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
//   - RUNAWAY. Some mutations do not make the suite fail, they make it never
//     finish (dropping the per-request exclusion set turns failover into an
//     unbounded retry loop). A run that has to be killed is a caught mutation,
//     not a passing one.
//   - TRUNCATED OUTPUT. A runaway logs as it spins and can exceed the child's
//     stdout buffer in seconds; the captured head then contains no failure
//     markers at all and reads as SURVIVES. ENOBUFS is treated as a runaway for
//     that reason, and maxBuffer is raised well past a normal run's output.
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

const args = process.argv.slice(2);
const repoArg = args.find(a => a.startsWith('--repo='));
if (!repoArg) {
  console.error('usage: tools/mutation-seam-table.mjs --repo=<checkout> [--force] [label prefix ...]');
  process.exit(2);
}
const REPO = repoArg.slice('--repo='.length);
const force = args.includes('--force');
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

const SELECT = 'accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId, ctx.decision)';
const RECORD = 'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);';
const CONFIRM = 'accountManager.confirmRouted(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);';
// Indentation included: these two anchor the endSession MOVE, and the release
// has to land inside the try rather than merely somewhere in the handler.
const END_IN_FINALLY = '        accountManager.endSession(sessionId);\n';
const FORWARD_AWAIT = '        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);\n';
const REC_STREAM = '      accountManager.recordTokenUsage(accountIndex, sessionId, model, merged);';
const REC_BODY = '      accountManager.recordTokenUsage(accountIndex, sessionId, model, json.usage);';
const MERGE_START = '      Object.assign(merged, data.message.usage);';
const MERGE_DELTA = '      Object.assign(merged, data.usage);';
const GUARDED_WRITE = '    if (Object.keys(merged).length) {\n'
  + '      accountManager.recordTokenUsage(accountIndex, sessionId, model, merged);\n'
  + '    }\n';

// [label, find, replace]
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
    'accountManager.recordSession(null, account.index, ctx.model, ctx.advisorModel, ctx.decision);'],
  ['recordSession     arg accountIndex', RECORD,
    'accountManager.recordSession(ctx.sessionId, accountManager.currentIndex, ctx.model, ctx.advisorModel, ctx.decision);'],
  ['recordSession     arg model', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, null, ctx.advisorModel, ctx.decision);'],
  ['recordSession     arg advisorModel', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, null, ctx.decision);'],
  ['recordSession     arg decision', RECORD,
    'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel);'],

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

  ['beginSession      call deleted', 'accountManager.beginSession(sessionId);', ''],
  ['beginSession      arg sessionId', 'accountManager.beginSession(sessionId);', 'accountManager.beginSession(null);'],
  ['endSession        call deleted', 'accountManager.endSession(sessionId);', ''],
  ['endSession        arg sessionId', 'accountManager.endSession(sessionId);', 'accountManager.endSession(null);'],
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
];

const wanted = args.filter(a => !a.startsWith('--') );
const original = fs.readFileSync(FILE, 'utf8');
const rows = [];

for (const [label, find, replace] of M) {
  if (wanted.length && !wanted.some(w => label.startsWith(w))) continue;
  if (!original.includes(find)) { rows.push([label, 'ANCHOR MISSING', []]); continue; }
  let mutated = original.replace(find, replace);
  // The "moved earlier" variant: delete the confirm at its real site and put it
  // right after selection, where a retried attempt would confirm too.
  if (label.endsWith('moved before the retry branches')) {
    mutated = mutated.replace(
      'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);',
      'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);\n  ' + CONFIRM);
  }
  // The endSession move: deleted from the finally above, re-inserted inside the
  // try. The happy path still releases the hold, so only a test that drives a
  // request THROUGH a throw can tell the difference.
  if (label.endsWith('moved out of the finally into the try')) {
    mutated = mutated.replace(FORWARD_AWAIT, FORWARD_AWAIT + END_IN_FINALLY);
  }
  fs.writeFileSync(FILE, mutated);
  let out = '';
  let timedOut = false;
  try {
    out = execFileSync(NODE, ['--test'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    out = (err.stdout || '') + (err.stderr || '');
    // A suite that never terminates is not a passing suite. Some mutations
    // (dropping the per-request exclusion set) make retry loops unbounded, so
    // the run has to be killed rather than reporting.
    // ENOBUFS means it drowned its own log before the timeout could fire.
    timedOut = err.killed || err.signal != null || err.code === 'ENOBUFS';
  } finally {
    fs.writeFileSync(FILE, original);
  }
  const fails = [...new Set([...out.matchAll(/^✖ (.+?) \(/gm)].map(m => m[1]))];
  const verdict = timedOut ? 'RUNS AWAY' : (fails.length ? 'DIES' : 'SURVIVES');
  rows.push([label, verdict, fails]);
}

for (const [label, verdict, fails] of rows) {
  console.log(`${verdict.padEnd(14)} ${label}`);
  for (const f of fails.slice(0, 3)) console.log(`               ↳ ${f}`);
}
const survived = rows.filter(r => r[1] === 'SURVIVES');
const unanchored = rows.filter(r => r[1] === 'ANCHOR MISSING');
console.log(`\n${rows.length - survived.length - unanchored.length}/${rows.length} mutations die.`);
reportIndistinguishableRows(rows);

// A mutation whose anchor no longer matches measured NOTHING, and it degrades
// exactly when the code moves — which is when this table is most worth running.
// Left as a quiet row beside a healthy count it reads as success, so it exits
// non-zero and says which ones lost their anchor.
if (unanchored.length) {
  console.error(`\n${unanchored.length} mutation(s) could not be applied — their anchor text is gone from`
    + ` ${FILE}. These measured nothing; the count above does not cover them:`);
  for (const [label] of unanchored) console.error(`  - ${label}`);
  console.error('\nRe-anchor each against the current source before trusting this table.');
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
function reportIndistinguishableRows(all) {
  const groups = new Map();
  for (const [label, verdict, fails] of all) {
    // Only a row that died has a meaningful set. A survivor's set is empty by
    // definition, and a runaway's is whatever was captured before it was killed.
    if (verdict !== 'DIES' || !fails.length) continue;
    const key = [...fails].sort().join(' ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(label);
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
