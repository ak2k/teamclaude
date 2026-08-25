// The F5 acceptance criterion: for each accountManager.* call on the request
// path that this branch touches, and for each of its arguments, the suite must
// FAIL when it is removed. Mutates src/server.js only, runs the whole suite,
// restores, and prints which test caught it.
//
// READ THIS BEFORE TRUSTING THE SUMMARY LINE. This is an instrument, and every
// way it has lied so far has been by reporting health while measuring nothing:
//
//   - MISSING ANCHOR. A mutation whose find-text no longer exists is not
//     applied, so it proves nothing — and this happens precisely when the code
//     has moved, which is when you most need the answer. Exits non-zero and
//     names them; never let one sit as a quiet row beside a healthy count.
//   - RUNAWAY. A mutation can make the suite never finish rather than fail
//     (dropping the per-request exclusion set turns failover into an unbounded
//     retry loop). A run that has to be killed is a caught mutation, not a
//     passing one. NOTE: no row has been observed to reach this by timeout.
//   - OUTPUT FLOOD, which is what the row above actually did. Measured over
//     three repetitions of `getActiveAccount arg exclude`: ENOBUFS at 98s and
//     65 MB with no `✖` anywhere, a clean finish at 12s naming 12 failing
//     tests, then ENOBUFS again at 107s, with `killed=undefined` and
//     `signal=null` every time. Nothing was unbounded and nothing was killed;
//     the suite simply out-ran a 64 MiB pipe buffer about two thirds of the
//     time, and losing that race produced a 65 MB head with no failure markers
//     in it. Output now goes to a file, which has no such limit, so the verdict
//     is the one the run produced rather than a coin flip.
//   - INCOMPLETE RUN. A child that exits before the reporter writes its summary
//     emits no failure markers either, and "no failures" is then
//     indistinguishable from "nothing was looked at". Rows require a summary
//     line and grade INDETERMINATE without one — never CAUGHT, since a process
//     dying for an unrelated reason also writes no summary.
//   - UNPARSEABLE MUTATION. A replacement that leaves invalid syntax is not a
//     tested mutation: every importer fails to load and the row DIES on the fact
//     that JavaScript has a grammar. Measured on `beginSession call deleted`
//     before it was re-anchored — 32 entries, every one an unparseable file, not
//     one a named test, harness exit 0. The mutated file is now syntax-checked
//     BEFORE the suite runs and grades INVALID, which is ungraded and fails the
//     run. Checked rather than inferred from the output: the marker-counting
//     alternative already has a known counterexample in this file's own
//     file-level section, which missed that row because one named test survived
//     among the failures it hid.
//   - A SECOND DEFINITION OF "THE SUITE". The command comes from the project's
//     `scripts.test`, not from a copy here. A hardcoded `node --test` agreed
//     with `npm test` until it did not: the project sets `--test-timeout`, this
//     did not, and a slow-but-passing test would clear the baseline and fail CI.
//
// TWO CONTROL ROWS carry the only verdicts known before a run: an identity
// rewrite that must SURVIVE, and an unparseable edit that must be refused as
// INVALID. They check what this table can still SAY. Ordinary rows are graded by
// what the code does; if the harness loses the ability to emit a verdict, only a
// row whose expected verdict is that one can reveal it.
//
// The shape is always the same: green because nothing was checked, not because
// nothing was wrong. That is the same failure this table exists to catch in the
// code, so hold the table to it too.
//
// Usage: node tools/mutation-seam-table.mjs --repo=<checkout> [--force] [label prefix ...]
//
// The repo path is REQUIRED and has no default. This harness writes to
// src/server.js in the tree it is pointed at, so a baked-in default is a way to
// silently overwrite a checkout somebody else is working in — which is exactly
// what a shared scratch tree is. For the same reason it refuses to run against
// a tree with uncommitted changes unless --force says you meant it: a crash
// between write and restore leaves the mutation behind, and it can only restore
// what it read.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let runSeq = 0;

const args = process.argv.slice(2);
const repoArg = args.find(a => a.startsWith('--repo='));
if (!repoArg) {
  console.error('usage: tools/mutation-seam-table.mjs --repo=<checkout> [--force] [label prefix ...]');
  process.exit(2);
}
const REPO = repoArg.slice('--repo='.length);
const force = args.includes('--force');
const fullFails = args.includes('--full-fails');
// Run the suite with the interpreter running this harness, so the table is
// measured on the same runtime the developer is using.
const NODE = process.execPath;
const FILE = `${REPO}/src/server.js`;

if (!fs.existsSync(FILE)) {
  console.error(`no ${FILE} — is --repo a teamclaude checkout?`);
  process.exit(2);
}
// A tree is mutable by this harness only if it carries the marker. Clean is NOT
// the same as mine: the shared checkout is usually clean, which is exactly how a
// "safe" run destroys a tree three reviewers are reading. The marker is absent
// by default and never committed, so the default is refusal for every tree.
//   touch <worktree>/.mutation-sandbox
// A COMMITTED marker would mark every checkout at once and turn this guard into
// a no-op everywhere, silently — the failure it exists to prevent, wearing its
// own badge. It is gitignored; refuse if it is tracked anyway.
try {
  execFileSync('git', ['-C', REPO, 'ls-files', '--error-unmatch', '.mutation-sandbox'],
    { stdio: 'ignore' });
  console.error('.mutation-sandbox is COMMITTED in this repo, which marks every checkout'
    + ' and disables this guard everywhere. Remove it from version control before running.');
  process.exit(2);
} catch { /* not tracked, which is the only acceptable state */ }
if (!fs.existsSync(`${REPO}/.mutation-sandbox`)) {
  console.error(`${REPO} is not marked as a mutation sandbox.\n\n`
    + 'This harness rewrites src/server.js in place. Run it in a worktree of your own:\n'
    + '  git worktree add --detach <path> <ref> && touch <path>/.mutation-sandbox\n\n'
    + 'Do NOT mark a checkout somebody else may be reading.');
  process.exit(2);
}
// The marker itself is untracked, so it must not read as somebody else's work.
const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' })
  .split('\n').filter(l => l.trim() && !l.endsWith('.mutation-sandbox')).join('\n');
if (dirty && !force) {
  console.error(`${REPO} has uncommitted changes — a crash between write and restore leaves`
    + ` a mutation behind, and this can only restore what it read:\n${dirty}\n`
    + 'Commit or stash them, or pass --force if you are certain.');
  process.exit(2);
}

// The suite command comes from the project, not from here. Read once, up front,
// so a malformed package.json fails before any file is mutated rather than
// midway through a table with rows already restored and rows not yet run.
const PKG = `${REPO}/package.json`;
if (!fs.existsSync(PKG)) {
  console.error(`no ${PKG} — cannot learn how this project runs its tests`);
  process.exit(2);
}
const TEST_COMMAND = (() => {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  } catch (err) {
    console.error(`${PKG} is not valid JSON, so the test command cannot be read: ${err.message}`);
    process.exit(2);
  }
  const script = pkg.scripts?.test;
  if (typeof script !== 'string' || !script.trim()) {
    console.error(`${PKG} defines no "scripts.test", so there is no project definition of a test run`
      + ' for this harness to share. Add one, or this table grades against a second definition.');
    process.exit(2);
  }
  return script.trim();
})();

// The harness's own runaway guard, and it must OUTLAST the project's per-test
// timeout or a slow-but-passing test is killed here and graded as a runaway
// while `npm test` reports it green. Asserted rather than assumed, because the
// two numbers live in different files and only one of them is in this repo's
// review surface.
const PROCESS_TIMEOUT_MS = 180_000;
{
  // FAILING TO READ THE TIMEOUT IS A REFUSAL, NOT A PASS. The first version of
  // this guard tested `match && value >= wall`, so a command it could not parse
  // left `match` null, the condition false, and the harness proceeded without a
  // word — scoring "I could not find the number" as "the number is fine". That
  // is the same absence-shaped failure as the INDETERMINATE grade one screen
  // down, in the guard written to prevent its cousin.
  //
  // The token is captured whole rather than as `(\d+)`, because a digit-prefix
  // match scores a partial parse as a successful one: `--test-timeout=2m` would
  // capture `2`, compare 2 against 180000, and pass.
  const all = [...TEST_COMMAND.matchAll(/--test-timeout(?:=|\s+)(\S+)/g)];
  if (!all.length) {
    console.error(`cannot find a --test-timeout in the project's test command, so this harness cannot`
      + ' verify that its own process wall outlasts it. Without that, a test the project would let'
      + ' finish can be killed here and graded RUNS AWAY while `npm test` calls it green.\n'
      + `  scripts.test: ${TEST_COMMAND}\n`
      + '  Add an explicit --test-timeout=<ms> there, or lower PROCESS_TIMEOUT_MS to a value you have'
      + ' checked by hand.');
    process.exit(2);
  }
  // node applies the last occurrence, so this compares the one that will govern.
  const raw = all[all.length - 1][1];
  if (!/^\d+$/.test(raw)) {
    console.error(`the project's per-test timeout is "${raw}", which this harness cannot read as a`
      + ' number of milliseconds, so the precondition below is unverifiable rather than satisfied.\n'
      + `  scripts.test: ${TEST_COMMAND}`);
    process.exit(2);
  }
  if (Number(raw) >= PROCESS_TIMEOUT_MS) {
    console.error(`the project's per-test timeout (${raw}ms) is not shorter than this harness's`
      + ` process timeout (${PROCESS_TIMEOUT_MS}ms), so a test the project would allow to finish would be`
      + ' killed here and graded RUNS AWAY. Raise PROCESS_TIMEOUT_MS above it.');
    process.exit(2);
  }
}

const SELECT = 'accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId, ctx.decision)';
const RECORD = 'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision, ctx.hold);';
const CONFIRM = 'accountManager.confirmRouted(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);';
// Indentation included: these two anchor the endSession MOVE, and the release
// has to land inside the try rather than merely somewhere in the handler.
const BEGIN_SESSION = '      ctx.hold = accountManager.beginSession(sessionId);\n';
const END_IN_FINALLY = '        accountManager.endSession(sessionId, ctx.hold);\n';
const FORWARD_AWAIT = '        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);\n';
const REC_STREAM = '      accountManager.recordTokenUsage(accountIndex, sessionId, model, merged);';
const REC_BODY = '      accountManager.recordTokenUsage(accountIndex, sessionId, model, json.usage);';
// Re-anchored TWICE. First when the band's clock became a parameter; then when
// the entry's ROUTE became one, which severed it again — and that time the two
// rows went NEVER APPLIED for a full run because I re-anchored my other table
// and inferred this one was safe on the grounds that its anchors live in
// `tools/`. These two anchor in `src/account-manager.js`, inside the very
// function the edit changed, so the coverage that stopped measuring was the
// coverage of that edit. Inference about where anchors live is not a check.
//
// Re-anchored when the band's clock became a parameter: an observation hands in
// the instant its projection was taken at, so the call no longer reads
// `Date.now()` here. The interventions are unchanged — one severs the decision
// from its application, the other freezes the clock — but the anchor had to
// follow the text, and until it did both rows measured nothing and said so.
const BAND_APPLY = '    const decision = decideBand(this._bandSnapshot(candidates, model, now, route));\n';
const SIZED_BRANCH = '  const sizing = sizeByCapacity(tier, pressures, snapshot);\n';
const UNMEASURED_BOTH = '    const unmeasured = entry.headroom.kind === \'absent\' || entry.pressure.kind === \'absent\';\n';
// Re-anchored when the admission loop began recording its steps: the stop went
// from a bare `continue` to a block that pushes a held row first. The
// intervention is unchanged — the guard never fires and every account is
// admitted — but the anchor had to follow the text, and until it did this row
// silently measured nothing while the table still counted 63.
const COVERAGE_STOP = '    if (!unmeasured && achieved >= snapshot.coverage) {\n';
// Re-anchored when the session-reset switch was split into a chooser and an
// applier: the guard now refuses by returning null to `_switchOnSessionReset`
// rather than returning from it. Same intervention — delete the guard and the
// switch may leave a strictly better incumbent behind.
const RESET_RANK_GUARD = '    if (rankOf.get(best.index) > rankOf.get(current.index)) return null;\n';
const RESET_RANK_ORDER = '      if (mine < theirs\n';
const HOLD_RELEASE = '    this._releaseHold(s, hold);\n';
const HOLD_DRAIN = '      for (const h of [...s.holds]) this._releaseHold(s, h);\n';
// Re-anchored when the claim boundary gained its released-hold test. BOTH THE
// FIND TEXT AND EVERY REPLACEMENT MOVE TOGETHER: a replacement left at the old
// two-term shape would silently drop the new term as well, so the row would
// pass while measuring an intervention its name does not describe.
const HOLD_CLAIM = '        if (hold && hold.rid === s.rid && s.holds.has(hold) && !hold.buckets.has(bucket)) {\n';
// The rid stamp itself. Ported with the invariant test it kills: the two rows
// withdrawn above rest on "membership in `holds` implies the record's rid",
// and severing the stamp is the observable half of that claim.
const RID_STAMP = '    const hold = { rid: s.rid, buckets: new Set() };\n';
const HOLD_OWNER_END = '    if (hold && hold.rid !== s.rid) return null;\n';
// Re-anchored when the gate began naming the bucket its figure came from. The
// maximum is now spelled as a comparison that carries the winner out, so the
// anchor moved with it; the intervention is unchanged, since returning the
// family bucket unconditionally is exactly "the maximum is never taken".
const GATE_MAX = "  return shared > own ? { value: shared, bucket: 'unified7d' } : { value: own, bucket: bucketKey };\n";
const GATE_SHARED_READ = '  const shared = quota?.unified7d ?? null;\n';
const PIN_HELD = '    return now - pin.at <= this.activeTtlMs || (s.pinHolds.get(bucket) || 0) > 0;\n';
const PICK_PRESSURE = '          pressure: pressures[i],\n';
const PICK_PRESSURE_TERM = '  { term: \'pressure\', of: a => pressureRank(a.pressure) },\n';
const BEST_PRESSURE = '          || (priority === bestPriority && pressure < bestPressure)\n';
const PRESSURE_OFF = '      return candidates.map(() => ({ kind: \'absent\', reason: \'expiry-routing-off\' }));\n';
const LOAD_BUCKET = '        const t = s.tokens?.get(bucket);\n';
const PICK_APPLY = '    const decision = decidePick(this._pickSnapshot(candidates, model, now));\n';
const PICK_LOAD = '          load: measured.context,\n';
const PICK_OBSERVED = '          observed: measured.reports,\n';
const FIVE_HOUR_READ = '          fiveHour: typeof fiveHour === \'number\' ? fiveHour : null,\n';
const MERGE_START = '      Object.assign(merged, data.message.usage);';
const MERGE_DELTA = '      Object.assign(merged, data.usage);';
const GUARDED_WRITE = '    if (Object.keys(merged).length) {\n'
  + '      accountManager.recordTokenUsage(accountIndex, sessionId, model, merged);\n'
  + '    }\n';

// Rows whose label starts with this are CONTROLS, not mutations: their expected
// verdict is known before the run, so they are the only rows that say anything
// about the harness rather than about the code. They are excluded from the
// mutation count and checked separately below.
const CONTROL = 'CONTROL';

// [label, find, replace], or [label, find, replace, relativeFile] for a
// seam that does not live in src/server.js. The default keeps every
// pre-existing row meaning exactly what it did.
const M = [
  // getActiveAccount — the call itself cannot be deleted (nothing would route),
  // so each argument is dropped in turn.
  ['getActiveAccount  arg exclude (ctx.tried)', SELECT,
    'accountManager.getActiveAccount(null, ctx.model, ctx.advisorModel, ctx.sessionId, ctx.decision)'],
  ['getActiveAccount  arg model', SELECT,
    'accountManager.getActiveAccount(ctx.tried, null, ctx.advisorModel, ctx.sessionId, ctx.decision)'],
  ['getActiveAccount  arg advisorModel', SELECT,
    'accountManager.getActiveAccount(ctx.tried, ctx.model, null, ctx.sessionId, ctx.decision)'],
  ['getActiveAccount  arg sessionId', SELECT,
    'accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, null, ctx.decision)'],
  ['getActiveAccount  arg decision', SELECT,
    'accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId)'],

  ['recordSession     call deleted', RECORD, ''],
  ['recordSession     arg sessionId', RECORD,
    'accountManager.recordSession(null, account.index, ctx.model, ctx.advisorModel, ctx.decision, ctx.hold);'],
  ['recordSession     arg accountIndex', RECORD,
    'accountManager.recordSession(ctx.sessionId, accountManager.currentIndex, ctx.model, ctx.advisorModel, ctx.decision, ctx.hold);'],
  ['recordSession     arg model', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, null, ctx.advisorModel, ctx.decision, ctx.hold);'],
  // THESE TWO COLLAPSE, and it is legitimate. `_requestBuckets` pins the advisor
  // family only when `advisorModel && decision?.advisorServed` — a conjunction —
  // so nulling either conjunct removes the same bucket. Exercised rather than
  // reasoned, across all three states the conjunction can be in:
  //
  //   advisorServed true    unmutated ["unified7d","unified7dFable"]
  //                         arg advisorModel -> null ["unified7d"]
  //                         arg decision     -> null ["unified7d"]
  //   advisorServed false   all three ["unified7d"]
  //   no advisor at all     all three ["unified7d"]
  //
  // Identical in every case, so the suite cannot tell them apart because there
  // is nothing to tell apart: one intervention, two spellings.
  //
  // The tripwire: they must separate if the advisor family is ever pinned on a
  // path that does not consult `decision.advisorServed` — that would make the
  // conjunction two independent conditions. If that lands and these still
  // collapse, the new path is untested.
  ['recordSession     arg advisorModel', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, null, ctx.decision, ctx.hold);'],
  // Explicitly null rather than truncating the list: dropping `decision` off the
  // end would slide `ctx.hold` into its place and mutate two arguments at once.
  ['recordSession     arg decision', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, null, ctx.hold);'],
  // The hold itself. Without it the pins this request spends are never claimed,
  // so a live stream stops holding its account the moment the pin ages out.
  ['recordSession     arg hold', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);'],

  ['confirmRouted     call deleted', CONFIRM, ''],
  ['confirmRouted     arg sessionId', CONFIRM,
    'accountManager.confirmRouted(null, account.index, ctx.model, ctx.advisorModel, ctx.decision);'],
  ['confirmRouted     arg accountIndex', CONFIRM,
    'accountManager.confirmRouted(ctx.sessionId, accountManager.currentIndex, ctx.model, ctx.advisorModel, ctx.decision);'],
  ['confirmRouted     arg model', CONFIRM,
    'accountManager.confirmRouted(ctx.sessionId, account.index, null, ctx.advisorModel, ctx.decision);'],
  ['confirmRouted     arg advisorModel', CONFIRM,
    'accountManager.confirmRouted(ctx.sessionId, account.index, ctx.model, null, ctx.decision);'],
  ['confirmRouted     arg decision', CONFIRM,
    'accountManager.confirmRouted(ctx.sessionId, account.index, ctx.model, ctx.advisorModel);'],
  ['confirmRouted     moved before the retry branches', CONFIRM, ''], // paired with the insert below

  // The WHOLE statement, including `ctx.hold =`. Anchoring on the call alone
  // left `ctx.hold = ;` behind, so the row measured that a syntax error breaks
  // the suite rather than that the call matters: it died on 32 entries, every
  // one a file that failed to parse, and not one a named test. A row can be
  // green-looking, applied, and still be testing the language rather than the
  // code.
  // THESE TWO COLLAPSE, and the group is new because re-anchoring both rows onto
  // the whole statement is what made them comparable. `beginSession` short
  // circuits on a falsy id — `sessionId ? beginRequest(sessionId) : null` — so
  // passing null never reaches the tracker and is observably identical to not
  // calling it at all. Exercised rather than reasoned:
  //
  //   unmutated              tracked=true  inFlight=1  hold={rid:1,...}
  //   arg sessionId -> null  tracked=false             hold=null
  //   call deleted           tracked=false             hold=undefined
  //
  // `null` against `undefined` is a difference in the local only: both are
  // falsy, and `recordSession` and `endSession` both default the parameter and
  // guard on truthiness. One intervention, two spellings.
  //
  // The tripwire: they must separate if `beginSession` ever does work BEFORE its
  // falsy check — a log line, a counter, anything observable — because then not
  // calling it and calling it with null stop being the same act.
  ['beginSession      call deleted', BEGIN_SESSION, ''],
  ['beginSession      arg sessionId', BEGIN_SESSION,
    '      ctx.hold = accountManager.beginSession(null);\n'],
  ['endSession        call deleted', 'accountManager.endSession(sessionId, ctx.hold);', ''],
  ['endSession        arg sessionId', 'accountManager.endSession(sessionId, ctx.hold);', 'accountManager.endSession(null, ctx.hold);'],
  // This row used to DELETE the call rather than move it, which made it a
  // duplicate of "call deleted" — the two died on the identical three tests and
  // the matrix reported 23 mutations while testing 22. The placement claim is
  // that the release survives a request that THROWS, so the mutation has to be
  // the move that breaks exactly that: out of the finally, into the try, where
  // the happy path still releases and the error path never does.
  ['endSession        moved out of the finally into the try', END_IN_FINALLY, ''], // paired with the insert below

  // Per-session token accounting. Two call sites, because the streaming path
  // merges its two usage reports and writes once at the end of the stream
  // while the buffered path has one report to begin with. The two
  // `Object.assign` rows are the field routing into that merge: they are not
  // accountManager calls, but they are the mechanism the call site depends on,
  // and a merge that drops an event records confident wrong numbers.
  ['recordTokenUsage  stream call deleted', REC_STREAM, ''],
  ['recordTokenUsage  stream arg accountIndex', REC_STREAM,
    '      accountManager.recordTokenUsage(accountManager.currentIndex, sessionId, model, merged);'],
  ['recordTokenUsage  stream arg sessionId', REC_STREAM,
    '      accountManager.recordTokenUsage(accountIndex, null, model, merged);'],
  ['recordTokenUsage  stream arg model', REC_STREAM,
    '      accountManager.recordTokenUsage(accountIndex, sessionId, null, merged);'],
  ['recordTokenUsage  stream arg usage', REC_STREAM,
    '      accountManager.recordTokenUsage(accountIndex, sessionId, model, {});'],

  ['recordTokenUsage  body call deleted', REC_BODY, ''],
  ['recordTokenUsage  body arg accountIndex', REC_BODY,
    '      accountManager.recordTokenUsage(accountManager.currentIndex, sessionId, model, json.usage);'],
  ['recordTokenUsage  body arg sessionId', REC_BODY,
    '      accountManager.recordTokenUsage(accountIndex, null, model, json.usage);'],
  ['recordTokenUsage  body arg model', REC_BODY,
    '      accountManager.recordTokenUsage(accountIndex, sessionId, null, json.usage);'],
  ['recordTokenUsage  body arg usage', REC_BODY,
    '      accountManager.recordTokenUsage(accountIndex, sessionId, model, {});'],

  // The band decision's WIRING, not its arithmetic. A row mutating `decideBand`
  // dies against the decision's own unit tables and says nothing about whether
  // anything calls it; these sever the call site instead, which is the failure
  // that ships green.
  ['bandDecision      call site ignores the decision', BAND_APPLY,
    '    const decision = decideBand(this._bandSnapshot(candidates, model, now, route));\n'
    + '    void decision;\n    return candidates;\n', 'src/account-manager.js'],
  ['bandDecision      snapshot ignores the clock', BAND_APPLY,
    '    const decision = decideBand(this._bandSnapshot(candidates, model, 0, route));\n',
    'src/account-manager.js'],
  // The capacity rule never runs and every fleet degrades to the ratio. This is
  // the fallback path made universal, so it is exactly what a build that
  // silently lost the five-hour signal would do.
  ['bandDecision      capacity rule never runs', SIZED_BRANCH,
    '  const sizing = { kind: \'fallback\', reason: \'no-capacity-signal\' };\n',
    'src/band-decision.js'],
  // Absence closes the band again, on whichever axis is severed. Two rows, not
  // one, because the exemption reads two measurements and a version covering
  // only headroom shipped once and was reported as complete.
  ['bandDecision      absent headroom stops widening', UNMEASURED_BOTH,
    '    const unmeasured = entry.pressure.kind === \'absent\';\n', 'src/band-decision.js'],
  ['bandDecision      absent pressure stops widening', UNMEASURED_BOTH,
    '    const unmeasured = entry.headroom.kind === \'absent\';\n', 'src/band-decision.js'],
  // The coverage stop never fires, so the band admits the whole tier every
  // time. Sizing stops being a size and the widening is unbounded.
  ['bandDecision      coverage never stops admission', COVERAGE_STOP,
    '    if (false) {\n', 'src/band-decision.js'],
  // The session-reset switch, a writer of `current` that selection never sees.
  // Severing either half restores the reset-timestamp proxy: one stops it
  // preferring the better candidate, the other lets it leave a strictly better
  // incumbent behind.
  ['bandDecision      session-reset leaves a better incumbent', RESET_RANK_GUARD, '',
    'src/account-manager.js'],
  ['bandDecision      session-reset ignores pressure order', RESET_RANK_ORDER,
    '      if (false\n', 'src/account-manager.js'],

  // Per-pin in-flight accounting. The claim, the read, and BOTH release paths:
  // an unpaired release does not merely lose an integer here, it leaves a pin
  // counted as loaded for the life of the record, so each release path gets its
  // own row rather than trusting the other to cover it.
  // THESE TWO COLLAPSE, and it is intended. One breaks the write side of the
  // hold and the other the read side, and the suite cannot tell them apart
  // because the read is the claim's only consumer: with nothing else looking at
  // `pinHolds`, never writing it and never reading it are the same observable.
  // Answered here rather than left for the flag to raise every run.
  //
  // The tripwire: this stops being true the moment `pinHolds` gains a second
  // consumer — a status field, a migration policy, anything. At that point the
  // two rows should separate on their own, and if they do not, the new consumer
  // is not covered.
  ['loadFor           in-flight pin never claimed', HOLD_CLAIM,
    '        if (false) {\n', 'src/session-tracker.js'],
  ['loadFor           held pin not counted as live', PIN_HELD,
    '    return now - pin.at <= this.activeTtlMs;\n', 'src/session-tracker.js'],
  ['loadFor           hold never released', HOLD_RELEASE, '', 'src/session-tracker.js'],
  ['loadFor           lost hold never drained', HOLD_DRAIN, '', 'src/session-tracker.js'],
  // Hold OWNERSHIP. A record can be evicted while its request is in flight, so
  // a hold outlives the record that issued it; without this a stale release
  // drains a live replacement.
  ['loadFor           stale hold ends a stranger\'s request', HOLD_OWNER_END, '',
    'src/session-tracker.js'],
  // NO ROW for the same test inside `_releaseHold`, and SINCE THIS CYCLE none
  // for it at the claim boundary either. Both are equivalent mutants by one
  // argument: `s.holds` has exactly one insertion site, `beginRequest`, which
  // stamps the record's own rid, so membership in that set already implies
  // ownership. The release side was always so; the claim side became so when
  // the released-hold test was added beside it, and the seam is what noticed —
  // the row went from dying to SURVIVES on the first run after that change,
  // which is the intended way to learn that a row has stopped measuring.
  // Registered in RESIDUALS as TC-005, with the tripwire that restores both: a
  // SECOND insertion site into any record's `holds`. Both guards stay in
  // source; they are preconditions, not dead code.
  //
  // AND THE IMPLICATION IS NOW BOUND rather than argued. "Membership implies
  // the rid" was the whole case for withdrawing those rows, and nothing tested
  // it — "cannot break today" and "we would notice if it did" are different
  // claims. `every outstanding hold carries the rid of the record holding it`
  // in test/session-tracker.test.js asserts it directly, and the row below severs
  // the stamp that makes it true, so the property has a killer of its own.
  // Both halves ported from the S4b slice at a6f67b7, which reached the same
  // pairing from the other direction.
  ['loadFor           beginRequest stamps a constant rid', RID_STAMP,
    '    const hold = { rid: 1, buckets: new Set() };\n', 'src/session-tracker.js'],
  // The released-hold test, which is a SEPARATE condition on the same line: a
  // hold whose release already ran can claim a bucket again, and no release
  // will ever follow, so the pin reads as held for the life of the record. The
  // claim boundary is guarded and the release boundary deliberately is not
  // (TC-025 — guarding it loses lost-hold recovery), which is exactly why this
  // end needs a row of its own rather than sharing the ownership one's.
  ['loadFor           released hold claims again', HOLD_CLAIM,
    '        if (hold && hold.rid === s.rid && !hold.buckets.has(bucket)) {\n',
    'src/session-tracker.js'],
  // The five-hour level is never read, so no account ever has measurable
  // capacity and cold start becomes permanent.
  ['bandDecision      five-hour never read', FIVE_HOUR_READ,
    '          fiveHour: null,\n', 'src/account-manager.js'],

  // The load weight's wiring. The first severs the call site; the second makes
  // the fleet permanently unmeasured, which is the cold-start state made
  // universal and is what a build that silently lost the token read would do.
  ['pickDecision      call site ignores the decision', PICK_APPLY,
    '    const decision = decidePick(this._pickSnapshot(candidates, model, now));\n'
    + '    void decision;\n    return candidates[0] || null;\n', 'src/account-manager.js'],
  ['pickDecision      load never measured', PICK_LOAD, '          load: 0,\n',
    'src/account-manager.js'],
  // The arrival signal itself. Without it, a lost token read is
  // indistinguishable from a fleet that never recorded one, and the weight
  // reverts to counting sessions with every gate still green.
  ['pickDecision      arrival signal never read', PICK_OBSERVED, '          observed: 0,\n',
    'src/account-manager.js'],
  // The expiry-pressure tiebreak. Four rows, because it reaches selection by
  // four separable steps and severing any one of them silently restores the
  // reset-timestamp proxy: the snapshot field, the term that ranks it, the
  // distribute-off loop that ranks it separately, and the off switch that has
  // to make it inert rather than merely small.
  ['pickDecision      pressure never reaches the snapshot', PICK_PRESSURE,
    '          pressure: { kind: \'absent\', reason: \'expiry-routing-off\' },\n',
    'src/account-manager.js'],
  ['pickDecision      pressure term never ranks', PICK_PRESSURE_TERM, '',
    'src/pick-decision.js'],
  ['pickDecision      distribute-off ignores pressure', BEST_PRESSURE, '',
    'src/account-manager.js'],
  // The off switch stops being off: the disabled path starts consulting a
  // pressure the operator asked it not to, which is the flag-off equivalence
  // claim broken from the inside.
  ['pickDecision      disabled path consults pressure anyway', PRESSURE_OFF, '',
    'src/account-manager.js'],
  // The weekly gate. THESE TWO COLLAPSE, and NOT because they are one
  // intervention — that reading was checked and is wrong. Run over all 147
  // combinations of {null,0,0.2,0.9,0.98,1.0,1.2} across the three bucket keys,
  // the two mutants agree on 135 and DIFFER on 12:
  //
  //   family absent, shared 0.9   max-never-taken -> 0.9   shared-never-read -> null
  //
  // They are different functions. What makes them indistinguishable is that the
  // only inputs separating them are the ones `if (own == null) return shared`
  // handles, and NO CALLER CAN PRODUCE THEM: the manager resolves the key
  // through `_windowForBucket`, which collapses an absent family bucket to
  // `unified7d` and takes the early return; the status renderer and the TUI tag
  // each ask only about a family they have already seen reported. So the branch
  // that distinguishes them is unreachable, and the collapse is that
  // unreachability rather than a shared identity.
  //
  // Which makes this the seam-table evidence for keeping that branch TOTAL: it
  // is the only thing separating these two mutants, and a function whose
  // correctness rests on inputs its callers happen not to produce is correct by
  // coincidence.
  //
  // The tripwire, and it is the same condition: they SEPARATE the moment any
  // caller can pass an absent family bucket under a non-shared key. If a fourth
  // caller appears and these rows still collapse, that caller is not covered.
  ['weeklyGate        maximum never taken', GATE_MAX,
    "  return { value: own, bucket: bucketKey };\n", 'src/model.js'],
  ['weeklyGate        shared bucket never read', GATE_SHARED_READ,
    '  const shared = null;\n', 'src/model.js'],
  // Per-bucket load attribution. Restoring the session-level sum charges every
  // account a split session touches with the session's whole context.
  ['loadFor           split session pooled across accounts', LOAD_BUCKET,
    '        const t = [...(s.tokens?.values() || [])].reduce((acc, x) =>\n'
    + '          ({ context: acc.context + x.context, reports: acc.reports + x.reports }),\n'
    + '          { context: 0, reports: 0 });\n',
    'src/session-tracker.js'],

  ['recordTokenUsage  merge drops message_start', MERGE_START, ''],
  ['recordTokenUsage  merge drops message_delta', MERGE_DELTA, ''],
  // Which report wins. The delta's figures are cumulative for the message, so
  // filling only the fields message_start did not set keeps the placeholder
  // output and, on a multi-inference turn, the first inference's input.
  ['recordTokenUsage  merge start supersedes delta', MERGE_DELTA,
    '      for (const [k, v] of Object.entries(data.usage)) if (!(k in merged)) merged[k] = v;'],
  // Writing an empty merge records an all-zero report, whose `reports: 1` says
  // an observation arrived for a stream that never carried one.
  ['recordTokenUsage  empty-merge guard removed', GUARDED_WRITE,
    `    ${REC_STREAM.trim()}\n`],

  // The control. Its replacement is identical to what it finds, so the file is
  // rewritten byte-for-byte and the suite runs against unmodified source: a
  // truthful table must call this SURVIVES. It fails when the table has started
  // reporting failures it did not cause — which is what an already-red suite
  // does to every row at once, and what this table did before the baseline
  // check below existed.
  //
  // It is a committed fixture rather than something reached for when the table
  // is doubted. A control that only exists in the sandbox where somebody went
  // looking is the same class of gap as the one it closes: it certifies the
  // harness on the run nobody was worried about, and is absent on every run
  // somebody trusted.
  //
  // LAST on purpose. It is the only row whose expected verdict is SURVIVES, so
  // it is the only one that can show a restore which silently failed earlier in
  // the run: against a tree still carrying somebody else's mutation, an edit
  // that changes nothing would start dying. Placed first it would be graded
  // before there was anything to detect.
  [`${CONTROL}        identity rewrite, mutates nothing`,
    'export class SessionTracker', 'export class SessionTracker', 'src/session-tracker.js'],
  // The second control, and the other half of the pair. NOOP proves the table
  // can still emit SURVIVES; this proves it can still emit INVALID — that a
  // mutation which does not parse is refused rather than graded on the resulting
  // wall of import failures. Both are the only rows whose verdict is known
  // before the run, so they are the only rows that say anything about the
  // harness rather than about the code.
  [`${CONTROL}        unparseable, must be refused not graded`,
    'export class SessionTracker', 'export class SessionTracker {{{', 'src/session-tracker.js'],
];

// What each control must grade as. A control that grades anything else means the
// harness has lost the ability to produce that verdict, which no ordinary row
// can reveal: rows are graded by what the code does, controls by what the table
// can still say.
const CONTROL_EXPECTATIONS = [
  { match: 'identity rewrite', expect: 'SURVIVES' },
  { match: 'unparseable', expect: 'INVALID' },
];

const wanted = args.filter(a => !a.startsWith('--') );
// One cached original per touched file. Read once so a row cannot restore
// a file from a copy some earlier row had already mutated.
const originals = new Map();
const readOriginal = (file) => {
  if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
  return originals.get(file);
};
// Does the file parse? `node --check` on the same interpreter that will run the
// suite, so the grammar asked about is the grammar that would execute. The
// package is `"type": "module"`, and --check parses `.js` under it as ESM.
//
// Returns null when it parses, or the reason when it does not. The reason is
// carried rather than discarded because INVALID FAILS THE RUN: a stop sign that
// does not say why forces the next reader to re-derive what this already
// computed and threw away, which is the same waste as the fail-sets truncated to
// three before --full-fails existed.
//
// SCOPE, and its tripwire. This checks the MUTATED TARGET only. A replacement
// that leaves the target parseable while breaking what another module imports
// from it would not be caught here, and would grade DIES on the resulting import
// failures. Not reachable with the current rows — every replacement is a
// same-shape substitution, an argument or a statement swapped for one of the
// same kind. **It goes live the moment a row is added whose replacement is not
// that**, and closing it then needs an IMPORT SMOKE TEST rather than a wider
// `node --check`, because the residual class is a file that parses and fails on
// import. Do not reach for a bigger parse check and conclude it cannot be done.
//
// Half-detected today, and both halves are worth knowing: such a row would die
// on file-level markers with no named test, so the file-only section below WOULD
// surface it — except in the variant where one named test survives among the
// failures the display hides, which is exactly how the `beginSession` row
// escaped. Partially detected with a known hole, not undetected.
function syntaxCheck(file) {
  try {
    execFileSync(NODE, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (err) {
    const out = (err.stderr || '').toString();
    const named = /^\w*(?:Syntax|Reference|Type)Error: .*$/m.exec(out);
    return (named ? named[0] : out.split('\n').find(l => l.trim()) || 'did not parse').trim();
  }
}

// One suite run, returning the failing test names and whether it terminated.
// Shared by the baseline below and every mutated row, so the two cannot come to
// differ about what "failing" means.
function runSuite() {
  // Output goes to a FILE, not a pipe buffer. Some mutations make the suite
  // enormously chatty, and against a 64 MiB in-memory buffer whether the run
  // finished before it filled was a race: measured over three repetitions of
  // one row, the same mutation on the same tree gave ENOBUFS at 98s / 65 MB
  // with no failure markers, a clean finish at 12s naming 12 failing tests, and
  // ENOBUFS again at 107s. The verdict was a coin flip between DIES and a
  // 65 MB head containing no `✖` at all, which without the ENOBUFS rule below
  // would have read SURVIVES. A file has no such limit, so the row now reports
  // what it actually did.
  const logPath = path.join(os.tmpdir(), `seam-run-${process.pid}-${runSeq++}.log`);
  const fd = fs.openSync(logPath, 'w');
  let timedOut = false;
  try {
    // THE PROJECT'S OWN TEST COMMAND, read from package.json rather than
    // reimplemented. A hardcoded `node --test` is a second definition of "the
    // suite passed" that agrees with the first until it does not: the project
    // runs `--test-timeout=120000`, the harness ran no per-test timeout at all,
    // and a 130-second test would pass this baseline and fail CI. A copy of the
    // command is the same defect one release later, so the script is the source.
    //
    // `node` in that script must resolve to the interpreter running this
    // harness, not whatever is first on PATH, so the table is measured on the
    // developer's runtime. Prepending its directory keeps both properties:
    // the project's exact command, this process's runtime.
    execFileSync('/bin/sh', ['-c', TEST_COMMAND], {
      cwd: REPO,
      stdio: ['ignore', fd, fd],
      timeout: PROCESS_TIMEOUT_MS,
      env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH || ''}` },
    });
  } catch (err) {
    // A suite that never terminates is not a passing suite. Some mutations
    // (dropping the per-request exclusion set) make retry loops unbounded, so
    // the run has to be killed rather than reporting. ENOBUFS is kept although
    // writing to a file cannot raise it: it costs nothing and it is the guard
    // that stood between the chattiest row and a false green.
    timedOut = err.killed || err.signal != null || err.code === 'ENOBUFS';
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.readFileSync(logPath, 'utf8');
  fs.unlinkSync(logPath);
  return {
    fails: [...new Set([...out.matchAll(/^✖ (.+?) \(/gm)].map(m => m[1]))],
    timedOut,
    // DID THE OBSERVATION HAPPEN AT ALL. A run that exits before the reporter
    // writes its summary produces no ✖ markers, and "no failures found" is
    // indistinguishable from "nothing was looked at" in the same way an
    // already-red suite was indistinguishable from a caught mutation. Measured:
    // a row that DIES reliably when run alone read SURVIVES inside a full table
    // on a loaded box.
    //
    // Graded INDETERMINATE and never CAUGHT. Treating a missing summary as a
    // catch is the mirror error and it hides real survivors, because a process
    // that dies for a reason unrelated to the mutation also writes no summary.
    completed: /^\S* ?tests \d+/m.test(out),
  };
}

// THE BASELINE. Every verdict below is "did the suite fail after I mutated",
// which only means "did the mutation break it" if the suite passed BEFORE. With
// a test already red, every row reads DIES on that one failure and the table
// reports total coverage of code nothing tests: measured in a sandbox with one
// injected failure, an identity rewrite that mutates nothing read DIES and the
// run exited 0.
//
// WHAT THIS COVERS, and the residual, stated narrowly because the first version
// of this comment was too pessimistic about its own guard. It closes the
// already-red door outright, AND the subset of flakes that happen to land in
// this baseline run — which is not hypothetical: on its second day it caught a
// load-sensitive CLI test that had passed 859/859 minutes earlier and passes 8
// of 8 in isolation, and refused to grade rather than crediting that one failure
// to all 59 rows.
//
// The residual is the other subset: a test that stays green HERE and fails
// inside some row's run is credited to that row, and the subtraction below
// cannot catch it because the name was never in the baseline set. So one green
// baseline does not establish that the suite is RELIABLY green; it establishes
// that it was green once, just now, which is strictly more than nothing and
// strictly less than reliability.
const baseline = runSuite();
if (baseline.timedOut || !baseline.completed) {
  console.error('baseline suite did not run to completion, so no verdict below would mean anything');
  process.exit(2);
}
if (baseline.fails.length) {
  console.error(`baseline suite is not green: ${baseline.fails.length} test(s) fail before any mutation.`);
  for (const f of baseline.fails) console.error(`  ✖ ${f}`);
  console.error('\nEvery row would read DIES on these. Fix or skip them, then re-run.');
  process.exit(2);
}

const rows = [];

for (const [label, find, replace, relativeFile] of M) {
  if (wanted.length && !wanted.some(w => label.startsWith(w))) continue;
  const target = relativeFile ? `${REPO}/${relativeFile}` : FILE;
  if (!fs.existsSync(target)) {
    rows.push([label, 'ANCHOR MISSING', []]);
    continue;
  }
  const original = readOriginal(target);
  if (!original.includes(find)) { rows.push([label, 'ANCHOR MISSING', []]); continue; }
  let mutated = original.replace(find, replace);
  // The "moved earlier" variant: delete the confirm at its real site and put it
  // right after selection, where a retried attempt would confirm too.
  if (label.endsWith('moved before the retry branches')) {
    mutated = mutated.replace(
      'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision, ctx.hold);',
      'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision, ctx.hold);\n  ' + CONFIRM);
  }
  // The endSession move: deleted from the finally above, re-inserted inside the
  // try. The happy path still releases the hold, so only a test that drives a
  // request THROUGH a throw can tell the difference.
  if (label.endsWith('moved out of the finally into the try')) {
    mutated = mutated.replace(FORWARD_AWAIT, FORWARD_AWAIT + END_IN_FINALLY);
  }
  fs.writeFileSync(target, mutated);
  let run;
  let syntaxError = null;
  try {
    // A MUTATION THAT DOES NOT PARSE HAS NOT BEEN TESTED. It is neither caught
    // nor survived: every file importing the broken module fails to load, the
    // suite reports a wall of failures, and the row grades DIES on the fact that
    // JavaScript has a grammar. Measured on the `beginSession call deleted` row
    // before it was re-anchored: 32 entries, every one an unparseable file and
    // not one a named test, and the harness exited 0.
    //
    // CHECKED, NOT INFERRED FROM THE OUTPUT. The alternative was to classify by
    // whether the failures look file-level, and this file already carries a
    // section that does a version of that — which missed exactly this row,
    // because it fires only when NO named test failed and one had survived among
    // the 29 the display hid. That is a heuristic over output with a known
    // counterexample. `node --check` is a decision about the bytes: deterministic,
    // no counting, and it makes the class impossible rather than detectable.
    // It also costs milliseconds and runs BEFORE the suite, so a broken row stops
    // in a tenth of a second instead of after a full run.
    syntaxError = syntaxCheck(target);
    run = syntaxError ? null : runSuite();
  } finally {
    fs.writeFileSync(target, original);
  }
  if (syntaxError) {
    rows.push([label, 'INVALID', [syntaxError]]);
    continue;
  }
  // Anything already failing at the baseline is not this row's doing. The
  // baseline is empty by the check above, so this subtraction is belt to that
  // brace: it keeps the invariant local to where a verdict is formed, where a
  // later edit that softens the abort into a warning would otherwise start
  // crediting rows with failures they did not cause.
  const inBaseline = new Set(baseline.fails);
  const fails = run.fails.filter(f => !inBaseline.has(f));
  const verdict = run.timedOut ? 'RUNS AWAY'
    : (!run.completed ? 'INDETERMINATE' : (fails.length ? 'DIES' : 'SURVIVES'));
  rows.push([label, verdict, fails]);
}

for (const [label, verdict, fails] of rows) {
  console.log(`${verdict.padEnd(14)} ${label}`);
  // Truncated for reading, in full with --full-fails. The truncation is display
  // only: the collapse analysis below fingerprints the WHOLE set, so two rows
  // can group on entries this never printed, and a reader comparing the visible
  // lines is comparing a different thing from the grouping.
  const shown = fullFails ? fails : fails.slice(0, 3);
  for (const f of shown) console.log(`               ↳ ${f}`);
  if (!fullFails && fails.length > 3) console.log(`               ↳ ...and ${fails.length - 3} more (--full-fails)`);
}
// Controls are graded against their KNOWN expected verdict, mutations against
// whether they died. Kept apart in the arithmetic as well as in the check: a
// control counted as a mutation would either inflate the denominator with a row
// that is meant to survive, or be read as a survivor and fail the run.
const controls = rows.filter(r => r[0].startsWith(CONTROL));
const mutations = rows.filter(r => !r[0].startsWith(CONTROL));
const survived = mutations.filter(r => r[1] === 'SURVIVES');
const unanchored = rows.filter(r => r[1] === 'ANCHOR MISSING');
// One clause per verdict, because a single ratio elides them. `54/54 mutations
// die` was printed over a run that was 53 DIES and one RUNS AWAY: true as
// phrased, and the phrasing was doing the work. A reader cannot debug a verdict
// computed from four triggers and printed as one word.
const tally = new Map();
for (const [, verdict] of mutations) tally.set(verdict, (tally.get(verdict) || 0) + 1);
const ungraded = mutations.filter(r => r[1] === 'ANCHOR MISSING' || r[1] === 'INDETERMINATE' || r[1] === 'INVALID');
const parts = [];
const order = ['DIES', 'SURVIVES', 'RUNS AWAY', 'INVALID', 'INDETERMINATE', 'ANCHOR MISSING'];
const words = {
  DIES: 'die', SURVIVES: 'SURVIVE', 'RUNS AWAY': 'runs away',
  INVALID: 'DID NOT PARSE', INDETERMINATE: 'graded nothing', 'ANCHOR MISSING': 'never applied',
};
for (const v of order) if (tally.get(v)) parts.push(`${tally.get(v)} ${words[v]}`);
// Factual, not a verdict. An earlier version printed "N controls as expected"
// unconditionally, so a run where a control graded WRONG announced them as
// expected one line above the error saying they were not — the summary
// asserting the very thing the check below exists to decide.
if (controls.length) parts.push(`controls: ${controls.map(r => r[1]).join(', ')}`);
console.log(`\n${parts.join(', ')}   (${mutations.length - ungraded.length} of `
  + `${mutations.length} mutations reached a verdict)`);

// Control verdicts are the only values in this table known independently of the
// run, so they are the only checks that still work when the checking logic is
// wrong. Each is graded against its OWN expectation: the identity rewrite must
// survive (or the table is attributing failures to a mutation that changed
// nothing), and the unparseable one must be refused (or the table has gone back
// to grading syntax errors as caught mutations).
const badControls = [];
for (const row of controls) {
  const rule = CONTROL_EXPECTATIONS.find(r => row[0].includes(r.match));
  if (!rule) { badControls.push([row[0], row[1], row[2], 'no expectation registered']); continue; }
  if (row[1] !== rule.expect) badControls.push([row[0], row[1], row[2], `expected ${rule.expect}`]);
}
if (badControls.length) {
  console.error(`\n${badControls.length} control row(s) graded wrong. Controls check what this table can`
    + ' still SAY, not what the code does, so every verdict above is suspect:');
  for (const [label, verdict, fails, why] of badControls) {
    console.error(`  - ${label}: got ${verdict}, ${why}`);
    for (const f of (fails || []).slice(0, 3)) console.error(`      ↳ ${f}`);
  }
  process.exit(2);
}
reportIndistinguishableRows(mutations);

// A mutation whose anchor no longer matches measured NOTHING, and it degrades
// exactly when the code moves — which is when this table is most worth running.
// Left as a quiet row beside a healthy count it reads as success, so it exits
// non-zero and says which ones lost their anchor.
if (unanchored.length) {
  console.error(`\n${unanchored.length} mutation(s) could not be applied — their anchor text is gone from`
    + ' their target file. These measured nothing; the count above does not cover them:');
  for (const [label] of unanchored) console.error(`  - ${label}`);
  console.error('\nRe-anchor each against the current source before trusting this table.');
  process.exit(1);
}
// A row whose run never finished graded nothing. It is not a survivor and not a
// catch; it has to be run again, so it exits non-zero and says so rather than
// being averaged into the count above.
// A mutation that did not parse was never tested. Not caught, not survived:
// ungraded, and the run says so rather than counting it.
const invalid = mutations.filter(r => r[1] === 'INVALID');
if (invalid.length) {
  console.error(`\n${invalid.length} row(s) produced source that does not parse, so they were NEVER RUN.`
    + ' A syntax error is not a caught mutation; re-anchor them against the current source:');
  for (const [label, , why] of invalid) {
    console.error(`  - ${label}`);
    if (why?.[0]) console.error(`      ${why[0]}`);
  }
  process.exit(1);
}
const indeterminate = mutations.filter(r => r[1] === 'INDETERMINATE');
if (indeterminate.length) {
  console.error(`\n${indeterminate.length} row(s) did not run to completion and were graded NOTHING.`
    + ' Re-run them; a verdict was not reached:');
  for (const [label] of indeterminate) console.error(`  - ${label}`);
  process.exit(1);
}
if (survived.length) process.exit(1);

/**
 * Rows the suite cannot tell apart: two mutations that die on exactly the same
 * set of test names are, as far as this table can see, the same intervention.
 *
 * This is the only check here aimed at the TABLE rather than the apparatus.
 * Every other guard — anchor matched, file present, run completed, output not
 * truncated — asks whether the machinery worked. All of them can pass while a
 * row quietly tests something other than what its label says, and then the
 * table over-reports its own coverage with nothing visibly wrong. That is not
 * hypothetical: a row labelled "endSession moved out of the finally" carried an
 * edit that simply DELETED the call, making it a copy of the row above it. It
 * applied cleanly, ran cleanly and died — so it read as coverage of a property
 * nothing was testing, across many runs, until someone compared the columns.
 *
 * Flagged, never failed: collapsing is often correct. `endSession(null)` returns
 * early, so dropping the argument and dropping the call ARE one edit, and the
 * table tests both deliberately. The question "are these meant to be the same?"
 * has to be answered by a person, which is why this prints and exits 0.
 */
// Node reports a FILE as failing alongside the tests inside it, so `✖` matches
// both `a session whose buckets collapse ...` and `test/rollover-collapse.test.js`.
// The file-level line carries nothing the test-level lines do not — if a test in
// a file fails, the file fails — and it is NOT emitted reliably: measured across
// two runs of the same pair on the same tree, the marker attached to
// `recordSession arg advisorModel` in one and to `arg decision` in the other,
// which split a genuine duplicate pair in one run and grouped it in the next.
// A fingerprint containing it is unstable, so the grouping was too.
//
// Dropped from the FINGERPRINT only, never from the verdict: a mutation that
// makes a file fail to load produces the file line and no test lines, and
// removing it there would turn a caught mutation into SURVIVES.
function isFileMarker(f) { return /\.(test|spec)\.[cm]?js$/.test(f.trim()); }

function reportIndistinguishableRows(all) {
  const groups = new Map();
  const fileOnly = [];
  for (const [label, verdict, fails] of all) {
    // Only a row that died has a meaningful set. A survivor's set is empty by
    // definition, and a runaway's is whatever was captured before it was killed.
    if (verdict !== 'DIES' || !fails.length) continue;
    const named = fails.filter(f => !isFileMarker(f));
    // Died only at file level: no test name to compare, so it cannot be grouped
    // without every such row colliding with every other on an empty key.
    if (!named.length) { fileOnly.push(label); continue; }
    const key = named.sort().join('\\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(label);
  }
  if (fileOnly.length) {
    console.log('\nRows that died at FILE level with no failing test named. Not grouped, because');
    console.log('there is nothing to compare; check what the file did rather than trusting DIES:');
    for (const label of fileOnly) console.log(`  · ${label}`);
  }
  const collisions = [...groups.values()].filter(g => g.length > 1);
  if (!collisions.length) return;
  console.log('\nRows the suite cannot tell apart — each group died on exactly the same tests.');
  console.log('Fine where the interventions really are one edit; otherwise a row is not testing');
  console.log('what its label claims, and its coverage is imaginary:');
  for (const group of collisions) {
    console.log('');
    for (const label of group) console.log(`  · ${label}`);
  }
}
