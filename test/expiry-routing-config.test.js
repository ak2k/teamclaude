import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_MAX } from '../src/session-tracker.js';

// The config → AccountManager wiring for expiryRouting is one argument in one
// constructor call plus one line in the reload path. Deleting either left the
// suite green while the feature shipped permanently off, so this drives the
// real daemon and reads what it says it is doing.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function configFor(port, expiryRouting, extra = {}) {
  return {
    proxy: { port, host: '127.0.0.1', apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    accounts: [{ name: 'a', type: 'apikey', apiKey: 'k1' }],
    ...(expiryRouting ? { expiryRouting } : {}),
    ...extra,
  };
}

async function status(port) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
    headers: { authorization: 'Bearer tc-test' },
  });
  assert.equal(res.status, 200);
  return res.json();
}

// Start the daemon headless against a throwaway config and hand the test its
// port plus the config path, so it can rewrite the file and reload.
async function withServer(expiryRouting, fn, extra = {}) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-expiry-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(configFor(port, expiryRouting, extra)));

  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (child.exitCode != null) throw new Error(`server exited early: ${output}`);
      try { await status(port); break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up: ${output}`);
      await new Promise(r => setTimeout(r, 100));
    }
    await fn({ port, configPath });
  } finally {
    child.kill('SIGKILL');
  }
}

// A quiet daemon has fired no rollovers, so the counters read zero — but they
// have to be PRESENT and zero rather than absent, because "no key" and "key at
// zero" are the same thing to an operator reading a fresh status and the
// difference between a feature that is quiet and one that is not deployed.
const NO_ROLLOVERS = { rolloversDetected: 0, rolloversPreempted: 0, rolloversOwed: 0 };

test('expiryRouting in the config file reaches the running manager', async () => {
  await withServer({ enabled: true, tolerance: 3, preempt: false, coverage: 2 }, async ({ port }) => {
    const s = await status(port);
    assert.deepEqual(s.expiryRouting,
      { enabled: true, tolerance: 3, preempt: false, coverage: 2, stats: NO_ROLLOVERS });
  });
});

test('an absent expiryRouting key leaves the feature off with its defaults', async () => {
  await withServer(null, async ({ port }) => {
    const s = await status(port);
    assert.deepEqual(s.expiryRouting,
      { enabled: false, tolerance: 1.5, preempt: true, coverage: 1, stats: NO_ROLLOVERS });
  });
});

// The session view the TUI and `status --json` render from, reaching the wire.
// `perBucket` is the one place a session's per-family pins are visible at all,
// so it has to survive the trip rather than only exist in the manager.
test('the session view reaches the wire with its cap and pin breakdown', async () => {
  await withServer(null, async ({ port }) => {
    const s = await status(port);
    assert.equal(s.sessions.known, 0);
    assert.equal(s.sessions.active, 0);
    assert.equal(s.sessions.evicted, 0);
    // The cap the tracker is actually holding, not merely "some positive
    // number": an evicted count is only readable against the bound that
    // produced it, and any constant satisfies a `> 0` test — including one that
    // stopped tracking the bound it claims to report.
    assert.equal(s.sessions.max, SESSION_MAX, 'the reported cap is not the one the tracker holds');
    assert.deepEqual(s.sessions.perAccount, {});
    assert.deepEqual(s.sessions.perBucket, {});
    // The rest of the routing view an operator reads a decision off. Each of
    // these was satisfied by a hardcoded constant.
    assert.equal(s.sessions.distribute, false, 'the distribution flag is reported, not read');
    assert.equal(s.switchThreshold, 0.9, 'the switch threshold is reported, not read');
    assert.equal(s.currentAccount, 'b');
    assert.deepEqual(s.accounts.map(a => [a.name, a.priority, a.disabled]),
      [['a', 0, true], ['b', 3, false]],
      'the account view reports constants rather than what each account is set to');
  }, {
    // Every value asserted above is set away from its default here, so a
    // reporter that publishes the default instead of the setting is visible.
    switchThreshold: 0.9,
    distributeSessions: false,
    accounts: [
      { name: 'a', type: 'apikey', apiKey: 'k1', disabled: true },
      { name: 'b', type: 'apikey', apiKey: 'k2', priority: 3 },
    ],
  });
});

test('an expiryRouting edit on disk hot-applies on reload', async () => {
  await withServer({ enabled: false }, async ({ port, configPath }) => {
    assert.equal((await status(port)).expiryRouting.enabled, false);
    await writeFile(configPath, JSON.stringify(configFor(port, { enabled: true, tolerance: 2 })));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, {
      method: 'POST', headers: { authorization: 'Bearer tc-test' },
    });
    assert.equal(res.status, 200);
    await res.text();
    const s = await status(port);
    assert.equal(s.expiryRouting.enabled, true, 'the edit did not reach the manager');
    assert.equal(s.expiryRouting.tolerance, 2);
  });
});
