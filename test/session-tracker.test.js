import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_KNOWN_TTL_MS, SESSION_ACTIVE_TTL_MS } from '../src/session-tracker.js';

// The weekly buckets a pin is keyed by (see model.js WEEKLY_BUCKET_KEYS).
const SHARED = 'unified7d';
const FABLE = 'unified7dFable';

// A tracker whose clock we drive by hand.
function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

test('touch records a session and pins it to the serving account', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 2, [SHARED], clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 2);
  assert.equal(st.pinnedAccount('unknown', SHARED, clock.t), null);
});

test('a later touch re-pins the session (failover moves it)', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, [SHARED], clock.t);
  st.touch('s1', 3, [SHARED], clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 3);
});

test('a pin is per bucket: re-pinning one leaves the others alone', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, [SHARED], clock.t);
  st.touch('s1', 1, [FABLE], clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0);
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 1);
  st.touch('s1', 2, [FABLE], clock.t); // the Fable pin fails over
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0, 'the shared pin moved with it');
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 2);
});

test('a bucket with no pin reads as unpinned', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
  st.touch('s1', 0, [SHARED], clock.t);
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), null);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0);
});

// The baselines are session-scoped state, so they live on the session record:
// one cap, one lifetime, one eviction policy for everything the session owns.
test('a rollover baseline is created, kept and dropped with its session', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, maxSessions: 3 });
  assert.equal(st.windowsFor('unknown', true, clock.t), null, 'a baseline outlived any session');
  st.touch('s1', 0, [SHARED], clock.t);
  const seen = st.windowsFor('s1', true, clock.t);
  assert.ok(seen);
  assert.equal(st.windowsFor('s1', false, clock.t), seen, 'a second look built a fresh baseline');
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.windowsFor('s1', true, clock.t), null, 'a forgotten session kept its baseline');
});

test('touch with no session id is a no-op', () => {
  const st = new SessionTracker();
  assert.equal(st.touch(null, 1, [SHARED]), null);
  assert.equal(st.touch(undefined, 1, [SHARED]), null);
});

test('a session is forgotten after the known (1h) idle window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
  assert.equal(st.stats(clock.t).known, 0);
});

test('a session stays known but goes inactive past the active window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  const stats = st.stats(clock.t);
  assert.equal(stats.known, 1);
  assert.equal(stats.active, 0);
  assert.equal(st.activeCountFor(1, clock.t), 0);
});

test('an in-flight request keeps a session active well past the active window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  const hold = st.beginRequest('s1', clock.t);
  st.touch('s1', 1, [SHARED], clock.t, hold); // routed to account 1
  // A 5-minute completion — far longer than the 2-min active window.
  clock.t += SESSION_ACTIVE_TTL_MS * 3;
  assert.equal(st.stats(clock.t).active, 1, 'still active while in flight');
  assert.equal(st.activeCountFor(1, clock.t), 1, 'still counts as load on its account');
  // Request finishes; recency now governs and it stays active a bit longer.
  st.endRequest('s1', null, clock.t);
  assert.equal(st.stats(clock.t).active, 1);
  // Then idles out of the active window.
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.stats(clock.t).active, 0);
});

test('an in-flight session is never expired, even past the 1h known window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS * 2; // a 2h+ stream
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0, 'pin survives while in flight');
  assert.equal(st.stats(clock.t).known, 1);
  // Only after it finishes and idles out does it get forgotten.
  st.endRequest('s1', null, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
});

test('concurrent requests on one session balance in/out via inFlight', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  // Both requests spend the same bucket, so each takes its own hold on it —
  // which is what makes the count balance rather than the first release
  // dropping a pin the second is still spending.
  const h1 = st.beginRequest('s1', clock.t);
  const h2 = st.beginRequest('s1', clock.t);
  st.touch('s1', 2, [SHARED], clock.t, h1);
  st.touch('s1', 2, [SHARED], clock.t, h2);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  st.endRequest('s1', h1, clock.t); // one still in flight
  assert.equal(st.activeCountFor(2, clock.t), 1);
  st.endRequest('s1', h2, clock.t); // now idle
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.activeCountFor(2, clock.t), 0);
});

test('activeCountFor counts only recently-active sessions on that account', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('a', 0, [SHARED], clock.t);
  st.touch('b', 0, [SHARED], clock.t);
  st.touch('c', 1, [SHARED], clock.t);
  assert.equal(st.activeCountFor(0, clock.t), 2);
  assert.equal(st.activeCountFor(1, clock.t), 1);
  assert.equal(st.activeCountFor(2, clock.t), 0);
});

test('a session spending two accounts is load on both, counted once each', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('split', 0, [SHARED], clock.t);
  st.touch('split', 1, [FABLE], clock.t);
  st.touch('whole', 0, [SHARED, FABLE], clock.t); // both buckets on one account
  assert.equal(st.activeCountFor(0, clock.t), 2, 'split + whole, each once');
  assert.equal(st.activeCountFor(1, clock.t), 1);
  assert.deepEqual(st.stats(clock.t).perAccount, { 0: 2, 1: 1 });
});

// Load is what the fleet is doing NOW. A pin outlives the active window by
// design (it holds the cache affinity for the whole known hour), so a session
// that took one diverted Fable request half an hour ago must not still read as
// load on that account — the whole point of the metric is to spread new
// sessions onto the accounts that are actually idle.
test('a pin stops counting as load once its bucket goes quiet', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [FABLE], clock.t);                 // one Fable turn on account 1
  clock.t += SESSION_ACTIVE_TTL_MS * 2;
  st.touch('s1', 0, [SHARED], clock.t);                // Opus turns keep going on 0
  assert.equal(st.activeCountFor(0, clock.t), 1);
  assert.equal(st.activeCountFor(1, clock.t), 0, 'an hour-old Fable pin still reads as load');
  assert.deepEqual(st.stats(clock.t).perAccount, { 0: 1 });
  // Still pinned, though — the affinity is intact and a Fable turn goes back there.
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 1);
});

test('a long stream still counts as load on the account it is spending', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [FABLE], clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS * 2;
  const hold = st.beginRequest('s1', clock.t);
  st.touch('s1', 0, [SHARED], clock.t, hold);
  clock.t += SESSION_ACTIVE_TTL_MS * 3;                // a 6-minute completion
  assert.equal(st.activeCountFor(0, clock.t), 1, 'the account serving the live request lost its load');
  assert.equal(st.activeCountFor(1, clock.t), 0);
});

test('stats reports known, active, and per-account active distribution', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('a', 0, [SHARED], clock.t);
  st.touch('b', 0, [SHARED], clock.t);
  st.touch('c', 1, [SHARED], clock.t);
  const stats = st.stats(clock.t);
  assert.equal(stats.known, 3);
  assert.equal(stats.active, 3);
  assert.deepEqual(stats.perAccount, { 0: 2, 1: 1 });
});

test('stats sweeps forgotten sessions out of the map', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('old', 0, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('new', 1, [SHARED], clock.t);
  st.stats(clock.t);
  assert.equal(st.sessions.has('old'), false);
  assert.equal(st.sessions.has('new'), true);
});

test('the session map is capped, evicting least-recently-seen first', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, maxSessions: 4 });
  for (const id of ['s0', 's1', 's2', 's3']) st.touch(id, 0, [SHARED], clock.t);
  st.touch('s0', 0, [SHARED], clock.t); // s0 is now the most recently seen
  st.touch('s4', 0, [SHARED], clock.t); // over the cap: s1 is the oldest
  assert.equal(st.sessions.size, 4);
  assert.equal(st.sessions.has('s1'), false, 'least-recently-seen was kept');
  assert.equal(st.sessions.has('s0'), true, 'a recently-seen session was evicted');
  assert.equal(st.pinnedAccount('s0', SHARED, clock.t), 0, 'a surviving session kept its pins');
});

test('the cap prefers an idle victim over a session with a request in flight', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, maxSessions: 3 });
  st.beginRequest('streaming', clock.t);          // oldest, but mid-response
  st.touch('streaming', 2, [SHARED], clock.t);
  st.touch('idle-1', 0, [SHARED], clock.t);
  st.touch('idle-2', 0, [SHARED], clock.t);
  st.touch('new', 0, [SHARED], clock.t);
  assert.equal(st.pinnedAccount('streaming', SHARED, clock.t), 2, 'a live request lost its pin');
  assert.equal(st.sessions.has('idle-1'), false, 'the oldest evictable one was kept');
});

// The session id is a client-supplied header and a streaming completion holds
// `inFlight` for its whole duration, so a preference for idle victims that can
// veto the cap is not a bound at all — enough concurrent streams turn it off.
test('the cap binds even when every probed session is in flight', () => {
  const { clock, now } = fixedClock();
  const max = 64;
  const st = new SessionTracker({ now, maxSessions: max });
  // Enough concurrent holders to fill the eviction probe several times over,
  // parked at the least-recently-seen end where the probe looks.
  for (let i = 0; i < 40; i++) {
    st.beginRequest(`stream-${i}`, clock.t);
    clock.t += 1;
  }
  for (let i = 0; i < 5000; i++) {
    clock.t += 1;
    st.touch(`churn-${i}`, 0, [SHARED], clock.t);
  }
  assert.ok(st.sessions.size <= max, `map grew to ${st.sessions.size} against a cap of ${max}`);
});

test('a session that keeps making requests is not the one eviction reaches for', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, maxSessions: 3 });
  st.touch('busy', 1, [SHARED], clock.t);
  for (let i = 0; i < 10; i++) {
    clock.t += 1;
    st.touch(`churn-${i}`, 0, [SHARED], clock.t);
    clock.t += 1;
    st.touch('busy', 1, [SHARED], clock.t); // re-inserted at the back each time
  }
  assert.equal(st.pinnedAccount('busy', SHARED, clock.t), 1, 'an actively-used session was evicted');
});

// Map order is what eviction consumes, so it has to track last ACTIVITY. A
// long stream is inserted when it starts; if finishing does not re-insert it,
// it sits at the front and is evicted ahead of sessions idle far longer.
test('a finished request re-orders its session ahead of older idle ones', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, maxSessions: 3 });
  st.beginRequest('stream', clock.t);
  st.touch('stream', 2, [SHARED], clock.t);
  clock.t += 1;
  st.touch('idle-old', 0, [SHARED], clock.t);
  clock.t += 1;
  st.touch('idle-new', 0, [SHARED], clock.t);
  clock.t += 1;
  st.endRequest('stream', null, clock.t); // the stream is now the most recent activity
  clock.t += 1;
  st.touch('fresh', 0, [SHARED], clock.t);
  assert.equal(st.pinnedAccount('stream', SHARED, clock.t), 2, 'the just-finished stream was evicted first');
  assert.equal(st.sessions.has('idle-old'), false, 'the least-recently-active session was kept');
});

// beginRequest goes through the same _ensure as touch, so an idle-expired
// record must be discarded there too — refreshing it instead resurrects a pin
// the session is no longer entitled to.
test('beginRequest does not resurrect a session that idled out', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.beginRequest('s1', clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null, 'an expired pin came back');
});

test('touch does not resurrect a session that idled out', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('s1', null, null, clock.t); // a request arriving with no routing decision yet
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null, 'an expired pin came back');
});

// endRequest is called from a `finally` that runs on every exit, including
// paths where the matching beginRequest never ran. The count is a hold, not an
// arithmetic total: below zero it stops meaning "quiet", so the record never
// settles a rollover and never expires.
test('the in-flight hold never goes below zero', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.endRequest('s1', null, clock.t);
  st.endRequest('s1', null, clock.t);           // an unpaired release
  assert.equal(st.sessions.get('s1').inFlight, 0, 'the hold went negative');
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.sweep(clock.t);
  assert.equal(st.sessions.has('s1'), false, 'a negative hold made the record immortal');
});

// _live is the read path for pins and baselines, and it is reached far more
// often than the sweep. A record it finds expired is dropped there, or an idle
// session that is never asked about again lingers until the next sweep — and a
// client sending one id per request makes that unbounded between sweeps.
test('a read that finds an expired record drops it', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
  assert.equal(st.sessions.has('s1'), false, 'an expired record survived the read that found it');
});

// A headless server never renders status, so the only sweep it gets is the one
// touch schedules. The id is a client-supplied header.
test('touch sweeps on its own schedule, without a status read', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  for (let i = 0; i < 50; i++) st.touch(`s${i}`, 0, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('later', 0, [SHARED], clock.t);
  assert.equal(st.sessions.size, 1, `${st.sessions.size} idle records survived a sweep interval`);
});

test('the pin view excludes sessions the sweep has not reached yet', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  // ONE snapshot: the call is what drops the expired record, so asking twice
  // reads the second answer off a map the first call already cleaned.
  const s = st.stats(clock.t);
  assert.deepEqual(s.perBucket, {}, 'a forgotten session is still shown holding its pin');
  assert.equal(s.known, 0, 'the known count is the raw map size rather than what is still live');
});

// Releasing the hold is the moment a long stream's session was last busy.
// Without that refresh a five-minute completion drops out of the active window
// the instant it finishes, and the account serving it reads as idle.
test('releasing the in-flight hold refreshes the session\'s recency', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;   // a long completion
  st.endRequest('s1', null, clock.t);
  assert.equal(st.stats(clock.t).active, 1, 'a session that just finished a request reads as idle');
});

test('a request with no routing decision leaves the pins it did not spend alone', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, [SHARED], clock.t);
  st.touch('s1', 2, [FABLE], clock.t);
  st.touch('s1', 1, null, clock.t);       // an attempt with nothing decided yet
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0);
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 2, 'a request that spent nothing re-pinned a bucket');
});

// The load metric decides where NEW sessions go. Counting a session that has
// gone quiet keeps spreading traffic away from an account nothing is using.
test('the load metric counts only sessions that are still active', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, [SHARED], clock.t);
  assert.equal(st.activeCountFor(1, clock.t), 1);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.activeCountFor(1, clock.t), 0, 'a session idle past the active window still counts as load');
});

// THE CLAIM BOUNDARY, ported with the guard from the reviewed slice
// (upstream/load-weighted-selection 530d16b). A hold that has already been
// RELEASED must not be able to claim a bucket again: the release path removed it
// from `holds` and would refuse it a second time, so the claim would never be
// released and the pin would read as held for the life of the record — the exact
// failure the counter exists to prevent.
//
// Unreachable from production today, for the reason RESIDUALS TC-024 records:
// `server.js` releases through one site with the hold it was given. This drives
// the tracker directly, which is the only way to reach it, and says so rather
// than implying the path is live.
test('a released hold cannot claim a bucket again', () => {
  const t = new SessionTracker();
  const hold = t.beginRequest('s1');
  t.touch('s1', 0, ['unified7d'], t._now(), hold);
  const s = t.sessions.get('s1');
  assert.equal(s.pinHolds.get('unified7d'), 1, 'the premise: the live hold did claim the bucket');

  t.endRequest('s1', hold);
  assert.equal(s.pinHolds.get('unified7d'), undefined, 'the premise: releasing gave the claim back');
  assert.ok(!s.holds.has(hold), 'the premise: the hold is no longer the record\'s');

  // The same hold, presented again after release, on a bucket it has not claimed.
  t.touch('s1', 0, ['unified7dFable'], t._now(), hold);
  assert.equal(s.pinHolds.get('unified7dFable'), undefined,
    'a released hold claimed a bucket nothing can ever release');
});

// WHY THE CLAIM CARRIES TWO CONDITIONS THAT CANNOT BE TOLD APART. `holds` is
// per record and `beginRequest` is the only thing that adds to it, stamping the
// record's own `rid` on the way in. So membership in `holds` IMPLIES a matching
// rid, and severing the rid test alone at the claim changes no behaviour: the
// reversion matrix reports it as covered by nothing, correctly. The rid test
// stays because the two answer different questions if `holds` handling ever
// changes, and the implication is asserted here so that "redundant" is a
// property this suite holds rather than a claim in a comment.
//
// Ported from the S4b slice at a6f67b7 (test/per-pin-holds.test.js), where the
// same argument was reached from the other direction: that matrix carries a
// documented NON-row for the claim-boundary rid test, measured green at
// 699/699, beside this test binding the implication it rests on. TC-005 records
// the equivalence for both boundaries; this is what keeps it from being prose.
test('every outstanding hold carries the rid of the record holding it', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  const a = st.beginRequest('s1', clock.t);
  const b = st.beginRequest('s1', clock.t);
  st.beginRequest('s2', clock.t);
  // A dropped record and its replacement, so two rids are live in the tracker.
  st.sessions.delete('s2');
  st.beginRequest('s2', clock.t);

  for (const [id, rec] of st.sessions) {
    for (const hold of rec.holds) {
      assert.equal(hold.rid, rec.rid, `a hold in ${id}'s set carries a foreign rid`);
    }
  }
  assert.equal(a.rid, b.rid, 'two requests on one record share its rid');
  assert.ok(st.sessions.get('s1').holds.has(a));
});
