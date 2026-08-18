// Tracks Claude Code sessions by their `x-claude-code-session-id` header so
// teamclaude can (a) report how many sessions are running and (b) optionally
// keep each session pinned to one account while spreading NEW sessions across
// accounts (the opt-in fix for concurrency funnelling — issue #109).
//
// A session pins PER GOVERNING QUOTA BUCKET, not once overall. Quota,
// eligibility and routing are all decided per bucket — an account whose Fable
// weekly is spent still serves Opus perfectly well — so a single pin per
// session lets a decision taken for one model relocate the whole session: a
// Fable request diverted off the pinned account re-pins the session there, and
// every later Opus request follows it onto an account that was never evaluated
// for Opus and whose Opus cache is cold. Keying each pin by the weekly bucket
// that governs the request keeps the families' affinities independent.
//
// Two windows:
//   - KNOWN: a session is remembered until it goes idle for this long, then
//     forgotten. 1h matches the maximum prompt-cache extension window — past
//     that there is no cache left to preserve, so the pin has no value.
//   - ACTIVE: a session counts as "active" (and toward per-account load) if it
//     made a request this recently. Short, so load-balancing reacts to what is
//     actually running now rather than to sessions merely lingering in the hour.
export const SESSION_KNOWN_TTL_MS = 60 * 60 * 1000; // 1h idle → forgotten
export const SESSION_ACTIVE_TTL_MS = 2 * 60 * 1000; // 2min idle → no longer "active"

const SWEEP_INTERVAL_MS = 60 * 1000; // bound growth without an external timer

// Hard cap on remembered sessions. The id arrives in a client-supplied header,
// so the idle window alone bounds nothing against a client that sends a fresh
// one per request — and each record now holds a pin per bucket.
const SESSION_MAX = 2048;

// How many least-recently-seen entries an insert may inspect for an evictable
// one before giving up. Keeps the insert O(1) whatever the map holds. A session
// with a request in flight is never evicted, so a probe that finds only those
// simply lets the map sit over its cap — real concurrency bounds that far below
// it, and the alternative is taking a live request's pin out from under it.
const SESSION_EVICT_PROBE = 16;

export class SessionTracker {
  constructor({ knownTtlMs, activeTtlMs, now, maxSessions } = {}) {
    // id -> { pins: Map<bucketKey, accountIndex>, firstSeen, lastSeen, count, inFlight }
    this.sessions = new Map();
    this.knownTtlMs = knownTtlMs ?? SESSION_KNOWN_TTL_MS;
    this.activeTtlMs = activeTtlMs ?? SESSION_ACTIVE_TTL_MS;
    this.maxSessions = maxSessions ?? SESSION_MAX;
    this._now = now || (() => Date.now());
    this._lastSweep = 0;
  }

  // Record that `sessionId` made a request served by `accountIndex`, spending
  // the weekly quota `buckets`. Refreshes lastSeen (keeping the session
  // "active"/"known") and re-pins ONLY those buckets — the session's affinity
  // for a family this request did not touch is none of this request's business.
  // Throttled sweep keeps the map bounded even in a headless server that never
  // renders status.
  touch(sessionId, accountIndex = null, buckets = null, now = this._now()) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.lastSeen = now;
    s.count += 1;
    if (accountIndex != null && buckets) {
      for (const bucket of buckets) s.pins.set(bucket, accountIndex);
    }
    if (now - this._lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
    return s;
  }

  // Mark a request for this session as started. A session with any request in
  // flight counts as active (and non-expirable) for the whole request, however
  // long it streams — a 5-minute completion must not drop out of "active" or the
  // load balancer would under-count that account. Paired with endRequest.
  beginRequest(sessionId, now = this._now()) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.inFlight += 1;
    s.lastSeen = now;
    return s;
  }

  // Mark a request as finished (refreshes recency; releases the in-flight hold).
  endRequest(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.lastSeen = now;
  }

  _ensure(sessionId, now) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Re-insert so the map iterates least-recently-seen first, which is the
      // order eviction consumes it in.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    while (this.sessions.size >= this.maxSessions) {
      if (!this._evictOne()) break;
    }
    const s = { pins: new Map(), firstSeen: now, lastSeen: now, count: 0, inFlight: 0 };
    this.sessions.set(sessionId, s);
    return s;
  }

  // Drop the least-recently-seen evictable session to make room, skipping any
  // with a request in flight. Returns false when the bounded probe found none.
  _evictOne() {
    let probed = 0;
    for (const [id, s] of this.sessions) {
      if (s.inFlight === 0) {
        this.sessions.delete(id);
        return true;
      }
      if (++probed >= SESSION_EVICT_PROBE) break;
    }
    return false;
  }

  // Active = a request in flight now, or one seen within the active window.
  _isActive(s, now) {
    return s.inFlight > 0 || now - s.lastSeen <= this.activeTtlMs;
  }

  // Expired = idle past the known window AND nothing in flight (a long-running
  // request keeps the session alive no matter how old lastSeen is).
  _isExpired(s, now) {
    return s.inFlight === 0 && now - s.lastSeen > this.knownTtlMs;
  }

  // The session's record while it is still known, else null. Expired-on-read
  // entries are dropped as they are found.
  _live(sessionId, now) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    if (this._isExpired(s, now)) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s;
  }

  // The account a known session is pinned to for `bucket` — the weekly quota
  // bucket governing the request being routed — or null when the session is
  // unknown, forgotten, or has no pin for that bucket yet. A bucket is required:
  // "which account is this session on" is precisely the question with no single
  // answer, and answering it anyway is what used to move a session wholesale.
  pinnedAccount(sessionId, bucket, now = this._now()) {
    const s = this._live(sessionId, now);
    if (!s || bucket == null) return null;
    return s.pins.get(bucket) ?? null;
  }

  // Is this session pinned to any account at all? For callers that keep their
  // own per-session state and need to know whether the tracker still routes it.
  isPinned(sessionId, now = this._now()) {
    const s = this._live(sessionId, now);
    return !!s && s.pins.size > 0;
  }

  // Does any of this session's pins point at `accountIndex`?
  _pinsInclude(s, accountIndex) {
    for (const idx of s.pins.values()) if (idx === accountIndex) return true;
    return false;
  }

  // Active sessions currently pinned to `accountIndex` — the load metric used to
  // spread new sessions across accounts. Counts in-flight sessions regardless of
  // how long their request has been streaming. A session counts at most once per
  // account however many of its buckets point there, but it does count on every
  // account it holds a pin on: a session spending two accounts is load on both.
  activeCountFor(accountIndex, now = this._now()) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this._isActive(s, now) && this._pinsInclude(s, accountIndex)) n += 1;
    }
    return n;
  }

  // Drop sessions idle longer than the known window (but never one still in flight).
  sweep(now = this._now()) {
    this._lastSweep = now;
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) this.sessions.delete(id);
    }
  }

  // { known, active, perAccount: { [index]: activeCount } } — for status/TUI.
  // Sweeps as it goes so a long-lived headless server stays bounded.
  stats(now = this._now()) {
    this._lastSweep = now;
    let known = 0;
    let active = 0;
    const perAccount = {};
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) {
        this.sessions.delete(id);
        continue;
      }
      known += 1;
      if (this._isActive(s, now)) {
        active += 1;
        // Once per account, on every account this session is pinned to.
        for (const idx of new Set(s.pins.values())) {
          perAccount[idx] = (perAccount[idx] || 0) + 1;
        }
      }
    }
    return { known, active, perAccount };
  }
}
