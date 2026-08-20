// A committed symlink must point somewhere that exists in every checkout of
// this repo. One pointing at an absolute path on the machine that committed it
// is broken everywhere else, and a relative one that climbs out of the tree is
// broken as soon as the repo is cloned to a different parent directory.
//
// This exists because a `node_modules` symlink into a scratch worktree was
// committed and no other gate could see it: the suite, the linter, the mutation
// batteries and the differential fuzz are all indifferent to it, and
// `git status` reads CLEAN precisely because the link is committed rather than
// stray. The ignore rule that should have stopped it was `node_modules/`, with
// a trailing slash, which matches a directory and not a symlink of the same
// name.
//
// TWO DELIBERATE STRICTNESSES, both of which make the verdict portable:
//
//   - ANY absolute target fails, not merely one that lands outside the repo.
//     An absolute path cannot be correct on another checkout even when it
//     happens to resolve inside this one, so "points inside the repo" would
//     pass a link that is still broken for everybody else.
//   - Resolution is LEXICAL, never filesystem. Nothing here calls stat, so the
//     answer does not depend on whether the target happens to exist on the
//     machine running the check. A gate whose verdict changes with the
//     checkout is a new instrument that lies, which is the failure this file
//     is part of a family of tools built to prevent.
//
// Usage: node tools/check-committed-symlinks.mjs [--repo=<checkout>]
// Exits 0 when every committed symlink is repo-relative and contained, 1 when
// any is not, 2 when the check could not be performed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoArg = process.argv.find(a => a.startsWith('--repo='));
const REPO = repoArg ? repoArg.slice('--repo='.length) : '.';

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

let entries;
try {
  entries = git('ls-files', '-s').split('\n').filter(Boolean);
} catch (err) {
  console.error(`could not list files in ${REPO}: ${err.message}`);
  process.exit(2);
}

// `git ls-files -s` prints: <mode> <sha> <stage>\t<path>
const links = entries
  .map(line => {
    const [meta, file] = line.split('\t');
    const [mode, sha] = meta.split(/\s+/);
    return { mode, sha, file };
  })
  .filter(e => e.mode === '120000');

const bad = [];
for (const link of links) {
  const target = git('cat-file', 'blob', link.sha).trim();
  if (path.posix.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
    bad.push({ ...link, target, why: 'absolute target: cannot be correct in another checkout' });
    continue;
  }
  // Lexical containment only. normalize() collapses `..` textually; a target
  // that climbs above the repo root still reads as `../…` afterwards.
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link.file), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    bad.push({ ...link, target, why: `escapes the repo: resolves to ${resolved}` });
  }
}

console.log(`committed symlinks: ${links.length}`);
for (const link of links) {
  const problem = bad.find(b => b.file === link.file);
  console.log(`  ${problem ? 'BAD ' : 'ok  '} ${link.file}`);
}
if (!bad.length) {
  process.exit(0);
}
console.error('\nA committed symlink does not resolve inside this repository:\n');
for (const b of bad) {
  console.error(`  ${b.file}\n    -> ${b.target}\n    ${b.why}`);
}
console.error('\nRemove it from the index (git rm --cached <path>) and make sure the ignore');
console.error('rule matches a symlink as well as a directory: `node_modules`, not');
console.error('`node_modules/`, since a trailing slash matches only the directory.');
process.exit(1);
