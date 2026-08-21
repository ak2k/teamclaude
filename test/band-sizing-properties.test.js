import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { decideBand, pressureOf, headroomOf } from '../src/band-decision.js';

// What capacity sizing promises, over generated pressure and capacity vectors
// rather than over four fleets someone thought of. The brief's four named
// pressure shapes collapse into this: sizing is a pure function of the vector,
// so the vector is what to generate.

const OPUS = 'claude-opus-5';
const THRESHOLD = 0.98;

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

// Deliberately includes the states that are not well-formed fleets: windows
// nobody has reported, five-hour levels nobody has reported, resets in the
// past, accounts already past the threshold. A generator that emits only
// healthy fleets tests one branch of several.
function fleet(rand, n, now) {
  const accounts = [];
  for (let i = 0; i < n; i += 1) {
    const quota = {};
    const w = rand();
    if (w < 0.15) { /* weekly unreported */ }
    else if (w < 0.25) { quota.unified7d = rand(); }
    else if (w < 0.35) { quota.unified7d = rand(); quota.unified7dReset = now - 1000; }
    else { quota.unified7d = rand(); quota.unified7dReset = now + rand() * 168 * 3600e3; }

    const f = rand();
    if (f < 0.2) { /* five-hour unreported */ }
    else if (f < 0.3) { quota.unified5h = 0.98 + rand() * 0.02; }
    else { quota.unified5h = rand(); }

    accounts.push({ name: `a${i}`, type: 'apikey', apiKey: `k${i}`, priority: rand() < 0.2 ? 100 : 0, quota });
  }
  return accounts;
}

test('capacity sizing holds its invariants over generated fleets', () => {
  const rand = rng(20260821);
  let sized = 0;
  let widened = 0;
  const trials = 5000;

  for (let trial = 0; trial < trials; trial += 1) {
    const now = Date.now();
    const n = 1 + Math.floor(rand() * 6);
    const coverage = rand() < 0.25 ? 1 + rand() * 3 : 1;
    const accounts = fleet(rand, n, now);
    const am = new AccountManager(accounts.map(a => ({ ...a })), THRESHOLD,
      { expiryRouting: { enabled: true, tolerance: 1.5, coverage } });
    accounts.forEach((a, i) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...a.quota }; });

    const snapshot = am._bandSnapshot(am.accounts, OPUS, now);
    const decision = decideBand(snapshot);
    const where = `trial ${trial} n=${n} coverage=${coverage.toFixed(2)}`;

    // A non-empty input never bands to empty. This is the invariant that keeps
    // the fleet routable at all: an empty candidate set is an outage.
    if (decision.kind !== 'passthrough') {
      assert.ok(decision.keep.length > 0, `${where}: banded to empty`);
      assert.equal(new Set(decision.keep).size, decision.keep.length, `${where}: duplicate index`);
    }
    if (decision.kind !== 'sized') continue;
    sized += 1;

    const top = Math.min(...snapshot.accounts.map(a => a.priority));
    const tier = snapshot.accounts.filter(a => a.priority === top);
    const lower = snapshot.accounts.filter(a => a.priority !== top);

    // Every lower tier passes through untouched, always. Priority is the
    // operator's explicit order and sizing must never override it.
    for (const a of lower) {
      assert.ok(decision.keep.includes(a.index), `${where}: sizing dropped a lower-priority account`);
    }

    const keptTier = tier.filter(a => decision.keep.includes(a.index));
    assert.ok(keptTier.length > 0, `${where}: the whole top tier was sized out`);

    // The most-expiring quota is always spent first: no account may be admitted
    // while a strictly-higher-pressure account in the same tier was not.
    const known = tier.filter(a => pressureOf(a, now).kind === 'known');
    if (known.length) {
      const best = Math.max(...known.map(a => /** @type {any} */ (pressureOf(a, now)).value));
      const bestHolders = known.filter(a => /** @type {any} */ (pressureOf(a, now)).value === best);
      assert.ok(bestHolders.some(a => decision.keep.includes(a.index)),
        `${where}: the highest-pressure account was not admitted`);
    }

    // `achieved` is what the admitted set actually adds up to, not a number the
    // decision is free to invent.
    const recomputed = keptTier.reduce((sum, a) => {
      const h = headroomOf(a, THRESHOLD);
      return sum + (h.kind === 'known' ? h.value : 0);
    }, 0);
    assert.ok(Math.abs(recomputed - decision.achieved) < 1e-9,
      `${where}: achieved ${decision.achieved} but the admitted set sums to ${recomputed}`);

    // Nothing is admitted once the target is met, so the admitted set is
    // MINIMAL for it. `keep` is emitted in tier order rather than admission
    // order, so the account to drop is the least-pressure one admitted, not the
    // last in the array: checking the array's own order would be checking a
    // different claim and would fail on a fleet whose two orders disagree.
    if (decision.achieved >= decision.target) {
      const byPressureDesc = keptTier.slice().sort((x, y) => {
        const px = pressureOf(x, now);
        const py = pressureOf(y, now);
        const xv = px.kind === 'known' ? px.value : -Infinity;
        const yv = py.kind === 'known' ? py.value : -Infinity;
        return yv - xv;
      });
      const withoutLast = byPressureDesc.slice(0, -1).reduce((sum, a) => {
        const h = headroomOf(a, THRESHOLD);
        return sum + (h.kind === 'known' ? h.value : 0);
      }, 0);
      assert.ok(withoutLast < decision.target,
        `${where}: the admitted set is not minimal for the target`);
    }
    if (keptTier.length > 1) widened += 1;
  }

  // The generator has to actually reach the mechanism, in both of its regimes.
  assert.ok(sized > trials * 0.4, `only ${sized} of ${trials} trials reached the capacity path`);
  assert.ok(widened > 200, `only ${widened} trials widened past a singleton, so widening is untested`);
});
