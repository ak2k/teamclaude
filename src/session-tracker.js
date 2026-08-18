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
// EVERYTHING scoped to a session lives on that session's record — its pins and
// its rollover baselines alike — so there is exactly one cap, one lifetime and
// one eviction policy for all of it. A second map keyed by session id would
// need its own bound, and any bound smaller than this one binds on entries that
// are still live here — which is not a bound on anything: it evicts state a
// running session needs while the map it was meant to shadow keeps growing.
//
// Two windows:
//   - KNOWN: a session is remembered until it goes idle for this long, then
//     forgotten. 1h matches the maximum prompt-cache extension window — past
//     that there is no cache left to preserve, so the pin has no value.
//   - ACTIVE: a session counts as "active" (and toward per-account load) if it
//     made a request this recently. Short, so load-balancing reacts to what is
//     actually running now rather than to sessions merely lingering in the hour.
import { WindowWatcher } from './window-watcher.js';

export const SESSION_KNOWN_TTL_MS = 60 * 60 * 1000; // 1h idle → forgotten
export const SESSION_ACTIVE_TTL_MS = 2 * 60 * 1000; // 2min idle → no longer "active"

const SWEEP_INTERVAL_MS = 60 * 1000; // bound growth without an external timer

// Hard cap on remembered sessions. The id arrives in a client-supplied header,
// so the idle window alone bounds nothing against a client that sends a fresh
// one per request — and each record now holds a pin per bucket.
const SESSION_MAX = 2048;

// How many least-recently-seen entries an insert may inspect looking for one
// with no request in flight, before evicting the least-recently-seen entry
// whatever its state. Keeps the insert O(1) whatever the map holds. Sparing a
// live request's pin is a PREFERENCE, not a veto: the session id is a
// client-supplied header and a streaming completion holds `inFlight` for its
// whole duration, so a veto lets that many concurrent streams switch the cap
// off entirely and the map grows without bound. Losing an in-flight session's
// tracking costs it one re-pin on its next request; unbounded growth costs the
// process.
const SESSION_EVICT_PROBE = 16;

export class SessionTracker {
  constructor({ knownTtlMs, activeTtlMs, now, maxSessions } = {}) {
    // id -> { pins: Map<bucketKey, {idx, at}>, windows, firstSeen, lastSeen, count, inFlight }
    this.sessions = new Map();
    this.knownTtlMs = knownTtlMs ?? SESSION_KNOWN_TTL_MS;
    this.activeTtlMs = activeTtlMs ?? SESSION_ACTIVE_TTL_MS;
    this.maxSessions = maxSessions ?? SESSION_MAX;
    this._now = now || (() => Date.now());
    this._lastSweep = 0;
    // Records dropped to keep the map under the cap, since start. Deliberately
    // NOT counting the TTL expiries around it: forgetting an idle session is
    // the design working, while the cap firing means the bound is binding and
    // live sessions are losing pins they will have to re-earn.
    this.evicted = 0;
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
      for (const bucket of buckets) s.pins.set(bucket, { idx: accountIndex, at: now });
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

  // Mark a request as finished (refreshes recency; releases the in-flight hold)
  // and return the record, so a caller can act on the session going quiescent.
  // Re-inserts: eviction consumes the map in order, so that order has to mean
  // last ACTIVITY. Without this a just-finished long stream sits where it was
  // when it STARTED — at the front — and is evicted ahead of sessions that have
  // been idle far longer.
  endRequest(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.lastSeen = now;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, s);
    return s;
  }

  _ensure(sessionId, now) {
    const existing = this.sessions.get(sessionId);
    if (existing && !this._isExpired(existing, now)) {
      // Re-insert so the map iterates least-recently-seen first, which is the
      // order eviction consumes it in.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    // Idled past the known window: this id is a NEW session that happens to
    // reuse the string. Refreshing the old record instead would resurrect pins
    // and baselines the session is no longer entitled to — pointing it at an
    // account nothing re-evaluated, with an hour-cold cache.
    if (existing) this.sessions.delete(sessionId);
    while (this.sessions.size >= this.maxSessions) {
      if (!this._evictOne()) break;
    }
    const s = { pins: new Map(), windows: null, firstSeen: now, lastSeen: now, count: 0, inFlight: 0 };
    this.sessions.set(sessionId, s);
    return s;
  }

  // Drop the least-recently-seen session to make room, preferring one with no
  // request in flight. Falls back to the least-recently-seen entry whatever its
  // state once the bounded probe has found no idle victim, so the cap holds at
  // any concurrency. Returns false only when the map is empty.
  _evictOne() {
    let probed = 0;
    let oldest = null;
    for (const [id, s] of this.sessions) {
      if (oldest === null) oldest = id;
      if (s.inFlight === 0) {
        this.sessions.delete(id);
        this.evicted += 1;
        return true;
      }
      if (++probed >= SESSION_EVICT_PROBE) break;
    }
    if (oldest === null) return false;
    this.sessions.delete(oldest);
    this.evicted += 1;
    return true;
  }

  // The rollover baselines for this session, built on `create` for the paths
  // that record one. Null for a session the tracker does not (or no longer)
  // knows: a baseline outliving the pin it belongs to has nothing to say about
  // anything. Readers pass no `create` so merely asking never allocates — most
  // sessions never need one at all.
  windowsFor(sessionId, create = false, now = this._now()) {
    const s = this._live(sessionId, now);
    if (!s) return null;
    if (!s.windows && create) s.windows = new WindowWatcher();
    return s.windows || null;
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
    return s.pins.get(bucket)?.idx ?? null;
  }

  // Re-point every pin through `mapFn` after the account list is renumbered
  // (see AccountManager.removeAccount). A pin is a bare index into that list, so
  // a removal one slot below silently hands the session to a different account;
  // returning null drops that pin instead, and the session re-routes that bucket
  // on its next request. Every bucket is mapped — a session may hold pins on
  // several accounts, and the removal shifts all of them. The rollover baselines
  // ride the same record and name the same list, so they shift with it: left
  // alone, a stale index there names a DIFFERENT account whose window would read
  // as a jump and preempt for nothing.
  remapAccounts(mapFn) {
    for (const s of this.sessions.values()) {
      for (const [bucket, pin] of [...s.pins]) {
        const moved = mapFn(pin.idx);
        if (moved == null) s.pins.delete(bucket);
        else pin.idx = moved;
      }
      if (s.windows && !s.windows.remap(mapFn)) s.windows = null;
    }
  }

  // Does this session count as load on `accountIndex` right now? A pin counts
  // while the bucket it belongs to was served within the active window — a
  // session that took one diverted Fable request an hour ago is not load on
  // that account for the rest of the hour, and counting it there skews the
  // spreading signal the whole feature exists to provide. A request in flight
  // keeps the pin it is spending counted however long it streams, which is the
  // freshest one: a 5-minute completion must not drop out of "active".
  _pinsInclude(s, accountIndex, now) {
    let newest = -Infinity;
    if (s.inFlight > 0) for (const pin of s.pins.values()) newest = Math.max(newest, pin.at);
    for (const pin of s.pins.values()) {
      if (pin.idx !== accountIndex) continue;
      if (now - pin.at <= this.activeTtlMs || pin.at === newest) return true;
    }
    return false;
  }

  // Accounts this session counts as load on right now.
  _loadedAccounts(s, now) {
    const out = new Set();
    for (const pin of s.pins.values()) {
      if (!out.has(pin.idx) && this._pinsInclude(s, pin.idx, now)) out.add(pin.idx);
    }
    return out;
  }

  // Active sessions currently pinned to `accountIndex` — the load metric used to
  // spread new sessions across accounts. A session counts at most once per
  // account however many of its buckets point there, but it does count on every
  // account it is currently spending: a session spending two accounts is load on
  // both.
  activeCountFor(accountIndex, now = this._now()) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this._isActive(s, now) && this._pinsInclude(s, accountIndex, now)) n += 1;
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

  // { known, active, max, evicted, perAccount, perBucket, pendingRollovers } —
  // for status/TUI. Sweeps as it goes so a long-lived headless server stays
  // bounded. Everything here comes out of the one walk this already does: the
  // status endpoint is read on every TUI frame, so nothing may add a second.
  //
  // `perAccount` is LOAD — active sessions, counted through the freshness rule
  // that decides what spreads new ones. `perBucket` is where known sessions are
  // PINNED, bucket -> account index -> count, which is a different question and
  // the only view in which one session holding Opus on one account and Fable on
  // another is visible at all. An idle-but-known pin still routes that session's
  // next request, so it belongs in the pin view and not in the load one.
  stats(now = this._now()) {
    this._lastSweep = now;
    let known = 0;
    let active = 0;
    let pendingRollovers = 0;
    const perAccount = {};
    const perBucket = {};
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) {
        this.sessions.delete(id);
        continue;
      }
      known += 1;
      pendingRollovers += s.windows?.pendingCount() || 0;
      for (const [bucket, pin] of s.pins) {
        const byAccount = perBucket[bucket] || (perBucket[bucket] = {});
        byAccount[pin.idx] = (byAccount[pin.idx] || 0) + 1;
      }
      if (this._isActive(s, now)) {
        active += 1;
        // Once per account, on every account this session is currently spending.
        for (const idx of this._loadedAccounts(s, now)) {
          perAccount[idx] = (perAccount[idx] || 0) + 1;
        }
      }
    }
    return { known, active, max: this.maxSessions, evicted: this.evicted, perAccount, perBucket, pendingRollovers };
  }
}
