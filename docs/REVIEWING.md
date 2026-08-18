# Reviewing changes to routing and session state

Repo-specific review guidance. Read this BEFORE reviewing a diff that
touches account selection, session pinning, rollover detection or the
request lifecycle; it encodes what generic review instincts miss and what
past reviews keep re-deriving. [`docs/routing.md`](routing.md) is
authoritative over this file for *behaviour*; this file is authoritative
over generic review heuristics.

Provenance: the invariants below come from five review rounds over the
expiry-pressure routing work. Each names the incident that produced it.
Rounds 1 and 2 fixed defects one at a time and round 3 found the same root
causes one level deeper each time — the numbered list exists so round 6
does not re-find round 5. Corridors without a named precedent have simply
not had an incident yet; treat them with equal weight, and when a review in
a new corridor fires a finding, add the precedent here in the same PR.

## What this subsystem is, in one review-relevant sentence

A router that spends real money-equivalent quota across accounts that are
not interchangeable — each has its own credential, its own per-model-family
windows, and its own reset clock — so state keyed to the wrong account, or
a fact recorded about the wrong window, spends the wrong budget or sends
the wrong credential upstream, and both fail silently.

## Severity calibration (what P0-P3 mean HERE)

Reserve **P0** for:
- A request served on an account that cannot serve it, or one account's
  refreshed credential written onto another (`_onTokenRefresh` and the
  in-memory `account.credential` are two separate halves — check both)
- An unanswered socket. The client waits out its own timeout, which for
  Claude Code is long; there is nothing for it to act on
- Quota or concurrency credited to an account that did not serve the request

**P1**: a rollover that is silently *not* detected (the feature's whole
purpose, and `rolloversDetected` stays 0 so the gauge reads exactly like a
healthy idle fleet); any divergence from upstream with `expiryRouting` off;
a session pin relocating traffic onto an account never evaluated for that
model; unbounded growth in a process that runs for weeks.

**P2**: counters that can misreport, observability that misdirects an
operator, reachable-but-narrow races.

**P3 / nit**: style. Anything `npx eslint .` enforces is NOT a finding at
any severity.

## Always check (invariants no linter expresses)

1. **Window state is keyed by `(requestBucket, accountIndex)` — never by
   the resolved window.** `_windowForBucket` (`src/account-manager.js:1190`)
   is **not injective**: it collapses a family bucket onto `unified7d`
   whenever the account reports no utilization for that family, which is
   the ordinary case on a fleet that never sends Fable. Any map keyed by
   the resolved window merges state belonging to different buckets.
   *Precedent: three separate defects, and a P1 where settling one bucket
   settled another that happened to share a window.*

2. **Never derive an identity from a value the event itself nulls.**
   `_windowForBucket` decides on the *utilization*, and
   `_clearExpiredQuotas` nulls the utilization and the reset together at
   the reset instant — so one family rollover presents as **two** window
   changes (collapse onto `unified7d`, then back), and a rule that treats a
   changed window as a first sight eats both halves. The rollover
   manufactures the window change that hides it. When state is keyed by a
   derived value, ask what nulls or rewrites that value, and whether the
   event you care about is what does it.
   *Precedent: the round-5 P1 — family weekly rollovers were never detected,
   permanently, on a tree where 723 tests passed. No type system catches
   this one; it is a design question.*

3. **One validating writer for `currentIndex`.** `_setCurrent`
   (`:287`) is it; `setCurrentAccount` (`:300`) is the public entry.
   Setting the account and seeding its rollover baseline are one act, so a
   raw assignment leaves an account current with no baseline and its next
   request reads a first sight as a jump.
   *Precedent: the switch endpoint and the TUI both bypassed it, under a
   docstring asserting they did not.*

4. **A counter names one event, counted once, at that event.** Increment at
   the *move*, not at the decision to move — a re-route that fails back was
   banked as a preemption and the gauge could report more moves than there
   were rollovers. Sites: `:652`, `:1129`, `:1185`.
   *Precedent: `rolloversPreempted` could exceed `rolloversDetected`;
   measured at 4 of 240 checkpoints before the fix.*

5. **Every runtime structure keyed by account index is remapped on
   removal.** An un-shifted index does not fail — it quietly names its
   neighbour. The remap block is `removeAccount` (`:1912`); the removed
   record gets `index = -1` so a request already past selection no-ops
   instead of crediting the wrong account.
   *Precedent: closed twice, and re-opened twice — the stuck-log throttle
   was missed under a comment claiming the block covered "every runtime
   structure keyed by account index".*

6. **The predicate that constrains selection and the one that records what
   was served are the same predicate.** Two derivations of one fact drift.
   `_canServeAdvisor` is shared by `_isAvailable`'s advisor arm and
   `decision.advisorServed` for this reason.
   *Precedent: the exhausted-fleet last resort selected an account by route
   allowance alone, then reported it as having served an advisor family
   upstream refuses.*

7. **Every error path answers the socket.** There are two outer catches.
   `src/server.js:546` answers 502, guarded on `!res.headersSent &&
   !res.destroyed` — the guard is load-bearing twice over: the inner
   `finally` runs `onRequestEnd` *after* the response has streamed, and a
   second `writeHead` there throws `ERR_HTTP_HEADERS_SENT` from inside the
   recovery. `src/server.js:194` (`createProxyServer`'s own handler) is
   still log-only. A `finally` that closes activity state belongs with it:
   a throw between the two `try`s otherwise leaks one entry per aborted
   request, forever, in a daemon that runs for weeks.
   *Precedent: `/tc-acct/%/v1/messages` — a malformed percent-escape in an
   ordinary request line — hung the client permanently.*

8. **A fixture must reach the branch, AND its state changes over time.**
   These are different questions and only the first is obvious. A fleet
   whose accounts meter no family bucket cannot reach family-bucket code at
   all; a fixture that sets up step 1 and jumps to step 3 reaches the branch
   but never observes the intermediate state. Fixtures should assert their
   own premise (`test/collapsing-fleet.js` fails loudly if the fleet stops
   collapsing), and a helper should take the in-gap request as a *required
   argument* rather than warn in a comment that it is needed.
   *Precedent: three unreachable fixtures — a fleet where no bucket
   collapsed left four wrong keyings indistinguishable; a family bucket
   that metered nothing hid a P1 behind 723 green tests; a test named for a
   streamed response answered `application/json`. And the fix for the last
   of those had its first fixture miss the regression for reason two, under
   a comment its own author had written warning against exactly that.*

9. **Comments describe enforcement that exists.** A comment claiming a
   check the code does not perform is a finding: the next reader skips
   verifying it. Verify the mechanism named is the mechanism in the code.
   *Precedent: the single-writer docstring in invariant 3 and the remap
   comment in invariant 5 were both false when written.*

10. **Deliberate non-behavior gets pinned.** When the decision is "we
    intentionally do NOT do X", pin it with a test and say it is deliberate,
    or a later "fix" reverses it silently. Currently pinned: preemption
    fires on a rollover **event** and never on drain (threshold preemption
    was simulated and thrashes the prompt cache for zero quota benefit);
    pressure scores the weekly buckets only (a 5h denominator is ~30x
    smaller and would dominate every comparison); the 403 failover is
    bounded by `ctx.tried`, **not** `retryCount` — adding the guard its
    sibling paths have would stop failover while healthy untried accounts
    remain.

11. **An instrument's green is not a result until you have seen it go red.**
    A mutation table that exits non-zero with `ANCHOR MISSING` rows
    certifies **nothing** for those rows — it happened on the very commit
    that shipped [`docs/mutation-testing.md`](mutation-testing.md) saying
    so, because the rewrite moved the code the anchors named and nobody
    re-ran the table. Equally: a regression test that was never observed
    red is not evidence. Run the new test against the broken tree, or
    mutate the fix and watch the named test fail; reporting only that it
    passes against the fix proves the test runs, not that it detects.

## Danger zones (escalate scrutiny; small diffs, big blast radius)

| Path | Why |
|---|---|
| `src/window-watcher.js` | The keying of invariants 1-2. Bounded at two entries per (bucket, account) only because `_windowForBucket` resolves to itself or `unified7d`; a third answer makes it a growth surface |
| `src/account-manager.js:1190` `_windowForBucket`, `:763` `_governingBucket` | The non-injective resolver every keying bug came through |
| `src/account-manager.js:1912` `removeAccount` | Invariant 5. Renumbering is index arithmetic on live state; two keys can map onto each other, so an in-place pass drops the survivor it just wrote |
| `src/server.js:194` and `:546` | The two outer catches (invariant 7). They are 350 lines apart and only one is fixed |
| `src/account-manager.js:652`, `:1129`, `:1185` | Counter increments (invariant 4) |
| `getStatus()` `:2036`, `getRoutes()` `:1294`, `eligibility()` `:918`, `prober.getStatus()`, `warmer.getStatus()` | Published payloads. A sweep froze 39 fields to constants and **20 survived** the suite — a field asserted in one arm of a boolean, or only at its default, is not asserted |
| `_setCurrent` `:287` / `setCurrentAccount` `:300` | Invariant 3 |

## Do not report (accepted residuals)

The register is [`docs/RESIDUALS.md`](RESIDUALS.md) — read it before
reporting, and cite suppressions by ID ("suppressed per TC-002"). A review
that ACCEPTS a new residual adds its entry in the same PR; without the
entry the next review re-litigates it. To overturn one, argue it on its
tracker item rather than re-flagging it.

Never report anything `npx eslint .` enforces.

## Verification recipes (run these; do not reason from the diff alone)

```sh
node --test test/*.test.js     # 728 tests
node --test                    # 729 — the +1 is test/collapsing-fleet.js,
                               # a 0-test helper node's discovery counts as a file
npx eslint .

# Mutation tables. --repo is required, and the tree must carry an untracked
# .mutation-sandbox marker: these rewrite source in place, and a clean tree
# belonging to someone else is exactly what a "safe" run destroys.
node tools/mutation-fix-table.mjs  --repo=<your worktree>
node tools/mutation-seam-table.mjs --repo=<your worktree>
```

- **Flag-off equivalence is the safety property.** With `expiryRouting`
  absent, selection must be identical to the unpatched tree. Re-derive it
  after any change to keying or selection rather than inheriting a previous
  run's result; a differential against a worktree at the upstream rev is
  what makes "fixed" distinguishable from "changed".
- **Claimed routing behaviour: drive it.** Several confident readings of
  this diff were wrong in both directions. `createProxyServer` with a
  scripted upstream reaches the real seam; a helper that reimplements the
  server's call sequence validates the helper.
- **Timing claims need real elapsed time or an injected clock, not both
  half-way.** A fixture built from one `Date.now()` and compared against
  another is a 1 ms flake; the `manager` helper takes the instant to stamp.
- **A probe that returns nothing is not a negative result.** Empty output,
  a timeout, a grep that matched nothing, a killed process — all read as
  "clean". Confirm the probe found its anchor before believing its verdict.

## Review workflow expectations

- Findings need a concrete failure scenario: inputs/state -> wrong outcome.
  "Could be cleaner" is not a finding here.
- Prefer a runnable reproduction over an argument from the diff, and label
  which one you have.
- Interleave claims: enumerate the actual orderings. `getActiveAccount`
  runs `refreshExpiredQuotas` as its first statement, which is why several
  "races" here are in fact guaranteed sequences.
- When an invariant governs a change, walk **every** site it governs and
  report each one's disposition — already correct, fixed here, or
  deliberately exempt and why. Fixing only the reported instance is what
  produced rounds 2 through 5.

## Review feedback contract (how this doc stays correct)

Every review over this subsystem ends with a short `REVIEWING.md feedback`
block:

- **Checked**: which numbered invariants applied to this diff, and whether
  any fired.
- **Uncovered**: any confirmed finding no invariant covers — propose the
  one-line rule.
- **Register hits**: any near-flag suppressed by a RESIDUALS entry (cite
  the ID) — evidence the register is earning its keep.
- **Dead weight**: any rule read but never actionable across recent
  reviews — a candidate for tightening or deletion.

Accepted candidates land in this doc in the review's fix commit. Without
that loop, skip the ceremony and expect drift.

## Not yet mechanized

bincache/cache pins the falsifiable claims its equivalent doc makes with a
test (`tests/reviewing-doc.test.ts`), so that a code change making the doc
wrong fails CI rather than waiting for an incident. **This doc has no such
test.** Every `file:line` above is therefore a claim that can rot silently
— which is invariant 9 applied to this file, currently unenforced. Treat
line numbers as hints and the symbol names as the real anchors.
