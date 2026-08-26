import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// THE TUI'S ROUTE GLYPHS AND THE STATUS SCREEN ANSWER ONE QUESTION, so they may
// not answer it differently.
//
// `_renderAcct` drew its general-route markers from `getRoutes().accounts` plus
// `m.eligible` — the STRIPPED-SAMPLE view, graded for an id no claim matches, so
// every account came back eligible. It never consulted `routing[]` or the
// suppression state. The payload could therefore withdraw a route's per-account
// figures, the status screen could say "no figures: an earlier route takes the
// id this route is named for", and this screen went on marking owners for it.
// That is the pass-13 P2 shape — the payload withdraws a claim and a screen
// makes it anyway — found for a SIXTH time, in the file the round never
// revisited.
//
// A REAL AccountManager rather than a stand-in: the defect lives in the
// relationship between two payload fields, and a stub that returns a routes
// array cannot have one.
//
// FIXTURES USE `*opus*`-SHAPED GLOBS DELIBERATELY. `routeFamily()` sends any
// route whose NAME OR GLOBS mention fable or sonnet to the F7/S7 bars instead of
// the general-route glyph column, so the campaign's usual `*fable*`/`*sonnet*`
// fixtures cannot reach this path at all — which is the likeliest reason six
// passes walked past it.

const H = 3600e3;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function fixture(now) {
  const routes = [
    { name: 'exact', match: ['claude-opus-4-5'], accounts: [] },
    { name: 'wide', match: ['*opus*'], accounts: [] },
    { name: 'other', match: ['claude-haiku-4-5*'], accounts: [] },
  ];
  const am = new AccountManager(
    [{ name: 'alpha', type: 'apikey', apiKey: 'ka', models: ['claude-opus-4-5'] },
      { name: 'beta', type: 'apikey', apiKey: 'kb', models: ['claude-haiku-4-5'] }],
    0.98, { routes });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota,
      unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H };
  });
  return { am, routes };
}

// The frame, through the real `_render()`. Calling `_renderAcct` directly is not
// equivalent: its trailing parameter defaults to the pre-fix behaviour for
// callers that do not supply the naming, so a bare call would exercise the old
// path and report the defect closed wherever it is open.
function renderFrame(tui) {
  const chunks = [];
  const w = process.stdout.write, c = process.stdout.columns, r = process.stdout.rows;
  process.stdout.columns = 200; process.stdout.rows = 50;
  process.stdout.write = chunk => { chunks.push(chunk); return true; };
  try { tui.running = true; tui._render(); } finally {
    process.stdout.write = w; process.stdout.columns = c; process.stdout.rows = r;
  }
  return strip(chunks.join('')).split('\n').map(l => l.replace(/^\x1b\[H/, ''));
}

// Row layout is ` ${sel}${cur} ${startSlot}${name} …`, so the glyph cells begin
// at index 4 and the name follows them and one space.
const GLYPH_AT = 4;

function glyphs(now) {
  const { am, routes } = fixture(now);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, routes },
    sx: null, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  const lines = renderFrame(tui);
  const status = am.getStatus();
  const general = status.routes
    .filter(r => !/fable|sonnet/i.test(`${r.name} ${(r.match || []).join(' ')}`))
    .map(r => r.name);
  const nameAt = GLYPH_AT + general.length + 1;
  const marked = {};
  for (const acct of am.accounts) {
    const row = lines.find(l => l.slice(nameAt).startsWith(acct.name));
    assert.ok(row, `no rendered row for account ${acct.name}`);
    marked[acct.name] = row.slice(GLYPH_AT, GLYPH_AT + general.length);
  }
  const on = name => Object.entries(marked)
    .filter(([, cells]) => cells[general.indexOf(name)] === '►').map(([n]) => n);
  return { status, general, on };
}

test('the TUI marks nobody on a route whose per-account figures the payload withdrew', () => {
  const now = Date.now();
  const { status, general, on } = glyphs(now);

  const wide = status.routing.find(e => e.route === 'wide');
  assert.equal(wide?.figuresAbsent, 'representative-captured',
    'the premise: the payload withdrew this route\'s figures');
  assert.ok(general.includes('wide'),
    'the premise: this route takes a general-route glyph column at all');
  // The two fields really do disagree — otherwise the assertion below passes
  // because there was nothing to get wrong.
  const listed = (status.routes.find(r => r.name === 'wide')?.accounts || [])
    .filter(a => a.eligible).map(a => a.name);
  assert.ok(listed.length,
    'the fixture is degenerate: getRoutes() marks nobody eligible, so the two views agree');

  assert.deepEqual(on('wide'), [],
    'the TUI marks an owner for a route whose figures the payload withdrew');

  // POSITIVE CONTROL: the column must still be capable of marking, or "marks
  // nobody" is satisfied by a renderer that stopped marking anything.
  assert.ok(on('other').length + on('exact').length > 0,
    'no route marks anybody: the glyph column is dead and proves nothing');
});

test('the TUI still marks the accounts a published scope admits', () => {
  const now = Date.now();
  const { status, on } = glyphs(now);
  // `other` is `claude-haiku-4-5*`, which beta claims and alpha does not.
  const other = status.routing.find(e => e.route === 'other');
  assert.equal(other?.figuresAbsent ?? null, null, 'the premise: this scope published');
  assert.deepEqual(other.band?.admitted, ['beta'], 'the premise: it admits exactly beta');
  assert.deepEqual(on('other'), ['beta'],
    'the glyph column disagrees with the scope that published the figures');
});
