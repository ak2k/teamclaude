import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { SessionTracker } from '../src/session-tracker.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Manager with per-account weekly buckets set from { used, resetH } (hours from
// now; fableUsed/fableResetH for the Fable bucket). Expiry routing on by default;
// `er: null` omits the config key entirely (the shipped default).
function manager(specs, { er = { enabled: true }, distribute = true, tracker } = {}) {
  const am = new AccountManager(specs.map(s => oauth(s.name, s.extra)), 0.98,
    { distributeSessions: distribute, sessionTracker: tracker, ...(er ? { expiryRouting: er } : {}) });
  const now = Date.now();
  specs.forEach((s, i) => {
    const q = am.accounts[i].quota;
    if (s.used != null) { q.unified7d = s.used; q.unified7dReset = now + s.resetH * H; }
    if (s.fableUsed != null) { q.unified7dFable = s.fableUsed; q.unified7dFableReset = now + s.fableResetH * H; }
    am.accounts[i].probing = false;
  });
  return am;
}

// Route a session request the way the server does: hold the session in flight
// for the whole request, select, record the pin, and — once the attempt is the
// one the client gets — confirm what served it and release the hold. The server
// wiring itself is covered end-to-end in test/server-session-routing.test.js.
function route(am, sid, model = OPUS, advisorModel = null) {
  am.beginSession(sid);
  try {
    const decision = {};
    const acc = am.getActiveAccount(null, model, advisorModel, sid, decision);
    if (acc) {
      am.recordSession(sid, acc.index, model, advisorModel, decision);
      am.confirmRouted(sid, acc.index, model, advisorModel, decision);
    }
    return acc;
  } finally {
    am.endSession(sid);
  }
}

// Everything the status endpoint says about rollovers, in one object, so a test
// asserts the whole triple rather than the one number it expected to move.
function rolloverStats(am) {
  return am.getStatus().expiryRouting.stats;
}

function noRollovers() {
  return { rolloversDetected: 0, rolloversPreempted: 0, rolloversOwed: 0 };
}

// Collect what the daemon logged while `fn` ran. The stuck-rollover line is an
// operator-facing signal like the preemption line beside it, so it is asserted
// the same way an operator would read it: off the log.
function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = real; }
  return lines;
}

const STUCK = 'no eligible account can take that traffic';

// Roll an account's Fable weekly window, leaving the shared one alone.
function rollFable(am, idx) {
  const q = am.accounts[idx].quota;
  q.unified7dFable = 0;
  q.unified7dFableReset += 168 * H;
}

// Roll an account's shared weekly window: fresh utilization, reset a week later.
function rollWeekly(am, idx) {
  const q = am.accounts[idx].quota;
  q.unified7d = 0;
  q.unified7dReset += 168 * H;
}

test('pressure prefers ample quota that expires soonest', () => {
  const specs = [
    { name: 'later', used: 0.1, resetH: 150 },
    { name: 'soon', used: 0.1, resetH: 50 },
  ];
  // With equal session counts the flag-off tiebreak also lands on 'soon', so give
  // it a session first: only the band still prefers it once it is the loaded one.
  const am = manager(specs);
  route(am, 'existing');
  assert.equal(route(am, 's1').name, 'soon');

  const flagOff = manager(specs, { er: null });
  route(flagOff, 'existing');
  assert.equal(route(flagOff, 's1').name, 'later');
});

test('a drained account is not preferred merely because its window rolls soon', () => {
  const am = manager([
    { name: 'soon-drained', used: 0.95, resetH: 53 },
    { name: 'later-ample', used: 0.07, resetH: 74 },
  ]);
  assert.equal(route(am, 's1').name, 'later-ample');
});

test('negative headroom (overage) clamps to zero pressure, never negative', () => {
  const am = manager([{ name: 'a', used: 1.05, resetH: 50 }]);
  assert.equal(am._expiryPressure(am.accounts[0]), 0);
});

test('band spreads new sessions across near-equal pressures; out-of-band stays untouched', () => {
  const am = manager([
    { name: 'a', used: 0.07, resetH: 56 },
    { name: 'b', used: 0.06, resetH: 77 },
    { name: 'c', used: 0.02, resetH: 160 },
  ]);
  const chosen = ['s1', 's2', 's3', 's4'].map(sid => route(am, sid).name);
  assert.ok(!chosen.includes('c'), `long-dated account was used: ${chosen}`);
  assert.ok(chosen.includes('a') && chosen.includes('b'), `no spread within band: ${chosen}`);
});

test('flag off: the same scenario reaches the long-dated account (band is the protection)', () => {
  const am = manager([
    { name: 'a', used: 0.07, resetH: 56 },
    { name: 'b', used: 0.06, resetH: 77 },
    { name: 'c', used: 0.02, resetH: 160 },
  ], { er: { enabled: false } });
  const chosen = ['s1', 's2', 's3'].map(sid => route(am, sid).name);
  assert.ok(chosen.includes('c'), `expected flag-off spreading to reach c: ${chosen}`);
});

test('band beats load when pressures differ; flag off prefers load', () => {
  const specs = [
    { name: 'soon', used: 0.07, resetH: 50 },
    { name: 'later', used: 0.05, resetH: 160 },
  ];
  const banded = manager(specs);
  route(banded, 'existing'); // one session already on 'soon'
  assert.equal(route(banded, 'fresh').name, 'soon'); // band excludes 'later' anyway

  const flagOff = manager(specs, { er: { enabled: false } });
  route(flagOff, 'existing');
  assert.equal(route(flagOff, 'fresh').name, 'later'); // least-loaded wins without the band
});

test('a pinned session is preempted exactly once when its weekly window rolls over', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1').name, 'a'); // pinned + rollover detector seeded
  assert.equal(route(am, 's1').name, 'a'); // steady state: pin honored
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'b'); // rollover → preempted off 'a'
  assert.equal(route(am, 's1').name, 'b'); // re-pinned; no further movement
});

test('draining the pinned account never preempts (anti-thrash)', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  // Drain 'a' far out of the pressure band — but no rollover happened.
  am.accounts[0].quota.unified7d = 0.9;
  assert.equal(route(am, 's1').name, 'a');
});

test('the cleared-window null gap does not preempt; the refreshed window does', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  const q = am.accounts[0].quota;
  const oldReset = q.unified7dReset;
  // _clearExpiredQuotas has wiped the window; the probe hasn't repopulated yet.
  q.unified7d = null;
  q.unified7dReset = null;
  assert.equal(route(am, 's1').name, 'a');
  // Probe repopulates with the fresh window → the jump is now visible.
  q.unified7d = 0;
  q.unified7dReset = oldReset + 168 * H;
  assert.equal(route(am, 's1').name, 'b');
});

test('preempt: false keeps the pin across a rollover', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  // Seeded while preempt is on, so it is the honor-path gate that holds the pin
  // below and not an empty detector with nothing to compare against.
  assert.equal(route(am, 's1').name, 'a');
  am.setExpiryRouting({ enabled: true, preempt: false });
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'a');
});

test('fable requests are scored on the fable bucket, opus on the shared weekly', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 140, fableUsed: 0.05, fableResetH: 140 },
    { name: 'b', used: 0.1, resetH: 50, fableUsed: 0.9, fableResetH: 50 },
  ]);
  assert.equal(route(am, 'opus-sess', OPUS).name, 'b');   // shared weekly: ample + soon
  assert.equal(route(am, 'fable-sess', FABLE).name, 'a'); // fable bucket: b is nearly spent
});

test('a session alternating models never sees a false rollover across buckets', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 50, fableUsed: 0.1, fableResetH: 50 },
    // 'b' is nearly out of Fable, so the band keeps both families on 'a' and the
    // alternation below is the only thing that could move the session.
    { name: 'b', used: 0.3, resetH: 55, fableUsed: 0.9, fableResetH: 55 },
  ]);
  assert.equal(route(am, 's1', OPUS).name, 'a');
  assert.equal(route(am, 's1', FABLE).name, 'a');
  assert.equal(route(am, 's1', OPUS).name, 'a');
  assert.equal(route(am, 's1', FABLE).name, 'a');
});

test('unknown quota stays in the top band (probe-discovery bias preserved)', () => {
  const am = manager([
    { name: 'known', used: 0.1, resetH: 50 },
    { name: 'unknown' },
  ]);
  // Unknown reset sorts first in the load tiebreak, so it must not have been
  // banded out despite having no pressure value.
  assert.equal(route(am, 's1').name, 'unknown');
});

test('a high-pressure low-priority fallback cannot band out the preferred tier', () => {
  const am = manager([
    { name: 'preferred', used: 0.1, resetH: 150, extra: { priority: 0 } },
    { name: 'fallback', used: 0.1, resetH: 30, extra: { priority: 10 } },
  ]);
  assert.equal(route(am, 's1').name, 'preferred');
  assert.equal(am._pickBestAvailable().name, 'preferred');
});

test('distribute off: the current account is re-ranked when its window rolls over', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a'); // sticky + detector seeded
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b'); // sticky on the new choice
});

test('distribute off: drain does not move the current account', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  am.accounts[0].quota.unified7d = 0.9;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

test('setExpiryRouting normalizes: tolerance below 1 clamps, defaults apply', () => {
  const am = manager([{ name: 'a' }]);
  am.setExpiryRouting({ enabled: true, tolerance: 0.2 });
  assert.equal(am.expiryRouting.tolerance, 1);
  am.setExpiryRouting({ enabled: true, tolerance: 0 });
  assert.equal(am.expiryRouting.tolerance, 1); // an explicit 0 clamps, not defaults
  am.setExpiryRouting({ enabled: true, tolerance: Infinity });
  assert.equal(am.expiryRouting.tolerance, 1.5); // a band of everything is not a band
  am.setExpiryRouting({ enabled: true, tolerance: 'wide' });
  assert.equal(am.expiryRouting.tolerance, 1.5);
  am.setExpiryRouting({ enabled: true, tolerance: null });
  assert.equal(am.expiryRouting.tolerance, 1.5); // null is "no value", not zero
  am.setExpiryRouting({ enabled: true, tolerance: '' });
  assert.equal(am.expiryRouting.tolerance, 1.5);
  am.setExpiryRouting({ enabled: true, tolerance: '2' });
  assert.equal(am.expiryRouting.tolerance, 1.5); // a string is not a number, even a numeric one
  am.setExpiryRouting({ enabled: true });
  assert.equal(am.expiryRouting.tolerance, 1.5);
  assert.equal(am.expiryRouting.preempt, true);
  am.setExpiryRouting({ enabled: true, preempt: 0 });
  assert.equal(am.expiryRouting.preempt, true); // only a real false turns it off
  am.setExpiryRouting({ enabled: true, preempt: false });
  assert.equal(am.expiryRouting.preempt, false);
  am.setExpiryRouting({ enabled: 'false' });
  assert.equal(am.expiryRouting.enabled, false); // a truthy string must not enable
  am.setExpiryRouting(undefined);
  assert.equal(am.expiryRouting.enabled, false);
});

test('getStatus exposes the config and per-account pressure', () => {
  const am = manager([{ name: 'a', used: 0.5, resetH: 100 }]);
  const status = am.getStatus();
  assert.equal(status.expiryRouting.enabled, true);
  assert.ok(status.accounts[0].pressure > 0);
});

test('a family bucket that disappears is not a rollover of the shared one', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 150, fableUsed: 0.05, fableResetH: 50 },
    { name: 'b', used: 0.1, resetH: 160, fableUsed: 0.1, fableResetH: 60 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'a');
  // The Fable window expired and has not been repopulated yet. The shared
  // weekly is still live and dated later — comparing against it would read as
  // a forward jump, which is exactly the null gap that must not preempt.
  const q = am.accounts[0].quota;
  q.unified7dFable = null;
  q.unified7dFableReset = null;
  assert.equal(route(am, 's1', FABLE).name, 'a');
});

test('a family bucket learned mid-session is not a rollover of the shared one', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 150 },
    { name: 'b', used: 0.1, resetH: 400 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'a'); // no Fable bucket: scored on the shared weekly
  assert.equal(route(am, 's1', FABLE).name, 'a'); // steady state
  // A probe learns the Fable bucket, whose window is dated differently from the
  // shared one it was standing in for. A new bucket is not a rollover.
  const q = am.accounts[0].quota;
  q.unified7dFable = 0.05;
  q.unified7dFableReset = Date.now() + 300 * H;
  assert.equal(route(am, 's1', FABLE).name, 'a');
});

test('with no family bucket, a shared-weekly rollover still preempts a Fable pin', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'a');
  rollWeekly(am, 0); // the shared weekly is what governs Fable here
  assert.equal(route(am, 's1', FABLE).name, 'b');
});

test('a rollover baseline is bounded by the session cap, not a second one', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { tracker: new SessionTracker({ maxSessions: 8 }) });
  for (let i = 0; i < 600; i++) route(am, `s${i}`);
  const withBaselines = [...am.sessionTracker.sessions.values()].filter(s => s.windows).length;
  assert.ok(am.sessionTracker.sessions.size <= 8, `map grew to ${am.sessionTracker.sessions.size}`);
  assert.ok(withBaselines > 0, 'no session kept a baseline at all');
  assert.ok(am.sessionTracker.windowsFor('s599'), 'the newest baseline was evicted');
  assert.equal(am.sessionTracker.windowsFor('s0'), null, 'the oldest baseline survived the cap');
  // Eviction is not a broken session: it re-seeds on its next request, and its
  // account's next rollover still moves it.
  const acc = route(am, 's0');
  const other = am.accounts[1 - acc.index];
  rollWeekly(am, acc.index);
  assert.equal(route(am, 's0').name, other.name);
});

// The baseline is only read by _selectForSession, which never runs with
// distribution off — building one there would accumulate state nothing reads.
test('with distribution off nothing seeds the pin rollover map', () => {
  const am = manager([{ name: 'a', used: 0.1, resetH: 50 }], { distribute: false });
  am.recordSession('s1', 0);
  assert.equal(am.sessionTracker.windowsFor('s1'), null);
});

// A session that keeps making requests holds the most recent slot in the one
// map that bounds it, so churn evicts the idle sessions around it instead.
test('a live session keeps its baseline while unrelated sessions churn past the cap', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
  ], { tracker: new SessionTracker({ maxSessions: 8 }) });
  route(am, 'live');
  for (let i = 0; i < 600; i++) { route(am, `s${i}`); route(am, 'live'); }
  rollWeekly(am, 0);
  assert.equal(route(am, 'live').name, 'b', 'the live session lost the baseline that detects its rollover');
});

test('a NaN utilization does not empty the band', () => {
  const am = manager([
    { name: 'poison', used: 0.1, resetH: 50 },
    { name: 'ok1', used: 0.1, resetH: 60 },
    { name: 'ok2', used: 0.2, resetH: 70 },
  ]);
  am.accounts[0].quota.unified7d = NaN;
  const band = am._topPressureBand(am.accounts.slice(), OPUS).map(a => a.name);
  assert.ok(band.includes('ok1') && band.includes('ok2'), `healthy accounts banded out: ${band}`);
  assert.ok(am._pickBestAvailable(null, OPUS), 'no account selectable');
});

test('an infinite utilization does not collapse the band onto itself', () => {
  const am = manager([
    { name: 'poison', used: 0.1, resetH: 50 },
    { name: 'ok1', used: 0.1, resetH: 60 },
    { name: 'ok2', used: 0.2, resetH: 70 },
  ]);
  am.accounts[0].quota.unified7d = -Infinity;
  const band = am._topPressureBand(am.accounts.slice(), OPUS).map(a => a.name);
  assert.ok(band.includes('ok1') && band.includes('ok2'), `healthy accounts banded out: ${band}`);
});

test('a finite negative utilization scores as an empty window, not unbounded headroom', () => {
  const specs = [
    { name: 'poison', used: 0.1, resetH: 50 },
    { name: 'ok1', used: 0.1, resetH: 60 },
    { name: 'ok2', used: 0.2, resetH: 70 },
  ];
  const am = manager(specs);
  const ref = manager(specs);
  // Finite, so every Number.isFinite guard passes it through; only the 0-1
  // domain clamp keeps its headroom from dwarfing every real account's.
  am.accounts[0].quota.unified7d = -1e300;
  ref.accounts[0].quota.unified7d = 0; // the emptiest window it can possibly mean
  const now = Date.now();
  assert.equal(am._expiryPressure(am.accounts[0], OPUS, now),
    ref._expiryPressure(ref.accounts[0], OPUS, now));
  const band = am._topPressureBand(am.accounts.slice(), OPUS).map(a => a.name);
  assert.deepEqual(band, ref._topPressureBand(ref.accounts.slice(), OPUS).map(a => a.name));
  assert.ok(band.length > 1, `the poisoned account captured the band alone: ${band}`);
  assert.ok(am._pickBestAvailable(null, OPUS), 'no account selectable');
});

test('a negative utilization header is not stored', () => {
  const am = manager([{ name: 'a' }]);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '-5' });
  assert.equal(am.accounts[0].quota.unified7d, null);
});

test('a negative utilization in restored state is not applied', () => {
  const am = manager([{ name: 'a' }]);
  const reset = Date.now() + 50 * H;
  am.restoreQuotaState([{ name: 'a', quota: { unified7d: -5, unified7dReset: reset } }]);
  assert.equal(am.accounts[0].quota.unified7d, null);
  assert.equal(am.accounts[0].quota.unified7dReset, reset);
});

// A reset is what retires a spent bucket. One that is not a number makes
// `now >= reset` never true, so nothing ever retires it: the account sits at or
// over threshold, is never selected, and never gets the response that would
// correct it — out of rotation until someone deletes the state file by hand.
test('restored quota fields outside their domain are dropped, valid ones kept', () => {
  const am = manager([{ name: 'a' }]);
  const good = Date.now() + 50 * H;
  am.restoreQuotaState([{ name: 'a', quota: {
    unified7d: 0.5, unified7dReset: good,
    unified5h: 0.4, unified5hReset: 'whenever',
    unified7dFable: 0.3, unified7dFableReset: Infinity,
    tokensLimit: 'lots', tokensRemaining: 5,
    requestsLimit: 10, requestsRemaining: -1,
    resetsAt: 'not-a-date', unifiedStatus: 'allowed',
  } }]);
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.5);
  assert.equal(q.unified7dReset, good);
  assert.equal(q.unifiedStatus, 'allowed');
  assert.equal(q.unified5hReset, null, 'a non-numeric reset was restored');
  assert.equal(q.unified7dFableReset, null, 'a non-finite reset was restored');
  assert.equal(q.tokensLimit, null);
  assert.equal(q.requestsRemaining, null);
  assert.equal(q.resetsAt, null);
});

test('a restored bucket whose window did not survive is unknown, not spent forever', () => {
  const am = manager([{ name: 'a' }, { name: 'b', used: 0.1, resetH: 60 }]);
  am.restoreQuotaState([{ name: 'a', quota: { unified5h: 0.99, unified5hReset: 'whenever' } }]);
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].quota.unified5h, null,
    'a spent utilization was restored with no window that can ever retire it');
  assert.ok(am._isAvailable(am.accounts[0]), 'the account is out of rotation with nothing that can bring it back');
});

// The usage endpoint is the third writer of these fields and reaches them over
// the network like the other two, so it is validated like the other two.
test('the usage endpoint cannot write a value outside its field\'s domain', () => {
  const am = manager([{ name: 'a' }]);
  const good = Date.now() + 50 * H;
  am.applyUsageData(0, {
    fiveHour: { utilization: -5, resetAt: good },
    sevenDay: { utilization: 0.4, resetAt: 'whenever' },
    sevenDayFable: { utilization: 0.2, resetAt: good },
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified5h, null, 'a negative utilization was stored');
  assert.equal(q.unified5hReset, good);
  assert.equal(q.unified7d, 0.4);
  assert.equal(q.unified7dReset, null, 'a non-numeric reset was stored');
  assert.equal(q.unified7dFable, 0.2);
  assert.equal(q.unified7dFableReset, good);
});

// One rule for what governs a request: the family bucket as soon as the account
// reports a utilization for it. Its window being unreported makes the PRESSURE
// unknown — it must not be scored on the shared weekly's horizon, which would
// rank this account on headroom its Fable bucket does not have.
// One rule for what governs a request: the family bucket as soon as the account
// reports a utilization for it. Its window being unreported makes the PRESSURE
// unknown — it must not be scored on the shared weekly's horizon, which would
// rank this account on headroom its Fable bucket does not have.
test('a family utilization with no family reset gates as family and ranks as unknown', () => {
  const am = manager([{ name: 'a', used: 0.1, resetH: 100 }]);
  const q = am.accounts[0].quota;
  q.unified7dFable = 0.9;
  const now = Date.now();
  assert.equal(am._expiryPressure(am.accounts[0], FABLE, now), null);
  assert.ok(am._expiryPressure(am.accounts[0], OPUS, now) > 0);
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), 0.9, 'the family gate was lost');
});

test('a family utilization without its reset cannot band out the accounts that have that quota', () => {
  // 'spent' has almost no Fable left and reports no Fable window; 'fresh' has
  // plenty. Scoring 'spent' from the shared pair credits it with the shared
  // weekly's 0.9 headroom over a 50h horizon — a pressure high enough to set
  // the band floor and exclude the one account that can actually serve Fable.
  const am = manager([
    { name: 'spent', used: 0.1, resetH: 50 },
    { name: 'fresh', used: 0.1, resetH: 400, fableUsed: 0.05, fableResetH: 400 },
  ]);
  am.accounts[0].quota.unified7dFable = 0.9;
  const band = am._topPressureBand(am.accounts.slice(), FABLE).map(a => a.name);
  assert.ok(band.includes('fresh'), `the account holding the Fable quota was banded out: ${band}`);
  // With both in the band, load decides — and 'spent' is the loaded one.
  route(am, 'existing', FABLE);
  assert.equal(route(am, 's1', FABLE).name, 'fresh');
});

test('a family reset with no family utilization is governed by the shared weekly', () => {
  const am = manager([{ name: 'a', used: 0.5, resetH: 100 }]);
  am.accounts[0].quota.unified7dFableReset = Date.now() + 300 * H;
  const now = Date.now();
  assert.equal(am._expiryPressure(am.accounts[0], FABLE, now),
    am._expiryPressure(am.accounts[0], OPUS, now));
  assert.equal(am._windowKeyFor(am.accounts[0], FABLE), 'unified7d');
});

test('non-finite quota headers are ignored rather than stored', () => {
  const am = manager([{ name: 'a' }]);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d-utilization': '-1e400',
    'anthropic-ratelimit-unified-7d-reset': 'whenever',
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, null);
  assert.equal(q.unified7dReset, null);
});

test('an advisor-only stretch still observes the current account rolling over', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { distribute: false });
  am.currentIndex = 0;
  // Every request in this stretch carries an advisor model, so selection only
  // ever runs the advisor-constrained pass — which must not be blind.
  assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'a');
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'a'); // observed, not acted on
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');        // the plain pass acts
});

test('a rollover owed on one bucket is not consumed by another bucket\'s request', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.05, fableResetH: 50 },
    { name: 'b', used: 0.05, resetH: 60, fableUsed: 0.99, fableResetH: 300 }, // no Fable
    { name: 'c', used: 0.9, resetH: 300, fableUsed: 0.05, fableResetH: 300 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'a'); // Fable pinned to 'a'
  am.accounts[2].disabled = true;                 // nowhere for Fable to move yet
  rollFable(am, 0);
  assert.equal(route(am, 's1', FABLE).name, 'a'); // detected, owed on the Fable bucket
  // An Opus request for the same session lands elsewhere and is confirmed. It
  // moved no Fable traffic, so it must not settle the Fable rollover.
  assert.equal(route(am, 's1', OPUS).name, 'b');
  am.accounts[2].disabled = false;
  assert.equal(route(am, 's1', FABLE).name, 'c');
});

test('a rollover that moves nothing is not consumed (pinned session)', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  am.accounts[1].disabled = true; // nowhere to move to
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'a');
  am.accounts[1].disabled = false;
  assert.equal(route(am, 's1').name, 'b'); // the event is still pending
});

test('a rollover that moves nothing is not consumed (current account)', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  am.accounts[1].disabled = false;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

test('removing an account does not make the renumbering look like a rollover', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 70 },
    { name: 'c', used: 0.1, resetH: 80 },
  ]);
  am.recordSession('s1', 0); // session pinned to 'a', windows seeded from it
  am.removeAccount(0);       // 'b' slides into index 0, which 's1' still records
  assert.equal(route(am, 's1').name, 'b'); // unpinned, re-routed, re-pinned
  assert.equal(route(am, 's1').name, 'b'); // 'a' windows must not be read as 'b' rolling over
});

test('a sub-window forward move of the reset is not a rollover', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
  ]);
  am.recordSession('s1', 0); // pinned to 'a', baseline seeded from it
  am.confirmRouted('s1', 0);
  assert.equal(route(am, 's1').name, 'a');
  // The two writers of a reset disagree on precision — whole seconds from a
  // response header, milliseconds from the usage endpoint — so one instant
  // reaches the detector as two values a fraction of a second apart.
  for (const delta of [1, 1000, 60_000]) {
    am.accounts[0].quota.unified7dReset += delta;
    assert.equal(route(am, 's1').name, 'a', `a ${delta}ms move preempted the pin`);
  }
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'b'); // a real weekly roll still fires
});

test('a pin rollover survives a retry that lands back on the rolled account', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
  ]);
  am.recordSession('s1', 0);
  am.confirmRouted('s1', 0);
  rollWeekly(am, 0);
  // The rollover re-routes to 'b', and the server pins the session there before
  // it sends — exactly the order the request path uses.
  const first = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(first.name, 'b');
  am.recordSession('s1', first.index);
  // 'b' throws; the retry excludes it and comes back to the rolled account.
  const retry = am.getActiveAccount(new Set([first.index]), OPUS, null, 's1');
  assert.equal(retry.name, 'a');
  am.recordSession('s1', retry.index);
  am.confirmRouted('s1', retry.index); // this attempt is the one that was served
  // Nothing ever moved off 'a', so the event is still owed.
  assert.equal(route(am, 's1').name, 'b');
});

// Two requests for one session overlap during a rollover. The one served off
// the rolled account banks the move; the slower one fails over and back onto
// it. Whichever finishes LAST says where the session ended up — settling at the
// first confirm leaves the session riding the rolled account with nothing owed.
test('a sibling confirm cannot settle a rollover the session then fails back onto', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  rollWeekly(am, 0);

  am.beginSession('s1');                                   // R1 starts
  const r1 = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(r1.name, 'b', 'the rollover did not preempt');
  am.recordSession('s1', r1.index, OPUS);

  am.beginSession('s1');                                   // R2 overlaps it
  const r2 = am.getActiveAccount(null, OPUS, null, 's1');
  am.recordSession('s1', r2.index, OPUS);
  am.confirmRouted('s1', r2.index, OPUS);
  am.endSession('s1');                                     // R2 done, R1 still out

  // R1's attempt on 'b' throws; the retry excludes it and comes back to 'a'.
  const retry = am.getActiveAccount(new Set([r1.index]), OPUS, null, 's1');
  assert.equal(retry.name, 'a');
  am.recordSession('s1', retry.index, OPUS);
  am.confirmRouted('s1', retry.index, OPUS);
  am.endSession('s1');

  assert.equal(route(am, 's1').name, 'b', 'the session was left on the rolled account with nothing owed');
});

test('a rollover the session did move off is settled once, not re-fired', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'b');
  // Settled: 'a' is a normal candidate again, not one the session is repelled
  // from every time it lands there.
  am.accounts[1].disabled = true;
  assert.equal(route(am, 's1').name, 'a');
  am.accounts[1].disabled = false;
  assert.equal(route(am, 's1').name, 'a');
});

// The account a rollover moved a session TO is not itself rolled over. Reading
// the owed event as "this account rolled" whatever account is asking chains the
// session off one healthy account after another.
test('a preempted session settles on its destination instead of chaining onward', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
    { name: 'c', used: 0.05, resetH: 70 },
  ]);
  am.recordSession('s1', 0, OPUS);
  am.confirmRouted('s1', 0, OPUS);
  rollWeekly(am, 0);
  // The preemption moves the session, but this request never completes, so the
  // event is still owed when the next one arrives.
  const first = am.getActiveAccount(null, OPUS, null, 's1');
  assert.notEqual(first.name, 'a');
  am.recordSession('s1', first.index, OPUS);
  const second = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(second.name, first.name, 'the owed event chained the session onto a third account');
});

// One request goes to ONE account, so the executor's bucket is what binds it;
// the advisor's model is a constraint on that choice, not a second pin to look
// up. Keying on the advisor's bucket hands the request to whichever account the
// session's OTHER family happens to sit on.
test('an advisor request follows the executor\'s pin, not the advisor\'s', () => {
  const am = manager([
    { name: 'opus-home', used: 0.2, resetH: 50, fableUsed: 0.2, fableResetH: 50 },
    { name: 'fable-home', used: 0.2, resetH: 300, fableUsed: 0.5, fableResetH: 300 },
  ]);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s1', 1, FABLE);
  assert.equal(am.getActiveAccount(null, OPUS, FABLE, 's1').name, 'opus-home');
});

// An advisor request pins both families because the account serves both. When
// no account is eligible for both, selection degrades to executor-only and the
// advisor sub-inference is dropped upstream — so that account served the
// executor alone, and pinning the advisor's family there points it at an
// account that never served it and may not be able to.
test('a degraded advisor request pins the executor\'s family only', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 },  // no Fable left
    { name: 'b', used: 0.99, resetH: 50, fableUsed: 0.05, fableResetH: 60 }, // no Opus left
  ]);
  am.recordSession('s1', 1, FABLE); // the session's Fable traffic lives on 'b'
  const decision = {};
  const acc = am.getActiveAccount(null, OPUS, FABLE, 's1', decision);
  assert.equal(acc.name, 'a', 'expected the degrade path');
  assert.equal(decision.advisorServed, false);
  am.recordSession('s1', acc.index, OPUS, FABLE, decision);
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7d'), 0);
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7dFable'), 1,
    'the dropped advisor family was pinned to the account that never served it');
});

test('a degraded advisor request does not settle the advisor family\'s rollover', () => {
  // Only 'a' can serve Opus, and it cannot serve Fable — so an Opus request
  // carrying a Fable advisor has no jointly-eligible account and degrades.
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 },
    { name: 'b', used: 0.99, resetH: 50, fableUsed: 0.3, fableResetH: 50 },
    { name: 'c', used: 0.99, resetH: 50, fableUsed: 0.05, fableResetH: 60 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'b'); // Fable pinned to 'b'
  am.accounts[2].disabled = true;                 // nowhere for Fable to move yet
  rollFable(am, 1);
  assert.equal(route(am, 's1', FABLE).name, 'b'); // detected, owed on the Fable bucket
  am.accounts[2].disabled = false;

  // An Opus+Fable-advisor request degrades onto 'a' (Fable-exhausted). It moved
  // no Fable traffic anywhere, so it must not bank the Fable rollover.
  const decision = {};
  const acc = am.getActiveAccount(null, OPUS, FABLE, 's1', decision);
  assert.equal(acc.name, 'a');
  am.recordSession('s1', acc.index, OPUS, FABLE, decision);
  am.confirmRouted('s1', acc.index, OPUS, FABLE, decision);

  assert.equal(route(am, 's1', FABLE).name, 'c', 'the degraded request settled a rollover it never moved');
});

test('an advisor request that was not degraded still pins both families', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.2, fableResetH: 50 },
    { name: 'b', used: 0.2, resetH: 400, fableUsed: 0.2, fableResetH: 400 },
  ]);
  const decision = {};
  const acc = am.getActiveAccount(null, OPUS, FABLE, 's1', decision);
  assert.equal(decision.advisorServed, true);
  am.recordSession('s1', acc.index, OPUS, FABLE, decision);
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7d'), acc.index);
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7dFable'), acc.index);
});

// A route pin is the operator saying where a model goes. Session affinity is a
// cache optimisation, and it must not quietly outrank that — including when the
// route covers only the ADVISOR's model.
test('a route pin on the advisor model still wins over session affinity', () => {
  const am = manager([
    { name: 'pin-target', used: 0.2, resetH: 300 },
    { name: 'session-home', used: 0.2, resetH: 50 },
  ]);
  am.setRoutes([{ name: 'fable', match: ['*fable*'] }]);
  assert.equal(am.setRoutePin('fable', 0).ok, true);
  am.recordSession('s1', 1, OPUS);
  assert.equal(am.getActiveAccount(null, OPUS, FABLE, 's1').name, 'pin-target');
});

// A preemption with nowhere to go leaves the session exactly where it was, so
// nothing switched — arming a ramp there would pace requests onto the account
// that is already serving them.
test('a rollover with nowhere to move does not pace the account already serving', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ]);
  route(am, 's1');
  am.accounts[1].disabled = true;
  am.accounts[0].rampStartedAt = null;
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'a');
  assert.equal(am.accounts[0].rampStartedAt, null,
    'the account already serving the session was paced as if it had just been switched to');
});

test('a current-account rollover survives a retry that lands back on it', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
  assert.equal(am.getActiveAccount(new Set([1]), OPUS).name, 'a'); // 'b' threw
  am.confirmRouted(null, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

// `_currentSeen` belongs to the sticky current-account walk. Everything else
// that routes a request — a session's pin, a /tc-acct/ pin, the keep-warm
// scheduler — never consults `currentIndex`, so confirming one of those must
// not consume an event that walk is still owed.
test('a request that never consulted the current account does not settle its rollover', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  am.currentIndex = 0;
  const seen = {};
  assert.equal(am.getActiveAccount(null, OPUS, null, null, seen).name, 'a'); // baseline seeded
  assert.equal(seen.viaCurrent, true);
  rollWeekly(am, 0);
  // An advisor-carrying request observes the rollover but cannot act on it, so
  // the event is owed when the next requests arrive.
  assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'a');

  // A /tc-acct/ pin: the server forces the account and never calls selection.
  am.recordSession('pinned-sess', 1, OPUS);
  am.confirmRouted('pinned-sess', 1, OPUS);
  // A distributed session's request: routed by its own pin, not by currentIndex.
  const sessionDecision = {};
  const acc = am.getActiveAccount(null, OPUS, null, 's1', sessionDecision);
  assert.equal(sessionDecision.viaCurrent, undefined, 'the session path claimed the current-account walk');
  am.recordSession('s1', acc.index, OPUS, null, sessionDecision);
  am.confirmRouted('s1', acc.index, OPUS, null, sessionDecision);

  assert.equal(am.getActiveAccount(null, OPUS).name, 'b',
    'an unrelated request swallowed the current account\'s rollover');
});

test('a request routed by the current-account walk does settle its rollover', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  rollWeekly(am, 0);
  const decision = {};
  assert.equal(am.getActiveAccount(null, OPUS, null, null, decision).name, 'b');
  am.confirmRouted(null, 1, OPUS, null, decision);
  // Settled: 'a' is an ordinary candidate again rather than one the walk is
  // still owed a move off.
  am.accounts[1].disabled = true;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  am.accounts[1].disabled = false;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

// Every writer of `currentIndex` has to leave a baseline behind, or the first
// pass that consults it after a quiet stretch first-sights the window instead
// of comparing against it — and a rollover in between is gone for a week.
test('the account chosen at launch is a rollover baseline, not a first sight', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(am.selectActiveAccount().name, 'a');
  // Every request in between is session-routed, so nothing consults currentIndex.
  for (let i = 0; i < 5; i++) route(am, `s${i}`);
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b',
    'the launch-time account had no baseline, so its rollover read as first sight');
});

test('the current-account baseline covers every bucket, not only the one first served', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.2, fableResetH: 50 },
    { name: 'b', used: 0.1, resetH: 100, fableUsed: 0.1, fableResetH: 100 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a'); // only Opus traffic so far
  const q = am.accounts[0].quota;
  q.unified7dFable = 0;
  q.unified7dFableReset += 168 * H;
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
});

test('removing an unrelated account keeps the current-account rollover detectable', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 60 },
    { name: 'doomed', used: 0.1, resetH: 60 },
    { name: 'c', used: 0.5, resetH: 50 },
  ], { distribute: false });
  am.currentIndex = 2;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'c'); // baseline seeded on 'c'
  am.removeAccount(1);
  assert.equal(am.currentIndex, 1);
  rollWeekly(am, 1);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

test('a live pinned session keeps its baseline through unrelated session churn', () => {
  // The tracker forgets an idle session almost immediately here; the live one
  // holds a request in flight, which keeps it pinned however long it streams.
  let t = Date.now();
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
  ], { tracker: new SessionTracker({ knownTtlMs: 1, activeTtlMs: 1, now: () => t }) });
  am.recordSession('live', 0);
  am.confirmRouted('live', 0);
  am.beginSession('live');
  for (let i = 0; i < 600; i++) { t += 10; route(am, `s${i}`); }
  t += 10;
  rollWeekly(am, 0);
  assert.equal(am.sessionTracker.pinnedAccount('live', 'unified7d'), 0, 'the live session lost its pin');
  assert.equal(route(am, 'live').name, 'b');
});

test('the rollover baseline seeds every bucket a route can make governing', () => {
  // The current account serves every bucket, so its baseline covers all of them
  // — including one a route's `bucket` override names, which the model family
  // table never mentions.
  const am = manager([{ name: 'a', used: 0.1, resetH: 50 }], { distribute: false });
  am.setRoutes([{ name: 'custom', match: ['*custom*'], bucket: 'unified7dCustom' }]);
  const q = am.accounts[0].quota;
  q.unified7dFable = 0.1;
  q.unified7dFableReset = Date.now() + 60 * H;
  q.unified7dSonnet = 0.1;
  q.unified7dSonnetReset = Date.now() + 70 * H;
  q.unified7dCustom = 0.2;
  q.unified7dCustomReset = Date.now() + 80 * H;
  am.currentIndex = 0;
  am.getActiveAccount(null, OPUS);
  const seeded = am._currentSeen.windows;
  for (const model of [OPUS, FABLE, 'claude-sonnet-4-6', 'my-custom-1']) {
    const key = am._windowKeyFor(am.accounts[0], model);
    assert.ok(seeded.has(key), `${model} is governed by unseeded bucket ${key}`);
  }
});

test('a pin preemption paces the herd onto its destination', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.05, resetH: 60 },
  ]);
  am.recordSession('s1', 0);
  am.confirmRouted('s1', 0);
  am.accounts[1].rampStartedAt = null;
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'b');
  assert.ok(am.accounts[1].rampStartedAt != null, 'the destination started no ramp window');
});

test('distribute off: the band overrides the soonest-reset tiebreak', () => {
  const specs = [
    { name: 'drained-sooner', used: 0.95, resetH: 50 },
    { name: 'ample-later', used: 0.05, resetH: 90 },
  ];
  const am = manager(specs, { distribute: false });
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'ample-later');
  const flagOff = manager(specs, { er: { enabled: false }, distribute: false });
  assert.equal(flagOff._pickBestAvailable(null, OPUS).name, 'drained-sooner');
});

test('distribute off: a currentIndex move to a later-dated account is not a rollover', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.2, resetH: 300 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a'); // baseline seeded on 'a'
  // currentIndex has writers that never touch the detector (a manual switch,
  // the probe, a reset). The later-dated window it moves to is not a jump.
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

test('a session-quota reset cannot park the current account outside the band', () => {
  const am = manager([
    { name: 'ample-later', used: 0.07, resetH: 160 },
    { name: 'drained-sooner', used: 0.9, resetH: 50 },
  ], { distribute: false });
  am.currentIndex = 0;
  const q = am.accounts[1].quota;
  q.unified5h = 0.5;
  q.unified5hReset = Date.now() - 1000; // its 5h window just expired
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'ample-later');
});

test('a Fable rollover preemption does not drag the session\'s Opus traffic', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.5, fableResetH: 50 },
    { name: 'b', used: 0.5, resetH: 300, fableUsed: 0.05, fableResetH: 300 },
  ]);
  assert.equal(route(am, 's1', OPUS).name, 'a');  // Opus band is [a]
  assert.equal(route(am, 's1', FABLE).name, 'a'); // Fable band is [a] too, for now
  rollFable(am, 0);
  assert.equal(route(am, 's1', FABLE).name, 'b'); // the rolled Fable window preempts
  // 'b' is far outside the Opus band — the Fable decision must not have moved
  // the Opus affinity onto it.
  assert.equal(route(am, 's1', OPUS).name, 'a');
});

test('a shared-weekly rollover moves the Opus pin and leaves the Fable pin alone', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.05, fableResetH: 50 },
    { name: 'b', used: 0.05, resetH: 60, fableUsed: 0.9, fableResetH: 400 },
  ]);
  assert.equal(route(am, 's1', OPUS).name, 'a');
  assert.equal(route(am, 's1', FABLE).name, 'a');
  rollWeekly(am, 0); // only the shared weekly rolls; the Fable bucket is untouched
  assert.equal(route(am, 's1', OPUS).name, 'b');
  assert.equal(route(am, 's1', FABLE).name, 'a');
});

// The window KEY collapses to the shared weekly for any bucket the account does
// not meter, and the live fleet meters no Sonnet bucket at all — so an ordinary
// Opus+Sonnet session has two buckets resolving to one key. A baseline keyed by
// the key alone merges them, each request overwrites the other's, and no
// rollover is detectable for that session on either family.
test('two buckets sharing a window key keep a baseline per account', () => {
  const SONNET = 'claude-sonnet-4-6';
  const am = manager([
    // Neither account reports a Sonnet bucket, so both models resolve to the
    // 'unified7d' window key while the pins sit on different accounts.
    { name: 'a', used: 0.3, resetH: 50 },
    { name: 'b', used: 0.3, resetH: 60 },
    { name: 'c', used: 0.1, resetH: 70 },
  ]);
  am.recordSession('s1', 0, OPUS);   // Opus on 'a'
  am.confirmRouted('s1', 0, OPUS);
  am.recordSession('s1', 1, SONNET); // Sonnet on 'b' — same window key, other account
  am.confirmRouted('s1', 1, SONNET);
  assert.equal(am._windowKeyFor(am.accounts[0], OPUS), am._windowKeyFor(am.accounts[1], SONNET),
    'the two buckets no longer collide, so this scenario proves nothing');
  for (let i = 0; i < 3; i++) {       // alternate, as a real session does
    assert.equal(route(am, 's1', OPUS).name, 'a');
    assert.equal(route(am, 's1', SONNET).name, 'b');
  }
  rollWeekly(am, 0);
  assert.notEqual(route(am, 's1', OPUS).name, 'a', "the Opus baseline was lost to the Sonnet pin's");
  assert.equal(route(am, 's1', SONNET).name, 'b', 'the Sonnet pin moved for an Opus rollover');
});

test('a session pinned per bucket keeps a rollover baseline for each account', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 }, // no Fable left
    { name: 'b', used: 0.99, resetH: 50, fableUsed: 0.1, fableResetH: 50 }, // no Opus left
    { name: 'c', used: 0.05, resetH: 60, fableUsed: 0.9, fableResetH: 300 },
  ]);
  // Opus lands on 'a', Fable on 'b' — one session, two accounts.
  assert.equal(route(am, 's1', OPUS).name, 'a');
  assert.equal(route(am, 's1', FABLE).name, 'b');
  // Alternating between them must not keep wiping each other's baseline: each
  // bucket remembers the window it saw on ITS OWN account.
  assert.equal(route(am, 's1', OPUS).name, 'a');
  assert.equal(route(am, 's1', FABLE).name, 'b');
  rollWeekly(am, 0); // 'a' gains a fresh shared week
  assert.equal(route(am, 's1', OPUS).name, 'c', 'the Opus baseline was lost to alternation');
  assert.equal(route(am, 's1', FABLE).name, 'b', 'the Fable pin moved for an Opus rollover');
});

test('string priorities still form a tier and keep the band engaged', () => {
  const am = manager([
    { name: 'soon', used: 0.07, resetH: 50, extra: { priority: '0' } },
    { name: 'later', used: 0.05, resetH: 160, extra: { priority: '0' } },
  ]);
  route(am, 'existing'); // one session on 'soon', so load alone would move off it
  assert.equal(route(am, 'fresh').name, 'soon');
});

test('one clock per band: a tick between accounts cannot break an exact tie', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 50 },
  ], { er: { enabled: true, tolerance: 1 } });
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t++; // every read is 1ms later than the last
  try {
    assert.equal(am._topPressureBand(am.accounts.slice(), OPUS).length, 2);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// Observability. Every serious defect this feature has had was SILENT: a
// rollover that should have fired and did not, the feature going inert, a
// session stranded on a rolled-over account. The daemon says something when a
// preemption happens and nothing when one is owed and stuck, so these hold the
// numbers and the one log line that tell those two states apart.
// ---------------------------------------------------------------------------

test('a rollover that preempts a pin is counted once, on the event not the request', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  assert.deepEqual(rolloverStats(am), noRollovers(), 'a quiet daemon claims a rollover');
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'b');
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 });
  // Steady state on the destination. rolledOver re-reports an owed event on
  // every pass, so a counter taken from its answer would climb per request.
  for (let i = 0; i < 5; i++) assert.equal(route(am, 's1').name, 'b');
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 },
    'the counters are a traffic meter, not an event count');
});

// The signature of the bug class three review rounds were spent on: the event
// fired, nothing moved, and the daemon looked exactly as it does when nothing
// rolled over at all.
test('a pin rollover with nowhere to move stays owed until something moves', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ]);
  assert.equal(route(am, 's1').name, 'a');
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  for (let i = 0; i < 3; i++) assert.equal(route(am, 's1').name, 'a');
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 0, rolloversOwed: 1 },
    'a rollover stuck across three requests reads as a quiet fleet');
  am.accounts[1].disabled = false;
  assert.equal(route(am, 's1').name, 'b');
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 },
    'the gauge did not clear when the event resolved');
});

test('a stuck current-account rollover is owed until the walk moves off it', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 0, rolloversOwed: 1 },
    'the current account\'s own owed event is not in the gauge');
  am.accounts[1].disabled = false;
  const decision = {};
  assert.equal(am.getActiveAccount(null, OPUS, null, null, decision).name, 'b');
  am.confirmRouted(null, 1, OPUS, null, decision);
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 });
});

// _selectNext re-ranks and may hand back the very account the rollover asked to
// move off. That is the stuck case wearing the shape of a successful one.
test('a re-rank that lands back on the rolled account is not a preemption', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ], { distribute: false });
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  assert.equal(rolloverStats(am).rolloversPreempted, 0,
    'staying on the rolled account was counted as moving off it');
});

test('the stuck-rollover line fires once for the event, not once per request', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ]);
  route(am, 's1');
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  const lines = captureLog(() => { for (let i = 0; i < 5; i++) route(am, 's1'); });
  const stuck = lines.filter(l => l.includes(STUCK));
  assert.equal(stuck.length, 1, `expected one throttled line across five requests, got ${stuck.length}`);
  assert.ok(stuck[0].includes('"a"') && stuck[0].includes('unified7d'),
    `the line names neither the account nor the bucket: ${stuck[0]}`);
});

test('a stuck current-account rollover says so too', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ], { distribute: false });
  am.currentIndex = 0;
  am.getActiveAccount(null, OPUS);
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  const lines = captureLog(() => {
    for (let i = 0; i < 3; i++) assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  });
  assert.equal(lines.filter(l => l.includes(STUCK)).length, 1);
});

// The line exists to separate "quiet because nothing rolled" from "quiet
// because it is stuck". A preemption that worked must not be filed as stuck.
test('a rollover that moves reports the move, not a stuck event', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  route(am, 's1');
  rollWeekly(am, 0);
  const lines = captureLog(() => { assert.equal(route(am, 's1').name, 'b'); });
  assert.equal(lines.filter(l => l.includes(STUCK)).length, 0, 'a successful preemption logged itself stuck');
  assert.ok(lines.some(l => l.includes('Session pin on "a" released')), lines.join('\n'));
});

test('flag off, and preempt off, count nothing and owe nothing', () => {
  for (const er of [null, { enabled: false }, { enabled: true, preempt: false }]) {
    const am = manager([
      { name: 'a', used: 0.5, resetH: 50 },
      { name: 'b', used: 0.1, resetH: 60 },
    ], { er });
    const label = JSON.stringify(er);
    route(am, 's1');
    rollWeekly(am, 0);
    const lines = captureLog(() => { route(am, 's1'); route(am, 's1'); });
    assert.deepEqual(rolloverStats(am), noRollovers(), `counters moved with ${label}`);
    assert.equal(lines.filter(l => l.includes(STUCK)).length, 0, `the stuck line fired with ${label}`);
  }
});

// The counters are monotonic SINCE DAEMON START, and setExpiryRouting replaces
// the config object wholesale on every reload — so anything kept inside it is
// zeroed by an operator editing an unrelated key while watching these numbers.
test('a config reload retunes the feature without zeroing its counters', () => {
  const am = manager([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  route(am, 's1');
  rollWeekly(am, 0);
  assert.equal(route(am, 's1').name, 'b');
  am.setExpiryRouting({ enabled: true, tolerance: 2 });
  assert.equal(am.expiryRouting.tolerance, 2, 'the reload did not apply');
  assert.deepEqual(rolloverStats(am),
    { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 });
});

// perAccount is one number per account and cannot express the model this branch
// was built around: a session holding one family on one account and another on
// a second. perBucket is the only view in which that is visible.
test('the per-bucket view shows one session\'s two families on two accounts', () => {
  const am = manager([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 }, // no Fable left
    { name: 'b', used: 0.99, resetH: 50, fableUsed: 0.1, fableResetH: 50 }, // no Opus left
  ]);
  assert.equal(route(am, 's1', OPUS).name, 'a');
  assert.equal(route(am, 's1', FABLE).name, 'b');
  const sessions = am.getStatus().sessions;
  assert.deepEqual(sessions.perBucket, { unified7d: { 0: 1 }, unified7dFable: { 1: 1 } });
  assert.deepEqual(sessions.perAccount, { 0: 1, 1: 1 },
    'perAccount already distinguishes the two families, so perBucket proves nothing');
});

test('the per-bucket view counts sessions, and never publishes their ids', () => {
  const am = manager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 55 },
  ]);
  // The id is a client-supplied header and this endpoint is read by the status
  // renderer and the TUI, so it must not travel.
  const secret = 'session-id-that-must-not-travel';
  route(am, secret);
  route(am, 'other');
  const status = am.getStatus();
  const counts = Object.values(status.sessions.perBucket.unified7d);
  assert.equal(counts.reduce((a, b) => a + b, 0), 2);
  assert.ok(!JSON.stringify(status).includes(secret), 'a client-supplied session id reached the status payload');
});

// The cap firing means the bound is BINDING: live sessions are losing pins they
// have to re-earn. Forgetting an idle session is the design working, so the two
// must not share a counter.
test('the cap evicting is counted; forgetting an idle session is not', () => {
  let t = Date.now();
  const tracker = new SessionTracker({ maxSessions: 4, knownTtlMs: 50, activeTtlMs: 50, now: () => t });
  const am = manager([{ name: 'a', used: 0.1, resetH: 50 }], { tracker });
  for (let i = 0; i < 10; i++) route(am, `s${i}`);
  assert.equal(am.getStatus().sessions.evicted, 6, 'the cap firing is invisible');
  t += 1000;
  tracker.sweep(t);
  assert.equal(tracker.sessions.size, 0, 'nothing was forgotten, so this proves nothing');
  assert.equal(am.getStatus().sessions.evicted, 6, 'a TTL expiry was counted as a cap eviction');
});

// The eviction that costs most is the one taken under concurrency, where the
// bounded probe finds no idle victim and drops a session mid-request.
test('an eviction forced past the in-flight probe is counted too', () => {
  const tracker = new SessionTracker({ maxSessions: 4 });
  const am = manager([{ name: 'a', used: 0.1, resetH: 50 }], { tracker });
  for (let i = 0; i < 6; i++) am.beginSession(`live${i}`); // never ended: all in flight
  assert.equal(tracker.sessions.size, 4, 'the cap did not hold, so this proves nothing');
  const sessions = am.getStatus().sessions;
  assert.equal(sessions.evicted, 2, 'a forced eviction under concurrency is invisible');
  assert.equal(sessions.max, 4, 'the cap is not reported, so evictions cannot be read against it');
  assert.equal(sessions.known, 4);
});

test('flag off matches an absent config step for step', () => {
  const specs = [
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.1, fableResetH: 50 },
    { name: 'b', used: 0.3, resetH: 90, fableUsed: 0.6, fableResetH: 90 },
    { name: 'c', used: 0.1, resetH: 160, fableUsed: 0.2, fableResetH: 160 },
  ];
  const steps = [
    am => route(am, 's1', OPUS),
    am => route(am, 's2', FABLE),
    am => route(am, 's1', FABLE),
    am => { rollWeekly(am, 0); return route(am, 's1', OPUS); },
    am => { am.accounts[1].quota.unified7d = 0.9; return route(am, 's2', OPUS); },
    am => route(am, 's3', OPUS),
    am => route(am, 's1', OPUS),
  ];
  const absent = manager(specs, { er: null });
  const disabled = manager(specs, { er: { enabled: false } });
  steps.forEach((step, i) => {
    assert.equal(step(absent).name, step(disabled).name, `step ${i} diverged`);
  });
});
