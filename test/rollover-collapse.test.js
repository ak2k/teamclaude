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
    { name: 'a', used: 0.5, resetH: 50 },
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
    { name: 'a', used: 0.5, resetH: 50 },
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
    { name: 'a', used: 0.5, resetH: 50 },
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
    { name: 'a', used: 0.5, resetH: 50 },
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
    assert.equal(seeded.get(bucket).get(0).window, SHARED,
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
