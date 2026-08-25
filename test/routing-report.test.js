import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// `routing[]` is the band and pick decisions as a report. What is held here is
// that it reports rather than re-derives: the entry is built from the same
// evaluation selection performs, so its lists cannot disagree with each other
// or with the routing they describe.
//
// Every fixture below sets values AWAY from the defaults, because a field
// frozen to its default is indistinguishable from a field that stopped reading
// its source. The ladder assertions in particular reach the four row shapes the
// design names, including the two a happy-path fixture never produces: absent
// pressure with KNOWN headroom, whose cumulative advances, and absent headroom,
// which is admitted and contributes nothing.

const acct = name => ({ name, type: 'apikey', apiKey: `k-${name}` });
const H = 3600e3;

function fleet({ accounts = ['a', 'b', 'c', 'd'], expiryRouting, routes, distributeSessions } = {}) {
  return new AccountManager(accounts.map(acct), 0.98, {
    expiryRouting: expiryRouting ?? { enabled: true, coverage: 1, tolerance: 1.5 },
    routes,
    distributeSessions,
  });
}

function quota(am, index, values) {
  am.accounts[index].quota = { ...am.accounts[index].quota, ...values };
}

/**
 * A fleet reaching all four ladder shapes plus one excluded account.
 *
 * Six accounts rather than four, because two of the shapes need an account each
 * that cannot also be one of the others: a row admitted with absent HEADROOM
 * contributes nothing, and a row admitted with absent PRESSURE contributes its
 * measured headroom, so one account cannot demonstrate both.
 */
const LADDER_FLEET = 6;
function ladderFleet(now) {
  const am = fleet({ accounts: ['a', 'b', 'c', 'd', 'e', 'f'] });
  // Ample and expiring soonest: rank 1, ordinary admission.
  quota(am, 0, {
    unified5h: 0.05, unified7d: 0.1, unified7dReset: now + 20 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 30 * H,
  });
  // Enough headroom to carry coverage past its target at rank 2.
  quota(am, 1, {
    unified5h: 0.15, unified7d: 0.3, unified7dReset: now + 40 * H,
    unified7dFable: 0.3, unified7dFableReset: now + 50 * H,
  });
  // No five-hour reading: admitted by the exemption, contributes nothing.
  quota(am, 2, {
    unified5h: null, unified7d: 0.5, unified7dReset: now + 60 * H,
    unified7dFable: 0.5, unified7dFableReset: now + 70 * H,
  });
  // Spent five-hour bucket: never a candidate at all.
  quota(am, 3, { unified5h: 0.99 });
  // Sorts last on pressure with both measurements known, so coverage is long
  // since met by the time it is reached: the held row.
  quota(am, 4, {
    unified5h: 0.3, unified7d: 0.6, unified7dReset: now + 200 * H,
    unified7dFable: 0.6, unified7dFableReset: now + 250 * H,
  });
  // Its family window has no reset, so on the Fable scope its PRESSURE is
  // absent while its headroom stays known: the exemption that still counts.
  quota(am, 5, {
    unified5h: 0.2, unified7d: 0.4, unified7dReset: now + 80 * H,
    unified7dFable: 0.4, unified7dFableReset: null,
  });
  return am;
}

const shared = report => report.find(e => e.scope === 'shared');

test('the shared scope is reported even on a fleet with no routes', () => {
  const am = fleet({ accounts: ['a', 'b'] });
  quota(am, 0, { unified7d: 0.1, unified7dReset: Date.now() + 20 * H });
  quota(am, 1, { unified7d: 0.2, unified7dReset: Date.now() + 30 * H });
  const report = am.getStatus().routing;

  assert.deepEqual(am.getStatus().routes, [], 'the premise: this fleet has no routes');
  assert.equal(report.length, 1);
  assert.equal(shared(report).scope, 'shared');
  assert.equal(shared(report).bucket, 'unified7d');
});

test('candidates and excluded together account for every account', () => {
  const now = Date.now();
  const report = ladderFleet(now).getStatus().routing;
  for (const entry of report) {
    assert.equal(entry.band.candidates + entry.band.excluded.length, LADDER_FLEET,
      `${entry.scope}: an account is in neither list, so the report lost one`);
  }
});

test('an account removed before the band is named with the reason that removed it', () => {
  const now = Date.now();
  const entry = shared(ladderFleet(now).getStatus().routing);
  assert.deepEqual(entry.band.excluded, [
    { account: 'd', reason: 'five-hour-spent', bucket: 'unified5h', detail: 0.99 },
  ], 'the excluded list is empty or unreasoned, so a spent account is simply missing');
  assert.ok(!entry.band.ladder.some(r => r.account === 'd'),
    'an account the band never saw appears in its ladder');
});

test('the ladder reaches all four row shapes', () => {
  const now = Date.now();
  const report = ladderFleet(now).getStatus().routing;
  const rows = report.flatMap(e => e.band.ladder);

  const ordinary = rows.find(r => r.reason === 'under-target');
  assert.ok(ordinary && ordinary.cumulative > 0, 'no ordinary admitted row with a running total');

  const held = rows.find(r => r.reason === 'coverage-met');
  assert.ok(held, 'no held row');
  assert.equal(held.admitted, false);
  assert.equal(held.cumulative, null, 'a held row carries a running total it did not join');

  // The row the design calls out: pressure absent, headroom KNOWN, admitted by
  // the exemption, and its cumulative ADVANCES because measured capacity counts
  // whether or not the account could be ranked.
  const exemptPressure = rows.find(r => r.reason === 'unmeasured-exempt-pressure'
    && r.headroom.kind === 'known');
  assert.ok(exemptPressure, 'no absent-pressure row with a known headroom');
  assert.equal(exemptPressure.admitted, true);
  assert.equal(exemptPressure.rank, null, 'a row the sort could not order carries a rank');
  const entryOf = rows.indexOf(exemptPressure);
  assert.ok(exemptPressure.cumulative > 0, `row ${entryOf}: the exemption contributed nothing`);

  // Its mirror: headroom absent, admitted, contributes nothing.
  const exemptHeadroom = rows.find(r => r.reason === 'unmeasured-exempt-headroom');
  assert.ok(exemptHeadroom, 'no absent-headroom row');
  assert.equal(exemptHeadroom.admitted, true);
  assert.equal(exemptHeadroom.headroom.kind, 'absent');
});

test('the ladder reconciles with the band it explains', () => {
  const now = Date.now();
  for (const entry of ladderFleet(now).getStatus().routing) {
    const admitted = entry.band.ladder.filter(r => r.admitted).map(r => r.account);
    assert.deepEqual([...admitted].sort(), [...entry.band.admitted].sort(),
      `${entry.scope}: the admitted list and the ladder name different accounts`);

    const ranks = entry.band.ladder.filter(r => r.rank != null).map(r => r.rank);
    assert.deepEqual(ranks, ranks.map((_, i) => i + 1), `${entry.scope}: ranks are not dense`);

    const last = entry.band.ladder.filter(r => r.cumulative != null).pop();
    assert.ok(Math.abs(last.cumulative - entry.band.achieved) < 1e-12,
      `${entry.scope}: achieved is not the last running total the ladder published`);

    assert.ok(entry.band.admitted.includes(entry.pick.account),
      `${entry.scope}: the pick names an account the band held back`);
  }
});

test('the pick chooses from the admitted set, not from the candidates', () => {
  // A held account is still a candidate — the band is what removed it — and the
  // pick's first term is load, so a held account carrying nothing wins the pick
  // outright if the pick is handed the wrong list. Naming it would not be a
  // display slip: it would report traffic going to an account the band decided
  // was not worth spending. This fixture is built so the two lists disagree,
  // because with every account idle they agree and the assertion says nothing.
  const now = Date.now();
  const am = fleet({ accounts: ['a', 'b', 'held'] });
  quota(am, 0, { unified5h: 0.05, unified7d: 0.1, unified7dReset: now + 20 * H });
  quota(am, 1, { unified5h: 0.15, unified7d: 0.3, unified7dReset: now + 40 * H });
  // Lowest pressure by a wide margin, so coverage is met before it is reached.
  quota(am, 2, { unified5h: 0.3, unified7d: 0.6, unified7dReset: now + 500 * H });
  // The two admitted accounts are carrying real traffic; the held one is idle.
  for (const [id, index] of [['s1', 0], ['s2', 1]]) {
    am.recordSession(id, index, 'claude-opus-5');
    am.recordTokenUsage(index, id, 'claude-opus-5', {
      input_tokens: 0, cache_read_input_tokens: 250_000,
      cache_creation_input_tokens: 0, output_tokens: 0,
    });
  }

  const entry = shared(am.getStatus().routing);
  assert.deepEqual(entry.band.admitted, ['a', 'b'], 'the premise: the third account is held');
  assert.equal(entry.band.candidates, 3, 'the premise: it is still a candidate');
  assert.ok(entry.band.ladder.some(r => r.account === 'held' && !r.admitted),
    'the premise: the ladder shows it held');
  assert.notEqual(entry.pick.account, 'held',
    'the pick was handed the candidates, so it names an account the band held back');
  assert.ok(entry.band.admitted.includes(entry.pick.account));
});

test('a fleet with no five-hour signal reports the ratio rule and says why', () => {
  const now = Date.now();
  const am = fleet({ accounts: ['a', 'b', 'c'] });
  // The stock upstream state: the quota probe is off, so nothing has reported a
  // five-hour level and capacity sizing cannot run.
  quota(am, 0, { unified5h: null, unified7d: 0.1, unified7dReset: now + 20 * H });
  quota(am, 1, { unified5h: null, unified7d: 0.2, unified7dReset: now + 100 * H });
  quota(am, 2, { unified5h: null, unified7d: 0.9, unified7dReset: now + 500 * H });
  const entry = shared(am.getStatus().routing);

  assert.equal(entry.band.kind, 'banded');
  assert.equal(entry.band.reason, 'no-capacity-signal',
    'the fallback reason is null, so the report cannot say which state produced it');
  assert.ok(entry.band.floor > 0, 'the ratio rule published no floor');
  assert.equal(entry.band.target, null, 'a variant without a target published one');
  assert.equal(entry.band.achieved, null);
  for (const row of entry.band.ladder) {
    assert.equal(row.rank, null, 'the ratio rule published a rank, which it never computed');
    assert.equal(row.cumulative, null, 'the ratio rule published a coverage total');
    assert.ok(['within-tolerance', 'below-floor', 'unmeasured-exempt-pressure'].includes(row.reason));
  }
  assert.ok(entry.band.ladder.some(r => r.reason === 'below-floor'),
    'the fixture never excluded anyone, so the floor was not exercised');
});

test('expiry routing off reports passthrough and publishes no ladder', () => {
  const now = Date.now();
  const am = fleet({ accounts: ['a', 'b'], expiryRouting: { enabled: false } });
  quota(am, 0, { unified7d: 0.1, unified7dReset: now + 20 * H });
  quota(am, 1, { unified7d: 0.2, unified7dReset: now + 30 * H });
  const entry = shared(am.getStatus().routing);

  assert.equal(entry.band.kind, 'passthrough');
  assert.equal(entry.band.reason, 'disabled');
  assert.deepEqual(entry.band.ladder, [],
    'a decision that ranked nothing published a ladder, which asserts a walk that never ran');
  assert.deepEqual(entry.band.admitted, ['a', 'b'], 'passthrough keeps the candidate set');
  assert.ok(entry.pick.account, 'a pick still happens with the feature off');
});

test('the report reaches more than one band variant across a run', () => {
  // A single-variant corpus leaves every variant-shaped field at one value, so
  // freezing `kind` would pass. Two fleets, two variants, asserted together.
  const now = Date.now();
  const sized = shared(ladderFleet(now).getStatus().routing).band.kind;
  const am = fleet({ accounts: ['a', 'b'], expiryRouting: { enabled: false } });
  quota(am, 0, { unified7d: 0.1, unified7dReset: now + 20 * H });
  const passthrough = shared(am.getStatus().routing).band.kind;
  assert.notEqual(sized, passthrough);
  assert.deepEqual([sized, passthrough].sort(), ['passthrough', 'sized']);
});

test('a tie broken by config order is reported as a tie, not as a term', () => {
  const now = Date.now();
  const am = fleet({ accounts: ['a', 'b'], expiryRouting: { enabled: false } });
  // Identical on every term: same quota, same reset, no load, no sessions.
  for (const i of [0, 1]) quota(am, i, { unified7d: 0.2, unified7dReset: now + 30 * H });
  const entry = shared(am.getStatus().routing);

  assert.equal(entry.pick.account, 'a');
  assert.deepEqual(entry.pick.tiedWith, ['b'],
    'the account the winner did not beat is not named, so position reads as a decision');
  assert.equal(entry.pick.runnerUp, 'b');
});

test('each entry names the family its own figures were computed for', () => {
  // A route matching two globs has two governing buckets, so two different
  // bands and two different picks. Publishing one entry for it presented the
  // first family's answer as the answer for both.
  const now = Date.now();
  const am = fleet({ accounts: ['a', 'b', 'c'], routes: [{ name: 'families', match: ['*fable*', '*sonnet*'] }] });
  for (const i of [0, 1, 2]) {
    quota(am, i, {
      unified5h: 0.05 + i * 0.1, unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H,
      unified7dSonnet: 0.5 + i * 0.1, unified7dSonnetReset: now + (25 + i * 10) * H,
    });
  }
  const entries = am.getStatus().routing.filter(e => e.route === 'families');

  assert.equal(entries.length, 2, 'a two-glob route published one answer for two families');
  assert.deepEqual(entries.map(e => e.bucket).sort(), ['unified7dFable', 'unified7dSonnet']);
  for (const e of entries) {
    assert.equal(e.match.length, 1, 'an entry claims globs its figures do not cover');
    assert.ok(e.bucket.toLowerCase().includes(e.match[0].replace(/\*/g, '')),
      `${e.match[0]} is published against ${e.bucket}`);
  }
});

// A GLOB IS NOT A FAMILY. `*fable*` happens to strip to a string whose family
// resolves correctly, which is why every fixture above passes with the glob
// used as a model id. `claude-*` strips to `claude-`, which resolves to the
// SHARED bucket, so one entry answered for Opus, Sonnet and Fable at once —
// with the shared weekly's band, ladder and destination.
function familyFleet(now, routes) {
  const am = fleet({ accounts: ['idle', 'opus-best', 'sonnet-best', 'fable-best'], routes });
  // Out of the way, so every destination below comes from ranking rather than
  // from the current account sitting still.
  am.accounts[0].disabled = true;
  quota(am, 0, { unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 500 * H });
  quota(am, 1, {
    unified5h: 0.05, unified7d: 0.1, unified7dReset: now + 20 * H,
    unified7dSonnet: 0.9, unified7dSonnetReset: now + 500 * H,
    unified7dFable: 0.9, unified7dFableReset: now + 500 * H,
  });
  quota(am, 2, {
    unified5h: 0.05, unified7d: 0.9, unified7dReset: now + 500 * H,
    unified7dSonnet: 0.1, unified7dSonnetReset: now + 20 * H,
    unified7dFable: 0.9, unified7dFableReset: now + 500 * H,
  });
  quota(am, 3, {
    unified5h: 0.05, unified7d: 0.9, unified7dReset: now + 500 * H,
    unified7dSonnet: 0.9, unified7dSonnetReset: now + 500 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 20 * H,
  });
  return am;
}

test('a glob spanning families publishes one entry per family, each with a real model id', () => {
  const now = Date.now();
  const routes = [{ name: 'broad', match: ['claude-*'] }];
  const entries = familyFleet(now, routes).getStatus().routing.filter(e => e.route === 'broad');

  assert.equal(entries.length, 3, 'a family-spanning glob published one answer for every family');
  assert.deepEqual(entries.map(e => e.bucket),
    ['unified7d', 'unified7dSonnet', 'unified7dFable'],
    'the entries do not cover one bucket each');
  // The premise: on this fleet the three families genuinely go to three
  // different accounts, so an entry copying another family's answer is visible.
  assert.equal(new Set(entries.map(e => e.target)).size, 3,
    'the fixture sends every family to the same account, so the entries cannot be told apart');

  for (const entry of entries) {
    // Each entry, against a request for the model that entry claims to be
    // about, on a manager of its own.
    const served = familyFleet(now, routes);
    const account = served.getActiveAccount(null, entry.model, null, null, {});
    assert.equal(entry.target, account ? account.name : null,
      `${entry.model}: the entry names ${entry.target}, a request for it is served by ${account?.name}`);
    assert.equal(entry.bucket, served._weeklyBucketFor(entry.model),
      `${entry.model}: the entry's bucket is not the one a request for it is metered on`);
  }
});

// AN ENTRY ANSWERS FOR ITS OWN ROUTE. Every figure on it used to be derived by
// resolving a route FROM the representative id — the request path's question,
// which the report already knows the answer to. When an earlier route captures
// that id, the resolution returns a different route, and the entry published
// that route's bucket override, that route's pin, that route's account list and
// a band over that route's candidates, all under this route's name.
//
// Six fields, so six assertions: a green on one of them proves nothing about
// the other five, and the first version of this fix threaded the route into the
// preview while a stale identity lookup left the rest deriving.
// SIX ASSERTIONS, ONE TEST BODY, so a reversion reports `1 fail` and not six.
// Detection is unaffected — break any one field and this test fails — but the
// first failing assertion aborts the rest, so the count understates the blast
// radius and never understates whether it was caught. A reader treating `1
// fail` as "one field moved" will under-scope the diagnosis.
test('every figure on an entry is its own route\'s, not the representative\'s owner\'s', () => {
  const now = Date.now();
  const am = fleet({
    accounts: ['a', 'b'],
    routes: [
      { name: 'exact', match: ['claude-fable-5'], accounts: ['a'], bucket: 'unified7dSonnet' },
      { name: 'wild', match: ['*fable*'], accounts: ['b'] },
    ],
  });
  for (const i of [0, 1]) {
    quota(am, i, {
      unified5h: 0.05 + i * 0.05, unified7d: 0.2, unified7dReset: now + 20 * H,
      unified7dFable: 0.1 + i * 0.4, unified7dFableReset: now + (20 + i * 10) * H,
      unified7dSonnet: 0.3, unified7dSonnetReset: now + 40 * H,
    });
  }
  assert.equal(am.setRoutePin('exact', 0).ok, true);

  const report = am.getStatus().routing;
  const wild = report.find(e => e.route === 'wild');
  const exact = report.find(e => e.route === 'exact');
  // The premise: `exact` captures the representative id, which is what makes
  // deriving the route from it return the wrong route.
  assert.equal(am._routeForModel('claude-fable-5').name, 'exact');
  assert.ok(wild, 'the live route publishes nothing, which is the defect one layer up');

  // WHAT A CAPTURED ENTRY PUBLISHES NOW. The figures were this route's own
  // after the threading, and they were still computed FOR AN ID THIS ROUTE
  // NEVER RECEIVES — which published `route-excluded` against the only account
  // serving the route. So they are not published at all, with the reason.
  assert.equal(wild.figuresAbsent, 'representative-captured',
    'the entry publishes per-account figures for an id its route never receives');
  assert.equal(wild.familySplit, 'an earlier route');
  assert.equal(wild.target, null, 'the entry names a destination for traffic it does not receive');
  assert.equal(wild.pinnedTo, null);
  assert.deepEqual(wild.band.excluded, [], 'a suppressed entry still names accounts');
  assert.deepEqual(wild.band.admitted, []);
  assert.equal(wild.band.candidates, 0);
  assert.equal(wild.pick.account, null);
  // The one figure that survives is the one that is about the SCOPE rather than
  // about accounts, and it is still this route's own: the earlier route's
  // Sonnet override does not reach it.
  assert.equal(wild.bucket, 'unified7dFable', "the entry carries the other route's bucket override");
  // And the entry that legitimately owns those things still has them, so the
  // fix cannot be "stop reading route configuration at all".
  assert.equal(exact.bucket, 'unified7dSonnet');
  assert.equal(exact.pinnedTo, 'a');
  assert.equal(exact.target, 'a');
});

// THE ROUTE HAS TO REACH RANKING, not only the fields that name things. The
// first threading carried it to the bucket, the pin, the account allowance and
// the preview, and stopped: `_bandSnapshot` still resolved each account's
// governing window from the model id, so a shadowed Fable route RANKED its
// candidates on the earlier route's Sonnet override while every label on the
// entry said Fable.
//
// Measured at c97a4ec before this fix, on the fixture below: the entry's bucket
// and every ladder row read `unified7dFable`, the band admitted `sonnet-best`,
// the pick named `sonnet-best` — and `target` said `fable-best`, because the
// preview WAS threaded. The entry contradicted itself and the suite was green.
//
// A correct label on a wrong computation is the shape this round exists to
// remove, and it survived because the label and the computation live in
// different functions.
// WHAT THESE FOUR NOW GRADE, and it is not what they were written for.
//
// Each fixture below was built to catch the route failing to reach one ranking
// site — the band's snapshot, the preview's band, the pick's final tiebreak,
// the last resort — by making the entry's own window and its CAPTOR'S window
// order the fleet oppositely. Every one of them needs a CAPTURED
// representative, because that is the only state in which deriving the route
// from the model differs from being handed it.
//
// A captured entry now publishes no per-account figures at all, so the ladder,
// the admitted set, the pick and the destination these asserted are gone by
// design. The invariant they graded still holds in the code and is no longer
// OBSERVABLE in this payload: the threading remains as defence, and its
// mutation-table rows are expected to report SURVIVES for exactly that reason.
// The fixtures are kept intact, with their measured premises, because they are
// the shapes that produce the state — and what they assert now is that the
// state produces an absence with a reason rather than somebody else's numbers.
test('the band ranks on the window this route governs, not its representative owner\'s', () => {
  const now = Date.now();
  const am = fleet({
    accounts: ['fable-best', 'sonnet-best'],
    expiryRouting: { enabled: true, coverage: 0.5, tolerance: 1.5 },
    routes: [
      { name: 'exact', match: ['claude-fable-5'], bucket: 'unified7dSonnet' },
      { name: 'wild', match: ['*fable*'] },
    ],
  });
  // The two windows rank the fleet OPPOSITE ways, so which one the band reads
  // decides the admitted set and the destination. Without that, both readings
  // agree and the arm grades nothing.
  quota(am, 0, {
    unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 300 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 20 * H,
    unified7dSonnet: 0.9, unified7dSonnetReset: now + 400 * H,
  });
  quota(am, 1, {
    unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 300 * H,
    unified7dFable: 0.9, unified7dFableReset: now + 400 * H,
    unified7dSonnet: 0.1, unified7dSonnetReset: now + 20 * H,
  });

  // Premises: the representative really is shadowed by a route with a bucket
  // override, and the two windows really do disagree about the ranking.
  assert.equal(am._routeForModel('claude-fable-5').name, 'exact');
  assert.equal(am._routeForModel('claude-fable-5').bucket, 'unified7dSonnet');

  const wild = am.getStatus().routing.find(e => e.route === 'wild');
  assert.equal(wild.bucket, 'unified7dFable',
    'the scope-level figure is still this route\'s own, not its captor\'s override');
  assert.equal(wild.figuresAbsent, 'representative-captured');
  assert.deepEqual(wild.band.ladder, [], 'a captured entry publishes a ranking of accounts');
  assert.deepEqual(wild.band.admitted, []);
  assert.equal(wild.pick.account, null);
  assert.equal(wild.target, null);
});

// THREE MORE SITES THE FIRST ARM DOES NOT REACH, each found by mutating the
// threading and watching the suite stay green. The ladder test above covers the
// report's own snapshot; these cover the preview's band, the pick's final
// tiebreak, and the last resort — every remaining place the route decides
// something and used to be resolved from the model id.
test('the preview bands on this route\'s window, so the destination follows it', () => {
  const now = Date.now();
  const am = fleet({
    accounts: ['idle', 'fable-best', 'sonnet-best'],
    expiryRouting: { enabled: true, coverage: 0.5, tolerance: 1.5 },
    routes: [
      { name: 'exact', match: ['claude-fable-5'], bucket: 'unified7dSonnet' },
      { name: 'wild', match: ['*fable*'] },
    ],
  });
  // The current account is out of the way, so the destination comes from the
  // band rather than from the sticky walk — with it eligible, the preview
  // returns it whatever the band decided and this arm grades nothing.
  am.accounts[0].disabled = true;
  quota(am, 0, { unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 500 * H });
  quota(am, 1, {
    unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 300 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 20 * H,
    unified7dSonnet: 0.9, unified7dSonnetReset: now + 400 * H,
  });
  quota(am, 2, {
    unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 300 * H,
    unified7dFable: 0.9, unified7dFableReset: now + 400 * H,
    unified7dSonnet: 0.1, unified7dSonnetReset: now + 20 * H,
  });

  const wild = am.getStatus().routing.find(e => e.route === 'wild');
  assert.equal(wild.figuresAbsent, 'representative-captured');
  assert.equal(wild.target, null,
    'the entry names a destination computed for an id it never receives');
});

test('the final tiebreak reads the reset of THIS route\'s window', () => {
  const now = Date.now();
  const am = fleet({
    // Three, not two: the preview returns an eligible CURRENT account without
    // ranking, so with only the tied pair the destination never reaches the
    // tiebreak and the `target` assertion below grades nothing. Measured — the
    // mutation that reads the wrong window in `_pickBestAvailable` survived
    // until this account existed.
    accounts: ['idle', 'soon', 'late'],
    expiryRouting: { enabled: true, coverage: 5, tolerance: 1.5 },
    routes: [
      { name: 'exact', match: ['claude-fable-5'], bucket: 'unified7dSonnet' },
      { name: 'wild', match: ['*fable*'] },
    ],
  });
  // Equal PRESSURE on the Fable window — (1-u)/seconds identical — so the pick
  // falls through to its last term, the governing window's reset. The Sonnet
  // window orders the two resets the OPPOSITE way, which is what makes the
  // arm able to tell the windows apart: my first version had both windows
  // ordering them the same, so reading the wrong one landed on the same
  // answer and the mutation survived.
  am.accounts[0].disabled = true;
  quota(am, 0, { unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 500 * H });
  quota(am, 1, {
    unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 300 * H,
    unified7dFable: 0.5, unified7dFableReset: now + 10 * H,
    unified7dSonnet: 0.5, unified7dSonnetReset: now + 20 * H,
  });
  quota(am, 2, {
    unified5h: 0.05, unified7d: 0.5, unified7dReset: now + 300 * H,
    unified7dFable: 0.75, unified7dFableReset: now + 5 * H,
    unified7dSonnet: 0.5, unified7dSonnetReset: now + 400 * H,
  });

  const wild = am.getStatus().routing.find(e => e.route === 'wild');
  assert.equal(wild.figuresAbsent, 'representative-captured');
  assert.deepEqual(wild.band.ladder, [],
    'the tie this fixture builds is between accounts this route may not even serve');
  assert.equal(wild.pick.account, null);
  assert.equal(wild.target, null);
});

test('the last resort reopens an account THIS route allows', () => {
  const now = Date.now();
  const secs = ms => String(Math.floor(ms / 1000));
  const am = fleet({
    accounts: ['exact-only', 'wild-only'],
    routes: [
      { name: 'exact', match: ['claude-fable-5'], accounts: ['exact-only'] },
      { name: 'wild', match: ['*fable*'], accounts: ['wild-only'] },
    ],
  });
  // Both barred, both carrying a five-hour reset that has already passed with no
  // utilization beside it — the reachable last-resort state.
  for (const i of [0, 1]) {
    am.updateQuota(i, {
      'anthropic-ratelimit-unified-5h-reset': secs(now - 30 * 60e3),
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.995',
      'anthropic-ratelimit-unified-7d_oi-reset': secs(now + 100 * H),
      'anthropic-ratelimit-unified-7d-utilization': '0.995',
      'anthropic-ratelimit-unified-7d-reset': secs(now + 100 * H),
    });
  }

  const wild = am.getStatus().routing.find(e => e.route === 'wild');
  assert.equal(wild.figuresAbsent, 'representative-captured');
  assert.equal(wild.band.candidates, 0);
  assert.equal(wild.target, null,
    'a captured entry names the account a last resort would reopen for another route\'s id');
});

// THREE CAUSES, ONE FIELD. `familySplit` says the figures on this entry are its
// representative's and names why the rest of the scope may differ. Two of the
// three were invisible until pass 8 found them: a family with no pattern of its
// own could not be measured at all, and an earlier ROUTE taking the
// representative was never asked about — the entry then answered, correctly, for
// an id its own route never receives.
test('an entry says WHY its representative may not answer for the scope', () => {
  const now = Date.now();
  const withClaims = (name, models) => ({ name, type: 'apikey', apiKey: `k-${name}`, models });
  const fill = (am) => {
    am.accounts.forEach((a, i) => {
      a.quota = { ...a.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
    });
    return am;
  };

  // 1. An earlier route takes the representative. The entry is right about
  //    where ITS traffic goes and named after an id that goes elsewhere.
  const captured = fill(new AccountManager([acct('a'), acct('b')], 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'exact', match: ['claude-fable-5'], accounts: ['a'] },
      { name: 'wild', match: ['*fable*'], accounts: ['b'] }],
  }));
  const wild = captured.getStatus().routing.find(e => e.route === 'wild');
  const served = fill(new AccountManager([acct('a'), acct('b')], 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'exact', match: ['claude-fable-5'], accounts: ['a'] },
      { name: 'wild', match: ['*fable*'], accounts: ['b'] }],
  })).getActiveAccount(null, 'claude-fable-5', null, null, {});
  assert.equal(wild.model, 'claude-fable-5', 'the premise: the entry is named by the captured id');
  assert.equal(served.name, 'a', 'the premise: that id is served by the OTHER route');
  assert.equal(wild.familySplit, 'an earlier route',
    'the entry answers under an id its route never receives and says nothing about it');
  // The disclosure and the suppression are one determination, so they arrive
  // together or the entry is claiming figures it has just disowned.
  assert.equal(wild.figuresAbsent, 'representative-captured');
  assert.equal(wild.target, null);

  // 2. A family with no pattern of its own is still divisible.
  const opus = fill(new AccountManager(
    [withClaims('five', ['claude-opus-4-5']), withClaims('one', ['claude-opus-4-1'])], 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
      routes: [{ name: 'broad', match: ['claude-*'] }],
    }));
  const entries = opus.getStatus().routing.filter(e => e.route === 'broad');
  const shared = entries.find(e => e.bucket === 'unified7d');
  const fable = entries.find(e => e.bucket === 'unified7dFable');
  assert.equal(shared.familySplit, 'model claims',
    'the shared bucket has no family glob, so its division was unmeasurable');
  // And the measurement stays specific: Opus claims do not divide Fable.
  assert.equal(fable.familySplit, null,
    'claims that cannot reach this family are reported as dividing it');
});

// THE SYMMETRY SET FOR CAPTURE is which id an earlier route took: the
// representative, or a SIBLING of it. The first was fixed in pass 8 by asking
// where the representative resolves, and that question cannot see the second —
// the representative still resolves here, so the entry answered for a family it
// shares with a route ahead of it and said nothing. The symmetry set for
// division is positive and negative: a split reported where there is one, and
// none reported where the scope cannot have one.
test('an earlier route splits the family whichever id it took, and one id is never split', () => {
  const now = Date.now();
  const withClaims = (name, models) => ({ name, type: 'apikey', apiKey: `k-${name}`, models });
  const fill = (am) => {
    am.accounts.forEach((a, i) => {
      a.quota = { ...a.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
    });
    return am;
  };
  const mk = (accounts, routes) => fill(new AccountManager(accounts, 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 }, routes }));

  // 1. A SIBLING id taken earlier. `claude-fable-4` is not the representative,
  //    so where the representative resolves is no evidence at all.
  const siblingRoutes = [{ name: 'sibling', match: ['claude-fable-4'], accounts: ['a'] },
    { name: 'wild', match: ['*fable*'], accounts: ['b'] }];
  const wild = mk([acct('a'), acct('b')], siblingRoutes)
    .getStatus().routing.find(e => e.route === 'wild');
  const four = mk([acct('a'), acct('b')], siblingRoutes)
    .getActiveAccount(null, 'claude-fable-4', null, null, {});
  assert.equal(wild.model, 'claude-fable-5', 'the premise: the entry is named by an id it does own');
  assert.equal(four.name, 'a', 'the premise: a sibling of the family is served elsewhere');
  assert.equal(wild.familySplit, 'an earlier route',
    'the entry answers for a family it shares with a route ahead of it');
  // This pole's representative is NOT captured — `claude-fable-4` is the id
  // taken — so the entry keeps its figures and names its own destination. That
  // is the line between the two disclosures: sibling taken, figures stand;
  // representative taken, figures go.
  assert.equal(wild.figuresAbsent, null);
  assert.equal(wild.target, 'b', 'the premise: its own traffic goes here');

  // 2. The negative pole for capture: an earlier route that cannot reach this
  //    family divides nothing, so the disclosure is not blanket.
  const apart = mk([acct('a'), acct('b')],
    [{ name: 'other', match: ['*opus*'], accounts: ['a'] },
      { name: 'wild', match: ['*fable*'], accounts: ['b'] }])
    .getStatus().routing.find(e => e.route === 'wild');
  assert.equal(apart.familySplit, null, 'a route ahead that shares no id takes nothing');

  // 3. A SCOPE OF ONE ID CANNOT BE DIVIDED, and reported that it was: measured
  //    against the family's `*fable*`, a sibling's claim looked like a split of
  //    a scope the sibling never reaches.
  const claims = [withClaims('a', ['claude-fable-5']), withClaims('b', ['claude-fable-4'])];
  const exact = mk(claims, [{ name: 'exact', match: ['claude-fable-5'] }])
    .getStatus().routing.find(e => e.route === 'exact');
  assert.deepEqual(exact.match, ['claude-fable-5'], 'the premise: the scope is one id');
  assert.equal(exact.familySplit, null, 'one id, one destination, nothing to divide');

  // 4. The positive pole for division, on the same claims: a WILD scope over
  //    that family is genuinely split by them, so the refusal above is about
  //    the scope's shape and not about the claims.
  const spread = mk(claims, [{ name: 'wild', match: ['*fable*'] }])
    .getStatus().routing.find(e => e.route === 'wild');
  assert.equal(spread.familySplit, 'model claims',
    'the same claims still split a scope wide enough to be divided');

  // 5. THE ONE SCOPE ONLY THE REPRESENTATIVE CHECK REACHES, and it needed
  //    finding: adding the earlier-route arm above made every previous fixture
  //    for that check pass with it disabled, because the new arm answers them
  //    with the same string. A neutralisation sweep is what noticed. The gap it
  //    left is a ONE-ID scope whose id an earlier route took — the early return
  //    for "one id cannot be divided" sits between the two checks, so only the
  //    representative check can speak for it.
  //
  //    Reaching it needs an earlier route that TAKES the representative while
  //    the earlier-route arm cannot see it. That arm asks
  //    `modelGlobOverlaps`, which compares literal cores: `claude-*-5` and
  //    `*fable*` reduce to `claude--5` and `fable`, neither containing the
  //    other, so it answers no overlap — while `claude-*-5` matches
  //    `claude-fable-5` perfectly well and takes it. The core comparison's
  //    imprecision is what leaves this case to the owner check.
  //
  //    (The fixture that used to sit here relied on `globCovers` refusing a
  //    two-interior-literal pattern. The exact-glob guard retired that refusal:
  //    such a route now correctly reads as covered and publishes nothing at
  //    all, so the fixture stopped reaching the check rather than stopped
  //    mattering.)
  const versioned = [{ name: 'v5', match: ['claude-*-5'], accounts: ['a'] },
    { name: 'wild', match: ['*fable*'], accounts: ['b'] }];
  const taken = mk([acct('a'), acct('b')], versioned)
    .getStatus().routing.find(e => e.route === 'wild');
  const goes = mk([acct('a'), acct('b')], versioned)
    .getActiveAccount(null, 'claude-fable-5', null, null, {});
  assert.equal(goes.name, 'a', 'the premise: its representative is served by the earlier route');
  assert.equal(taken.familySplit, 'an earlier route',
    'an entry named by an id its route never receives said nothing about it');
  // Captured, so the figures go with the disclosure. This pole is the pair's
  // other side: the one above keeps its figures because the id taken was a
  // SIBLING, this one loses them because the id taken is the entry's own name.
  assert.equal(taken.figuresAbsent, 'representative-captured');
  assert.equal(taken.target, null);
});

// WHAT A FAMILY IS, versus which families meter their own weekly bucket. Two
// questions, one helper answering both, and the wrong one was being asked: an
// exhaustive measurement of this field found 210 disclosures on scopes that
// cannot be divided, and half of them were Opus entries measured against their
// SCOPE's glob because `familyGlobFor` answers null for a family with no bucket.
test('a family is measured by its own pattern, not by whether it meters a bucket', () => {
  const now = Date.now();
  const fill = (am) => {
    am.accounts.forEach((a, i) => {
      a.quota = { ...a.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
    });
    return am;
  };
  const am = fill(new AccountManager([acct('a'), acct('b')], 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'exact', match: ['claude-fable-5'], accounts: ['a'] },
      { name: 'broad', match: ['claude-*'], accounts: ['b'] }],
  }));
  const entries = am.getStatus().routing.filter(e => e.route === 'broad');
  const of = family => entries.find(e => e.model.includes(family));

  // The Fable entry genuinely shares its family with the earlier route.
  assert.equal(of('fable').familySplit, 'an earlier route',
    'the family the earlier route reaches into is disclosed');
  // The Opus one does not. Every Opus id is this route's, and `claude-*` is not
  // the Opus family — it is merely the scope those ids happen to arrive under.
  assert.equal(of('opus').familySplit, null,
    'an Opus entry was told its family was split by a route that takes no Opus id');
  assert.equal(of('sonnet').familySplit, null,
    'and the same for Sonnet, so this is about the family and not about one id');
});

// THE ONE FAMILY WITH NO PATTERN keeps the scope glob, and that remnant needs
// its own fixture or it is a branch nobody grades — a sweep found it surviving
// once the named families stopped using it. An id belongs to 'other' by failing
// every named family, which no glob expresses, so the scope's own glob is the
// best available characterisation and is not wrong the way `claude-*` was wrong
// for Opus: there is nothing narrower to be right about.
test('a family with no pattern of its own is still measured by its scope', () => {
  const now = Date.now();
  const withClaims = (name, models) => ({ name, type: 'apikey', apiKey: `k-${name}`, models });
  const build = (claims) => {
    const am = new AccountManager(
      [withClaims('a', claims[0]), withClaims('b', claims[1])], 0.98, {
        expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
        routes: [{ name: 'gpt', match: ['gpt-*'] }],
      });
    am.accounts.forEach((x, i) => {
      x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H };
    });
    return am.getStatus().routing.find(e => e.route === 'gpt');
  };
  const split = build([['gpt-4o'], ['gpt-4o-mini']]);
  assert.equal(split.model, 'gpt-', 'the premise: no metered family, so the scope is its own literal');
  assert.equal(split.familySplit, 'model claims',
    'a scope whose family has no pattern was left unmeasurable and undisclosed');
  // The negative pole: claims that cannot reach this scope do not divide it.
  assert.equal(build([['claude-fable-5'], ['claude-fable-4']]).familySplit, null,
    'claims that name no id this scope carries were read as dividing it');
});

// A ROUTE WITH AN EXPLICIT ACCOUNTS LIST PINS WHAT IT CARRIES. `_routeAllows`
// decides before any claim does, so the scope goes where the list says whatever
// the accounts claim; reporting a claim-division there describes a split the
// route makes impossible.
test('claims cannot divide a scope whose route names its accounts', () => {
  const now = Date.now();
  const withClaims = (name, models) => ({ name, type: 'apikey', apiKey: `k-${name}`, models });
  const build = (accounts) => {
    const am = new AccountManager(
      [withClaims('a', ['claude-fable-5']), withClaims('b', ['claude-fable-4'])], 0.98, {
        expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
        routes: [{ name: 'fable', match: ['*fable*'], ...(accounts ? { accounts } : {}) }],
      });
    am.accounts.forEach((x, i) => {
      x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
    });
    return am.getStatus().routing.find(e => e.route === 'fable');
  };
  assert.equal(build(['b']).familySplit, null,
    'the route pins every id it carries, so no claim can divide the scope');
  // The contrast, so this is a statement about the route and not a blanket
  // silencing of the claims arm.
  assert.equal(build(null).familySplit, 'model claims',
    'the same claims still divide the same scope when the route names no accounts');
});

// ONE COVERAGE QUESTION, TWO DOORS. A glob naming a metered family asks whether
// an earlier route already took it; a glob naming none fell back to its own
// literal and never asked. So `gpt-*` behind a catch-all published a scope with
// a destination while every real request went to the catch-all — and `*fable*`
// in the identical shape was correctly suppressed. The contrast is what makes
// it a missing question rather than a policy.
test('a route the catch-all has already taken publishes nothing, family or not', () => {
  const now = Date.now();
  const build = (glob) => {
    const am = new AccountManager([acct('a'), acct('b'), acct('c')], 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
      routes: [{ name: 'all', match: ['*'], accounts: ['a'] },
        { name: 'later', match: [glob], accounts: ['c'] }],
    });
    am.accounts.forEach((x, i) => {
      x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
    });
    return am;
  };
  for (const [glob, probe] of [['gpt-*', 'gpt-4o'], ['*fable*', 'claude-fable-5']]) {
    const entries = build(glob).getStatus().routing.filter(e => e.route === 'later');
    const served = build(glob).getActiveAccount(null, probe, null, null, {});
    assert.equal(served.name, 'a', `the premise: ${probe} is served by the catch-all`);
    assert.deepEqual(entries, [],
      `the ${glob} route advertises a destination for traffic it never receives`);
  }
});

// AN AUTOCREATED SCOPE IS LAST BY CONSTRUCTION — it exists only because no
// configured route matched its representative — so every configured route is
// ahead of it. It arrives with no route object of its own, and reading that as
// "nothing precedes this" made the predecessor walk unreachable for exactly the
// scopes with the most predecessors. Two reviewers confirmed the mechanism and
// neither could make it show, because their fixtures had both ids landing on
// the same account; what makes it show is the sibling being pinned somewhere it
// cannot be served.
test('an autocreated scope sees the configured routes ahead of it', () => {
  const now = Date.now();
  const routes = [{ name: 'four', match: ['claude-fable-4'], accounts: ['a'] }];
  const build = () => {
    const am = new AccountManager([acct('a'), acct('b'), acct('c')], 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 }, routes });
    const q = (i, fable) => {
      am.accounts[i].quota = { ...am.accounts[i].quota,
        unified5h: 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2, unified7dReset: now + 40 * H,
        unified7dFable: fable, unified7dFableReset: now + 40 * H };
    };
    q(0, 0.99);   // spent on Fable, and the only account the exact route may use
    q(1, 0.5);
    q(2, 0.02);
    return am;
  };
  const entry = build().getStatus().routing.find(e => e.autocreated);
  const five = build().getActiveAccount(null, 'claude-fable-5', null, null, {});
  const four = build().getActiveAccount(null, 'claude-fable-4', null, null, {});

  assert.equal(entry.model, 'claude-fable-5', 'the premise: the autocreated Fable scope is published');
  assert.equal(five.name, 'c', 'the premise: the family goes to the best Fable account');
  assert.equal(four, null,
    'the premise: the sibling is pinned to a spent account and cannot be served at all');
  assert.equal(entry.familySplit, 'an earlier route',
    'the entry named its own destination for a family whose other id is served nowhere');
});

test('a route whose families are all captured earlier publishes no entry at all', () => {
  // Two states reached the same empty list and only one of them means "fall
  // back to the literal": a glob naming NO metered family is a shared-bucket
  // scope, while a glob whose families another route already owns carries
  // nothing. Collapsing them published a second `*fable*` route with a Fable
  // bucket and a destination for traffic first-match routing never sends it.
  const now = Date.now();
  const routes = [{ name: 'first', match: ['*fable*'] }, { name: 'second', match: ['*fable*'] }];
  const report = familyFleet(now, routes).getStatus().routing;

  assert.deepEqual(report.filter(e => e.route === 'first').map(e => e.model), ['claude-fable-5'],
    'the premise: the first route is the one that receives Fable');
  assert.deepEqual(report.filter(e => e.route === 'second'), [],
    'the second route publishes a destination for traffic it can never receive');
});

// EVERY EARLIER ROUTE, not just the one the representative resolves to. With an
// exact route and then a CATCH-ALL ahead of a third, the representative resolves
// to the exact route, that route covers nothing, and the entry published — while
// the catch-all in between had taken every id the third could carry.
//
// Both arms, because the refutation is half the result: the same cascade with a
// `claude-*` predecessor leaves the third route LIVE (it still receives
// `fable-experimental`), and hiding it would be the opposite error.
test('a route left dead by a catch-all publishes nothing; one still reachable publishes', () => {
  const now = Date.now();
  const build = middle => {
    const am = fleet({
      accounts: ['a', 'b', 'c'],
      routes: [
        { name: 'exact', match: ['claude-fable-5'], accounts: ['a'] },
        { name: 'broad', match: [middle], accounts: ['b'] },
        { name: 'third', match: ['*fable*'], accounts: ['c'] },
      ],
    });
    for (const i of [0, 1, 2]) {
      quota(am, i, { unified5h: 0.05 + i * 0.05, unified7d: 0.2 + i * 0.1,
        unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H });
    }
    return am;
  };

  const dead = build('*');
  assert.equal(dead._routeForModel('fable-experimental').name, 'broad',
    'the premise: the catch-all takes every id the third route could carry');
  assert.deepEqual(dead.getStatus().routing.filter(e => e.route === 'third'), [],
    'a route that can receive nothing advertises a destination');

  const live = build('claude-*');
  assert.equal(live._routeForModel('fable-experimental').name, 'third',
    'the premise: this predecessor leaves the third route reachable');
  assert.equal(live.getStatus().routing.filter(e => e.route === 'third').length, 1,
    'a route that still carries traffic was hidden');
});

test('a glob naming no metered family stays one scope on the shared bucket', () => {
  const now = Date.now();
  const entries = familyFleet(now, [{ name: 'other', match: ['gpt-*'] }])
    .getStatus().routing.filter(e => e.route === 'other');
  assert.equal(entries.length, 1, 'a glob that names no family was split per family anyway');
  assert.equal(entries[0].bucket, 'unified7d');
});

test('a family an earlier route captures is not claimed by a later one', () => {
  // Routes match in order, so `*fable*` above `claude-*` takes Fable with it.
  // An entry for a family this route never receives claims a destination for
  // traffic that goes somewhere else entirely.
  const now = Date.now();
  const routes = [{ name: 'fable', match: ['*fable*'] }, { name: 'broad', match: ['claude-*'] }];
  const report = familyFleet(now, routes).getStatus().routing;

  assert.deepEqual(report.filter(e => e.route === 'broad').map(e => e.model),
    ['claude-opus-4-5', 'claude-sonnet-4-6'],
    'the broad route claims a family the fable route receives');
  assert.deepEqual(report.filter(e => e.route === 'fable').map(e => e.bucket), ['unified7dFable'],
    'the premise: the earlier route is the one reporting Fable');
});

test('two routes sharing a name each carry their own metadata and target', () => {
  // Route names are not unique. A consumer joining an entry back to routes[] by
  // name attaches this decision to another route's globs and another route's
  // target, so the entry carries its own.
  const now = Date.now();
  const am = fleet({
    accounts: ['a', 'b', 'c'],
    routes: [
      { name: 'dup', match: ['*fable*'], accounts: ['b'] },
      { name: 'dup', match: ['*sonnet*'], accounts: ['c'] },
    ],
  });
  for (const i of [0, 1, 2]) {
    quota(am, i, {
      unified5h: 0.05 + i * 0.1, unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H,
      unified7dSonnet: 0.1 + i * 0.1, unified7dSonnetReset: now + (25 + i * 10) * H,
    });
  }
  const entries = am.getStatus().routing.filter(e => e.route === 'dup');

  assert.equal(entries.length, 2, 'the premise: both same-named routes are reported');
  const fable = entries.find(e => e.bucket === 'unified7dFable');
  const sonnet = entries.find(e => e.bucket === 'unified7dSonnet');
  assert.deepEqual(fable.match, ['*fable*']);
  assert.deepEqual(sonnet.match, ['*sonnet*']);
  assert.equal(fable.target, 'b', 'the fable entry carries the other route\'s target');
  assert.equal(sonnet.target, 'c', 'the sonnet entry carries the other route\'s target');
});

test('a manual route pin is what the entry reports, not the load winner', () => {
  // `_selectRoute` skips the session-distribution path entirely when a pin is
  // set, so a pin beats load ranking whether or not distribution is on. An
  // entry reporting only the pick would name an account routing will not use.
  const now = Date.now();
  for (const distributeSessions of [false, true]) {
    const am = fleet({
      accounts: ['a', 'b', 'c'],
      routes: [{ name: 'fable', match: ['*fable*'] }],
      distributeSessions,
    });
    for (const i of [0, 1, 2]) {
      quota(am, i, {
        unified5h: 0.05 + i * 0.1, unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H,
      });
    }
    assert.equal(am.distributeSessions, distributeSessions,
      'the premise: the fixture actually applied the distribution flag');
    assert.equal(am.setRoutePin('fable', 2).ok, true, 'the premise: the pin was accepted');
    const entry = am.getStatus().routing.find(e => e.route === 'fable');

    assert.equal(entry.pinnedTo, 'c', `distribute=${distributeSessions}: the pin is not reported`);
    assert.equal(entry.target, 'c', `distribute=${distributeSessions}: the target ignores the pin`);
    assert.notEqual(entry.pick.account, 'c',
      'the premise: the load ranking would have chosen someone else, so the two answers differ');
  }
});

test('a status poll cannot change the account the next request selects', () => {
  // THE CLAIM: reading `/teamclaude/status` is free of routing consequence. A
  // poll can happen at any frequency, from a dashboard, a scrape or a person
  // pressing a key, and none of it may move traffic. A read that changes where
  // the next request goes is a read nobody can afford to automate.
  //
  // This is the evidence for that claim rather than an assertion of it, and it
  // is the answer to upstream issue #177's question about whether the status
  // endpoint is side-effect free. The honest form of the answer is: polling is
  // idempotent with respect to routing, demonstrated by two fleets that differ
  // in nothing but whether they were read.
  //
  // HOW IT DEMONSTRATES THAT. Two identical fleets. One is polled before the
  // request path runs, one is not. If reading has no consequence they must
  // select the same account, so a difference between the arms IS the defect —
  // which is why the assertion is on the selected account and not on any
  // internal field.
  //
  // The fleet is built so the arms have something to disagree about. One
  // account's five-hour window has already reset; that reset is an event which
  // moves the current account, so it is worth stealing and its theft is
  // visible. Without it both arms would agree for a reason unrelated to the
  // property, and the test would pass while proving nothing.
  const now = Date.now();
  const identicalFleet = () => {
    const am = fleet({ accounts: ['incumbent', 'resetting'] });
    am.accounts[0].quota = { ...am.accounts[0].quota,
      unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 300 * H };
    // Five-hour window already past its reset, weekly expiring much sooner than
    // the incumbent's: the account the reset event should move traffic to.
    am.accounts[1].quota = { ...am.accounts[1].quota,
      unified5h: 0.99, unified5hReset: now - 60_000, unified7d: 0.3, unified7dReset: now + 10 * H };
    return am;
  };

  const neverRead = identicalFleet();
  assert.ok(neverRead.accounts[1].quota.unified5hReset < now,
    'the premise: there is a reset event for a poll to consume, or both arms agree for free');
  neverRead.refreshExpiredQuotas();
  const selectedWithoutAnyPoll = neverRead.accounts[neverRead.currentIndex].name;

  const readFirst = identicalFleet();
  readFirst.getStatus();
  readFirst.refreshExpiredQuotas();
  const selectedAfterAPoll = readFirst.accounts[readFirst.currentIndex].name;

  assert.equal(selectedWithoutAnyPoll, 'resetting',
    'the premise: unread, the reset event moves the selected account, so there is a change to lose');
  assert.equal(selectedAfterAPoll, selectedWithoutAnyPoll,
    'reading the status changed the account the next request selects');
});

test('an observer answers with the state the request path would see', () => {
  // Not consuming the event is half of it. The other half is that the answer
  // must still be the one the request path gets: an observer that skips the
  // clear and then reads the UNCLEARED window reports an account as
  // five-hour-spent when its window has in fact reset, which is a wrong report
  // rather than a stolen event, and no destination changes so nothing else here
  // would catch it.
  const now = Date.now();
  const am = fleet({ accounts: ['incumbent', 'resetting'] });
  quota(am, 0, { unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 300 * H });
  quota(am, 1, { unified5h: 0.99, unified5hReset: now - 60_000, unified7d: 0.3, unified7dReset: now + 10 * H });

  const entry = am.getStatus().routing.find(e => e.scope === 'shared');
  assert.equal(am.accounts[1].quota.unified5h, 0.99, 'the premise: the read did not clear the window');
  assert.ok(!entry.band.excluded.some(x => x.account === 'resetting'),
    'the report calls an account spent whose five-hour window has already reset');
  assert.equal(entry.band.candidates, 2, 'the reset account is missing from the candidate set');
});

// THE OBSERVATION'S CLOCK IS THE CALLER'S, and that is the half the fixture
// above cannot see, because it observes at the wall clock so the two agree. A
// helper that re-projects per question would have to pick a clock, and the only
// one available to it is `Date.now()` — so asked at an INJECTED `now`, it would
// answer about a different moment than the fleet was projected at, which is the
// self-contradicting state `_observedFleet` exists to prevent. Found by a
// neutralisation sweep: re-adding the per-question projection to `_quotaBar`
// changed nothing, since every fixture observed at the wall clock.
test('a report answers at the clock it was asked with, not at the wall clock', () => {
  const asked = Date.now() - 5 * 60_000;
  const am = fleet({ accounts: ['ample', 'expiring'] });
  quota(am, 0, { unified5h: 0.2, unified5hReset: asked + 2 * H, unified7d: 0.3, unified7dReset: asked + 300 * H });
  // Spent, with a window that reset BETWEEN the asked-for moment and now: still
  // spent at `asked`, already reset at the wall clock. One account, two answers,
  // and only the caller's clock chooses.
  quota(am, 1, { unified5h: 0.99, unified5hReset: asked + 60_000, unified7d: 0.3, unified7dReset: asked + 10 * H });
  assert.ok(am.accounts[1].quota.unified5hReset < Date.now(),
    'the premise: the window has expired by the wall clock');
  assert.ok(am.accounts[1].quota.unified5hReset > asked,
    'the premise: it has NOT expired at the moment being asked about');

  const entry = am.getStatus(asked).routing.find(e => e.scope === 'shared');
  assert.ok(entry.band.excluded.some(x => x.account === 'expiring' && x.reason === 'five-hour-spent'),
    'the report answered about a later moment than it was asked about');
  assert.equal(entry.band.candidates, 1, 'the spent account entered the band anyway');
});

test('a route preview does not consume the event either', () => {
  // `_routeTarget` runs the preview for every route scope, and the preview
  // consults a manual pin and can fall through to a full pick — both of which
  // asked availability. The shared scope alone does not reach either path, so a
  // fleet with a route and a pin is what exercises them.
  const now = Date.now();
  const am = fleet({
    accounts: ['incumbent', 'resetting'],
    routes: [{ name: 'fable', match: ['*fable*'] }],
  });
  quota(am, 0, {
    unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 300 * H,
    unified7dFable: 0.2, unified7dFableReset: now + 40 * H,
  });
  quota(am, 1, {
    unified5h: 0.99, unified5hReset: now - 60_000, unified7d: 0.3, unified7dReset: now + 10 * H,
    unified7dFable: 0.2, unified7dFableReset: now + 30 * H,
  });
  assert.equal(am.setRoutePin('fable', 1).ok, true, 'the premise: the pin routes the preview at the reset account');
  // The current account is out, so the preview also falls through to a pick.
  am.accounts[0].disabled = true;

  const status = am.getStatus();
  assert.ok(status.routing.some(e => e.route === 'fable'), 'the premise: the route scope is reported');
  assert.equal(am.accounts[1].quota.unified5h, 0.99,
    'the route preview consumed the session-reset event while answering a display');
});

test('a requalifying current account is reported as the account traffic leaves', () => {
  // `_select` re-ranks unconditionally when the current account carries
  // `requalify`, and the preview had no such branch — so the block named the
  // account the next request would leave.
  //
  // Not an exotic flag: accounts are constructed `probing`, and `applyUsageData`
  // sets `requalify` the moment a weekly window is learned, which the prober
  // does to every account. A freshly started fleet carries it everywhere until a
  // plain request consumes it, and an idle fleet is when someone runs `status`.
  //
  // THE FIXTURE HAS THE CURRENT ACCOUNT ADMITTED, deliberately. The other shape
  // — current account held out of the band — puts `; not in the admitted set` on
  // the row, and a fix keying off that qualifier would go green while this shape
  // stayed broken. Here nothing on the line hints at anything.
  const now = Date.now();
  const build = () => {
    const am = fleet({ accounts: ['a', 'b', 'c'] });
    quota(am, 0, { unified5h: 0.08, unified5hReset: now + 2 * H, unified7d: 0.15, unified7dReset: now + 25 * H });
    quota(am, 1, { unified5h: 0.05, unified5hReset: now + 2 * H, unified7d: 0.1, unified7dReset: now + 20 * H });
    // Its five-hour window has already reset. Nothing in this test is about that
    // account, but the requalify branch walks every account to re-rank, so a
    // projection that forgot to observe would clear it here — and the flag being
    // read is not the only thing an observer can consume.
    quota(am, 2, { unified5h: 0.9, unified5hReset: now - 60_000, unified7d: 0.9, unified7dReset: now + 500 * H });
    am.setCurrentAccount(0);
    am.accounts[0].requalify = true;
    return am;
  };

  const observed = build();
  const entry = observed.getStatus().routing.find(e => e.scope === 'shared');
  assert.ok(entry.band.admitted.includes('a'),
    'the premise: the current account IS admitted, so no qualifier hints at the divergence');

  // What a request actually gets, on a fresh manager with the same fixture.
  const served = build().getActiveAccount(null, null, null, null, {});
  assert.equal(served.name, 'b', 'the premise: requalification moves the request off the current account');
  assert.equal(entry.target, served.name,
    'the block names the account the next request leaves rather than the one it reaches');

  // And the observer still does not consume the flag it read.
  assert.equal(observed.accounts[0].requalify, true,
    'reading the status consumed the requalification the request path owns');
  assert.equal(observed.accounts[2].quota.unified5h, 0.9,
    'the re-rank walked every account and cleared an expired window while observing');
});

test('the report names accounts and never a session id', () => {
  const now = Date.now();
  const am = ladderFleet(now);
  am.recordSession('session-abc-123', 0, 'claude-opus-5');
  const json = JSON.stringify(am.getStatus().routing);

  assert.ok(!json.includes('session-abc-123'), 'a client-supplied session id reached the payload');
  for (const entry of am.getStatus().routing) {
    for (const row of entry.band.ladder) {
      assert.equal(typeof row.account, 'string');
      assert.ok(am.accounts.some(a => a.name === row.account), 'a ladder row names no known account');
    }
  }
});
