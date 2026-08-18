import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// TUI account management (settings screen) + the on-demand quota probe (`p`).
// Same approach as tui-routes.test.js: a minimal AccountManager stand-in and a
// stubbed render() so these exercise the state machine, not the terminal.

function makeTUI({ accounts = [{ name: 'a', index: 0, type: 'oauth', credential: 't' }], probeQuota } = {}) {
  const calls = { added: [], removed: [], probed: 0 };
  const am = {
    accounts,
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
    addAccount(entry) { calls.added.push(entry); this.accounts.push({ ...entry, index: this.accounts.length }); },
    removeAccount(idx) { calls.removed.push(this.accounts[idx]?.name); this.accounts.splice(idx, 1); },
  };
  const config = { proxy: { port: 1 }, accounts: accounts.map(a => ({ name: a.name, type: a.type })), routes: [] };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
    probeQuota: probeQuota === undefined ? (() => { calls.probed++; }) : probeQuota,
  });
  tui.render = () => {}; // bypass terminal rendering
  return { tui, am, config, calls };
}

const type = (tui, s) => { for (const ch of s) tui._key(ch); };
const settle = () => new Promise(r => setTimeout(r, 5)); // let async handlers finish

// Open a settings row by its field id (robust to fields being added/reordered).
function openSettingsRow(tui, id) {
  tui._key('g');
  const idx = tui._settingsFields().findIndex(f => f.id === id);
  for (let i = 0; i < idx; i++) tui._key('down');
  tui._key('enter');
}

test('the a/r shortcuts are gone from normal mode', () => {
  const { tui } = makeTUI();
  tui._key('a');
  assert.equal(tui.mode, 'normal'); // no add chooser
  tui._key('r');
  assert.equal(tui.mode, 'normal'); // no remove selector
});

test('p probes quota on all accounts and logs the result', async () => {
  const { tui, calls } = makeTUI();
  tui._key('p');
  await settle();
  assert.equal(calls.probed, 1);
  assert.equal(tui.mode, 'normal'); // fire-and-forget, no mode change
  assert.ok(tui.log.some(l => /Refreshing quota on 1 account/.test(l.msg)));
  assert.ok(tui.log.some(l => /Quota refresh complete/.test(l.msg)));
});

test('p reports when there is nothing to probe (no OAuth accounts)', async () => {
  const { tui, calls } = makeTUI({ accounts: [{ name: 'k', index: 0, type: 'apikey' }] });
  tui._key('p');
  await settle();
  assert.equal(calls.probed, 0);
  assert.ok(tui.log.some(l => /No OAuth accounts to probe/.test(l.msg)));
});

test('a probe failure is logged, and a re-press probes again', async () => {
  let n = 0;
  const { tui } = makeTUI({ probeQuota: () => { n++; return Promise.reject(new Error('boom')); } });
  tui._key('p');
  await settle();
  assert.ok(tui.log.some(l => /Quota refresh failed: boom/.test(l.msg)));
  tui._key('p');
  await settle();
  assert.equal(n, 2); // the in-flight guard was released
});

test('settings → Add account → API key adds the account and returns to settings', async () => {
  const { tui, am, config, calls } = makeTUI();
  openSettingsRow(tui, 'addAccount');
  assert.equal(tui.mode, 'add');
  tui._key('k'); // API key path
  assert.equal(tui.mode, 'input');
  type(tui, 'sk-test');
  tui._key('enter');
  await settle();
  assert.equal(tui.mode, 'settings'); // input falls back to the launching screen
  assert.equal(calls.added.length, 1);
  assert.equal(am.accounts.length, 2);
  assert.equal(config.accounts.at(-1).type, 'apikey');
});

test('Esc backs out of the add chooser to settings', () => {
  const { tui } = makeTUI();
  openSettingsRow(tui, 'addAccount');
  tui._key('esc');
  assert.equal(tui.mode, 'settings');
});

test('settings → Remove account removes the picked account and returns to settings', async () => {
  const { tui, am, config, calls } = makeTUI({
    accounts: [
      { name: 'a', index: 0, type: 'oauth', credential: 't' },
      { name: 'b', index: 1, type: 'oauth', credential: 't' },
    ],
  });
  openSettingsRow(tui, 'removeAccount');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'remove');
  tui._key('down'); // pick "b"
  tui._key('enter');
  await settle();
  assert.deepEqual(calls.removed, ['b']);
  assert.equal(am.accounts.length, 1);
  assert.equal(config.accounts.length, 1);
  assert.equal(tui.mode, 'settings'); // back where the flow started
});

test('the Remove account row is absent with no accounts, and Esc from remove-select returns to settings', () => {
  const none = makeTUI({ accounts: [] });
  assert.ok(!none.tui._settingsFields().some(f => f.id === 'removeAccount'));
  assert.ok(none.tui._settingsFields().some(f => f.id === 'addAccount')); // add still offered

  const { tui } = makeTUI();
  openSettingsRow(tui, 'removeAccount');
  tui._key('esc');
  assert.equal(tui.mode, 'settings');
});

test('Event logging setting cycles show → hide → block and writes config', async () => {
  const { tui, config } = makeTUI();
  config.eventLogging = 'hide';
  await tui._cycleEventLogging(+1); // hide → block
  assert.equal(config.eventLogging, 'block');
  await tui._cycleEventLogging(+1); // block → show
  assert.equal(config.eventLogging, 'show');
  await tui._cycleEventLogging(-1); // show → block
  assert.equal(config.eventLogging, 'block');
});

test('Blocked models editor: add a glob then delete it, persisting each change', async () => {
  const { tui, config } = makeTUI();
  openSettingsRow(tui, 'blocklist');
  assert.equal(tui.mode, 'blocklist');

  tui._key('a'); // add
  assert.equal(tui.mode, 'input');
  type(tui, '*fable*');
  tui._key('enter');
  await settle();
  assert.deepEqual(config.blockedModels, ['*fable*']);
  assert.equal(tui.mode, 'blocklist');

  tui._key('d'); // delete the selected entry
  await settle();
  assert.deepEqual(config.blockedModels, []);

  tui._key('esc');
  assert.equal(tui.mode, 'settings');
});

test('Blocked models editor: a duplicate glob is not added twice', async () => {
  const { tui, config } = makeTUI();
  config.blockedModels = ['*fable*'];
  openSettingsRow(tui, 'blocklist');
  tui._key('a');
  type(tui, '*fable*');
  tui._key('enter');
  await settle();
  assert.deepEqual(config.blockedModels, ['*fable*']);
});

test('select mode entered from the dashboard still returns to normal', () => {
  const { tui } = makeTUI();
  tui._key('d'); // enable/disable selector from normal mode
  assert.equal(tui.mode, 'select');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
});

// Importing the credentials of a second organization must not swallow the first.
// Both entries are named from the same email, so matching on the name alone drops
// one from the config and — worse here — rewrites the surviving in-memory
// account's accountUuid/orgUuid, collapsing two live accounts into one without
// even a restart.
test('importing a second org adds an account instead of overwriting the first', async () => {
  const accounts = [{ name: 'a@x.com', index: 0, type: 'oauth', credential: 'old', accountUuid: 'u1', orgUuid: 'o-personal', orgName: 'Personal' }];
  const { tui, am, config, calls } = makeTUI({ accounts });
  config.accounts = [{ name: 'a@x.com', type: 'oauth', accountUuid: 'u1', orgUuid: 'o-personal', orgName: 'Personal' }];
  tui._readCredentials = async () => ({ accessToken: 'new', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  tui._readProfile = async () => ({ email: 'a@x.com', accountUuid: 'u1', orgUuid: 'o-acme', orgName: 'Acme' });

  await tui._doImport();

  assert.equal(config.accounts.length, 2);
  assert.equal(calls.added.length, 1);
  assert.equal(am.accounts[0].orgUuid, 'o-personal');       // the running account kept its identity
  assert.equal(am.accounts[0].credential, 'old');           // and its own token
  assert.deepEqual(config.accounts.map(a => a.name), ['a@x.com (Personal)', 'a@x.com (Acme)']);
});

test('re-importing the same account+org still updates in place', async () => {
  const accounts = [{ name: 'a@x.com', index: 0, type: 'oauth', credential: 'old', accountUuid: 'u1', orgUuid: 'o-acme', orgName: 'Acme' }];
  const { tui, am, config, calls } = makeTUI({ accounts });
  config.accounts = [{ name: 'a@x.com', type: 'oauth', accountUuid: 'u1', orgUuid: 'o-acme', orgName: 'Acme' }];
  tui._readCredentials = async () => ({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 });
  tui._readProfile = async () => ({ email: 'a@x.com', accountUuid: 'u1', orgUuid: 'o-acme', orgName: 'Acme' });

  await tui._doImport();

  assert.equal(config.accounts.length, 1);
  assert.equal(calls.added.length, 0);
  assert.equal(am.accounts[0].credential, 'fresh');
});

// Picking an account with 's' is the same act as POST /teamclaude/switch, and
// both have to go through the manager's one currentIndex writer — establishing
// the account and recording what its windows looked like are one thing. Driven
// against a REAL AccountManager: a stand-in that reimplements the write is the
// thing under test reimplemented by its own test.
test('picking an account in the TUI establishes it as a rollover baseline', () => {
  const H = 3600_000;
  const now = Date.now();
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k1' },
    { name: 'b', type: 'apikey', apiKey: 'k2' },
    { name: 'c', type: 'apikey', apiKey: 'k3' },
  ], 0.98, { expiryRouting: { enabled: true } });
  const weekly = [[0.2, 50], [0.5, 60], [0.1, 70]];
  am.accounts.forEach((acct, i) => {
    acct.quota.unified7d = weekly[i][0];
    acct.quota.unified7dReset = now + weekly[i][1] * H;
    acct.probing = false;
  });
  const tui = new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: am.accounts.map(a => ({ name: a.name, type: a.type })), routes: [] },
    sx: null, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};

  tui._key('s');
  assert.equal(tui.mode, 'select', 'the switch picker did not open');
  tui._key('down');
  tui._key('enter');
  assert.equal(am.currentIndex, 1, 'the pick did not move the current account');

  am.accounts[1].quota.unified7d = 0;
  am.accounts[1].quota.unified7dReset += 168 * H;
  assert.notEqual(am.getActiveAccount(null, 'claude-opus-5').name, 'b',
    'the account the TUI switched to first-sighted its own window, so its roll never fired');
  assert.equal(am.getStatus().expiryRouting.stats.rolloversDetected, 1);
});
