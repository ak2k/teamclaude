// Rollover bookkeeping for a sticky routing choice, in its own module so both
// the AccountManager (for the global current account) and a SessionTracker
// record (for a pinned session) can hold one without importing each other.

// How far a weekly reset must move forward to count as that window rolling over
// rather than the same window re-reported. The two writers of a reset disagree
// on precision — a response header carries whole seconds, the usage endpoint a
// fractional ISO timestamp — so one instant reaches the detector as two values
// up to a second apart, and any strictly-forward test reads that as a rollover
// and re-routes every sticky session for nothing. A real weekly roll moves the
// window by a week, so an hour is a floor no genuine event can fall under.
export const ROLLOVER_MIN_JUMP_MS = 3600_000;

/**
 * Rollover bookkeeping for one sticky choice — a session's pins, or the global
 * current account. Everything here is PER BUCKET, because a session's pins are:
 * its Opus traffic and its Fable traffic can sit on different accounts, so
 * "the account this choice was last seen on" is a question per bucket and not
 * per session. Each entry in `windows` therefore carries its own account, which
 * is the invariant that makes the numbers comparable — a reset is only ever
 * measured against one previously seen on the SAME account for the SAME bucket.
 *
 * A detected rollover is kept PENDING rather than applied. The preemption it
 * asks for only really happens once a request is served somewhere else, and a
 * request can be re-routed several times before that: it excludes an account
 * that just failed, and it re-pins its session on every attempt. Consuming the
 * event at detection time means a retry that fails back onto the rolled-over
 * account banks a move that never happened, and the session then rides that
 * account until its window rolls again a week later.
 */
export class WindowWatcher {
  constructor() {
    // window key -> { idx, reset }: the reset last seen for that window, and
    // the account it was seen on.
    this.windows = new Map();
    // request bucket -> { idx, window, reset }: rollovers found but not acted
    // on. Keyed by the REQUEST's bucket, not the window's, because that is what
    // decides which later request can consume the event — only traffic for the
    // same bucket moving off `idx` settles it.
    this.pending = new Map();
  }

  /** Record `resets` as the baseline for account `idx`. Seed-only for windows
   * already seen on this same account, since overwriting one here would erase a
   * jump nothing has acted on yet; a window last seen on a DIFFERENT account is
   * replaced outright, because comparing across accounts is never a rollover. */
  seed(idx, resets) {
    for (const [key, reset] of Object.entries(resets)) {
      if (reset == null) continue;
      const seen = this.windows.get(key);
      if (!seen || seen.idx !== idx) this.windows.set(key, { idx, reset });
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
   * window past a rollover it has found. Only commitOn does that, and only once
   * a preemption has actually moved a request. That is the invariant that lets
   * detection run on every selection pass, including one that cannot act on
   * what it finds: looking costs the event nothing.
   */
  rolledOver(idx, bucket, window, resets) {
    // Still owed from an earlier pass: re-report it rather than re-deriving it
    // from a baseline that a re-pin may since have moved.
    const owed = this.pending.get(bucket);
    if (owed && owed.idx === idx) return true;
    const seen = this.windows.get(window);
    const prev = seen && seen.idx === idx ? seen.reset : null;
    this.seed(idx, resets);
    const now = resets[window] ?? null;
    if (prev == null || now == null || now - prev <= ROLLOVER_MIN_JUMP_MS) return false;
    this.pending.set(bucket, { idx, window, reset: now });
    return true;
  }

  /**
   * A request spending `buckets` was served by `acceptedIdx`. For each of those
   * buckets, a rollover pending on any OTHER account is one this request moved
   * off, so bank its post-rollover window and drop the event; one pending on the
   * accepted account itself was not acted on — the re-route came back — and
   * stays owed for the next request. A bucket this request did not spend is left
   * alone: it moved no traffic for that family, so it settles nothing.
   */
  commitOn(acceptedIdx, buckets) {
    for (const bucket of buckets) {
      const owed = this.pending.get(bucket);
      if (!owed || owed.idx === acceptedIdx) continue;
      const seen = this.windows.get(owed.window);
      if (seen && seen.idx === owed.idx) seen.reset = owed.reset;
      this.pending.delete(bucket);
    }
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
    for (const [key, seen] of [...this.windows]) {
      const moved = mapFn(seen.idx);
      if (moved == null) this.windows.delete(key);
      else seen.idx = moved;
    }
    return this.windows.size > 0 || this.pending.size > 0;
  }
}
