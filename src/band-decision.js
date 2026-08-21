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
 * How much of an account's five-hour capacity is still spendable, as a
 * fraction of the spendable range. Absent when the account has never reported
 * one, which is the cold-start state: a fleet nobody has measured has no
 * capacity signal to size against.
 *
 * @typedef {{ kind: 'known', value: number }
 *         | { kind: 'absent', reason: 'no-five-hour' }} Headroom
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
 * the fallback is the ordinary path rather than an error path.
 *
 * @typedef {'no-capacity-signal'} FallbackReason
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
  if (account.fiveHour == null || !Number.isFinite(account.fiveHour)) {
    return { kind: 'absent', reason: 'no-five-hour' };
  }
  if (!(switchThreshold > 0)) return { kind: 'absent', reason: 'no-five-hour' };
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
 * @param {BandAccount[]} tier
 * @param {Pressure[]} pressures
 * @param {BandSnapshot} snapshot
 * @returns {{ keep: number[], achieved: number } | null}
 */
function sizeByCapacity(tier, pressures, snapshot) {
  const headrooms = tier.map(a => headroomOf(a, snapshot.switchThreshold));
  // Cold start, and the probe-off default: nothing has reported a five-hour
  // level, so there is no capacity to size against and this rule does not run
  // at all. Off until the signal exists, rather than sized against a guess.
  if (!headrooms.some(h => h.kind === 'known')) return null;

  // Descending pressure, so the most-expiring quota is spent first. Accounts
  // with no comparable pressure sort last but are still admitted, because the
  // way their quota becomes known is by being used.
  const order = tier.map((account, i) => ({ account, pressure: pressures[i], headroom: headrooms[i] }));
  order.sort((a, b) => {
    const av = a.pressure.kind === 'known' ? a.pressure.value : -Infinity;
    const bv = b.pressure.kind === 'known' ? b.pressure.value : -Infinity;
    return bv - av;
  });

  const keep = [];
  let achieved = 0;
  for (const entry of order) {
    if (achieved >= snapshot.coverage) break;
    keep.push(entry.account.index);
    switch (entry.headroom.kind) {
      case 'known': achieved += entry.headroom.value; break;
      // Admitted, but it cannot count toward a target it has not been measured
      // against. Counting it would let an unmeasured account close the band.
      case 'absent': break;
      default: assertNever(entry.headroom, 'sizeByCapacity');
    }
  }
  // Emitted in the tier's own order, not the pressure order used to choose
  // them: callers break ties by taking the first acceptable candidate, and
  // re-ranking here would move that decision into this function silently.
  const admitted = new Set(keep);
  return { keep: tier.filter(a => admitted.has(a.index)).map(a => a.index), achieved };
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
  const { accounts, now, tolerance, enabled } = snapshot;
  if (!enabled) return { kind: 'passthrough', reason: 'disabled' };
  if (accounts.length <= 1) return { kind: 'passthrough', reason: 'single-candidate' };

  const top = Math.min(...accounts.map(a => a.priority));
  const tier = accounts.filter(a => a.priority === top);
  const pressures = tier.map(a => pressureOf(a, now));
  const known = pressures.filter(p => p.kind === 'known').map(p => p.value);
  // Nothing to rank on. Every account in the tier is unknown, so there is no
  // maximum to measure a floor against and no basis for preferring any of them.
  if (!known.length) return { kind: 'passthrough', reason: 'no-known-pressure' };

  // Capacity first; the ratio is what it degrades to when nothing has reported
  // a five-hour level.
  const sized = sizeByCapacity(tier, pressures, snapshot);
  if (sized) {
    const keep = sized.keep.slice();
    for (const account of accounts) {
      if (account.priority !== top) keep.push(account.index);
    }
    return { kind: 'sized', keep, target: snapshot.coverage, achieved: sized.achieved };
  }

  const floor = Math.max(...known) / tolerance;
  // Surviving members of the top tier first, then every lower tier untouched.
  // The order is part of the contract, not an accident of the loop: callers
  // break ties by taking the first acceptable candidate, so emitting these in
  // the snapshot's order instead would silently re-rank a mixed-priority fleet.
  const keep = [];
  for (let i = 0; i < tier.length; i += 1) {
    const pressure = pressures[i];
    switch (pressure.kind) {
      // An unknown account stays in: using it is how its quota is discovered,
      // and banding it out would make the unknown permanent.
      case 'absent': keep.push(tier[i].index); break;
      case 'known': if (pressure.value >= floor) keep.push(tier[i].index); break;
      default: assertNever(pressure, 'decideBand');
    }
  }
  for (const account of accounts) {
    if (account.priority !== top) keep.push(account.index);
  }
  return { kind: 'banded', keep, floor, reason: 'no-capacity-signal' };
}
