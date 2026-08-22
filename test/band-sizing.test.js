import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { decideBand, headroomOf, pressureOf } from '../src/band-decision.js';

// Capacity-based band sizing: how many accounts must run in parallel, rather
// than how much worse in pressure an account may be.
//
// The defect this replaces is measured, not hypothetical. At an 18x to 28x
// pressure gap the ratio collapses the band to one account, and a singleton
// band makes session distribution a no-op: 1090 requests to one account and 0
// to two others, with distribution on. The fleet ran one account at a time
// while three sat idle and the fourth gated.

const OPUS = 'claude-opus-5';
const HOUR = 3600e3;
const acct = (name, over = {}) => ({ name, type: 'apikey', apiKey: `k-${name}`, ...over });

function managerWith(accounts, expiry = {}, extra = {}) {
  const am = new AccountManager(accounts.map(a => ({ ...a })), 0.98,
    { expiryRouting: { enabled: true, tolerance: 1.5, ...expiry }, ...extra });
  accounts.forEach((a, i) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...a.quota }; });
  return am;
}

const decide = (am, now = Date.now()) => decideBand(am._bandSnapshot(am.accounts, OPUS, now));

// A weekly window: `spent` of it used, resetting in `hours`. Pressure is
// headroom per remaining second, so a small `hours` with a low `spent` is the
// most-expiring quota there is.
const weekly = (spent, hours) => ({ unified7d: spent, unified7dReset: Date.now() + hours * HOUR });

// ---------------------------------------------------------------------------
// COLD START. Every closed-loop quantity is off until its signal exists, and
// this is the state upstream is in by default: probe off, nothing measured yet.
// ---------------------------------------------------------------------------

test('cold start: no five-hour level anywhere falls back to the ratio, and says so', () => {
  const am = managerWith([
    acct('a', { quota: weekly(0.1, 1) }),
    acct('b', { quota: weekly(0.9, 168) }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'banded',
    'with no capacity signal the capacity rule must not run at all');
  assert.equal(decision.reason, 'no-capacity-signal');
});

test('cold start: one account reporting is enough to switch the rule on', () => {
  const am = managerWith([
    acct('a', { quota: { ...weekly(0.1, 1), unified5h: 0.1 } }),
    acct('b', { quota: weekly(0.9, 168) }),
  ]);
  assert.equal(decide(am).kind, 'sized');
});

test('cold start: an account with no five-hour level is admitted but counts for nothing', () => {
  // `unmeasured` outranks on pressure, so it is admitted first. It cannot close
  // the band on its own, because capacity nobody has measured is not capacity.
  const am = managerWith([
    acct('unmeasured', { quota: weekly(0.0, 1) }),
    acct('measured', { quota: { ...weekly(0.5, 2), unified5h: 0.0 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0, 1],
    'an unmeasured account must not satisfy the coverage target by itself');
  assert.ok(decision.achieved >= 1, 'the measured account is what actually covered it');
});

// ---------------------------------------------------------------------------
// SIZING. The band widens on its own as the fleet loads, with no history and
// no demand forecast: the five-hour level is the integral of demand.
// ---------------------------------------------------------------------------

test('a fresh fleet concentrates: one untouched account covers the target', () => {
  const am = managerWith([
    acct('expiring', { quota: { ...weekly(0.1, 1), unified5h: 0.0 } }),
    acct('later', { quota: { ...weekly(0.1, 168), unified5h: 0.0 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0],
    'an untouched account has a full account of capacity, so one is enough');
});

test('a loaded account widens the band without any history being kept', () => {
  // Same fleet, same pressures, same everything except that the account worth
  // spending has burned most of its five-hour rate. It can no longer absorb the
  // load alone, so the band admits the next one.
  const am = managerWith([
    acct('expiring', { quota: { ...weekly(0.1, 1), unified5h: 0.7 } }),
    acct('later', { quota: { ...weekly(0.1, 168), unified5h: 0.0 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0, 1],
    'a partly spent account cannot cover the target alone');
});

// The measured defect, in the shape it was measured in.
test('an 18x pressure gap no longer collapses the band when the fleet is loaded', () => {
  const am = managerWith([
    // Pressure 0.9/3600 = 2.5e-4. The others are ~18x to 28x below it.
    acct('hot', { quota: { ...weekly(0.1, 1), unified5h: 0.9 } }),
    acct('cool1', { quota: { ...weekly(0.1, 20), unified5h: 0.1 } }),
    acct('cool2', { quota: { ...weekly(0.1, 28), unified5h: 0.0 } }),
  ]);
  const ratio = decideBand({
    ...am._bandSnapshot(am.accounts, OPUS, Date.now()),
    // What the old rule would have done with the same fleet.
    accounts: am._bandSnapshot(am.accounts, OPUS, Date.now()).accounts.map(a => ({ ...a, fiveHour: null })),
  });
  assert.equal(ratio.kind, 'banded');
  assert.deepEqual(ratio.keep, [0],
    'the ratio should collapse to a singleton here, which is the defect');

  const sized = decide(am);
  assert.equal(sized.kind, 'sized');
  assert.ok(sized.keep.length > 1,
    `capacity sizing should admit more than one account, got ${JSON.stringify(sized.keep)}`);
  assert.equal(sized.keep[0], 0, 'the most-expiring account is still spent first');
});

test('a fleet with nothing left admits everyone rather than gating on one', () => {
  const am = managerWith([
    acct('a', { quota: { ...weekly(0.1, 1), unified5h: 0.97 } }),
    acct('b', { quota: { ...weekly(0.1, 2), unified5h: 0.97 } }),
    acct('c', { quota: { ...weekly(0.1, 3), unified5h: 0.97 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0, 1, 2]);
  assert.ok(decision.achieved < decision.target,
    'the target is genuinely unmet here, which is why everyone is in');
});

test('the coverage target is a knob, and raising it hedges wider', () => {
  const fleet = [
    acct('a', { quota: { ...weekly(0.1, 1), unified5h: 0.0 } }),
    acct('b', { quota: { ...weekly(0.1, 2), unified5h: 0.0 } }),
    acct('c', { quota: { ...weekly(0.1, 3), unified5h: 0.0 } }),
  ];
  assert.deepEqual(decide(managerWith(fleet)).keep, [0]);
  assert.deepEqual(decide(managerWith(fleet, { coverage: 2 })).keep, [0, 1]);
  assert.deepEqual(decide(managerWith(fleet, { coverage: 3 })).keep, [0, 1, 2]);
});

// The snapshot reads `unified5h` by literal name, and losing that read is an
// absence-shaped failure: every account would report no capacity, the rule
// would fall back to the ratio forever, and the fallback is legitimate
// behaviour, so nothing else would go red. A rename upstream, or a typo, would
// silently revert this whole change and look like a fleet that had simply never
// reported a five-hour level.
test('the snapshot carries the five-hour level the sizing rule needs', () => {
  const am = managerWith([
    acct('a', { quota: { ...weekly(0.1, 1), unified5h: 0.42 } }),
    acct('b', { quota: weekly(0.2, 2) }),
  ]);
  const snapshot = am._bandSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(snapshot.accounts[0].fiveHour, 0.42,
    'the reported five-hour level did not reach the snapshot');
  assert.equal(snapshot.accounts[1].fiveHour, null,
    'an unreported level must arrive as absent rather than as a number');
  assert.equal(snapshot.switchThreshold, 0.98);
  assert.equal(snapshot.coverage, 1);
});

test('headroom is measured against the threshold, because quota above it cannot be spent', () => {
  // At the switch threshold the account is unavailable, so its usable capacity
  // is zero even though its raw utilization is not 1.
  assert.deepEqual(headroomOf({ index: 0, priority: 0, utilization: null, resetAt: null, fiveHour: 0.98 }, 0.98),
    { kind: 'known', value: 0 });
  assert.deepEqual(headroomOf({ index: 0, priority: 0, utilization: null, resetAt: null, fiveHour: 0.49 }, 0.98),
    { kind: 'known', value: 0.5 });
  assert.deepEqual(headroomOf({ index: 0, priority: 0, utilization: null, resetAt: null, fiveHour: null }, 0.98),
    { kind: 'absent', reason: 'no-five-hour' });
  // Past the threshold is clamped rather than going negative: an account cannot
  // owe capacity back to the fleet.
  assert.deepEqual(headroomOf({ index: 0, priority: 0, utilization: null, resetAt: null, fiveHour: 1 }, 0.98),
    { kind: 'known', value: 0 });
});

test('priority still outranks capacity: a lower tier passes through untouched', () => {
  const am = managerWith([
    acct('top1', { priority: 0, quota: { ...weekly(0.1, 1), unified5h: 0.0 } }),
    acct('top2', { priority: 0, quota: { ...weekly(0.1, 2), unified5h: 0.0 } }),
    acct('fallback', { priority: 100, quota: { ...weekly(0.0, 1), unified5h: 0.0 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0, 2],
    'the fallback tier is never sized out, and follows the surviving top tier');
});

// ---------------------------------------------------------------------------
// THE SEAM. As before: the decision being right says nothing about whether the
// selection path uses it.
// ---------------------------------------------------------------------------

test('capacity sizing changes which account real selection returns', () => {
  // `expiring` wins on pressure and on the reset tiebreak, so it is what
  // selection returns while it can still absorb the load. Loading its
  // five-hour bucket must bring `spare` into the band, and with `expiring`
  // holding an active session, distribution then places the new one on `spare`.
  const fleet = spent => [
    acct('expiring', { quota: { ...weekly(0.1, 1), unified5h: spent } }),
    acct('spare', { quota: { ...weekly(0.1, 168), unified5h: 0.0 } }),
  ];

  const fresh = managerWith(fleet(0.0), {}, { distributeSessions: true });
  assert.deepEqual(fresh._bandedCandidates(null, OPUS).map(a => a.name), ['expiring'],
    'a fresh fleet should concentrate, or there is nothing for loading it to change');
  assert.equal(fresh.getActiveAccount(null, OPUS, null, 's1').name, 'expiring');

  const loaded = managerWith(fleet(0.8), {}, { distributeSessions: true });
  assert.deepEqual(loaded._bandedCandidates(null, OPUS).map(a => a.name), ['expiring', 'spare'],
    'a loaded fleet should widen the band');
  loaded.recordSession('s1', 0, OPUS);
  assert.equal(loaded.getActiveAccount(null, OPUS, null, 's2').name, 'spare',
    'selection ignored the widened band: the second session should spread onto it');
});

// ---------------------------------------------------------------------------
// ABSENCE MAY WIDEN THE BAND AND MUST NEVER CLOSE IT. The admission loop
// stopped as soon as coverage was met, which dropped every unmeasured account
// that happened to sort behind one covering the target alone — the one class of
// account the band exists to keep in, since being used is how its quota becomes
// known.
// ---------------------------------------------------------------------------

test('an unmeasured account sorted behind a covering one is still admitted', () => {
  const am = managerWith([
    // Highest pressure and a wholly unspent five-hour bucket: covers alone.
    acct('covers-alone', { quota: { ...weekly(0.1, 1), unified5h: 0 } }),
    // Lower pressure, so it sorts LAST, and no five-hour level ever reported.
    acct('never-reported', { quota: weekly(0.9, 10) }),
  ]);

  // Three premises, because the first two fixtures written for this reached
  // `passthrough` and sorted the unknown account FIRST — the case that already
  // worked. Either would have read as "not reproduced".
  const decision = decide(am);
  assert.equal(decision.kind, 'sized', 'never reached the capacity path');
  const snap = am._bandSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(headroomOf(snap.accounts[0], am.switchThreshold).kind, 'known');
  assert.equal(headroomOf(snap.accounts[1], am.switchThreshold).kind, 'absent',
    'the second account has a measurable headroom, so nothing here is unmeasured');
  assert.ok(decision.achieved >= decision.target,
    'the target was not met, so nothing would have stopped the loop anyway');

  assert.ok(decision.keep.includes(1),
    'the unmeasured account was sized out, so its capacity can never become known');
  assert.equal(decision.achieved, 1,
    'the unmeasured account counted toward coverage, which lets it close the band');
});

test('an account whose PRESSURE is unknown is admitted, and can still be picked', () => {
  // The other absence. Its five-hour level is known, so the exemption written
  // against headroom alone does not reach it: it sorts last on pressure, meets
  // a target the peer already met, and is dropped. With the probe off that
  // account's weekly is then unknowable forever, because the only way it gets
  // reported is by being used.
  const am = managerWith([
    acct('covers-alone', { quota: { ...weekly(0.05, 10), unified5h: 0 } }),
    acct('weekly-unknown', { quota: { unified5h: 0.3, unified5hReset: Date.now() + 4 * 3600e3 } }),
  ]);
  const snap = am._bandSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(pressureOf(snap.accounts[1], Date.now()).kind, 'absent',
    'the second account has a known pressure, so this tests the case already covered');
  assert.equal(headroomOf(snap.accounts[1], am.switchThreshold).kind, 'known',
    'its headroom is absent too, which is the case the headroom exemption already handles');

  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.ok(decision.keep.includes(1),
    'an account with no known weekly was sized out, so its weekly can never be discovered');
  // Admission is not enough on its own: discovery happens because the pick can
  // reach it, and an unknown pressure ranks first on the probe bias.
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'weekly-unknown');
});

test('an admitted unknown-pressure account contributes its MEASURED headroom to achieved', () => {
  // Deliberate, and the opposite of the headroom case. Absent headroom adds
  // nothing because unmeasured capacity is not capacity; here the capacity is
  // measured and only the pressure is not, so `achieved` would understate what
  // the admitted set can absorb if it were left out.
  const am = managerWith([
    acct('measured', { quota: { ...weekly(0.05, 10), unified5h: 0.5 } }),
    acct('weekly-unknown', { quota: { unified5h: 0, unified5hReset: Date.now() + 4 * 3600e3 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0, 1]);
  const snap = am._bandSnapshot(am.accounts, OPUS, Date.now());
  const sum = snap.accounts.reduce((acc, a) => {
    const h = headroomOf(a, am.switchThreshold);
    return acc + (h.kind === 'known' ? h.value : 0);
  }, 0);
  assert.ok(Math.abs(decision.achieved - sum) < 1e-9,
    `achieved ${decision.achieved} omits measured capacity the band is carrying (${sum})`);
});

test('an unmeasured account admitted this way still cannot close the band', () => {
  // Same shape, but the measured account no longer covers alone. The unknown
  // one is admitted first on pressure and must not stop the loop reaching the
  // measured account behind it.
  const am = managerWith([
    acct('never-reported', { quota: weekly(0.1, 1) }),
    acct('measured', { quota: { ...weekly(0.5, 1), unified5h: 0.5 } }),
  ]);
  const decision = decide(am);
  assert.equal(decision.kind, 'sized');
  assert.deepEqual(decision.keep, [0, 1], 'the unmeasured account closed the band on its own');
});

// ---------------------------------------------------------------------------
// DEGENERATE KNOBS. `decideBand` is exported and takes plain numbers, so the
// config validator's clamps are not what makes these safe. Each one used to
// empty the tier or publish a nonsense target, and an empty candidate set is an
// outage.
// ---------------------------------------------------------------------------

// These drive `decideBand` with an overridden snapshot rather than going
// through `managerWith`, because `setExpiryRouting` clamps both knobs —
// `tolerance` to `Math.max(1, ...)`, `coverage` to a positive default. Routed
// through the manager these tests pass against the UNGUARDED function: the
// validator answers them and the guard is never reached. That is the whole
// hazard being fixed here, since `decideBand` is exported and typed as taking
// plain numbers, so the clamp upstream is not what makes it safe.
const snapshotOf = (accounts) => {
  const am = managerWith(accounts);
  return am._bandSnapshot(am.accounts, OPUS, Date.now());
};

const measuredSnapshot = () => snapshotOf([
  acct('a', { quota: { ...weekly(0.1, 1), unified5h: 0.2 } }),
  acct('b', { quota: { ...weekly(0.5, 1), unified5h: 0.3 } }),
]);

for (const coverage of [0, -1, NaN, Infinity]) {
  test(`coverage ${coverage} falls back to the ratio instead of emptying the tier`, () => {
    const snapshot = { ...measuredSnapshot(), coverage };
    assert.ok(!Number.isFinite(snapshot.coverage) || snapshot.coverage <= 0,
      'the coverage under test was normalised away before the decision saw it');
    const decision = decideBand(snapshot);
    assert.equal(decision.kind, 'banded');
    assert.ok(decision.keep.length > 0, `coverage ${coverage} banded to empty`);
    assert.equal(decision.reason, 'no-coverage-target',
      'the reason must name the knob, not the cold-start state it is not in');
  });
}

for (const tolerance of [0.5, 0, -1, NaN]) {
  test(`tolerance ${tolerance} still keeps the highest-pressure account`, () => {
    // No five-hour level anywhere, so the ratio path runs and the floor is what
    // decides. A tolerance below 1 asks for accounts strictly better than the
    // best there is; the maximum has to qualify regardless.
    const base = snapshotOf([
      acct('a', { quota: weekly(0.1, 1) }),
      acct('b', { quota: weekly(0.5, 1) }),
    ]);
    const snapshot = { ...base, tolerance };
    assert.ok(!(snapshot.tolerance >= 1),
      'the tolerance under test was normalised away before the decision saw it');
    const decision = decideBand(snapshot);
    assert.equal(decision.kind, 'banded');
    assert.ok(decision.keep.length > 0, `tolerance ${tolerance} banded to empty`);
    assert.ok(decision.keep.includes(0), 'the highest-pressure account was banded out');
  });
}

test('a switch threshold with no spendable range says so, and is not the cold-start state', () => {
  const decision = decideBand({ ...measuredSnapshot(), switchThreshold: 0 });
  assert.equal(decision.kind, 'banded');
  assert.equal(decision.reason, 'no-headroom-scale',
    'a degenerate threshold is a misconfiguration to fix, not a window to wait for');
  assert.ok(decision.keep.length > 0);
});

test('the two headroom absences are distinguishable at the source', () => {
  const account = { index: 0, priority: 0, utilization: 0.1, resetAt: Date.now() + 3600e3, fiveHour: 0.2 };
  assert.deepEqual(headroomOf(account, 0), { kind: 'absent', reason: 'no-headroom-scale' });
  assert.deepEqual(headroomOf({ ...account, fiveHour: null }, 0.98),
    { kind: 'absent', reason: 'no-five-hour' });
});
