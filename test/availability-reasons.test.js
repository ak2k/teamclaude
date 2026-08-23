import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { gatingSource, gatingUtilization } from '../src/model.js';

// Selection filters candidates through `_isAvailable`, which answers yes or no.
// A report of what selection filtered needs the why, and the only safe way to
// get it is from the same evaluation: a reporter re-asking the same questions in
// the same order is a second implementation of eligibility, and it fails by
// disagreeing with routing about who is eligible while claiming to explain it.
//
// So `_availability` is the decision and `_isAvailable` is its projection. What
// is held here is that every branch is reachable and named, that the projection
// is exact, and that the bucket a report names is the bucket the figure beside
// it came from.

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const acct = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `k-${name}`, ...extra });
const future = () => Date.now() + 7 * 24 * 3600e3;

function fleet(extra = {}) {
  return new AccountManager([acct('a'), acct('b')], 0.98, extra);
}

test('every way an account can be barred has its own reason', () => {
  // Enumerated rather than sampled: a code with no case here is a value the
  // wire can carry that nothing has ever produced, which is how a domain
  // acquires a member nobody can interpret.
  const cases = [
    ['disabled', am => { am.accounts[0].disabled = true; }, OPUS],
    ['throttled', am => {
      am.accounts[0].status = 'throttled';
      am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
    }, OPUS],
    ['exhausted', am => { am.accounts[0].status = 'exhausted'; }, OPUS],
    ['error', am => { am.accounts[0].status = 'error'; }, OPUS],
    ['five-hour-spent', am => { am.accounts[0].quota.unified5h = 0.99; }, OPUS],
    ['weekly-spent', am => {
      am.accounts[0].quota.unified7d = 0.99;
      am.accounts[0].quota.unified7dReset = future();
    }, OPUS],
    ['tokens-spent', am => {
      am.accounts[0].quota.tokensLimit = 100;
      am.accounts[0].quota.tokensRemaining = 1;
    }, OPUS],
    ['requests-spent', am => {
      am.accounts[0].quota.requestsLimit = 100;
      am.accounts[0].quota.requestsRemaining = 1;
    }, OPUS],
    ['route-excluded', am => {
      am.setRoutes([{ name: 'fable-only', match: ['*fable*'], accounts: ['b'] }]);
    }, FABLE],
    ['advisor-ineligible', am => {
      am.setRoutes([{ name: 'fable-only', match: ['*fable*'], accounts: ['b'] }]);
    }, OPUS, FABLE],
  ];

  const produced = new Set();
  for (const [reason, arrange, model, advisor = null] of cases) {
    const am = fleet();
    arrange(am);
    const verdict = am._availability(am.accounts[0], model, advisor);
    assert.ok(verdict, `${reason}: the account was not barred at all`);
    assert.equal(verdict.reason, reason);
    assert.equal(am._isAvailable(am.accounts[0], model, advisor), false,
      `${reason}: the boolean disagrees with the reason`);
    produced.add(verdict.reason);
  }
  assert.equal(produced.size, cases.length, 'two cases produced the same reason');
});

test('an account nothing bars reports no reason at all', () => {
  const am = fleet();
  am.accounts[0].quota.unified7d = 0.1;
  am.accounts[0].quota.unified7dReset = future();
  assert.equal(am._availability(am.accounts[0], OPUS), null);
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true);
});

test('the first bar found is the one reported', () => {
  // A disabled account over its weekly cap is disabled. Both are true; the one
  // to act on is the one selection would have stopped at.
  const am = fleet();
  am.accounts[0].disabled = true;
  am.accounts[0].quota.unified7d = 0.99;
  am.accounts[0].quota.unified7dReset = future();
  assert.equal(am._availability(am.accounts[0], OPUS).reason, 'disabled');
});

test('the barred weekly bucket is the one that produced the figure', () => {
  // The gate takes a maximum over the family bucket and the shared one, so the
  // governing key and the blocking key are not always the same. Naming the
  // governing one beside a number the shared bucket produced would put a window
  // and a measurement from different windows on the same line.
  const overShared = fleet();
  overShared.accounts[0].quota.unified7dFable = 0.2;
  overShared.accounts[0].quota.unified7dFableReset = future();
  overShared.accounts[0].quota.unified7d = 0.99;
  overShared.accounts[0].quota.unified7dReset = future();
  const shared = overShared._availability(overShared.accounts[0], FABLE);
  assert.equal(shared.reason, 'weekly-spent');
  assert.equal(shared.bucket, 'unified7d', 'the shared cap is reported as the family bucket');
  assert.equal(shared.detail, 0.99);

  const overFamily = fleet();
  overFamily.accounts[0].quota.unified7dFable = 0.99;
  overFamily.accounts[0].quota.unified7dFableReset = future();
  overFamily.accounts[0].quota.unified7d = 0.2;
  overFamily.accounts[0].quota.unified7dReset = future();
  const family = overFamily._availability(overFamily.accounts[0], FABLE);
  assert.equal(family.reason, 'weekly-spent');
  assert.equal(family.bucket, 'unified7dFable', 'the family cap is reported as the shared bucket');
  assert.equal(family.detail, 0.99);

  // And the family is still free to serve another model: the Fable bucket bars
  // Fable alone, which is the whole reason the governing bucket is per model.
  assert.equal(overFamily._availability(overFamily.accounts[0], OPUS), null);
});

test('gatingSource names the bucket holding the value it returns', () => {
  const LEVELS = [null, 0, 0.4, 0.9, 1];
  let sawFamily = 0;
  let sawShared = 0;
  for (const own of LEVELS) {
    for (const sharedLevel of LEVELS) {
      const quota = { unified7dFable: own, unified7d: sharedLevel };
      const got = gatingSource(quota, 'unified7dFable');
      assert.equal(gatingUtilization(quota, 'unified7dFable'), got?.value ?? null,
        'the projection disagrees with the source it projects');
      if (own == null && sharedLevel == null) {
        assert.equal(got, null, 'two unreported buckets produced a figure');
        continue;
      }
      const expected = Math.max(own ?? -Infinity, sharedLevel ?? -Infinity);
      assert.equal(got.value, expected, `own ${own}, shared ${sharedLevel}`);
      assert.equal(quota[got.bucket], got.value,
        `own ${own}, shared ${sharedLevel}: named a bucket that does not hold this value`);
      if (got.bucket === 'unified7dFable') sawFamily += 1; else sawShared += 1;
    }
  }
  assert.ok(sawFamily > 0 && sawShared > 0,
    'the corpus never exercised one of the two buckets, so the naming was tested one-sided');
});
