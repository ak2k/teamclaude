// Real type checking for the decision layer, from its JSDoc.
//
// The JSDoc on `band-decision.js` describes tagged unions whose whole purpose
// is that absence is a variant rather than a coerced null. Comments describing
// a union do not enforce one: without a checker, `decision.keep` on a
// passthrough is a runtime `undefined` that reads as an empty band, which is
// the failure the union exists to prevent, reintroduced by the code that
// consumes it. `assertNever` catches that at runtime on the paths that execute;
// this catches it on the paths that do not.
//
// SCOPED DELIBERATELY. Only the decision layer is checked. The rest of the
// codebase has no JSDoc types, so checking it would produce thousands of
// findings nobody will read, and a gate nobody reads is a gate that is off.
// Files are listed explicitly rather than globbed for the same reason: a new
// file joins this gate by someone deciding it should, not by landing in a
// directory.
//
// The compiler lives in tools/typecheck/ with its own lockfile so the runtime
// dependency set of the shipped package is untouched. It is excluded from the
// carried patch.
//
// Usage: node tools/typecheck.mjs [--repo=<checkout>]
// Exits 0 clean, 1 on a type error, 2 when the check could not be performed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoArg = process.argv.find(a => a.startsWith('--repo='));
const REPO = path.resolve(repoArg ? repoArg.slice('--repo='.length) : '.');

// The decision layer, and nothing else.
const CHECKED = [
  'src/band-decision.js',
  'src/pick-decision.js',
];

const tsc = path.join(REPO, 'tools', 'typecheck', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.error(`no typescript at ${tsc}\n`
    + 'Install it once:  (cd tools/typecheck && npm install)');
  process.exit(2);
}

const missing = CHECKED.filter(f => !fs.existsSync(path.join(REPO, f)));
if (missing.length) {
  // A checked file that has been renamed away silently shrinks the gate to
  // nothing while still exiting 0, which is the shape every instrument in this
  // repo has failed by at least once.
  console.error(`checked file(s) missing, so this measured nothing: ${missing.join(', ')}`);
  process.exit(2);
}

const args = [
  '--noEmit',
  '--allowJs',
  '--checkJs',
  '--strict',
  '--target', 'es2022',
  '--module', 'es2022',
  '--moduleResolution', 'bundler',
  ...CHECKED.map(f => path.join(REPO, f)),
];

try {
  execFileSync(tsc, args, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
} catch (err) {
  const out = (err.stdout || '') + (err.stderr || '');
  console.error(out.trim() || err.message);
  console.error(`\ntypecheck FAILED over ${CHECKED.length} file(s)`);
  process.exit(1);
}
console.log(`typecheck clean over ${CHECKED.length} file(s): ${CHECKED.join(', ')}`);
