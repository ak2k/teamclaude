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
// one per request — and each record now holds a pin per bucket. Exported so a
// test can assert the reported cap IS this number: "some positive cap" is
// satisfied by any constant, including one that stopped tracking this one.
export const SESSION_MAX = 2048;

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

// Per-session token totals, kept per weekly bucket rather than once per session.
// Fable meters into its own weekly bucket, so how much 5h capacity a weekly
// point costs is a per-family quantity by construction; totals summed across
// families cannot be taken apart again afterwards, and the distinction is gone
// before anything can use it.
//
// The names map one-to-one onto the fields upstream reports in its `usage`
// object, so a reader can line them up with the wire:
// `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`,
// `output_tokens`.
//
// `context` is the odd one out and is not a sum. It is the size of the last
// context upstream reported reading, which is what a decision about this
// session's cache costs; summing it would answer a question nobody asks. The
// sums, read against `firstSeen` and `lastSeen`, give the session's burn rate.
//
// `context` and `reports` are what `loadFor` ranks accounts on; the cumulative
// sums are not read by any decision. The reason to expect the burn-rate pair to
// be the useful one for MIGRATION — what a session is worth moving off a loaded
// account should scale with the load it sheds and against the cache that move
// destroys — remains an argument from cost structure rather than a measurement.
// No migration policy exists here to test it.
//
// `reports` counts the usage objects that contributed, so a consumer can tell
// "no tokens because the session is idle" from "no tokens because nothing was
// ever observed": two states that otherwise look identical at zero.
function emptyTokens() {
  return { cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0, reports: 0 };
}

// The counters in an aggregate sum over KNOWN sessions; the cached footprint
// only over ACTIVE ones. Two populations in one object, so the footprint is
// named for its scope. `context / reports` would otherwise read as an
// average and be a ratio of different denominators.
const COUNTERS = ['cacheRead', 'cacheCreation', 'input', 'output', 'reports'];
function emptyAggregate() {
  return { cacheRead: 0, cacheCreation: 0, input: 0, output: 0, reports: 0, activeContext: 0 };
}

// Upstream omits a field it has nothing to say about, and has been seen to send
// null. Anything that is not a finite number contributes zero, so one malformed
// report cannot turn a running total into NaN and keep it there.
function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function setAndReturn(map, key, value) {
  map.set(key, value);
  return value;
}

export class SessionTracker {
  constructor({ knownTtlMs, activeTtlMs, now, maxSessions } = {}) {
    // id -> { pins: Map<bucketKey, {idx, at}>, windows, firstSeen, lastSeen, count, inFlight }
    this.sessions = new Map();
    this.knownTtlMs = knownTtlMs ?? SESSION_KNOWN_TTL_MS;
    this.activeTtlMs = activeTtlMs ?? SESSION_ACTIVE_TTL_MS;
    this.maxSessions = maxSessions ?? SESSION_MAX;
    this._now = now || (() => Date.now());
    this._lastSweep = 0;
    // Monotonic per-record identity. Never reused, so a hold issued against a
    // record that has since been evicted can never match its replacement.
    this._recordSeq = 0;
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
  touch(sessionId, accountIndex = null, buckets = null, now = this._now(), hold = null) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.lastSeen = now;
    s.count += 1;
    // A pin is a position in the account list, so a negative one names nothing.
    // AccountManager marks a removed account's own index -1 to make late calls
    // from an in-flight request no-ops, and a request that was past selection
    // when the removal landed hands that -1 straight here. Routing shrugs it off
    // (the next lookup misses and the session re-routes), but the count reaches
    // the status payload as a `"-1"` key in both perBucket and perAccount, which
    // is a live account nobody can find.
    if (accountIndex != null && accountIndex >= 0 && buckets) {
      for (const bucket of buckets) {
        s.pins.set(bucket, { idx: accountIndex, at: now });
        // The request that is placing this pin is the one spending it, so it
        // takes a hold until it ends. Claimed here rather than at
        // `beginRequest` because which buckets a request spends is not known
        // until selection has run and this is the call that says so. Claimed at
        // most once per bucket per request: a retry that re-pins the same
        // bucket is the same request still spending it.
        // Same ownership test as the release. Without it the window admits a
        // phantom claim on the way IN as well as a bad release on the way out:
        // a request whose record was evicted mid-flight would add a hold count
        // to whatever record now answers to its id.
        if (hold && hold.rid === s.rid && !hold.buckets.has(bucket)) {
          hold.buckets.add(bucket);
          s.pinHolds.set(bucket, (s.pinHolds.get(bucket) || 0) + 1);
        }
      }
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
    // The per-pin hold this request will fill in once selection tells it which
    // buckets it is spending. Returned so the caller can hand it back at
    // `endRequest`; a caller that does not is covered by the drain below.
    const hold = { rid: s.rid, buckets: new Set() };
    s.holds.add(hold);
    return hold;
  }

  // Release one request's per-pin holds. Idempotent: a hold already released,
  // or one belonging to another session, is a no-op rather than an
  // under-count.
  _releaseHold(s, hold) {
    // Ownership again, because this is reachable from the drain as well as from
    // `endRequest` and a guard at one entrance is not a guard.
    if (!hold || hold.rid !== s.rid || !s.holds.delete(hold)) return;
    for (const bucket of hold.buckets) {
      const n = s.pinHolds.get(bucket) || 0;
      if (n <= 1) s.pinHolds.delete(bucket);
      else s.pinHolds.set(bucket, n - 1);
    }
    hold.buckets.clear();
  }

  // Mark a request as finished (refreshes recency; releases the in-flight hold)
  // and return the record, so a caller can act on the session going quiescent.
  // Re-inserts: eviction consumes the map in order, so that order has to mean
  // last ACTIVITY. Without this a just-finished long stream sits where it was
  // when it STARTED — at the front — and is evicted ahead of sessions that have
  // been idle far longer.
  // `hold` before `now`, deliberately: `now` is a test affordance and the hold
  // is what callers actually pass. With the order reversed a hold handed to the
  // second parameter was silently taken as the clock, which set `lastSeen` to an
  // object and made every subsequent `now - lastSeen` NaN — so the session read
  // as inactive and the mistake looked like a load-accounting bug.
  endRequest(sessionId, hold = null, now = this._now()) {
    // A clock passed where the hold goes is the mistake this reorder exists to
    // prevent, and a silent no-op on it would be the same class of bug wearing
    // the new signature. Programming error, so it says so.
    if (hold != null && typeof hold !== 'object') {
      throw new TypeError(`endRequest(sessionId, hold, now): hold must be the object beginRequest returned, got ${typeof hold}`);
    }
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    // A HOLD HAS AUTHORITY ONLY OVER THE RECORD THAT ISSUED IT. A record can be
    // evicted while its request is still in flight, and a later request under
    // the same id builds a NEW record; when the original finally ends, its hold
    // names a record that no longer exists. Acting on it here would decrement a
    // stranger's in-flight count, release a pin it never claimed, and — once
    // that count hit zero — drain the live replacement's holds, reading its
    // 50000-token stream as idle. The replacement is not this request's to
    // finish, so a foreign hold does nothing at all. That is also why it cannot
    // leak: the record it belonged to is gone, and gone records hold nothing.
    if (hold && hold.rid !== s.rid) return null;
    s.inFlight = Math.max(0, s.inFlight - 1);
    this._releaseHold(s, hold);
    // THE PAIRING GUARANTEE. A hold that never comes back would leave a pin
    // counted as loaded forever, where the pre-existing `Math.max(0, ...)`
    // above merely floors an integer. So the count is not trusted to pairing
    // alone: no outstanding request means no held pin, by definition, and any
    // hold still standing at zero was lost by a caller that did not return it.
    // Draining here makes a leak self-correcting at the end of the session's
    // last request rather than permanent.
    if (s.inFlight === 0) {
      for (const h of [...s.holds]) this._releaseHold(s, h);
    }
    s.lastSeen = now;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, s);
    return s;
  }

  /**
   * Add one upstream usage report to a session's running totals.
   *
   * Records only what the report carries. A streaming response splits its usage
   * across two events and only `message_start` carries the cache fields, so the
   * caller passes each field at the event that reports it and every counter is
   * incremented once, at its own event. Passing `output` at `message_start`
   * would double count it against `message_delta`.
   *
   * Four cases this deliberately does NOT special-case, because the tokens were
   * spent upstream whether or not the request finished:
   *
   *   - a stream that fails after `message_start`: the context read happened and
   *     was charged, so it stays counted;
   *   - a request the client abandoned: same, the client leaving does not refund
   *     anything;
   *   - an advisor request: one report covers the whole request, and the
   *     advisor's sub-inference is not separable from the executor's inside it,
   *     so it lands on the executing model's bucket. Splitting it across the two
   *     buckets a request can touch would be inventing a division upstream did
   *     not report;
   *   - a session evicted mid-request: its totals died with its record, and this
   *     will NOT resurrect one. The id is a client-supplied header, so creating
   *     records here would let usage reports defeat the cap that eviction exists
   *     to enforce. A report for a session that is gone is dropped.
   */
  recordTokens(sessionId, bucket, usage, now = this._now()) {
    const s = this._live(sessionId, now);
    if (!s || !usage || !bucket) return null;
    const byBucket = s.tokens || (s.tokens = new Map());
    const t = byBucket.get(bucket) || setAndReturn(byBucket, bucket, emptyTokens());
    const read = num(usage.cache_read_input_tokens);
    const creation = num(usage.cache_creation_input_tokens);
    const input = num(usage.input_tokens);
    t.cacheRead += read;
    t.cacheCreation += creation;
    t.input += input;
    t.output += num(usage.output_tokens);
    // Only a report that carries the input side describes a context. A
    // `message_delta` carries output alone and would otherwise reset this to 0.
    if (read || creation || input) t.context = read + creation + input;
    t.reports += 1;
    return t;
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
    const s = {
      pins: new Map(), windows: null, firstSeen: now, lastSeen: now, count: 0, inFlight: 0,
      tokens: new Map(),
      // Per-pin outstanding requests, ADDED beside `inFlight` rather than
      // replacing it. The two answer different questions and only one reader
      // wants this one: `holds` is the live request records, `pinHolds` is
      // bucket -> how many of them are spending that bucket.
      holds: new Set(), pinHolds: new Map(),
      // Identity of THIS record, stamped into every hold it issues. A session id
      // does not identify a record: eviction and idle-expiry both replace the
      // record while the id lives on, and an in-flight request outlives its own
      // record in exactly those cases. A counter rather than the record object,
      // so a hold cannot keep an evicted record alive by referring to it.
      rid: ++this._recordSeq,
    };
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

  // Does THIS pin count as load on `accountIndex` right now? A pin counts while
  // the bucket it belongs to was served within the active window — a session
  // that took one diverted Fable request an hour ago is not load on that account
  // for the rest of the hour, and counting it there skews the spreading signal
  // the whole feature exists to provide. A request in flight keeps the pin it is
  // spending counted however long it streams: a 5-minute completion must not
  // drop out of "active".
  //
  // Per PIN rather than per session, because the two questions have different
  // answers: a session is load on every account it is currently spending, while
  // each bucket's tokens were spent on exactly one of them.
  //
  // WHY A HELD COUNT AND NOT THE NEWEST PIN. The in-flight arm used to be
  // `pin.at === newest`, reading the session-level `inFlight` counter and then
  // guessing that the outstanding request was spending the most recently placed
  // pin. That is true for one request and false for two: with an Opus stream
  // live on one account and a later Fable request on another, only the Fable pin
  // matched, and the account carrying a live 100000-token context read as idle
  // on every term. The guess also fails the ordinary shape of a short request
  // starting after a long one and finishing first. `pinHolds` counts the
  // outstanding requests actually spending each bucket, so nothing is inferred.
  //
  // WHAT THIS DOES NOT COVER: concurrency within ONE family. Pins are keyed by
  // bucket, so two concurrent requests on the same family share a pin and the
  // second RE-PINS it — the first account's pin is destroyed rather than aged
  // out, and a hold cannot rescue a pin that no longer exists. A live stream can
  // therefore still read as zero load when a later request on the SAME family is
  // served elsewhere. Closing that means a pin per request rather than per
  // bucket, which is a different change. The claim here is cross-family
  // concurrency, which is the shape an Opus stream beside a Fable request takes.
  _pinCounts(s, bucket, pin, accountIndex, now) {
    if (pin.idx !== accountIndex) return false;
    return now - pin.at <= this.activeTtlMs || (s.pinHolds.get(bucket) || 0) > 0;
  }

  _pinsInclude(s, accountIndex, now) {
    for (const [bucket, pin] of s.pins) {
      if (this._pinCounts(s, bucket, pin, accountIndex, now)) return true;
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

  // Everything the selection weight needs about one account, in ONE pass.
  //
  // The count, the measured footprint and the report count are all sums over
  // the same sessions under the same two predicates, so asking for them
  // separately walked every session three times per account per pick. On a
  // fleet at SESSION_MAX that is three O(sessions x accounts) traversals on the
  // selection path to answer one question.
  //
  // WHY CONTEXT AND NOT CUMULATIVE TOKENS. This asks what an account is
  // carrying NOW. A session's context is what each of its requests costs to
  // serve; its lifetime total is a fact about its past and would rank a long
  // quiet session above a young heavy one.
  //
  // POOLED ACROSS FAMILIES ON THIS ACCOUNT, AND SPLIT BY ACCOUNT. The rate
  // ceiling an account can hit is its five-hour bucket, and that bucket is
  // shared by every family, so load on ONE account is not divided by family.
  // It is emphatically divided by account: a session spanning two families
  // holds a separate pin per family, commonly on two different accounts, and
  // each bucket's tokens were spent on whichever account served that bucket.
  // Testing the pin per session and then summing every bucket charged the whole
  // context to both — two accounts carrying 100000 and 7000 each read 107000
  // and the pick could not tell them apart. That is not an edge case: 20.1% of
  // the 1504 sessions in the transcript corpus span more than one family.
  //
  // The count is deliberately NOT divided the same way. A split session is
  // genuinely active on both accounts, so it counts once on each; its tokens
  // were spent once, on one of them. Cardinality is a property of the
  // relationship, quantity is a property of the transaction.
  //
  // WHY `reports` COMES BACK TOO. `context` of 0 is enormously plausible: an
  // idle session legitimately has none. So if the token read were ever lost,
  // every account would score zero, selection would fall back to counting
  // sessions, the fallback would be CORRECT behaviour, and the fleet would be
  // indistinguishable from one that had never recorded a token. Carrying the
  // report count keeps "no tokens because idle" separable from "no tokens
  // because nothing was observed" at the boundary, which is the distinction
  // `reports` was added to preserve one layer in.
  //
  // Zero across the board is not a special case: an unmeasured fleet scores
  // every account zero, the load term cannot discriminate, and the caller's
  // remaining tiebreaks decide exactly as they did before any of this existed.
  loadFor(accountIndex, now = this._now()) {
    let sessions = 0;
    let context = 0;
    let reports = 0;
    for (const s of this.sessions.values()) {
      if (!this._isActive(s, now)) continue;
      let counted = false;
      for (const [bucket, pin] of s.pins) {
        if (!this._pinCounts(s, bucket, pin, accountIndex, now)) continue;
        counted = true;
        const t = s.tokens?.get(bucket);
        if (!t) continue;
        context += t.context;
        reports += t.reports;
      }
      if (counted) sessions += 1;
    }
    return { sessions, context, reports };
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
    // Fleet totals over the sessions still known, plus the live cached footprint
    // (`context`) summed over the ACTIVE ones only, since an idle session's
    // cache is what expiry is about to reclaim rather than what is being spent.
    const tokens = emptyAggregate();
    const byBucket = {};
    let activeContext = 0;
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) {
        this.sessions.delete(id);
        continue;
      }
      known += 1;
      pendingRollovers += s.windows?.pendingCount() || 0;
      for (const [bucket, t] of s.tokens || []) {
        const per = byBucket[bucket] || (byBucket[bucket] = emptyAggregate());
        for (const k of COUNTERS) {
          tokens[k] += t[k];
          per[k] += t[k];
        }
      }
      for (const [bucket, pin] of s.pins) {
        const byAccount = perBucket[bucket] || (perBucket[bucket] = {});
        byAccount[pin.idx] = (byAccount[pin.idx] || 0) + 1;
      }
      if (this._isActive(s, now)) {
        active += 1;
        // The live cached footprint, per family and in total. A session
        // holding a big Opus context and a small Fable one contributes to both,
        // and which of them is under pressure is the whole question.
        for (const [bucket, t] of s.tokens || []) {
          const per = byBucket[bucket] || (byBucket[bucket] = emptyAggregate());
          per.activeContext += t.context;
          activeContext += t.context;
        }
        // Once per account, on every account this session is currently spending.
        for (const idx of this._loadedAccounts(s, now)) {
          perAccount[idx] = (perAccount[idx] || 0) + 1;
        }
      }
    }
    tokens.activeContext = activeContext;
    tokens.byBucket = byBucket;
    return { known, active, max: this.maxSessions, evicted: this.evicted, perAccount, perBucket, pendingRollovers, tokens };
  }
}
