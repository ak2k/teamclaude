// Shared fixture for the tests that hold "window state is keyed by (request
// bucket, account)".
//
// The window a bucket resolves to COLLAPSES onto the shared weekly for any
// family the account reports no utilization for, and that is the shipped
// fleet's ordinary case rather than an edge: every live account reports
// `unified7dSonnet: null`, and any account that has not served Fable reports no
// Fable bucket either. Under the collapse two buckets that are pinned,
// preempted and settled SEPARATELY resolve to one window, so anything keyed by
// the window merges them.
//
// No fixture in this suite produced that collision, which is why four
// separately wrong implementations of the key passed every test. Every test of
// the keying builds its fleet here and anchors on `assertCollapses`, so a fleet
// that quietly stops colliding fails loudly instead of passing for the wrong
// reason.
//
// Not named `*.test.js`, so it carries no tests of its own.
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

export const H = 3600_000;
export const WEEK_MS = 168 * H;
export const OPUS = 'claude-opus-5';
export const SONNET = 'claude-sonnet-4-6';
export const FABLE = 'claude-fable-5';

export function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, ...extra };
}

/**
 * A fleet metering ONLY the shared weekly bucket, from { name, used, resetH }.
 * Every family bucket is deliberately left unreported, which is what makes
 * `unified7dFable` and `unified7dSonnet` resolve to the `unified7d` window.
 */
export function collapsingManager(specs, { er = { enabled: true }, distribute = true } = {}) {
  const am = new AccountManager(specs.map(s => oauth(s.name, s.extra)), 0.98,
    { distributeSessions: distribute, ...(er ? { expiryRouting: er } : {}) });
  const now = Date.now();
  specs.forEach((s, i) => {
    const q = am.accounts[i].quota;
    q.unified7d = s.used;
    q.unified7dReset = now + s.resetH * H;
    am.accounts[i].probing = false;
  });
  assertCollapses(am);
  return am;
}

/** The anchor: every family model really is governed by the shared window on
 * every account, so a test built on this fleet is exercising the collapse. */
export function assertCollapses(am, models = [SONNET, FABLE]) {
  for (const account of am.accounts) {
    for (const model of models) {
      assert.equal(am._governingBucket(account, model), 'unified7d',
        `"${account.name}" meters ${model} separately, so this fleet does not collapse and proves nothing`);
    }
  }
}

/** Route one session request the way the server does: hold the session in
 * flight for the whole request, select, pin, confirm what served it, release. */
export function route(am, sid, model = OPUS, advisorModel = null) {
  am.beginSession(sid);
  try {
    const decision = {};
    const acc = am.getActiveAccount(null, model, advisorModel, sid, decision);
    if (acc) {
      am.recordSession(sid, acc.index, model, advisorModel, decision);
      am.confirmRouted(sid, acc.index, model, advisorModel, decision);
    }
    return acc;
  } finally {
    am.endSession(sid);
  }
}

/** Roll an account's shared weekly window: fresh utilization, reset a week on.
 * Under the collapse this rolls every family bucket with it, because they all
 * read that window. */
export function rollWeekly(am, idx) {
  const q = am.accounts[idx].quota;
  q.unified7d = 0;
  q.unified7dReset += WEEK_MS;
}

export function rolloverStats(am) {
  return am.getStatus().expiryRouting.stats;
}
