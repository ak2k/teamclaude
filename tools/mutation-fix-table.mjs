// Behavioural mutation table: each fix on this branch must have a test that
// FAILS when the fix is undone. Applies one mutation to the tree, runs the whole
// suite, restores, and prints which test caught it.
//
// Usage: node tools/mutation-fix-table.mjs --repo=<checkout> [--force] [name prefix ...]
//
// READ THIS BEFORE TRUSTING THE SUMMARY LINE. This is an instrument, and every
// way it has lied so far has been by reporting health while measuring nothing:
//
//   - MISSING ANCHOR. A mutation whose find-text no longer exists is not
//     applied, so it proves nothing — and this happens precisely when the code
//     has moved, which is when you most need the answer. Exits non-zero and
//     names them; never let one sit as a quiet row beside a healthy count.
//   - RUNAWAY. Some mutations do not make the suite fail, they make it never
//     finish. A run that has to be killed is a caught mutation, not a passing one.
//   - TRUNCATED OUTPUT. A runaway logs as it spins and can exceed the child's
//     stdout buffer in seconds; the captured head then contains no failure
//     markers at all and reads as a survivor. ENOBUFS is treated as a runaway
//     for that reason, and maxBuffer is raised well past a normal run's output.
//
// The shape is always the same: green because nothing was checked, not because
// nothing was wrong. That is the same failure this table exists to catch in the
// code, so hold the table to it too.
//
// The repo path is REQUIRED and has no default: this writes to src/ in the tree
// it is pointed at, and a baked-in default is a way to silently overwrite a
// checkout somebody else is reading. It refuses a dirty tree unless --force,
// because a crash between write and restore leaves the mutation behind.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const repoArg = argv.find(a => a.startsWith('--repo='));
if (!repoArg) {
  console.error('usage: tools/mutation-fix-table.mjs --repo=<checkout> [--force] [name prefix ...]');
  process.exit(2);
}
const REPO = repoArg.slice('--repo='.length);
const force = argv.includes('--force');
// Run the suite with the interpreter running this harness, so the table is
// measured on the same runtime the developer is using.
const NODE = process.execPath;

if (!fs.existsSync(`${REPO}/src/account-manager.js`)) {
  console.error(`no ${REPO}/src/account-manager.js — is --repo a teamclaude checkout?`);
  process.exit(2);
}
requireSandbox(REPO, force);

// A tree is mutable by this harness only if it carries the marker. Clean is NOT
// the same as mine: the shared checkout is usually clean, which is exactly how a
// "safe" run destroys a tree three reviewers are reading. The marker is absent
// by default and never committed, so the default is refusal for every tree
// including the one you are standing in. Opt a tree in deliberately:
//   touch <worktree>/.mutation-sandbox
function requireSandbox(repo, forced) {
  // A COMMITTED marker would mark every checkout at once and turn this guard
  // into a no-op everywhere, silently — the failure it exists to prevent,
  // wearing its own badge. It is gitignored; refuse if it is tracked anyway.
  try {
    execFileSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '.mutation-sandbox'],
      { stdio: 'ignore' });
    console.error('.mutation-sandbox is COMMITTED in this repo, which marks every checkout'
      + ' and disables this guard everywhere. Remove it from version control before running.');
    process.exit(2);
  } catch { /* not tracked, which is the only acceptable state */ }
  if (!fs.existsSync(`${repo}/.mutation-sandbox`)) {
    console.error(`${repo} is not marked as a mutation sandbox.\n\n`
      + 'This harness rewrites files in place. Run it in a worktree of your own:\n'
      + `  git worktree add --detach <path> <ref> && touch <path>/.mutation-sandbox\n\n`
      + 'Do NOT mark a checkout somebody else may be reading.');
    process.exit(2);
  }
  // The marker itself is untracked, so it must not read as somebody else's work.
  const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n').filter(l => l.trim() && !l.endsWith('.mutation-sandbox')).join('\n');
  if (dirty && !forced) {
    console.error(`${repo} has uncommitted changes — a crash between write and restore leaves`
      + ` a mutation behind, and this can only restore what it read:\n${dirty}\n`
      + 'Commit or stash them, or pass --force if you are certain.');
    process.exit(2);
  }
}

// [name, file, find, replace]
const MUTATIONS = [
  ['F1  ensureTokenFresh uses the captured index', 'src/account-manager.js',
    'const idx = this.accounts.indexOf(account);', 'const idx = accountIndex;'],
  ['F2  eviction probe vetoes on in-flight', 'src/session-tracker.js',
    'if (oldest === null) return false;\n    this.sessions.delete(oldest);\n    this.evicted += 1;\n    return true;', 'return false;'],
  ['F3  window baselines keyed by window alone', 'src/window-watcher.js',
    'if (!byAccount.has(idx)) byAccount.set(idx, reset);', 'if (!byAccount.has(idx)) { byAccount.clear(); byAccount.set(idx, reset); }'],
  ['F5a recordSession loses ctx.model/ctx.advisorModel', 'src/server.js',
    'accountManager.recordSession(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);',
    'accountManager.recordSession(ctx.sessionId, account.index, null, null, ctx.decision);'],
  ['F5b confirmRouted call deleted', 'src/server.js',
    'accountManager.confirmRouted(ctx.sessionId, account.index, ctx.model, ctx.advisorModel, ctx.decision);', ''],
  ['F5c beginSession/endSession calls deleted', 'src/server.js',
    'accountManager.beginSession(sessionId);', ''],
  ['F6  numeric route memberships not remapped', 'src/account-manager.js',
    '.map(a => (/^\\d+$/.test(a) ? remapIndexRef(a, index) : a))', '.map(a => a)'],
  ['F7  endRequest does not re-insert', 'src/session-tracker.js',
    "s.lastSeen = now;\n    this.sessions.delete(sessionId);\n    this.sessions.set(sessionId, s);\n    return s;", 's.lastSeen = now;\n    return s;'],
  ['F8  restore skips the reset domain check', 'src/account-manager.js',
    'for (const f of PERSISTED_QUOTA_FIELDS) setQuotaField(account, f, match.quota[f]);',
    'for (const f of PERSISTED_QUOTA_FIELDS) { const v = match.quota[f]; if (v != null) account.quota[f] = v; }'],
  ['F9  settle at confirm instead of at idle', 'src/account-manager.js',
    'this.sessionTracker.windowsFor(sessionId)?.noteServed(accountIndex, buckets)',
    'this.sessionTracker.windowsFor(sessionId)?.commitOn(accountIndex, buckets)'],
  ['F10 pressure falls back to the shared pair', 'src/account-manager.js',
    "    if (bucket === 'unified7d') return bucket;\n    return account.quota[bucket] == null ? 'unified7d' : bucket;",
    "    if (bucket === 'unified7d') return bucket;\n    return account.quota[`${bucket}Reset`] == null ? 'unified7d' : bucket;"],
  ['F11 _ensure refreshes an expired record', 'src/session-tracker.js',
    'if (existing && !this._isExpired(existing, now)) {', 'if (existing) {'],
  ['F12 priority left in its config form', 'src/account-manager.js',
    'priority: Number(acct.priority) || 0,', 'priority: acct.priority || 0,'],
  ['F13 expiryRouting not passed to the constructor', 'src/index.js',
    'distributeSessions: config.distributeSessions, expiryRouting: config.expiryRouting }',
    'distributeSessions: config.distributeSessions }'],
  ['F13 hot-reload setExpiryRouting deleted', 'src/index.js',
    'accountManager.setExpiryRouting(config.expiryRouting);', ''],
  ['F14 pin load ignores when the bucket was served', 'src/session-tracker.js',
    'if (now - pin.at <= this.activeTtlMs || pin.at === newest) return true;', 'return true;'],
  ['F15 owed event reported for any account', 'src/window-watcher.js',
    'return !!owed && owed.idx === idx;', 'return !!owed;'],
  ['F16 pin looked up by the advisor bucket', 'src/account-manager.js',
    'this.sessionTracker.pinnedAccount(sessionId, this._weeklyBucketFor(model))',
    'this.sessionTracker.pinnedAccount(sessionId, this._weeklyBucketFor(advisorModel || model))'],
  ['F17 route-pin guard drops the advisor arm', 'src/account-manager.js',
    '!this._pinnedAccountForModel(model, advisorModel)) {', '!this._pinnedAccountForModel(model)) {'],
  ['F18 preemption ramps even when nothing moved', 'src/account-manager.js',
    'if (next && next.index !== pinIdx) {', 'if (next) {'],
  ['F19 _ensure does not re-insert', 'src/session-tracker.js',
    'this.sessions.delete(sessionId);\n      this.sessions.set(sessionId, existing);\n      return existing;', 'return existing;'],
  ['F21 applyUsageData writes unguarded', 'src/account-manager.js',
    "      setQuotaField(account, field, reported.utilization);\n      setQuotaField(account, `${field}Reset`, reported.resetAt);",
    "      if (reported.utilization != null) q[field] = reported.utilization;\n      if (reported.resetAt != null) q[`${field}Reset`] = reported.resetAt;"],
  ['F22 anyone may settle the current-account event', 'src/account-manager.js',
    'if (decision?.viaCurrent) this._currentSeen.commitOn(accountIndex, buckets);',
    'this._currentSeen.commitOn(accountIndex, buckets);'],
  ['F23 degraded advisor still claims its family', 'src/account-manager.js',
    'if (advisorModel && decision?.advisorServed) {',
    'if (advisorModel) {'],
  ['F24 currentIndex established without a baseline', 'src/account-manager.js',
    'this.currentIndex = account.index;\n    this._currentSeen.seed(account.index, this._windowResets(account));',
    'this.currentIndex = account.index;'],
];

const wanted = argv.filter(a => !a.startsWith('--'));
const runs = MUTATIONS.filter(m => !wanted.length || wanted.some(w => m[0].startsWith(w)));
const rows = [];

for (const [name, file, find, replace] of runs) {
  const path = `${REPO}/${file}`;
  // A file that is not there is the same failure as an anchor that is not
  // there — the mutation measured nothing — and it must be reported, not
  // thrown: an exception here skips every mutation after it, which is a way to
  // end up with a short table that still looks like a clean one.
  if (!fs.existsSync(path)) {
    rows.push([name, 'ANCHOR MISSING', [`${file} does not exist in this tree`]]);
    continue;
  }
  const original = fs.readFileSync(path, 'utf8');
  if (!original.includes(find)) {
    rows.push([name, 'ANCHOR MISSING', [`anchor text is gone from ${file}`]]);
    continue;
  }
  fs.writeFileSync(path, original.replace(find, replace));
  let out = '';
  let ranAway = false;
  try {
    out = execFileSync(NODE, ['--test'], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    out = (err.stdout || '') + (err.stderr || '');
    // Killed by the timeout, or it drowned its own log before the timeout could
    // fire. Either way the suite did not finish, which is not a pass.
    ranAway = err.killed || err.signal != null || err.code === 'ENOBUFS';
  } finally {
    fs.writeFileSync(path, original);
  }
  const fails = [...new Set([...out.matchAll(/^✖ (.+?) \(/gm)].map(m => m[1]))];
  rows.push([name, ranAway ? 'RUNS AWAY' : (fails.length ? 'DIES' : 'LIVES'), fails]);
}

for (const [name, verdict, fails] of rows) {
  console.log(`${verdict.padEnd(14)} ${name}`);
  for (const f of fails.slice(0, 4)) console.log(`               ↳ ${f}`);
}
const lived = rows.filter(r => r[1] === 'LIVES');
const unanchored = rows.filter(r => r[1] === 'ANCHOR MISSING');
console.log(`\n${rows.length - lived.length - unanchored.length}/${rows.length} mutations die.`);
reportIndistinguishableRows(rows);

// A mutation that could not be applied measured NOTHING. Left as a quiet row
// beside a healthy count it reads as success, so it fails the run outright.
if (unanchored.length) {
  console.error(`\n${unanchored.length} mutation(s) could not be applied — the code they anchor on has`
    + ' moved. These measured nothing; the count above does not cover them:');
  for (const [name] of unanchored) console.error(`  - ${name}`);
  console.error('\nRe-anchor each against the current source before trusting this table.');
  process.exit(1);
}
if (lived.length) process.exit(1);

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
