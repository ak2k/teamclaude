import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SESSION_KNOWN_TTL_MS } from '../src/session-tracker.js';

// Session-aware routing is decided across three separate calls the server makes
// per request — select, recordSession, confirmRouted — inside the beginSession
// / endSession pair that brackets them. A test that makes those calls itself
// validates its own ordering, not the server's, and every one of them is a line
// that can be dropped from src/server.js without any such test noticing. These
// drive the real server for that reason.
//
// If you extend this file, two things about grading it are worth knowing,
// because both once produced a clean bill that was not one:
//
//   - Some of these mutations do not FAIL, they run away. Dropping the
//     per-request exclusion set makes failover re-offer an account the request
//     already tried, and the retry loop then logs until it drowns the runner's
//     stdout buffer — which reads, on truncated output, as a mutation nothing
//     caught. A grader has to treat a run that cannot finish as a caught
//     mutation, not a passing one. Two tests below bound their refusing
//     upstream so the outcome is a wrong hit sequence instead; stock 403 tests
//     still loop.
//   - A test here can hang the harness meant to grade it. The overlapping-
//     sibling test waits for a preemption to reach the second account, and
//     under a mutation that changes routing it may never arrive; the wait is
//     bounded and the latch released in a `finally` for that reason.

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
//
// The `{ a: 0.5/50h, b: 0.1/60h }` pair below recurs throughout this file and
// expiry-pressure.test.js, and it puts 'a' EXACTLY on the pressure band's
// tolerance floor — (1-0.5)/50h is precisely ((1-0.1)/60h) / 1.5. It stays in
// the band because a fixture is always built before it is scored, so the
// elapsed time between is non-negative. Stable, but on the line: changing the
// tolerance default or the pressure formula moves these tests as a group.
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
  // and that is the response the client gets. The refusal stops after two hits
  // so that a failover which re-offers an account it already tried terminates
  // and can be asserted on, instead of looping.
  const upstream = scriptedUpstream(({ account, hit }) => ({ status: account === 'b' && hit <= 2 ? 403 : 200 }));
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
    let slow;
    try {
      assert.equal(await send({ model: OPUS, messages: [] }), 200); // pinned to 'a'
      am.accounts[0].quota.unified7d = 0;
      am.accounts[0].quota.unified7dReset += 168 * H;               // 'a' rolls over

      slow = send({ model: OPUS, messages: [] });                   // preempted to 'b', held
      const deadline = Date.now() + 5000;
      while (!slowSeen) {
        assert.ok(Date.now() < deadline, `the rollover never preempted onto 'b': ${JSON.stringify(hits)}`);
        await new Promise(r => setTimeout(r, 5));
      }
      assert.equal(await send({ model: OPUS, messages: [] }), 200); // sibling: served by 'b'
    } finally {
      // Whatever happened above, nothing may be left waiting on this latch or
      // the run never ends.
      releaseSlow();
      await slow?.catch(() => {});
    }
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.equal(hits.at(-1).account, 'b',
    'the session was left on the rolled account with the event already banked');
});

// The advisor's model constrains WHICH account may serve the request, not just
// what gets pinned afterwards: the sub-inference runs on the same account, so
// one that cannot serve it must not be chosen while one that can is available.
test('an account that cannot serve the advisor model is not selected', async () => {
  // The Opus band prefers 'a', but 'a' has no Fable weekly left.
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 },
    { name: 'b', used: 0.2, resetH: 400, fableUsed: 0.05, fableResetH: 400 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
    assert.equal(await send(advisorRequest(OPUS, FABLE), { 'x-claude-code-session-id': 'sess-2' }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b'],
    'the advisor request landed on the account that cannot run the advisor');
});

// The degrade path: with no jointly-eligible account the advisor call is
// dropped upstream, so the account served the executor alone and must not be
// left holding the advisor family's pin.
test('a degraded advisor request does not pin the family it never served', async () => {
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 50, fableUsed: 0.99, fableResetH: 50 },  // no Fable
    { name: 'b', used: 0.99, resetH: 50, fableUsed: 0.05, fableResetH: 60 }, // no Opus
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send(advisorRequest(OPUS, FABLE)), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a']);
  assert.equal(am.sessionTracker.pinnedAccount('sess-1', 'unified7d'), 0);
  assert.equal(am.sessionTracker.pinnedAccount('sess-1', 'unified7dFable'), null,
    'the dropped advisor family was pinned to the account that never served it');
});

// The current-account walk owns its own rollover event. A request routed by it
// settles that event; the previous test's session traffic must not.
test('a session-less request settles the current account\'s rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // baseline on 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // re-ranked to 'b'
    am.accounts[1].disabled = true;
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // back to 'a'
    am.accounts[1].disabled = false;
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'a', 'a'],
    'the settled rollover fired again');
});

test('a session\'s request does not settle the current account\'s rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  // Every account is out of Opus band once 'a' rolls except 'b', so the session
  // lands on 'b' — off the rolled account, which is exactly what would look
  // like the current-account walk having acted if it were allowed to confirm it.
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // baseline on 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;
    assert.equal(await send({ model: OPUS, messages: [] }), 200);     // a session's request
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // the walk still owes a move
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'b'],
    'a session\'s request consumed the current account\'s rollover');
});

// The per-request exclusion set is what stops failover re-offering an account
// this request has already tried and had refused.
test('a failed-over request is not routed back onto the account it just tried', async () => {
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.2, resetH: 60 },
  ]);
  // 'a' refuses the credential. The upstream stops refusing after a few hits so
  // a selection that ignores the exclusion set terminates and can be asserted
  // on, rather than looping the test runner.
  const upstream = scriptedUpstream(({ account, hit }) => ({ status: account === 'a' && hit <= 3 ? 403 : 200 }));
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b'],
    'the request was offered an account it had already tried');
});

// The pin has to name the account that served the request, which under session
// distribution is not the fleet's current account.
test('the pin names the account that served, not the fleet\'s current one', async () => {
  const am = fleet([
    { name: 'a', used: 0.9, resetH: 50 },  // currentIndex starts here
    { name: 'b', used: 0.1, resetH: 60 },  // but the band sends the session to 'b'
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.equal(am.currentIndex, 0, 'the session path must not have moved currentIndex');
  assert.deepEqual(upstream.hits.map(h => h.account), ['b', 'b'],
    'the session was pinned to an account that never served it');
});

// Settlement is per bucket, so the confirmation has to say which buckets the
// request spent. Told nothing, it settles the shared weekly for a Fable request
// and the Fable event stays owed forever.
test('a Fable request settles the Fable bucket\'s rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 300, fableUsed: 0.3, fableResetH: 50 },
    { name: 'b', used: 0.2, resetH: 300, fableUsed: 0.3, fableResetH: 55 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: FABLE, messages: [] }), 200); // Fable pinned to 'a'
    am.accounts[0].quota.unified7dFable = 0;
    am.accounts[0].quota.unified7dFableReset += 168 * H;           // 'a' rolls its Fable window
    assert.equal(await send({ model: FABLE, messages: [] }), 200); // preempted to 'b'
    am.accounts[1].disabled = true;
    assert.equal(await send({ model: FABLE, messages: [] }), 200); // driven back onto 'a'
    am.accounts[1].disabled = false;
    assert.equal(await send({ model: FABLE, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'a', 'a'],
    'the Fable rollover was settled against some other bucket');
});

test('an advisor request settles the advisor family\'s rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 300, fableUsed: 0.3, fableResetH: 50 },
    { name: 'b', used: 0.2, resetH: 300, fableUsed: 0.3, fableResetH: 55 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: FABLE, messages: [] }), 200); // Fable pinned to 'a'
    am.accounts[0].quota.unified7dFable = 0;
    am.accounts[0].quota.unified7dFableReset += 168 * H;
    am.accounts[1].disabled = true;
    assert.equal(await send({ model: FABLE, messages: [] }), 200); // detected, nowhere to move
    am.accounts[1].disabled = false;
    // An Opus request carrying a Fable advisor: it spends the Fable bucket on
    // whatever serves it, so being served off 'a' is what settles that event.
    assert.equal(await send(advisorRequest(OPUS, FABLE)), 200);
    am.accounts[1].disabled = true;
    assert.equal(await send({ model: FABLE, messages: [] }), 200); // back onto 'a'
    am.accounts[1].disabled = false;
    assert.equal(await send({ model: FABLE, messages: [] }), 200);
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'a', 'b', 'a', 'a'],
    'the advisor request did not settle the family it spent');
});

// Confirmation belongs after every branch that retries, not at selection: an
// attempt that is re-routed and then fails back has moved nothing.
test('a current-account attempt that failed back does not settle its rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  // 'b' refuses the credential the first time it is tried, so the preempted
  // attempt fails over back to 'a' and that is the response the client gets.
  let refusedOnce = false;
  const upstream = scriptedUpstream(({ account }) => {
    if (account === 'b' && !refusedOnce) { refusedOnce = true; return { status: 403 }; }
    return { status: 200 };
  });
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // baseline on 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // tries 'b', served by 'a'
    assert.equal(await send({ model: OPUS, messages: [] }, {}), 200); // still owed → moves
  });
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'a', 'b'],
    'an attempt that never reached the client settled the rollover');
});

// endSession is in a `finally`, and only that placement covers the path where
// the request throws. Everything downstream of the hold now depends on it: the
// hold is what defers settlement (endSession settles only at inFlight === 0),
// what keeps a session from expiring on the idle TTL, and what the cap's
// eviction probe deliberately spares. A hold that is never released therefore
// strands the session's pending rollover forever, leaks the record past its
// TTL, and makes it the one entry eviction will not reclaim — three of this
// branch's bug classes from a single thrown request.
//
// The throw is injected on recordSession because that is a real call the
// request path makes after the hold is taken and outside forwardRequest's own
// catch, which is where an unforeseen internal error would surface. Which call
// throws is not the point; that any of them can is.
test('a request that throws still releases the session\'s in-flight hold', async () => {
  const am = fleet([{ name: 'a', used: 0.2, resetH: 50 }]);
  const realRecord = am.recordSession.bind(am);
  let reached = false;
  am.recordSession = (...args) => {
    realRecord(...args);
    reached = true;
    throw new Error('injected failure on the request path');
  };
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 502);
  });
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
  const s = am.sessionTracker.sessions.get('sess-1');
  assert.ok(s, 'the session record went away entirely');
  assert.equal(s.inFlight, 0,
    'a thrown request left the session held in flight: it can never settle a rollover, never expire on the idle TTL, and is the entry eviction spares');
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

// The hold is released on EVERY exit from the request, and three separate
// invariants downstream of it depend on that. The test above proves the
// release; these three name what a stuck hold breaks, because that is what a
// failure would actually look like from outside.
async function driveThrowingRequest(am, before = 0) {
  const upstream = scriptedUpstream();
  const realConsoleError = console.error;
  console.error = () => {};                 // the 502 path logs; keep the run readable
  try {
    await withProxy(am, upstream, async (send) => {
      for (let i = 0; i < before; i++) assert.equal(await send({ model: OPUS, messages: [] }), 200);
      const realRecord = am.recordSession.bind(am);
      am.recordSession = (...args) => { realRecord(...args); throw new Error('injected failure on the request path'); };
      assert.equal(await send({ model: OPUS, messages: [] }), 502,
        'the fixture never reached the unhandled-error path');
      am.recordSession = realRecord;
    });
  } finally {
    console.error = realConsoleError;
  }
  return upstream;
}

test('a thrown request leaves no session immortal, always-active or unevictable', async () => {
  const am = fleet([{ name: 'a', used: 0.2, resetH: 50 }]);
  await driveThrowingRequest(am);
  const st = am.sessionTracker;
  const later = Date.now() + SESSION_KNOWN_TTL_MS * 2;
  st.sweep(later);
  assert.equal(st.sessions.has('sess-1'), false,
    'the record outlived the known window because inFlight never returned to zero');
  assert.equal(st.stats(later).active, 0,
    'the session counts as active load on its account forever');
  assert.equal(st.activeCountFor(0, later), 0,
    'the account it touched carries a phantom session in the load metric that spreads new ones');
});

// Settlement waits for the session to fall quiet, so a hold that is never
// released is also a rollover that never settles.
test('a thrown request does not strand the session\'s pending rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  const upstream = scriptedUpstream();
  await withProxy(am, upstream, async (send) => {
    assert.equal(await send({ model: OPUS, messages: [] }), 200);   // pinned to 'a'
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;                 // 'a' rolls over
    const realRecord = am.recordSession.bind(am);
    const realConsoleError = console.error;
    console.error = () => {};
    am.recordSession = (...args) => { realRecord(...args); throw new Error('injected failure on the request path'); };
    assert.equal(await send({ model: OPUS, messages: [] }), 502);
    am.recordSession = realRecord;
    console.error = realConsoleError;
    // The next request completes normally, so the session is quiet again and the
    // event has to settle.
    assert.equal(await send({ model: OPUS, messages: [] }), 200);
  });
  assert.equal(am.getStatus().expiryRouting.stats.rolloversOwed, 0,
    'an earlier thrown request held the session open, so the rollover never settled');
});

// The /tc-acct/ path forces an account and never calls selection at all, so it
// has no decision to hand on. Given one, it settles the current-account walk's
// event without that walk having acted — leaving `current` parked on the
// account that just gained a full week.
test('a /tc-acct/ pinned request does not settle the current account\'s rollover', async () => {
  const am = fleet([
    { name: 'a', used: 0.5, resetH: 50 },
    { name: 'b', used: 0.1, resetH: 60 },
  ]);
  const upstream = scriptedUpstream();
  const upstreamPort = await listen(upstream.server);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const sendTo = async (path) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },   // no session id: the current-account walk
      body: JSON.stringify({ model: OPUS, messages: [] }),
    });
    await res.text();
    return res.status;
  };
  try {
    assert.equal(await sendTo('/v1/messages'), 200);        // baseline on 'a'
    am.accounts[1].disabled = true;
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;        // 'a' rolls, nowhere to move
    assert.equal(await sendTo('/v1/messages'), 200);
    assert.equal(am.getStatus().expiryRouting.stats.rolloversOwed, 1,
      'the rollover was never owed, so this proves nothing');
    am.accounts[1].disabled = false;
    assert.equal(await sendTo('/tc-acct/b/v1/messages'), 200);
    assert.equal(am.getStatus().expiryRouting.stats.rolloversOwed, 1,
      'a pinned request settled an event the current-account walk never acted on');
    assert.equal(await sendTo('/v1/messages'), 200);
  } finally {
    proxy.close();
    upstream.server.close();
  }
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'a', 'b', 'b'],
    'the walk did not move off the rolled account once it could');
});

// The 403 branch recurses without a retryCount guard, unlike its three sibling
// retry paths — deliberately. Those retry the SAME account after a condition a
// retry can fix, so they need a count; this one excludes the account for the
// rest of the request, so `ctx.tried` bounds it at one attempt per account. That
// is the stronger bound (a fleet whose first few accounts are refused still
// reaches the healthy ones, which a count below the account total would not),
// and it is the bound this holds — nothing else asserts that the 403 path adds
// to the exclusion set at all.
//
// The upstream stops refusing after a dozen hits so a failover that had lost its
// bound terminates and can be asserted on, instead of hanging the runner.
test('a fleet answering 403 is tried once per account, then reported', async () => {
  const am = fleet([
    { name: 'a', used: 0.2, resetH: 50 },
    { name: 'b', used: 0.2, resetH: 60 },
    { name: 'c', used: 0.2, resetH: 70 },
  ]);
  const upstream = scriptedUpstream(({ hit }) => ({ status: hit <= 12 ? 403 : 200 }));
  const realConsoleError = console.error;
  console.error = () => {};
  try {
    await withProxy(am, upstream, async (send) => {
      assert.equal(await send({ model: OPUS, messages: [] }), 502,
        'the client was shown the upstream 403 it cannot act on');
    });
  } finally {
    console.error = realConsoleError;
  }
  assert.deepEqual(upstream.hits.map(h => h.account), ['a', 'b', 'c'],
    'a refused account was offered to the same request twice');
});
