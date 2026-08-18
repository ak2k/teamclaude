import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowWatcher, ROLLOVER_MIN_JUMP_MS } from '../src/window-watcher.js';

// Every map in the watcher is keyed by (request bucket, account index). These
// hold that directly, at the level the key lives, because the collapse that
// breaks a window-keyed map is invisible from routing: two buckets resolving to
// one window route identically right up until one of them settles.

const WEEK = 168 * 3600_000;
const SHARED = 'unified7d';
const FABLE = 'unified7dFable';
const SONNET = 'unified7dSonnet';

// One entry of the baseline a caller hands in: which window this bucket
// resolved to on that account, and that window's reset.
const on = (window, reset) => ({ window, reset });

test('two buckets that resolve to one window keep a baseline each', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  // The shipped shape: an account metering no Fable bucket, so a Fable request
  // and an Opus request both read the shared window.
  const before = { [SHARED]: on(SHARED, R0), [FABLE]: on(SHARED, R0) };
  const after = { [SHARED]: on(SHARED, R0 + WEEK), [FABLE]: on(SHARED, R0 + WEEK) };
  w.seed(0, before);

  assert.equal(w.rolledOver(0, FABLE, after), true, 'the Fable bucket missed the roll');
  // The Fable traffic moves to account 1 and the event settles there.
  w.noteServed(1, [FABLE]);
  assert.equal(w.settleServed(), 1);

  // The shared bucket is still on account 0 and its own rollover is untouched:
  // settling Fable banked Fable's baseline, not this one's.
  assert.equal(w.rolledOver(0, SHARED, after), true,
    'settling one bucket advanced a baseline another bucket reads');
});

test('two accounts can owe on one bucket at once', () => {
  const w = new WindowWatcher();
  const A = Date.now() + 50 * 3600_000;
  const B = Date.now() + 60 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, A) });
  w.seed(1, { [SHARED]: on(SHARED, B) });

  assert.equal(w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, A + WEEK) }), true);
  assert.equal(w.rolledOver(1, SHARED, { [SHARED]: on(SHARED, B + WEEK) }), true);
  assert.equal(w.owedOn(SHARED, 0), true, 'the second account overwrote the first account\'s event');
  assert.equal(w.owedOn(SHARED, 1), true);
  assert.equal(w.pendingCount(), 2);
});

test('a settle resolves only the account the traffic left', () => {
  const w = new WindowWatcher();
  const A = Date.now() + 50 * 3600_000;
  const B = Date.now() + 60 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, A) });
  w.seed(1, { [SHARED]: on(SHARED, B) });
  w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, A + WEEK) });
  w.rolledOver(1, SHARED, { [SHARED]: on(SHARED, B + WEEK) });

  w.noteServed(1, [SHARED]);   // the traffic ended up on account 1
  assert.equal(w.settleServed(), 1, 'the count of moves is not the count of events resolved by one');
  assert.equal(w.owedOn(SHARED, 0), false, 'the account the traffic left is still owed');
  assert.equal(w.owedOn(SHARED, 1), true, 'an event was settled by traffic that stayed put');
});

test('a baseline is seeded once and never overwritten within its window', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, R0) });
  w.seed(0, { [SHARED]: on(SHARED, R0 + WEEK) }); // the roll, seen before anything acted
  assert.equal(w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + WEEK) }), true,
    'a re-seed erased a jump nothing had acted on');
});

test('a null reset is not a baseline', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, null) });
  assert.equal(w.windows.size, 0, 'a window with no reset was stored as one');
  // ...and the first real sighting is a first sight, not a jump off null.
  assert.equal(w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0) }), false);
});

test('a bucket whose window changed is a first sight, not a jump', () => {
  const w = new WindowWatcher();
  const shared = Date.now() + 50 * 3600_000;
  const family = shared + 40 * 3600_000; // an unrelated window, dated differently
  w.seed(0, { [FABLE]: on(SHARED, shared) });
  // The account starts reporting its own Fable utilization, so this bucket now
  // reads a different window. Two windows' resets are not comparable.
  assert.equal(w.rolledOver(0, FABLE, { [FABLE]: on(FABLE, family) }), false,
    'a window change was read as the window rolling over');
  // The new window is the baseline from here on, so its own roll IS a jump.
  assert.equal(w.rolledOver(0, FABLE, { [FABLE]: on(FABLE, family + WEEK) }), true);
});

test('an owed event is re-reported, not re-derived from a baseline that moved', () => {
  const w = new WindowWatcher();
  const shared = Date.now() + 50 * 3600_000;
  w.seed(0, { [FABLE]: on(SHARED, shared) });
  assert.equal(w.rolledOver(0, FABLE, { [FABLE]: on(SHARED, shared + WEEK) }), true);
  // Nothing has moved yet, and now the account starts metering Fable — which
  // re-seeds this bucket against a window the pre-roll reset says nothing about.
  // Re-derived, the event would vanish while still sitting in `pending`: owed
  // forever, and never preempting again.
  const family = shared + 300 * 3600_000;
  assert.equal(w.rolledOver(0, FABLE, { [FABLE]: on(FABLE, family) }), true,
    'the owed event was lost to a baseline that moved under it');
});

test('a jump shorter than the floor is the same window re-reported', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, R0) });
  assert.equal(w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + ROLLOVER_MIN_JUMP_MS) }), false);
  assert.equal(w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + ROLLOVER_MIN_JUMP_MS + 1) }), true);
});

// `owed` is the operator's silent-failure signal, so it counts events NOTHING
// HAS MOVED. An event whose bucket has already been served elsewhere is
// resolved and merely waiting for the session to fall quiet.
test('an event a request has already moved is not owed while it waits to settle', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, R0) });
  w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + WEEK) });
  assert.equal(w.pendingCount(), 1, 'a detected rollover nothing moved is not owed');

  w.noteServed(1, [SHARED]);
  assert.equal(w.pendingCount(), 0,
    'a rollover a request already moved reads as the silent failure it is not');
  assert.equal(w.settleServed(), 1);
  assert.equal(w.pendingCount(), 0);
});

test('an event the traffic came back onto is still owed', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, R0) });
  w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + WEEK) });
  w.noteServed(0, [SHARED]); // preempted, failed over, and served by the same account
  assert.equal(w.pendingCount(), 1, 'a preemption that moved nothing was counted as resolved');
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 0), true);
});

test('a settle clears what it was told, so a stale service cannot settle the next event', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, R0) });
  w.noteServed(1, [SHARED]);
  assert.equal(w.settleServed(), 0); // nothing pending yet
  // A rollover detected AFTER that service must not be settled by it.
  assert.equal(w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + WEEK) }), true);
  assert.equal(w.settleServed(), 0, 'a service from before the event settled it');
  assert.equal(w.owedOn(SHARED, 0), true);
});

test('remap renumbers baselines, pending events and the last service together', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(2, { [SHARED]: on(SHARED, R0), [SONNET]: on(SHARED, R0) });
  w.rolledOver(2, SHARED, { [SHARED]: on(SHARED, R0 + WEEK), [SONNET]: on(SHARED, R0 + WEEK) });
  w.noteServed(2, [SONNET]);

  assert.equal(w.remap(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx)), true);
  assert.equal(w.owedOn(SHARED, 1), true, 'the pending event kept a stale account index');
  assert.equal(w.owedOn(SHARED, 2), false);
  assert.equal(w.served.get(SONNET), 1, 'the last service kept a stale account index');
  assert.equal(w.windows.get(SHARED).has(1), true, 'the baseline kept a stale account index');
  assert.equal(w.windows.get(SONNET).has(1), true, 'only the request bucket that rolled was renumbered');
});

test('remap reports the watcher dead once the removal left nothing', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(1, { [SHARED]: on(SHARED, R0) });
  w.rolledOver(1, SHARED, { [SHARED]: on(SHARED, R0 + WEEK) });
  assert.equal(w.remap(idx => (idx === 1 ? null : idx)), false,
    'a watcher holding nothing still claims to be live, so it is never dropped');
  assert.equal(w.windows.size, 0);
  assert.equal(w.pending.size, 0);
});

test('commitOn reports the moves it settled', () => {
  const w = new WindowWatcher();
  const R0 = Date.now() + 50 * 3600_000;
  w.seed(0, { [SHARED]: on(SHARED, R0) });
  w.rolledOver(0, SHARED, { [SHARED]: on(SHARED, R0 + WEEK) });
  assert.equal(w.commitOn(0, [SHARED]), 0, 'staying put was reported as a move');
  assert.equal(w.commitOn(1, [SHARED]), 1, 'the move was not reported');
  assert.equal(w.commitOn(1, [SHARED]), 0, 'a settled event was reported a second time');
});
