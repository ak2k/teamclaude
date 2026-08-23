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

test('a pin that fell through is not credited, and is not hidden either', () => {
  // `setRoutePin` documents pinning a near-quota or throttled account as
  // supported: it acts as a preference and routing falls back to best-available
  // until the pinned account is eligible. Branching on the pin's EXISTENCE
  // therefore credited a pin that had not acted — and worse, suppressed the
  // reason that had, sending a reader debugging the destination to the pin.
  //
  // Four accounts, because removing the pinned one must still leave a band that
  // sizes; on two or three the scope passes through and the block renders
  // nothing, which reads as agreement.
  const now = Date.now();
  const build = pinnedHealthy => {
    const am = new AccountManager(['a', 'b', 'c', 'pinned'].map(acct), 0.98, {
      expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
      routes: [{ name: 'fable', match: ['*fable*'] }],
      distributeSessions: true,
    });
    am.accounts.forEach((x, i) => {
      x.quota = { ...x.quota,
        unified5h: 0.05 + i * 0.1, unified5hReset: now + 2 * H,
        unified7d: 0.1 + i * 0.1, unified7dReset: now + (20 + i * 10) * H,
        unified7dFable: 0.1 + i * 0.1, unified7dFableReset: now + (30 + i * 10) * H };
    });
    // Near-quota rather than disabled: the state the docstring names.
    if (!pinnedHealthy) am.accounts[3].quota = { ...am.accounts[3].quota, unified5h: 0.99 };
    assert.equal(am.setRoutePin('fable', 3).ok, true, 'the premise: the pin was accepted');
    return am;
  };

  const fellThrough = build(false).getStatus();
  const entry = fellThrough.routing.find(e => e.route === 'fable');
  assert.equal(entry.pinnedTo, 'pinned', 'the premise: a pin is set');
  assert.notEqual(entry.target, 'pinned', 'the premise: it did not win, so crediting it would be false');
  const newSession = row(renderStatus(fellThrough, { color: false, now }).split('\n'), 'New session');
  assert.doesNotMatch(newSession, /route pin\)/, 'the block credits a pin that did not act');
  assert.match(newSession, /by \w+/, 'the reason that DID choose is suppressed by the pin branch');
  assert.match(newSession, /pin to pinned is not eligible/,
    'a pin the operator set vanished from the block, which reads as no pin at all');

  // Control: the same fixture with the pinned account healthy. Without this the
  // assertions above pass for a block that never credits a pin at all.
  const honoured = build(true).getStatus();
  assert.equal(honoured.routing.find(e => e.route === 'fable').target, 'pinned');
  assert.match(row(renderStatus(honoured, { color: false, now }).split('\n'), 'New session'), /→ pinned .*route pin/,
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

test('expiry routing off collapses to one row instead of a block', () => {
  const now = Date.now();
  const am = new AccountManager(['a', 'b'].map(acct), 0.98);
  am.accounts[0].quota = { ...am.accounts[0].quota, unified7d: 0.1, unified7dReset: now + 20 * H };
  const lines = render(am, now);

  assert.ok(!lines.some(l => l.startsWith('Decision')),
    'a fleet with the feature off renders a block about a rule that never ran');
  assert.match(row(lines, 'Selection'), /load-ranked · expiry routing off · 2 accounts eligible/);
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
  // `tools/verify-caption.mjs` pins this exact sentence and refuses to run when
  // it changes. Holding it here too means a reword fails the suite as well as
  // the gate, rather than only being caught by a tool somebody has to remember.
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
