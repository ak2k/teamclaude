import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/switch is the headless equivalent of picking an account with
// 's' in the TUI: both go through the manager's one currentIndex writer. The
// TUI is not reachable when the proxy runs as a background service, which is
// what this endpoint exists for. currentIndex is a weak preference — selection drops it
// when the account is unavailable and also when an available account has a
// lower priority value — so "recorded" and "in effect" are tested separately.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1', accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
  { name: 'bob@example.com (Acme)', type: 'apikey', apiKey: 'k2', accountUuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
];

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function withServer(fn, hooks = {}) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(am, port, proxy);
  } finally {
    proxy.close();
  }
}

test('switch moves currentIndex and answers with the resolved account name', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.account, 'bob@example.com (Acme)');
    assert.equal(am.currentIndex, 1);
  });
});

test('switch accepts the same account forms as a pin (uuid, bare email)', async () => {
  await withServer(async (am, port) => {
    assert.equal((await post(port, JSON.stringify({ account: 'bbbbbbbb-0000-0000-0000-000000000002' }))).status, 200);
    assert.equal(am.currentIndex, 1);
    assert.equal((await post(port, JSON.stringify({ account: 'alice@example.com' }))).status, 200);
    assert.equal(am.currentIndex, 0);
  });
});

test('the status endpoint reports the switched account', async () => {
  await withServer(async (am, port) => {
    await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    const status = await res.json();
    assert.equal(status.currentAccount, 'bob@example.com (Acme)');
    assert.equal(am.currentIndex, 1);
  });
});

test('an unknown account is refused with 404 and the valid names', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'nobody@example.com' }));
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /nobody@example\.com/);
    assert.deepEqual(res.body.accounts, ['alice@example.com', 'bob@example.com (Acme)']);
    assert.equal(am.currentIndex, 0, 'a refused switch must not move the current account');
  });
});

// The rotation index is array position, so accepting it would silently repoint a
// script at a DIFFERENT account after a removal. resolveAccountPin refuses it and
// the endpoint inherits that.
test('a numeric rotation index is not an account name', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: '1' }));
    assert.equal(res.status, 404);
    assert.equal(am.currentIndex, 0);
  });
});

test('a missing or blank account field is a 400, not a switch', async () => {
  await withServer(async (am, port) => {
    for (const body of ['{}', JSON.stringify({ account: '' }), JSON.stringify({ account: '   ' }), JSON.stringify({ account: 7 })]) {
      const res = await post(port, body);
      assert.equal(res.status, 400, body);
      assert.equal(res.body.ok, false, body);
    }
    assert.equal(am.currentIndex, 0);
  });
});

test('a malformed body is a 400, not a crash', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, 'not json');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(am.currentIndex, 0);
  });
});

// A switch that cannot take effect must not report a bare success. currentIndex
// still moves (that is the TUI's behaviour), but selection skips an unavailable
// account on the very next request, so the answer says whether traffic will
// actually follow the choice.
test('switching to a disabled account succeeds but reports it as ineligible', async () => {
  const am = new AccountManager([
    { name: 'live@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'off@example.com', type: 'apikey', apiKey: 'k2', disabled: true },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await post(port, JSON.stringify({ account: 'off@example.com' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, 'the switch is still recorded, as in the TUI');
    assert.equal(res.body.account, 'off@example.com');
    assert.equal(res.body.eligible, false);
    assert.match(res.body.reason, /disabled/);
    assert.equal(am.currentIndex, 1, 'currentIndex moves even when ineligible');
    // Proof the report is not pedantic: the next selection abandons the choice.
    assert.equal(am.getActiveAccount().name, 'live@example.com');
  } finally {
    proxy.close();
  }
});

test('switching to a usable account reports it as eligible', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    assert.equal(res.body.eligible, true);
    assert.equal(res.body.reason, undefined, 'no reason when nothing is wrong');
    assert.equal(am.getActiveAccount().name, 'bob@example.com (Acme)');
  });
});

// Unavailability is not the only way a switch gets undone. A perfectly healthy
// account is dropped just as fast when another available account outranks it on
// priority, so "eligible" has to answer the real question — would a request go
// here — rather than only "is this account usable at all".
test('a switch that priority will immediately override is reported as ineligible', async () => {
  const am = new AccountManager([
    { name: 'high@example.com', type: 'apikey', apiKey: 'k1', priority: 0 },
    { name: 'low@example.com', type: 'apikey', apiKey: 'k2', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await post(port, JSON.stringify({ account: 'low@example.com' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, 'the switch is still recorded');
    assert.equal(res.body.eligible, false, 'a preempted target is not where traffic will go');
    assert.match(res.body.reason, /priority/i);
    assert.match(res.body.reason, /high@example\.com/, 'name the account that wins');
    assert.equal(am.currentIndex, 1, 'currentIndex still moves');
    // Proof the report is not pedantic: selection hands it straight back.
    assert.equal(am.getActiveAccount().name, 'high@example.com');
  } finally {
    proxy.close();
  }
});

test('switching to the highest-priority account is eligible', async () => {
  const am = new AccountManager([
    { name: 'high@example.com', type: 'apikey', apiKey: 'k1', priority: 0 },
    { name: 'low@example.com', type: 'apikey', apiKey: 'k2', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    am.currentIndex = 1;
    const res = await post(port, JSON.stringify({ account: 'high@example.com' }));
    assert.equal(res.body.eligible, true);
    assert.equal(res.body.reason, undefined);
    assert.equal(am.getActiveAccount().name, 'high@example.com');
  } finally {
    proxy.close();
  }
});

// Equal priority must NOT read as preemption, or every default fleet would
// report its own current account as ineligible.
test('accounts at the same priority do not preempt each other', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    assert.equal(res.body.eligible, true);
    assert.equal(am.getActiveAccount().name, 'bob@example.com (Acme)');
  });
});

test('an over-limit body is refused as 413 without echoing parser internals', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'a'.repeat(70_000) }));
    assert.equal(res.status, 413);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /too large/);
    assert.equal(am.currentIndex, 0);
  });
});

// The log line is the only record of a manual switch on a headless server, so a
// refactor that drops it must fail something.
test('a successful switch is logged, and says so when the target is ineligible', async () => {
  const am = new AccountManager([
    { name: 'live@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'off@example.com', type: 'apikey', apiKey: 'k2', disabled: true },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await post(port, JSON.stringify({ account: 'live@example.com' }));
    await post(port, JSON.stringify({ account: 'off@example.com' }));
  } finally {
    console.log = origLog;
    proxy.close();
  }
  assert.ok(lines.some(l => l.includes('live@example.com') && /switch/i.test(l)), lines.join(' | '));
  const offLine = lines.find(l => l.includes('off@example.com'));
  assert.ok(offLine, lines.join(' | '));
  assert.match(offLine, /disabled/, 'the log must not claim a clean switch to an unusable account');
});

// Loopback is exempt from the proxy-key gate (that is what makes the fetch-based
// tests above work), so the gate itself has to be exercised with a remote peer.
function remoteRequest(server, { headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/teamclaude/switch';
  req.headers = headers;
  req.socket = { remoteAddress: '203.0.113.9' };

  const res = {
    status: null,
    chunks: '',
    writeHead(status) { this.status = status; return this; },
    end(chunk) { if (chunk) this.chunks += chunk; this._done(); },
  };
  const finished = new Promise(resolve => { res._done = resolve; });
  server.emit('request', req, res);
  return finished.then(() => ({ status: res.status, body: JSON.parse(res.chunks || '{}') }));
}

test('a remote client without the proxy key cannot switch', async () => {
  await withServer(async (am, port, server) => {
    const res = await remoteRequest(server, { body: JSON.stringify({ account: 'bob@example.com (Acme)' }) });
    assert.equal(res.status, 401);
    assert.equal(am.currentIndex, 0);
  });
});

test('a remote client with the proxy key can switch', async () => {
  await withServer(async (am, port, server) => {
    const res = await remoteRequest(server, {
      headers: { 'x-api-key': 'tc-test' },
      body: JSON.stringify({ account: 'bob@example.com (Acme)' }),
    });
    assert.equal(res.status, 200);
    assert.equal(am.currentIndex, 1);
  });
});

// A manual switch establishes an account, which is the same act rotation
// performs — so it carries the same rollover baseline. Without one the account
// an operator parked the fleet on first-sights its own window, and the roll
// that should have moved the fleet off it is invisible for the rest of the week.
test('the switch endpoint establishes its account as a rollover baseline', async () => {
  const H = 3600_000;
  const now = Date.now();
  const am = new AccountManager([
    { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
    { name: 'c@example.com', type: 'apikey', apiKey: 'k3' },
  ], 0.98, { expiryRouting: { enabled: true } });
  const weekly = [[0.2, 50], [0.5, 60], [0.1, 70]];
  am.accounts.forEach((acct, i) => {
    acct.quota.unified7d = weekly[i][0];
    acct.quota.unified7dReset = now + weekly[i][1] * H;
    acct.probing = false;
  });
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    assert.equal((await post(port, JSON.stringify({ account: 'b@example.com' }))).status, 200);
    assert.equal(am.currentIndex, 1);
    am.accounts[1].quota.unified7d = 0;
    am.accounts[1].quota.unified7dReset += 168 * H; // 'b' rolls over a week out
    assert.notEqual(am.getActiveAccount(null, 'claude-opus-5').name, 'b@example.com',
      'the account the switch established first-sighted its own window, so its roll never fired');
    assert.equal(am.getStatus().expiryRouting.stats.rolloversDetected, 1);
  } finally {
    proxy.close();
  }
});

// The control-plane listener has its own outer catch, wrapping the auth gate,
// the CSRF gate, the forward-proxy relay and status/reload/switch. It had the
// same defect as the proxied one 350 lines below: log and drop, client hangs.
// `getStatusExtra` is a hook the application installs, so the throw surface is
// real rather than hypothetical — and this branch enlarged it, turning the
// switch endpoint from a property write into a call that reaches the account
// manager.
test('a throwing status hook is answered, not left hanging', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  let reached = false;
  const proxy = createProxyServer(am, CONFIG, {
    getStatusExtra: () => { reached = true; throw new Error('status hook blew up'); },
  });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    let status;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: ac.signal });
      await res.text();
      status = res.status;
    } catch (err) {
      status = err.name === 'AbortError' ? 'HUNG' : `transport: ${err.message}`;
    }
    clearTimeout(timer);
    assert.equal(status, 502, 'a throwing status hook left the client waiting forever');
  } finally {
    console.error = realErr;
    proxy.close();
  }
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
});

// An open activity entry has to be closed by SOMETHING. Only the inner path has
// a `finally`, so a throw above it used to leave the row open in every
// consumer: the TUI holds it in `active` (and never idles while one remains),
// headless holds it in `inFlight`. The ordinary trigger is a client cancelling
// mid-body — Ctrl+C in Claude Code — on a daemon that runs for weeks.
test('a request aborted mid-body closes its activity entry', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const started = [];
  const ended = [];
  const proxy = createProxyServer(am, CONFIG, {
    onRequestStart: (id) => started.push(id),
    onRequestEnd: (id) => ended.push(id),
  });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    // Announce a body and then hang up without sending it: the server's
    // `for await (const chunk of req)` rejects.
    const ac = new AbortController();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"claude-opus-5",'));
        setTimeout(() => ac.abort(), 50);       // client goes away mid-upload
      },
    });
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body, duplex: 'half', signal: ac.signal,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));  // let the server-side rejection land
  } finally {
    console.error = realErr;
    proxy.close();
  }
  assert.ok(started.length > 0, 'no activity entry was opened, so this proves nothing');
  assert.deepEqual(ended, started,
    `an aborted request left ${started.length - ended.length} activity entry(s) open forever`);
});

// A guard that decides whether to ANSWER has two halves, and the earlier fix
// only had one. `getStatusExtra`'s value is serialized AFTER writeHead, so a
// hook returning something JSON cannot represent — a cycle, a BigInt — throws
// with the 200 already sent: the before-headers arm declines, nothing ends the
// response, and not one byte reaches the client. Covering the throwing hook and
// not this one is why three rounds of "the catch does not answer" kept
// producing a fourth.
test('a status hook returning an unserializable value does not hang the client', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const [label, extra] of [['a cycle', { cyclic }], ['a BigInt', { big: 1n }]]) {
    const am = new AccountManager(ACCTS, 0.98);
    let reached = false;
    const proxy = createProxyServer(am, CONFIG, {
      getStatusExtra: () => { reached = true; return extra; },
    });
    const port = await listen(proxy);
    const realErr = console.error;
    console.error = () => {};
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    let outcome;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: ac.signal });
      await res.text();
      outcome = `answered ${res.status}`;
    } catch (err) {
      // Headers were already sent, so there is no status left to change: the
      // connection is destroyed and the client retries. That is the answer.
      outcome = err.name === 'AbortError' ? 'HUNG' : 'closed';
    } finally {
      clearTimeout(timer);
      console.error = realErr;
      proxy.close();
    }
    assert.ok(reached, `the request never reached the hook returning ${label}`);
    assert.notEqual(outcome, 'HUNG', `${label}: the client waited forever for a response nobody sent`);
  }
});

// The ledger's START side, which is the mirror of the ordering fixed on the end
// side: a hook that registers its row and THEN throws leaves the row held, and
// nothing recorded to close it. This is the shipped hook's shape — the TUI does
// `active.set(id, …)` and then `render()`, which rethrows.
test('a hook that throws after registering its row still has the row closed', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const open = new Set();
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' }, {
    onRequestStart: (id) => { open.add(id); throw new Error('render() rethrew'); },
    onRequestEnd: (id) => { open.delete(id); },
  });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    }).then(r => r.text()).catch(() => {});
  } finally {
    console.error = realErr;
    proxy.close();
  }
  assert.deepEqual([...open], [],
    'a hook that threw after registering its row left the row open forever');
});

// The blocklist answers and returns on its own, so it owns the entry it closes.
// Leaving it marked open means the outer catch closes it a second time — one
// request, two closes — the moment anything downstream of it throws.
test('a blocked model closes its activity entry exactly once', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const ends = [];
  const proxy = createProxyServer(am, {
    proxy: {}, upstream: 'http://127.0.0.1:1', blockedModels: ['*fable*'],
  }, {
    onRequestEnd: (id, info) => {
      ends.push(info.status);
      if (ends.length === 1) throw new Error('the activity pane rethrew');
    },
  });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [] }),
    });
    assert.equal(res.status, 400, 'the blocklist did not answer, so this proves nothing');
    await res.text();
  } finally {
    console.error = realErr;
    proxy.close();
  }
  assert.equal(ends.length, 1,
    `one blocked request closed its activity entry ${ends.length} times (statuses ${ends.join(', ')})`);
});

// ── the two halves of the recovery, each held ─────────────────────────────
// Both were shipped undefended: moving the mark back after the hook, or
// dropping the try/catch around the catch's own hook call, left the whole suite
// green. The second is the one that matters — unguarded, a throwing activity
// hook escapes an async request listener as an `unhandledRejection`, and
// src/crash-log.js turns that into exit(1). The daemon dies on a bad hook.

// HALF ONE: the entry is marked closed BEFORE the end hook runs, so a hook that
// throws does not leave it looking open to the outer catch, which would then
// call that same hook a second time for one request.
test('a throwing end hook is not called twice for one request', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const calls = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upPort}` }, {
    onRequestEnd: (id, info) => { calls.push(info.status); throw new Error('the activity pane rethrew'); },
  });
  const port = await listen(proxy);
  const realErr = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    await res.text();
  } finally {
    console.error = realErr;
    proxy.close();
    upstream.close();
  }
  assert.equal(calls.length, 1,
    `one request closed its activity entry ${calls.length} times (statuses ${calls.join(', ')})`);
});

// HALF TWO: the catch's OWN hook call is guarded, because the throw that landed
// there may BE that hook. Unguarded it rethrows out of an async listener with
// nothing above it — an unhandledRejection, which this daemon treats as fatal.
test('a hook that throws on every call cannot bring the process down', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  let calls = 0;
  // BOTH hooks throw, which is what reaches the guarded call. The start hook
  // throwing is what carries an OPEN entry into the outer catch — with the
  // entry already closed by the inner `finally`, the catch has nothing to close
  // and the guard is never exercised. So this is the one arrangement that
  // reaches it: entry open, and the hook the catch must call throws too.
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' }, {
    onRequestStart: () => { throw new Error('render() rethrew on open'); },
    onRequestEnd: () => { calls += 1; throw new Error('the activity pane rethrew, every time'); },
  });
  const port = await listen(proxy);

  const rejections = [];
  const uncaught = [];
  const onRejection = (e) => rejections.push(e?.message || String(e));
  const onUncaught = (e) => uncaught.push(e?.message || String(e));
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onUncaught);
  const realErr = console.error;
  console.error = () => {};
  try {
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    }).then(r => r.text()).catch(() => { /* the upstream is not there; that is fine */ });
    await new Promise(r => setTimeout(r, 150));   // let any rejection surface
  } finally {
    console.error = realErr;
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onUncaught);
    proxy.close();
  }
  assert.ok(calls > 0, 'the hook was never called, so this proves nothing');
  assert.deepEqual(rejections, [],
    'a throwing activity hook escaped as an unhandled rejection, which crash-log turns into exit(1)');
  assert.deepEqual(uncaught, [], 'a throwing activity hook escaped as an uncaught exception');
});
