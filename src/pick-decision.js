// Which account a new session lands on, as a pure function of a snapshot.
//
// Same shape as the band decision and for the same reasons: a decision that
// reads nothing but its argument can be driven into states a live fleet cannot
// easily be put into, and two calls with the same snapshot answer the same way
// forever.
//
// WHY THE WEIGHT EXISTS. Selection ranked accounts by how many active sessions
// each held, which treats sessions as interchangeable. Measured on a live
// fleet, two accounts holding 2 and 4 sessions drew 0.0300 and 0.0125 of their
// five-hour window per session: the account with half the sessions carried more
// load, and the only exposed metric would have reported "5 and 4, nicely
// balanced" while being wrong by 2.4x. Per-session spread is wider still, at
// roughly 41x between the median session and the 99th percentile.
//
// TOKEN-ONLY, DELIBERATELY. Nothing here reads quota. Upstream's default is
// probe-off, so a weight that consulted quota would have an absent arm on day
// one for every upstream user, and "independent of probe state" would stop
// being one proof and become an axis crossed with every load shape.
//
// COLD START IS STRUCTURAL, NOT A MODE. Load is inserted ahead of the session
// count rather than replacing it. A fleet that has observed nothing scores every
// account zero, the term cannot discriminate, and the remaining tiebreaks decide
// exactly as they did before this existed. There is no flag to get wrong and no
// bootstrap constant to hide a fitted number in: the mechanism is off until the
// signal exists because an absent signal makes it inert.
import { assertNever } from './band-decision.js';

/**
 * One candidate as the pick sees it. `load` is the measured footprint the
 * account is currently carrying; `sessions` is the cardinality it replaces as
 * the leading term and survives behind it, so an account that is busy but
 * UNMEASURED still ranks behind an account that is genuinely idle.
 *
 * `observed` is how many usage reports back `load`. It is NOT ranked on, and
 * that is a decision rather than an oversight: an account whose load is
 * unmeasured should attract work, because being used is how its load becomes
 * known, and the session count behind `load` already stops it from attracting
 * everything. It is here because `load: 0` is otherwise ambiguous in the one
 * direction that hides a silent revert. Zero is enormously plausible, so if the
 * token read were lost every account would score zero, selection would fall
 * back to counting sessions, the fallback would be correct behaviour, and the
 * fleet would be indistinguishable from one that had never recorded a token.
 * Carrying the count makes "the signal arrived" a property a test can hold.
 *
 * @typedef {{
 *   index: number,
 *   priority: number,
 *   load: number,
 *   observed: number,
 *   sessions: number,
 *   inFlight: number,
 *   pressure: PickPressure,
 *   reset: number,
 * }} PickAccount
 */

/**
 * Why an account has no expiry pressure to rank on. The first three are the
 * band's own `AbsentReason` — a window nobody has reported. The fourth is the
 * operator having switched expiry routing off, which is not a missing
 * measurement but a decision not to consult one, and folding it into the others
 * would say the fleet is waiting for a signal that is never being asked for.
 * Both make the term inert; only the reason tells them apart.
 *
 * @typedef {import('./band-decision.js').AbsentReason | 'expiry-routing-off'} PickPressureAbsentReason
 */

/**
 * @typedef {{ kind: 'known', value: number }
 *         | { kind: 'absent', reason: PickPressureAbsentReason }} PickPressure
 */

/**
 * @typedef {{ accounts: PickAccount[] }} PickSnapshot
 */

/**
 * `by` names the first term that discriminated, which is what makes the
 * cold-start claim checkable from outside: on an unmeasured fleet it can never
 * be `load`, and a test can say so rather than trusting the comment above.
 *
 * @typedef {'priority' | 'load' | 'sessions' | 'in-flight' | 'pressure' | 'reset' | 'first'} PickTerm
 */

/**
 * @typedef {{ kind: 'picked', index: number, by: PickTerm }
 *         | { kind: 'none', reason: 'no-candidates' }} PickDecision
 */

/**
 * Descending pressure as an ascending rank, so every term in the list still
 * reads "lower wins".
 *
 * Absence ranks FIRST, which is the bias this codebase already applies to an
 * unreported window on the `reset` term below: an account nothing is known
 * about gets used, because being used is how it becomes known. That is not a
 * claim it has high pressure. When EVERY account is absent — expiry routing
 * off, or a fleet nobody has measured — they all rank equal, the term cannot
 * discriminate, and the terms below decide exactly as they did before this one
 * existed. That is what keeps the disabled path byte-identical rather than
 * merely similar.
 *
 * @param {PickPressure} pressure
 * @returns {number}
 */
export function pressureRank(pressure) {
  switch (pressure.kind) {
    case 'known': return -pressure.value;
    case 'absent': return -Infinity;
    default: return assertNever(pressure, 'pressureRank');
  }
}

/**
 * The ordered comparison. Lower wins on every term, which is why `reset` is a
 * timestamp rather than a duration: the soonest-resetting account is the one
 * whose quota is closest to expiring unspent.
 *
 * WHY PRESSURE SITS AHEAD OF RESET. An earlier reset is a proxy for expiring
 * quota and it is only a good one at equal headroom, where the two agree
 * exactly — soonest reset IS highest pressure. Where headroom differs they come
 * apart, and the proxy loses: a nearly-drained account resetting in an hour
 * beat one holding 20x the quota that expires in ten, purely on the timestamp.
 * The tolerance ratio used to hide this by banding such an account out, so
 * sizing the band for parallel capacity is what exposed it. Pressure therefore
 * generalises the reset tiebreak rather than reversing it, and `reset` stays
 * behind it to settle exact pressure ties.
 *
 * @type {{ term: PickTerm, of: (a: PickAccount) => number }[]}
 */
const TERMS = [
  { term: 'priority', of: a => a.priority },
  // Ahead of `sessions`, which it does not replace. See the header.
  { term: 'load', of: a => a.load },
  { term: 'sessions', of: a => a.sessions },
  { term: 'in-flight', of: a => a.inFlight },
  { term: 'pressure', of: a => pressureRank(a.pressure) },
  { term: 'reset', of: a => a.reset },
];

/**
 * @param {PickSnapshot} snapshot
 * @returns {PickDecision}
 */
export function decidePick(snapshot) {
  const { accounts } = snapshot;
  if (!accounts.length) return { kind: 'none', reason: 'no-candidates' };

  let best = accounts[0];
  for (const account of accounts.slice(1)) {
    for (const { of } of TERMS) {
      const mine = of(account);
      const theirs = of(best);
      if (mine === theirs) continue;
      if (mine < theirs) best = account;
      break;
    }
  }
  // `by` is measured against the FIELD, not against whichever comparison
  // happened to promote the leader last. Deriving it from the swap looks
  // equivalent and is not: when the first candidate is already the winner
  // nothing ever swaps, so every such decision would report that no term
  // decided at all, which is the common case rather than an edge one.
  const [by = 'first'] = decidingTerms({ accounts }, { kind: 'picked', index: best.index, by: 'first' });
  return { kind: 'picked', index: best.index, by };
}

/**
 * Every term the winner beat the field on, for a caller that wants to report
 * why rather than merely who. Pure, and separate from `decidePick` so that
 * explaining a decision cannot change it.
 *
 * @param {PickSnapshot} snapshot
 * @param {PickDecision} decision
 * @returns {PickTerm[]}
 */
export function decidingTerms(snapshot, decision) {
  switch (decision.kind) {
    case 'none': return [];
    case 'picked': {
      const winner = snapshot.accounts.find(a => a.index === decision.index);
      if (!winner) return [];
      return TERMS
        .filter(({ of }) => snapshot.accounts.some(a => of(a) !== of(winner)))
        .map(({ term }) => term);
    }
    default: return assertNever(decision, 'decidingTerms');
  }
}

/**
 * The accounts equal to the winner on EVERY term, so that config order is what
 * separated them.
 *
 * `by` makes the winner provably MINIMAL on that term, not uniquely minimal,
 * and the gap is reachable rather than theoretical. `decidingTerms` keeps a term
 * when ANY account differs from the winner, so on a field where the winner and
 * the runner-up are both at `load: 0` and a third account is not, `by` reads
 * `load` while load did nothing to separate the two accounts that mattered.
 * `by: 'first'` cannot catch it either: `decidePick` only reaches that value
 * when the whole field is unanimous on all six terms, so a tie broken by array
 * position is invisible in a decision that reports a term.
 *
 * Non-empty here means position broke the tie, which is what a report should
 * say instead of crediting a term that did not decide. Empty means the winner
 * really is uniquely minimal.
 *
 * Pure, and separate from `decidePick` for the reason the header gives: nothing
 * here may change what was chosen.
 *
 * @param {PickSnapshot} snapshot
 * @param {PickDecision} decision
 * @returns {number[]}
 */
export function tiedWith(snapshot, decision) {
  switch (decision.kind) {
    case 'none': return [];
    case 'picked': {
      const winner = snapshot.accounts.find(a => a.index === decision.index);
      if (!winner) return [];
      return snapshot.accounts
        .filter(a => a.index !== winner.index && TERMS.every(({ of }) => of(a) === of(winner)))
        .map(a => a.index);
    }
    default: return assertNever(decision, 'tiedWith');
  }
}

/**
 * Who would have been chosen if the winner were not there.
 *
 * Derived by running `decidePick` again over the field minus the winner rather
 * than by tracking second place during the first pass. Second place is not
 * something that comparison loop computes — it keeps a single leader and never
 * ranks the rest — so any attempt to read it out of that loop would be a new
 * ordering rule written beside the real one. Running the same function on a
 * smaller field cannot disagree with it.
 *
 * Null when the winner was alone, which is a different fact from a tie and is
 * why it is not spelled as an index of anything.
 *
 * @param {PickSnapshot} snapshot
 * @param {PickDecision} decision
 * @returns {number | null}
 */
export function runnerUp(snapshot, decision) {
  if (decision.kind !== 'picked') return null;
  const rest = snapshot.accounts.filter(a => a.index !== decision.index);
  if (!rest.length) return null;
  const second = decidePick({ ...snapshot, accounts: rest });
  return second.kind === 'picked' ? second.index : null;
}
