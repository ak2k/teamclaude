// Flag-off differential fuzz: with `expiryRouting` absent from the config, this
// branch must route identically to the revision it forked from. Two checkouts
// are driven through the same random script of quota, status and selection
// operations, and the account each one picks is compared step by step.
//
// Usage:
//   node tools/flagoff-differential.mjs --head=<checkout> --base=<checkout> \
//        [--one-model-per-session] [--seeds=N] [--steps=N]
//
// BOTH PATHS ARE REQUIRED and neither has a default. This is a differential: a
// baked-in default is how you end up comparing a tree against itself and
// reporting a perfect score. The revisions actually compared are resolved with
// `git rev-parse` and printed in the result line, because "flag-off matches
// upstream" is a claim about two specific commits and is worthless without them
// — a stale base worktree produces a green run that has verified nothing.
//
// ── the two modes, and why the result line names the one it ran ──────────────
//
// Under this branch a session's pin is per governing BUCKET rather than one pin
// for the whole session. That is a deliberate change, and it is observable with
// the flag off: a session that sends opus and then fable can legitimately be
// routed to two different accounts where the base would have kept both on one.
//
//   --one-model-per-session  Each session sends exactly one model for its whole
//                            life, derived from its id. One model means one
//                            governing bucket, so the deliberate change has no
//                            way to show, and EXACT equality at every step is
//                            the acceptance criterion. This is the gate.
//   (default)                Sessions mix models freely. Divergences are
//                            EXPECTED here and are not by themselves a defect;
//                            this mode is for reading what the change does, not
//                            for accepting it.
//
// Same numbers, opposite meanings — `divergences=0` is a pass in the first mode
// and unremarkable in the second, and a nonzero count is a defect in the first
// and the point of the exercise in the second. So `mode=` is printed in the
// result line rather than left to whoever remembers which flag they passed. A
// number whose meaning depends on an invocation nobody recorded is not evidence.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const HEAD = opt('head');
const BASE = opt('base');
const ONE_MODEL_PER_SESSION = argv.includes('--one-model-per-session');
const SEEDS = Number(opt('seeds', '2500'));
const STEPS = Number(opt('steps', '120'));

if (!HEAD || !BASE) {
  console.error('usage: tools/flagoff-differential.mjs --head=<checkout> --base=<checkout>'
    + ' [--one-model-per-session] [--seeds=N] [--steps=N]');
  process.exit(2);
}
for (const [label, dir] of [['head', HEAD], ['base', BASE]]) {
  if (!fs.existsSync(`${dir}/src/account-manager.js`)) {
    console.error(`no ${dir}/src/account-manager.js — is --${label} a teamclaude checkout?`);
    process.exit(2);
  }
}

// Resolving these is also the check that the two trees are not the same tree.
// A differential against yourself is the purest form of this instrument lying.
const revOf = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
const headRev = revOf(HEAD);
const baseRev = revOf(BASE);
if (headRev !== 'unknown' && headRev === baseRev) {
  console.error(`--head and --base are both at ${headRev}; a tree always matches itself.`);
  process.exit(2);
}

const { AccountManager: Head } = await import(pathToFileURL(`${HEAD}/src/account-manager.js`).href);
const { AccountManager: Base } = await import(pathToFileURL(`${BASE}/src/account-manager.js`).href);

const H = 3600_000;
const MODELS = [null, 'claude-opus-5', 'claude-fable-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

// xorshift32 so both arms see the identical script.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// No `expiryRouting` key at all — that absence IS the flag-off condition under
// test, so it is spelled out here rather than left as a thing the reader has to
// notice is missing.
function build(Ctor, n, distribute, namePrefix = 'a') {
  const specs = Array.from({ length: n }, (_, i) => ({ name: `${namePrefix}${i}`, type: 'apikey', apiKey: `k${i}` }));
  return new Ctor(specs, 0.98, { distributeSessions: distribute });
}

function step(am, op, now) {
  const a = am.accounts[op.idx % am.accounts.length];
  switch (op.kind) {
    case 'quota': {
      a.quota.unified7d = op.used;
      a.quota.unified7dReset = now + op.resetH * H;
      a.probing = false;
      break;
    }
    case 'fable': {
      a.quota.unified7dFable = op.used;
      a.quota.unified7dFableReset = now + op.resetH * H;
      break;
    }
    case 'fiveh': { a.quota.unified5h = op.used; a.quota.unified5hReset = now + op.resetH * H; break; }
    case 'disable': a.disabled = op.on; break;
    case 'priority': a.priority = op.p; break;
    case 'status': a.status = op.s; if (op.s !== 'throttled') { a.rateLimitedUntil = null; } break;
    case 'inflight': a.inFlight = op.n; break;
    case 'current': am.currentIndex = op.idx % am.accounts.length; break;
    case 'clearq': { a.quota.unified7d = null; a.quota.unified7dReset = null; break; }
  }
}

function script(seed, steps, nAcc) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const ops = [];
  for (let i = 0; i < steps; i++) {
    const kind = pick(['quota', 'quota', 'fable', 'fiveh', 'disable', 'priority', 'status', 'inflight', 'current', 'clearq', 'select', 'select', 'select', 'select']);
    ops.push({
      kind, idx: Math.floor(r() * nAcc), used: Math.round(r() * 100) / 100,
      resetH: Math.round(r() * 400), on: r() < 0.3, p: Math.floor(r() * 3),
      s: pick(['active', 'exhausted', 'error', 'active']), n: Math.floor(r() * 5),
      model: pick(MODELS), sid: `s${Math.floor(r() * 6)}`, useSid: r() < 0.6,
    });
  }
  return ops;
}

/**
 * One seed, both arms, compared step by step.
 *
 * `served` counts the steps where BOTH arms returned an account. It is reported
 * because it is the only thing separating "identical" from "compared nothing":
 * a fleet that is exhausted or misconfigured returns null on every selection,
 * null equals null, and the run prints a flawless zero having tested no routing
 * decision at all.
 */
function compareSeed(seed, distribute, basePrefix, onDiverge) {
  const nAcc = 2 + (seed % 4);
  const head = build(Head, nAcc, distribute);
  const base = build(Base, nAcc, distribute, basePrefix);
  const now = Date.now();
  let compared = 0;
  let served = 0;
  let diverged = 0;
  for (const op of script(seed, STEPS, nAcc)) {
    if (op.kind !== 'select') { step(head, op, now); step(base, op, now); continue; }
    const sid = op.useSid ? op.sid : null;
    const model = (ONE_MODEL_PER_SESSION && sid)
      ? MODELS[sid.charCodeAt(1) % MODELS.length] : op.model;
    const h = head.getActiveAccount(null, model, null, sid, {});
    const b = base.getActiveAccount(null, model, null, sid);
    // Both arms record the same route so the pins stay in step.
    if (h) head.recordSession(sid, h.index, model, null, {});
    if (b) base.recordSession?.(sid, b.index, model);
    compared++;
    if (h && b) served++;
    // Index rather than name, so the canary can rename the base's accounts
    // without that rename being what it detects.
    const hn = h ? h.index : null;
    const bn = b ? b.index : null;
    if (hn !== bn) {
      diverged++;
      onDiverge?.({ distribute, seed, model, sid, head: hn, base: bn });
    }
  }
  return { compared, served, diverged };
}

/**
 * Positive control on the comparison itself, run before the fuzz.
 *
 * The base is built with accounts whose INDICES are the same but whose
 * selection is forced apart: every account after the first is disabled in the
 * base only, so any step where both arms serve must serve a different index —
 * unless the comparison is not looking. A zero here means the run that follows
 * cannot detect a divergence, and its `divergences=0` would be an artefact.
 */
function canary() {
  let served = 0;
  let diverged = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const nAcc = 4;
    const head = build(Head, nAcc, false);
    const base = build(Base, nAcc, false);
    // Force the two arms apart in a way no routing rule can reconcile: the base
    // may only ever serve account 0, the head may never serve it.
    for (let i = 1; i < nAcc; i++) base.accounts[i].disabled = true;
    head.accounts[0].disabled = true;
    for (const op of script(seed, STEPS, nAcc)) {
      if (op.kind !== 'select') continue;   // a disable op would undo the setup
      const sid = op.useSid ? op.sid : null;
      const h = head.getActiveAccount(null, op.model, null, sid, {});
      const b = base.getActiveAccount(null, op.model, null, sid);
      if (!h || !b) continue;
      served++;
      if ((h.index ?? null) !== (b.index ?? null)) diverged++;
    }
  }
  return { served, diverged };
}

// Both managers narrate every switch, and 170k selections of that buries the
// one line worth reading under a megabyte. Captured before stubbing so this
// tool's own output still goes somewhere; `say` is used for everything below.
const say = console.log.bind(console);
console.log = () => {};

const control = canary();
if (control.served === 0 || control.diverged !== control.served) {
  console.error(`CONTROL FAILED: ${control.diverged}/${control.served} forced divergences detected.`);
  console.error('The comparison cannot see a difference it was handed, so a clean run below would'
    + ' mean nothing. Check that both checkouts loaded and that selection returns accounts at all.');
  process.exit(2);
}

const shown = [];
let compared = 0;
let served = 0;
let divergences = 0;
for (const distribute of [false, true]) {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = compareSeed(seed, distribute, 'a', (d) => {
      if (shown.length < 8) shown.push(d);
    });
    compared += r.compared;
    served += r.served;
    divergences += r.diverged;
  }
}
for (const d of shown) {
  say(`DIVERGE distribute=${d.distribute} seed=${d.seed} model=${d.model} sid=${d.sid} head=${d.head} base=${d.base}`);
}

const mode = ONE_MODEL_PER_SESSION ? 'one-model-per-session' : 'free-model-mix';
say(`mode=${mode} head=${headRev} base=${baseRev} seeds=${SEEDS} steps=${STEPS}`
  + ` compared=${compared} both-served=${served} control=${control.diverged}/${control.served}`
  + ` divergences=${divergences}`);

// Only the gated mode has a pass/fail. In free-model-mix the divergences are the
// deliberate per-bucket pin change, and failing on them would be reporting the
// feature as a defect.
if (ONE_MODEL_PER_SESSION && divergences) process.exit(1);
