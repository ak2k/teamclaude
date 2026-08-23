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
