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
      + 'before it resets goes first, until 1.0 accounts of 5h headroom are covered',
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
  { expiryRouting: sample.expiryRouting, routes: sample.routes?.filter(r => !r.autocreated) });
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
function replay(order) {
  const keep = [];
  let achieved = 0;
  let metAt = null;
  order.forEach((acct, i) => {
    const headroom = headroomOf(acct, snapshot.switchThreshold);
    const pressure = pressureOf(acct, snapshot.now);
    const unmeasured = headroom.kind === 'absent' || pressure.kind === 'absent';
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
const tally = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
const failed = results.filter(r => r.verdict === 'FALSIFIED' || r.verdict === 'INDISTINGUISHABLE');
console.log(`\nsummary    ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}` +
  `  over ${results.length} caption${results.length === 1 ? '' : 's'} on ${tier.length} ranked accounts`);
if (failed.length) {
  console.log(`           ${failed.length} caption${failed.length === 1 ? '' : 's'} did not grade as expected: ` +
    failed.map(r => r.caption.id).join(', '));
}
process.exit(failed.length ? 1 : 0);
