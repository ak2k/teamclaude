import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

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
    .filter(([, cells]) => /[\u25ba\u25b8]/.test(cells[general.indexOf(name)] || '')).map(([n]) => n);
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

// ── THE SETTINGS SCREEN IS THE THIRD CONSUMER, and it was still answering from
// the old field after the other two were converted. One route could be answered
// three different ways on three surfaces: the status renderer and the dashboard
// glyphs from `routeNaming()`, and the auto-detected line from
// `getRoutes().accounts` — the stripped-sample view.
//
// THE CONFIGURED BLOCK ABOVE IT IS DELIBERATELY NOT CONVERTED and the second
// test here pins that. It prints what the OPERATOR TYPED, which is a settings
// editor showing configuration and is correct; converting it would be a new
// defect wearing this one's justification. The display's CLAIM decides its
// source — configuration screens paint config, status answers paint the rule.
test('the settings auto-detected line answers from the shared rule', () => {
  const now = Date.now();
  const am = new AccountManager(
    [{ name: 'owner', type: 'apikey', apiKey: 'k1', models: ['claude-fable-5'] },
      { name: 'other', type: 'apikey', apiKey: 'k2', models: ['claude-sonnet-4-6'] }],
    0.98, { routes: [] });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota,
      unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H,
      unified7dFable: 0.2 + i * 0.1, unified7dFableReset: now + 40 * H };
  });
  const status = am.getStatus();
  assert.ok(status.routes.some(r => r.autocreated),
    'the premise: a family metered separately produced an AUTOCREATED route');
  const admitted = new Set(status.routing
    .filter(e => e.scope === 'route' && e.figuresAbsent == null)
    .flatMap(e => e.band?.admitted || []));
  const notAdmitted = ['owner', 'other'].filter(n => !admitted.has(n));
  assert.ok(admitted.size && notAdmitted.length,
    'the fixture is degenerate: the rule admits everyone, so the two sources cannot disagree');

  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, routes: [] },
    sx: null, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  const lines = [];
  tui._renderRoutes(lines);
  const auto = lines.map(strip).find(l => l.includes('*fable*'));
  assert.ok(auto, 'the settings screen renders the auto-detected route');

  for (const name of notAdmitted) {
    assert.doesNotMatch(auto, new RegExp(`\\b${name}\\b`),
      `the auto line names ${name}, which the shared rule does not admit`);
  }
  // POSITIVE CONTROL: it must still name the admitted account, or this passes
  // on a line that stopped naming anyone.
  for (const name of admitted) {
    assert.match(auto, new RegExp(`\\b${name}\\b`),
      `the auto line dropped ${name}, which the shared rule admits`);
  }
});

// ── A SURFACE THAT CANNOT RENDER THE MARKER MUST NOT SILENTLY DROP WHAT THE
// MARKER QUALIFIES.
//
// The status line says `→ fiveOwner (split by model claims; other ids may go
// elsewhere)`. This column showed `fiveOwner` marked, the sibling-owner
// unmarked, and said NOTHING — the same set as the status line with the
// disclosure removed. That is the one-payload-two-surfaces shape appearing
// inside the commit that added the disclosure, which is why the glyph column
// needs a qualified mark of its own rather than an exemption.
//
// `▸` marks "admitted, on a basis that does not cover this route". It is put on
// the accounts the rule DOES admit rather than on everyone it cannot rule out:
// the qualifier is about the ROUTE'S ANSWER being partial, and marking every
// unadmitted account would be this renderer inventing per-account answers it
// does not have — the defect class this round keeps finding.
test('the glyph column qualifies a route whose basis does not cover it', () => {
  const now = Date.now();
  const routes = [
    { name: 'wide', match: ['*opus*'], accounts: [] },
    { name: 'plain', match: ['claude-haiku-4-5'], accounts: [] },
  ];
  const am = new AccountManager([
    { name: 'fiveOwner', type: 'apikey', apiKey: 'k5', models: ['claude-opus-4-5'] },
    { name: 'fourOwner', type: 'apikey', apiKey: 'k4', models: ['claude-opus-4-1'] },
  ], 0.98, { routes });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota,
      unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H };
  });
  const status = am.getStatus();
  const entry = status.routing.find(e => e.route === 'wide');
  assert.ok(entry?.familySplit,
    'the premise: the payload reports a basis gap on this route');
  const admitted = entry.band?.admitted || [];
  assert.ok(admitted.length, 'the fixture is degenerate: nothing is admitted, so nothing is marked');

  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, routes },
    sx: null, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  const lines = renderFrame(tui);
  const general = status.routes
    .filter(r => !/fable|sonnet/i.test(`${r.name} ${(r.match || []).join(' ')}`)).map(r => r.name);
  const nameAt = GLYPH_AT + general.length + 1;
  const col = general.indexOf('wide');
  assert.ok(col >= 0, 'the premise: the split route takes a glyph column');

  const cellFor = name => {
    const row = lines.find(l => l.slice(nameAt).startsWith(name));
    assert.ok(row, `no rendered row for ${name}`);
    return row[GLYPH_AT + col];
  };
  // PINNED-BY-DESIGN, and the distinction is the point of the whole test: this
  // asserts WHICH mark is used, not whether anything is marked. A widened
  // matcher here would accept the complete glyph and the assertion would grade
  // nothing — the defect it holds is precisely a qualified route rendering as a
  // complete one. Matchers that ask "is it marked at all" belong to the
  // vocabulary class and are widened (see the helper above); an identity claim
  // about a specific glyph is the one case that must stay literal.
  for (const name of admitted) {
    assert.equal(cellFor(name), '▸',
      `${name} is marked as if this route's answer were complete, while the status `
      + 'line discloses that its basis does not cover the route');
  }
});

// ── ATTACH MODE MUST GRADE WITH THE SERVER'S BLOCKLIST, NOT THE LOCAL ONE.
//
// The dashboard polls a server, and that server copies its own `blockedModels`
// into the payload. `this.config` is the config of whatever machine the
// dashboard is running on — a different list, and usually empty. Grading the
// route glyphs with the local one was wrong in BOTH directions and both were
// reproduced, which is why both are asserted here: two models reported them as
// separate findings and they are one root.
//
// The preference is deliberately asymmetric: in LOCAL mode `getStatus()` does
// not carry `blockedModels` at all, so the config IS the source there. The
// payload wins only when it actually has a list.
function attachGlyphs(serverBlocked, localBlocked) {
  const now = Date.now();
  const src = new AccountManager(
    [{ name: 'alpha', type: 'apikey', apiKey: 'ka', models: ['claude-opus-4-5'] },
      { name: 'beta', type: 'apikey', apiKey: 'kb', models: ['claude-haiku-4-5'] }],
    0.98, {
      routes: [{ name: 'op', match: ['*opus*'], accounts: [] },
        { name: 'hk', match: ['claude-haiku-4-5*'], accounts: [] }],
    });
  src.accounts.forEach((x, i) => {
    x.quota = { ...x.quota,
      unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
      unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H };
  });
  const status = { ...src.getStatus(), blockedModels: serverBlocked };
  const am = new RemoteAccountManager();
  am.applyStatus(status);
  const tui = new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, routes: [], blockedModels: localBlocked },
    sx: null, saveConfig: async () => {}, syncAccounts: async () => 0,
    onQuit: () => {}, remote: true,
  });
  const lines = renderFrame(tui);
  const general = status.routes
    .filter(r => !/fable|sonnet/i.test(`${r.name} ${(r.match || []).join(' ')}`))
    .map(r => r.name);
  const nameAt = GLYPH_AT + general.length + 1;
  const marks = {};
  for (const n of ['alpha', 'beta']) {
    const row = lines.find(l => l.slice(nameAt).startsWith(n));
    assert.ok(row, `no rendered row for ${n} in attach mode`);
    marks[n] = row.slice(GLYPH_AT, GLYPH_AT + general.length);
  }
  return name => Object.entries(marks)
    .filter(([, cells]) => /[►▸]/.test(cells[general.indexOf(name)] || '')).map(([k]) => k);
}

test('attach mode does not blank a live route because the LOCAL config blocks it', () => {
  const baseline = attachGlyphs([], []);
  assert.ok(baseline('op').length,
    'the fixture is degenerate: nothing marks the route even with nothing blocked');
  const localBlocks = attachGlyphs([], ['*opus*']);
  assert.deepEqual(localBlocks('op'), baseline('op'),
    'a route the SERVER considers live lost its owner because the local config blocks it');
});

test('attach mode does not keep marking a route the SERVER blocks', () => {
  const baseline = attachGlyphs([], []);
  assert.ok(baseline('op').length, 'the fixture is degenerate: nothing to lose');
  const serverBlocks = attachGlyphs(['*opus*'], []);
  assert.deepEqual(serverBlocks('op'), [],
    'a route the server BLOCKS still marks an owner, because the local config does not block it');
  // POSITIVE CONTROL: the other route is unaffected, so this is not "the column
  // stopped marking anything".
  assert.ok(serverBlocks('hk').length,
    'the unblocked route stopped marking too — the column died rather than the block applying');
});

test('the settings CONFIGURED routes block still prints what the operator typed', () => {
  const now = Date.now();
  const am = new AccountManager(
    [{ name: 'owner', type: 'apikey', apiKey: 'k1' },
      { name: 'other', type: 'apikey', apiKey: 'k2' }],
    0.98, { routes: [] });
  am.accounts.forEach((x, i) => {
    x.quota = { ...x.quota, unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H };
  });
  // The CONFIG's own route list: bare strings, as the operator entered them.
  const config = {
    proxy: { port: 1 },
    routes: [{ name: 'typed', match: ['*opus*'], accounts: ['owner', 'other'] }],
  };
  const tui = new TUI({
    accountManager: am, config,
    sx: null, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  const lines = [];
  tui._renderRoutes(lines);
  const typed = lines.map(strip).find(l => l.includes('*opus*'));
  assert.ok(typed, 'the settings screen renders the configured route');
  for (const name of ['owner', 'other']) {
    assert.match(typed, new RegExp(`\\b${name}\\b`),
      `the configured block dropped ${name}; it must show the configuration as entered, `
      + 'not a graded answer about who serves');
  }
});


// ── THE REASON IS NOT ONE REASON.
//
// `routeNaming` returns `source: 'none'` for FOUR different facts — the scopes
// were captured, everything measured is blocked, nothing was measured, or no id
// can reach the route at all. The settings auto line collapsed all four to
// "(no figures)", so a BLOCKED route reported that its data was missing. The
// names were right and the REASON was false, and an operator acts differently
// on the two: one is a switch they flipped, the other is a gap in the report.
//
// The status line has always distinguished these. One payload described two
// ways is the shape this round keeps finding, so it is asserted rather than
// left to the next reader.
test('the settings auto line says WHY it names nobody', () => {
  const now = Date.now();
  const build = (blockedModels) => {
    const am = new AccountManager([
      { name: 'owner', type: 'apikey', apiKey: 'k1', models: ['claude-fable-5'] },
      { name: 'other', type: 'apikey', apiKey: 'k2', models: ['claude-sonnet-4-6'] },
    ], 0.98, { routes: [] });
    am.accounts.forEach((x, i) => {
      x.quota = { ...x.quota,
        unified5h: 0.05 + i * 0.05, unified5hReset: now + 2 * H,
        unified7d: 0.2 + i * 0.1, unified7dReset: now + 40 * H,
        unified7dFable: 0.2 + i * 0.1, unified7dFableReset: now + 40 * H };
    });
    const tui = new TUI({
      accountManager: am,
      config: { proxy: { port: 1 }, routes: [], blockedModels },
      sx: null, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    });
    tui.render = () => {};
    const lines = [];
    tui._renderRoutes(lines);
    return lines.map(strip).find(l => l.includes('*fable*'));
  };

  const blocked = build(['*fable*']);
  const clear = build([]);
  assert.ok(blocked && clear, 'the settings screen renders the auto-detected route');
  assert.notEqual(blocked, clear,
    'the fixture is degenerate: blocking changes nothing, so no reason was exercised');
  assert.match(blocked, /block/i,
    'a BLOCKED route does not say it is blocked — the names are right and the reason is false');
  assert.doesNotMatch(blocked, /no figures/,
    'a blocked route reports its data as missing, which is a different fact');
});
