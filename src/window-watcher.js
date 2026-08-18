// Rollover bookkeeping for one sticky routing choice — a session's pins, or the
// global current account.
//
// A window is identified by (accountIndex, windowKey), never by the key alone.
// The key collapses to `unified7d` for any bucket whose family reset the
// account does not report, so two buckets of one session can resolve to the
// same key while sitting on DIFFERENT accounts; a map keyed by the window alone
// merges them, and each overwrites the other's baseline until no rollover is
// detectable for either. A reset is only ever compared with one previously seen
// on the SAME account for the SAME window.
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

export class WindowWatcher {
  constructor() {
    // window key -> account index -> the reset last seen for that window there.
    this.windows = new Map();
    // request bucket -> { idx, window, reset }: rollovers found but not acted
    // on. Keyed by the REQUEST's bucket, not the window's, because that is what
    // decides which later request can consume the event — only traffic for the
    // same bucket moving off `idx` settles it.
    this.pending = new Map();
    // request bucket -> the account that most recently SERVED it (noteServed).
    // A selection is not a service: an attempt can be re-routed and re-pinned
    // several times, and only the response the client actually gets says where
    // the traffic went.
    this.served = new Map();
  }

  /** Record `resets` as the baseline for account `idx`. Seed-only per
   * (window, account): overwriting one here would erase a jump nothing has
   * acted on yet. A window last seen on a different account is a separate
   * entry, so there is nothing to replace. */
  seed(idx, resets) {
    for (const [key, reset] of Object.entries(resets)) {
      if (reset == null) continue;
      let byAccount = this.windows.get(key);
      if (!byAccount) this.windows.set(key, byAccount = new Map());
      if (!byAccount.has(idx)) byAccount.set(idx, reset);
    }
  }

  /**
   * Has the window `window` on account `idx` rolled over since we last looked,
   * for a request governed by `bucket`? `resets` is every governing window the
   * account reports right now — all of them are seeded, not just the one this
   * request is governed by, or a session that has only ever sent Opus would
   * first-sight its Fable window on the very request that should have caught it
   * rolling.
   *
   * This writes — it seeds a first-sight baseline — but it never advances a
   * window past a rollover it has found. Only settleServed does that, and only
   * once a preemption has actually moved a request. That is the invariant that
   * lets detection run on every selection pass, including one that cannot act
   * on what it finds: looking costs the event nothing.
   */
  rolledOver(idx, bucket, window, resets) {
    // Still owed from an earlier pass: re-report it rather than re-deriving it
    // from a baseline that a re-pin may since have moved.
    const owed = this.pending.get(bucket);
    if (owed && owed.idx === idx) return true;
    const prev = this.windows.get(window)?.get(idx) ?? null;
    this.seed(idx, resets);
    const now = resets[window] ?? null;
    if (prev == null || now == null || now - prev <= ROLLOVER_MIN_JUMP_MS) return false;
    this.pending.set(bucket, { idx, window, reset: now });
    return true;
  }

  /**
   * A request spending `buckets` was SERVED by `acceptedIdx` — the response the
   * client got, not an attempt that went on to retry somewhere else.
   */
  noteServed(acceptedIdx, buckets) {
    for (const bucket of buckets) this.served.set(bucket, acceptedIdx);
  }

  /**
   * Resolve every pending rollover against where its bucket was last served.
   * A bucket served off the rolled account is one the preemption moved, so bank
   * its post-rollover window and drop the event. A bucket whose last service
   * came back to the rolled account — a retry that failed over and back, or a
   * sibling request that raced ahead and was then overtaken — moved nothing
   * that stuck, so it stays owed and the next request preempts again. A bucket
   * nothing served settles nothing.
   *
   * Called when the sticky choice is next quiescent, which for a session means
   * its last in-flight request has ended: an earlier settlement can be undone
   * by a slower sibling that fails back, so the answer is only stable once no
   * attempt is left to change it.
   */
  settleServed() {
    for (const [bucket, owed] of [...this.pending]) {
      const acceptedIdx = this.served.get(bucket);
      if (acceptedIdx == null || acceptedIdx === owed.idx) continue;
      this.windows.get(owed.window)?.set(owed.idx, owed.reset);
      this.pending.delete(bucket);
    }
    this.served.clear();
  }

  /** noteServed + settleServed, for a sticky choice with no quiescent point of
   * its own: the global current account is shared by every request, including
   * the ones carrying no session id, so there is nothing to wait for. */
  commitOn(acceptedIdx, buckets) {
    this.noteServed(acceptedIdx, buckets);
    this.settleServed();
  }

  /** Renumber after the account list shifts, dropping whatever named the account
   * that went away. Returns false once nothing is left, so the caller can drop
   * the watcher whole. */
  remap(mapFn) {
    for (const [bucket, owed] of [...this.pending]) {
      const moved = mapFn(owed.idx);
      if (moved == null) this.pending.delete(bucket);
      else owed.idx = moved;
    }
    for (const [bucket, idx] of [...this.served]) {
      const moved = mapFn(idx);
      if (moved == null) this.served.delete(bucket);
      else this.served.set(bucket, moved);
    }
    for (const [key, byAccount] of [...this.windows]) {
      const moved = new Map();
      for (const [idx, reset] of byAccount) {
        const to = mapFn(idx);
        if (to != null) moved.set(to, reset);
      }
      if (moved.size) this.windows.set(key, moved);
      else this.windows.delete(key);
    }
    return this.windows.size > 0 || this.pending.size > 0;
  }
}
