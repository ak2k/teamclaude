import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  collapsingManager, assertCollapses, route, rollWeekly, rolloverStats,
  oauth, H, OPUS, FABLE, SONNET,
} from './collapsing-fleet.js';

// One invariant: window state is keyed by (request bucket, account index), and
// the window a bucket resolves to is a value read off the account rather than an
// identity stored under.
//
// Every fleet here COLLAPSES — no account meters a family bucket, so Opus,
// Sonnet and Fable requests all read the `unified7d` window while being pinned,
// preempted and settled as three separate things. That is the shipped fleet's
// ordinary case and the case no fixture in this suite produced, which is why
// four separately wrong keys passed every test.

const SHARED = 'unified7d';
const FABLE_BUCKET = 'unified7dFable';
const SONNET_BUCKET = 'unified7dSonnet';

// ── the P1 ────────────────────────────────────────────────────────────────
// Two buckets of one session, on one account, resolving to one window. The
// first to be preempted banks its post-rollover reset; keyed by the window, it
// banks the other bucket's baseline too, and that bucket's rollover becomes
// undetectable — the session rides the account that just gained a full week
// until the window comes round again.

test('settling a collapsed bucket does not settle the one it shares a window with', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  // An advisor request runs both families on one account, so both buckets pin
  // there — the shape that makes them collide.
  assert.equal(route(am, 's1', OPUS, FABLE).name, 'a');
  assert.equal(am.sessionTracker.pinnedAccount('s1', SHARED), 0);
  assert.equal(am.sessionTracker.pinnedAccount('s1', FABLE_BUCKET), 0);

  rollWeekly(am, 0);
  assert.equal(route(am, 's1', FABLE).name, 'b', 'the Fable bucket missed the roll');
  assert.equal(route(am, 's1', OPUS).name, 'b',
    "settling the Fable bucket swallowed the shared bucket's rollover, leaving the session on the rolled account");
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 2, rolloversPreempted: 2, rolloversOwed: 0 },
    'one of the two buckets\' events was never counted');
});

test('settling the shared bucket does not settle the family bucket collapsed onto it', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assert.equal(route(am, 's1', OPUS, FABLE).name, 'a');
  rollWeekly(am, 0);
  assert.equal(route(am, 's1', OPUS).name, 'b');
  assert.equal(route(am, 's1', FABLE).name, 'b',
    "settling the shared bucket swallowed the Fable bucket's rollover");
});

test('a third bucket collapsed onto the same window is not settled either', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  // Sonnet is the live fleet's own case: every account reports unified7dSonnet
  // as null, so an Opus+Sonnet session already holds two colliding buckets.
  assert.equal(route(am, 's1', OPUS, SONNET).name, 'a');
  assert.equal(am.sessionTracker.pinnedAccount('s1', SONNET_BUCKET), 0);
  rollWeekly(am, 0);
  assert.equal(route(am, 's1', SONNET).name, 'b');
  assert.equal(route(am, 's1', OPUS).name, 'b',
    "the Opus bucket inherited the Sonnet bucket's settled baseline");
});

// ── the same thing through the real server ────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Records which account served each request, by the injected key.
function recordingUpstream() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push((req.headers['x-api-key'] || req.headers['authorization'] || '').replace(/^(k-|Bearer t-)/, ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  return { server, hits };
}

async function withProxy(am, upstream, fn) {
  const upstreamPort = await listen(upstream.server);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const send = async (body) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1' },
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  };
  try {
    return await fn(send);
  } finally {
    proxy.close();
    upstream.server.close();
  }
}

const advisorRequest = (executor, advisor) => ({
  model: executor,
  max_tokens: 16,
  tools: [{ type: 'advisor_20260301', name: 'advisor', model: advisor }],
  messages: [],
});

test('a session whose buckets collapse is moved off the rolled account on every family', async () => {
  const am = collapsingManager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  assertCollapses(am);
  const upstream = recordingUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send(advisorRequest(OPUS, FABLE)), 200);  // both buckets pin to 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;              // 'a' rolls
    assert.equal(await send({ model: FABLE, messages: [] }), 200);
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits, ['a', 'b', 'b'],
    "the Fable request's settlement left the session's Opus traffic on the rolled account");
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 2, rolloversPreempted: 2, rolloversOwed: 0 });
});

// ── the keying itself, where it is stored ─────────────────────────────────

test('a bucket the account does not meter is stored under its own name', () => {
  const am = collapsingManager([{ name: 'a', used: 0.2, resetH: 50 }], { distribute: false });
  am.setCurrentAccount(0);
  const seeded = am._currentSeen.windows;
  for (const bucket of [SHARED, FABLE_BUCKET, SONNET_BUCKET]) {
    assert.equal(seeded.get(bucket)?.has(0), true,
      `${bucket} has no baseline of its own, so it shares another bucket's`);
    assert.deepEqual([...seeded.get(bucket).get(0).keys()], [SHARED],
      `${bucket} did not resolve to the shared window, so this fleet does not collapse`);
  }
});

test('the baseline names the account it was read from', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 300 },
  ], { distribute: false });
  am.setCurrentAccount(1);
  assert.equal(am._currentSeen.windows.get(SHARED)?.has(1), true,
    'the baseline was filed against an account it was not read from');
  assert.equal(am._currentSeen.windows.get(SHARED)?.has(0), false);
});

// A pin belongs to ONE account per bucket, so a check about one bucket must not
// write baselines for the session's other buckets — those sit on other accounts,
// and a baseline read here would answer for a window nobody looked at there.
test('a pin rollover check seeds only the bucket it is about', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  route(am, 's1', OPUS);
  route(am, 's1', OPUS); // the second request is the one with a pin to check
  const seen = am.sessionTracker.windowsFor('s1');
  assert.deepEqual([...seen.windows.keys()], [SHARED],
    'the check seeded buckets this account was never chosen for');
});

test('a request seeds only the buckets it spent', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  route(am, 's1', FABLE);
  const seen = am.sessionTracker.windowsFor('s1');
  assert.deepEqual([...seen.windows.keys()], [FABLE_BUCKET],
    'a Fable request seeded buckets it did not spend');
});

// ── the stuck-rollover line, per (account, bucket) ────────────────────────

const STUCK = 'no eligible account can take that traffic';

function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = real; }
  return lines;
}

// Two buckets of one account roll together under the collapse, and both can be
// stuck at once. Throttled per account they are one line, and the operator is
// told about one of the two families that stopped moving.
test('two buckets stuck on one account are both reported', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 100 },
  ]);
  route(am, 's1', OPUS, FABLE);
  am.accounts[1].disabled = true;
  rollWeekly(am, 0);
  const lines = captureLog(() => { route(am, 's1', FABLE); route(am, 's1', OPUS); });
  const stuck = lines.filter(l => l.includes(STUCK));
  assert.equal(stuck.length, 2, `two stuck buckets reported ${stuck.length} lines`);
  assert.equal(stuck.filter(l => l.includes(FABLE_BUCKET)).length, 1, stuck.join('\n'));
  assert.equal(stuck.filter(l => l.includes(`${SHARED} window`)).length, 1, stuck.join('\n'));
});

test('the stuck-rollover throttle follows an account through a removal', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98,
    { distributeSessions: true, expiryRouting: { enabled: true } });
  am._noteStuckRollover(am.accounts[1], OPUS); // 'b' is stuck and now throttled
  am.removeAccount(0);                          // 'b' → 0, 'c' → 1

  const cLines = captureLog(() => am._noteStuckRollover(am.accounts[1], OPUS));
  assert.equal(cLines.filter(l => l.includes(STUCK)).length, 1,
    "the account that slid into the throttled slot inherited its neighbour's silence");
  const bLines = captureLog(() => am._noteStuckRollover(am.accounts[0], OPUS));
  assert.equal(bLines.filter(l => l.includes(STUCK)).length, 0,
    'the throttle did not follow the account it belongs to');
});

// ── the other sticky choice ────────────────────────────────────────────────
// The pin arm above and this one are the SAME mistake in adjacent functions
// (_pinRolledOver / _currentRolledOver), and neither arm catches the other's:
// a fixture that drives only one leaves the other's wrong key alive. The global
// current account is one account for every bucket, so its collapse shows in the
// bookkeeping rather than in where the next request lands.

test('the current-account walk settles a collapsed bucket under that bucket', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { distribute: false });
  assertCollapses(am);
  am.setCurrentAccount(0);

  // No session id anywhere here: this is the walk that owns `currentIndex`.
  const walk = (model) => {
    const decision = {};
    const acc = am.getActiveAccount(null, model, null, null, decision);
    am.confirmRouted(null, acc.index, model, null, decision);
    return acc;
  };
  assert.equal(walk(OPUS).name, 'a');
  assert.equal(walk(FABLE).name, 'a');

  rollWeekly(am, 0);
  assert.equal(walk(FABLE).name, 'b', 'the collapsed Fable bucket missed the roll');
  // The event was detected against the Fable bucket and must settle against it.
  // Filed under the window it resolves to, the settle looks for a service on
  // `unified7d`, finds the one the Fable request recorded on `unified7dFable`,
  // and matches nothing — so the move never lands and the gauge never clears.
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 },
    "the Fable bucket's event was filed under a key its own service could not settle");
});

test('a collapsed bucket settling does not swallow the shared bucket\'s roll on the current account', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.1, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ], { distribute: false });
  am.setCurrentAccount(0);
  const walk = (model) => {
    const decision = {};
    const acc = am.getActiveAccount(null, model, null, null, decision);
    am.confirmRouted(null, acc.index, model, null, decision);
    return acc;
  };
  assert.equal(walk(OPUS).name, 'a');
  assert.equal(walk(FABLE).name, 'a');

  rollWeekly(am, 0);
  assert.equal(walk(FABLE).name, 'b');  // the Fable bucket moves and banks its own baseline

  // Drive the walk back onto 'a' without asking about the shared bucket, so the
  // only thing that could have advanced its baseline is the Fable settle.
  am.accounts[1].disabled = true;
  assert.equal(walk(OPUS).name, 'a');
  am.accounts[1].disabled = false;
  assert.equal(walk(OPUS).name, 'b',
    "the shared bucket inherited the Fable bucket's banked baseline, so its own roll never fired");
  assert.equal(rolloverStats(am).rolloversDetected, 2, 'one of the two buckets never reported its roll');
});

// ── the fleet shape every other rollover fixture here cannot reach ────────
// The fixtures above deliberately meter NO family bucket, so no bucket's window
// name ever changes and the whole family-window path is unexercised. That gap
// let a permanent P1 through 723 passing tests: on an account that DOES meter
// `unified7dFable`, a rollover of that window was never detected at all.
//
// The mechanism is why a fixture has to drive the whole transition rather than
// jump to the end state. A family roll is TWO window flips, because
// _clearExpiredQuotas nulls the utilization and the reset together at the reset
// instant and the utilization is what _windowForBucket decides on:
//
//   1. metered      -> bucket resolves to `unified7dFable`
//   2. reset passes -> both nulled -> bucket collapses onto `unified7d`
//   3. new window   -> bucket resolves to `unified7dFable` again
//
// A fixture that only sets up (1) and then jumps to (3) misses step 2, which is
// the step that used to destroy the pre-roll baseline.

// A fleet that METERS its family bucket, from { used, resetH, fableUsed,
// fableResetH }, with the premise asserted rather than assumed.
function meteringManager(specs, { distribute = true } = {}) {
  const am = new AccountManager(specs.map(s => oauth(s.name)), 0.98,
    { distributeSessions: distribute, expiryRouting: { enabled: true } });
  const now = Date.now();
  specs.forEach((s, i) => {
    const q = am.accounts[i].quota;
    q.unified7d = s.used;
    q.unified7dReset = now + s.resetH * H;
    q.unified7dFable = s.fableUsed;
    q.unified7dFableReset = now + s.fableResetH * H;
    am.accounts[i].probing = false;
  });
  for (const account of am.accounts) {
    assert.equal(am._governingBucket(account, FABLE), FABLE_BUCKET,
      `"${account.name}" does not meter its Fable bucket, so this fleet cannot reach the family-window path`);
  }
  return am;
}

// Step 2: `idx`'s Fable window reaches its reset, and the request path clears
// it — which nulls the UTILIZATION, and the utilization is what decides the
// window. Returns the reset that just lapsed.
function expireFableWindow(am, idx) {
  const q = am.accounts[idx].quota;
  const wasReset = q.unified7dFableReset;
  q.unified7dFableReset = Date.now() - 1;
  am.refreshExpiredQuotas();                     // what every request does first
  assert.equal(q.unified7dFable, null, 'the expired family utilization was not cleared');
  assert.equal(am._governingBucket(am.accounts[idx], FABLE), 'unified7d',
    'the bucket did not collapse while its window was gone, so step 2 is untested');
  return wasReset;
}

// Step 3: upstream reports the next window, through applyUsageData — the writer
// the prober and the usage endpoint actually use.
function reportNewFableWindow(am, idx, resetAt) {
  am.applyUsageData(idx, { sevenDayFable: { utilization: 0, resetAt } });
  assert.equal(am._governingBucket(am.accounts[idx], FABLE), FABLE_BUCKET,
    'the bucket did not return to its own window');
}

// The whole transition, WITH a request landing in the gap. That request is the
// point: it is the one that observes the collapsed window, and it is what a
// fixture jumping straight from step 1 to step 3 never performs. Without it the
// watcher never sees the intermediate state and a wrong implementation of the
// baseline slot goes undetected — the exact hole that let this defect ship.
function rollFableWindowThroughTheGap(am, idx, request) {
  const wasReset = expireFableWindow(am, idx);
  request();                                     // traffic keeps arriving meanwhile
  reportNewFableWindow(am, idx, wasReset + 168 * H);
}

test('a metered family window rolling over is detected on a session pin', () => {
  const am = meteringManager([
    { name: 'a', used: 0.3, resetH: 300, fableUsed: 0.4, fableResetH: 50 },
    { name: 'b', used: 0.3, resetH: 300, fableUsed: 0.3, fableResetH: 60 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'a');
  rollFableWindowThroughTheGap(am, 0, () => route(am, 's1', FABLE));
  assert.equal(route(am, 's1', FABLE).name, 'b',
    'the session rode the account whose Fable window just gained a full week');
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 });
});

test('a metered family window rolling over is detected on the current account', () => {
  const am = meteringManager([
    { name: 'a', used: 0.3, resetH: 300, fableUsed: 0.4, fableResetH: 50 },
    { name: 'b', used: 0.3, resetH: 300, fableUsed: 0.3, fableResetH: 60 },
  ], { distribute: false });
  am.setCurrentAccount(0);
  const walk = () => {
    const decision = {};
    const acc = am.getActiveAccount(null, FABLE, null, null, decision);
    am.confirmRouted(null, acc.index, FABLE, null, decision);
    return acc;
  };
  assert.equal(walk().name, 'a');
  rollFableWindowThroughTheGap(am, 0, walk);
  assert.equal(walk().name, 'b',
    'the current-account walk stayed on the account whose Fable window just rolled');
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 });
});

// The shared bucket must not be disturbed by the family bucket's round trip:
// it never changed window, and its own baseline is a separate slot.
test('a family window rolling over leaves the shared bucket\'s baseline alone', () => {
  const am = meteringManager([
    { name: 'a', used: 0.3, resetH: 300, fableUsed: 0.4, fableResetH: 50 },
    { name: 'b', used: 0.3, resetH: 300, fableUsed: 0.3, fableResetH: 60 },
  ]);
  // One advisor request pins both buckets to one account. Two separate requests
  // are split by the load tiebreak — the second lands on the OTHER account
  // because the first made this one the loaded one — and the roll would then
  // land on a window this session is not pinned to.
  assert.equal(route(am, 's1', OPUS, FABLE).name, 'a');
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7d'), 0);
  assert.equal(am.sessionTracker.pinnedAccount('s1', FABLE_BUCKET), 0);
  rollFableWindowThroughTheGap(am, 0, () => route(am, 's1', FABLE));
  assert.equal(route(am, 's1', FABLE).name, 'b');
  // The shared weekly never moved, so Opus stays put and owes nothing.
  assert.equal(route(am, 's1', OPUS).name, 'a',
    "the Fable bucket's round trip moved the shared bucket's traffic");
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 1, rolloversPreempted: 1, rolloversOwed: 0 });
});

// The forward flip on its own — an account that starts metering a family bucket
// it never metered before — is still a first sight, not a jump. This is the
// property the window-scoped baseline exists to preserve, so a fix for the roll
// must not buy it by making every window change an event.
test('an account that starts metering a family bucket does not report a rollover', () => {
  const am = collapsingManager([
    { name: 'a', used: 0.3, resetH: 50 },   // the account the Fable band prefers
    { name: 'b', used: 0.3, resetH: 300 },
  ]);
  assert.equal(route(am, 's1', FABLE).name, 'a');
  // 'a' begins reporting its own Fable window, dated well away from the shared
  // one it had been collapsing onto.
  am.applyUsageData(0, { sevenDayFable: { utilization: 0.1, resetAt: Date.now() + 700 * H } });
  assert.equal(am._governingBucket(am.accounts[0], FABLE), FABLE_BUCKET,
    'the bucket did not take up its own window, so this proves nothing');
  assert.equal(route(am, 's1', FABLE).name, 'a',
    'first sight of a family window was read as that window rolling over');
  assert.deepEqual(rolloverStats(am), { rolloversDetected: 0, rolloversPreempted: 0, rolloversOwed: 0 });
});
