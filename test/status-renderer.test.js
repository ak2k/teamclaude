import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus } from '../src/status-renderer.js';

const now = Date.parse('2026-07-03T12:00:00Z');

function sampleStatus() {
  return {
    currentAccount: 'a',
    switchThreshold: 0.98,
    probe: {
      enabled: true,
      intervalSeconds: 300,
      lastRunFinishedAt: '2026-07-03T11:58:00Z',
      nextRunAt: '2026-07-03T12:03:00Z',
      accounts: [{ name: 'a', status: 'ok', lastProbedAt: '2026-07-03T11:58:00Z', durationMs: 42 }],
    },
    accounts: [{
      name: 'a',
      type: 'oauth',
      priority: 0,
      status: 'active',
      quota: { unified5h: 0.95, unified5hReset: now + 60_000 },
      usage: { totalInputTokens: 1000, totalOutputTokens: 500, totalRequests: 2, lastUsed: '2026-07-03T11:59:00Z' },
    }],
  };
}

// A PAYLOAD THIS BUILD CANNOT PRODUCE, BY CONSTRUCTION AND ON PURPOSE.
//
// The destination rows print `nothing eligible` when an entry has no target.
// Locally that never happens inside a rendered block: the block is skipped for a
// passthrough band, `decideBand` passes through whenever the candidate set is
// one account or none, and any candidate gives the preview a destination. The
// two conditions exclude each other, so no fixture built from an AccountManager
// can reach this row — a driven sweep of every disclosure this round added
// found it as the one unreachable branch.
//
// It is kept because `tui-remote` and `teamclaude status` render payloads
// fetched from other hosts, which run their own patch level, and a producer
// whose band and preview disagree sends this shape.
//
// SO THE PAYLOAD BELOW IS HAND-BUILT AND MUST STAY HAND-BUILT. Tidying it into
// `am.getStatus()` would make `target` non-null, the branch would stop being
// exercised, and this test would keep passing while witnessing nothing — which
// is the exact failure the sweep that found this branch exists to catch.
test('a foreign payload whose band and preview disagree still renders honest words', () => {
  const foreign = {
    ...sampleStatus(),
    routing: [{
      scope: 'shared',
      route: null,
      model: null,
      match: [],
      autocreated: false,
      target: null,          // no destination…
      pinnedTo: null,
      bucket: 'unified7d',
      familySplit: false,
      band: {
        kind: 'sized',       // …beside a band that says two accounts were ranked
        reason: null,
        target: 1,
        achieved: 1.8,
        floor: null,
        candidates: 2,
        admitted: ['a', 'b'],
        ladder: [],
        excluded: [],
      },
      pick: { kind: 'none', reason: 'no-candidates', account: null, runnerUp: null, tiedWith: [], by: null, terms: [] },
    }],
  };

  const lines = renderStatus(foreign, { color: false, now }).split('\n');
  const next = lines.find(l => l.trim().startsWith('Next request'));
  assert.ok(next, 'the block did not render at all, so the branch under test was skipped');
  assert.match(next, /nothing eligible/,
    'a payload with no destination rendered a destination anyway');
  const newSession = lines.find(l => l.trim().startsWith('New session'));
  assert.match(newSession, /nothing eligible/);
});

test('renderStatus prints core status', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });

  assert.match(output, /Active\s+a/);
  assert.match(output, /Session\s+\[█████████████████░\] 95% reset 1m/);
  assert.match(output, /Probe\s+ok 2m ago/);
  assert.match(output, /2 req, 1.5k tok/);
});

test('renderStatus shows the sessions line and per-account session count when present', () => {
  const status = sampleStatus();
  status.sessions = { known: 3, active: 2, perAccount: { 0: 2 }, distribute: true };
  status.accounts[0].sessions = 2;
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Sessions\s+2 active \/ 3 known · distributing/);
  assert.match(output, /a \(oauth, prio 0\).*2 sess/);
});

test('renderStatus omits the sessions line when the status has no sessions field', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });
  assert.doesNotMatch(output, /Sessions\s/);
});

test('renderStatus colors active accounts and bars', () => {
  const output = renderStatus(sampleStatus(), { color: true, now });

  assert.match(output, /\x1b\[32mactive/);
  const cells = [...output.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m█/g)]
    .map(match => match.slice(1).map(Number));
  assert.ok(cells.length > 2);
  assert.ok(cells[0][1] > cells[0][0], 'bar should start green');
  assert.ok(cells.at(-1)[0] > cells.at(-1)[1], 'bar should end red');
});

test('renderStatus shows per-model eligibility when a family is metered separately', () => {
  const status = sampleStatus();
  // Shared 5h has headroom, general/Opus weekly is fine, but the Fable weekly is
  // spent: Fable should read ✗ (with its reset) while Opus stays ✓ — the
  // "some accounts are disabled for specific models" view of issue #85.
  status.accounts[0].quota = {
    unified5h: 0.2, unified5hReset: now + 60_000,
    unified7d: 0.3, unified7dReset: now + 600_000,
    unified7dFable: 1.0, unified7dFableReset: now + 86_400_000,
  };
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Models\s+Opus ✓/);
  assert.match(output, /Fable ✗ 1d/);
});

test('renderStatus omits the Models line for accounts with no family-specific bucket', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });
  assert.doesNotMatch(output, /Models/);
});

test('renderStatus prints the routing table with configured and auto routes', () => {
  const status = sampleStatus();
  status.routes = [
    { name: 'fable', match: ['*fable*'], autocreated: false, bucket: null,
      accounts: [{ name: 'personal', eligible: true }, { name: 'a', eligible: false }] },
    { name: 'sonnet', match: ['*sonnet*'], autocreated: true, bucket: null,
      accounts: [{ name: 'a', eligible: true }] },
  ];
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Routing/);
  assert.match(output, /\*fable\*\s+→ personal a/);
  assert.match(output, /\*sonnet\*\s+→ a \(auto\)/);
});

test('renderStatus shows a route color and pinned account', () => {
  const status = sampleStatus();
  status.routes = [
    { name: 'fable', match: ['*fable*'], autocreated: false, bucket: null, color: 'magenta', pinned: 'personal',
      accounts: [{ name: 'personal', eligible: true }, { name: 'a', eligible: true }] },
  ];
  // Plain text: the pin annotation is visible.
  const plain = renderStatus(status, { color: false, now });
  assert.match(plain, /\*fable\*\s+→ personal a \[pinned: personal\]/);
  // Colored: the magenta SGR code (35) wraps the route label.
  const colored = renderStatus(status, { color: true, now });
  assert.match(colored, /\x1b\[35m\*fable\*/);
});

test('renderStatus omits the routing table when there are no routes', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });
  assert.doesNotMatch(output, /Routing/);
});

test('renderStatus sanitizes probe errors', () => {
  const status = sampleStatus();
  status.probe.accounts[0] = {
    name: 'a',
    status: 'error',
    lastProbedAt: '2026-07-03T11:58:00Z',
    error: 'bad\n\x1b[31mred',
  };

  const output = renderStatus(status, { color: false, now });
  assert.match(output, /bad red/);
  assert.doesNotMatch(output, /\x1b\[31m/);
});

// --- blocklist visibility (issue: a blocked model read as available) ---------
// `Models` reports quota headroom, so a fully-blocked family used to render ✓
// while every request for it got a 400. Quota and the blocklist are separate
// gates; status has to surface both.

function blockedStatus(blockedModels) {
  const status = sampleStatus();
  status.blockedModels = blockedModels;
  status.accounts[0].quota = {
    unified5h: 0.02,
    unified5hReset: now + 3600_000,
    unified7d: 0.49,
    unified7dReset: now + 86_400_000,
    unified7dFable: 0.11,
    unified7dFableReset: now + 86_400_000,
  };
  return status;
}

test('renderStatus shows a Blocked row listing the configured patterns', () => {
  const output = renderStatus(blockedStatus(['*fable*']), { color: false, now });
  assert.match(output, /Blocked\s+\*fable\*/);
});

test('renderStatus omits the Blocked row when nothing is blocked', () => {
  assert.doesNotMatch(renderStatus(blockedStatus([]), { color: false, now }), /Blocked/);
  assert.doesNotMatch(renderStatus(sampleStatus(), { color: false, now }), /Blocked/);
});

test('renderStatus marks a blocked family blocked, not available, despite free quota', () => {
  const output = renderStatus(blockedStatus(['*fable*']), { color: false, now });
  // Fable has 89% headroom and the session bucket is nearly empty, so the
  // quota-only path would have rendered "Fable ✓".
  assert.match(output, /Fable ⊘ blocked/);
  assert.doesNotMatch(output, /Fable ✓/);
  assert.match(output, /Opus ✓/); // unrelated families keep reporting quota
});

// The claim this has always made is that a CONCRETE id is visible on the family
// row — a blocklist entry that lights up nothing is how a blocked model came to
// read as available. That claim stands. What changed is the word: one id of a
// family is not the family, because `claude-fable-4` and every dated variant of
// `claude-fable-5` still match the route and are still served. `partly blocked`
// says the thing that is true; `⊘ blocked` said the route was dead and it was
// carrying traffic.
test('renderStatus marks a family reached by a concrete model id, without calling it dead', () => {
  const output = renderStatus(blockedStatus(['claude-fable-5']), { color: false, now });
  assert.match(output, /Fable [^\n]*partly blocked/,
    'a concrete id lights up nothing on the family row, which is how a blocked model reads as available');
  assert.doesNotMatch(output, /Fable ⊘ blocked/,
    'one blocked id of a family is reported as the whole family being out of service');
});

test('renderStatus still calls a family dead when the blocklist covers it', () => {
  const output = renderStatus(blockedStatus(['*fable*']), { color: false, now });
  assert.match(output, /Fable ⊘ blocked/,
    'a glob covering the family no longer reads as blocked, so the distinction collapsed the other way');
});

test('renderStatus leaves families untouched by an unrelated block', () => {
  const output = renderStatus(blockedStatus(['*sonnet*']), { color: false, now });
  assert.match(output, /Fable ✓/);
  assert.match(output, /Opus ✓/);
});

test('renderStatus reports a fully-blocked route as blocked instead of listing accounts', () => {
  const status = blockedStatus(['*fable*']);
  status.routes = [{
    name: 'fable',
    match: ['*fable*'],
    autocreated: true,
    accounts: [{ name: 'a', eligible: true }],
  }];
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /\*fable\*\s+→ blocked \(auto\)/);
});

test('renderStatus still lists accounts for a route the blocklist does not cover', () => {
  const status = blockedStatus(['*fable*']);
  status.routes = [{
    name: 'sonnet',
    match: ['*sonnet*'],
    autocreated: true,
    accounts: [{ name: 'a', eligible: true }],
  }];
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /\*sonnet\*\s+→ a \(auto\)/);
});
