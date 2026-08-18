import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveAccountPin } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

// ── resolveAccountPin (unit) ─────────────────────────────────────────────────

const withIds = (name, accountUuid, orgUuid) => ({ ...oauth(name), accountUuid, orgUuid });

test('resolveAccountPin matches by accountUuid, orgUuid, name and email', () => {
  const am = new AccountManager([
    withIds('me@x.com (Acme)', 'AAA', 'O1'),
    withIds('me@x.com (Beta)', 'AAA', 'O2'),
    withIds('other@x.com', 'BBB', 'O3'),
  ], 0.98);
  assert.equal(resolveAccountPin(am, 'BBB'), 2);              // accountUuid
  assert.equal(resolveAccountPin(am, 'O2'), 1);               // orgUuid
  assert.equal(resolveAccountPin(am, 'me@x.com (Beta)'), 1);  // display name
  assert.equal(resolveAccountPin(am, 'other@x.com'), 2);      // bare email
  assert.equal(resolveAccountPin(am, 'BbB'), 2);              // case-insensitive
});

// One account across several orgs shares an accountUuid, so the qualified form
// is the only way to name the second one; a bare uuid takes the first match.
test('accountUuid/orgUuid selects one account among an org set', () => {
  const am = new AccountManager([
    withIds('me@x.com (Acme)', 'AAA', 'O1'),
    withIds('me@x.com (Beta)', 'AAA', 'O2'),
  ], 0.98);
  assert.equal(resolveAccountPin(am, 'AAA/O2'), 1);
  assert.equal(resolveAccountPin(am, 'AAA/O1'), 0);
  assert.equal(resolveAccountPin(am, 'AAA'), 0);       // first match wins
  assert.equal(resolveAccountPin(am, 'me@x.com'), 0);  // ditto for the email
});

// The rotation index is array position: deleting an account would repoint every
// later pin at a DIFFERENT account, so it is not an accepted pin form.
test('resolveAccountPin does not accept a rotation index', () => {
  const am = new AccountManager([oauth('alpha'), oauth('beta')], 0.98);
  assert.equal(resolveAccountPin(am, '0'), null);
  assert.equal(resolveAccountPin(am, '1'), null);
});

test('resolveAccountPin returns null for an unknown token', () => {
  const am = new AccountManager([oauth('alpha')], 0.98);
  assert.equal(resolveAccountPin(am, 'nope'), null);
  assert.equal(resolveAccountPin(am, ''), null);
  assert.equal(resolveAccountPin(am, '9'), null);
});

test('an account literally named "0" still resolves by name', () => {
  const am = new AccountManager([oauth('x'), { ...oauth('y'), name: '0' }], 0.98);
  assert.equal(resolveAccountPin(am, '0'), 1);
});

// ── end-to-end pin routing (integration) ─────────────────────────────────────

// Stand up a mock upstream that records the path and Authorization it received,
// so we can prove which account a pinned request was routed to and that the
// /tc-acct/<pin> prefix was stripped before forwarding.
async function withProxy(run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([oauth('alpha'), oauth('beta')], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);
  try {
    return await run({ proxyPort, seen, am });
  } finally {
    proxy.close();
    upstream.close();
  }
}

const post = (url) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'x', messages: [] }),
});

test('a /tc-acct/<name> request is routed to that exact account, prefix stripped', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/beta/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/v1/messages');          // prefix stripped
    assert.equal(seen[0].auth, 'Bearer t-beta');         // routed to 'beta', not rotation default
  });
});

test('pinning by numeric index also works', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/alpha/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer t-alpha');
  });
});

test('an unknown pin returns 404 and never reaches upstream', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/ghost/v1/messages`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error.type, 'not_found_error');
    assert.equal(seen.length, 0);
  });
});

test('pinning overrides rotation even when another account is the active one', async () => {
  await withProxy(async ({ proxyPort, seen, am }) => {
    am.currentIndex = 0; // rotation would pick 'alpha'
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/beta/v1/messages`);
    await res.text();
    assert.equal(seen[0].auth, 'Bearer t-beta'); // pin wins over the active account
  });
});

test('a normal (unpinned) request still rotates as before', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].path, '/v1/messages');
    assert.equal(seen[0].auth, 'Bearer t-alpha'); // default rotation → first account
  });
});

// ── the window above forwardRequest answers the socket ────────────────────
// The 502 that guards forwardRequest covers the inner try only. Everything
// above it — the egress hold, this pin parsing, buffering the body, the
// activity hooks — runs under an outer catch that used to log and return,
// leaving the client waiting on a request nobody would ever answer. A hang is
// worse than an error: the client cannot act on it, and Claude Code's own
// timeout is long.
//
// Both tests race a timer, so "no answer" is a result rather than a run that
// never finishes.
async function postWithin(url, ms = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      signal: ac.signal,
    });
    await res.text();
    return res.status;
  } catch (err) {
    if (err.name === 'AbortError') return 'HUNG';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The escaping of a `/tc-acct/` segment is the CLIENT's, so a malformed one is
// an ordinary bad request. It used to throw URIError out of decodeURIComponent.
test('a /tc-acct/ pin with a malformed escape is answered, not left hanging', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    for (const pin of ['%', '%zz', '%E0%A4']) {
      assert.equal(await postWithin(`http://127.0.0.1:${port}/tc-acct/${pin}/v1/messages`), 404,
        `a pin of "${pin}" left the client waiting on a request nobody will answer`);
    }
    // A well-formed but unknown pin is the same answer, which is the point: an
    // undecodable pin is an unusable pin, not an internal error.
    assert.equal(await postWithin(`http://127.0.0.1:${port}/tc-acct/%61%62/v1/messages`), 404);
  } finally {
    console.error = realErr;
    proxy.close();
  }
});

// The property behind that one, held at the seam rather than through the single
// input that happened to reach it: anything that throws in the window is
// answered. `onRequestStart` fires there, above the inner try.
test('a throw above forwardRequest is answered rather than hanging the client', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  let reached = false;
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' }, {
    onRequestStart: () => { reached = true; throw new Error('injected failure above forwardRequest'); },
  });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await postWithin(`http://127.0.0.1:${port}/v1/messages`), 502,
      'a throw above forwardRequest left the client waiting forever');
  } finally {
    console.error = realErr;
    proxy.close();
  }
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
});

// The other half of that catch: it must NOT answer twice. The inner `finally`
// runs `onRequestEnd` after the response has been streamed, so a throw there
// reaches the outer catch with headers already sent — and a second writeHead
// throws ERR_HTTP_HEADERS_SENT from inside the catch itself, which is an
// unhandled rejection rather than a handled error. The client already has its
// answer; the guard is what keeps the recovery from becoming the failure.
test('a throw after the response is streamed does not answer a second time', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([oauth('a')], 0.98);
  let reached = false;
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {
    onRequestEnd: () => { reached = true; throw new Error('injected failure after the response'); },
  });
  const port = await listen(proxy);

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await postWithin(`http://127.0.0.1:${port}/v1/messages`), 200,
      'the client did not get the response the upstream already sent');
    // Give a rejection a turn of the loop to surface before we judge.
    await new Promise(r => setTimeout(r, 50));
  } finally {
    console.error = realErr;
    process.off('unhandledRejection', onRejection);
    proxy.close();
    upstream.close();
  }
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
  assert.deepEqual(rejections.map(e => e.code || e.message), [],
    'the outer catch tried to answer an already-answered request and threw doing it');
});
