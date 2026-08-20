import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder, TextDecoder } from 'node:util';
import { upstreamFetch } from '../src/upstream-fetch.js';
import { readWithIdleTimeout, isTransientUpstreamError } from '../src/server.js';

// Bring up an HTTP server on an ephemeral port and hand back {server, port}.
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

// A half-dead upstream: it accepts the connection but never sends a response —
// exactly what a keep-alive socket becomes after the host's network drops and
// reconnects. Without the headers timeout this hangs until Node's 300s default.
test('fails fast (does not hang) when upstream never sends headers', async () => {
  const { server, port } = await listen(() => { /* never respond */ });

  const start = Date.now();
  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', body: '{}', headersTimeoutMs: 200 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected fast-fail, took ${elapsed}ms`);

  server.close();
});

// The mechanism the whole fix rests on: after a hung request the dead socket is
// dropped from the pool, so the next request to the SAME origin opens a fresh
// connection and succeeds. Same origin is the point: two ports would be two
// pools and prove nothing about eviction. We count TCP connections and assert
// the second request opened a new one rather than reusing the dead keep-alive.
test('evicts the dead socket and reconnects on the same origin', async () => {
  let conns = 0;
  let mode = 'hang';
  const { server, port } = await listen((req, res) => {
    if (mode === 'respond') { res.writeHead(200); res.end('ok'); }
    // else: never respond, simulating a half-dead socket after a network drop
  });
  server.on('connection', () => { conns += 1; });
  const origin = `http://127.0.0.1:${port}/`;

  await assert.rejects(
    () => upstreamFetch(origin, { headersTimeoutMs: 150 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
  );

  mode = 'respond';
  const res = await upstreamFetch(origin, { headersTimeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  // >1 connection proves the dead socket was evicted and a fresh one opened; a
  // reuse of the aborted socket would leave the count at 1 (and hang). undici may
  // open more than one on the abort path, so assert the invariant, not an exact n.
  assert.ok(conns >= 2, `expected a fresh socket after eviction, saw ${conns} connection(s)`);

  server.close();
});

// The headers deadline is headers-only: once headers arrive it is disarmed, so a
// body that streams well past the timeout window is NOT cut off (SSE completions
// run for minutes). Headers here return instantly; the body finishes at ~400ms
// with a 150ms headers timeout.
test('does not cut a slow body once headers have arrived', async () => {
  const { server, port } = await listen(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\n\n');
    await new Promise((r) => setTimeout(r, 400));
    res.write('event: done\n\n');
    res.end();
  });

  const res = await upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 150 });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /done/); // full body read, not aborted at 150ms

  server.close();
});

// Mid-stream recovery (extends the PR): once headers have arrived the headers
// timeout is disarmed, so a drop DURING the body would hang forever. The
// body-idle watchdog in streamResponse guards each read. Here the stream yields
// one chunk then goes silent; the second read must fail fast with a transient
// TEAMCLAUDE_BODY_TIMEOUT (which server.js treats as retryable) rather than hang.
test('body watchdog fails fast when the stream goes silent mid-body', async () => {
  // readWithIdleTimeout's watchdog is unref'd (in production the listening socket
  // keeps the loop alive; here this test has no socket of its own), so hold a
  // ref'd handle for the test's duration or the loop can drain before it fires.
  const alive = setInterval(() => {}, 60_000);
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\n\n'));
        // never enqueue again and never close — a mid-stream network drop
      },
    });
    const reader = stream.getReader();

    // First chunk is already buffered: resolves immediately, no timeout.
    const first = await readWithIdleTimeout(reader, 200);
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), 'event: ping\n\n');

    // Second read: the stream is silent, so the watchdog fires fast.
    const start = Date.now();
    await assert.rejects(
      () => readWithIdleTimeout(reader, 200),
      (err) => err.code === 'TEAMCLAUDE_BODY_TIMEOUT',
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected fast body-timeout, took ${elapsed}ms`);
  } finally {
    clearInterval(alive);
  }
});

// The watchdog must not fire on a healthy-but-slow stream: a chunk that arrives
// within the window resets nothing artificially — it simply resolves.
test('body watchdog does not fire when chunks keep arriving', async () => {
  const alive = setInterval(() => {}, 60_000); // see note above: keep the loop alive
  try {
    let pushed = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (pushed) { controller.close(); return; }
        pushed = true;
        return new Promise((resolve) => setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('event: ok\n\n'));
          resolve();
        }, 100));
      },
    });
    const reader = stream.getReader();

    const r = await readWithIdleTimeout(reader, 500); // 100ms chunk < 500ms window
    assert.equal(r.done, false);
    assert.match(new TextDecoder().decode(r.value), /ok/);
  } finally {
    clearInterval(alive);
  }
});

// ── a failure of the HOST is not a failure of the ACCOUNT ─────────────────
// The hostname has no per-account component, so a name-resolution failure gives
// every account the same answer. Failing over is wasted work, and worse than
// wasted: it turns a network hiccup into what reads as a fleet-wide outage, and
// makes a log of N such lines look like N requests when it was one.
//
// Measured before this was classified: one client request against an
// unresolvable upstream produced four "Upstream error" lines on a four-account
// fleet and answered the client 429.

const enotfound = () => Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
const withCode = (code) => Object.assign(new Error(`${code} while connecting`), { code });
// Node's happy-eyeballs dialer reports an all-addresses-failed connect like
// this. `message` is '' by construction and there may be no top-level code.
const aggregate = (codes) => new AggregateError(codes.map(withCode), '');

test('a name-resolution failure is transient, not an account to fail over from', () => {
  assert.equal(isTransientUpstreamError(enotfound()), true,
    'a DNS failure marches the whole fleet before answering');
  assert.equal(isTransientUpstreamError(withCode('EAI_AGAIN')), true,
    'a temporary resolver failure marches the whole fleet');
});

test('a host or network that cannot be reached is transient too', () => {
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']) {
    assert.equal(isTransientUpstreamError(withCode(code)), true, `${code} failed the fleet over`);
  }
  // A broken pipe is the write-side sibling of ECONNRESET: a dead socket, not a
  // dead account.
  assert.equal(isTransientUpstreamError(withCode('EPIPE')), true);
});

// ...unless failing over would actually dial somewhere else. An account may name
// its own `upstream`, and a name that will not resolve for one host says nothing
// about a different one.
test('a host failure IS worth failing over when another account dials a different host', () => {
  assert.equal(isTransientUpstreamError(enotfound(), { otherHostAvailable: true }), false,
    'a fleet with a third-party backend lost its failover on a DNS error');
  // A socket-level failure stays transient either way: it is about this
  // connection, and another host cannot fix a reset one.
  assert.equal(isTransientUpstreamError(withCode('ECONNRESET'), { otherHostAvailable: true }), true);
  // ECONNREFUSED stays UNCONDITIONAL, even though "nothing listening at
  // host:port" is arguably a property of the host. It was unconditionally
  // transient before this classification existed, so routing it through the
  // condition turns every gap in `otherHostAvailable` into a regression rather
  // than an unfixed case — measured, a disabled account with its own upstream
  // made a four-account fleet march. See docs/RESIDUALS.md.
  assert.equal(isTransientUpstreamError(withCode('ECONNREFUSED')), true);
  assert.equal(isTransientUpstreamError(withCode('ECONNREFUSED'), { otherHostAvailable: true }), true,
    'a refused connection became conditional again, which regresses every gap in the condition');
});

// The reason the codes are read from the children as well.
test('an all-addresses-failed connect is classified from its children', () => {
  assert.equal(isTransientUpstreamError(aggregate(['ENOTFOUND', 'ENOTFOUND'])), true,
    'an AggregateError carrying no top-level code failed the whole fleet over');
  assert.equal(isTransientUpstreamError(aggregate(['ECONNREFUSED', 'ECONNREFUSED'])), true);
  // And through `cause`, which is where Node's global fetch puts the real error.
  assert.equal(isTransientUpstreamError(Object.assign(new TypeError('boom'), { cause: enotfound() })), true);
});

test('an error that is genuinely about the account still fails over', () => {
  assert.equal(isTransientUpstreamError(new Error('upstream proxy refused CONNECT: HTTP/1.1 407')), false);
  assert.equal(isTransientUpstreamError(withCode('CERT_HAS_EXPIRED')), false);
  assert.equal(isTransientUpstreamError('not an error at all'), false);
});

// ── the whole classifier, table-driven ────────────────────────────────────
// "Unit-tested over every code" was false: six of the nine socket-scoped codes
// were held by nothing, including TEAMCLAUDE_HEADERS_TIMEOUT and
// TEAMCLAUDE_BODY_TIMEOUT — the codes THIS FILE's own watchdogs raise, whose
// entire purpose is "close the connection, do not march the fleet". Shrinking
// the set to three left the suite green. So the table names every arm, and a
// code dropped from either set fails here rather than silently starting to burn
// the fleet on a timeout.
//
// `otherHostAvailable` is varied per row because it is the whole difference
// between the two sets: socket-scoped codes ignore it, host-scoped ones do not.
const CLASSIFIER_TABLE = [
  // [label, error, otherHostAvailable, expected transient?]
  ['ECONNRESET', withCode('ECONNRESET'), false, true],
  ['ECONNRESET, another host available', withCode('ECONNRESET'), true, true],
  ['ECONNREFUSED', withCode('ECONNREFUSED'), false, true],
  ['ECONNREFUSED, another host available', withCode('ECONNREFUSED'), true, true],
  ['ETIMEDOUT', withCode('ETIMEDOUT'), false, true],
  ['ETIMEDOUT, another host available', withCode('ETIMEDOUT'), true, true],
  ['EPIPE', withCode('EPIPE'), false, true],
  ['UND_ERR_CONNECT_TIMEOUT', withCode('UND_ERR_CONNECT_TIMEOUT'), false, true],
  ['UND_ERR_HEADERS_TIMEOUT', withCode('UND_ERR_HEADERS_TIMEOUT'), false, true],
  ['UND_ERR_BODY_TIMEOUT', withCode('UND_ERR_BODY_TIMEOUT'), false, true],
  // Our own watchdogs. If these ever fail over, a slow upstream costs the fleet.
  ['TEAMCLAUDE_HEADERS_TIMEOUT', withCode('TEAMCLAUDE_HEADERS_TIMEOUT'), false, true],
  ['TEAMCLAUDE_HEADERS_TIMEOUT, another host', withCode('TEAMCLAUDE_HEADERS_TIMEOUT'), true, true],
  ['TEAMCLAUDE_BODY_TIMEOUT', withCode('TEAMCLAUDE_BODY_TIMEOUT'), false, true],
  ['TEAMCLAUDE_BODY_TIMEOUT, another host', withCode('TEAMCLAUDE_BODY_TIMEOUT'), true, true],
  // The name arm: an abort or a timeout carries no code of ours.
  ['name TimeoutError', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), false, true],
  ['name AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), false, true],
  ['name AbortError, another host', Object.assign(new Error('aborted'), { name: 'AbortError' }), true, true],
  // The message arm: Node's global fetch reports everything as this.
  ['message "fetch failed"', new TypeError('fetch failed'), false, true],
  // Host-scoped: the only codes `otherHostAvailable` may change the answer for.
  ['ENOTFOUND', withCode('ENOTFOUND'), false, true],
  ['ENOTFOUND, another host available', withCode('ENOTFOUND'), true, false],
  ['EAI_AGAIN', withCode('EAI_AGAIN'), false, true],
  ['EAI_AGAIN, another host available', withCode('EAI_AGAIN'), true, false],
  ['EHOSTUNREACH', withCode('EHOSTUNREACH'), false, true],
  ['EHOSTUNREACH, another host available', withCode('EHOSTUNREACH'), true, false],
  ['ENETUNREACH', withCode('ENETUNREACH'), false, true],
  ['ENETUNREACH, another host available', withCode('ENETUNREACH'), true, false],
  ['ENETDOWN', withCode('ENETDOWN'), false, true],
  ['ENETDOWN, another host available', withCode('ENETDOWN'), true, false],
  // Genuinely about this account or this request: fail over.
  ['an unclassified transport error', new Error('upstream proxy refused CONNECT: HTTP/1.1 407'), false, false],
  ['CERT_HAS_EXPIRED', withCode('CERT_HAS_EXPIRED'), false, false],
  ['CERT_HAS_EXPIRED, another host', withCode('CERT_HAS_EXPIRED'), true, false],
  ['not an Error at all', 'a string', false, false],
];

test('every arm of the upstream-error classifier is pinned', () => {
  for (const [label, err, otherHostAvailable, expected] of CLASSIFIER_TABLE) {
    assert.equal(isTransientUpstreamError(err, { otherHostAvailable }), expected,
      `${label}: expected ${expected ? 'transient (close, let the client retry)' : 'failover'}`);
  }
  // A positive control on the table itself: it must contain rows that go BOTH
  // ways, or a predicate stuck on one answer would satisfy every row.
  const outcomes = new Set(CLASSIFIER_TABLE.map(r => r[3]));
  assert.equal(outcomes.size, 2, 'the table only asserts one outcome, so it cannot detect a stuck predicate');
});
