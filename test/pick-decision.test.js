import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { decidePick, decidingTerms, pressureRank } from '../src/pick-decision.js';

// The load weight: selection ranked by what accounts are measurably carrying
// rather than by how many sessions each holds.

const OPUS = 'claude-opus-5';
const acct = (name) => ({ name, type: 'apikey', apiKey: `k-${name}` });

function managerWith(names, extra = {}) {
  return new AccountManager(names.map(acct), 0.98, { distributeSessions: true, ...extra });
}

// A session on `idx` whose observed context is `context` tokens. Goes through
// the real recording path so the load being measured is the load the proxy
// would actually have recorded.
function session(am, id, idx, context, model = OPUS) {
  am.recordSession(id, idx, model);
  am.recordTokenUsage(idx, id, model, {
    input_tokens: 0,
    cache_read_input_tokens: context,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  });
}

const pick = (am, model = OPUS) =>
  decidePick(am._pickSnapshot(am.accounts, model, Date.now()));

// ---------------------------------------------------------------------------
// COLD START, which here is structural rather than a mode: an unmeasured fleet
// scores every account zero, so the term cannot discriminate and the tiebreaks
// that existed before decide exactly as they did.
// ---------------------------------------------------------------------------

test('cold start: with nothing measured the load term never decides', () => {
  const am = managerWith(['a', 'b', 'c']);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s2', 0, OPUS);
  const decision = pick(am);
  assert.equal(decision.kind, 'picked');
  assert.notEqual(decision.by, 'load',
    'an unmeasured fleet must not be able to decide on load');
  assert.equal(decision.by, 'sessions');
  assert.equal(decision.index, 1, 'the account with no sessions still wins on count');
});

test('cold start: every account tied on everything reports that nothing decided', () => {
  const am = managerWith(['a', 'b']);
  const decision = pick(am);
  assert.equal(decision.kind, 'picked');
  assert.equal(decision.by, 'first');
  assert.deepEqual(decidingTerms(am._pickSnapshot(am.accounts, OPUS, Date.now()), decision), [],
    'no term separated the field, so none should be reported as deciding');
});

test('an empty candidate set is a decision, not a null', () => {
  assert.deepEqual(decidePick({ accounts: [] }), { kind: 'none', reason: 'no-candidates' });
});

// ---------------------------------------------------------------------------
// THE WEIGHT. The measured case is the one session counting gets wrong.
// ---------------------------------------------------------------------------

// The shape measured on the live fleet: the account with FEWER sessions was
// carrying more load, so counting sessions sent new work to exactly the wrong
// place. Figures are the ratio that was observed (2.4x), not its absolute
// tokens, which would be a corpus number in a test.
test('fewer sessions does not mean less load, and load is what decides', () => {
  const am = managerWith(['heavy', 'light']);
  session(am, 'h1', 0, 300_000);
  session(am, 'h2', 0, 300_000);
  session(am, 'l1', 1, 125_000);
  session(am, 'l2', 1, 125_000);
  session(am, 'l3', 1, 125_000);
  session(am, 'l4', 1, 125_000);

  const snapshot = am._pickSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(snapshot.accounts[0].sessions, 2);
  assert.equal(snapshot.accounts[1].sessions, 4);
  assert.ok(snapshot.accounts[0].load > snapshot.accounts[1].load,
    'the fixture must actually invert count and load, or it proves nothing');

  const decision = decidePick(snapshot);
  assert.equal(decision.by, 'load');
  assert.equal(decision.index, 1,
    'session count would have sent this to the account already carrying more');
});

test('load outranks session count but does not replace it', () => {
  // Both measured, equal load, different counts: the count still decides.
  const am = managerWith(['a', 'b']);
  session(am, 's1', 0, 100_000);
  session(am, 's2', 1, 50_000);
  session(am, 's3', 1, 50_000);
  const decision = pick(am);
  assert.equal(decision.by, 'sessions',
    'with load tied, the term behind it should decide');
  assert.equal(decision.index, 0);
});

// An account can be busy and unmeasured: requests served before any usage
// report landed. It scores zero load, which is indistinguishable from idle, so
// the surviving session count is what keeps it from attracting everything.
test('a busy but unmeasured account does not read as idle', () => {
  const am = managerWith(['unmeasured', 'idle']);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s2', 0, OPUS);
  const snapshot = am._pickSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(snapshot.accounts[0].load, 0, 'unmeasured is zero, same as idle');
  const decision = decidePick(snapshot);
  assert.equal(decision.index, 1);
  assert.equal(decision.by, 'sessions',
    'the count behind the load term is what separates busy-unmeasured from idle');
});

// ---------------------------------------------------------------------------
// SIGNAL ARRIVAL. A feature whose fallback is legitimate behaviour is invisible
// when broken: lose the token read, every account scores zero, selection falls
// back to counting sessions, the fallback is CORRECT, and the fleet looks
// exactly like one that never recorded a token. Every gate stays green while
// the weight quietly does nothing.
//
// The second half is the sharp one here. For a five-hour level, absent versus a
// number is obvious on sight. For token counts, ZERO IS ENORMOUSLY PLAUSIBLE:
// an idle session legitimately has none, so a lost read does not degrade into
// an obviously wrong value, it degrades into one nobody looks at twice. So the
// boundary has to carry the distinction, not merely the number.
// ---------------------------------------------------------------------------

test('signal arrival: measured tokens reach the weight input', () => {
  const am = managerWith(['a', 'b']);
  session(am, 's1', 0, 250_000);
  const snapshot = am._pickSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(snapshot.accounts[0].load, 250_000,
    'the recorded context did not reach the weight, so the weight is inert');
  assert.ok(snapshot.accounts[0].observed > 0,
    'the report count did not reach the weight either');
  assert.equal(snapshot.accounts[1].load, 0,
    'an account with no sessions carries no load');
});

// What `observed` does NOT do, stated so nobody has to rediscover it. Nothing
// reads it at runtime, so it cannot by itself catch a partial loss: a build
// that stopped recording usage on one code path but not another would show
// `sessions > 0, observed = 0` on the affected accounts, and no test here
// constructs that. It makes the state VISIBLE. Acting on it would be a
// different change with a different argument.
test('observed makes a partial loss visible, which is all it claims to do', () => {
  const am = managerWith(['recorded', 'not-recorded']);
  session(am, 'a1', 0, 200_000);
  am.recordSession('b1', 1, OPUS);          // served, never reported
  const [recorded, lost] = am._pickSnapshot(am.accounts, OPUS, Date.now()).accounts;
  assert.ok(recorded.observed > 0 && recorded.load > 0);
  assert.equal(lost.sessions, 1, 'the account is carrying a session');
  assert.equal(lost.observed, 0, 'and nothing was ever observed for it');
  assert.equal(lost.load, 0,
    'which is indistinguishable from idle on load alone: the reason observed exists');
});

test('signal arrival: never-observed is distinguishable from observed-as-zero', () => {
  // Left: sessions exist and NOTHING was ever reported for them. Right:
  // sessions exist and upstream reported a genuinely empty context. Both carry
  // load 0, which is exactly why load alone cannot tell them apart.
  const am = managerWith(['never-observed', 'observed-zero']);
  am.recordSession('u1', 0, OPUS);
  am.recordSession('u2', 0, OPUS);
  session(am, 'z1', 1, 0);
  session(am, 'z2', 1, 0);

  const snapshot = am._pickSnapshot(am.accounts, OPUS, Date.now());
  const [never, zero] = snapshot.accounts;
  assert.equal(never.load, 0);
  assert.equal(zero.load, 0);
  assert.equal(never.sessions, zero.sessions,
    'the two accounts must be identical on every other term, or this proves nothing');

  assert.equal(never.observed, 0, 'nothing was ever observed for this account');
  assert.ok(zero.observed > 0,
    'a genuinely empty context was still an observation, and must not read as absence');
});

test('priority still outranks measured load', () => {
  const am = managerWith(['preferred', 'spare']);
  am.accounts[1].priority = 100;
  session(am, 's1', 0, 900_000);
  const decision = pick(am);
  assert.equal(decision.by, 'priority');
  assert.equal(decision.index, 0, 'a loaded account still beats a lower-priority idle one');
});

test('the load is pooled across families, because the rate ceiling is', () => {
  const am = managerWith(['a', 'b']);
  session(am, 's1', 0, 200_000, 'claude-opus-5');
  session(am, 's2', 0, 200_000, 'claude-fable-5');
  const snapshot = am._pickSnapshot(am.accounts, OPUS, Date.now());
  assert.equal(snapshot.accounts[0].load, 400_000,
    'an Opus context and a Fable context are both load on the same five-hour bucket');
});

test('nothing in the weight reads quota', () => {
  // Same fleet twice; the second has every quota field an account can carry.
  const bare = managerWith(['a', 'b']);
  session(bare, 's1', 0, 100_000);
  const quotaed = managerWith(['a', 'b']);
  session(quotaed, 's1', 0, 100_000);
  const now = Date.now();
  for (const a of quotaed.accounts) {
    a.quota.unified5h = 0.9;
    a.quota.unified5hReset = now + 3600e3;
    a.quota.unified7d = 0.8;
    a.quota.unified7dReset = now + 7 * 86400e3;
  }
  const bareSnap = bare._pickSnapshot(bare.accounts, OPUS, now);
  const quotaSnap = quotaed._pickSnapshot(quotaed.accounts, OPUS, now);
  assert.deepEqual(
    bareSnap.accounts.map(a => ({ ...a, reset: 0 })),
    quotaSnap.accounts.map(a => ({ ...a, reset: 0 })),
    'a quota field moved a load term, so the weight is not token-only');
});

// ---------------------------------------------------------------------------
// THE SEAM.
// ---------------------------------------------------------------------------

test('the weight changes which account real selection returns', () => {
  const build = () => {
    const am = managerWith(['heavy', 'light']);
    session(am, 'h1', 0, 400_000);
    session(am, 'l1', 1, 50_000);
    session(am, 'l2', 1, 50_000);
    return am;
  };
  const am = build();
  const snapshot = am._pickSnapshot(am.accounts, OPUS, Date.now());
  assert.ok(snapshot.accounts[0].sessions < snapshot.accounts[1].sessions,
    'the fixture must give the heavy account fewer sessions');
  assert.ok(snapshot.accounts[0].load > snapshot.accounts[1].load,
    'and more measured load');

  assert.equal(am.getActiveAccount(null, OPUS, null, 'new').name, 'light',
    'selection ignored the weight: it went to the account with fewer sessions');
});

// ---------------------------------------------------------------------------
// PROPERTIES. The cold-start claim is the one worth generating: "inert until
// something is measured" is an equivalence to the previous rule, and an
// equivalence is checkable rather than merely stated.
// ---------------------------------------------------------------------------

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/** No expiry pressure at all, which is what the disabled path supplies. */
const OFF = { kind: 'absent', reason: 'expiry-routing-off' };

/** The pre-weight chain, verbatim: priority, then sessions, then in-flight, then reset. */
function referencePick(accounts) {
  let best = null;
  let bp = Infinity; let bs = Infinity; let bi = Infinity; let br = Infinity;
  for (const a of accounts) {
    if (a.priority < bp
      || (a.priority === bp && a.sessions < bs)
      || (a.priority === bp && a.sessions === bs && a.inFlight < bi)
      || (a.priority === bp && a.sessions === bs && a.inFlight === bi && a.reset < br)) {
      best = a; bp = a.priority; bs = a.sessions; bi = a.inFlight; br = a.reset;
    }
  }
  return best ? best.index : null;
}

test('with nothing measured and no pressure consulted, the chain is exactly the rule it replaced', () => {
  const rand = rng(20260821);
  let compared = 0;
  let discriminated = 0;
  for (let trial = 0; trial < 5000; trial += 1) {
    const n = 1 + Math.floor(rand() * 5);
    const accounts = [];
    for (let i = 0; i < n; i += 1) {
      accounts.push({
        index: i,
        priority: rand() < 0.25 ? 100 : 0,
        load: 0,                                   // the cold-start fleet
        sessions: Math.floor(rand() * 4),
        inFlight: Math.floor(rand() * 3),
        // Absent for every account, which is both the cold-start fleet and the
        // disabled path. Two inert terms rather than one, and the claim is the
        // same for both: an absent signal cannot discriminate, so the chain
        // reduces to what it was before either term existed.
        pressure: rand() < 0.5 ? OFF : { kind: 'absent', reason: 'no-utilization' },
        reset: rand() < 0.2 ? -Infinity : Math.floor(rand() * 1e6),
      });
    }
    const decision = decidePick({ accounts });
    assert.equal(decision.kind, 'picked');
    assert.equal(decision.index, referencePick(accounts), `trial ${trial}`);
    assert.notEqual(decision.by, 'load', `trial ${trial}: load decided on an unmeasured fleet`);
    assert.notEqual(decision.by, 'pressure',
      `trial ${trial}: pressure decided on a fleet where every account's is absent`);
    compared += 1;
    if (decision.by !== 'first') discriminated += 1;
  }
  assert.equal(compared, 5000);
  assert.ok(discriminated > 2000,
    `only ${discriminated} fleets had any term discriminate, so agreement proves little`);
});

test('the winner is lexicographically minimal over every term', () => {
  const rand = rng(987654321);
  let loadDecided = 0;
  let pressureCompared = 0;
  for (let trial = 0; trial < 5000; trial += 1) {
    const n = 1 + Math.floor(rand() * 5);
    const accounts = [];
    for (let i = 0; i < n; i += 1) {
      accounts.push({
        index: i,
        priority: rand() < 0.25 ? 100 : 0,
        // Coarse on purpose. Drawn from a wide continuous range, `load` alone
        // decides almost every fleet and the terms behind it are never reached:
        // this generator produced 5000 winners and let pressure decide 10 of
        // them, which is a minimality claim about a term the run barely
        // evaluated.
        load: rand() < 0.6 ? 0 : Math.floor(rand() * 2) * 1000,
        sessions: rand() < 0.6 ? 0 : 1,
        inFlight: rand() < 0.8 ? 0 : 1,
        pressure: rand() < 0.2 ? OFF : { kind: 'known', value: Math.floor(rand() * 4) * 1e-6 },
        reset: Math.floor(rand() * 1e6),
      });
    }
    const decision = decidePick({ accounts });
    const key = a => [a.priority, a.load, a.sessions, a.inFlight, pressureRank(a.pressure), a.reset];
    const PRESSURE_SLOT = 4;
    const winner = accounts.find(a => a.index === decision.index);
    for (const other of accounts) {
      const w = key(winner);
      const o = key(other);
      const at = w.findIndex((v, i) => v !== o[i]);
      assert.ok(at === -1 || w[at] < o[at],
        `trial ${trial}: account ${other.index} beats the winner at term ${at}`);
      // Count the comparisons that actually reached the pressure slot. `by` is
      // the wrong statistic for this: it names the first term that
      // discriminates against the FIELD, so a fleet with any priority spread
      // reports `priority` however deep the winner was really decided, and the
      // slot below can go unchecked while the count looks healthy.
      if (at === PRESSURE_SLOT) pressureCompared += 1;
    }
    if (decision.by === 'load') loadDecided += 1;
  }
  assert.ok(loadDecided > 500, `load decided only ${loadDecided} times, so the term is barely exercised`);
  assert.ok(pressureCompared > 500,
    `only ${pressureCompared} comparisons reached the pressure slot, so its position in the key is untested`);
});

// The briefed invariant, stated as it was briefed: within any band, the pick
// must never prefer a strictly-lower-pressure member on account of an earlier
// reset timestamp. An exact pressure tie may keep the existing reset tiebreak.
//
// Scoped to the accounts that TIE the winner on every term above pressure,
// because those are the only ones the reset tiebreak could have decided
// against. A lower-pressure account that wins on load wins for a reason this
// invariant says nothing about.
test('the pick never prefers a strictly lower pressure member on an earlier reset', () => {
  const rand = rng(20260821);
  let contested = 0;
  for (let trial = 0; trial < 5000; trial += 1) {
    const n = 2 + Math.floor(rand() * 4);
    const accounts = [];
    for (let i = 0; i < n; i += 1) {
      accounts.push({
        index: i,
        priority: 0,
        // Ties are common on purpose: this invariant only has teeth where the
        // terms above pressure fail to discriminate.
        load: rand() < 0.6 ? 0 : Math.floor(rand() * 3) * 1000,
        sessions: rand() < 0.6 ? 0 : Math.floor(rand() * 3),
        inFlight: 0,
        pressure: rand() < 0.15 ? OFF : { kind: 'known', value: rand() * 1e-5 },
        reset: Math.floor(rand() * 1e6),
      });
    }
    const decision = decidePick({ accounts });
    const winner = accounts.find(a => a.index === decision.index);
    const above = a => [a.priority, a.load, a.sessions, a.inFlight].join('|');
    for (const other of accounts) {
      if (other.index === winner.index || above(other) !== above(winner)) continue;
      contested += 1;
      const wp = winner.pressure;
      const op = other.pressure;
      if (wp.kind === 'known' && op.kind === 'known') {
        assert.ok(wp.value >= op.value,
          `trial ${trial}: won with pressure ${wp.value} over ${op.value}, on the reset alone`);
      }
    }
  }
  assert.ok(contested > 2000,
    `only ${contested} pairs tied above pressure, so the invariant was barely tested`);
});

// ---------------------------------------------------------------------------
// THE MEASURED CELL, through the real manager rather than the pure function.
//
// Two accounts, same priority, both with a five-hour level such that neither
// covers a coverage target of 1 alone — which is what makes capacity sizing
// widen the band to both. Once it does, the reset tiebreak picks the account
// that is nearly drained but resets sooner, over one holding 3.2x the expiring
// quota. The tolerance ratio used to hide this by banding the low-pressure
// member out before the pick ever saw it, so sizing the band is what exposed
// the tiebreak rather than what broke it.
//
// Note for anyone reading the evidence: the flag-off differential is silent
// about this cell by construction. It is a claim about the DISABLED path, and
// this changes selection with expiry routing ON.
// ---------------------------------------------------------------------------

const HOUR = 3600e3;

function contestedFleet(extra = {}) {
  const now = Date.now();
  const specs = [
    { name: 'drained-resets-soon', quota: { unified7d: 0.97, unified7dReset: now + 1 * HOUR, unified5h: 0.5 } },
    { name: 'fresh-resets-later', quota: { unified7d: 0.05, unified7dReset: now + 10 * HOUR, unified5h: 0.5 } },
  ];
  const am = new AccountManager(specs.map(s => ({ ...acct(s.name) })), 0.98,
    { expiryRouting: { enabled: true, tolerance: 1.5 }, ...extra });
  specs.forEach((s, i) => { am.accounts[i].quota = { ...am.accounts[i].quota, ...s.quota }; });
  return am;
}

test('inside a capacity-widened band the pick takes the expiring quota, not the earlier reset', () => {
  const am = contestedFleet();
  const now = Date.now();

  // Premises. Each one is a way this fixture could fail to reach the defect
  // while still passing: a band that never widened, a pressure ordering that
  // agreed with the reset ordering anyway, or a target one account covered.
  const snapshot = am._bandSnapshot(am.accounts, OPUS, now);
  const [pA, pB] = am._pickPressures(am.accounts, OPUS, now);
  assert.equal(pA.kind, 'known');
  assert.equal(pB.kind, 'known');
  assert.ok(pB.value > pA.value, 'the fresher account does not hold more expiring quota');
  assert.ok(snapshot.accounts[0].resetAt < snapshot.accounts[1].resetAt,
    'the two orderings agree, so this fixture cannot tell them apart');
  const band = am._bandedCandidates(null, OPUS);
  assert.deepEqual(band.map(a => a.name), ['drained-resets-soon', 'fresh-resets-later'],
    'the band did not widen to both, so no low-pressure member is admitted to prefer');

  assert.equal(am._pickBestAvailable(null, OPUS).name, 'fresh-resets-later',
    'expiry on, distribute off: took the earlier reset over 3.2x the expiring quota');
});

test('the same inversion through the distributing path, once the load terms tie', () => {
  const am = contestedFleet({ distributeSessions: true });
  // No sessions recorded, so load, sessions and in-flight are all equal and the
  // decision falls through to the terms this is about.
  const decision = pick(am);
  assert.equal(decision.by, 'pressure',
    'something above pressure discriminated, so the tiebreak was never reached');
  assert.equal(am.accounts[decision.index].name, 'fresh-resets-later');
});

// Driven through `decidePick` rather than the manager, and that is forced
// rather than convenient. Pressure is headroom over time REMAINING, so two
// accounts whose pressures are equal at one instant stop being equal at the
// next unless their reset and utilization are both identical — in which case
// the reset term has nothing to discriminate on either, and the fixture cannot
// state the claim. A manager-driven version of this test passes by having the
// later-resetting account win on pressure, which is the opposite of what it
// says it is checking.
test('an exact pressure tie still falls through to the soonest reset', () => {
  const tied = value => [
    { index: 0, priority: 0, load: 0, observed: 0, sessions: 0, inFlight: 0,
      pressure: { kind: 'known', value }, reset: 10_000 },
    { index: 1, priority: 0, load: 0, observed: 0, sessions: 0, inFlight: 0,
      pressure: { kind: 'known', value }, reset: 5_000 },
  ];
  const decision = decidePick({ accounts: tied(1.3889e-5) });
  assert.equal(decision.index, 1, 'an exact pressure tie must keep the existing reset tiebreak');
  assert.equal(decision.by, 'reset', 'pressure discriminated on a fleet where it is equal');

  // And absence ties the same way, which is what makes the disabled path fall
  // through to exactly the rule that preceded this term.
  const off = tied(0).map(a => ({ ...a, pressure: OFF }));
  assert.equal(decidePick({ accounts: off }).index, 1);
});

test('with expiry routing off, no account has a pressure to rank on', () => {
  const am = contestedFleet({ expiryRouting: { enabled: false } });
  const pressures = am._pickPressures(am.accounts, OPUS, Date.now());
  for (const p of pressures) {
    assert.deepEqual(p, { kind: 'absent', reason: 'expiry-routing-off' },
      'the disabled path is consulting a pressure it was told not to');
  }
  // Inert rather than special-cased: every account ranks equal, so the reset
  // tiebreak decides exactly as it did before the term existed.
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'drained-resets-soon');
});
