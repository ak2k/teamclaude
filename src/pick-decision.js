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
 *   reset: number,
 * }} PickAccount
 */

/**
 * @typedef {{ accounts: PickAccount[] }} PickSnapshot
 */

/**
 * `by` names the first term that discriminated, which is what makes the
 * cold-start claim checkable from outside: on an unmeasured fleet it can never
 * be `load`, and a test can say so rather than trusting the comment above.
 *
 * @typedef {'priority' | 'load' | 'sessions' | 'in-flight' | 'reset' | 'first'} PickTerm
 */

/**
 * @typedef {{ kind: 'picked', index: number, by: PickTerm }
 *         | { kind: 'none', reason: 'no-candidates' }} PickDecision
 */

/**
 * The ordered comparison. Lower wins on every term, which is why `reset` is a
 * timestamp rather than a duration: the soonest-resetting account is the one
 * whose quota is closest to expiring unspent.
 *
 * @type {{ term: PickTerm, of: (a: PickAccount) => number }[]}
 */
const TERMS = [
  { term: 'priority', of: a => a.priority },
  // Ahead of `sessions`, which it does not replace. See the header.
  { term: 'load', of: a => a.load },
  { term: 'sessions', of: a => a.sessions },
  { term: 'in-flight', of: a => a.inFlight },
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
