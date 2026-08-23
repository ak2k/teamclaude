# Mutation testing: how the instrument lies

The routing and session code in this repo is held by mutation tables — undo a
fix, or drop an argument from a call, and some test must fail. The tables found
real defects. They also, five separate times, reported health while measuring
nothing.

That second thing is the durable lesson, because it is the same failure the
tables exist to catch: **green because nothing was checked, not because nothing
was wrong.** Anyone extending a mutation harness here should read this first —
the summary line is not the whole answer.

## Why mutation testing is used here at all

A suite of 592 tests was green while the production wiring in `src/server.js`
was deletable. Removing the `confirmRouted` call, or dropping `recordSession`'s
model arguments, changed nothing the suite noticed — because the tests drove a
helper that reimplemented the server's call sequence rather than the server. The
tests validated their own ordering.

So the rule for anything at that seam: a test that does not FAIL when the call
is deleted, or when each of its arguments is dropped, is not covering it. Verify
that by performing the mutation, not by reading the test.

## The six ways the harness reported success while measuring nothing

**1. The test exercised a helper, not the code.** As above. A test can be
detailed, readable and entirely about a reimplementation of the thing it names.
The mutation is the only way to tell.

**2. Missing anchor.** A mutation is find-and-replace on source text. When the
code moves, the find-text stops matching and the mutation is silently not
applied — reported as a skip beside a healthy count. This degrades exactly when
the code changes, which is when the table is most worth running. Two mutations
lost their anchors to an unrelated commit that reflowed the lines they matched;
both read as skips next to a passing table. **A harness must exit non-zero and
name them.**

**3. Missing file.** Worse than a missing anchor and a different code path: an
unhandled `ENOENT` aborts the loop, so every mutation after it never runs. The
result is a short table that still looks clean — the denominator shrinks and
nothing says so. Report it like any other unapplied mutation.

**4. Runaway.** Some mutations do not make the suite fail, they make it never
finish. Dropping the per-request exclusion set turns failover into an unbounded
retry loop: the suite spins instead of failing. A run that has to be killed is a
caught mutation, not a passing one — but only if the harness says so.

**The mechanism was measured and it is not what this section assumed.** The
paragraph above described an unbounded loop hitting a wall clock. Three
instrumented repetitions of the exclusion-set row, same tree, same machine, on
every field the verdict reads:

```
rep 1  ENOBUFS    98,211ms  65,135,482 bytes  fails-matched=0   -> RUNS AWAY
rep 2  (no code)  12,622ms   7,810,845 bytes  fails-matched=12  -> DIES
rep 3  ENOBUFS   107,484ms  65,135,443 bytes  fails-matched=0   -> RUNS AWAY
```

`killed=undefined` and `signal=null` in all three: **the 180s timeout never
fired, in any observation.** Nothing was unbounded and nothing was killed. Rep 2
finished in twelve seconds naming twelve failing tests. What actually happened is
that the mutation makes the suite enormously chatty, and whether it out-ran a
64 MiB pipe buffer before finishing was a race — won a third of the time. Losing
it produced a 65 MB head containing no failure markers at all, which without the
`ENOBUFS` rule would have read **SURVIVES** on the most important seam argument
in the table.

**The verdict was a coin flip, and the earlier load-average story was a
correlation.** Load makes losing the race likelier; it is not the mechanism.

Fixed by writing the child's output to a **file** rather than a pipe buffer,
which has no such limit. The row now grades DIES deterministically with its
twelve named tests. `RUNS AWAY` survives as a verdict for a genuine timeout and
**currently has no members**. The `ENOBUFS` branch is kept although a file
cannot raise it: it costs nothing and it is what stood between that row and a
false green.

*The wider lesson, which cost a day:* a verdict computed from four triggers and
printed as one word cannot be debugged by looking at the word. Three repetitions
with the fields printed settled in eight minutes what argument had not settled in
a day. **In every flooded run the row also contributed zero named tests**, so its
fingerprint was empty — and an empty fail-set is invisible to the duplicate
detector, the one check aimed at coverage claims. It was carried as verified
coverage *and* exempted from the check that would have questioned it.

**Rule: check load and clear strays before trusting any verdict from this table,
and treat a lone SURVIVES on a busy machine as unmeasured rather than
measured.** Repeating the row does not help — every re-run inherits the same
contaminated machine, so repetition confirms the artifact instead of exposing
it. Vary the suspected condition instead: interleave the trees, clean between,
and see whether the difference tracks the tree or the box.

*Open item, with the disambiguation already named:* whether to widen the window
or key detection on something load-independent. Nobody has decided. The cheap
next step is to apply the mutation by hand and watch whether the suite hangs or
completes — if it completes, the loop became bounded at some point and this
entry is stale, which is the more interesting outcome, because a bound nobody
designed is a bound nobody is holding.

**5. Truncated output.** The runaway above logs as it spins and exceeded the
child process's default 1 MB stdout buffer in 1.6 seconds. The captured head
then contained no failure markers at all, and the harness — grepping that head
for failures — reported the mutation as SURVIVED. A false clean bill on the
exact gate built to prevent false clean bills. Treat `ENOBUFS` as a runaway, and
raise `maxBuffer` well past a normal run's output.

**6. The result is absence-shaped.** Entries 2 to 5 are one class in different
clothes, and naming it is what lets you recognise the next door before it costs
a run. A verifier has three outcomes and two values. Only *fail* carries
positive evidence: a captured failure signal, a named test, a non-zero exit.
*Pass* and *did-not-measure* are both the absence of that signal, the same
value. Instrument faults are therefore not spread evenly between red and green.
They are systematically green, and green is the state nobody investigates.

Two more doors, beyond the missing anchor and the missing file already listed:

*The mutant does not parse.* Replacing an opening token can orphan the block it
opened: `try {` swapped for `if (true) {` leaves a bare `} catch (…) {` and the
file is a SyntaxError. Every test file then fails to load, and the harness reads
that wall of failures as a caught mutation. One row had reported a kill on every
run since it was written. Run `node --check` on each mutant and grade a
non-parsing one as broken.

**Now implemented**, and worth reading as a worked example of choosing a check
over a heuristic. The alternative was to classify by whether the failures look
file-level, and this harness already had a section doing a version of that — and
it missed the very row that motivated it, because it fires only when NO named
test failed, and one had survived among the failures the display truncated away.
That is a heuristic over output with a known counterexample. `node --check` is a
decision about the bytes: deterministic, no counting, and it runs BEFORE the
suite, so a broken row stops in a tenth of a second rather than after a full run.
The verdict is `INVALID`, which is ungraded — neither caught nor survived — and
fails the run. A committed control row carries a deliberately unparseable edit
with expected verdict `INVALID`, so the ability to emit it is checked every run
rather than the next time somebody breaks a file by accident.

*The run stalls.* A missing summary line is not a pass and is not a kill. Grade
a stalled mutant INDETERMINATE, re-run it, and never score it. Only a deadline
kill measured against a known baseline is evidence of a runaway, and a loaded
box will forge that evidence, so reproduce it before believing it. A stall also
leaves the mutation applied; see "A clean tree is not your tree" below for what
that costs the next run.

Two habits make the whole class rarer: replace whole balanced blocks instead of
opening tokens, and attribute every kill to the named tests that failed, so an
instrument fault reads as a list of file names instead of the one or two
behaviour names a real kill produces.

A seventh, adjacent: a duplicated row in the mutation table over-reported 23
mutations as 22 for several runs. Count what you ran, not what you listed.

**A summary line is a claim, and it must be computed from the same data as the
check below it.** Otherwise it is a second opinion dressed as a heading, and it
is read first. Three instances in this project inside one week: `59/59 mutations
die` printed over a run containing a row that had run away; `2 controls as
expected` printed one line above the error saying one was not; and a freeze line
calling six residuals recorded when three of them did not exist. Each heading was
assembled separately from the check it summarised, and each was wrong in the
reassuring direction. Derive the sentence from the verdicts, or print the
verdicts and let the reader assemble it.

**An eighth, and it is about the tools you audit with.** A raw control byte in a
source file makes `grep` treat it as binary and match **nothing, silently** — no
error, no warning, exit 1 as though the pattern were simply absent. It has landed
three times in this project, most recently on this harness itself, where a
fingerprint separator written as a literal NUL rather than the escape `'\u0000'`
made the tool invisible to the tool being used to audit it. Three greps returned
empty before anyone ran `file` and saw `data` instead of `UTF-8 text`.

The rule is not "an empty result is a finding about the tool". That is half of
it, and acting on the wrong half is how it costs a round: **an empty result is
equally often a finding about your query, and the two are indistinguishable until
you check both.** Both halves happened here within one hour — a NUL that really
had broken the file, and a case-sensitive pattern against uppercase text that had
not. Check the file type *and* the pattern before concluding either. Write
separators as escape sequences; the point is the escape, not the codepoint.

**And what the green-baseline check does and does not cover.** The harness runs
the suite once before any mutation and aborts if it is not green, because with a
test already red every row reads DIES on that one failure and the table reports
total coverage of code nothing tests. That closes the already-red door outright,
**and** the subset of flaky tests that happen to fail in the baseline run — which
is not hypothetical: it caught a load-sensitive CLI test on its second day,
unprompted, refusing to grade rather than crediting one failure to all 59 rows.

What it leaves: a test that stays green in the baseline and fails inside some
row's own run is still credited to that row, and the per-row subtraction of the
baseline set cannot catch it, because that name was never in the baseline set.
One green baseline establishes that the suite was green once, just now. That is
strictly more than nothing and strictly less than reliability.

## The table can lie even when every mechanism works

Everything above validates the *apparatus*. None of it asks whether a row tests
what its label says — and a row can be specified wrongly while every mechanism
performs perfectly.

The case study is in this repo's own history. A row labelled `endSession moved
out of the finally into the try` carried an edit that simply **deleted** the
call, making it a copy of the row two above it. The anchor matched. The suite
ran. The mutation genuinely died. There was nothing wrong to see in the
machinery, which is what everyone was checking — so a table of 23 rows reported
22 distinct interventions for many runs, and a real defect (the in-flight hold
leaking when the request path throws) sat undetected behind the duplicate.

**Flag any two rows that die on exactly the same set of test names.** It is free:
those names are already collected in order to print them. Two rows the suite
cannot tell apart are, as far as the table can see, one intervention.

It must **flag, not fail**. Rows collapse legitimately: `endSession(null)`
returns early, so dropping the argument and dropping the call *are* the same
edit, and both are tested deliberately. The output is a question — "are these
meant to be indistinguishable?" — and a person answers it. Only a row that
claims a different property while sharing a fingerprint is a defect.

## Checking the checker

The guards above are code, and code can be wrong in exactly the way it exists to
detect. Two people here independently wrote a broken instrument-check on their
first attempt within the same hour — both grepping `^# pass` against a reporter
that emits `ℹ pass`, so the check matched nothing and reported success on every
run.

So keep **one known-caught canary row**: a mutation certain to be caught. Its
value is not that it catches more — it catches less than the per-row guards. It
is that its expected value is known *independently of the run*, which makes it
the only check that still works when the checking logic itself is wrong. If the
known-caught row reads as surviving, the harness is broken and no other number
in the table means anything.

State its limit in the same breath, or it will be trusted past it: **it certifies
the harness on the canary's own path, not per row.** It would not have caught the
truncated-output misread, because a fast-failing canary never blows the buffer —
that row reads as a survivor while the canary reads as caught and the harness
looks healthy. Truncation is caught per row by "did the observation complete",
not by any canary.

A known-*survivor* canary row is unnecessary. It asserts the same thing as a
green unmutated baseline run at the start of the table, which you need anyway: if
the suite is red or flaky before any mutation is applied, every row reads as
caught and the whole table is meaningless in the confident direction.

### A gate that catches both a defect and real work is worse than no gate

Two guards here were written, fired on legitimate rows, and had to be narrowed.
Both narrowings are the point, not the guards.

**Uniform failure.** A mutant that breaks itself fails everything, and a wall of
failures reads as a confident kill. So flag any result whose failures span more
than half the test files, or where every failure across files is a single
exception class — *a signal too uniform to be information*. First version of that
rule said "any non-assertion class across files", and it immediately misgraded a
real kill: a mutation that removed a published field made its consumers throw
`TypeError`, and **that TypeError was the property**, not a broken mutant. The
consumer failing *is* what the row exists to demonstrate. Narrowed to
`ReferenceError` only, which is the class a mutant naming something that does
not exist actually produces. Keeping it narrow costs coverage of hypothetical
shapes and buys not misgrading real work — the trade a gate has to win, or it
gets ignored, and an ignored gate is worse than an absent one because it still
reads green.

**The parse gate answers "does it parse", not "is it a mutation".** `node --check`
catches the orphaned-block mutant, and it passes happily on a mutant that
references an undefined name — which then fails every test file with a
`ReferenceError` and reads as a kill. The two guards are complementary and
neither replaces the other: parse-check for syntax, uniform-failure for a mutant
that broke itself at runtime.

Verify each guard the same way as the harness: with a deliberately broken row
built to trip it, and a genuine row that must stay caught. A guard that has only
ever been *run* has not been *verified*, and one that has only ever been seen to
**refuse** has not been seen to **permit**.

**A green instrument tells you nothing until you have seen it go red, and a full
table tells you nothing until you have checked that its rows differ.**

## The harness can hang the thing grading it

A test that waits for a condition the production code normally produces will
wait forever under a mutation that changes it. One test here waits for a
rollover preemption to reach a second account; under a routing mutation it never
arrives. Bound every such wait and release every latch in a `finally`, or the
mutation run hangs instead of reporting — indistinguishable, from the outside,
from a slow pass.

## A clean tree is not your tree

The harness rewrites source in place: mutate, run, restore. That is safe in a
tree nobody else is reading and destructive in one they are. A dirty-tree
refusal does not protect against this, because a shared checkout is usually
clean — which is precisely how a "safe" run corrupts a tree other people are
reading, for one suite run at a time, repeatedly.

The property to test is ownership, not cleanliness. Require an explicit,
never-committed marker in any tree the harness may mutate, so the default is
refusal for every tree including the one you are standing in:

    git worktree add --detach <path> <ref>
    touch <path>/.mutation-sandbox

Also: a kill between write and restore leaves the mutation behind. The harness
can only restore what it read, so if it dies mid-cycle, check `git status`
before trusting the tree.

## And `git status` clean is not the tree being right

The counterpart to the section above, and the one that cost the most here.
Everything else in this document is *absence* — a signal that never arrived.
This one is presence wearing absence's clothes: state that is wrong **precisely
because it was successfully recorded**.

A `node_modules` symlink pointing at an absolute path inside another agent's
scratch worktree was committed into a change. `git status` read clean, and the
report said "tree clean" in good faith, because a committed file is not a dirty
file. Suite, eslint, both mutation tables and the differential fuzz were all
indifferent to it. It shipped, and the same fault survived into the *next*
commit after the class had been named.

The mechanism generalises past the instance: `.gitignore` said `node_modules/`
**with a trailing slash**, which matches a directory. A symlink of that name is
not a directory, so the rule never matched it and `git add -A` took it. Drop the
slash.

The check is one line, and belongs in the battery beside the others:

    git ls-files -s | awk '$1 == "120000"'   # every committed symlink

then resolve each target and fail on any that is **absolute** — not merely on
ones escaping the repo, because an absolute path cannot be correct in another
checkout even when it happens to resolve in this one — or that lexically escapes
the repo root. Resolve **lexically**, with no `stat`: a verdict that depends on
whether the target exists on the machine running the check is a verdict that
moves with the checkout.

Capture its red against a commit that still carries a fault. That free failing
case expires the moment you fix it, and a gate nobody has watched fire is an
assumption.

The rule underneath, worth more than the check: **any all-clear computed as a
difference — clean tree, empty diff, no new findings — reports success once the
unwanted thing has been absorbed into the baseline it compares against.** Ask
what the baseline would have to contain for the check to stay quiet while being
wrong, and check that separately.

## Known equivalent mutants

Both committed tables report zero survivors, which is the state you want and
also the state that erases information: a survivor that was *investigated and
found harmless* is indistinguishable, in a clean table, from one nobody ever
wrote. These are the mutations that survive a wider table than the two here —
each checked and found unobservable, with the argument, so the next person can
disagree with the reasoning instead of rediscovering the row.

An equivalent mutant is not a coverage gap. Writing a test to kill one means
asserting an implementation detail that no behaviour depends on, which is a test
that will fail the next time somebody refactors correctly.

| Mutation | Why nothing can observe it |
|---|---|
| `advisorServed = true` without an advisor model | Only read under `if (advisorModel && …)` in `_requestBuckets`. |
| `_requestBuckets` stops de-duplicating executor and advisor buckets | The consumers are `Map`s (`s.pins`, `served`); a repeated bucket writes the same key twice. |
| `confirmRouted` drops its `if (sessionId)` guard | `windowsFor(null)` returns null and the call is `?.`-chained. |
| `endSession` runs for a session the tracker no longer has | The substituted record has `windows: null`, so `windows?.settleServed()` is a no-op. |
| `beginRequest` stops refreshing `lastSeen` | A record with a request in flight is active and non-expirable whatever `lastSeen` says, and `endRequest` sets it again on the way out. |
| `activeCountFor` drops its `_isActive` guard | `_pinsInclude` is true only if `now - pin.at <= activeTtlMs` (and `lastSeen >= pin.at` always, since `touch` sets both and `lastSeen` only moves forward) or if `inFlight > 0`. Either implies `_isActive`. The guard is defensive, not load-bearing. |
| `stats()` reports `known` as the raw map size | The loop deletes expired records *before* the return, so the two are equal by construction. |
| `ctx.decision ??= {}` instead of `= {}` | Every `getActiveAccount` path that can reach a flag writes both flags, and the `/tc-acct/` path never calls it. |
| `beginSession` moved inside the inner `try` | Both catches now answer the socket, so this only changes which one handles it. |

One that is NOT equivalent and is deliberately unheld: the stuck-rollover log
throttle's one-minute window. It reads the wall clock directly where the rest of
the tracker takes an injectable `now`, so widening it breaks no test. Adding a
clock parameter for one log throttle would be source that exists only to be
tested. The line's content and its per-(account, bucket) key are both held; the
duration is not.
