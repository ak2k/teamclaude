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

// The claim that rotted. Both catches answer and both close the ledger, so the
// doc must not still be describing one of them as log-only or prescribing work
// that is already done.
test('REVIEWING.md does not describe an outer catch that is already fixed', () => {
  assert.ok(!/still log-only/.test(doc),
    'the doc says an outer catch is still log-only; both answer the socket');
  assert.ok(!/A `finally` that closes activity state belongs with it/.test(doc),
    'the doc prescribes a finally that has shipped');
});

// The claims themselves, checked against the code rather than against prose.
// Two catches, each with both answer arms and each closing the ledger.
test('both outer catches answer on each half and close the activity entry', () => {
  const answers = server.match(/if \(!res\.headersSent && !clientGone\(res\)\) \{/g) || [];
  assert.equal(answers.length, 2, `expected both outer catches to answer; found ${answers.length}`);
  const secondArms = server.match(/\} else if \(!res\.writableEnded\) \{/g) || [];
  assert.ok(secondArms.length >= 2,
    `a catch answers only the before-headers half: found ${secondArms.length} headers-sent arms`);
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
test('the residuals REVIEWING.md suppresses are still accepted', () => {
  for (const id of doc.match(/TC-\d{3}/g) || []) {
    const overturned = new RegExp(`~~${id}~~`).test(residuals);
    assert.ok(!overturned,
      `REVIEWING.md still cites ${id}, which RESIDUALS.md records as overturned`);
  }
});

// The count the doc used to quote, which was twelve short. Asserting the number
// here rather than in prose means it is maintained by the suite that produces it.
test('the documented test-file count matches what the suite runs', () => {
  const files = readdirSync(here).filter(f => f.endsWith('.test.js'));
  assert.ok(files.length > 60, `only ${files.length} test files found — is this the right directory?`);
  assert.ok(!/# \d{3} tests/.test(doc),
    'REVIEWING.md quotes a hardcoded test count, which rots on the next test added');
});
