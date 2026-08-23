import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { renderStatus } from '../src/status-renderer.js';

// THE INVARIANT, enforced rather than promised:
//
//   Every branch by which `_select` can return an account other than the one
//   `previewRouteIndex` names is either MIRRORED in the preview, or NAMED in the
//   preview's docstring as a deliberate absence.
//
// The prose enumeration of that surface happens to be complete today. This is
// what makes it stay complete: a new branch added to `_select` and not mirrored
// fails here, instead of surviving until someone reads two functions side by
// side. Two of pass 3's five findings were exactly that — a poll consuming an
// event the request path owned, and requalification re-ranking in one function
// and not the other.
//
// THE THREE DOCUMENTED ABSENCES are exceptions by construction rather than by
// assertion: this drives a SESSION-LESS request with NO advisor model, so the
// session-affinity path and the advisor pass cannot run, and it never builds a
// fleet where every account is over threshold, so the exhausted-fleet probe
// cannot either. Rollover preemption is excluded the same way — no state here
// rolls a window. If a case below ever reaches one of those, the exception has
// stopped being structural and this file is the wrong place to notice it.
//
// PAIRED MANAGERS, NEVER ONE. `previewRouteIndex` and `getActiveAccount` are run
// on two managers built from the same fixture, because asking one and then the
// other on a single manager lets the first call consume state the second would
// have seen — `requalify` is cleared by selection, and a five-hour reset is an
// event. That would grade a state the test's own first call destroyed, which is
// the trap that has caught both of us this round.

const H = 3600e3;
const acct = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `k-${name}`, ...extra });

/** Every state below is a plain fleet plus one named difference. */
function baseFleet(now, opts = {}) {
  const am = new AccountManager(
    [acct('current'), acct('second'), acct('third')], 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 }, ...opts });
  // The current account is deliberately the WORST on pressure while remaining
  // usable. Selection keeps a usable current account without re-ranking, so an
  // untouched fleet stays on it — but any branch that DOES re-rank moves the
  // answer, which is what makes the parity assertions non-vacuous. With the
  // current account also the best, re-ranking returns it and every case agrees
  // for a reason that has nothing to do with the preview mirroring anything.
  am.accounts[0].quota = { ...am.accounts[0].quota,
    unified5h: 0.2, unified5hReset: now + 2 * H,
    unified7d: 0.8, unified7dReset: now + 400 * H,
    unified7dFable: 0.8, unified7dFableReset: now + 400 * H };
  am.accounts[1].quota = { ...am.accounts[1].quota,
    unified5h: 0.05, unified5hReset: now + 2 * H,
    unified7d: 0.1, unified7dReset: now + 20 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 20 * H };
  am.accounts[2].quota = { ...am.accounts[2].quota,
    unified5h: 0.1, unified5hReset: now + 2 * H,
    unified7d: 0.2, unified7dReset: now + 30 * H,
    unified7dFable: 0.2, unified7dFableReset: now + 30 * H };
  am.setCurrentAccount(0);
  return am;
}

/**
 * Each entry names a state `_select` treats specially. A case that stops being
 * special — because the fixture drifted, say — is worse than a missing one, so
 * several carry a premise the harness checks below.
 */
const STATES = [
  ['nothing special', () => {}],
  ['current account disabled', am => { am.accounts[0].disabled = true; }],
  ['current account past its throttle hold', am => {
    am.accounts[0].status = 'throttled';
    am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  }],
  ['current account still inside its throttle hold', am => {
    am.accounts[0].status = 'throttled';
    am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
  }],
  ['current account over its five-hour cap', am => {
    am.accounts[0].quota = { ...am.accounts[0].quota, unified5h: 0.99 };
  }],
  ['current account\'s five-hour window has already reset', am => {
    am.accounts[0].quota = { ...am.accounts[0].quota, unified5h: 0.99, unified5hReset: Date.now() - 60_000 };
  }],
  ['current account requalifying', am => { am.accounts[0].requalify = true; }],
  ['a strictly higher-priority account is available', am => { am.accounts[2].priority = -1; }],
  ['current account exhausted', am => { am.accounts[0].status = 'exhausted'; }],
  // THE PROLOGUE, which is not a branch of `_select` at all: `getActiveAccount`
  // runs `refreshExpiredQuotas` before any selection, and both of its effects
  // change the answer. Neither appeared here until pass 4 filed them, because
  // the enumeration this matrix was built from walked `_select` and never
  // walked its caller.
  ['a non-current weekly window has already reset, and the fleet must re-rank', am => {
    am.accounts[0].disabled = true;
    am.accounts[1].quota = { ...am.accounts[1].quota,
      unified7d: 0.95, unified7dReset: Date.now() - 60_000 };
  }],
  ['a five-hour reset moves the current account before selection runs', am => {
    am.accounts[1].quota = { ...am.accounts[1].quota,
      unified5h: 0.9, unified5hReset: Date.now() - 60_000 };
  }],
];

const ROUTED = [
  ['manual pin, pinned account eligible', am => { am.setRoutePin('fable', 2); }],
  ['manual pin, pinned account barred', am => {
    am.accounts[2].quota = { ...am.accounts[2].quota, unified5h: 0.99 };
    am.setRoutePin('fable', 2);
  }],
  ['manual pin, pinned account disabled', am => {
    am.accounts[2].disabled = true;
    am.setRoutePin('fable', 2);
  }],
];

function parity(label, arrange, model, opts) {
  const now = Date.now();
  // Two managers from one fixture. Never one asked twice.
  const previewed = baseFleet(now, opts);
  arrange(previewed);
  const served = baseFleet(now, opts);
  arrange(served);

  const index = previewed.previewRouteIndex(model);
  const previewSays = index == null ? null : previewed.accounts[index].name;
  const account = served.getActiveAccount(null, model, null, null, {});
  const requestGets = account ? account.name : null;

  assert.equal(previewSays, requestGets,
    `${label}: the preview names ${previewSays}, a request is served by ${requestGets}`);
  return { previewSays, requestGets };
}

test('the preview names the account a plain request is served by, in every state selection treats specially', () => {
  const seen = new Set();
  for (const [label, arrange] of STATES) {
    const { previewSays } = parity(label, arrange, null);
    seen.add(previewSays);
  }
  // A matrix whose every case answers the same account is a matrix that proved
  // nothing about branching. Several of these states must move the answer.
  assert.ok(seen.size > 1,
    'every state produced the same destination, so no branch was actually exercised');
});

test('the preview matches selection for a routed model, pinned or not', () => {
  const routes = [{ name: 'fable', match: ['*fable*'] }];
  for (const [label, arrange] of ROUTED) {
    parity(label, arrange, 'claude-fable-5', { routes });
  }
});

// THE BLOCK HAS TWO DESTINATION ROWS ANSWERING TWO DIFFERENT QUESTIONS, and
// they need two different oracles. Everything above drives a SESSION-LESS
// request, which is the right oracle for `Next request` and cannot be the one
// for `New session` — that row is a claim about a request carrying a new
// session id, and the session-distribution path only runs for such a request.
//
// Grading one row and not the other is how a regression landed in the row that
// was ungraded: the condition selecting between the two destinations was
// changed, the session-less oracle agreed either way, and nothing failed.
const NEW_SESSION_STATES = [
  ['no pin, so the session-distribution path RUNS', () => {}],
  ['an ineligible pin, so that path is SKIPPED', am => {
    am.accounts[2].quota = { ...am.accounts[2].quota, unified5h: 0.99 };
    am.setRoutePin('fable', 2);
  }],
  ['an eligible pin, which wins outright', am => { am.setRoutePin('fable', 2); }],
];

test('the block names the account a NEW SESSION is served by, which is a different question', () => {
  const routes = [{ name: 'fable', match: ['*fable*'] }];
  const model = 'claude-fable-5';
  let distinguished = 0;

  for (const [label, arrange] of NEW_SESSION_STATES) {
    const now = Date.now();
    // Distribution ON, or both rows resolve through `_select` and the
    // interesting arm is vacuous — the two candidate destinations become the
    // same account for a reason unrelated to anything under test.
    const opts = { routes, distributeSessions: true };
    const observed = baseFleet(now, opts);
    arrange(observed);
    const served = baseFleet(now, opts);
    arrange(served);

    const entry = observed.getStatus().routing.find(e => e.route === 'fable');
    // PER ARM, not once across the set. The router's choice and the load-ranked
    // winner must differ on THIS arm, or this arm holds whichever destination
    // the block printed and contributes nothing — including the honoured-pin
    // arm, which exists to prove the block can still credit a pin and would be
    // satisfied by a block that never consults the pin at all.
    assert.notEqual(entry.target, entry.pick.account,
      `${label}: the router's choice and the pick are the same account, so this arm `
      + 'cannot tell which branch produced the row');
    distinguished += 1;

    const account = served.getActiveAccount(null, model, null, `sess-${label}`, {});
    const expected = account ? account.name : null;
    // THE RENDERER'S OWN OUTPUT, not a model of it. Computing what the block
    // "would" print from `pinnedTo` and `pick` would test a second derivation
    // against the oracle and leave the renderer free to disagree with both —
    // which is the defect class this whole round has been removing.
    const lines = renderStatus(observed.getStatus(), { color: false, now }).split('\n');
    const rowText = (lines.find(l => l.trim().startsWith('New session')) || '');
    const shown = (rowText.match(/→ (\S+)/) || [])[1] ?? null;
    assert.ok(rowText, `${label}: no New session row rendered, so nothing is being compared`);
    assert.equal(shown, expected,
      `${label}: the block names ${shown}, a new session is served by ${expected}`);
  }

  assert.equal(distinguished, NEW_SESSION_STATES.length,
    'an arm was skipped, so the set is smaller than it reads');
});

// THE OTHER DESTINATION ROW, graded the way `New session` is. `parity` above
// grades `previewRouteIndex`, which is what the row is computed from; this
// grades the row itself, because a row can be rendered from something else
// entirely and nothing between the two would notice. Pass 4 named this gap:
// only one of the two rows had an oracle of its own.
test('the rendered Next request row names the account a plain request is served by', () => {
  for (const [label, arrange] of STATES) {
    const now = Date.now();
    const observed = baseFleet(now);
    arrange(observed);
    const served = baseFleet(now);
    arrange(served);

    const account = served.getActiveAccount(null, null, null, null, {});
    const expected = account ? account.name : null;
    const lines = renderStatus(observed.getStatus(), { color: false, now }).split('\n');
    const rowText = (lines.find(l => l.trim().startsWith('Next request')) || '');
    assert.ok(rowText, `${label}: no Next request row rendered, so nothing is being compared`);
    const shown = (rowText.match(/→ (\S+)/) || [])[1] ?? null;
    assert.equal(shown, expected,
      `${label}: the block names ${shown}, a plain request is served by ${expected}`);
  }
});

// The LAST RESORT is a fourth way `_select` returns an account: with nothing
// eligible it reopens the one whose hold has already elapsed rather than
// failing. It is not one of the three documented absences — those are the
// probe, session affinity and rollover preemption — and until it was projected
// the preview answered "nothing can serve this" about the account every request
// was landing on.
//
// This is the one fixture in the file where every account IS unavailable, which
// is the region the probe lives in, so the probe is stubbed and asserted unused:
// otherwise a green here could mean the walk fell through to a mutation the
// preview must never mirror.
//
// EVERY QUOTA VALUE HERE ARRIVES THROUGH `updateQuota`, from headers upstream
// can send. My first fixture set `status = 'exhausted'` by hand and nothing in
// the running system ever writes that value, so it graded this branch from a
// state no fleet reaches. The reachable route is a DESYNCHRONISED five-hour
// pair: `updateQuota` sets each field independently through `setQuotaField`,
// which rejects an out-of-domain value and leaves the field where it was, so a
// response carrying a 5h reset and no usable 5h utilization leaves the reset
// set and the utilization null. `_expiredQuotaView` will not retire that
// window — its guard is `q.unified5h != null` — so once the timestamp passes
// the account carries a reset in the past permanently, while a spent weekly
// keeps it out of every candidate set.
test('the preview names the account the last resort reopens, and not by probing', () => {
  const now = Date.now();
  const secs = ms => String(Math.floor(ms / 1000));
  const build = () => {
    const am = new AccountManager([acct('spent'), acct('offline')], 0.98,
      { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
    am.updateQuota(0, {
      'anthropic-ratelimit-unified-5h-reset': secs(now - 30 * 60e3),
      'anthropic-ratelimit-unified-7d-utilization': '0.995',
      'anthropic-ratelimit-unified-7d-reset': secs(now + 100 * H),
    });
    am.accounts[1].disabled = true;
    am.setCurrentAccount(0);
    return am;
  };

  const previewed = build();
  // Premise 1: the state is the one described above, and the fleet-wide refresh
  // does not retire it. If either stops holding, this grades an ordinary fleet.
  assert.equal(previewed.accounts[0].quota.unified5h, null,
    'the 5h pair is no longer desynchronised, so nothing here needs the last resort');
  previewed.refreshExpiredQuotas();
  assert.ok(previewed.accounts[0].quota.unified5hReset < now,
    'the refresh retired the past reset, which is the route this fixture depends on');
  // Premise 2: ordinary selection must find nothing, or the last resort is not
  // what either side is answering with.
  assert.equal(previewed._pickBestAvailable(null, null, null,
    { observe: true, fleet: previewed._observedFleet().accounts }), null,
    'an account was eligible after all, so this fixture never reaches the last resort');

  const served = build();
  let probes = 0;
  served._selectProbe = () => { probes += 1; return null; };
  const account = served.getActiveAccount(null, null, null, null, {});

  const index = previewed.previewRouteIndex(null);
  assert.equal(index == null ? null : previewed.accounts[index].name,
    account ? account.name : null);
  assert.equal(probes, 0, 'the probe served this request, so the last resort is not what was graded');
});

// The last resort asks "has this window already passed", which is a clock
// question, and the preview must ask it at the instant its projection was taken
// — not at whatever the wall clock says one call later. Graded by handing the
// preview a projection from ten minutes ago: at that instant the window had not
// passed and nothing can serve the fleet; at the wall clock it has, and the
// account is named. A wall-clock read answers the second question for both.
test('the last resort is asked at the instant the projection was taken', () => {
  const wall = Date.now();
  const secs = ms => String(Math.floor(ms / 1000));
  const am = new AccountManager([acct('spent'), acct('offline')], 0.98,
    { expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 } });
  // The reachable desynchronised pair again, with the five-hour reset falling
  // BETWEEN the two instants.
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-reset': secs(wall - 5 * 60e3),
    'anthropic-ratelimit-unified-7d-utilization': '0.995',
    'anthropic-ratelimit-unified-7d-reset': secs(wall + 100 * H),
  });
  am.accounts[1].disabled = true;
  am.setCurrentAccount(0);

  const asked = wall - 10 * 60e3;
  assert.equal(am.previewRouteIndex(null, am._observedFleet(asked)), null,
    'the preview reopened an account whose window had not passed at that instant');
  assert.equal(am.previewRouteIndex(null, am._observedFleet(wall)), 0,
    'the premise: at the wall clock that window HAS passed, so the two instants differ');
});

test('the states that must move the answer do move it', () => {
  // The premise for the matrix above: if `requalify` or a disabled current
  // account stopped changing where a request goes, the parity assertions would
  // hold for a reason that has nothing to do with the preview mirroring
  // anything, and a real divergence could hide behind them.
  const now = Date.now();
  const plain = baseFleet(now);
  const plainGets = plain.getActiveAccount(null, null, null, null, {}).name;
  assert.equal(plainGets, 'current', 'the premise: an untouched fleet stays on the current account');

  for (const label of ['current account disabled', 'current account requalifying',
    'a non-current weekly window has already reset, and the fleet must re-rank',
    'a five-hour reset moves the current account before selection runs']) {
    const [, arrange] = STATES.find(s => s[0] === label);
    const am = baseFleet(now);
    arrange(am);
    const moved = am.getActiveAccount(null, null, null, null, {}).name;
    assert.notEqual(moved, plainGets, `${label}: no longer moves the request, so parity here is vacuous`);
  }
});

// The two prologue arms carry a second premise the others do not: each names a
// window that must ALREADY have expired at the moment the arm runs. A fixture
// whose timestamps drifted into the future would still pass parity — both sides
// would simply agree about an ordinary fleet — and the arm would silently stop
// being about the prologue at all.
test('the prologue states are the states they claim to be', () => {
  const now = Date.now();

  const reranking = baseFleet(now);
  STATES.find(s => s[0].startsWith('a non-current weekly'))[1](reranking);
  const weekly = reranking._expiredQuotaView(reranking.accounts[1]);
  assert.ok(weekly.cleared.includes('weekly'),
    'the arm no longer expires a weekly window, so it grades an ordinary re-rank');
  assert.notEqual(reranking.accounts[1].quota.unified7d, null,
    'and the live quota must still hold the spent figure, or there are not two views to disagree');

  const switching = baseFleet(now);
  STATES.find(s => s[0].startsWith('a five-hour reset'))[1](switching);
  assert.ok(switching._expiredQuotaView(switching.accounts[1]).session,
    'the arm no longer produces a session-reset event, so nothing moves currentIndex');
  const before = switching.currentIndex;
  switching.refreshExpiredQuotas();
  assert.notEqual(switching.currentIndex, before,
    'the prologue no longer moves the current account here, so the arm grades nothing');
});
