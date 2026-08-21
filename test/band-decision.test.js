import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { decideBand, pressureOf, assertNever } from '../src/band-decision.js';

// The band decision, as a pure function, and its equivalence to the banding it
// replaced.
//
// The equivalence is TESTED against the previous implementation rather than
// asserted in a comment. `referenceBand` below is the pre-refactor body,
// verbatim, kept here as the thing the new path has to agree with over
// generated fleets. When the sizing rule lands it will disagree deliberately
// and this becomes the description of what changed; until then any divergence
// is a defect.

const OPUS = 'claude-opus-5';
const acct = (name, over = {}) => ({ name, type: 'apikey', apiKey: `k-${name}`, ...over });

/**
 * The band as it was before the decision layer existed. Verbatim, including the
 * `.concat(rest)` ordering, which is the part a re-implementation is most
 * likely to get wrong because nothing in the old code said it mattered.
 */
function referenceBand(am, candidates, model, now) {
  if (!am.expiryRouting.enabled || candidates.length <= 1) return candidates;
  const prio = a => a.priority || 0;
  const top = Math.min(...candidates.map(prio));
  const tier = candidates.filter(a => prio(a) === top);
  const rest = candidates.filter(a => prio(a) !== top);
  const pressures = tier.map(a => referencePressure(am, a, model, now));
  const known = pressures.filter(p => Number.isFinite(p));
  if (!known.length) return candidates;
  const floor = Math.max(...known) / am.expiryRouting.tolerance;
  return tier.filter((a, i) => !Number.isFinite(pressures[i]) || pressures[i] >= floor).concat(rest);
}

/** The pre-refactor `_expiryPressure`, verbatim. */
function referencePressure(am, account, model, now) {
  const key = am._governingBucket(account, model);
  const used = account.quota[key];
  const reset = account.quota[`${key}Reset`];
  if (used == null || !reset) return null;
  const seconds = (reset - now) / 1000;
  if (seconds <= 0) return 0;
  if (!Number.isFinite(used)) return null;
  const u = Math.min(1, Math.max(0, used));
  const pressure = (1 - u) / seconds;
  return Number.isFinite(pressure) ? pressure : null;
}

// xorshift32, so a failure names a seed that reproduces it exactly.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

// The shapes worth generating are the ones the mechanism is sensitive to:
// unreported windows, resets already passed, malformed utilizations, and mixed
// priority tiers. A generator that only produces well-formed fleets exercises
// one branch of four.
function fleet(rand, n) {
  const accounts = [];
  for (let i = 0; i < n; i += 1) {
    const roll = rand();
    let quota;
    if (roll < 0.15) quota = {};                                   // nothing reported
    else if (roll < 0.25) quota = { unified7d: rand() };            // utilization, no window
    else if (roll < 0.32) quota = { unified7d: NaN, unified7dReset: Date.now() + 3600e3 };
    else if (roll < 0.42) quota = { unified7d: rand(), unified7dReset: Date.now() - 1000 };
    else quota = { unified7d: rand(), unified7dReset: Date.now() + rand() * 7 * 86400e3 };
    accounts.push(acct(`a${i}`, { priority: rand() < 0.25 ? 100 : 0, quota }));
  }
  return accounts;
}

function managerWith(accounts, tolerance = 1.5, enabled = true, extra = {}) {
  const am = new AccountManager(accounts.map(a => ({ ...a })), 0.98,
    { expiryRouting: { enabled, tolerance }, ...extra });
  // The constructor owns quota shape, so write the generated quota afterwards.
  accounts.forEach((a, i) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...a.quota }; });
  return am;
}

test('the decision agrees with the banding it replaced, over generated fleets', () => {
  const rand = rng(20260820);
  let compared = 0;
  let banded = 0;
  for (let trial = 0; trial < 4000; trial += 1) {
    const n = 1 + Math.floor(rand() * 5);
    const tolerance = 1 + rand() * 30;
    const accounts = fleet(rand, n);
    const am = managerWith(accounts, tolerance);
    const now = Date.now();

    const expected = referenceBand(am, am.accounts, OPUS, now).map(a => a.index);
    const decision = decideBand(am._bandSnapshot(am.accounts, OPUS, now));
    const actual = decision.kind === 'banded'
      ? decision.keep
      : am.accounts.map(a => a.index);

    assert.deepEqual(actual, expected,
      `trial ${trial}: n=${n} tolerance=${tolerance.toFixed(3)}`);
    compared += 1;
    if (decision.kind === 'banded') banded += 1;
  }
  assert.equal(compared, 4000);
  // Without this the test passes just as well when every fleet took the
  // passthrough branch and the banding arithmetic was never reached.
  assert.ok(banded > 500,
    `only ${banded} of ${compared} fleets reached the banding branch, so agreement proves little`);
});

// The cold-start case named in the brief. Every account unknown means there is
// no maximum to measure a floor against, so the mechanism is off rather than
// guessing, and it must be off by returning everything rather than nothing.
test('every window unreported bands nothing out, and says why', () => {
  const am = managerWith([
    acct('a', { quota: {} }),
    acct('b', { quota: {} }),
    acct('c', { quota: {} }),
  ]);
  const decision = decideBand(am._bandSnapshot(am.accounts, OPUS, Date.now()));
  assert.equal(decision.kind, 'passthrough');
  assert.equal(decision.reason, 'no-known-pressure');
  assert.deepEqual(am._topPressureBand(am.accounts, OPUS).map(a => a.name), ['a', 'b', 'c']);
});

test('an unknown account rides along with accounts that are known', () => {
  const now = Date.now();
  const am = managerWith([
    acct('rich', { quota: { unified7d: 0.1, unified7dReset: now + 3600e3 } }),
    acct('spent', { quota: { unified7d: 0.99, unified7dReset: now + 7 * 86400e3 } }),
    acct('unknown', { quota: {} }),
  ]);
  const decision = decideBand(am._bandSnapshot(am.accounts, OPUS, now));
  assert.equal(decision.kind, 'banded');
  assert.deepEqual(decision.keep, [0, 2],
    'the spent account should band out and the unknown one should not');
});

test('priority outranks pressure: a lower tier is never banded out', () => {
  const now = Date.now();
  const am = managerWith([
    acct('preferred', { priority: 0, quota: { unified7d: 0.99, unified7dReset: now + 7 * 86400e3 } }),
    acct('preferred2', { priority: 0, quota: { unified7d: 0.1, unified7dReset: now + 3600e3 } }),
    acct('fallback', { priority: 100, quota: { unified7d: 0.0, unified7dReset: now + 60e3 } }),
  ]);
  const decision = decideBand(am._bandSnapshot(am.accounts, OPUS, now));
  assert.equal(decision.kind, 'banded');
  assert.deepEqual(decision.keep, [1, 2],
    'the fallback tier must pass through unfiltered, after the surviving top tier');
});

test('pressure names the absence rather than coercing it', () => {
  const now = Date.now();
  assert.deepEqual(pressureOf({ index: 0, priority: 0, utilization: null, resetAt: now + 1000 }, now),
    { kind: 'absent', reason: 'no-utilization' });
  assert.deepEqual(pressureOf({ index: 0, priority: 0, utilization: 0.5, resetAt: null }, now),
    { kind: 'absent', reason: 'no-reset' });
  assert.deepEqual(pressureOf({ index: 0, priority: 0, utilization: NaN, resetAt: now + 1000 }, now),
    { kind: 'absent', reason: 'utilization-not-finite' });
  // A window whose reset has passed is KNOWN to be worth nothing, which is a
  // different claim from knowing nothing about it.
  assert.deepEqual(pressureOf({ index: 0, priority: 0, utilization: 0.5, resetAt: now - 1 }, now),
    { kind: 'known', value: 0 });
});

test('the decision reads no clock of its own', () => {
  const now = 1_700_000_000_000;
  const am = managerWith([
    acct('a', { quota: { unified7d: 0.2, unified7dReset: now + 3600e3 } }),
    acct('b', { quota: { unified7d: 0.9, unified7dReset: now + 3600e3 } }),
  ]);
  const snapshot = am._bandSnapshot(am.accounts, OPUS, now);
  const first = decideBand(snapshot);
  const second = decideBand(snapshot);
  assert.deepEqual(first, second, 'the same snapshot decided differently twice');

  // The same fleet at a later instant. Both accounts share a window, so their
  // ratio is unchanged and the membership holds; the FLOOR moves, because
  // pressure is headroom per remaining second and the seconds are running out.
  // That moving floor is the evidence the instant is genuinely an input: a
  // decision that had read its own clock would produce it either way, but a
  // decision that ignored the instant could not move it at all.
  const later = decideBand({ ...snapshot, now: now + 3599e3 });
  assert.equal(first.kind, 'banded');
  assert.equal(later.kind, 'banded');
  assert.deepEqual(later.keep, first.keep, 'membership should not move with a shared window');
  assert.ok(later.floor > first.floor * 100,
    `the floor should rise steeply as the window closes: ${first.floor} -> ${later.floor}`);

  // Past the reset every account scores a known zero, so none can be below a
  // floor of zero and the band keeps all of them.
  const passed = decideBand({ ...snapshot, now: now + 3601e3 });
  assert.equal(passed.kind, 'banded');
  assert.deepEqual(passed.keep, [0, 1], 'both windows have reset, so both score zero and both stay');
  assert.equal(passed.floor, 0);
});

// THE SEAM. Everything above drives `decideBand` directly, which proves the
// decision is right and proves nothing about whether anything calls it. This
// goes through the real manager's real selection path and observes the band
// changing which account a request lands on.
//
// Unit tables for the decision plus unit tables for the application do not
// discharge this: they are both satisfied by a build where `_topPressureBand`
// ignores the decision entirely and returns its input, which is exactly the
// shape that let a whole feature ship green.
test('the band changes which account real selection returns', () => {
  const now = Date.now();
  // The fixture has to make the band and the pre-existing tiebreak DISAGREE,
  // or the test passes on a build that ignores the band entirely. The last
  // tiebreak in `_pickLeastLoaded` is soonest weekly reset, so:
  //
  //   soonest   resets first but is mostly spent  -> pressure 0.1/1800s
  //   ample     resets later but is untouched      -> pressure 1/7200s, ~2.5x
  //
  // `soonest` is spent to 0.9 rather than 0.99 on purpose: at 0.99 it sits
  // above the 0.98 availability gate and is filtered out before the band ever
  // sees it, which would have made this pass for a reason that has nothing to
  // do with banding.
  //
  // Reset order prefers `soonest`; pressure prefers `ample`. Whichever comes
  // back names which rule actually ran.
  const accounts = [
    acct('soonest', { quota: { unified7d: 0.9, unified7dReset: now + 1800e3 } }),
    acct('ample', { quota: { unified7d: 0.0, unified7dReset: now + 7200e3 } }),
  ];

  const off = managerWith(accounts, 1.5, false, { distributeSessions: true });
  const withoutBand = off.getActiveAccount(null, OPUS, null, 'sess-seam');
  assert.equal(withoutBand.name, 'soonest',
    'without the band, the reset tiebreak wins, so the band has something to change');

  const on = managerWith(accounts, 1.5, true, { distributeSessions: true });
  const banded = on._bandedCandidates(null, OPUS).map(a => a.name);
  assert.deepEqual(banded, ['ample'],
    'the band should have narrowed to the account with ample expiring quota');
  const withBand = on.getActiveAccount(null, OPUS, null, 'sess-seam');
  assert.equal(withBand.name, 'ample',
    'selection ignored the band: the decision is computed and then thrown away');
});

test('assertNever names the variant it could not handle', () => {
  assert.throws(() => assertNever(/** @type {never} */ ({ kind: 'invented' }), 'ctx'),
    /ctx: unhandled variant .*invented/);
});
