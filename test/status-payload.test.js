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

// The session view is what a load or cache decision would be argued from, and
// every field below reads a different source: the two cache totals come off the
// account, the session totals off the tracker's records, and the live footprint
// off the ACTIVE subset of them. Each is set away from its default here, so a
// field that stopped reading its source fails rather than agreeing with zero.
test('the session view reports the token totals and the live cached footprint', () => {
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98);
  am.sessionTracker.touch('s1', 0);
  am.sessionTracker.touch('s2', 1);
  // Distinct values per field and per session, so a total that reads the wrong
  // one is a different number rather than a coincidence.
  am.recordTokenUsage(0, 's1', 'claude-opus-5', {
    input_tokens: 11, cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 300, output_tokens: 7,
  });
  // A different family on purpose: the two must not be pooled on the way out.
  am.recordTokenUsage(1, 's2', 'claude-fable-5', {
    input_tokens: 22, cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 50, output_tokens: 9,
  });

  const s = am.getStatus();
  assert.equal(s.sessions.tokens.cacheRead, 5000, 'the cache-read total is not reported');
  assert.equal(s.sessions.tokens.cacheCreation, 350, 'the cache-creation total is not reported');
  assert.equal(s.sessions.tokens.input, 33, 'the per-session input total is not reported');
  assert.equal(s.sessions.tokens.output, 16, 'the per-session output total is not reported');
  assert.equal(s.sessions.tokens.reports, 2,
    'the report count is not published, so no tokens and no observations read alike');
  assert.equal(s.sessions.tokens.activeContext, 4311 + 1072,
    'the live cached footprint is not reported');

  assert.equal(s.accounts[0].usage.totalCacheReadTokens, 4000,
    "the account's cache-read total is not reported");
  assert.equal(s.accounts[0].usage.totalCacheCreationTokens, 300,
    "the account's cache-creation total is not reported");
  assert.equal(s.accounts[1].usage.totalCacheReadTokens, 1000,
    'both accounts report the same cache total');
  assert.equal(s.accounts[1].usage.totalCacheCreationTokens, 50);


  assert.equal(s.sessions.tokens.byBucket.unified7d.cacheRead, 4000,
    'the Opus weekly bucket is not reported on its own');
  assert.equal(s.sessions.tokens.byBucket.unified7dFable.cacheRead, 1000,
    'the Fable weekly bucket is not reported on its own, so the families are pooled');
  assert.equal(s.sessions.tokens.byBucket.unified7d.activeContext, 4311);
  assert.equal(s.sessions.tokens.byBucket.unified7dFable.activeContext, 1072);
  assert.equal(s.accounts[0].usage.byBucket.unified7d.cacheReadTokens, 4000,
    "the account's per-family split is not reported");
  assert.equal(s.accounts[1].usage.byBucket.unified7dFable.cacheReadTokens, 1000);
});

// An operator reading a fleet during an incident needs to tell a dead token
// pipeline from an idle account, and `load` alone cannot: zero is what both
// look like. `observed` is the report count backing that load, so the pair is
// legible where neither half is on its own. Both are asserted away from their
// defaults, because a field that stops reading its source agrees with zero.
test('each account publishes what it is carrying and how many reports back it', () => {
  const am = new AccountManager([apikey('busy'), apikey('idle')], 0.98);
  // recordSession rather than touch: a pin is what makes a session count as
  // load on an account, and touch without buckets creates none.
  am.recordSession('s1', 0, 'claude-opus-5');
  am.recordTokenUsage(0, 's1', 'claude-opus-5', {
    input_tokens: 12, cache_read_input_tokens: 300000,
    cache_creation_input_tokens: 1000, output_tokens: 700,
  });

  const s = am.getStatus();
  const [busy, idle] = s.accounts;
  assert.equal(busy.load, 301012, "the account's measured load is not published");
  assert.equal(busy.observed, 1,
    'the report count backing that load is not published, so a dead token '
    + 'pipeline reads exactly like an idle account');
  assert.equal(idle.load, 0, 'an account carrying nothing reports no load');
  assert.equal(idle.observed, 0);
});

test('a missing pressure says which measurement is missing', () => {
  const now = Date.now();
  const am = new AccountManager(
    [apikey('no-util'), apikey('no-reset'), apikey('healthy'), apikey('bad-util')], 0.98);
  // Each account is one absence, set away from the null default so freezing the
  // field to null fails here rather than passing on the happy path. The healthy
  // one is the other half of the claim: `pressureAbsent` is non-null EXACTLY
  // when `pressure` is null, so a fixture of absences alone would let a field
  // that is always non-null pass.
  am.accounts[0].quota = { ...am.accounts[0].quota, unified7d: null, unified7dReset: now + 3600e3 };
  am.accounts[1].quota = { ...am.accounts[1].quota, unified7d: 0.4, unified7dReset: null };
  am.accounts[2].quota = { ...am.accounts[2].quota, unified7d: 0.4, unified7dReset: now + 3600e3 };
  am.accounts[3].quota = { ...am.accounts[3].quota, unified7d: Number.NaN, unified7dReset: now + 3600e3 };

  const [noUtil, noReset, healthy, badUtil] = am.getStatus().accounts;

  assert.equal(noUtil.pressure, null);
  assert.equal(noUtil.pressureAbsent, 'no-utilization',
    'a window nobody has reported reads the same as one whose reset is missing');
  assert.equal(noReset.pressure, null);
  assert.equal(noReset.pressureAbsent, 'no-reset');
  assert.equal(badUtil.pressure, null);
  assert.equal(badUtil.pressureAbsent, 'utilization-not-finite',
    'a malformed value reads as merely unreported, so nobody goes and looks at the account');
  assert.ok(healthy.pressure > 0, 'the fixture must contain a measurable account');
  assert.equal(healthy.pressureAbsent, null,
    'a measured account carries an absence reason, so the field means nothing');
});

test('the absence reason never reports the feature flag', () => {
  // `expiry-routing-off` is a reason `_pickPressures` gives for a model-scoped
  // question. This pressure is computed whether the flag is on or off, so
  // publishing the flag here would report a measured fleet as unmeasurable
  // because a feature is switched off.
  const now = Date.now();
  const quota = { unified7d: 0.4, unified7dReset: now + 3600e3 };
  const off = new AccountManager([apikey('a'), apikey('b')], 0.98);
  const on = new AccountManager([apikey('a'), apikey('b')], 0.98,
    { expiryRouting: { enabled: true } });
  for (const am of [off, on]) {
    for (const a of am.accounts) a.quota = { ...a.quota, ...quota };
  }

  assert.equal(off.expiryRouting.enabled, false, 'the premise: this manager has the feature off');
  assert.equal(on.expiryRouting.enabled, true, 'the premise: this manager has it on');
  for (const account of off.getStatus().accounts) {
    assert.equal(account.pressureAbsent, null);
    assert.ok(account.pressure > 0, 'pressure is computed with expiry routing off');
  }
  assert.deepEqual(
    off.getStatus().accounts.map(a => a.pressureAbsent),
    on.getStatus().accounts.map(a => a.pressureAbsent),
    'the absence reason moved when the feature flag moved');
});

// ONE STATE PER PAYLOAD. Every section answers about the fleet as the next
// request will find it, and the sections must not disagree: pass 4's converged
// finding was a ladder ranking an account on a window the eligibility beside it
// had already treated as gone. The rows and the report are asserted together
// here, because either alone can be right while the pair is nonsense.
test('an expired window is gone from every section of the payload, and from none of the fleet', () => {
  const now = Date.now();
  const H = 3600e3;
  const am = new AccountManager([apikey('healthy'), apikey('expired'), apikey('held')], 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  am.accounts[0].quota = { ...am.accounts[0].quota,
    unified5h: 0.1, unified5hReset: now + 2 * H, unified7d: 0.2, unified7dReset: now + 20 * H };
  // Spent, on a window whose reset has already passed: live it is 95% used, and
  // to the next request it is a window nobody has reported yet.
  am.accounts[1].quota = { ...am.accounts[1].quota,
    unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.95, unified7dReset: now - H };
  // Throttled, hold elapsed: the next request reopens it before it does anything
  // else, so a payload calling it throttled describes a state nothing can meet.
  am.accounts[2].quota = { ...am.accounts[2].quota,
    unified5h: 0.3, unified5hReset: now + 2 * H, unified7d: 0.4, unified7dReset: now + 40 * H };
  am.accounts[2].status = 'throttled';
  am.accounts[2].rateLimitedUntil = now - 60_000;

  const s = am.getStatus();
  const [, expired, held] = s.accounts;

  assert.equal(expired.quota.unified7d, null, 'the row publishes a window the request path has already dropped');
  assert.equal(expired.pressure, null);
  assert.equal(expired.pressureAbsent, 'no-utilization',
    'the row scores pressure on the spent figure while eligibility ignores it');
  assert.equal(held.status, 'active', 'the row calls an account throttled that the next request reopens');
  assert.equal(held.rateLimitedUntil, null);

  const shared = s.routing.find(e => e.scope === 'shared');
  const row = shared.band.ladder.find(r => r.account === 'expired');
  assert.ok(shared.band.ladder.length, 'the premise: this fleet must produce a ladder to compare against');
  assert.ok(row, 'the expired account is not on the ladder, so the sections are not being compared');
  assert.deepEqual(row.pressure, { kind: 'absent', reason: 'no-utilization' },
    'the ladder ranks the expired window that the account row beside it reports as gone');

  // AND NOTHING WAS APPLIED. The clear is a session-reset event's cousin: the
  // request path owns it, so a status call must leave every field where it was.
  assert.equal(am.accounts[1].quota.unified7d, 0.95, 'reading the status consumed the expiry');
  assert.equal(am.accounts[2].status, 'throttled', 'reading the status performed the throttle transition');
  assert.equal(am.accounts[2].rateLimitedUntil, now - 60_000);
});

// ONE CLOCK, and asked for rather than asserted. Every field of the payload
// that consults a clock must consult the SAME one, or two of them straddle a
// window that resets between the reads: the projection keeps a live window that
// the pressure figure beside it scores as spent, which is pass 4's converged
// finding one line down from the code that fixed it.
//
// The real gap is microseconds wide and no test can catch it by waiting. This
// asks for the payload at an instant ten minutes gone instead: every field that
// reads the wall clock then answers about a different fleet than the field next
// to it, and the difference is ten minutes rather than a microsecond.
test('every field of the payload answers about the instant the payload was asked for', () => {
  // TWO COVERAGES, because they grade different readers. Below one account's
  // headroom the band admits exactly one account, so the BAND's clock decides
  // the destination and the pick has nothing left to choose between; at a
  // coverage of 1 both candidates are admitted under either clock and it is the
  // PICK's clock that decides. Measured: each value leaves the other's reader
  // ungraded, and the first version of this test ran only the narrow one.
  for (const coverage of [1, 0.5]) oneClock(coverage);
});

function oneClock(coverage) {
  const H = 3600e3;
  const wall = Date.now();
  const asked = wall - 10 * 60e3;
  const am = new AccountManager(
    [apikey('expired'), apikey('soon'), apikey('ample'), apikey('held'), apikey('paused')], 0.98,
    { expiryRouting: { enabled: true, coverage, tolerance: 1.5 } });
  const q = (i, o) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...o }; };
  // Its weekly reset falls BETWEEN the two instants: a live window with eight
  // minutes left when the payload was asked for, an expired one at the wall
  // clock. Disabled, so it grades the row fields without also being a
  // destination — the ranking below is a separate claim with its own accounts.
  am.accounts[0].disabled = true;
  q(0, { unified5h: 0.1, unified5hReset: wall + 2 * H, unified7d: 0.5, unified7dReset: wall - 2 * 60e3 });
  // Pressure rises as a window nears its reset, and it rises fastest for the
  // nearest one: `ample` holds more quota and outranks `soon` at the earlier
  // instant, while `soon` — one minute from its reset at the wall clock —
  // overtakes it there. So the destination itself names which clock ranked it.
  q(1, { unified5h: 0.1, unified5hReset: wall + 2 * H, unified7d: 0.9, unified7dReset: wall + 60e3 });
  q(2, { unified5h: 0.1, unified5hReset: wall + 2 * H, unified7d: 0.2, unified7dReset: wall + 30 * 60e3 });
  q(3, { unified5h: 0.1, unified5hReset: wall + 2 * H, unified7d: 0.5, unified7dReset: wall + 200 * H });
  q(4, { unified5h: 0.1, unified5hReset: wall + 2 * H, unified7d: 0.5, unified7dReset: wall + 400 * H });
  // A hold and a pause that both elapsed between the two instants.
  am.accounts[3].status = 'throttled';
  am.accounts[3].rateLimitedUntil = wall - 5 * 60e3;
  am.accounts[4].pausedUntil = wall - 60e3;

  const s = am.getStatus(asked);
  const [expired, , , held, paused] = s.accounts;
  const shared = s.routing.find(e => e.scope === 'shared');

  assert.equal(expired.quota.unified7d, 0.5,
    'the projection retired a window that had not reset when the payload was asked for');
  assert.ok(expired.pressure > 0,
    'the pressure figure scored that window as already reset, so the row disagrees with itself');
  assert.equal(expired.pressureAbsent, null);
  assert.equal(held.status, 'throttled', 'a hold still live at that instant reads as elapsed');
  assert.ok(shared.band.excluded.some(e => e.account === 'held' && e.reason === 'throttled'),
    'eligibility reopened a hold the row beside it still calls live');
  assert.ok(paused.pausedUntil, 'a pause still live at that instant reads as elapsed');
  assert.equal(shared.target, 'ample',
    `coverage ${coverage}: the destination was ranked on a different clock than the payload was asked for`);
  // The report's OWN figures, which are a separate reader from the destination:
  // the ladder it publishes and the pick it explains both order by pressure, and
  // pressure is a function of the clock.
  assert.equal(shared.band.ladder[0].account, 'ample',
    `coverage ${coverage}: the ladder is ordered by pressure at another instant`);
  assert.equal(shared.pick.account, 'ample',
    `coverage ${coverage}: the pick ranked its candidates at another instant`);

  // THE PREMISE: every assertion above must answer differently at the wall
  // clock, or the fixture cannot tell one clock from two.
  const later = am.getStatus();
  const [expiredLater, , , heldLater, pausedLater] = later.accounts;
  const sharedLater = later.routing.find(e => e.scope === 'shared');
  assert.equal(expiredLater.quota.unified7d, null);
  assert.equal(expiredLater.pressure, null);
  assert.equal(heldLater.status, 'active');
  assert.equal(pausedLater.pausedUntil, null);
  assert.equal(sharedLater.target, 'soon');
  assert.equal(sharedLater.band.ladder[0].account, 'soon');
  assert.equal(sharedLater.pick.account, 'soon');
}

test('the active account is the one the next request starts from, not the one it leaves', () => {
  const now = Date.now();
  const H = 3600e3;
  const am = new AccountManager([apikey('incumbent'), apikey('resetting')], 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  am.accounts[0].quota = { ...am.accounts[0].quota,
    unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.5, unified7dReset: now + 400 * H };
  // Five-hour window already reset AND a sooner weekly: the prologue
  // `getActiveAccount` runs before any selection moves the current account onto it.
  am.accounts[1].quota = { ...am.accounts[1].quota,
    unified5h: 0.9, unified5hReset: now - 60_000, unified7d: 0.3, unified7dReset: now + 20 * H };
  am.setCurrentAccount(0);

  const s = am.getStatus();
  assert.equal(s.currentAccount, 'resetting',
    'the payload names an account no request will start from');
  assert.equal(am.currentIndex, 0, 'reading the status moved the current account');
  assert.equal(s.routing.find(e => e.scope === 'shared').target, 'resetting',
    'the destination and the active row disagree about where the next request starts');
});

test('an account publishes how many requests it is carrying right now', async () => {
  const am = new AccountManager([apikey('busy'), apikey('idle')], 0.98);
  // Through admit() rather than by assigning the counter: admit() is what the
  // request path calls, so a field wired to something else fails here.
  assert.equal(await am.admit(0), true);
  assert.equal(await am.admit(0), true);
  assert.equal(await am.admit(1), true);
  am.release(1);

  const [busy, idle] = am.getStatus().accounts;
  assert.equal(busy.inFlight, 2,
    'the in-flight gauge is not published, so the term that ranks is invisible');
  assert.equal(idle.inFlight, 0,
    'zero here is a measurement, nothing in flight, and is what a released slot returns to');
});
