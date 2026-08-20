import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `docs/REVIEWING.md` describes the code, so it rots exactly like a comment —
// and it rotted within a day of being written: it said one outer catch was
// "still log-only" and prescribed a `finally` that "belongs with it", both of
// which had shipped two commits earlier, and it quoted a test count that was
// twelve short. That is invariant 9 ("an instrument's green is not a result")
// turned on the invariants file itself.
//
// This is the smallest useful mechanization: not a proof that the prose is
// right, which no test can give, but a check that its FALSIFIABLE claims still
// hold. Anchored on symbols and behaviour rather than line numbers, because the
// doc itself flags line numbers as the rot-prone part — a claim tied to `:194`
// is stale the next time anything above it grows a line.

const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(here, '..', 'docs', 'REVIEWING.md'), 'utf8');
const residuals = readFileSync(join(here, '..', 'docs', 'RESIDUALS.md'), 'utf8');
const server = readFileSync(join(here, '..', 'src', 'server.js'), 'utf8');

// Each invariant may carry an italic `*Precedent: …*` note recording the defect
// that earned it, and those notes QUOTE the wrong claims by construction — the
// whole point of invariant 15 is that a stale sentence is worth preserving as
// evidence. So a check for "the doc asserts X" has to read the prose that
// prescribes, not the history that quotes; grepping the whole file cannot tell
// "says X" from "records that X was once wrongly said", and failed on exactly
// that the first time invariant 15 was written.
const PRECEDENT = /^\s*\*Precedent:[\s\S]*?\*$/gm;
const claims = doc.replace(PRECEDENT, '');

// Stripping is only safe if it strips the history and nothing else. A greedy or
// mis-anchored pattern would swallow the live prose and turn every check below
// into a green no-op, which is invariant 9 on the instrument itself.
test('the precedent-stripper leaves the doc it is meant to check', () => {
  assert.match(claims, /Every error path answers the socket/,
    'stripping precedent notes ate live invariant text; every claim check below is now vacuous');
  assert.ok(claims.length > doc.length * 0.6,
    `stripping removed ${Math.round((1 - claims.length / doc.length) * 100)}% of the doc, which is more than its history`);
  assert.ok(claims.length < doc.length,
    'no precedent note was stripped — has the italic `*Precedent:` form changed?');
});

// The claim that rotted. Both catches answer, so the doc must not still be
// describing one of them as log-only or prescribing work that is already done.
test('REVIEWING.md does not describe an outer catch that is already fixed', () => {
  assert.ok(!/still log-only/.test(claims),
    'the doc says an outer catch is still log-only; both answer the socket');
  assert.ok(!/A `finally` that closes activity state belongs with it/.test(claims),
    'the doc prescribes a finally that has shipped');
  // The correction to that claim was itself wrong, which is precedent 15: only
  // `createProxyRequestListener` opens an activity entry, so only it can close
  // one. `createProxyServer`'s handler has no ledger to close.
  assert.ok(!/[Bb]oth outer catches[^.]*close the activity entry/.test(claims),
    'the doc says both outer catches close an activity entry; the control-plane one never opens one');
});

// The claims themselves, checked against the code rather than against prose.
// Two catches, each with both answer arms and each closing the ledger.
test('both outer catches answer on each half and close the activity entry', () => {
  // Anchored on the two outer catches themselves — their 502 body is unique to
  // them — rather than on a COUNT of sites using the shared predicate, which
  // changes whenever another site adopts it and would fail for a reason that
  // has nothing to do with the claim. (It did, immediately.)
  // The OUTER catches specifically: the inner one around forwardRequest shares
  // the same 502 body, and is a different claim — it has always had both arms.
  // The two outer ones are the sites that gate on the shared predicate.
  const catches = [...server.matchAll(/'Internal proxy error' \} \}\)\);/g)]
    .filter(m => /if \(!res\.headersSent && !clientGone\(res\)\) \{/
      .test(server.slice(Math.max(0, m.index - 400), m.index)));
  assert.equal(catches.length, 2, `expected two outer catches; found ${catches.length}`);
  for (const m of catches) {
    const before = server.slice(Math.max(0, m.index - 400), m.index);
    const after = server.slice(m.index, m.index + 900);   // past the arm's comment
    assert.match(before, /if \(!res\.headersSent && !clientGone\(res\)\) \{/,
      'an outer catch does not gate its answer on the shared client-gone predicate');
    assert.match(after, /\} else if \(!res\.writableEnded\) \{[\s\S]*?res\.destroy\(\);/,
      'an outer catch answers only the before-headers half, so a throw after writeHead hangs the client');
  }
  // The ledger's ordering, which is the thing two rounds got backwards.
  const startIdx = server.indexOf('openEntry = { reqId, sessionId };');
  const hookIdx = server.indexOf('hooks.onRequestStart?.(');
  assert.ok(startIdx > 0 && hookIdx > 0 && startIdx < hookIdx,
    'the activity entry is marked open AFTER the start hook, so a hook that registers then throws leaks a row');
});

// Symbols the doc names as the things to look at. A rename that leaves the doc
// pointing at nothing is the same rot in a different form.
test('REVIEWING.md names symbols that still exist', () => {
  for (const symbol of ['_windowForBucket', '_governingBucket', 'removeAccount',
                        '_setCurrent', 'setCurrentAccount', 'clientGone']) {
    if (!doc.includes(symbol)) continue;          // only check what it claims
    assert.ok(server.includes(symbol) || readdirSync(join(here, '..', 'src'))
      .some(f => readFileSync(join(here, '..', 'src', f), 'utf8').includes(symbol)),
    `REVIEWING.md names \`${symbol}\`, which no longer exists in src/`);
  }
});

// Every residual the doc tells reviewers not to report must still be a live
// entry — an overturned one has to stop being cited as a reason for silence.
//
// Scanned over the WHOLE doc, precedent notes included: a precedent that points
// at a residual is still a live pointer, and "recorded as TC-007" going stale
// misdirects a reviewer exactly as much as a stale suppression. What the doc may
// do is name an overturned entry AS overturned, which is how invariant 15 cites
// its own precedent — so the check is that the label travels with the citation,
// not that the ID is absent.
test('the residuals REVIEWING.md suppresses are still accepted', () => {
  for (const m of doc.matchAll(/TC-\d{3}/g)) {
    if (!new RegExp(`~~${m[0]}~~`).test(residuals)) continue;      // still live
    const site = doc.slice(m.index, m.index + 120);
    assert.match(site, /overturned/i,
      `REVIEWING.md cites ${m[0]} as if it were live; RESIDUALS.md records it as overturned`);
  }
});

// The doc said it had no test of this kind for as long as it had one — the
// claim outlived its own falsification by three commits, in the section whose
// subject is claims outliving their truth.
test('REVIEWING.md does not deny the mechanization it has', () => {
  assert.ok(!/This doc has no such test/.test(claims),
    'the doc says it is unmechanized while this file is running against it');
});

// The one count the doc is allowed to state, because it is checked. A ledger of
// past incidents only grows by appending, so the number is the length of the
// list — stated once for the reader, verified here so it cannot drift from it.
test('the ledger of tests that measured nothing counts itself', () => {
  const start = doc.indexOf('## The tests that named a property');
  assert.ok(start > 0, 'the ledger section is gone from REVIEWING.md');
  const rest = doc.slice(start + 3);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);

  const stated = Number(/(\d+) tests on this branch/.exec(section)?.[1]);
  const entries = [...section.matchAll(/^\d+\. /gm)].length;
  assert.ok(stated > 0, 'the ledger no longer states a count, which was the point of writing it');
  assert.equal(entries, stated,
    `the ledger says ${stated} tests and lists ${entries} — appending an entry means updating the number`);
  // Each entry has to say what caught it; "found somehow" is the part with no
  // value, since the whole claim is about which instrument finds these.
  const attributed = [...section.matchAll(/\*Caught (in|by) [^*]+\*/g)].length;
  assert.equal(attributed, entries, 'a ledger entry does not say what caught it');
});

// The count the doc used to quote, which was twelve short. Asserting the number
// here rather than in prose means it is maintained by the suite that produces it.
test('the documented test-file count matches what the suite runs', () => {
  const files = readdirSync(here).filter(f => f.endsWith('.test.js'));
  assert.ok(files.length > 60, `only ${files.length} test files found — is this the right directory?`);
  assert.ok(!/# \d{3} tests/.test(doc),
    'REVIEWING.md quotes a hardcoded test count, which rots on the next test added');
});
