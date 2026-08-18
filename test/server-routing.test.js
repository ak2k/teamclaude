import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Session-aware routing is decided across three separate calls the server makes
// per request — select, recordSession, confirmRouted — inside the beginSession
// / endSession pair that brackets them. A test that makes those calls itself
// validates its own ordering, not the server's, and every one of them is a line
// that can be dropped from src/server.js without any such test noticing. These
// drive the real server for that reason.

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const SID = { 'x-claude-code-session-id': 'sess-1' };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function apikey(name) {
  return { name, type: 'apikey', apiKey: `k-${name}` };
}

// An upstream that records which account served each request (by the injected
// x-api-key) and answers however `reply` says. Returns the hit log.
function scriptedUpstream(reply = () => ({ status: 200 })) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString() || '{}';
    const account = (req.headers['x-api-key'] || '').replace(/^k-/, '');
    const model = JSON.parse(body).model || null;
    hits.push({ account, model });
    const { status = 200, headers = {} } = reply({ account, model, hit: hits.length }) || {};
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  return { server, hits };
}

// Two accounts with expiry routing and session distribution on, quota set by
// hand (the upstream sends no rate-limit headers, so nothing overwrites it).
function fleet(specs, { expiryRouting = { enabled: true } } = {}) {
  const am = new AccountManager(specs.map(s => apikey(s.name)), 0.98,
    { distributeSessions: true, expiryRouting });
  const now = Date.now();
  specs.forEach((s, i) => {
    const q = am.accounts[i].quota;
    if (s.used != null) { q.unified7d = s.used; q.unified7dReset = now + s.resetH * H; }
    if (s.fableUsed != null) { q.unified7dFable = s.fableUsed; q.unified7dFableReset = now + s.fableResetH * H; }
    am.accounts[i].probing = false;
  });
  return am;
}

async function withProxy(am, upstream, fn) {
  const upstreamPort = await listen(upstream.server);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const send = async (body, headers = SID) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
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

// (a) A Fable request diverted off the session's account must not take the
// session's Opus traffic with it. recordSession has to be told which model the
// request spent, or every request re-pins the one shared bucket.
test('a diverted Fable request does not move the session\'s Opus pin', async () => {
  // 'a' has no Fable weekly left; both are fine for Opus, and 'a' is where the
  // Opus band puts the session.
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 },
    { name: 'b', used: 0.2, resetH: 400, fableUsed: 0.05, fableResetH: 400 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
    assert.equal(await send({ model: FABLE, messages: [] }), 200);
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'a'],
    'the Fable diversion relocated the session wholesale');
});

// (c) An advisor request runs both families on ONE account, so it pins both —
// which is only true if the advisor model reaches recordSession.
test('an advisor request pins both families to the account that served it', async () => {
  // The Opus band prefers 'a'; the Fable band, on its own, prefers 'b'.
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.5, fableResetH: 400 },
    { name: 'b', used: 0.2, resetH: 400, fableUsed: 0.05, fableResetH: 50 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send(advisorRequest(OPUS, FABLE)), 200);
    assert.equal(await send({ model: FABLE, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'a'],
    "the advisor's family was not pinned to the account that served it");
});

// (b) The rollover event is settled by the response the client GETS. A request
// that was preempted, failed over and came back to the rolled account settled
// nothing, so the next request preempts again.
test('a rollover settles once the client\'s response came off the rolled account', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200); // pinned to 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;              // 'a' rolls over
    assert.equal(await send({ model: OPUS, messages: [] }), 200); // preempted to 'b'
    // The session is driven back onto 'a' with 'b' out of the picture; with the
    // event settled, 'a' is an ordinary account again and it stays there.
    am.accounts[1].disabled = true;
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
    am.accounts[1].disabled = false;
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'a', 'a'],
    'the settled rollover fired again');
});

test('a rollover the client\'s response came back onto is not settled', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  // 'b' refuses the credential, so the preempted attempt fails over back to 'a'
  // and that is the response the client gets.
  const upstream = scriptedUpstream(({ account }) => ({ status: account === 'b' ? 403 : 200 }));
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200); // pinned to 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;
    assert.equal(await send({ model: OPUS, messages: [] }), 200); // tries 'b', served by 'a'
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'a']);

  // The move never happened, so the event is still owed: with 'b' healthy the
  // very next request preempts again.
  const upstream2 = scriptedUpstream();
  await withProxy(am, upstream2, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.deepEqual(upstream2.hits.map(h => h.account), ['b'],
    'the rollover was banked by a request that came back to the rolled account');
});

// The in-flight hold spans the WHOLE request, retries and streaming body
// included. Without it a multi-minute completion drops out of the active window
// mid-response and the account serving it reads as idle.
test('a session is held in flight for the duration of its request', async () => {
  const am = fleet([{ name: 'a', used: 0.2, resetH: 50 }]);
  let release;
  const held = new Promise(r => { release = r; });
  let observed = null;
  const upstream = { server: null, hits: [] };
  upstream.server = http.createServer(async (req, res) => {
    await new Promise(done => { req.resume(); req.on('end', done); });
    upstream.hits.push({ account: (req.headers['x-api-key'] || '').replace(/^k-/, '') });
    observed = am.sessionTracker.sessions.get('sess-1');
    observed = observed && { inFlight: observed.inFlight };
    await held;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await withProxy(am, upstream, async (send) => {
    const done = send({ model: OPUS, messages: [] });
    setTimeout(release, 50);
    assert.equal(await done, 200);
  });
  assert.deepEqual(observed, { inFlight: 1 },
    'the session was not counted as in flight while its request was upstream');
  assert.equal(am.sessionTracker.sessions.get('sess-1').inFlight, 0, 'the hold was never released');
});

// Two requests for one session overlap during a rollover. The one served off
// the rolled account is overtaken by the slower one failing back onto it, so
// the session ends up where it started — and the event must still be owed.
// Only the in-flight hold can tell the settlement to wait for that.
test('an overlapping sibling does not settle a rollover the session fails back onto', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  let releaseSlow;
  const slowHeld = new Promise(r => { releaseSlow = r; });
  let slowSeen = false;
  const hits = [];
  const upstream = { hits, server: null };
  upstream.server = http.createServer(async (req, res) => {
    await new Promise(done => { req.resume(); req.on('end', done); });
    const account = (req.headers['x-api-key'] || '').replace(/^k-/, '');
    hits.push({ account });
    // The FIRST request to reach 'b' is the slow one, and it is refused, so it
    // fails over back to 'a'. The sibling that follows it onto 'b' succeeds.
    if (account === 'b' && !slowSeen) {
      slowSeen = true;
      await slowHeld;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200); // pinned to 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;               // 'a' rolls over

    const slow = send({ model: OPUS, messages: [] });             // preempted to 'b', held
    while (!slowSeen) await new Promise(r => setTimeout(r, 5));
    assert.equal(await send({ model: OPUS, messages: [] }), 200); // sibling: served by 'b'
    releaseSlow();
    assert.equal(await slow, 200);                                // 403 on 'b' → served by 'a'

    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.equal(hits.at(-1).account, 'b',
    'the session was left on the rolled account with the event already banked');
});

// A request with no session header must not fall over on any of the session
// calls, and must not create session state.
test('a request with no session id routes without touching session state', async () => {
  const am = fleet([{ name: 'a', used: 0.2, resetH: 50 }]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200);
  });
  assert.equal(am.sessionTracker.sessions.size, 0);
  assert.deepEqual(upstream.hits.map(h => h.account), ['a']);
});
