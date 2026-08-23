import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// The caption gate is a script, so what is held here is that it still RUNS and
// still grades: a gate nobody invokes rots into a file, and the first sign is
// that its committed sample no longer produces the verdicts it was built for.
//
// The invocation below is also the worked example. `--now` has no default
// because a captured sample read at the wall clock arrives with its five-hour
// buckets already expired, so the sample carries `_capturedAt` and the caller
// passes it — the fixture documents its own clock without the tool defaulting
// to one.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, '..', 'tools', 'verify-caption.mjs');
const SAMPLE = path.join(HERE, '..', 'tools', 'caption-sample.json');
const NOW = '2026-08-22T23:08:21Z';

function gate(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [GATE, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('the shipped caption still describes what decideBand does', () => {
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(code, 0, out);
  // The premise: without this line the assertions below could all pass on a run
  // that graded nothing, because the harness aborts before printing verdicts.
  assert.match(out, /harness {4}replaying the CODE's own order reproduces the decision: yes/);
  assert.match(out, /REPRODUCES {9}weekly-headroom-per-hour/);
  assert.equal((out.match(/^DIFFERS/gm) || []).length, 2);
  assert.doesNotMatch(out, /INDISTINGUISHABLE/);
});

test('a sample read without its capture clock is refused, not guessed at', () => {
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5']);
  assert.equal(code, 2);
  assert.match(out, /--now=<iso> is required/);
});

test('a band variant the caption does not describe is refused rather than graded', () => {
  // One account cannot be banded, so `decideBand` passes through and the
  // coverage sentence has nothing to say about the outcome. Grading it anyway
  // would report a caption as reproducing a decision the caption never made.
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  sample.accounts = sample.accounts.slice(0, 1);
  const single = path.join(os.tmpdir(), `caption-single-${process.pid}.json`);
  fs.writeFileSync(single, JSON.stringify(sample));
  try {
    const { code, out } = gate([`--sample=${single}`, '--model=claude-fable-5', `--now=${NOW}`]);
    assert.equal(code, 2);
    assert.match(out, /decides 'passthrough'/);
    assert.doesNotMatch(out, /REPRODUCES|DIFFERS/);
  } finally {
    fs.rmSync(single, { force: true });
  }
});
