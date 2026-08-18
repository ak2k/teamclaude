// Rollover bookkeeping for one sticky routing choice — a session's pins, or the
// global current account.
//
// EVERY map here is keyed by (request bucket, account index). The window a
// bucket resolves to is a VALUE read off the account, never an identity stored
// under: it collapses to `unified7d` for any bucket whose family utilization the
// account does not report, so two buckets of one session resolve to the same
// window while sitting on DIFFERENT accounts and being preempted independently.
// Keyed by the window, `unified7dFable` and `unified7d` share one entry — the
// first to seed wins, and settling either one advances a baseline the other
// reads, so the other's rollover is never detectable again and that pin rides
// the account it should have left until the window comes round a week later.
// The collapse is the ordinary case, not an edge: an account that has never
// served a family reports no utilization for it.
//
// The window is still CARRIED alongside each baseline, because two resets are
// only comparable when they are the same window's. A bucket's window changes the
// first time its account reports that family's own utilization, and the family
// window's reset is an unrelated instant — compared with the shared window's it
// reads as a jump that never happened. A changed window is a first sight.
//
// A detected rollover is kept PENDING rather than applied. The preemption it
// asks for only really happens once a request is served somewhere else, and a
// request can be re-routed several times before that: it excludes an account
// that just failed, and it re-pins its session on every attempt. Consuming the
// event at detection time means a retry that fails back onto the rolled-over
// account banks a move that never happened, and the session then rides that
// account until its window rolls again a week later.

// How far a weekly reset must move forward to count as that window rolling over
// rather than the same window re-reported. The two writers of a reset disagree
// on precision — a response header carries whole seconds, the usage endpoint a
// fractional ISO timestamp — so one instant reaches the detector as two values
// up to a second apart, and any strictly-forward test reads that as a rollover
// and re-routes every sticky session for nothing. A real weekly roll moves the
// window by a week, so an hour is a floor no genuine event can fall under.
export const ROLLOVER_MIN_JUMP_MS = 3600_000;

// The (bucket, account) maps below are nested — bucket -> account index -> entry
// — so the account half stays a live number the renumbering after a removal can
// rewrite, rather than being baked into a composite string key.
function readPair(map, bucket, idx) {
  return map.get(bucket)?.get(idx) ?? null;
}

function writePair(map, bucket, idx, value) {
  let byAccount = map.get(bucket);
  if (!byAccount) map.set(bucket, byAccount = new Map());
  byAccount.set(idx, value);
}

function deletePair(map, bucket, idx) {
  const byAccount = map.get(bucket);
  if (!byAccount) return;
  byAccount.delete(idx);
  if (!byAccount.size) map.delete(bucket);
}

// Renumber the account half of every entry through `mapFn`, dropping the ones
// whose account went away (and any bucket left holding none).
function remapPairs(map, mapFn) {
  for (const [bucket, byAccount] of [...map]) {
    const moved = new Map();
    for (const [idx, value] of byAccount) {
      const to = mapFn(idx);
      if (to != null) moved.set(to, value);
    }
    if (moved.size) map.set(bucket, moved);
    else map.delete(bucket);
  }
}

export class WindowWatcher {
  constructor() {
    // request bucket -> account index -> { window, reset }: the reset last seen
    // for that bucket THERE, and which window it was read from.
    this.windows = new Map();
    // request bucket -> account index -> { window, reset }: rollovers found but
    // not acted on. Two accounts can owe on one bucket at once — a pin moves
    // while its event is still outstanding — and each is settled by its own
    // traffic moving off it, so the account is part of the key here too.
    this.pending = new Map();
    // request bucket -> the account that most recently SERVED it (noteServed).
    // The account is the ANSWER here, not part of the question, so this one is
    // keyed by the bucket alone: "where did this bucket's traffic go" has
    // exactly one current answer. A selection is not a service — an attempt can
    // be re-routed and re-pinned several times, and only the response the client
    // actually gets says where the traffic went.
    this.served = new Map();
  }

  /**
   * Record `resets` — { requestBucket: { window, reset } } — as the baseline for
   * account `idx`. Seed-only per (bucket, account): overwriting one here would
   * erase a jump nothing has acted on yet. The exception is a baseline read from
   * a DIFFERENT window, which is not a baseline for this one at all and is
   * replaced rather than compared against.
   */
  seed(idx, resets) {
    for (const [bucket, seen] of Object.entries(resets)) {
      if (!seen || seen.reset == null) continue;
      const prev = readPair(this.windows, bucket, idx);
      if (prev && prev.window === seen.window) continue;
      writePair(this.windows, bucket, idx, { window: seen.window, reset: seen.reset });
    }
  }

  /**
   * Has the window governing `bucket` on account `idx` rolled over since we last
   * looked? `resets` is every bucket this account currently resolves, as
   * { requestBucket: { window, reset } } — all of them are seeded, not just the
   * one this request is governed by, or a session that has only ever sent Opus
   * would first-sight its Fable bucket on the very request that should have
   * caught it rolling.
   *
   * This writes — it seeds a first-sight baseline — but it never advances a
   * bucket past a rollover it has found. Only settleServed does that, and only
   * once a preemption has actually moved a request. That is the invariant that
   * lets detection run on every selection pass, including one that cannot act
   * on what it finds: looking costs the event nothing.
   */
  rolledOver(idx, bucket, resets) {
    // Still owed from an earlier pass: re-report it rather than re-deriving it
    // from a baseline that a re-pin may since have moved.
    if (this.owedOn(bucket, idx)) return true;
    const prev = readPair(this.windows, bucket, idx);
    this.seed(idx, resets);
    const now = resets[bucket] || null;
    if (!prev || !now || now.reset == null) return false;
    // Two resets are comparable only within one window. Across a window change
    // this is a first sight, which seed() has just recorded.
    if (prev.window !== now.window) return false;
    if (now.reset - prev.reset <= ROLLOVER_MIN_JUMP_MS) return false;
    writePair(this.pending, bucket, idx, { window: now.window, reset: now.reset });
    return true;
  }

  /** Is a rollover on `bucket` already owed against account `idx`? The question
   * rolledOver asks first, so a caller can tell a newly detected event from the
   * re-report of one still owed — the two are indistinguishable in its boolean,
   * and only the first is an event. */
  owedOn(bucket, idx) {
    return !!this.pending.get(bucket)?.has(idx);
  }

  /**
   * How many rollovers this choice has detected that NOTHING HAS MOVED YET — the
   * gauge an operator reads to tell a stuck preemption from a working one.
   *
   * An event whose bucket has already been served off the rolled account is
   * resolved; it is merely waiting for the sticky choice to go quiescent before
   * settleServed banks it, which for a session means the end of its last
   * in-flight request. Counting those would put the gauge above zero for the
   * whole of every request a session makes after a rollover — a routine false
   * positive on the one signal that is supposed to mean the feature is failing
   * silently, which trains an operator to ignore it.
   *
   * A gauge read straight off the live state rather than a counter of its own:
   * an event that goes away with the pin it belonged to has stopped being owed,
   * and a counter would keep claiming it.
   */
  pendingCount() {
    let owed = 0;
    for (const [bucket, byAccount] of this.pending) {
      const acceptedIdx = this.served.get(bucket);
      for (const idx of byAccount.keys()) {
        if (acceptedIdx == null || acceptedIdx === idx) owed += 1;
      }
    }
    return owed;
  }

  /**
   * A request spending `buckets` was SERVED by `acceptedIdx` — the response the
   * client got, not an attempt that went on to retry somewhere else.
   */
  noteServed(acceptedIdx, buckets) {
    for (const bucket of buckets) this.served.set(bucket, acceptedIdx);
  }

  /**
   * Resolve every pending rollover against where its bucket was last served, and
   * return how many of them a move actually resolved — the count of preemptions
   * that happened, as distinct from the ones selection asked for.
   *
   * A bucket served off the rolled account is one the preemption moved, so bank
   * its post-rollover window and drop the event. A bucket whose last service
   * came back to the rolled account — a retry that failed over and back, or a
   * sibling request that raced ahead and was then overtaken — moved nothing that
   * stuck, so it stays owed and the next request preempts again. A bucket
   * nothing served settles nothing.
   *
   * Called when the sticky choice is next quiescent, which for a session means
   * its last in-flight request has ended: an earlier settlement can be undone
   * by a slower sibling that fails back, so the answer is only stable once no
   * attempt is left to change it.
   */
  settleServed() {
    let moved = 0;
    for (const [bucket, byAccount] of [...this.pending]) {
      const acceptedIdx = this.served.get(bucket);
      if (acceptedIdx == null) continue;
      for (const [idx, owed] of [...byAccount]) {
        if (acceptedIdx === idx) continue;
        writePair(this.windows, bucket, idx, { window: owed.window, reset: owed.reset });
        deletePair(this.pending, bucket, idx);
        moved += 1;
      }
    }
    this.served.clear();
    return moved;
  }

  /** noteServed + settleServed, for a sticky choice with no quiescent point of
   * its own: the global current account is shared by every request, including
   * the ones carrying no session id, so there is nothing to wait for. Returns
   * settleServed's count of events a move resolved. */
  commitOn(acceptedIdx, buckets) {
    this.noteServed(acceptedIdx, buckets);
    return this.settleServed();
  }

  /** Renumber after the account list shifts, dropping whatever named the account
   * that went away. Returns false once nothing is left, so the caller can drop
   * the watcher whole. */
  remap(mapFn) {
    remapPairs(this.pending, mapFn);
    for (const [bucket, idx] of [...this.served]) {
      const moved = mapFn(idx);
      if (moved == null) this.served.delete(bucket);
      else this.served.set(bucket, moved);
    }
    remapPairs(this.windows, mapFn);
    return this.windows.size > 0 || this.pending.size > 0;
  }
}
