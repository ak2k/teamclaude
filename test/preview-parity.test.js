import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// THE INVARIANT, enforced rather than promised:
//
//   Every branch by which `_select` can return an account other than the one
//   `previewRouteIndex` names is either MIRRORED in the preview, or NAMED in the
//   preview's docstring as a deliberate absence.
//
// The prose enumeration of that surface happens to be complete today. This is
// what makes it stay complete: a new branch added to `_select` and not mirrored
// fails here, instead of surviving until someone reads two functions side by
// side. Two of pass 3's five findings were exactly that — a poll consuming an
// event the request path owned, and requalification re-ranking in one function
// and not the other.
//
// THE THREE DOCUMENTED ABSENCES are exceptions by construction rather than by
// assertion: this drives a SESSION-LESS request with NO advisor model, so the
// session-affinity path and the advisor pass cannot run, and it never builds a
// fleet where every account is over threshold, so the exhausted-fleet probe
// cannot either. Rollover preemption is excluded the same way — no state here
// rolls a window. If a case below ever reaches one of those, the exception has
// stopped being structural and this file is the wrong place to notice it.
//
// PAIRED MANAGERS, NEVER ONE. `previewRouteIndex` and `getActiveAccount` are run
// on two managers built from the same fixture, because asking one and then the
// other on a single manager lets the first call consume state the second would
// have seen — `requalify` is cleared by selection, and a five-hour reset is an
// event. That would grade a state the test's own first call destroyed, which is
// the trap that has caught both of us this round.

const H = 3600e3;
const acct = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `k-${name}`, ...extra });

/** Every state below is a plain fleet plus one named difference. */
function baseFleet(now, opts = {}) {
  const am = new AccountManager(
    [acct('current'), acct('second'), acct('third')], 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 }, ...opts });
  // The current account is deliberately the WORST on pressure while remaining
  // usable. Selection keeps a usable current account without re-ranking, so an
  // untouched fleet stays on it — but any branch that DOES re-rank moves the
  // answer, which is what makes the parity assertions non-vacuous. With the
  // current account also the best, re-ranking returns it and every case agrees
  // for a reason that has nothing to do with the preview mirroring anything.
  am.accounts[0].quota = { ...am.accounts[0].quota,
    unified5h: 0.2, unified5hReset: now + 2 * H,
    unified7d: 0.8, unified7dReset: now + 400 * H,
    unified7dFable: 0.8, unified7dFableReset: now + 400 * H };
  am.accounts[1].quota = { ...am.accounts[1].quota,
    unified5h: 0.05, unified5hReset: now + 2 * H,
    unified7d: 0.1, unified7dReset: now + 20 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 20 * H };
  am.accounts[2].quota = { ...am.accounts[2].quota,
    unified5h: 0.1, unified5hReset: now + 2 * H,
    unified7d: 0.2, unified7dReset: now + 30 * H,
    unified7dFable: 0.2, unified7dFableReset: now + 30 * H };
  am.setCurrentAccount(0);
  return am;
}

/**
 * Each entry names a state `_select` treats specially. A case that stops being
 * special — because the fixture drifted, say — is worse than a missing one, so
 * several carry a premise the harness checks below.
 */
const STATES = [
  ['nothing special', () => {}],
  ['current account disabled', am => { am.accounts[0].disabled = true; }],
  ['current account past its throttle hold', am => {
    am.accounts[0].status = 'throttled';
    am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  }],
  ['current account still inside its throttle hold', am => {
    am.accounts[0].status = 'throttled';
    am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
  }],
  ['current account over its five-hour cap', am => {
    am.accounts[0].quota = { ...am.accounts[0].quota, unified5h: 0.99 };
  }],
  ['current account\'s five-hour window has already reset', am => {
    am.accounts[0].quota = { ...am.accounts[0].quota, unified5h: 0.99, unified5hReset: Date.now() - 60_000 };
  }],
  ['current account requalifying', am => { am.accounts[0].requalify = true; }],
  ['a strictly higher-priority account is available', am => { am.accounts[2].priority = -1; }],
  ['current account exhausted', am => { am.accounts[0].status = 'exhausted'; }],
];

const ROUTED = [
  ['manual pin, pinned account eligible', am => { am.setRoutePin('fable', 2); }],
  ['manual pin, pinned account barred', am => {
    am.accounts[2].quota = { ...am.accounts[2].quota, unified5h: 0.99 };
    am.setRoutePin('fable', 2);
  }],
  ['manual pin, pinned account disabled', am => {
    am.accounts[2].disabled = true;
    am.setRoutePin('fable', 2);
  }],
];

function parity(label, arrange, model, opts) {
  const now = Date.now();
  // Two managers from one fixture. Never one asked twice.
  const previewed = baseFleet(now, opts);
  arrange(previewed);
  const served = baseFleet(now, opts);
  arrange(served);

  const index = previewed.previewRouteIndex(model);
  const previewSays = index == null ? null : previewed.accounts[index].name;
  const account = served.getActiveAccount(null, model, null, null, {});
  const requestGets = account ? account.name : null;

  assert.equal(previewSays, requestGets,
    `${label}: the preview names ${previewSays}, a request is served by ${requestGets}`);
  return { previewSays, requestGets };
}

test('the preview names the account a plain request is served by, in every state selection treats specially', () => {
  const seen = new Set();
  for (const [label, arrange] of STATES) {
    const { previewSays } = parity(label, arrange, null);
    seen.add(previewSays);
  }
  // A matrix whose every case answers the same account is a matrix that proved
  // nothing about branching. Several of these states must move the answer.
  assert.ok(seen.size > 1,
    'every state produced the same destination, so no branch was actually exercised');
});

test('the preview matches selection for a routed model, pinned or not', () => {
  const routes = [{ name: 'fable', match: ['*fable*'] }];
  for (const [label, arrange] of ROUTED) {
    parity(label, arrange, 'claude-fable-5', { routes });
  }
});

test('the states that must move the answer do move it', () => {
  // The premise for the matrix above: if `requalify` or a disabled current
  // account stopped changing where a request goes, the parity assertions would
  // hold for a reason that has nothing to do with the preview mirroring
  // anything, and a real divergence could hide behind them.
  const now = Date.now();
  const plain = baseFleet(now);
  const plainGets = plain.getActiveAccount(null, null, null, null, {}).name;
  assert.equal(plainGets, 'current', 'the premise: an untouched fleet stays on the current account');

  for (const label of ['current account disabled', 'current account requalifying']) {
    const [, arrange] = STATES.find(s => s[0] === label);
    const am = baseFleet(now);
    arrange(am);
    const moved = am.getActiveAccount(null, null, null, null, {}).name;
    assert.notEqual(moved, plainGets, `${label}: no longer moves the request, so parity here is vacuous`);
  }
});
