import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { renderStatus, ruleCaption } from '../src/status-renderer.js';

// The compact Decision block. Every assertion below drives the real renderer
// over a real `getStatus()` payload rather than checking a formatter in
// isolation: round 2 shipped a test that recomputed the rule it was checking and
// stayed green with the fix reverted, and the difference was that it never
// rendered anything.

const H = 3600e3;
const acct = name => ({ name, type: 'apikey', apiKey: `k-${name}` });

function render(am, now) {
  return renderStatus(am.getStatus(), { color: false, now }).split('\n');
}
const row = (lines, label) => lines.find(l => l.trim().startsWith(label));

function sizedFleet(now) {
  const am = new AccountManager(['a', 'b', 'c', 'd'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  q(0, { unified5h: 0.05, unified7d: 0.1, unified7dReset: now + 20 * H });
  q(1, { unified5h: 0.15, unified7d: 0.3, unified7dReset: now + 40 * H });
  q(2, { unified5h: 0.3, unified7d: 0.6, unified7dReset: now + 500 * H });
  q(3, { unified5h: 0.99 });
  return am;
}

test('the block answers first and gives the rule last', () => {
  const now = Date.now();
  const lines = render(sizedFleet(now), now);
  const start = lines.findIndex(l => l.startsWith('Decision'));
  assert.ok(start >= 0, 'no Decision block rendered; every assertion below would assert nothing');

  // Labels only, in the order they appear. A row's label is its leading words,
  // which for `New session` is followed by a single space and an arrow rather
  // than by the column gap every other row uses.
  const LABELS = ['New session', 'Next request', 'Band', 'Admit', 'Spare', 'Skipped', 'Rule'];
  const order = lines.slice(start)
    .map(l => LABELS.find(label => l.trim().startsWith(label)))
    .filter(Boolean);
  assert.deepEqual(order.slice(0, 3), ['New session', 'Next request', 'Band'],
    'the block opens with something other than the two destinations and the summary');
  assert.ok(order.indexOf('Rule') > order.indexOf('Admit'),
    'the caption precedes its own evidence');
});

test('the band row states achieved against target and where admission stopped', () => {
  const now = Date.now();
  const lines = render(sizedFleet(now), now);
  const band = row(lines, 'Band');

  assert.match(band, /sized/);
  // The `x` is load-bearing: `1.796 of 1.0` implies a portion, and 1.796 is not
  // a portion of 1.0, so it reads as the same N-of-M alarm the figure is not.
  assert.match(band, /1\.796x the 1\.0 target/);
  assert.match(band, /met at p2/, 'the stop point is not stated, so the ladder has no marker to check');
  assert.match(band, /2 of 3 candidates/);
});

test('a target crossed on an unranked row is not reported as unmet', () => {
  // The exemption admits an absent-pressure row that the sort could not order,
  // so the row carrying the total past the target has rank null. Deriving "was
  // it met" from "which rank met it" read that null as never-reached and
  // printed the denial next to the evidence.
  const now = Date.now();
  const am = new AccountManager(['ranked', 'exempt'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  // headroom = (0.98 - unified5h) / 0.98, so 0.4 and 0.8 of the target
  am.accounts[0].quota = {
    ...am.accounts[0].quota,
    unified5h: 0.98 * 0.6, unified5hReset: now + 2 * H,
    unified7d: 0.5, unified7dReset: now + 40 * H,
  };
  // No reset: pressure absent, sorts last, admitted by the exemption
  am.accounts[1].quota = {
    ...am.accounts[1].quota,
    unified5h: 0.98 * 0.2, unified5hReset: now + 2 * H,
    unified7d: 0.5, unified7dReset: null,
  };

  const entry = am.getStatus().routing.find(e => e.scope === 'shared');
  const crossing = entry.band.ladder.find(r => r.cumulative != null && r.cumulative >= entry.band.target);
  assert.ok(entry.band.achieved >= entry.band.target, 'the premise: the target IS reached');
  assert.equal(crossing.rank, null, 'the premise: the row that crossed it has no rank');

  const band = row(render(am, now), 'Band');
  assert.doesNotMatch(band, /target not met/,
    'the line denies a target its own figure exceeds');
  assert.match(band, /met at p-/,
    'the crossing row has no ordinal, so the marker must point at p- rather than invent one');
});

test('a target genuinely not reached still says so', () => {
  // The other side of the split: `target not met` must remain reachable, or the
  // fix above would have replaced one wrong answer with the opposite one.
  const now = Date.now();
  const am = new AccountManager(['a', 'b'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 3, tolerance: 1.5 } });
  am.accounts[0].quota = {
    ...am.accounts[0].quota,
    unified5h: 0.5, unified5hReset: now + 2 * H, unified7d: 0.1, unified7dReset: now + 20 * H,
  };
  am.accounts[1].quota = {
    ...am.accounts[1].quota,
    unified5h: 0.6, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 40 * H,
  };

  const entry = am.getStatus().routing.find(e => e.scope === 'shared');
  assert.ok(entry.band.achieved < entry.band.target, 'the premise: the target is NOT reached');

  const band = row(render(am, now), 'Band');
  assert.match(band, /target not met/);
  assert.doesNotMatch(band, /met at p/, 'an unmet target reported a crossing rank');
});

test('capacity figures carry three decimals', () => {
  // `achieved >= coverage` is evaluated raw, so a coarser display can show a
  // target met while admission continues.
  const now = Date.now();
  const lines = render(sizedFleet(now), now);
  const admit = lines.filter(l => /\+\d/.test(l));
  assert.ok(admit.length >= 2);
  for (const line of admit) {
    assert.match(line, /\+\d\.\d{3}\b/, `two decimals or fewer in: ${line.trim()}`);
  }
});

test('the printed contributions add up to the published total', () => {
  // `+x` claims this row's headroom is inside `achieved`. A lower-tier account
  // is appended wholesale and never enters the coverage walk, so printing `+`
  // for it made three rows sum to 2.541 on a fleet whose achieved was 1.796.
  const now = Date.now();
  const am = new AccountManager(
    [acct('a'), acct('b'), { name: 'lower', type: 'apikey', apiKey: 'k-lower', priority: 1 }], 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  am.accounts.forEach((x, i) => {
    x.quota = {
      ...x.quota, unified5h: 0.05 + i * 0.1, unified5hReset: now + 2 * H,
      unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
    };
  });
  const status = am.getStatus();
  const entry = status.routing.find(e => e.scope === 'shared');
  assert.ok(entry.band.ladder.some(r => r.reason === 'lower-tier' && r.headroom.kind === 'known'),
    'the premise: a lower-tier row with a known headroom is in the ladder');

  const lines = renderStatus(status, { color: false, now }).split('\n');
  const contributions = lines.filter(l => /\+\d/.test(l)).map(l => Number(l.match(/\+([\d.]+)/)[1]));
  assert.ok(contributions.length >= 2, 'no contributions printed, so nothing is being checked');
  const sum = contributions.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - entry.band.achieved) < 5e-4,
    `printed contributions sum to ${sum.toFixed(3)} against an achieved of ${entry.band.achieved.toFixed(3)}`);
  assert.match(lines.find(l => /\blower\b/.test(l) && /p-/.test(l)), /p-\s+0\.\d{3}\s+lower/,
    'the lower-tier row claims a contribution the coverage total never took');
});

test('the ladder renders in the order the band walked it', () => {
  // The ladder is a SEQUENCE — that is the whole reason it is published rather
  // than recomputed. An account admitted by the exemption sorts LAST, after
  // coverage was already met, so grouping the admitted rows above the held ones
  // lifted it above a row the walk reached first and printed an admission order
  // that did not happen.
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'held', 'exempt'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  q(0, { unified5h: 0.05, unified5hReset: now + 2 * H, unified7d: 0.1, unified7dReset: now + 20 * H });
  q(1, { unified5h: 0.15, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 40 * H });
  q(2, { unified5h: 0.3, unified5hReset: now + 2 * H, unified7d: 0.6, unified7dReset: now + 200 * H });
  // No reset: absent pressure, so it sorts last and is admitted by the exemption
  // AFTER the held row — the interleaving a partition cannot represent.
  q(3, { unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.4, unified7dReset: null });

  const status = am.getStatus();
  const walk = status.routing.find(e => e.scope === 'shared').band.ladder;
  const heldIndex = walk.findIndex(r => !r.admitted);
  assert.ok(heldIndex >= 0 && walk.slice(heldIndex).some(r => r.admitted),
    'the premise: an admitted row comes AFTER a held one, or grouping cannot reorder anything');

  const lines = renderStatus(status, { color: false, now }).split('\n');
  const names = am.accounts.map(a => a.name);
  const rendered = lines
    .slice(lines.findIndex(l => l.startsWith('Decision')))
    .filter(l => /\bp(\d+|-)\s/.test(l))
    .map(l => names.find(n => new RegExp(`\\b${n}\\b`).test(l)))
    .filter(Boolean);

  assert.deepEqual(rendered, walk.map(r => r.account),
    'the block prints the ladder in an order the band never performed');
});

test('a held account prints its capacity without a plus sign', () => {
  const now = Date.now();
  const lines = render(sizedFleet(now), now);
  const spare = lines.findIndex(l => l.trim().startsWith('Spare'));
  assert.ok(spare > 0, 'no Spare row, so the held account is invisible');
  assert.match(lines[spare], /not needed; covered at p2/);
  assert.match(lines[spare + 1], /p3\s+0\.694\s+c/);
  assert.ok(!lines[spare + 1].includes('+'),
    'a held row prints a contribution, claiming capacity the band did not take');
});

test('an account the band never saw is named with the reason it was skipped', () => {
  const now = Date.now();
  const lines = render(sizedFleet(now), now);
  const skipped = row(lines, 'Skipped');
  assert.ok(skipped, 'the spent account is in neither list, so the block describes a smaller fleet');
  assert.match(skipped, /five-hour-spent/);
  assert.match(skipped, /\bd\b/);
  assert.match(skipped, /unified5h 0\.990/);
});

test('a blocked family does not get to be the scope the block reports', () => {
  // The blocklist is answered at the server with a 400 before selection runs,
  // so a blocked family is not somewhere the next request can go. Reporting its
  // band answered "where does traffic land" for traffic that never lands, on
  // the same screen as the Blocked row saying it is refused.
  const now = Date.now();
  const am = sizedFleet(now);
  for (const [i, o] of [[0, 0.1], [1, 0.3], [2, 0.6]]) {
    am.accounts[i].quota = {
      ...am.accounts[i].quota, unified7dFable: o, unified7dFableReset: now + (30 + i * 10) * H,
    };
  }
  const status = { ...am.getStatus(), blockedModels: ['*fable*'] };
  const fable = status.routing.find(e => e.model && /fable/.test(e.model));
  assert.ok(fable, 'the premise: a fable scope exists');
  assert.notEqual(fable.band.kind, 'passthrough',
    'the premise: it decided something, so it would otherwise win the block');

  const lines = renderStatus(status, { color: false, now }).split('\n');
  const header = lines.find(l => l.startsWith('Decision'));
  assert.ok(header, 'no block rendered at all');
  assert.doesNotMatch(header, /fable/,
    'the block is scoped to a family the server refuses before selection');
  assert.match(row(lines, 'Other scopes') || '', /fable[^,]*: blocked/,
    'the other-scopes line names its band variant, describing a decision about refused traffic');
});

// ONE SCREEN, ONE CLASSIFICATION. The Decision block, the Routing line and the
// per-account Models row each answered the blocklist their own way — a scope's
// model, a glob overlap, a family name — so a concrete id rendered a live Fable
// decision above a Routing line calling that route blocked and a Models row
// calling the family blocked. The three are held to each other here rather than
// to a fixed string, because which of them is right is not what an operator
// cannot act on: a screen contradicting itself is.
test('every section agrees about what the blocklist does to a family', () => {
  const now = Date.now();
  const build = () => {
    const am = sizedFleet(now);
    for (const [i, o] of [[0, 0.1], [1, 0.3], [2, 0.6]]) {
      am.accounts[i].quota = {
        ...am.accounts[i].quota, unified7dFable: o, unified7dFableReset: now + (30 + i * 10) * H,
      };
    }
    return am;
  };

  // Three blocklists reaching the Fable route three different ways, and one
  // reaching it not at all. `claude-fable-5` is the id the report publishes as
  // the family's representative and `claude-fable-4` is deliberately not: a
  // fixture using only the representative agrees with any of the three rules by
  // coincidence, which is how this survived one fix already.
  // `claude-fable-5` read `blocked` here for a whole pass, and this table is
  // where it was written down: the D fix made three sections agree and I
  // asserted the agreement without asking whether the answer they agreed on was
  // true. It was not — the route still carries `claude-fable-4` and every dated
  // variant of `claude-fable-5` itself. A consistency check cannot tell you
  // which of "consistent" and "correct" you got, so the expected values here
  // are now derived from what the route would actually still serve.
  const CASES = [
    ['*fable*', 'blocked'],
    ['claude-fable-5', 'partly'],
    ['claude-fable-4', 'partly'],
    ['*opus*', 'clear'],
  ];
  const seen = new Set();

  for (const [pattern, expected] of CASES) {
    const status = { ...build().getStatus(), blockedModels: [pattern] };
    const fableScope = status.routing.find(e => e.model && /fable/.test(e.model));
    assert.ok(fableScope, `${pattern}: the premise: a fable scope exists to be classified`);
    assert.notEqual(fableScope.band.kind, 'passthrough',
      `${pattern}: the premise: it decided something, so it would otherwise win the block`);

    const lines = renderStatus(status, { color: false, now }).split('\n');
    const header = lines.find(l => l.startsWith('Decision')) || '';
    const others = row(lines, 'Other scopes') || '';
    const routing = lines.find(l => l.trim().startsWith('*fable*')) || '';
    const models = row(lines, 'Models') || '';
    assert.ok(routing, `${pattern}: no Routing line for the fable route`);
    assert.ok(models, `${pattern}: no Models row, so the family cell is not being compared`);
    seen.add(expected);

    if (expected === 'blocked') {
      assert.doesNotMatch(header, /fable/, `${pattern}: the block reports a scope the server refuses`);
      assert.match(others, /fable[^,]*: blocked/, `${pattern}: the other-scopes line does not say blocked`);
      assert.match(routing, /→ blocked/, `${pattern}: the routing line still lists accounts`);
      assert.match(models, /Fable ⊘ blocked/, `${pattern}: the family cell disagrees with the routing line`);
    } else if (expected === 'partly') {
      // Traffic still flows, so the destination rows are real and must be shown.
      assert.match(header, /fable/, `${pattern}: a route that still carries traffic lost its block`);
      assert.match(routing, /partly blocked/, `${pattern}: the routing line calls a partial block total`);
      assert.doesNotMatch(routing, /→ blocked/, `${pattern}: the route is not fully blocked`);
      assert.match(models, /Fable [^⊘]*partly blocked/,
        `${pattern}: the family cell calls a single blocked id the whole family`);
    } else {
      assert.match(header, /fable/, `${pattern}: an untouched route lost its block`);
      assert.doesNotMatch(routing, /blocked/, `${pattern}: the routing line blocks an untouched route`);
      assert.doesNotMatch(models, /Fable [^ ]* partly blocked/,
        `${pattern}: the family cell reports a block that does not reach it`);
    }
  }

  assert.equal(seen.size, 3, 'the cases collapsed to fewer than three states, so they grade less than they read');
});

test('with distribution off the block does not name a destination routing would not choose', () => {
  // `_selectForSession` is never reached when distributeSessions is false — the
  // default — so a new session follows the current account. Naming the pick's
  // load winner reported a destination the router would not choose.
  const now = Date.now();
  const am = sizedFleet(now);
  // Make the current account the LOAD LOSER, so the pick names someone else and
  // the two answers actually differ. With every account idle they agree and the
  // assertion says nothing.
  am.recordSession('s1', 0, 'claude-opus-5');
  am.recordTokenUsage(0, 's1', 'claude-opus-5', {
    input_tokens: 0, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0, output_tokens: 0,
  });
  const status = am.getStatus();
  assert.equal(status.sessions.distribute, false, 'the premise: distribution is off');
  const entry = status.routing.find(e => e.scope === 'shared');
  assert.notEqual(entry.pick.account, status.currentAccount,
    'the premise: the pick names someone other than the current account');

  // The block must name the account the ROUTER returns, not restate a rule.
  // Saying "follows the current account" was true of the rule and false of the
  // fleet whenever the current account was disabled or otherwise ineligible.
  const entry2 = status.routing.find(e => e.scope === 'shared');
  const line = row(renderStatus(status, { color: false, now }).split('\n'), 'New session');
  assert.match(line, new RegExp(`→ ${entry2.target}\\b`),
    'the row does not name what the routing preview returns');
  assert.match(line, /distribution off; not load-ranked/,
    'the row credits load ranking on a path where load did not rank anything');
});

test('a route pin is what the block names, even with distribution on', () => {
  // `_selectRoute` skips the session path entirely when a pin is set, so the
  // pick describes a ranking that never runs. With distribution OFF the block
  // would name the target anyway; only distribution ON separates the two, which
  // is why this asserts the flag it depends on.
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'c'].map(acct), 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'fable', match: ['*fable*'] }],
    distributeSessions: true,
  });
  am.accounts.forEach((x, i) => {
    x.quota = {
      ...x.quota, unified5h: 0.05 + i * 0.1, unified5hReset: now + 2 * H,
      unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H,
    };
  });
  assert.equal(am.distributeSessions, true, 'the premise: distribution is on');
  assert.equal(am.setRoutePin('fable', 2).ok, true, 'the premise: the pin was accepted');
  const status = am.getStatus();
  const entry = status.routing.find(e => e.route === 'fable');
  assert.notEqual(entry.pick.account, 'c',
    'the premise: load ranking would choose someone else, so the two answers differ');

  const line = row(renderStatus(status, { color: false, now }).split('\n'), 'New session');
  assert.match(line, /→ c\b/, 'the block names the load winner over a pin routing will honour');
  assert.match(line, /route pin/, 'the block credits a term when a pin decided');
});

test('a pin that fell through names the destination the router chose, not the pick', () => {
  // `_selectRoute:421` skips the session-distribution path whenever a pin is set
  // for this scope — EXISTENCE, not eligibility. So while any pin is set, a new
  // session goes wherever the router's own order sends it and no pick term
  // applies. The block must therefore name `entry.target` and must not credit a
  // term, while still disclosing that the pin did not act.
  //
  // THE FIXTURE MAKES THE TWO CANDIDATE DESTINATIONS DIFFER. An earlier version
  // had the current account as both the router's choice AND the load-ranked
  // winner, so `target === pick.account` and every assertion passed whichever
  // one the code printed. Here `current` is usable but its weekly window is
  // furthest out, so the pick names someone else.
  const now = Date.now();
  const build = pinnedHealthy => {
    const am = new AccountManager(['current', 'ranked', 'third', 'pinned'].map(acct), 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
      routes: [{ name: 'fable', match: ['*fable*'] }],
      distributeSessions: true,
    });
    const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
    q(0, { unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.8, unified7dReset: now + 400 * H,
      unified7dFable: 0.8, unified7dFableReset: now + 400 * H });
    q(1, { unified5h: 0.05, unified5hReset: now + 2 * H, unified7d: 0.1, unified7dReset: now + 20 * H,
      unified7dFable: 0.1, unified7dFableReset: now + 20 * H });
    q(2, { unified5h: 0.1, unified5hReset: now + 2 * H, unified7d: 0.2, unified7dReset: now + 30 * H,
      unified7dFable: 0.2, unified7dFableReset: now + 30 * H });
    q(3, { unified5h: pinnedHealthy ? 0.1 : 0.99, unified5hReset: now + 2 * H,
      unified7d: 0.3, unified7dReset: now + 40 * H,
      unified7dFable: 0.3, unified7dFableReset: now + 40 * H });
    am.setCurrentAccount(0);
    assert.equal(am.setRoutePin('fable', 3).ok, true, 'the premise: the pin was accepted');
    return am;
  };

  const status = build(false).getStatus();
  const entry = status.routing.find(e => e.route === 'fable');
  assert.equal(entry.pinnedTo, 'pinned', 'the premise: a pin is set');
  assert.notEqual(entry.target, 'pinned', 'the premise: it did not win');
  assert.notEqual(entry.target, entry.pick.account,
    'the premise: the two candidate destinations differ, or this cannot tell them apart');

  // What a new session actually gets, on a fresh manager.
  const served = build(false).getActiveAccount(null, 'claude-fable-5', null, 'sess-1', {});
  assert.equal(served.name, entry.target,
    'the premise: with a pin set, the session path is skipped and the router decides');

  const newSession = row(renderStatus(status, { color: false, now }).split('\n'), 'New session');
  assert.match(newSession, new RegExp(`→ ${entry.target}\\b`),
    'the block names the load-ranked winner on a fleet where load ranking never ran');
  assert.doesNotMatch(newSession, /by \w+/,
    'a pick term is credited, and no pick term applied');
  assert.match(newSession, /pin to pinned is not eligible/,
    'a pin the operator set vanished from the block, which reads as no pin at all');

  // Control: the same fixture with the pinned account healthy. Without it these
  // assertions pass for a block that never credits a pin at all.
  const honoured = build(true).getStatus();
  const honouredEntry = honoured.routing.find(e => e.route === 'fable');
  assert.equal(honouredEntry.target, 'pinned');
  // The control needs the same premise the main case does: if the healthy pin
  // also won the load ranking, this arm would be satisfied by a block that
  // ignored the pin entirely and printed the pick.
  assert.notEqual(honouredEntry.target, honouredEntry.pick.account,
    'the honoured pin is also the load-ranked winner, so this control cannot tell '
    + 'a credited pin from an ignored one');
  assert.match(row(renderStatus(honoured, { color: false, now }).split('\n'), 'New session'),
    /→ pinned .*route pin/,
    'an honoured pin is not credited, so the block cannot distinguish the two cases');
});

test('a block for one of two same-named routes shows its own globs', () => {
  // Route names are not unique, so a renderer joining the entry back to routes[]
  // by name labels this decision with another route's globs. The fable route is
  // restricted to one account so it passes through and the block reports the
  // sonnet route — whose label a name-join would get wrong.
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'c'].map(acct), 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [
      { name: 'dup', match: ['*fable*'], accounts: ['b'] },
      { name: 'dup', match: ['*sonnet*'], accounts: ['b', 'c'] },
    ],
  });
  am.accounts.forEach((x, i) => {
    x.quota = {
      ...x.quota, unified5h: 0.05 + i * 0.1, unified5hReset: now + 2 * H,
      unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H,
      unified7dSonnet: 0.1 + i * 0.1, unified7dSonnetReset: now + (25 + i * 10) * H,
    };
  });
  const status = am.getStatus();
  const fableEntry = status.routing.find(e => e.bucket === 'unified7dFable');
  assert.equal(fableEntry.band.kind, 'passthrough',
    'the premise: the fable scope decides nothing, so the block reports the sonnet one');

  const header = renderStatus(status, { color: false, now }).split('\n').find(l => l.startsWith('Decision'));
  assert.match(header, /\*sonnet\*/, 'the block is labelled with the other same-named route\'s globs');
  assert.doesNotMatch(header, /\*fable\*/);
});

test('a route scope answers Next request with that route, not the current account', () => {
  // The current account can be excluded from the very scope being reported —
  // it appears in that entry's excluded[] as route-excluded — so answering with
  // it contradicted the block's own evidence three lines up.
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'c'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  for (const i of [0, 1, 2]) {
    am.accounts[i].quota = {
      ...am.accounts[i].quota,
      unified5h: 0.05 + i * 0.1, unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H,
    };
  }
  am.setRoutes([{ name: 'fable-only', match: ['*fable*'], accounts: ['b', 'c'] }]);
  const status = am.getStatus();
  const entry = status.routing.find(e => e.route === 'fable-only');
  assert.equal(status.currentAccount, 'a', 'the premise: the current account is a');
  assert.ok(entry.band.excluded.some(x => x.account === 'a' && x.reason === 'route-excluded'),
    'the premise: this scope excluded the current account');

  const lines = renderStatus(status, { color: false, now }).split('\n');
  assert.match(lines.find(l => l.startsWith('Decision')), /fable/, 'the premise: the block reports that scope');
  const line = row(lines, 'Next request');
  assert.doesNotMatch(line, /→ a\b/,
    'the block points at an account it listed as route-excluded on the same screen');
  assert.match(line, /\(would serve now\)/,
    'the row labels another account as the current one');
  assert.ok(entry.band.admitted.includes(line.match(/→ (\S+)/)[1]),
    'the named account is not in the admitted set of the scope it is named under');
});

// TWO RULES ARE OFF ON THE STOCK FLEET and the row spoke about one. Both poles
// are asserted, because the assertion that missed this read `/load-ranked · …/`
// — which the corrected sentence still contains, as `not load-ranked`. A
// substring both wordings satisfy cannot grade either one.
test('expiry routing off collapses to one row instead of a block', () => {
  const now = Date.now();
  const build = (distributeSessions) => {
    const am = new AccountManager(['a', 'b'].map(acct), 0.98, { distributeSessions });
    am.accounts[0].quota = { ...am.accounts[0].quota, unified7d: 0.1, unified7dReset: now + 20 * H };
    return am;
  };
  const lines = render(build(false), now);   // the stock fleet: both rules off

  assert.ok(!lines.some(l => l.startsWith('Decision')),
    'a fleet with the feature off renders a block about a rule that never ran');
  const off = row(lines, 'Selection');
  assert.match(off, /distribution off; not load-ranked · expiry routing off · 2 accounts eligible/);
  assert.doesNotMatch(off, /(^|\s)Selection\s+load-ranked/,
    'the default fleet claimed a ranking that never runs on it');

  // The other pole: with distribution on, load ranking is what happens and the
  // row says so, so the correction is about the state and not a blanket hedge.
  const on = row(render(build(true), now), 'Selection');
  assert.match(on, /^Selection\s+load-ranked · expiry routing off · 2 accounts eligible/);
  assert.doesNotMatch(on, /distribution off/);
});

test('a fully barred fleet says nothing is eligible rather than claiming one account', () => {
  // `decideBand` guards `accounts.length <= 1`, so an EMPTY candidate set
  // arrives at the same `single-candidate` reason a one-account fleet does. A
  // caption that assumed one candidate would assert an eligible account on a
  // fleet that has none, which is the state where the truth matters most.
  const now = Date.now();
  const am = new AccountManager(['a', 'b'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1 } });
  for (const account of am.accounts) account.quota = { ...account.quota, unified5h: 0.99 };
  const lines = render(am, now);

  assert.match(row(lines, 'Selection'), /no eligible account right now/);
});

// NOTHING ELIGIBLE IS NOT NOTHING SERVED, and this round is what made the
// difference visible: the preview learned to name the account the last resort
// reopens, so `target` stopped being null on an exhausted fleet while the
// one-row collapse went on saying nothing was eligible. `Active spent` sat two
// lines above `no eligible account right now` on a fleet serving every request
// from `spent`.
test('the collapsed row names where the next request goes when nothing is under the threshold', () => {
  const now = Date.now();
  const secs = ms => String(Math.floor(ms / 1000));
  const am = new AccountManager([acct('spent'), acct('offline')].map(a => a), 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  // The reachable last-resort state: a five-hour reset with no utilization
  // beside it, which nothing retires, under a weekly over the threshold.
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-reset': secs(now - 30 * 60e3),
    'anthropic-ratelimit-unified-7d-utilization': '0.995',
    'anthropic-ratelimit-unified-7d-reset': secs(now + 100 * H),
  });
  am.accounts[1].disabled = true;
  am.setCurrentAccount(0);

  const status = am.getStatus();
  const shared = status.routing.find(e => e.scope === 'shared');
  assert.equal(shared.band.candidates, 0, 'the premise: nothing is eligible on this fleet');
  assert.equal(shared.target, 'spent', 'the premise: a request is still served, and by whom');

  const line = row(render(am, now), 'Selection');
  assert.ok(line, 'no collapsed row rendered, so nothing is being compared');
  assert.match(line, /reopens spent/,
    'the row says nothing is eligible beside an Active row naming the account every request lands on');
});

// An account that does not meter the scope's family is ranked on the SHARED
// weekly instead. Its pressure and headroom are both known, so the caption's
// "missing either measurement" clause is true and says nothing about it — and a
// reader sees an ordinary rank under a header naming `unified7dFable` and
// concludes the account has a Fable reading. It does not. The payload has said
// which window each row came from since the report was built; the ladder was
// the one row type that never printed it, while `Skipped` beside it always has.
//
// BOTH DIRECTIONS IN ONE RENDER. A fixture where every row differs would pass
// for a renderer that annotates unconditionally, which is a different defect
// wearing the same green.
test('a row measured on another window says so, and the rows on the scope\'s own window do not', () => {
  const now = Date.now();
  const am = new AccountManager([acct('meters-fable'), acct('no-fable-reading'), acct('c')], 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'fable', match: ['*fable*'] }],
  });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  q(0, { unified5h: 0.05, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 300 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 20 * H });
  q(1, { unified5h: 0.1, unified5hReset: now + 2 * H, unified7d: 0.2, unified7dReset: now + 25 * H });
  q(2, { unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.4, unified7dReset: now + 400 * H,
    unified7dFable: 0.5, unified7dFableReset: now + 40 * H });

  const entry = am.getStatus().routing.find(e => e.model && /fable/.test(e.model));
  const odd = entry.band.ladder.find(r => r.account === 'no-fable-reading');
  // The premises: one row genuinely measured elsewhere, and it is NOT an
  // absent-measurement row — the caption's exemption already covers those, and
  // grading this through one would test the note that was already there.
  assert.equal(odd.bucket, 'unified7d', 'the odd row is measured on the scope bucket after all');
  assert.equal(odd.pressure.kind, 'known', 'the odd row is missing a measurement, which is a different claim');
  assert.ok(entry.band.ladder.some(r => r.bucket === entry.bucket),
    'no row is on the scope bucket, so the silent half of this is untested');

  const lines = render(am, now);
  // BY THE RANK MARKER, not by the name: `meters-fable` also appears in the two
  // destination rows above the ladder, and a first-match selector returns one of
  // those — which carries no bucket, so every assertion below passed for a
  // renderer that annotates unconditionally. Measured: that mutation survived
  // until this line selected the row under test instead of the first line
  // mentioning it.
  const rowFor = name => lines.find(l => /\bp(\d+|-)\b/.test(l) && l.includes(name));
  assert.match(rowFor('no-fable-reading'), /unified7d\b/,
    'the row ranked on the shared weekly reads as though it had a Fable window');
  for (const name of ['meters-fable', 'c']) {
    assert.doesNotMatch(rowFor(name), /unified7d/,
      `${name} is on the scope's own window, so naming it turns the exception into a column`);
  }
});

// A ROUTE IS NOT AN ANSWER when it spans families. `claude-*` has one entry per
// family — three buckets, three bands, three destinations — and they rendered as
// `broad: sized, broad: sized` with nothing to tell them apart, under a header
// naming the glob as though the destinations below covered all of it. Threading
// the route fixed WHICH route an entry answers for; this is the other axis,
// aggregation within one route, and it is disclosed rather than closed.
//
// Silent when the route has one entry: a `*fable*` route is already unambiguous
// and a qualifier there would be decoration.
test('a route spanning families says which family each entry is', () => {
  const now = Date.now();
  const build = routes => {
    const am = new AccountManager([acct('a'), acct('b')].map(x => x), 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 }, routes,
    });
    const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
    q(0, { unified5h: 0.05, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 30 * H,
      unified7dFable: 0.1, unified7dFableReset: now + 20 * H,
      unified7dSonnet: 0.2, unified7dSonnetReset: now + 25 * H });
    q(1, { unified5h: 0.1, unified5hReset: now + 2 * H, unified7d: 0.4, unified7dReset: now + 300 * H,
      unified7dFable: 0.5, unified7dFableReset: now + 200 * H,
      unified7dSonnet: 0.6, unified7dSonnetReset: now + 250 * H });
    return am;
  };

  const spanning = build([{ name: 'broad', match: ['claude-*'] }]);
  const entries = spanning.getStatus().routing.filter(e => e.route === 'broad');
  assert.equal(entries.length, 3, 'the premise: one route, several families');
  const lines = render(spanning, now);
  assert.match(lines.find(l => l.startsWith('Decision')), /claude-\* \((opus|sonnet|fable)\)/,
    'the header names the glob alone, so the destinations below claim the whole route');
  const others = row(lines, 'Other scopes');
  assert.match(others, /broad \(\w+\): /, 'two entries of one route render identically');
  assert.doesNotMatch(others, /broad: /, 'an ambiguous label survived');

  // THE SILENT HALF, and it has to be asserted where the qualifier is BUILT.
  // Two single-family routes, so one wins the block and the other appears in
  // `Other scopes` under its own plain name — measured: asserting this on the
  // header alone left "print it unconditionally" alive, because the header
  // builds its qualifier separately from the scope list.
  const single = build([{ name: 'fable', match: ['*fable*'] }, { name: 'sonnet', match: ['*sonnet*'] }]);
  const singleLines = render(single, now);
  const header = singleLines.find(l => l.startsWith('Decision'));
  const singleOthers = row(singleLines, 'Other scopes');
  assert.ok(header.includes('*fable*') || header.includes('*sonnet*'),
    'the premise: a single-family route won the block');
  assert.doesNotMatch(header, /\((fable|sonnet|opus)\)/,
    'an unambiguous route carries a qualifier in the header');
  assert.match(singleOthers, /\b(fable|sonnet): /,
    'the premise: the other single-family route is listed');
  assert.doesNotMatch(singleOthers, /\w+ \((fable|sonnet|opus)\): /,
    'an unambiguous route carries a qualifier in the scope list, so the exception becomes a column');
});

// AN ENTRY ANSWERS FOR A SET, AND THE SET IS NOT ALWAYS UNIFORM. A family is
// one scope only while it routes as one: per-account `models` claims split it,
// and then `claude-fable-5` and `claude-fable-4` are served by different
// accounts while the entry advertises the first as the answer for both.
//
// This is the same axis as a route spanning families, one level in, and it is
// disclosed rather than closed — keying entries on the model id would be the
// representative problem in reverse and would multiply entries by every dated
// variant upstream ships.
//
// Where it lands is the point: splitting a family leaves its entry with one
// candidate, so the entry collapses to passthrough and never wins the block.
// Disclosed only there, it would be disclosed exactly never.
test('a family split by per-account model claims says so where it lands', () => {
  const now = Date.now();
  const build = (claims) => {
    const withClaims = n => (claims
      ? { name: n, type: 'apikey', apiKey: `k-${n}`, models: [`claude-fable-${n === 'five' ? 5 : 4}`] }
      : acct(n));
    const am = new AccountManager([withClaims('five'), withClaims('four')], 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
      routes: [{ name: 'fable', match: ['*fable*'] }],
    });
    am.accounts.forEach((a, i) => {
      a.quota = { ...a.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2, unified7dReset: now + 20 * H,
        unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
    });
    return am;
  };

  // The premise: the two ids of one family genuinely go to different accounts.
  // Paired managers, since each call walks and may settle state.
  assert.equal(build(true).getActiveAccount(null, 'claude-fable-5', null, null, {}).name, 'five');
  assert.equal(build(true).getActiveAccount(null, 'claude-fable-4', null, null, {}).name, 'four');

  const split = build(true);
  const splitEntry = split.getStatus().routing.find(e => e.route === 'fable');
  assert.equal(splitEntry.familySplit, 'model claims',
    'the entry claims one destination for a family its accounts have divided');
  assert.equal(splitEntry.target, 'five', 'the premise: the entry answers for the representative');
  assert.match(row(render(split, now), 'Other scopes'), /fable: [^,]+, split by model claims/,
    'the split is invisible where it actually appears, which is the scope list');

  // The silent half: an unsplit family says nothing, so the marker means "this
  // one is divided" rather than becoming a column.
  const whole = build(false);
  const wholeEntry = whole.getStatus().routing.find(e => e.route === 'fable');
  assert.equal(wholeEntry.familySplit, null);
  const wholeOthers = row(render(whole, now), 'Other scopes') || '';
  assert.doesNotMatch(wholeOthers, /split by model claims/,
    'a family that routes as one is reported as divided');
});

test('one eligible account says there is nothing to choose between', () => {
  const now = Date.now();
  const am = new AccountManager(['a', 'b'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1 } });
  am.accounts[0].quota = { ...am.accounts[0].quota, unified7d: 0.1, unified7dReset: now + 20 * H };
  am.accounts[1].quota = { ...am.accounts[1].quota, unified5h: 0.99 };
  const lines = render(am, now);

  assert.match(row(lines, 'Selection'), /one eligible account; nothing to choose between/);
});

test('the ratio rule prints a floor and no ranks', () => {
  // No five-hour reading anywhere is the stock probe-off state, and the only
  // way a healthy fleet reaches the ratio rule. It does not sort, so a rank
  // there would be renderer invention.
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'c'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  q(0, { unified5h: null, unified7d: 0.1, unified7dReset: now + 20 * H });
  q(1, { unified5h: null, unified7d: 0.2, unified7dReset: now + 100 * H });
  q(2, { unified5h: null, unified7d: 0.9, unified7dReset: now + 500 * H });
  const lines = render(am, now);

  const band = row(lines, 'Band');
  assert.match(band, /ratio rule/);
  assert.match(band, /floor \d\.\d{3}e[-+]\d+/);
  assert.match(band, /\(no-capacity-signal\)/);
  assert.ok(!band.includes('met at'), 'the ratio rule reported a coverage stop it never computed');

  const ladder = lines.slice(lines.findIndex(l => l.trim().startsWith('Admit')));
  const ranked = ladder.filter(l => /\bp[1-9]\b/.test(l));
  assert.equal(ranked.length, 0, 'the ratio rule printed a rank, asserting an order it never computed');
});

test('the caption is the rule that is running, with the configured target in it', () => {
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'c'].map(acct), 0.98,
    { expiryRouting: { enabled: true, coverage: 2, tolerance: 1.5 } });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  q(0, { unified5h: 0.05, unified7d: 0.1, unified7dReset: now + 20 * H });
  q(1, { unified5h: 0.15, unified7d: 0.3, unified7dReset: now + 40 * H });
  q(2, { unified5h: 0.3, unified7d: 0.6, unified7dReset: now + 500 * H });
  const lines = render(am, now);
  // Collect every wrapped continuation rather than a fixed number of lines: the
  // caption's length changes when its wording does, and a fixed slice silently
  // truncates the sentence it is asserting about.
  const start = lines.findIndex(l => l.trim().startsWith('Rule'));
  const caption = [lines[start], ...lines.slice(start + 1)
    .filter((l, i, all) => all.slice(0, i + 1).every(x => /^ {15}\S/.test(x)))]
    .map(l => l.trim().replace(/^Rule\s+/, '')).join(' ');

  assert.match(caption, /2\.0 accounts of 5h headroom/,
    'the caption carries a literal target, so a reconfigured one is described wrongly');
  // The ordering claim is qualified by priority, because only the best tier is
  // ranked: unqualified, the sentence is falsified by a lower-priority account
  // with more expiring quota, which the band puts last.
  assert.match(caption, /within the best priority tier/,
    'the caption claims an unqualified ordering the band only follows within a tier');
  // `headroom` names the five-hour bucket everywhere else in the payload, so
  // the weekly numerator must not borrow the word.
  assert.match(caption, /unspent weekly quota per hour/);
  assert.ok(!/weekly headroom/.test(caption), 'the caption calls the weekly numerator headroom');
});

test('the caption a reader sees is the caption the gate grades', () => {
  // The caption is also pinned outside the suite, by a review-time gate that
  // refuses to run when the sentence changes. Holding it here too means a
  // reword fails the suite as well, rather than depending on a tool somebody
  // has to remember to run — and the suite is the copy that always ships.
  assert.equal(
    ruleCaption({ kind: 'sized', target: 1 }),
    'within the best priority tier, most unspent weekly quota per hour '
      + 'before it resets goes first, until 1.0 accounts of 5h headroom are covered; '
      + 'accounts missing either measurement are admitted regardless');
  assert.equal(ruleCaption({ kind: 'banded' }),
    'within the best priority tier, everything within the tolerance ratio '
      + 'of the best unspent-weekly-per-hour; accounts with no pressure reading '
      + 'are admitted regardless');
  assert.equal(ruleCaption({ kind: 'passthrough' }), null,
    'a decision that ran no rule has a rule caption');
});

// A SCOPE WITH NO FIGURES IS NOT A FLEET WITH NO ACCOUNTS. When an earlier
// route takes the id a scope is named for, the entry publishes no per-account
// figures — and the collapsed row's default branch would have reported that as
// "0 eligible", which is a claim about the fleet rather than about the question
// nobody asked.
test('a captured scope says why it has no figures rather than counting to zero', () => {
  const now = Date.now();
  // Expiry routing ON and a third account, so SOME scope decides something and
  // the block renders at all — a fleet where every scope is passthrough
  // collapses to the one-row form and this line never appears.
  //
  // THE FIXTURE HAS TO EARN THE SUPPRESSION, and all three conditions are here
  // deliberately: `wild`'s representative is captured by `exact`, `wild` lists
  // NO accounts so the id reaches the ownership question at all, and the
  // `models` claim below makes that question discriminate. Drop any one and the
  // entry publishes ordinary figures — which is the whole correction this
  // fixture exists downstream of, since it originally listed its accounts and
  // was suppressed anyway.
  //
  // THE CLAIM NAMES A SIBLING, NOT THE REPRESENTATIVE, and that is the point of
  // it. `claude-fable-5` is the id `exact` captured, so `wild` never receives
  // it and a claim on it decides nothing about `wild`'s traffic. `claude-fable-4`
  // is an id `wild` actually gets. An earlier version of this fixture claimed
  // the representative and stopped suppressing the moment the predicate started
  // asking about received ids — correctly, since nothing about that fleet's
  // published figures was wrong.
  const accounts = ['a', 'b', 'c'].map(acct);
  accounts[0].models = ['claude-fable-4'];
  const am = new AccountManager(accounts, 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'exact', match: ['claude-fable-5'], accounts: ['a', 'c'] },
      { name: 'wild', match: ['*fable*'], accounts: [] }],
  });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
  });
  const status = am.getStatus();
  const wild = status.routing.find(e => e.route === 'wild');
  assert.equal(wild.figuresAbsent, 'representative-captured', 'the premise: this scope is suppressed');

  // WHAT A SUPPRESSED ENTRY PUBLISHES, asserted here because this is the only
  // fixture in the suite where suppression genuinely applies — the tests that
  // used to grade this shape were built on captured entries whose figures are
  // correct, and they went back to grading those figures.
  //
  // `candidates` is NULL and not 0, and the difference is the entry's whole
  // claim. Zero is a figure: on this fleet it would say nothing can serve the
  // scope, while `b` serves it perfectly well. Not measured is not the same as
  // measured and none, and every other scalar on this band already says so.
  assert.equal(wild.band.candidates, null,
    'a suppressed entry counts a fleet nobody measured');
  assert.equal(wild.target, null);
  assert.equal(wild.pick.account, null);
  assert.deepEqual(wild.band.admitted, []);
  assert.deepEqual(wild.band.ladder, []);
  assert.deepEqual(wild.band.excluded, []);

  const lines = renderStatus(status, { color: false, now }).split('\n');
  const rendered = lines.join('\n');
  // It surfaces on the `Other scopes` line, because a scope that decided
  // nothing never wins the block — which is exactly why the line has to say
  // something better than the band variant `passthrough`.
  assert.match(rendered, /no figures, an earlier route takes its id/,
    'the screen describes a suppressed scope by a decision it never made');
  assert.doesNotMatch(rendered, /0 eligible/,
    'the collapsed row counted a fleet nobody asked about');
});

// A ROUTE CAN BE PARTLY SUPPRESSED, and the mixed path was the half the
// withdrawal fix did not cover. A route with two globs has two scopes: an
// earlier route can capture one representative and not the other, so one scope
// publishes figures and one does not.
//
// The mixed line fell through to `routes[].accounts`, which `getRoutes` grades
// against the route's STRIPPED SAMPLE — an id no claim matches — so every
// account came back eligible and the screen named one that the measured scope
// excludes. The caveat beside it did not save it: a name on screen is an owner
// offered for traffic this route cannot send it, which is the rule the round's
// own pass-14 test already states.
test('a partly suppressed route names only accounts its measured scopes admit', () => {
  const now = Date.now();
  const accounts = ['a', 'b'].map(acct);
  accounts[0].models = ['claude-fable-5', 'claude-sonnet-4-6'];
  const am = new AccountManager(accounts, 0.98, {
    routes: [{ name: 'exact', match: ['claude-fable-5'], accounts: [] },
      { name: 'mixed', match: ['*fable*', '*sonnet*'], accounts: [] }],
  });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.2, unified7dReset: now + 40 * H,
      unified7dFable: 0.2 + i * 0.2, unified7dFableReset: now + 40 * H,
      unified7dSonnet: 0.2 + i * 0.2, unified7dSonnetReset: now + 40 * H };
  });
  const status = am.getStatus();
  const scopes = status.routing.filter(e => e.route === 'mixed');
  // The premise: PARTLY, not wholly. Without both halves this fixture is
  // testing the full-withdrawal path that already worked.
  assert.ok(scopes.some(e => e.figuresAbsent === 'representative-captured'),
    'the premise: one scope of this route is suppressed');
  const measured = scopes.filter(e => e.figuresAbsent == null);
  assert.ok(measured.length, 'the premise: another scope of it published figures');

  const line = renderStatus(status, { color: false, now }).split('\n')
    .find(l => l.includes('*fable*, *sonnet*'));
  assert.ok(line, 'the routing table renders the mixed route');
  // Nobody the measured scopes all exclude may appear, in any colour.
  const excludedEverywhere = ['a', 'b'].filter(n =>
    measured.every(e => (e.band?.excluded || []).some(x => x.account === n)));
  for (const name of excludedEverywhere) {
    assert.doesNotMatch(line, new RegExp(`\\b${name}\\b`),
      `the line names ${name}, which every measured scope of this route excludes`);
  }
  // THE POSITIVE CONTROL: it must still name somebody, or "names no excluded
  // account" is satisfied by a renderer that stopped naming accounts at all.
  const admitted = new Set(measured.flatMap(e => e.band?.admitted || []));
  assert.ok(admitted.size, 'the fixture is degenerate: no measured scope admitted anyone');
  for (const name of admitted) {
    assert.match(line, new RegExp(`\\b${name}\\b`),
      `the line dropped ${name}, which a measured scope admits`);
  }
  assert.match(line, /some scopes have no figures/,
    'the line presents a partial answer as a whole one');
});

// AT THE DEFAULT CONFIGURATION, which is the whole point of this test existing.
// The test above turns expiry routing ON so that some scope decides something
// and the Decision block renders at all. With it OFF — the shipped default —
// every scope is passthrough, the block collapses to its one-row form, and the
// `Other scopes` line carrying the suppression notice is never emitted. The
// routing table is then the ONLY thing on screen about the route, and it was
// listing accounts graded for an id the route does not receive: the payload
// withdrew the claim and the default rendering went on making it.
//
// So the withdrawal is attached to the routing line, which renders in every
// configuration, and this test pins it in the one the block does not reach.
test('the routing table withdraws a suppressed route in the default configuration', () => {
  const now = Date.now();
  const accounts = ['owner5', 'owner4'].map(acct);
  // A claim on a SIBLING the wide route receives, not on the captured
  // representative — the shape that makes the figures wrong.
  accounts[1].models = ['claude-fable-4'];
  const am = new AccountManager(accounts, 0.98, {
    // No expiryRouting key at all: the stock default, and the configuration
    // whose absence of a warning was the defect.
    routes: [{ name: 'exact', match: ['claude-fable-5'], accounts: [] },
      { name: 'wild', match: ['*fable*'], accounts: [] }],
  });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
      unified7dFable: 0.1 + i * 0.2, unified7dFableReset: now + (20 + i * 10) * H };
  });
  const status = am.getStatus();
  const wild = status.routing.find(e => e.route === 'wild');
  assert.equal(wild.figuresAbsent, 'representative-captured', 'the premise: the wire withdrew this scope');

  const rendered = renderStatus(status, { color: false, now });
  const wildLine = rendered.split('\n').find(l => l.includes('*fable*'));
  assert.ok(wildLine, 'the routing table renders the route at all');
  assert.match(wildLine, /no figures: an earlier route takes the id/,
    'the default screen says nothing about a scope whose figures were withdrawn');
  // THE CONTROL: the accounts must be gone from that line, not merely
  // accompanied by a caveat. Naming them beside the notice would still put an
  // owner on screen for traffic this route cannot serve.
  assert.doesNotMatch(wildLine, /owner5|owner4/,
    'the line still names an owner the payload withdrew');
  // And the route that legitimately owns its representative is untouched, so
  // the fix is not "stop rendering accounts".
  const exactLine = rendered.split('\n').find(l => l.includes('claude-fable-5'));
  assert.match(exactLine, /owner5|owner4/, 'an unsuppressed route stopped naming its accounts');
});

// ── THE ROUTE LINE HAS ONE NAMING RULE, and the four cases below are its
// boundary rather than four samples of it.
//
// The mixed-path fix took names from the scopes that PUBLISHED — but only under
// PARTIAL suppression. With nothing captured the line fell through to
// `routes[].accounts`, which `getRoutes` grades against the route's STRIPPED
// SAMPLE, an id no claim matches, so every account came back eligible and the
// line named accounts every measured scope excluded. Same defect, sibling
// branch: the fifth time this round that repairing one branch left its twin.
//
// So the rule is now selected by whether the route HAS routing entries, not by
// their suppression state. UNION SEMANTICS, spelled out because "excluded by
// all" and "excluded by any" are both plausible readings of a union nobody
// wrote down: an account admitted by AT LEAST ONE published scope is named; an
// account excluded by ALL of them is not named at all, not even in red.

// A fleet whose accounts are separated by what they CLAIM, so one route's
// scopes genuinely admit different accounts and the stripped-sample view
// disagrees with all of them.
function claimFleet(now, globs, claims) {
  const names = Object.keys(claims);
  const am = new AccountManager(names.map(acct), 0.98, {
    routes: [{ name: 'multi', match: globs, accounts: [] }],
  });
  names.forEach((n, i) => {
    am.accounts[i].models = claims[n];
    am.accounts[i].quota = { ...am.accounts[i].quota,
      unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H };
  });
  return am;
}

const routeLine = (am, now, needle) =>
  renderStatus(am.getStatus(), { color: false, now }).split('\n')
    .find(l => l.includes(needle));

// CASE 1 — ALL PUBLISHED, which is the PASS-16 P1. Nothing is captured, so the
// old code took the `routes[].accounts` branch.
test('a route with nothing suppressed names only accounts a published scope admits', () => {
  const now = Date.now();
  const am = claimFleet(now, ['*sonnet*', '*opus*'], {
    a: ['claude-sonnet-4-6'], b: ['claude-opus-4-5'], c: ['claude-fable-5'],
  });
  const status = am.getStatus();
  const scopes = status.routing.filter(e => e.route === 'multi');
  assert.ok(scopes.length >= 2, 'the premise: this route has several scopes');
  assert.ok(scopes.every(e => e.figuresAbsent == null),
    'the premise: NOTHING is suppressed — otherwise this re-tests the mixed path');

  const line = routeLine(am, now, '*sonnet*, *opus*');
  assert.ok(line, 'the routing table renders the route');

  const admitted = new Set(scopes.flatMap(e => e.band?.admitted || []));
  const unadmitted = ['a', 'b', 'c'].filter(n => !admitted.has(n));
  // `c` claims neither glob's id, so no published scope admits it — and the
  // stripped-sample view called it eligible anyway.
  assert.ok(unadmitted.length,
    'the fixture is degenerate: every account is admitted somewhere, so the two sources cannot disagree');
  for (const name of unadmitted) {
    assert.doesNotMatch(line, new RegExp(`\\b${name}\\b`),
      `the line names ${name}, which no published scope of this route admits`);
  }
  // POSITIVE CONTROL: "names nobody unadmitted" must not be satisfiable by a
  // renderer that stopped naming accounts at all.
  assert.ok(admitted.size, 'the fixture is degenerate: no scope admitted anyone');
  for (const name of admitted) {
    assert.match(line, new RegExp(`\\b${name}\\b`),
      `the line dropped ${name}, which a published scope admits`);
  }
  // Nothing here went unmeasured, so the partial caveat must not appear.
  assert.doesNotMatch(line, /some scopes have no figures/,
    'a fully measured route claims part of it was not measured');
});

// CASE 2 — THREE-PLUS SCOPES. Two globs can be special-cased by accident;
// three is where a union has to actually be a union.
//
// THE THIRD GLOB IS `claude-haiku-4-5*`, NOT `*haiku*`, and the reason is worth
// keeping because the first draft of this test asserted the wrong thing and its
// own degeneracy guard caught it. `*haiku*` strips to the bare sample `haiku`,
// which no account claims — and an id no claim names admits EVERYONE, which is
// exactly the property TC-031 records. That scope was therefore vacuously
// permissive, admitted all four accounts, and the union named `d` correctly.
// The assertion was wrong, not the renderer. A glob whose stripped core is a
// REAL id makes the third scope discriminate like the other two.
test('a route with three published scopes names the union of what they admit', () => {
  const now = Date.now();
  const am = claimFleet(now, ['*sonnet*', '*opus*', 'claude-haiku-4-5*'], {
    a: ['claude-sonnet-4-6'], b: ['claude-opus-4-5'],
    c: ['claude-haiku-4-5'], d: ['claude-fable-5'],
  });
  const status = am.getStatus();
  const scopes = status.routing.filter(e => e.route === 'multi');
  assert.equal(scopes.length, 3, 'the premise: three scopes');
  assert.ok(scopes.every(e => e.figuresAbsent == null), 'the premise: all published');

  const line = routeLine(am, now, '*sonnet*, *opus*, claude-haiku-4-5*');
  assert.ok(line, 'the routing table renders the route');
  const admitted = new Set(scopes.flatMap(e => e.band?.admitted || []));
  assert.ok(admitted.size >= 3,
    'the fixture is degenerate: the union does not span all three scopes');
  for (const name of admitted) {
    assert.match(line, new RegExp(`\\b${name}\\b`), `the union dropped ${name}`);
  }
  assert.ok(!admitted.has('d'),
    'the fixture is degenerate: d was supposed to be admitted by no scope');
  assert.doesNotMatch(line, /\bd\b/,
    'named d, which claims none of this route\'s globs and no published scope admits');
});

// CASE 3 — THE SCOPES DISAGREE ABOUT ONE ACCOUNT: admitted by one, excluded by
// another. The direction is the assertion.
test('an account one published scope admits is named even where another excludes it', () => {
  const now = Date.now();
  const am = claimFleet(now, ['*sonnet*', '*opus*'], {
    a: ['claude-sonnet-4-6'], b: ['claude-opus-4-5'],
  });
  const status = am.getStatus();
  const scopes = status.routing.filter(e => e.route === 'multi');
  const admits = n => scopes.some(e => (e.band?.admitted || []).includes(n));
  const excludes = n => scopes.some(e => (e.band?.excluded || []).some(x => x.account === n));
  const disputed = ['a', 'b'].find(n => admits(n) && excludes(n));
  assert.ok(disputed,
    'the fixture is degenerate: no account is admitted by one scope and excluded by another');

  const line = routeLine(am, now, '*sonnet*, *opus*');
  assert.match(line, new RegExp(`\\b${disputed}\\b`),
    `dropped ${disputed}, which a published scope admits — a union over admissions must name it`);
});

// CASE 4 — THE FALLBACK SURVIVES. With NO matching routing entry there are no
// published scopes to draw on, and `routes[].accounts` is then the route's own
// CONFIGURED list rather than a stripped-sample grade. Silencing those routes
// would be the mirror-image defect, so the fix is pinned against it.
test('a route with no routing entries still names its configured accounts', () => {
  const now = Date.now();
  const am = claimFleet(now, ['*sonnet*'], {
    a: ['claude-sonnet-4-6'], b: ['claude-sonnet-4-6'],
  });
  const status = am.getStatus();
  const listed = (status.routes.find(r => r.name === 'multi')?.accounts || []).map(a => a.name);
  assert.ok(listed.length, 'the fixture is degenerate: the route lists no accounts');
  // The pre-suppression wire shape, and the shape any consumer that does not
  // send `routing` produces.
  const stripped = { ...status, routing: [] };
  const line = renderStatus(stripped, { color: false, now }).split('\n')
    .find(l => l.includes('*sonnet*'));
  assert.ok(line, 'the routing table renders the route at all');
  for (const name of listed) {
    assert.match(line, new RegExp(`\\b${name}\\b`),
      `the fallback dropped ${name}; with no routing entries the configured list is all there is`);
  }
});

// ── THE OTHER TWO PIPELINE STAGES, each of which the SWEEP found unheld.
//
// Both of these exist because a neutralisation row SURVIVED: reverting the join
// to its name-based key, and dropping the blocklist predicate from the union,
// each left the whole suite green. Probes covered them; the suite did not, and a
// stage no test holds is a stage the next refactor silently removes.

// STAGE: THE JOIN. Route names are NOT unique. Matching entries to a route by
// `(name, glob)` let a later route sharing both import an earlier route's entry
// — naming an owner for traffic this route cannot send, and (grok's stronger
// fixture) dropping the account that actually serves it. The join is by the
// route's POSITION, which cannot collide.
test('a route sharing a name with an earlier one does not inherit its scopes', () => {
  const now = Date.now();
  const accounts = [acct('alpha'), acct('beta')];
  accounts[0].models = ['claude-opus-4-5'];
  accounts[1].models = ['claude-haiku-4-5'];
  const am = new AccountManager(accounts, 0.98, {
    routes: [
      { name: 'exact', match: ['claude-opus-4-5'], accounts: [] },
      { name: 'dup', match: ['claude-haiku-4-5*'], accounts: [] },
      // Same NAME as the route above and it also lists that route's glob, which
      // is what made the old key ambiguous.
      { name: 'dup', match: ['*opus*', 'claude-haiku-4-5*'], accounts: [] },
    ],
  });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H };
  });
  const status = am.getStatus();
  const late = status.routes.findIndex(r => (r.match || []).length === 2);
  assert.ok(late >= 0, 'the premise: the two-glob route rendered');
  const earlier = status.routing.find(e => e.route === 'dup' && e.routeIndex !== late);
  assert.ok(earlier, 'the premise: an earlier route shares the name "dup"');
  assert.ok((earlier.band?.admitted || []).length,
    'the fixture is degenerate: the earlier same-named route admits nobody, so importing it changes nothing');

  const line = renderStatus(status, { color: false, now }).split('\n')
    .find(l => l.includes('*opus*, claude-haiku-4-5*'));
  assert.ok(line, 'the routing table renders the late route');
  for (const name of earlier.band.admitted) {
    assert.doesNotMatch(line, new RegExp(`\\b${name}\\b`),
      `the late route names ${name}, which only the EARLIER same-named route's scope admits`);
  }
});

// THE OTHER DIRECTION, and the one this rewrite nearly shipped wrong. Naming
// from the published scopes must not become naming only the accounts the BAND
// KEPT. A band SIZES: `admitted` is the subset that meets the coverage target,
// `ladder` is the candidate field, and an account can be in the ladder, able to
// serve, and not admitted — SPARE, `reason: 'coverage-met'`. Keyed on
// `band.admitted` alone this line went from `→ a b c` to `→ a b` on a fleet
// where `c` can serve: f45431a's trade-not-add, pointed at a renderer, and it
// would have spread to EVERY route once the rule stopped being gated on partial
// suppression. The rule unions `admitted` with the ladder so the two regimes
// (passthrough, where the ladder is empty, and sized) get one answer.
test('a spare account that can serve the route is still named', () => {
  const now = Date.now();
  const am = new AccountManager(['a', 'b', 'c', 'd'].map(acct), 0.98, {
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
    routes: [{ name: 'wide', match: ['*opus*'], accounts: ['a', 'b', 'c'] }],
  });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  q(0, { unified5h: 0.05, unified7d: 0.1, unified7dReset: now + 20 * H });
  q(1, { unified5h: 0.15, unified7d: 0.3, unified7dReset: now + 40 * H });
  q(2, { unified5h: 0.30, unified7d: 0.6, unified7dReset: now + 500 * H });
  q(3, { unified5h: 0.40, unified7d: 0.7, unified7dReset: now + 600 * H });

  const status = am.getStatus();
  const entry = status.routing.find(e => e.route === 'wide' && e.figuresAbsent == null);
  assert.ok(entry, 'the premise: this route published figures');
  const band = entry.band || {};
  assert.equal(band.kind, 'sized', 'the premise: the band SIZES, or there are no spares to drop');
  const admitted = new Set(band.admitted || []);
  const cannot = new Set((band.excluded || []).map(x => x.account));
  const spare = (band.ladder || []).map(r => r.account)
    .filter(n => !admitted.has(n) && !cannot.has(n));
  assert.ok(spare.length,
    'the fixture is degenerate: no account is a candidate the band declined to admit');

  const line = renderStatus(status, { color: false, now }).split('\n')
    .find(l => l.trim().startsWith('*opus*'));
  assert.ok(line, 'the routing table renders the route');
  for (const name of spare) {
    assert.match(line, new RegExp(`\\b${name}\\b`),
      `dropped ${name}, a candidate that CAN serve this route and was merely not `
      + 'kept by the band — naming only the admitted subset hides working capacity');
  }
  // And the account that genuinely cannot serve is still not named, so this is
  // an ADDITION to the rule rather than a retreat from it.
  for (const name of cannot) {
    assert.doesNotMatch(line, new RegExp(`\\b${name}\\b`),
      `named ${name}, which this scope excludes as unable to serve`);
  }
});

// STAGE: THE BLOCKLIST. A published scope whose own model is blocked carries
// nothing, so an account admitted solely there is an owner offered for traffic
// the route cannot send it. The `(partly blocked)` tag beside the name does not
// save it — that is the same caveat-does-not-save-it rule the round already
// applied to the stripped sample.
test('a route does not name an account only a blocked scope admits', () => {
  const now = Date.now();
  const accounts = [acct('alpha'), acct('beta')];
  accounts[0].models = ['claude-opus-4-5'];
  accounts[1].models = ['claude-haiku-4-5'];
  const am = new AccountManager(accounts, 0.98, {
    routes: [{ name: 'multi', match: ['*opus*', 'claude-haiku-4-5*'], accounts: [] }],
  });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H };
  });
  // Block one of the two globs, the way the server does.
  const status = { ...am.getStatus(), blockedModels: ['*opus*'] };
  const scopes = status.routing.filter(e => e.route === 'multi');
  assert.equal(scopes.length, 2, 'the premise: two scopes');
  assert.ok(scopes.every(e => e.figuresAbsent == null),
    'the premise: both PUBLISHED — this is about blocking, not suppression');
  const opus = scopes.find(e => (e.match || [])[0] === '*opus*');
  const clear = scopes.find(e => (e.match || [])[0] !== '*opus*');
  const clearAdmits = new Set(clear.band?.admitted || []);
  const blockedOnly = (opus.band?.admitted || []).filter(n => !clearAdmits.has(n));
  assert.ok(blockedOnly.length,
    'the fixture is degenerate: no account is admitted ONLY by the blocked scope');

  const line = renderStatus(status, { color: false, now }).split('\n')
    .find(l => l.includes('*opus*, claude-haiku-4-5*'));
  assert.ok(line, 'the routing table renders the route');
  for (const name of blockedOnly) {
    assert.doesNotMatch(line, new RegExp(`\\b${name}\\b`),
      `named ${name}, which only a BLOCKED scope admits — the route cannot send it traffic`);
  }
  // POSITIVE CONTROL: the clear scope's accounts must still be named, or this
  // passes on a line that stopped naming anyone.
  assert.ok(clearAdmits.size, 'the fixture is degenerate: the clear scope admits nobody');
  for (const name of clearAdmits) {
    assert.match(line, new RegExp(`\\b${name}\\b`),
      `dropped ${name}, which the unblocked scope admits`);
  }
});
