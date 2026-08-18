import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

// `teamclaude status --json` is what an operator reads during an incident, and
// a field that ignores its source is worse than a missing one: it answers
// confidently and wrongly. A field is unverified unless some test would FAIL if
// it stopped reading its input — asserting it in one arm of a boolean, or only
// at its default value, does not qualify, because the constant and the default
// agree.
//
// So every value below is set AWAY from its default in the fixture, and this
// file is written against the serializers (getStatusExtra, getStatus, getRoutes,
// SessionTracker.stats) rather than against the assertions that already exist —
// enumerating assertions finds only fields somebody already thought about, which
// is the complement of the population being hunted.

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

async function status(port) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
    headers: { authorization: 'Bearer tc-test' },
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function withServer(config, fn) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-status-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, host: '127.0.0.1', apiKey: 'tc-test' },
    upstreamProxy: false,
    autoUpdate: false,
    ...config,
  }));
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
    await fn({ port });
  } finally {
    child.kill('SIGKILL');
  }
}

// The one that misdirects rather than merely omits: a host pointed at a
// third-party backend reporting the Anthropic default in its own status.
test('the server block reports the upstream, port and blocklist it is running with', async () => {
  const upstream = 'https://backend.example.invalid/v1';
  await withServer({
    upstream,
    blockedModels: ['*fable*', 'gpt-*'],
    quotaProbeSeconds: 900,
    accounts: [{ name: 'a', type: 'apikey', apiKey: 'k1' }],
  }, async ({ port }) => {
    const s = await status(port);
    assert.equal(s.server.upstream, upstream,
      'a host on a third-party backend reports the Anthropic default in its own status');
    assert.equal(s.server.port, port, 'the port is reported, not read');
    assert.deepEqual(s.blockedModels, ['*fable*', 'gpt-*'],
      'the live blocklist an operator just edited is not what status shows');
    assert.equal(s.probe.enabled, true, 'the probe schedule is reported, not read');
    assert.equal(s.probe.intervalSeconds, 900);
    // startedAt is a real clock reading, not a constant: it has to sit between
    // this test's start and now.
    const started = Date.parse(s.server.startedAt);
    assert.ok(Number.isFinite(started), `startedAt is not a time: ${s.server.startedAt}`);
    assert.ok(Math.abs(Date.now() - started) < 120_000,
      `startedAt is not this run's clock: ${s.server.startedAt}`);

    // uptimeSeconds has to ADVANCE. A constant satisfies any "is it a number"
    // check and any bound generous enough not to flake, and frozen at 0 it reads
    // as "just restarted" to whoever is looking during an incident — the same
    // family of misdirection as reporting the wrong upstream. Asserting growth
    // rather than a value keeps it independent of how long the boot took.
    await new Promise(r => setTimeout(r, 2100));
    const later = await status(port);
    assert.ok(later.server.uptimeSeconds > s.server.uptimeSeconds,
      `uptime is a constant, not a clock: ${s.server.uptimeSeconds} then ${later.server.uptimeSeconds}`);
    assert.ok(Math.abs(later.server.uptimeSeconds - (Date.now() - started) / 1000) < 2,
      'uptime and startedAt disagree, so at most one of them is being read');
    assert.equal(later.server.startedAt, s.server.startedAt, 'startedAt moved while the server ran');
  });
});

test('a probe left off is reported off, with its configured interval', async () => {
  await withServer({
    upstream: 'https://api.anthropic.com',
    quotaProbeSeconds: 0,
    accounts: [{ name: 'a', type: 'apikey', apiKey: 'k1' }],
  }, async ({ port }) => {
    const s = await status(port);
    assert.equal(s.probe.enabled, false, 'a disabled probe reports itself running');
    assert.equal(s.probe.intervalSeconds, 0);
  });
});

// The route view is what the TUI renders pins and per-route eligibility from,
// and it reached the wire with three of its fields unread.
test('the route view reports each route\'s own bucket, globs and account list', async () => {
  await withServer({
    upstream: 'https://api.anthropic.com',
    accounts: [
      { name: 'a', type: 'apikey', apiKey: 'k1' },
      { name: 'b', type: 'apikey', apiKey: 'k2' },
    ],
    routes: [{ name: 'custom', match: ['*custom*', 'other-*'], bucket: 'unified7dCustom', accounts: ['b'] }],
  }, async ({ port }) => {
    const s = await status(port);
    const route = s.routes.find(r => r.name === 'custom');
    assert.ok(route, `the configured route is absent: ${JSON.stringify(s.routes)}`);
    assert.equal(route.bucket, 'unified7dCustom', "the route's quota-bucket override is not reported");
    assert.deepEqual(route.match, ['*custom*', 'other-*'], "the route's globs are not reported");
    assert.deepEqual(route.accounts.map(a => a.name), ['b'],
      'the route lists accounts it excludes, so its exclusivity is invisible');
    assert.equal(route.autocreated, false);
  });
});

// ── the manager-level half ────────────────────────────────────────────────
// Fields whose non-default value needs state a booted daemon will not reach on
// its own (a pin, a throttle, a pause, a learned quota).

function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: `k-${name}`, ...extra };
}

test('the route view reports the pin an operator set and who is eligible', () => {
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98, {
    routes: [{ name: 'custom', match: ['*custom*'] }],
  });
  assert.equal(am.getRoutes()[0].pinned, null, 'an unpinned route claims a pin');
  assert.equal(am.setRoutePin('custom', 1).ok, true);
  assert.equal(am.getRoutes()[0].pinned, 'b', 'the pin an operator set is not reported');

  // Eligibility is per account and must be read, not assumed.
  am.accounts[0].disabled = true;
  assert.deepEqual(am.getRoutes()[0].accounts, [{ name: 'a', eligible: false }, { name: 'b', eligible: true }],
    'the route view reports every account as eligible regardless of its state');
});

// A family bucket nobody configured a route for is surfaced as an ephemeral
// route, which is the only place that per-model quota is visible at all.
test('a family bucket with no configured route is surfaced as an autocreated one', () => {
  const am = new AccountManager([apikey('a')], 0.98);
  assert.deepEqual(am.getRoutes(), [], 'a fleet metering no family bucket invented a route');
  am.accounts[0].quota.unified7dFable = 0.2;
  const fable = am.getRoutes().find(r => r.name === 'fable');
  assert.ok(fable, 'the Fable bucket the account meters is invisible in the route view');
  assert.equal(fable.autocreated, true, 'an ephemeral route is reported as a configured one');
  assert.equal(fable.pinned, null);
  assert.equal(am.setRoutePin('fable', 0).ok, true);
  assert.equal(am.getRoutes().find(r => r.name === 'fable').pinned, 'a',
    "an autocreated route's pin is not reported");
});

test('the account view reports each account\'s own type, org, state and quota', () => {
  const am = new AccountManager([
    apikey('a', { orgName: 'Acme' }),
    { name: 'b', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.accounts[0].quota.unified7d = 0.42;
  am.accounts[0].usage.totalInputTokens = 1234;
  am.markRateLimited(1, 60);
  am.pauseAccount(0, 30);

  const s = am.getStatus();
  assert.deepEqual(s.accounts.map(a => a.type), ['apikey', 'oauth'],
    'every account is reported as the same type');
  assert.deepEqual(s.accounts.map(a => a.orgName), ['Acme', null],
    "the org an account belongs to is not reported");
  assert.deepEqual(s.accounts.map(a => a.status), ['active', 'throttled'],
    'a throttled account is reported as healthy');
  assert.equal(s.accounts[0].quota.unified7d, 0.42, 'the learned quota is not reported');
  assert.equal(s.accounts[0].usage.totalInputTokens, 1234, 'the usage counters are not reported');
  assert.ok(s.accounts[1].rateLimitedUntil, 'the rate-limit hold is not reported');
  assert.ok(s.accounts[0].pausedUntil, 'the rate-limit pause is not reported');
  assert.equal(s.accounts[1].pausedUntil, null, 'an unpaused account reports a pause');
});

// The probe's per-account view is where an operator finds out WHY quota stopped
// refreshing. A failure reported as a blank is the same reading as a healthy
// account that has simply not run yet.
test('the probe view reports each account\'s own outcome and failure', async () => {
  const am = new AccountManager([
    { name: 'good', type: 'oauth', accessToken: 't-good', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'bad', type: 'oauth', accessToken: 't-bad', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'key', type: 'apikey', apiKey: 'k' },
  ], 0.98);
  const prober = new Prober(am, {
    intervalMs: 0,
    log: () => {},
    probeFn: async (credential) => (credential === 't-bad'
      ? { error: 'usage endpoint said no' }
      : { sevenDay: { utilization: 0.3, resetAt: Date.now() + 50 * 3600_000 } }),
  });
  await prober.probeAll();

  const view = prober.getStatus().accounts;
  assert.deepEqual(view.map(a => a.name), ['good', 'bad', 'key'],
    'the probe view does not name the accounts it probed');
  assert.deepEqual(view.map(a => a.status), ['ok', 'error', 'not-applicable'],
    'every account reports the same probe outcome');
  assert.equal(view[0].error, null);
  assert.equal(view[1].error, 'usage endpoint said no',
    'the reason a probe failed is not reported, so a broken account reads as an idle one');
  assert.equal(view[2].error, null);
  assert.equal(prober.getStatus().running, false);
});
