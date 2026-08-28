// The band decision, as a pure function of a snapshot.
//
// Which accounts are worth spending is a decision; narrowing the candidate list
// is an action. Splitting them means the decision can be driven directly with
// constructed inputs, including inputs a live fleet cannot easily be put into
// (every window unreported, a reset already passed, one account at a different
// priority), and it means the instant is an argument rather than something read
// from the clock partway through.
//
// `decideBand` reads no clock, no account object and no configuration: `now`
// arrives in the snapshot. Two calls with the same snapshot return the same
// decision forever, which is what makes the property tests meaningful rather
// than a re-run of the implementation.
//
// ABSENCE IS A VARIANT, NEVER A COERCED null. An account whose window is
// unreported is not an account with zero pressure and not an account with
// infinite pressure; it is an account nothing is known about, and the band
// keeps it in so that using it is how its quota gets discovered. Writing that
// as `null` puts the burden on every consumer to remember which of the three it
// meant, and the one that forgets is the one that ranks an unknown account
// first. `reason` is part of the contract for the same purpose: a caller that
// wants to log, publish or branch on why a band did nothing reads a value, not
// a sentence.

/**
 * Why an account has no comparable pressure. Each names a distinct upstream
 * state rather than a failure: the first two are a window nobody has reported
 * yet, the third is a value that arrived malformed.
 *
 * @typedef {'no-utilization' | 'no-reset' | 'utilization-not-finite'} AbsentReason
 */

/**
 * @typedef {{ kind: 'known', value: number }
 *         | { kind: 'absent', reason: AbsentReason }} Pressure
 */

/**
 * One account as the decision sees it. Deliberately not an account object: the
 * decision layer cannot reach anything it was not handed.
 *
 * `utilization` is the governing weekly bucket's fraction spent and `resetAt`
 * is that same bucket's reset instant in epoch milliseconds. Both come from the
 * ONE bucket the caller resolved, never one bucket's usage against another's
 * clock.
 *
 * There is deliberately NO per-family five-hour field here. Upstream publishes
 * one `unified-5h` per account on the header path and one `fiveHour` on the
 * probe path, against three weekly families, so a per-family five-hour figure
 * does not exist to be read. Modelling it as `absent` would be worse than
 * omitting it: absent reads as "not known yet", which invites a consumer to
 * wait for a value that is never coming.
 *
 * `fiveHour` is that account's five-hour utilization, and it is the ONLY field
 * here with no family: see the paragraph above. It is the rate signal. A weekly
 * bucket says how much quota is left before the week ends; the five-hour bucket
 * says how fast it can be spent right now, and it is the one that gates.
 *
 * @typedef {{
 *   index: number,
 *   priority: number,
 *   utilization: number | null,
 *   resetAt: number | null,
 *   fiveHour: number | null,
 * }} BandAccount
 */

/**
 * `switchThreshold` is the utilization at which an account stops being
 * available at all. Headroom is measured against it rather than against 1.0
 * because the quota above it cannot be spent: an account at the threshold has
 * no usable capacity left, whatever the raw figure says. It is the operator's
 * existing knob, not a number chosen to fit any measurement.
 *
 * `coverage` is how much absorptive capacity the admitted set must add up to,
 * counted in whole accounts. One means "as much capacity as a single untouched
 * account", which is the smallest target that can describe the fleet at all.
 *
 * @typedef {{
 *   now: number,
 *   enabled: boolean,
 *   tolerance: number,
 *   switchThreshold: number,
 *   coverage: number,
 *   accounts: BandAccount[],
 * }} BandSnapshot
 */

/**
 * Why an account's five-hour capacity cannot be measured. `no-five-hour` is the
 * account's own signal missing, which is the cold-start state and fixes itself
 * the first time a window is reported. `no-headroom-scale` is the FLEET's:
 * a `switchThreshold` that is not a positive finite number leaves no spendable
 * range to measure against, and no amount of reporting will fix it. They are
 * separate because one is the ordinary default and the other is a
 * misconfiguration, and a reader who cannot tell them apart cannot tell whether
 * to wait or to go and change something.
 *
 * @typedef {'no-five-hour' | 'no-headroom-scale'} HeadroomAbsentReason
 */

/**
 * How much of an account's five-hour capacity is still spendable, as a
 * fraction of the spendable range.
 *
 * @typedef {{ kind: 'known', value: number }
 *         | { kind: 'absent', reason: HeadroomAbsentReason }} Headroom
 */

/**
 * Why the band kept everything it was given. `disabled` and `single-candidate`
 * are structural; `no-known-pressure` is the cold-start state, and it is the
 * reason the mechanism is off until a signal exists rather than guessing from a
 * default.
 *
 * @typedef {'disabled' | 'single-candidate' | 'no-known-pressure'} PassthroughReason
 */

/**
 * Why sizing fell back to the tolerance ratio. `no-capacity-signal` is the
 * cold-start and probe-off state and is the one upstream sees by default, so
 * the fallback is the ordinary path rather than an error path. The other two
 * are degenerate configuration, and each names which knob: a threshold with no
 * spendable range, and a coverage target no admitted set can reach. Three
 * reasons rather than one because `reason` is the single field whose whole job
 * is to say which state produced the decision, and folding distinct states into
 * one string is the absence-as-a-coerced-value error committed in the one place
 * built to prevent it.
 *
 * @typedef {'no-capacity-signal' | 'no-headroom-scale' | 'no-coverage-target'} FallbackReason
 */

/**
 * `sized` is the capacity rule: accounts admitted in descending pressure order
 * until the admitted set's five-hour headroom reaches the target. `banded` is
 * the tolerance ratio it falls back to. They are separate variants rather than
 * one variant with a flag because a consumer that wants to know which rule ran,
 * and every log that reports a band, should not have to infer it.
 *
 * @typedef {{ kind: 'passthrough', reason: PassthroughReason }
 *         | { kind: 'banded', keep: number[], floor: number, reason: FallbackReason }
 *         | { kind: 'sized', keep: number[], target: number, achieved: number }} BandDecision
 */

/**
 * Why one step of the walk went the way it did.
 *
 * The exemption splits by AXIS rather than sharing one code, because the axes do
 * not behave the same way: an account with absent pressure still contributes its
 * measured headroom to the running total, and one with absent headroom
 * contributes nothing. A single `unmeasured` code would hand every consumer back
 * the job of inferring which happened from the numbers beside it, which is the
 * inference this module exists to make unnecessary.
 *
 * `within-tolerance` is the ratio rule's ordinary admission. It exists for
 * symmetry with `under-target`: a null there would be the one place in a
 * structure built to keep absence out of the value channel where "no code" had
 * to be read as "admitted normally".
 *
 * @typedef {'under-target' | 'coverage-met' | 'unmeasured-exempt-pressure'
 *         | 'unmeasured-exempt-headroom' | 'within-tolerance' | 'below-floor'
 *         | 'lower-tier'} LadderReason
 */

/**
 * One step of an admission walk: an account, what was known about it, and what
 * the walk did with it.
 *
 * This is the unit BOTH projections consume. The decision reads `admitted` and
 * `cumulative` to produce `keep` and `achieved`; the explanation reports the
 * steps as a ladder. One walk, so a ladder that claims an order the decision did
 * not perform is unconstructible rather than merely tested for.
 *
 * `rank` is null wherever the sort could not order the row: absent pressure
 * under `sized`, every row under `banded` (the floor is a test, not an order),
 * and every lower-tier row. A number there would assert an ordering that was
 * never computed.
 *
 * `cumulative` is the running coverage total AFTER this step, and is null only
 * where the step admitted nobody. A step admitting an account whose headroom is
 * absent carries the UNCHANGED total rather than null: nothing was added, but
 * the account was taken, and null in that slot reads as held back.
 *
 * @typedef {{
 *   account: BandAccount,
 *   rank: number | null,
 *   pressure: Pressure,
 *   headroom: Headroom,
 *   admitted: boolean,
 *   cumulative: number | null,
 *   reason: LadderReason,
 * }} AdmissionStep
 */

/**
 * A band decision together with the walk that produced it.
 *
 * `BandDecision` deliberately does not grow a ladder field: `decidingTerms` is
 * "pure, and separate from `decidePick` so that explaining a decision cannot
 * change it" (`pick-decision.js:172`, the `kind: 'none', reason: 'no-candidates'` return), and the same posture applies here. So the
 * explanation is a second projection of the same work rather than a wider
 * decision, and nothing on the routing path reads it.
 *
 * @typedef {{
 *   decision: BandDecision,
 *   ladder: AdmissionStep[],
 *   candidates: number,
 * }} BandExplanation
 */

/**
 * Exhaustiveness, enforced at runtime as well as by the type checker. The
 * checker catches a union that gained a variant; this catches a snapshot that
 * arrived from somewhere the checker does not cover, which on a JS codebase
 * being typed one file at a time is most places.
 *
 * @param {never} value
 * @param {string} context
 * @returns {never}
 */
export function assertNever(value, context) {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * The expiring-quota pressure of one account: headroom per second remaining in
 * its governing window. Higher means more quota that is closer to expiring, so
 * more worth spending now.
 *
 * @param {BandAccount} account
 * @param {number} now
 * @returns {Pressure}
 */
export function pressureOf(account, now) {
  if (account.utilization == null) return { kind: 'absent', reason: 'no-utilization' };
  if (!account.resetAt) return { kind: 'absent', reason: 'no-reset' };
  // Rejected before the clamp below, not after. Clamping a non-finite
  // utilization would turn it into 0, which reads as a completely unspent
  // window: the strongest score there is, invented out of a malformed value.
  if (!Number.isFinite(account.utilization)) {
    return { kind: 'absent', reason: 'utilization-not-finite' };
  }
  const seconds = (account.resetAt - now) / 1000;
  // A window whose reset has passed has no remaining time to spread headroom
  // over. That is a known pressure of zero rather than an absence: the account
  // is known to be worth nothing to spend for expiry reasons, which is a
  // different claim from knowing nothing about it.
  if (seconds <= 0) return { kind: 'known', value: 0 };
  const u = Math.min(1, Math.max(0, account.utilization));
  const value = (1 - u) / seconds;
  return Number.isFinite(value)
    ? { kind: 'known', value }
    : { kind: 'absent', reason: 'utilization-not-finite' };
}

/**
 * @param {BandAccount} account
 * @param {number} switchThreshold
 * @returns {Headroom}
 */
export function headroomOf(account, switchThreshold) {
  // The scale is checked before the account, because it is a property of the
  // fleet: when it is degenerate EVERY account is unmeasurable, and reporting
  // that as the account's own missing signal sends the reader looking at the
  // wrong thing.
  if (!Number.isFinite(switchThreshold) || switchThreshold <= 0) {
    return { kind: 'absent', reason: 'no-headroom-scale' };
  }
  if (account.fiveHour == null || !Number.isFinite(account.fiveHour)) {
    return { kind: 'absent', reason: 'no-five-hour' };
  }
  const spendable = (switchThreshold - account.fiveHour) / switchThreshold;
  return { kind: 'known', value: Math.min(1, Math.max(0, spendable)) };
}

/**
 * Band sizing as a capacity question rather than a ratio question.
 *
 * The ratio asks "how much worse in pressure may an account be and still be
 * used". The question that decides whether the fleet gates is "how many
 * accounts must run in parallel to cover demand", and those are different
 * enough that a single scalar cannot express the second. At an 18x to 28x
 * pressure gap the ratio collapses the band to one account and the fleet runs
 * one account at a time while the rest idle.
 *
 * Demand is not forecast here, and no history is kept. The five-hour level IS
 * the integral of demand: an account absorbing more than its share climbs
 * toward its own gate, and its remaining headroom falls. So admitting accounts
 * in descending pressure order until their combined headroom reaches the target
 * spends the most-expiring quota first while keeping enough parallel capacity
 * to absorb what is actually arriving. Fresh fleet, one account covers it and
 * the band stays narrow; loaded fleet, the same rule widens on its own.
 *
 * The error is deliberately asymmetric. Under-sizing gates the fleet and forces
 * a migration that destroys cache; over-sizing spends quota that was not going
 * to expire, which costs nothing while the fleet is demand-limited. So an
 * account whose headroom is unknown is admitted and contributes NOTHING to
 * coverage: capacity that has not been measured cannot be a reason to stop
 * admitting.
 *
 * @typedef {{ kind: 'sized', steps: AdmissionStep[] }
 *         | { kind: 'fallback', reason: FallbackReason }} SizingOutcome
 */

/**
 * @param {BandAccount[]} tier
 * @param {Pressure[]} pressures
 * @param {BandSnapshot} snapshot
 * @returns {SizingOutcome}
 */
function sizeByCapacity(tier, pressures, snapshot) {
  // A target that is not a positive finite number cannot be reached by
  // admitting accounts, and the loop below reads "already covered" for any
  // value at or below zero — which admits nobody and empties the tier. The
  // config validator clamps this, but `decideBand` is exported and takes a
  // plain number, so the precondition has to hold here rather than upstream of
  // here. Measured before the guard: coverage 0 returned an empty band, and a
  // non-finite one published `target: null` on the wire.
  if (!Number.isFinite(snapshot.coverage) || snapshot.coverage <= 0) {
    return { kind: 'fallback', reason: 'no-coverage-target' };
  }

  const headrooms = tier.map(a => headroomOf(a, snapshot.switchThreshold));
  // Cold start, and the probe-off default: nothing has reported a five-hour
  // level, so there is no capacity to size against and this rule does not run
  // at all. Off until the signal exists, rather than sized against a guess.
  if (!headrooms.some(h => h.kind === 'known')) {
    const scale = headrooms.some(h => h.kind === 'absent' && h.reason === 'no-headroom-scale');
    return { kind: 'fallback', reason: scale ? 'no-headroom-scale' : 'no-capacity-signal' };
  }

  // Descending pressure, so the most-expiring quota is spent first. Accounts
  // with no comparable pressure sort last but are still admitted, because the
  // way their quota becomes known is by being used.
  const order = tier.map((account, i) => ({ account, pressure: pressures[i], headroom: headrooms[i] }));
  order.sort((a, b) => {
    const av = a.pressure.kind === 'known' ? a.pressure.value : -Infinity;
    const bv = b.pressure.kind === 'known' ? b.pressure.value : -Infinity;
    return bv - av;
  });

  // The walk is recorded step by step rather than reduced on the way past.
  // `keep` and `achieved` are recovered from the steps below, and the ladder the
  // status interface publishes is the same array: one sequence with two readers,
  // so an explanation that disagrees with the routing it explains cannot be
  // written. The alternative — a second sort in the explainer — is a parallel
  // implementation of the decision, and the drift would surface as a ladder
  // describing an admission that never happened.
  /** @type {AdmissionStep[]} */
  const steps = [];
  let rank = 0;
  let achieved = 0;
  for (const entry of order) {
    // Ranked only where the sort had something to order by. An account with no
    // comparable pressure sits at the end of `order` because it sorted as
    // -Infinity, not because it came fourth on the measurement.
    const ranked = entry.pressure.kind === 'known' ? (rank += 1) : null;
    // ABSENCE ON EITHER AXIS, not just headroom. This rule ranks on two
    // measurements — pressure decides the order, headroom decides when to stop
    // — and an account missing EITHER is exempt from the coverage stop. Absence
    // may widen the band and must never close it, because being used is how the
    // missing measurement is obtained, and an account dropped for lacking one
    // can never supply it. Restricting the exemption to headroom left the other
    // half live: absent pressure sorts last, so it met a target a peer had
    // already met and was dropped, which is the same defect one noun over.
    const unmeasured = entry.headroom.kind === 'absent' || entry.pressure.kind === 'absent';
    if (!unmeasured && achieved >= snapshot.coverage) {
      steps.push({
        account: entry.account, rank: ranked, pressure: entry.pressure, headroom: entry.headroom,
        admitted: false, cumulative: null, reason: 'coverage-met',
      });
      continue;
    }
    switch (entry.headroom.kind) {
      // Counted whenever it is known, including for an account admitted by the
      // exemption above. The reason absent headroom adds nothing is that
      // unmeasured capacity is not capacity; that reason does not reach an
      // account whose capacity IS measured and whose pressure merely is not.
      // `achieved` reaches the wire as what the admitted set can absorb, and
      // omitting measured capacity would understate it.
      case 'known': achieved += entry.headroom.value; break;
      case 'absent': break;
      default: assertNever(entry.headroom, 'sizeByCapacity');
    }
    // Pressure is checked first because both axes can be absent at once and the
    // codes are not symmetric: such a row was admitted by the exemption AND
    // contributed nothing, and `unmeasured-exempt-pressure` is the half that
    // explains why it is here at all, which is what a reader seeing it last in
    // the ladder with no `+x` beside it is asking.
    const reason = entry.pressure.kind === 'absent' ? 'unmeasured-exempt-pressure'
      : entry.headroom.kind === 'absent' ? 'unmeasured-exempt-headroom'
        : 'under-target';
    steps.push({
      account: entry.account, rank: ranked, pressure: entry.pressure, headroom: entry.headroom,
      admitted: true, cumulative: achieved, reason,
    });
  }
  return { kind: 'sized', steps };
}

/**
 * The accounts a walk admitted, in the TIER's own order rather than the pressure
 * order that chose them: callers break ties by taking the first acceptable
 * candidate, so re-ranking here would move that decision into this function
 * silently.
 *
 * @param {BandAccount[]} tier
 * @param {AdmissionStep[]} steps
 * @returns {number[]}
 */
function keptFrom(tier, steps) {
  const admitted = new Set(steps.filter(s => s.admitted).map(s => s.account.index));
  return tier.filter(a => admitted.has(a.index)).map(a => a.index);
}

/**
 * What the admitted set can absorb: the last running total the walk published.
 * Read back from the steps rather than accumulated a second time, so the figure
 * on the wire and the figure in the ladder's final row are the same number by
 * construction and cannot disagree in the last decimal.
 *
 * @param {AdmissionStep[]} steps
 * @returns {number}
 */
function achievedFrom(steps) {
  let achieved = 0;
  for (const step of steps) if (step.cumulative != null) achieved = step.cumulative;
  return achieved;
}

/**
 * The accounts worth spending, as a decision. Pure.
 *
 * Only the best priority tier is banded. Priority is the operator's explicit
 * order and has to keep winning: a high-pressure low-priority fallback must not
 * band out the tier the operator preferred. Lower tiers pass through unfiltered,
 * since they are only reached when the top tier is empty, which banding cannot
 * cause because the maximum always qualifies.
 *
 * @param {BandSnapshot} snapshot
 * @returns {BandDecision}
 */
export function decideBand(snapshot) {
  return bandWork(snapshot).decision;
}

/**
 * The band's whole computation: the decision, and the steps that produced it.
 *
 * Both exported entry points are projections of this. `decideBand` takes the
 * decision and drops the steps; `explainBand` keeps both. That is what makes an
 * explanation that contradicts the routing unconstructible: there is one walk,
 * and neither caller can produce the other's answer from a different one.
 *
 * @param {BandSnapshot} snapshot
 * @returns {{ decision: BandDecision, steps: AdmissionStep[], top: number|null }}
 */
function bandWork(snapshot) {
  const { accounts, now, tolerance, enabled } = snapshot;
  if (!enabled) return { decision: { kind: 'passthrough', reason: 'disabled' }, steps: [], top: null };
  if (accounts.length <= 1) {
    return { decision: { kind: 'passthrough', reason: 'single-candidate' }, steps: [], top: null };
  }

  const top = Math.min(...accounts.map(a => a.priority));
  const tier = accounts.filter(a => a.priority === top);
  const pressures = tier.map(a => pressureOf(a, now));
  const known = pressures.filter(p => p.kind === 'known').map(p => p.value);
  // Nothing to rank on. Every account in the tier is unknown, so there is no
  // maximum to measure a floor against and no basis for preferring any of them.
  if (!known.length) {
    return { decision: { kind: 'passthrough', reason: 'no-known-pressure' }, steps: [], top: null };
  }

  // Surviving members of the top tier first, then every lower tier untouched.
  // The order is part of the contract, not an accident of the loop: callers
  // break ties by taking the first acceptable candidate, so emitting these in
  // the snapshot's order instead would silently re-rank a mixed-priority fleet.
  /** @param {number[]} keep @returns {number[]} */
  const withLowerTiers = keep => {
    const out = keep.slice();
    for (const account of accounts) {
      if (account.priority !== top) out.push(account.index);
    }
    return out;
  };

  // Capacity first; the ratio is what it degrades to when nothing has reported
  // a five-hour level.
  const sizing = sizeByCapacity(tier, pressures, snapshot);
  switch (sizing.kind) {
    case 'sized': {
      /** @type {BandDecision} */
      const decision = {
        kind: 'sized',
        keep: withLowerTiers(keptFrom(tier, sizing.steps)),
        target: snapshot.coverage,
        achieved: achievedFrom(sizing.steps),
      };
      return { decision, steps: sizing.steps, top };
    }
    case 'fallback': {
      const maxKnown = Math.max(...known);
      // A tolerance that is not a positive finite number cannot define a floor,
      // and one BELOW 1 asks for accounts strictly better than the best there
      // is. Both empty the tier, which contradicts the invariant this function
      // documents two paragraphs up. Clamping the floor at the maximum makes
      // "the maximum always qualifies" true by construction rather than by
      // trusting the knob: at any tolerance >= 1 the clamp is inert and the
      // ratio is unchanged. Measured before the guard: tolerance 0.5 on a
      // two-account fleet kept nothing at all.
      const ratio = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1;
      const floor = Math.min(maxKnown, maxKnown / ratio);
      const steps = floorSteps(tier, pressures, snapshot, floor);
      /** @type {BandDecision} */
      const decision = {
        kind: 'banded', keep: withLowerTiers(keptFrom(tier, steps)), floor, reason: sizing.reason,
      };
      return { decision, steps, top };
    }
    default: return assertNever(sizing, 'bandWork');
  }
}

/**
 * The ratio rule's walk. No order and no running total: the floor is a test
 * applied to each account independently, so a rank would assert a comparison
 * that never happened and a cumulative would assert a coverage claim this rule
 * does not make.
 *
 * @param {BandAccount[]} tier
 * @param {Pressure[]} pressures
 * @param {BandSnapshot} snapshot
 * @param {number} floor
 * @returns {AdmissionStep[]}
 */
function floorSteps(tier, pressures, snapshot, floor) {
  return tier.map((account, i) => {
    const pressure = pressures[i];
    // Carried for the ladder's column even though this rule never consults it:
    // it is the reading the fleet HAS, and under `no-capacity-signal` its
    // absence is the very reason this rule is running.
    const headroom = headroomOf(account, snapshot.switchThreshold);
    switch (pressure.kind) {
      // An unknown account stays in: using it is how its quota is discovered,
      // and banding it out would make the unknown permanent.
      case 'absent':
        return {
          account, rank: null, pressure, headroom,
          admitted: true, cumulative: null, reason: 'unmeasured-exempt-pressure',
        };
      case 'known': {
        const admitted = pressure.value >= floor;
        return {
          account, rank: null, pressure, headroom, admitted, cumulative: null,
          reason: admitted ? 'within-tolerance' : 'below-floor',
        };
      }
      default: return assertNever(pressure, 'floorSteps');
    }
  });
}

/**
 * The same decision, with the sequence that produced it.
 *
 * Separate from `decideBand` rather than folded into it because explaining a
 * decision must not be able to change it — the posture `decidingTerms` sets for
 * the pick (`pick-decision.js:172`) — so `BandDecision` is untouched and nothing
 * on the routing path reads a ladder. What the two share is the walk itself, not
 * a convention about how to redo it.
 *
 * Lower-tier accounts are appended after the ranked rows, carrying `lower-tier`
 * and no rank: `decideBand` keeps them wholesale without ever comparing them, so
 * ranking them here would publish an ordering the band never computed. Under
 * `passthrough` the ladder is empty for the same reason, and emptiness is the
 * honest report — no walk ran, so there is no sequence to describe.
 *
 * @param {BandSnapshot} snapshot
 * @returns {BandExplanation}
 */
export function explainBand(snapshot) {
  const { decision, steps, top } = bandWork(snapshot);
  const candidates = snapshot.accounts.length;
  if (decision.kind === 'passthrough') return { decision, ladder: [], candidates };

  const ladder = steps.slice();
  for (const account of snapshot.accounts) {
    if (account.priority === top) continue;
    ladder.push({
      account,
      rank: null,
      pressure: pressureOf(account, snapshot.now),
      headroom: headroomOf(account, snapshot.switchThreshold),
      admitted: true,
      cumulative: null,
      reason: 'lower-tier',
    });
  }
  return { decision, ladder, candidates };
}
