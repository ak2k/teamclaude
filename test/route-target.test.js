import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// The `target` field on a getRoutes() entry: the account that route would pick
// for a request right now. The dashboard draws one marker per route from it, so
// it has to track live eligibility rather than route membership.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const byName = (routes, name) => routes.find(r => r.name === name);

test('a route names the account it currently resolves to', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  assert.equal(byName(am.getRoutes(), 'bulk').target, 'a');

  am.setRoutePin('bulk', 1);
  assert.equal(byName(am.getRoutes(), 'bulk').target, 'b'); // pin moves the target
});

test('an auto-detected family route names its live target', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const acc of am.accounts) {
    acc.quota.unified7dFable = 0.1;
    acc.quota.unified7dFableReset = Date.now() + 3600_000;
  }
  assert.equal(byName(am.getRoutes(), 'fable').target, 'a');

  // a's Fable bucket crosses the switch threshold — the bucket, not the account,
  // is what moves the marker.
  am.accounts[0].quota.unified7dFable = 0.999;
  assert.equal(byName(am.getRoutes(), 'fable').target, 'b');
});

test('target is null when no account can serve the route', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'], accounts: ['a'] }], // only a may serve it
  });
  am.setDisabled(0, true);
  assert.equal(byName(am.getRoutes(), 'bulk').target, null);
});

test('target stays null-safe with no accounts and no quota data', () => {
  const empty = new AccountManager([], 0.98, { routes: [{ name: 'bulk', match: ['*opus*'] }] });
  const emptyRoutes = empty.getRoutes();
  assert.equal(byName(emptyRoutes, 'bulk').target, null);
  assert.deepEqual(emptyRoutes.filter(r => r.autocreated), []); // no quota → no family routes

  // Accounts present but never probed: no family buckets, configured route still resolves.
  const unprobed = new AccountManager([oauth('a')], 0.98, { routes: [{ name: 'bulk', match: ['*opus*'] }] });
  const routes = unprobed.getRoutes();
  assert.equal(byName(routes, 'bulk').target, 'a');
  assert.deepEqual(routes.filter(r => r.autocreated), []);
});

test('target is derived for display only and never reaches the stored routing table', () => {
  const configured = [{ name: 'bulk', match: ['*opus*'] }];
  const am = new AccountManager([oauth('a')], 0.98, { routes: configured });
  am.getRoutes();

  // The config array the caller handed in — the object that gets written back to
  // disk — must be untouched, as must the manager's normalized copy.
  assert.equal('target' in configured[0], false);
  assert.equal('target' in am.routes[0], false);
});

// ONE RESPONSE, TWO PAYLOADS, AND THEY DISAGREED. `routing[]` was threaded with
// the entry's own route this round; `getRoutes` was not, so both fields here
// re-derived the route from the model — and `_routeForModel` answers about the
// FIRST route matching that id, which for a later route is an earlier one.
//
// WHY EVERY EARLIER FIXTURE MISSED IT: they all used `*fable*`, whose stripped
// core `fable` is an id no route captures, so the sample was never taken by a
// predecessor. `claude-fable-5*` strips to `claude-fable-5`, which is exactly
// what an exact route ahead of it takes. A capturable core is the whole fixture.
test('a later route publishes its OWN destination and its own eligibility', () => {
  const now = Date.now();
  const routes = [{ name: 'exact', match: ['claude-fable-5'], accounts: ['a'] },
    { name: 'later', match: ['claude-fable-5*'], accounts: ['b'] }];
  const build = () => {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 }, routes });
    am.accounts.forEach((x, i) => {
      x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * 3600e3,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * 3600e3,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * 3600e3 };
    });
    return am;
  };
  const status = build().getStatus();
  const later = byName(status.routes, 'later');
  const entry = status.routing.find(e => e.route === 'later');
  const served = build().getActiveAccount(null, 'claude-fable-5-20260101', null, null, {});

  assert.equal(later.sample, 'claude-fable-5',
    'the premise: this route\'s core is an id the earlier route captures');
  assert.equal(served.name, 'b', 'the premise: traffic in this route\'s scope is served by b');
  assert.equal(later.target, 'b',
    'routes[] published the EARLIER route\'s destination for a live later route');
  assert.deepEqual(later.accounts, [{ name: 'b', eligible: true }],
    'routes[] called this route\'s only account ineligible, by another route\'s rules');
  assert.equal(entry.target, later.target,
    'two payloads in one response disagree about where this route sends traffic');
});
