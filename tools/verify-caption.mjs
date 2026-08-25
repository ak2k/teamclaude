// Caption gate: a printed sentence that describes the routing rule is a CLAIM,
// and this checks it against the rule rather than against a reading of the rule.
//
// Usage:
//   node tools/verify-caption.mjs --sample=<status.json> --model=<id> --now=<iso>
//                                 [--caption=<id>] [--list]
//
// The compact status block prints a `Rule` line under the band ladder, and that
// line makes two falsifiable claims: an ORDERING ("most unspent weekly quota per
// hour before it resets goes first") and a STOP ("until 1.0 accounts of 5h
// headroom are covered"). The sentence itself comes from `ruleCaption`, so the
// string graded here is the string that prints; grading a copy would leave the
// printed one ungoverned. A caption that no longer matches `decideBand` is worse
// than no caption: it describes an admission sequence that did not happen,
// beside the numbers that did, and nothing else in the suite would notice.
//
// ── why this recomputes the ordering on purpose ──────────────────────────────
//
// This project bans a test that recomputes the rule it is testing, and round 2
// shipped exactly that defect: a test computed the gate itself, compared the
// result to itself, and stayed green with the fix reverted. The rule looks
// violated here, so the difference is worth stating.
//
// There the second derivation was ACCIDENTAL and both sides moved together. Here
// the caption's English is the subject under test, and its executable reading is
// pinned in `CAPTIONS` below precisely so it CANNOT move when the code does. If
// `sizeByCapacity` changes its sort tomorrow, the pinned reading stops
// reproducing the decision and this gate fires. That is the whole point.
//
// ── why the harness checks itself before it judges anything ──────────────────
//
// A caption's order is a counterfactual — "what would this sentence have
// admitted?" — and the product only ever performs its own order, so the
// replay below is a second implementation of `sizeByCapacity`'s admission loop.
// A drifted replay would fail every caption including the true one, or pass a
// false one, and would look like a caption defect either way.
//
// So the first replay is run with the CODE's own ordering (`pressureOf`
// descending) and must reproduce `decideBand`'s `keep` and `achieved` exactly.
// If it does not, the harness is void and NO caption verdict is printed, because
// a verdict from a broken instrument is worse than no verdict. Every number
// below that line is downstream of that check passing.
//
// ── the ORDER is the claim, so the order is what is compared ────────────────
//
// An earlier version of this gate compared the SET a caption admits and the
// coverage total it reaches, on the reasoning that those are what `decideBand`
// publishes. Both are order-insensitive — a set has no sequence and a sum is
// commutative — while the caption's entire claim is that a particular account
// *goes first*. So the gate graded everything except the thing on trial.
//
// It was not a theoretical gap. Measured before the fix: transposing the top
// two accounts of the shipped caption's own reading left the admitted set and
// the total byte-identical and the caption graded REPRODUCES, with
// `admits [3,2]` printed on the same line as `vs decision [2,3]`.
//
// `explainBand` publishes the sequence the band actually walked, so the order
// is now read from the decision's own ladder and compared position by position.
// The set and total are still checked, because a caption can be wrong in more
// than one way and the failure line should say which.
//
// A sample can still fail to separate two orderings by set alone; that is
// reported as INDISTINGUISHABLE and fails the run, because a sample that cannot
// discriminate has produced no evidence and a non-answer must never read as a
// pass. And `transposed-band-order` in the registry below is this gate's own red
// control: the band's own order with two entries swapped, which admits the same
// set with the same total by construction. A verdict that stops consulting order
// grades it INDISTINGUISHABLE and the run fails, which is how a future edit that
// reintroduces the original blindness gets caught rather than inherited.
import fs from 'node:fs';
import { AccountManager } from '../src/account-manager.js';
import { decideBand, explainBand, pressureOf, headroomOf } from '../src/band-decision.js';
import { ruleCaption } from '../src/status-renderer.js';

const argv = process.argv.slice(2);
/** Last-wins is a silent way to obey an argument nobody meant; refuse instead. */
function opt(name) {
  const hits = argv.filter(a => a.startsWith(`--${name}=`));
  if (hits.length > 1) refuse(`--${name} passed ${hits.length} times; one value or none`);
  return hits.length ? hits[0].slice(name.length + 3) : null;
}
function refuse(message) {
  console.error(`verify-caption: ${message}`);
  process.exit(2);
}

/**
 * The captions this tool gates, each with the executable reading of its ordering
 * claim. `score` ranks DESCENDING; null means the caption's rule has nothing to
 * say about this account, which sorts it last exactly as absent pressure does in
 * `sizeByCapacity`.
 *
 * `shipped: false` entries are not dead weight — they are the gate's own red
 * control. `soonest-expiring` is the caption this block actually carried before
 * the design session falsified it against a live sample, so a run where it fails
 * to differ is a run that could not have caught the original defect either.
 *
 * @typedef {{ id: string, shipped: boolean, pinned: string,
 *             score: (a: any, now: number) => number|null }} Caption
 * @type {Caption[]}
 */
const CAPTIONS = [
  {
    id: 'unspent-weekly-per-hour',
    shipped: true,
    // The sentence this reading was written against, pinned. The text that
    // PRINTS comes from `ruleCaption` and is graded below; this string is the
    // tripwire for the one thing a gate cannot check by itself — someone
    // rewording the caption without asking whether the reading still reads it.
    // Reword the renderer and this run refuses until the reading is revisited.
    //
    // WHAT THE PIN STILL CANNOT CATCH, stated where the limit lives: a sentence
    // and a reading updated TOGETHER into a consistent lie pass, because nothing
    // can verify that an English claim and a scoring function mean the same
    // thing. That gap narrowed when the verdict began comparing order — the
    // reading must now also reproduce the sequence the band actually walked, so
    // a lie has to be consistent with the CODE as well as with itself, which
    // rules out any lie about the ordering. What survives is a sentence that
    // describes the real order in misleading English. A human reading the
    // `Rule` line is the only check on that, and this comment exists so the
    // next person knows it is theirs to make rather than the gate's.
    pinned: 'within the best priority tier, most unspent weekly quota per hour '
      + 'before it resets goes first, until 1.0 accounts of 5h headroom are covered; '
      + 'accounts missing either measurement are admitted regardless',
    // Per HOUR where the code computes per second: the two differ by 3600, a
    // positive constant, so they cannot order two accounts differently. Written
    // as the caption says it rather than as the code says it, because the reading
    // is what is on trial.
    //
    // The tier qualifier in the sentence has no counterpart here, and that is
    // correct rather than an omission: this scores the accounts it is handed,
    // and it is handed the top priority tier, because that is the only set the
    // band ranks. The sentence gained the qualifier because it was overclaiming
    // — unqualified, it said the highest-pressure account goes first, which a
    // priority-1 account with 330x the pressure of the top tier falsifies while
    // this gate stays green. The reading was always the narrower, truer one.
    score: (a, now) => {
      if (a.utilization == null || !Number.isFinite(a.utilization) || a.resetAt == null) return null;
      const hours = (a.resetAt - now) / 3600000;
      return hours > 0 ? (1 - a.utilization) / hours : 0;
    },
  },
  {
    id: 'soonest-expiring',
    shipped: false,
    pinned: 'the soonest-expiring account goes first',
    score: (a, now) => (a.resetAt == null ? null : -(a.resetAt - now)),
  },
  {
    id: 'least-used-weekly',
    shipped: false,
    pinned: 'the least-used weekly bucket goes first',
    score: a => (a.utilization == null || !Number.isFinite(a.utilization) ? null : -a.utilization),
  },
  {
    // THE ORDER CONTROL. Not a sentence anyone would write — it is this gate's
    // red control for the one property it exists to grade.
    //
    // The band's own order with its first two entries swapped. Both are admitted
    // (coverage is not met until at least the second), so the admitted SET and
    // the coverage TOTAL are identical to the decision's by construction, and
    // the only difference is sequence. A verdict that stops consulting order
    // therefore grades this INDISTINGUISHABLE and the run fails — which is how a
    // future edit that reintroduces the original blindness gets caught.
    //
    // Its premise is asserted below rather than assumed: if the swap changes the
    // admitted set on some sample, it is no longer an order-only control there
    // and the run refuses instead of quietly grading something else.
    id: 'transposed-band-order',
    shipped: false,
    pinned: "the band's own order with its first two entries swapped",
    score: (a, now) => {
      const p = pressureOf(a, now);
      return p.kind === 'known' ? p.value : null;
    },
    reorder: ordered => [ordered[1], ordered[0], ...ordered.slice(2)],
    orderOnly: true,
  },
];

if (argv.includes('--list')) {
  for (const c of CAPTIONS) console.log(`${c.shipped ? 'shipped ' : 'control '} ${c.id}\n    "${c.pinned}"`);
  process.exit(0);
}

const SAMPLE = opt('sample');
const MODEL = opt('model');
const NOW = opt('now');
const ONLY = opt('caption');

// No defaults on any of the three. A default sample compares a tree against a
// fixture nobody chose; a default model silently picks a governing bucket, which
// is the whole quantity under test; and a default `now` of the wall clock reads a
// captured sample through resets that expired weeks ago, which yields pressures
// of zero and a green run that verified nothing.
if (!SAMPLE) refuse('--sample=<status.json> is required (a captured /teamclaude/status body)');
if (!MODEL) refuse('--model=<id> is required: it resolves the governing weekly bucket the band ranks on');
if (!NOW) refuse('--now=<iso> is required: a captured sample is only meaningful against the clock it was captured at');

const now = Date.parse(NOW);
if (!Number.isFinite(now)) refuse(`--now=${NOW} is not a parseable timestamp`);

/**
 * What a caption SAYS. For the shipped one that is whatever `ruleCaption`
 * renders, because grading a copy of the sentence would leave the printed one
 * ungoverned; for a control it is the pinned string, since no renderer emits it.
 */
function textOf(caption) {
  return caption.shipped ? ruleCaption({ kind: 'sized', target: 1 }) : caption.pinned;
}

// The one thing this gate cannot check for itself: whether the reading below
// still reads the sentence above. Nothing can verify that an English claim and
// a scoring function mean the same thing, so the sentence is pinned and a
// reword stops the run rather than silently grading the new sentence with the
// old sentence's reading — which would pass, and would mean nothing.
const shippedText = ruleCaption({ kind: 'sized', target: 1 });
const pinned = CAPTIONS.find(c => c.shipped).pinned;
if (shippedText !== pinned) {
  console.error('verify-caption: the shipped caption has been reworded since this gate was written.');
  console.error(`  renders: ${shippedText}`);
  console.error(`  pinned:  ${pinned}`);
  console.error('  Re-read the new sentence, decide whether the executable reading in CAPTIONS still');
  console.error('  reads it, and update both together. Grading a new claim with an old reading passes');
  console.error('  and proves nothing.');
  process.exit(2);
}

// The whole process runs at the capture clock, not just the snapshot. Passing
// `now` into `_bandSnapshot` is not enough: the product reads the wall clock
// directly at points selection depends on, and `_clearExpiredQuotas` NULLS
// `unified5h` as soon as its reset is in the past (`account-manager.js:1588`).
// Measured rather than anticipated — the first run of this tool did exactly
// that. A sample captured yesterday arrived with every five-hour bucket
// cleared, so `sizeByCapacity` found no capacity signal, the band fell back to
// the ratio, and the tool was about to grade a coverage caption against a fleet
// that never existed. A captured sample is coherent only against the clock it
// was captured at.
Date.now = () => now;
if (ONLY && !CAPTIONS.some(c => c.id === ONLY)) refuse(`--caption=${ONLY} names no caption; --list shows them`);

let sample;
try {
  sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
} catch (err) {
  refuse(`cannot read ${SAMPLE}: ${err.message}`);
}
if (!Array.isArray(sample.accounts) || !sample.accounts.length) refuse(`${SAMPLE} carries no accounts[]`);
if (!sample.expiryRouting) refuse(`${SAMPLE} carries no expiryRouting block; it predates the band`);

// Rebuilt through the real constructor and the real snapshot builder, so the
// shape the band sees here is the shape it sees in the server. Auth type is
// forced because nothing below selection reads it and a captured sample does not
// carry credentials.
const am = new AccountManager(
  sample.accounts.map(a => ({ name: a.name, type: 'apikey', apiKey: 'sample', priority: a.priority || 0 })),
  sample.switchThreshold,
  {
    expiryRouting: sample.expiryRouting,
    // A CAPTURED STATUS IS NOT A CONFIG. `routes[].accounts` on the wire is
    // `[{name, eligible}]`, and `setRoutes` expects names — handed the objects,
    // every account stringifies to "[object Object]", matches nothing, and the
    // route excludes the entire fleet. The committed sample carries no routes,
    // so the gate could not be fed a real capture without silently grading an
    // empty fleet.
    routes: sample.routes?.filter(r => !r.autocreated)
      .map(r => ({ ...r, accounts: (r.accounts || []).map(a => (typeof a === 'string' ? a : a.name)) })),
  });
sample.accounts.forEach((a, i) => {
  am.accounts[i].quota = { ...a.quota };
  am.accounts[i].status = a.status || 'active';
  am.accounts[i].disabled = !!a.disabled;
  am.accounts[i].load = a.load || 0;
});

// The composition `_bandedCandidates` performs, with the clock injected: the
// predicate and the snapshot builder are the product's, only the wiring is here.
const candidates = am.accounts.filter(a => am._isAvailable(a, MODEL));
const snapshot = am._bandSnapshot(candidates, MODEL, now);
const decision = decideBand(snapshot);

console.log(`sample     ${SAMPLE}`);
console.log(`model      ${MODEL}   bucket ${am._governingBucket(am.accounts[0], MODEL)}   now ${new Date(now).toISOString()}`);
console.log(`fleet      ${candidates.length} of ${sample.accounts.length} accounts are candidates` +
  (candidates.length === sample.accounts.length ? '' :
    `  (excluded: ${am.accounts.filter(a => !candidates.includes(a)).map(a => a.name).join(', ')})`));
console.log(`decision   ${decision.kind}${decision.reason ? ` (${decision.reason})` : ''}` +
  (decision.kind === 'sized' ? `  target ${decision.target}  achieved ${decision.achieved.toFixed(3)}` : ''));

// Only the `sized` variant admits by coverage, which is what these captions
// describe. Under `banded` or `passthrough` the sentence on trial is a different
// sentence, and grading it against this one would grade the wrong claim.
if (decision.kind !== 'sized') {
  refuse(`the sample decides '${decision.kind}', so the coverage caption never runs on it; capture one where the band sizes`);
}

const top = Math.min(...snapshot.accounts.map(a => a.priority));
const tier = snapshot.accounts.filter(a => a.priority === top);
const tierIndices = new Set(tier.map(a => a.index));
const decided = {
  keep: decision.keep.filter(i => tierIndices.has(i)),
  achieved: decision.achieved,
};

/**
 * `sizeByCapacity`'s admission loop over an arbitrary order. Kept deliberately
 * literal against `band-decision.js:276-301` — including the absent-on-EITHER-
 * axis exemption, which is the clause a paraphrase drops first — because the
 * identity check below is what makes this fidelity a measured claim.
 */
function replay(order, { exempt = true } = {}) {
  const keep = [];
  let achieved = 0;
  let metAt = null;
  order.forEach((acct, i) => {
    const headroom = headroomOf(acct, snapshot.switchThreshold);
    const pressure = pressureOf(acct, snapshot.now);
    // `exempt: false` is the STRICT reading of the caption's stop clause —
    // admission halts at coverage, full stop. It exists so a control can show
    // the difference between that and what the band does, which is the whole
    // content of the exemption half of the sentence.
    const unmeasured = exempt && (headroom.kind === 'absent' || pressure.kind === 'absent');
    if (!unmeasured && achieved >= snapshot.coverage) return;
    keep.push(acct.index);
    if (headroom.kind === 'known') achieved += headroom.value;
    if (metAt === null && achieved >= snapshot.coverage) metAt = i + 1;
  });
  return { keep, achieved, metAt };
}

/** Descending by score, nulls last, ties left in the tier's own order (stable). */
function orderBy(score) {
  return tier.map((a, i) => ({ a, i, v: score(a, snapshot.now) }))
    .sort((x, y) => {
      const xv = x.v == null ? -Infinity : x.v;
      const yv = y.v == null ? -Infinity : y.v;
      return yv - xv || x.i - y.i;
    })
    .map(e => e.a);
}

const sameSet = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
const sameTotal = (a, b) => Math.abs(a - b) < 1e-9;
const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The sequence the band actually walked, read from the decision's own published
// ladder rather than re-sorted here. Lower-tier rows are appended without ever
// being compared, so they are not part of any ordering claim.
const codeOrder = explainBand(snapshot).ladder
  .filter(r => r.reason !== 'lower-tier')
  .map(r => r.account.index);

// Two ranked accounts minimum, or the order control below cannot transpose and
// the run would have no evidence the verdict consults order at all.
if (codeOrder.length < 2) {
  refuse('the sample has fewer than two ranked accounts, so the order control cannot run; '
    + 'without it this run has no evidence the gate can see order');
}

const pressureScore = a => {
  const p = pressureOf(a, snapshot.now);
  return p.kind === 'known' ? p.value : null;
};

// ── harness self-check ──────────────────────────────────────────────────────
const identityOrdering = orderBy(pressureScore);
const identity = replay(identityOrdering);
const identityOrder = identityOrdering.map(a => a.index);
const harnessOk = sameOrder(identityOrder, codeOrder)
  && sameSet(identity.keep, decided.keep) && sameTotal(identity.achieved, decided.achieved);
console.log(`\nharness    replaying the CODE's own order reproduces the decision: ${harnessOk ? 'yes' : 'NO'}`);
if (!harnessOk) {
  console.error(`  ladder order [${codeOrder}]  decideBand kept [${decided.keep}] achieving ${decided.achieved.toFixed(3)}`);
  console.error(`  replay order [${identityOrder}]  replay     kept [${identity.keep}] achieving ${identity.achieved.toFixed(3)}`);
  console.error('  the admission replay has drifted from sizeByCapacity. No caption verdict is printed:');
  console.error('  every verdict this tool could give is downstream of this check, so all of them are void.');
  process.exit(1);
}
console.log(`           coverage ${snapshot.coverage} met at p${identity.metAt ?? '-'} of ${tier.length} ranked`);
console.log(`           the band walked [${codeOrder}], which is the sequence each caption is graded against`);

const unmeasuredRows = tier.filter(a => {
  const p = pressureOf(a, snapshot.now);
  const h = headroomOf(a, snapshot.switchThreshold);
  return p.kind === 'absent' || h.kind === 'absent';
}).length;
if (unmeasuredRows) {
  console.log(`           ${unmeasuredRows} of ${tier.length} rows are unmeasured on an axis and admitted by the exemption,`);
  console.log('           which the caption text does not state. The verdicts below depend on it.');
}

// ── caption verdicts ────────────────────────────────────────────────────────
const results = [];
for (const caption of CAPTIONS) {
  if (ONLY && caption.id !== ONLY) continue;
  const ordering = caption.reorder ? caption.reorder(orderBy(caption.score)) : orderBy(caption.score);
  const got = replay(ordering);
  const gotOrder = ordering.map(a => a.index);
  // An order-only control has to BE order-only on this sample, or it is grading
  // something other than sequence and its verdict says nothing about order.
  if (caption.orderOnly
    && !(sameSet(got.keep, decided.keep) && sameTotal(got.achieved, decided.achieved))) {
    refuse(`the order control changed the admitted set on this sample `
      + `([${got.keep}] achieving ${got.achieved.toFixed(3)} against [${decided.keep}] `
      + `achieving ${decided.achieved.toFixed(3)}), so it is not an order-only control here `
      + 'and cannot show that the verdict consults order');
  }
  // Order first, because it is the caption's actual claim; set and total are
  // still checked so a caption wrong in more than one way says which.
  const orderMatches = sameOrder(gotOrder, codeOrder);
  const reproduces = orderMatches
    && sameSet(got.keep, decided.keep) && sameTotal(got.achieved, decided.achieved);
  let verdict;
  if (caption.shipped) verdict = reproduces ? 'REPRODUCES' : 'FALSIFIED';
  else verdict = reproduces ? 'INDISTINGUISHABLE' : 'DIFFERS';
  results.push({ caption, got, gotOrder, orderMatches, verdict, text: textOf(caption) });
}

console.log('');
for (const r of results) {
  console.log(`${r.verdict.padEnd(18)} ${r.caption.id}${r.caption.shipped ? '  (shipped)' : '  (control)'}`);
  console.log(`                   "${r.text}"`);
  console.log(`                   orders [${r.gotOrder}] vs the band's [${codeOrder}]`
    + `   ${r.orderMatches ? 'same sequence' : 'DIFFERENT SEQUENCE'}`);
  console.log(`                   admits [${r.got.keep}] achieving ${r.got.achieved.toFixed(3)}` +
    `   vs decision [${decided.keep}] achieving ${decided.achieved.toFixed(3)}`);
  if (r.verdict === 'INDISTINGUISHABLE') {
    console.log('                   this sample admits the same set under both rules, so it cannot tell this control');
    console.log('                   from the shipped caption and produces no evidence for either. Run a scope or a');
    console.log('                   fleet where they separate; the run fails rather than reporting a pass it did not earn.');
  }
}

// One clause per verdict, counted from the verdicts rather than asserted beside
// them: a summary that states what the check decided, computed from the same
// data the check used.
// ── CROSS-TIER CONTROL ──────────────────────────────────────────────────────
//
// The caption's ordering claim is scoped to a priority tier. This checks that
// the scope is load-bearing rather than decoration, because the sentence was
// wrong here once: unqualified, it claimed the most-expiring account goes first,
// while `decideBand` ranks only the best priority tier and appends the rest
// untouched. A priority-1 account with far more expiring quota than the whole
// top tier therefore goes LAST, and the sentence said it goes first.
//
// The rows above cannot see this: `codeOrder` is the ladder minus lower-tier
// rows, and the readings are scored over the tier, so a cross-tier inversion is
// invisible to every verdict printed so far. Hence a separate check on a
// synthesised fleet, and hence its own premise assertions.
//
// Demote the account the band ranked first and re-decide. The band must then not
// rank it at all; the UNQUALIFIED reading — pressure over every candidate,
// ignoring priority — must still put it first. If those two agree, the tier
// scope is unobservable here and this control has proved nothing.
const demotedIndex = codeOrder[0];
const crossTier = {
  ...snapshot,
  accounts: snapshot.accounts.map(a => (a.index === demotedIndex ? { ...a, priority: 1 } : a)),
};
const crossLadder = explainBand(crossTier).ladder;
const demotedRow = crossLadder.find(r => r.account.index === demotedIndex);
const crossTierOrder = crossLadder.filter(r => r.reason !== 'lower-tier').map(r => r.account.index);

// Premise 1: the demotion actually moved it out of the ranked set.
if (!demotedRow || demotedRow.reason !== 'lower-tier' || demotedRow.rank != null) {
  refuse('the cross-tier control could not demote the top account out of the ranked set '
    + `(row reason ${demotedRow ? demotedRow.reason : 'missing'}, rank ${demotedRow?.rank}), `
    + 'so it cannot show that the caption\'s tier scope is load-bearing');
}
// Premise 2: it still has the highest pressure of the fleet, which is what makes
// the unqualified reading name it and the priority rule the only thing stopping it.
const pressures = crossTier.accounts.map(a => ({ index: a.index, p: pressureScore(a) }));
const strongest = pressures.reduce((best, x) => ((x.p ?? -Infinity) > (best.p ?? -Infinity) ? x : best));
if (strongest.index !== demotedIndex) {
  refuse('the demoted account is not the highest-pressure one on this sample, so the '
    + 'unqualified reading would not name it and the control tests nothing about priority');
}

const unqualifiedFirst = strongest.index;
const bandFirst = crossTierOrder[0];
const scopeIsLoadBearing = unqualifiedFirst !== bandFirst;
console.log(`\ncross-tier  demoting [${demotedIndex}] to a lower priority: the band then ranks `
  + `[${crossTierOrder}] and the unqualified reading still names [${unqualifiedFirst}] first`
  + `  ${scopeIsLoadBearing ? 'DIFFERS, as it must' : 'READS THE SAME'}`);
if (!scopeIsLoadBearing) {
  console.error('  the tier-scoped and unqualified readings agree on this fleet, so nothing here');
  console.error('  shows the caption\'s priority qualifier is doing any work.');
  process.exit(1);
}

// ── STOP-CLAUSE CONTROL ─────────────────────────────────────────────────────
//
// The caption says admission runs "until N accounts of 5h headroom are covered"
// and then that "accounts missing either measurement are admitted regardless".
// The second half is the load-bearing one and was absent from the sentence for
// four passes: a fleet with an unmeasured account admits it AFTER coverage is
// met, so a ladder can hold one row for `coverage-met` and admit the next.
//
// This grades that half. The strict reading — stop at coverage, full stop — must
// admit a SMALLER set than the band does. If the two agree the exemption is
// invisible on this fleet and the clause is ungraded, which is the state the
// caption was in until a pass found it.
//
// EITHER MEASUREMENT MEANS TWO, and this graded one of them. The clause exempts
// an account "missing either measurement": pressure OR headroom. Synthesising
// absence by removing `resetAt` only ever produces the PRESSURE half, so the
// exemption could have been lost on the headroom side — an account with a known
// pressure and no five-hour reading — and this gate would have stayed green.
// Filed from outside on pass 4, and it is the falsification-per-axis argument
// arriving on schedule: a control checks what its author thought to build,
// while the sentence's claim space is wider than that.
//
// One implementation, two axes. Two copies of this would be two chances to fix
// the axis nobody is looking at, which is the shape being closed here.
//
// Synthesised, because the committed sample has no unmeasured account: the
// lowest-ranked account loses one measurement. Removing `resetAt` makes its
// pressure absent (and sorts it last, where it already is); removing `fiveHour`
// leaves the ranking untouched and takes its headroom away instead.
function gradeExemption(axis, drop, expectedReason) {
  const lastRanked = codeOrder[codeOrder.length - 1];
  const exemptSnapshot = {
    ...snapshot,
    accounts: snapshot.accounts.map(a => (a.index === lastRanked ? { ...a, ...drop } : a)),
  };
  const exemptLadder = explainBand(exemptSnapshot).ladder;
  const exemptRow = exemptLadder.find(r => r.account.index === lastRanked);
  const heldBefore = exemptLadder.findIndex(r => !r.admitted);

  // Premise 1: the account must actually be admitted by the exemption, and on
  // THIS axis — a headroom control that produced an absent-pressure row would
  // grade the axis the other control already covers.
  if (!exemptRow || !exemptRow.admitted || exemptRow.reason !== expectedReason) {
    refuse(`the ${axis} stop-clause control could not produce a row admitted by that half of `
      + `the exemption (reason ${exemptRow ? exemptRow.reason : 'missing'}, admitted `
      + `${exemptRow?.admitted}, wanted ${expectedReason}), so it cannot grade the clause`);
  }
  // Premise 2: it must be admitted AFTER coverage was already met, or the strict
  // reading would admit it too and the two would agree for a trivial reason.
  if (heldBefore < 0 || exemptLadder.indexOf(exemptRow) < heldBefore) {
    refuse(`the ${axis} exempt row is not admitted after a held one on this sample, so the `
      + 'strict and exempting readings cannot differ and the stop clause stays ungraded');
  }

  const exemptTier = exemptSnapshot.accounts.filter(a => a.priority === Math.min(...exemptSnapshot.accounts.map(x => x.priority)));
  const orderedExempt = exemptTier
    .map((a, i) => ({ a, i, v: pressureScore(a) }))
    .sort((x, y) => ((y.v == null ? -Infinity : y.v) - (x.v == null ? -Infinity : x.v)) || x.i - y.i)
    .map(e => e.a);
  const asWritten = replay(orderedExempt).keep;
  const strictStop = replay(orderedExempt, { exempt: false }).keep;
  const observable = !sameSet(asWritten, strictStop);
  console.log(`\nstop clause  ${axis.padEnd(8)} with the exemption [${asWritten}] against a strict stop `
    + `at coverage [${strictStop}]  ${observable ? 'DIFFERS, as it must' : 'READS THE SAME'}`);
  if (!observable) {
    console.error(`  a caption that stopped at coverage and said nothing about a missing ${axis}`);
    console.error('  would grade identically here, so this run does not check that clause at all.');
    process.exit(1);
  }
}

gradeExemption('pressure', { resetAt: null }, 'unmeasured-exempt-pressure');
gradeExemption('headroom', { fiveHour: null }, 'unmeasured-exempt-headroom');

// ── THE BANDED CAPTION ──────────────────────────────────────────────────────
//
// `ruleCaption` has two branches and everything above grades one of them. The
// other runs whenever no account has reported a five-hour level — the
// cold-start and probe-off state, which is not exotic — and it has never been
// graded at all. That is the same gap the stop clause was in for four passes,
// on a different axis, and deferring it once is how that one became a finding.
//
// The banded sentence claims three things: the best priority TIER, everything
// within the tolerance RATIO of the best unspent-weekly-per-hour, and accounts
// with no pressure reading admitted REGARDLESS. Each is replayed literally
// against `floorSteps`, from the same sample with its five-hour readings
// removed — which is precisely what makes the band fall back to the ratio.
// Synthesised on two axes, because the committed sample cannot exercise either
// clause on its own: with the five-hour readings gone every account still has a
// known pressure and all of them clear the floor, so a caption saying "admit
// everything" would reproduce exactly as well as the real one. The
// lowest-ranked account's window is pushed far out (pressure below the floor,
// so the RATIO is observable) and the next one's reset is removed (pressure
// absent, so the EXEMPTION is observable).
const belowIdx = codeOrder[codeOrder.length - 1];
const absentIdx = codeOrder[codeOrder.length - 2];
const bandedSnapshot = {
  ...snapshot,
  accounts: snapshot.accounts.map((a) => {
    const base = { ...a, fiveHour: null };
    if (a.index === belowIdx) return { ...base, resetAt: snapshot.now + 1e12 };
    if (a.index === absentIdx) return { ...base, resetAt: null };
    return base;
  }),
};
const bandedDecision = decideBand(bandedSnapshot);
// Premise: the fallback must actually be running, or this grades the sentence
// that is not on screen.
if (bandedDecision.kind !== 'banded') {
  refuse(`removing every five-hour reading still decides '${bandedDecision.kind}', so the `
    + 'banded caption never runs on this sample and cannot be graded from it');
}

const bandedTier = bandedSnapshot.accounts
  .filter(a => a.priority === Math.min(...bandedSnapshot.accounts.map(x => x.priority)));
const bandedScores = bandedTier.map(a => pressureScore(a));
const maxKnown = Math.max(...bandedScores.filter(v => v != null));
const ratio = Number.isFinite(bandedSnapshot.tolerance) && bandedSnapshot.tolerance > 0
  ? bandedSnapshot.tolerance : 1;
const asWrittenFloor = Math.min(maxKnown, maxKnown / ratio);
// The sentence, replayed: admit an account whose pressure is at or above the
// floor, and admit an account with no pressure reading whatever the floor is.
const bandedKeep = bandedTier
  .filter((a, i) => bandedScores[i] == null || bandedScores[i] >= asWrittenFloor)
  .map(a => a.index);
const bandedCode = bandedDecision.keep.filter(i => bandedTier.some(a => a.index === i));
// Premises, so the comparison below cannot pass by admitting everything: the
// floor must exclude one account, and one must be admitted with no reading.
if (bandedCode.includes(belowIdx)) {
  refuse(`the floor admits [${belowIdx}] on the banded fleet, so the tolerance clause is not `
    + 'observable here and a caption with no floor at all would grade the same. TWO CAUSES, '
    + 'and the second is likelier: this sample stopped discriminating, or `floorSteps` stopped '
    + 'applying the floor. Read the rule before touching the fixture.');
}
if (!bandedCode.includes(absentIdx)) {
  refuse(`the account with no pressure reading [${absentIdx}] was not admitted, so the `
    + '"regardless" clause is not what this sample exercises. TWO CAUSES, and the second is '
    + 'likelier: this sample stopped carrying an unmeasured account, or `floorSteps` stopped '
    + 'exempting one. Read the rule before touching the fixture.');
}
const bandedAgrees = sameSet(bandedKeep, bandedCode)
  && sameTotal(asWrittenFloor, bandedDecision.floor);
console.log(`\nbanded      the sentence admits [${bandedKeep}] at floor ${asWrittenFloor.toExponential(3)}`
  + `  against the decision's [${bandedCode}] at ${bandedDecision.floor.toExponential(3)}`
  + `  ${bandedAgrees ? 'REPRODUCES' : 'FALSIFIED'}`);
if (!bandedAgrees) {
  console.error('  the banded caption does not describe what the ratio rule did on this fleet.');
  process.exit(1);
}

// Its red control, on the clause most easily lost: a reading that drops the
// exemption admits a SMALLER set, or the exemption is invisible here and the
// clause is ungraded — the same argument as the stop clause's two axes.
const strictBanded = bandedTier
  .filter((a, i) => bandedScores[i] != null && bandedScores[i] >= asWrittenFloor)
  .map(a => a.index);
const exemptionObservable = !sameSet(bandedKeep, strictBanded);
console.log(`banded      with the pressure exemption [${bandedKeep}] against a strict floor `
  + `[${strictBanded}]  ${exemptionObservable ? 'DIFFERS, as it must' : 'READS THE SAME'}`);
if (!exemptionObservable) {
  console.error('  no account in this sample lacks a pressure reading once the five-hour figures');
  console.error('  are gone, so "admitted regardless" is not exercised and the clause is ungraded.');
  process.exit(1);
}

const tally = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
const failed = results.filter(r => r.verdict === 'FALSIFIED' || r.verdict === 'INDISTINGUISHABLE');
console.log(`\nsummary    ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}` +
  `  over ${results.length} caption${results.length === 1 ? '' : 's'} on ${tier.length} ranked accounts`);
if (failed.length) {
  console.log(`           ${failed.length} caption${failed.length === 1 ? '' : 's'} did not grade as expected: ` +
    failed.map(r => r.caption.id).join(', '));
}
process.exit(failed.length ? 1 : 0);
