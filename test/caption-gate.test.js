import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ruleCaption } from '../src/status-renderer.js';

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
  assert.match(out, /REPRODUCES {9}unspent-weekly-per-hour/);
  // Three controls now: two falsified captions and the transposed-order control.
  assert.equal((out.match(/^DIFFERS/gm) || []).length, 3);
  assert.doesNotMatch(out, /INDISTINGUISHABLE/);
});

test('the gate grades the ORDER, which is what the caption claims', () => {
  // Set membership and a coverage total are both order-insensitive, and the
  // caption's whole claim is that a particular account goes first. Grading only
  // those two let a transposed reading pass: measured before this changed, the
  // shipped caption with its top two swapped graded REPRODUCES while printing
  // `admits [3,2]` beside `vs decision [2,3]`.
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(code, 0, out);
  assert.match(out, /the band walked \[[\d,]+\], which is the sequence each caption is graded against/);
  assert.match(out, /orders \[[\d,]+\] vs the band's \[[\d,]+\] {3}same sequence/);
  assert.match(out, /DIFFERENT SEQUENCE/,
    'no control differed on order, so the comparison was never exercised');
});

test("the gate's order control must differ, or its verdicts are set membership in an ordering's words", () => {
  // The gate's own red control: the band's order with two entries swapped,
  // which admits the same set with the same total by construction, so only a
  // sequence comparison can see it. It is graded through the ordinary caption
  // path rather than asserted separately — a control checked by different
  // machinery than the captions proves nothing about the captions.
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(code, 0, out);
  assert.match(out, /DIFFERS {12}transposed-band-order {2}\(control\)/,
    'the transposed order graded as reproducing, so the verdict is not consulting sequence');
  // Its premise, printed: the SAME admitted set and total as the decision, so
  // the only thing that can have separated them is sequence. Compared as sets,
  // because the replay lists what it admitted in walk order while the decision
  // lists it in tier order — the difference that makes this control order-only
  // is exactly the difference a string comparison would trip over.
  const lines = out.split('\n');
  const admits = lines[lines.findIndex(l => l.includes('transposed-band-order')) + 3];
  const [, got, gotTotal, want, wantTotal] =
    admits.match(/admits \[([\d,]+)\] achieving ([\d.]+) +vs decision \[([\d,]+)\] achieving ([\d.]+)/);
  assert.deepEqual(got.split(',').sort(), want.split(',').sort(),
    'the control changed the admitted set, so it is not an order-only control here');
  assert.equal(gotTotal, wantTotal, 'the control changed the coverage total');
  assert.notEqual(got, want, 'the control did not reorder anything');
});

test("the gate shows the caption's priority scope is doing work, not decorating", () => {
  // The caption is scoped to a priority tier because unqualified it was false:
  // `decideBand` ranks only the best tier, so a lower-priority account with far
  // more expiring quota goes last while the sentence said it goes first. Every
  // other verdict in this gate is blind to that — the ladder it grades against
  // excludes lower-tier rows — so the scope needs its own check.
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(code, 0, out);
  assert.match(out, /cross-tier {2}demoting \[\d+\] to a lower priority/,
    'the cross-tier control did not run, so the priority qualifier is ungraded');
  assert.match(out, /DIFFERS, as it must/,
    'the tier-scoped and unqualified readings agreed, so the scope is unobservable here');
});

test('the gate grades the stop clause on BOTH measurements, not on the one it thought of', () => {
  // "Until N are covered" is only half the rule. The other half — accounts
  // missing either measurement are admitted regardless — is what lets a ladder
  // hold one row for `coverage-met` and admit the next, and it was absent from
  // the caption for four passes while every verdict here stayed green.
  //
  // EITHER means two, and the control synthesised absence one way: it removed a
  // reset, which is the pressure half. The exemption could have been lost on the
  // headroom side and this gate would have stayed green — a control checks what
  // its author thought to build, and the sentence's claim space is wider.
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(code, 0, out);
  for (const axis of ['pressure', 'headroom']) {
    const line = out.split('\n').find(l => l.startsWith(`stop clause  ${axis}`));
    assert.ok(line,
      `the ${axis} half of "either measurement" is ungraded, which is the state the other half `
      + 'was in when a pass found the caption wrong');
    assert.match(line, /DIFFERS, as it must/,
      `a caption that said nothing about a missing ${axis} would grade identically`);
  }
});

// The caption has TWO branches and the gate graded one. The other runs whenever
// no account has reported a five-hour level — cold start, probe off — and went
// ungraded for the whole round. That is the stop clause's gap on a different
// axis, and deferring the stop clause once is how it became a finding.
test('the gate grades the banded caption, not only the sized one', () => {
  const { code, out } = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(code, 0, out);
  const reproduces = out.split('\n').find(l => l.startsWith('banded') && l.includes('the sentence admits'));
  assert.ok(reproduces, 'the banded sentence is ungraded, which is the state the stop clause was in');
  assert.match(reproduces, /REPRODUCES/,
    'the banded caption does not describe what the ratio rule did');
  const control = out.split('\n').find(l => l.startsWith('banded') && l.includes('exemption'));
  assert.match(control, /DIFFERS, as it must/,
    'a caption that dropped "admitted regardless" would grade identically');
});

// A CAPTURED STATUS IS NOT A CONFIG, and the committed sample could not show
// it: its `routes` is empty. On the wire `routes[].accounts` is
// `[{name, eligible}]`, while `setRoutes` expects names — handed the objects,
// every account stringified to "[object Object]", matched nothing, and the
// route excluded the entire fleet. The gate then refused for the wrong reason,
// reporting a passthrough decision about a fleet it had emptied itself.
//
// So this fixture carries a route in the shape the wire actually sends. Keep it
// that shape: rewriting `accounts` to bare strings here would make the test pass
// against the bug it exists to catch.
test('the gate accepts a captured status, whose routes carry account OBJECTS', () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  assert.deepEqual(sample.routes ?? [], [],
    'the committed sample grew routes; this fixture no longer adds the case it was built for');
  sample.routes = [{
    name: 'fable',
    match: ['*fable*'],
    bucket: null,
    color: null,
    autocreated: false,
    pinned: null,
    accounts: sample.accounts.map(a => ({ name: a.name, eligible: true })),
    sample: 'claude-fable-5',
    target: sample.accounts[0].name,
  }];
  const routed = path.join(os.tmpdir(), `caption-routed-${process.pid}.json`);
  fs.writeFileSync(routed, JSON.stringify(sample));
  try {
    const { code, out } = gate([`--sample=${routed}`, '--model=claude-fable-5', `--now=${NOW}`]);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /0 of \d+ accounts are candidates/,
      'the route excluded the whole fleet, which is what account objects used to do');
    assert.match(out, /REPRODUCES {9}unspent-weekly-per-hour/,
      'the gate graded nothing on a fleet it had emptied');
  } finally {
    fs.rmSync(routed, { force: true });
  }
});

// A REPLAY CANNOT NOTICE A REWORDING. The banded section grades `floorSteps`
// and never read the sentence describing it, so the caption could be rewritten
// into something false about the rule — "the soonest-expiring account goes first
// and nothing else is admitted" — and the gate still exited 0 printing
// REPRODUCES. Both shipped branches are pinned now, for the reason the sized one
// always was.
test('the gate refuses when either shipped caption has been reworded', () => {
  const sized = ruleCaption({ kind: 'sized', target: 1 });
  const banded = ruleCaption({ kind: 'banded', floor: 1 });
  // The pins are written as concatenated literals, so the sentence never appears
  // on one line: flatten the concatenation before looking for it. Reading the
  // file for a substring that the file cannot contain is its own small version
  // of grading the wrong thing, and it failed here first.
  const flat = fs.readFileSync(GATE, 'utf8')
    .replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  const oneLine = t => t.replace(/\s+/g, ' ');
  assert.ok(flat.includes(oneLine(banded)),
    'the banded caption is not pinned in the gate, so a rewording passes it silently');
  assert.ok(flat.includes(oneLine(sized)),
    'the sized caption pin no longer matches what renders');
  // And the pin is the mechanism, not a comment: both texts appear as literals
  // the gate compares against, so drift stops the run rather than being graded.
  assert.match(flat, /BANDED caption has been reworded/,
    'nothing fails the run when the banded caption drifts');
  // The behaviour itself is asserted below rather than observed by hand.
});

// THE PIN IS A BEHAVIOUR AND THE TEST ABOVE GRADES ITS TEXT. Disabling the
// comparison — `if (false && bandedText !== BANDED_PINNED)` — leaves every
// literal and the message in the file, so all three assertions above still
// pass while the gate no longer refuses anything. A neutralisation sweep found
// that; the comment here used to say the red had been "observed" by hand,
// which is the same evidence with nobody re-running it.
test('the banded pin refuses a reworded caption rather than only mentioning it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-pin-'));
  try {
    fs.cpSync(path.join(HERE, '..', 'src'), path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'));
    const script = path.join(dir, 'tools', 'verify-caption.mjs');
    fs.copyFileSync(GATE, script);
    // Reword what the gate pins, in the copy only.
    const renderer = path.join(dir, 'src', 'status-renderer.js');
    const before = fs.readFileSync(renderer, 'utf8');
    const said = 'everything within the tolerance ratio';
    assert.equal(before.split(said).length - 1, 1,
      'the premise: one place says it, so the rewording below is the caption');
    fs.writeFileSync(renderer, before.replace(said, 'NOTHING within the tolerance ratio'));

    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath,
        [script, `--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`],
        { encoding: 'utf8' });
    } catch (err) {
      code = err.status;
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }
    assert.equal(code, 2, 'the gate graded a tree whose banded caption no longer says what it grades');
    assert.match(out, /BANDED caption has been reworded/);
    assert.match(out, /NOTHING within the tolerance ratio/,
      'the refusal must print what it found, or a reader cannot see what drifted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  // THE ROUTING BLOCK DESCRIBES THE FULL FLEET AND THIS FIXTURE TRUNCATES IT,
  // so the capture would contradict its own accounts — and the fidelity check
  // now catches exactly that, refusing before the band-variant refusal this
  // test is about. That is the check working, not interfering: a four-candidate
  // routing entry beside a one-account fleet IS an inconsistent capture.
  // The entry is brought into line with the truncated fleet so the fixture is
  // internally coherent and the refusal under test is the one that fires.
  for (const e of sample.routing || []) {
    if (e && e.band) {
      e.band.candidates = 1;
      e.band.kind = 'passthrough';
      e.band.admitted = (e.band.admitted || []).slice(0, 1);
    }
  }
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

// A ROUTE'S WIRE VIEW IS NOT ITS CONFIG, and the gate rebuilds a fleet from the
// wire. `routes[].accounts` is `[{name, eligible}]` — who the route currently
// admits — and a route the operator left UNRESTRICTED publishes the whole
// eligible fleet there. Reading that back as an explicit accounts list turns
// "unrestricted, and four happen to qualify" into "restricted to these four",
// which is a different route and can be a different DECISION.
//
// Measured before the check below existed: a capture from a `*fable*` route
// with an empty accounts list and one models-claim owner records `passthrough`
// over ONE candidate in its own routing entry, and the rebuild produced `sized`
// over FOUR — then printed REPRODUCES for the shipped caption against a fleet
// that never existed. The pre-round gate refused the same payload outright, so
// the reconstruction turned a refusal into a graded verdict.
//
// The gate cannot recover the config from the wire, so it does not try: it
// checks its rebuild against the capture's own routing entry and REFUSES on
// disagreement.
async function captureWith(routeAccounts) {
  const { AccountManager } = await import('../src/account-manager.js');
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  const H = 3600e3;
  const am = new AccountManager([
    { name: 'owner', type: 'apikey', apiKey: 'k1', models: ['claude-fable-5'] },
    { name: 'spare1', type: 'apikey', apiKey: 'k2' },
    { name: 'spare2', type: 'apikey', apiKey: 'k3' },
    { name: 'spare3', type: 'apikey', apiKey: 'k4' },
  ], 0.98, {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: routeAccounts }],
    expiryRouting: { enabled: true, coverage: 1, tolerance: 1.5 },
  });
  am.accounts.forEach((a, i) => {
    a.quota = { ...a.quota,
      unified5h: 0.10 + i * 0.05, unified5hReset: now + (2 + i) * H,
      unified7d: 0.20 + i * 0.10, unified7dReset: now + (40 + i * 5) * H,
      unified7dFable: 0.15 + i * 0.10, unified7dFableReset: now + (40 + i * 5) * H };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-recon-'));
  const file = path.join(dir, 'capture.json');
  fs.writeFileSync(file, JSON.stringify(am.getStatus(), null, 2));
  return { file, now: new Date(now).toISOString() };
}

test('a capture the rebuild cannot reproduce is refused, not graded', async () => {
  const { file, now } = await captureWith([]);          // UNRESTRICTED route
  const { code, out } = gate([`--sample=${file}`, '--model=claude-fable-5', `--now=${now}`]);
  assert.notEqual(code, 0, `the gate graded a fleet the capture contradicts:\n${out}`);
  assert.doesNotMatch(out, /^(REPRODUCES|DIFFERS|INDISTINGUISHABLE)\s+\S/m,
    'a caption verdict was printed for a fleet the capture does not describe;'
    + ' the exit code is not the observable, the verdict is');
  assert.match(out, /the rebuilt fleet does not match the capture/,
    'it refused for some other reason, so this fixture is not exercising the reconstruction check');
  assert.match(out, /candidates 4 rebuilt vs 1 captured/);
});

test('the reconstruction check does not refuse a capture it CAN reproduce', async () => {
  // The control, and the reason it is not optional: a check that refused every
  // capture would satisfy the test above without measuring anything. With the
  // route configured explicitly, the wire view and the config agree, the
  // rebuild matches, and the gate walks past this check to its ordinary work.
  const { file, now } = await captureWith(['owner']);   // EXPLICIT route
  const { out } = gate([`--sample=${file}`, '--model=claude-fable-5', `--now=${now}`]);
  assert.doesNotMatch(out, /the rebuilt fleet does not match the capture/,
    'the reconstruction check refused a capture whose route WAS explicitly configured,'
    + ' so it is not discriminating — it is just refusing');
});

// THE GUARD WAS THE BYPASS. The fidelity check added in `09c1fdf` compares the
// rebuilt fleet against the capture's own routing entry — and skipped silently
// when no entry named the graded model. `tools/caption-sample.json` carried NO
// routing key at all, so on the sample the battery actually runs the repair had
// never executed once, for any model, while the gate printed caption verdicts.
//
// Unreachable code cannot carry a claim; this is that defect in an INSTRUMENT.
test('the fidelity check actually runs on the shipped sample', () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  assert.ok(Array.isArray(sample.routing) && sample.routing.length,
    'the shipped sample lost its routing block; the fidelity check is inert again');
  const entry = sample.routing.find(e => e && e.model === 'claude-fable-5');
  assert.ok(entry && entry.band,
    'no captured entry names the graded model, so the comparison would skip');

  // IT GRADES when the rebuild matches...
  const ok = gate([`--sample=${SAMPLE}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.equal(ok.code, 0, ok.out);

  // ...and REFUSES when the capture contradicts the rebuild. Without this the
  // test passes on a build where the check is present and never fires.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-fid-'));
  const bad = JSON.parse(JSON.stringify(sample));
  const badEntry = bad.routing.find(e => e && e.model === 'claude-fable-5');
  badEntry.band.candidates = (badEntry.band.candidates || 0) + 99;
  const badPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(badPath, JSON.stringify(bad));
  const refused = gate([`--sample=${badPath}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.notEqual(refused.code, 0, 'a contradicted capture was graded anyway');
  assert.match(refused.out, /does not match the capture/);

  // ...and refuses LOUDLY when there is nothing to check against, so the next
  // sample captured without a routing block cannot restore the silence.
  const stripped = JSON.parse(JSON.stringify(sample));
  delete stripped.routing;
  const strippedPath = path.join(dir, 'noRouting.json');
  fs.writeFileSync(strippedPath, JSON.stringify(stripped));
  const loud = gate([`--sample=${strippedPath}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.notEqual(loud.code, 0, 'a sample with no routing block was graded silently');
  assert.match(loud.out, /carries no routing/);

  // ...AND REFUSES WHEN THE ROUTING BLOCK NAMES NO ENTRY FOR THE GRADED MODEL.
  // This is the arm that actually bypassed: same band payload, a SIBLING model
  // id on the entry, the comparison skipped and a verdict printed anyway. It is
  // a DIFFERENT conjunct from the missing-block case, and without it the
  // neutralisation row for the no-entry refusal SURVIVES — measured, which is
  // how this arm came to be written.
  const sibling = JSON.parse(JSON.stringify(sample));
  for (const e of sibling.routing) {
    if (e && e.model === 'claude-fable-5') e.model = 'claude-fable-4';
  }
  const siblingPath = path.join(dir, 'sibling.json');
  fs.writeFileSync(siblingPath, JSON.stringify(sibling));
  const skipped = gate([`--sample=${siblingPath}`, '--model=claude-fable-5', `--now=${NOW}`]);
  assert.notEqual(skipped.code, 0,
    'a capture naming no entry for the graded model was graded without any fidelity check');
  assert.match(skipped.out, /no entry for claude-fable-5/);
});
