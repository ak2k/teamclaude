# Accepted-residual register

Consciously accepted tradeoffs, verified and argued once so reviews stop
re-flagging them. Cite entries by ID in review output ("suppressed per
TC-003"). Rules:

- **Adding**: a review that ACCEPTS a new residual adds the entry in the
  same PR (id, date, one-line risk, why accepted, where argued). Without
  the entry, the next review re-litigates it.
- **Pruning**: each entry names the code it describes; if that code is gone
  or the tradeoff is fixed, delete the entry in the fixing PR.
- **Challenging**: entries are decisions, not laws. To overturn one, argue
  it where it was decided — not by re-flagging it in review. Precedent:
  the `ENOTFOUND` failover below was carried as a residual for exactly one
  round, then overturned on its merits (a DNS failure cannot be
  account-specific, so failing over burns the fleet and makes a network
  blip present as an outage) and fixed. That is the intended lifecycle.

| ID | Residual | Why accepted | Argued at | Added |
|---|---|---|---|---|
| TC-001 | `ctx.tried` / `ctx.reauthed` / `ctx.pinnedIndex` hold account indices for the life of a request; a removal mid-request leaves them naming a different account (`tried` excludes the wrong one, `pinnedIndex` forces whoever took the slot) | Narrow window, impact is one misrouted request and no data loss. `removed.index = -1` closes the late-call half. Closing the rest needs re-resolution by name per attempt (the MITM pin already does this) or a generation stamp on the account list — a design change to request handling that wants its own review round | Round 5, user decision | 2026-08-18 |
| TC-002 | The 60s stuck-rollover log throttle (`_noteStuckRollover`) is untested — widening it to 600s breaks nothing | It reads the wall clock where the rest of the tracker takes an injectable `now`; adding a clock parameter for one log throttle is a source change that exists only to be tested. What IS held: the line's content and its per-(account, bucket) key | Round 5 (AM49) | 2026-08-18 |
| TC-003 | About ten fixtures sit exactly on the pressure band's tolerance boundary — the recurring `a{0.5, 50h} / b{0.1, 60h}` pair, where `0.5/(50·3600)` is *exactly* `(0.9/(60·3600))/1.5` in float | Deterministic today: a fixture is always built before it is scored, so elapsed time is non-negative and the account stays in band. Not flaky, and rewriting ten fixtures late in a branch is churn. Both fixture helpers carry a comment saying that moving the default `tolerance` or the pressure formula moves them all at once | Round 4, user decision | 2026-08-18 |
| TC-004 | The first time an account reports family utilization, a genuine roll of the *shared* window coincident with that flip is not seen by the family bucket | The shared bucket has its own baseline and detects the same roll, so the session still preempts, and from that point the family bucket has its own window governing it — which is the right answer going forward. One missed preemption, on one bucket, once, at a real transition. Closing it means comparing across windows, which invariant 2 forbids | Round 5 (Case A), measured with `repro-coincident.mjs` | 2026-08-18 |
| TC-005 | A handful of mutation-table rows survive as **equivalent mutants** — unobservable given the rest of the code, not untested. Currently: the advisor predicate asserted on the session path (no path can produce the divergence today), and the `_isActive` guard in `_pinsInclude` (implied by `lastSeen >= pin.at`) | Each was argued individually and at least one was confirmed by 30,041 randomized trials against a generator *proven* able to produce the divergence elsewhere. **This list is anchor-relative and must be re-derived after any rewrite** — a previous list evaporated with the session that made it, and the tables reported zero survivors afterwards, so nobody could check it | Rounds 4-5 | 2026-08-18 |
| TC-006 | `res.destroyed` is inert on the HTTP/2 (MITM) path: `Http2ServerResponse` has no `destroyed` property at all, before or after `res.destroy()`. Affects the outer catch's guard and, pre-existing, `streamResponse`'s break and four retry guards | Measured byte-identical on the patched and unpatched trees, so not introduced here. Harmless in the outer catch (writeHead+end on a dead h2 stream is a measured silent no-op). The pre-existing sites are upstream's and outside this change; an h2 client cancelling mid-stream leaves the proxy pulling the remainder for ~1s | Round 5 (F2), `p5-h2-guard.mjs` / `p6-h2-cancel.mjs` | 2026-08-18 |

Not residuals (never report, no ID needed): anything `npx eslint .`
enforces.
