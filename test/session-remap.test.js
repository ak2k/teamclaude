import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { SessionTracker } from '../src/session-tracker.js';

const SHARED = 'unified7d';
const FABLE = 'unified7dFable';
const OPUS_MODEL = 'claude-opus-5';
const FABLE_MODEL = 'claude-fable-5';

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

test('remapAccounts moves every pinned session and unpins on a null result', () => {
  const st = new SessionTracker();
  st.touch('s0', 0, [SHARED]);
  st.touch('s1', 1, [SHARED]);
  st.touch('s2', 2, [SHARED]);
  st.touch('none'); // never served: no pin to move
  st.remapAccounts(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx));
  assert.equal(st.pinnedAccount('s0', SHARED), 0);
  assert.equal(st.pinnedAccount('s1', SHARED), null);
  assert.equal(st.pinnedAccount('s2', SHARED), 1);
  assert.equal(st.pinnedAccount('none', SHARED), null);
});

test('remapAccounts moves every bucket of a session pinned to two accounts', () => {
  const st = new SessionTracker();
  st.touch('split', 0, [SHARED]);
  st.touch('split', 2, [FABLE]);
  st.remapAccounts(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx));
  assert.equal(st.pinnedAccount('split', SHARED), 0);
  assert.equal(st.pinnedAccount('split', FABLE), 1, 'the second bucket was left on a stale index');
});

test('remapAccounts drops only the bucket whose account went away', () => {
  const st = new SessionTracker();
  st.touch('split', 1, [SHARED]);
  st.touch('split', 2, [FABLE]);
  st.remapAccounts(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx));
  assert.equal(st.pinnedAccount('split', SHARED), null);
  assert.equal(st.pinnedAccount('split', FABLE), 1);
  assert.equal(st.isPinned('split'), true, 'the whole session was unpinned');
});

test('removing an account renumbers the sessions pinned above it', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98,
    { distributeSessions: true });
  am.recordSession('s-a', 0, OPUS_MODEL);
  am.recordSession('s-b', 1, OPUS_MODEL);
  am.recordSession('s-c', 2, OPUS_MODEL);
  am.removeAccount(1); // drop 'b' → 'c' slides down to index 1
  assert.equal(am.sessionTracker.pinnedAccount('s-a', SHARED), 0);
  assert.equal(am.sessionTracker.pinnedAccount('s-b', SHARED), null); // its account is gone
  assert.equal(am.sessionTracker.pinnedAccount('s-c', SHARED), 1);
});

test('a session keeps its own account when an account below it is removed', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c'), oauth('d')], 0.98,
    { distributeSessions: true });
  am.recordSession('s-c', 2); // pinned to 'c'
  am.removeAccount(1);        // 'c' → 1, 'd' → 2: the stale index would name 'd'
  assert.equal(am.getActiveAccount(null, null, null, 's-c').name, 'c');
});

test('removing an account unpins it across every bucket of a split session', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98,
    { distributeSessions: true });
  am.recordSession('split', 1, OPUS_MODEL);  // Opus on 'b'
  am.recordSession('split', 2, FABLE_MODEL); // Fable on 'c'
  am.removeAccount(1);
  assert.equal(am.sessionTracker.pinnedAccount('split', SHARED), null);
  assert.equal(am.sessionTracker.pinnedAccount('split', FABLE), 1, "'c' slid down to 1");
});

test('a surviving pin keeps the rollover baseline the removal renumbered', () => {
  const H = 3600_000;
  const am = new AccountManager([oauth('a'), oauth('doomed'), oauth('c')], 0.98,
    { distributeSessions: true, expiryRouting: { enabled: true } });
  const now = Date.now();
  const weekly = [[0.1, 60], [0.1, 60], [0.5, 50]];
  am.accounts.forEach((acct, i) => {
    acct.quota.unified7d = weekly[i][0];
    acct.quota.unified7dReset = now + weekly[i][1] * H;
    acct.probing = false;
  });
  am.recordSession('s1', 2, OPUS_MODEL); // pinned to 'c', its rollover baseline seeded from it
  am.confirmRouted('s1', 2, OPUS_MODEL);
  am.removeAccount(1);                   // 'c' → 1: the baseline has to move with the pin
  assert.equal(am.sessionTracker.pinnedAccount('s1', SHARED), 1);
  const q = am.accounts[1].quota;        // 'c' rolls over a week out
  q.unified7d = 0;
  q.unified7dReset += 168 * H;
  assert.equal(am.getActiveAccount(null, OPUS_MODEL, null, 's1').name, 'a');
});
