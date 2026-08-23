import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBand, explainBand, pressureOf, headroomOf } from '../src/band-decision.js';

// The explainer's ladder IS the decider's admission sequence.
//
// `decideBand` and `explainBand` are two projections of one walk, so the ladder
// cannot report an ORDER the decision did not perform — that much is structural.
// What is still constructible, and what these properties hold, is a projection
// that reads the shared walk differently: an admitted set that disagrees with
// `keep`, a running total that does not reconcile with `achieved`, a rank on a
// row the sort could not order, a reason code that contradicts its own row.
// Every one of those publishes a ladder describing an admission sequence that
// did not happen, beside numbers that did, and nothing else in the suite looks.
//
// Generated fleets rather than fixtures, because the interesting rows are the
// ones nobody thinks to write down: an account with absent pressure and KNOWN
// headroom, admitted by the exemption, whose cumulative advances — and its
// mirror, absent headroom, admitted, contributing nothing. A four-fixture suite
// reaches neither. The corpus asserts its own coverage at the bottom: a
// generator that never produced an exempt row would leave these properties
// vacuously true, which is the failure mode of property tests.

const THRESHOLD = 0.98;
const NOW = 1_700_000_000_000;

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

// Ordinary values and degenerate ones are drawn from separate pools, with the
// degenerate pool at a fixed minority weight. Mixing them into one list looked
// simpler and was worse: absence in a third of every field made most fleets
// degrade to `passthrough` before any walk ran, so the corpus spent its seeds on
// the one variant that has no ladder. The tallies at the bottom are what caught
// that — `coverage-met` had been reached twelve times in four thousand fleets.
const ORDINARY = {
  utilization: [0, 0.31, 0.62, 0.97, 1],
  resetAt: [NOW + 1800e3, NOW + 3600e3, NOW + 30 * 3600e3, NOW + 7 * 24 * 3600e3],
  fiveHour: [0, 0.2, 0.4, 0.7, 0.9, 0.98],
};
const DEGENERATE = {
  utilization: [null, Number.NaN, Number.POSITIVE_INFINITY],
  resetAt: [null, NOW - 1000, NOW],
  fiveHour: [null, Number.NaN],
};
const COVERAGE = [1, 2, 0.5, 3];
const TOLERANCE = [1.5, 1, 3];
const THRESHOLDS = [THRESHOLD, 0.5];

function fleet(seed) {
  const r = rng(seed);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  // A quarter degenerate per field: often enough that every absence path is
  // exercised, rarely enough that a fleet usually still has a walk to describe.
  const field = name => (r() < 0.25 ? pick(DEGENERATE[name]) : pick(ORDINARY[name]));
  // One account sometimes, because `single-candidate` is a real state, but
  // rarely: it is the variant that publishes no ladder at all.
  const n = r() < 0.05 ? 1 : 2 + Math.floor(r() * 6);
  // A fleet with no five-hour reading anywhere is not an edge case: it is the
  // stock upstream state, since the quota probe defaults off, and it is the only
  // way to reach the ratio rule on a healthy fleet. Drawing each account's
  // signal independently made it vanishingly rare — 83 banded fleets in 4000 —
  // so it gets drawn as a fleet-level property, which is what it is.
  const probeOff = r() < 0.2;
  return {
    now: NOW,
    enabled: r() < 0.05 ? false : true,
    tolerance: pick(TOLERANCE),
    switchThreshold: pick(THRESHOLDS),
    coverage: pick(COVERAGE),
    accounts: Array.from({ length: n }, (_, index) => ({
      index,
      priority: r() < 0.2 ? 1 : 0,
      utilization: field('utilization'),
      resetAt: field('resetAt'),
      fiveHour: probeOff ? null : field('fiveHour'),
    })),
  };
}

const SEEDS = 4000;
const sameSet = (a, b) => a.length === b.length
  && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();

test('the ladder reports the sequence the decision performed, over generated fleets', () => {
  const seen = {
    'under-target': 0,
    'coverage-met': 0,
    'unmeasured-exempt-pressure': 0,
    'unmeasured-exempt-headroom': 0,
    'within-tolerance': 0,
    'below-floor': 0,
    'lower-tier': 0,
  };
  const variants = { sized: 0, banded: 0, passthrough: 0 };
  let exemptPressureAdvanced = 0;
  let exemptHeadroomHeld = 0;

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const snapshot = fleet(seed);
    const decision = decideBand(snapshot);
    const explained = explainBand(snapshot);
    const where = `seed ${seed}`;

    assert.equal(explained.decision.kind, decision.kind, `${where}: variants disagree`);
    variants[decision.kind] += 1;

    // Passthrough ranks nothing, so it has no ladder to publish. An empty array
    // is the honest report; rows with null ranks would assert that a walk ran.
    if (decision.kind === 'passthrough') {
      assert.deepEqual(explained.ladder, [], `${where}: passthrough published a ladder`);
      continue;
    }

    const ladder = explained.ladder;
    // 1. Every account appears exactly once. A row that vanished would take its
    //    reason with it, which is the class of defect TC-026 records one layer up.
    assert.ok(sameSet(ladder.map(r => r.account.index), snapshot.accounts.map(a => a.index)),
      `${where}: ladder accounts do not match the snapshot`);

    // 2. The admitted rows ARE the kept accounts.
    assert.ok(sameSet(ladder.filter(r => r.admitted).map(r => r.account.index), decision.keep),
      `${where}: ladder admissions disagree with decision.keep`);

    // 3. Ranks are dense over the rows the sort could order, null elsewhere, and
    //    the ranked rows are in descending pressure order.
    const ranked = ladder.filter(r => r.rank != null);
    assert.deepEqual(ranked.map(r => r.rank), ranked.map((_, i) => i + 1),
      `${where}: ranks are not dense`);
    for (let i = 1; i < ranked.length; i += 1) {
      assert.ok(ranked[i - 1].pressure.value >= ranked[i].pressure.value,
        `${where}: ranked rows are not in descending pressure order`);
    }
    for (const row of ladder) {
      if (row.rank != null) assert.equal(row.pressure.kind, 'known', `${where}: ranked an unordered row`);
      seen[row.reason] += 1;
    }

    // 4. Pressure and headroom on the row are the values the decision used, not
    //    a second reading of the account.
    for (const row of ladder) {
      assert.deepEqual(row.pressure, pressureOf(row.account, snapshot.now), `${where}: pressure differs`);
      assert.deepEqual(row.headroom, headroomOf(row.account, snapshot.switchThreshold),
        `${where}: headroom differs`);
    }

    const top = Math.min(...snapshot.accounts.map(a => a.priority));
    for (const row of ladder) {
      const isLower = row.account.priority !== top;
      assert.equal(row.reason === 'lower-tier', isLower, `${where}: lower-tier code is misapplied`);
      if (isLower) {
        assert.equal(row.rank, null, `${where}: a lower-tier row carries a rank`);
        assert.equal(row.admitted, true, `${where}: a lower-tier row was not kept`);
        assert.equal(row.cumulative, null, `${where}: a lower-tier row carries a running total`);
      }
    }

    if (decision.kind === 'sized') {
      // 5. The running total reconciles with the published one, and advances
      //    only where headroom was known.
      const tierRows = ladder.filter(r => r.reason !== 'lower-tier');
      let running = 0;
      for (const row of tierRows) {
        if (!row.admitted) {
          assert.equal(row.cumulative, null, `${where}: a held row carries a running total`);
          assert.equal(row.reason, 'coverage-met', `${where}: a held row is not coverage-met`);
          continue;
        }
        const before = running;
        if (row.headroom.kind === 'known') running += row.headroom.value;
        assert.ok(Math.abs(row.cumulative - running) < 1e-12,
          `${where}: cumulative does not reconcile at index ${row.account.index}`);
        if (row.reason === 'unmeasured-exempt-pressure') {
          assert.equal(row.pressure.kind, 'absent', `${where}: exempt-pressure row has a pressure`);
          if (row.cumulative > before) exemptPressureAdvanced += 1;
        }
        if (row.reason === 'unmeasured-exempt-headroom') {
          assert.equal(row.headroom.kind, 'absent', `${where}: exempt-headroom row has a headroom`);
          assert.equal(row.cumulative, before, `${where}: an unmeasured headroom contributed`);
          exemptHeadroomHeld += 1;
        }
        if (row.reason === 'under-target') {
          assert.equal(row.pressure.kind, 'known', `${where}: under-target row has no pressure`);
          assert.equal(row.headroom.kind, 'known', `${where}: under-target row has no headroom`);
        }
      }
      const last = tierRows.filter(r => r.cumulative != null).pop();
      assert.ok(Math.abs((last ? last.cumulative : 0) - decision.achieved) < 1e-12,
        `${where}: achieved ${decision.achieved} is not the last cumulative`);
      assert.ok(tierRows.some(r => r.admitted), `${where}: sized admitted nobody`);
    }

    if (decision.kind === 'banded') {
      // 6. Under the ratio rule the floor decides, and no running total exists
      //    to publish — a number there would be a coverage claim the rule that
      //    ran never made.
      for (const row of ladder.filter(r => r.reason !== 'lower-tier')) {
        assert.equal(row.cumulative, null, `${where}: a banded row carries a running total`);
        const keeps = row.pressure.kind === 'absent' || row.pressure.value >= decision.floor;
        assert.equal(row.admitted, keeps, `${where}: banded admission disagrees with the floor`);
        const expected = row.pressure.kind === 'absent' ? 'unmeasured-exempt-pressure'
          : (keeps ? 'within-tolerance' : 'below-floor');
        assert.equal(row.reason, expected, `${where}: banded reason is wrong`);
      }
    }
  }

  // The corpus states what it actually reached. Every code below was observed on
  // a real generated fleet; a zero here means the properties above said nothing
  // about that case, and the assertion is what stops that from passing quietly.
  for (const [code, count] of Object.entries(seen)) {
    assert.ok(count > 0, `the corpus never produced a '${code}' row, so nothing above tested it`);
  }
  for (const [kind, count] of Object.entries(variants)) {
    assert.ok(count > 0, `the corpus never produced a '${kind}' decision`);
  }
  // The two rows the brief names as the ones a naive fixture never reaches.
  assert.ok(exemptPressureAdvanced > 0,
    'no fleet produced an absent-pressure row with KNOWN headroom whose cumulative advanced');
  assert.ok(exemptHeadroomHeld > 0,
    'no fleet produced an absent-headroom row admitted without contributing');
});
