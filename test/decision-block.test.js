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
  const caption = lines.slice(lines.findIndex(l => l.trim().startsWith('Rule')), 100)
    .slice(0, 2).map(l => l.trim().replace(/^Rule\s+/, '')).join(' ');

  assert.match(caption, /2\.0 accounts of 5h headroom/,
    'the caption carries a literal target, so a reconfigured one is described wrongly');
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
    'most unspent weekly quota per hour before it resets goes first, '
      + 'until 1.0 accounts of 5h headroom are covered');
  assert.equal(ruleCaption({ kind: 'banded' }),
    'within the tolerance ratio of the best unspent-weekly-per-hour');
  assert.equal(ruleCaption({ kind: 'passthrough' }), null,
    'a decision that ran no rule has a rule caption');
});
