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

## The five ways the harness reported success while measuring nothing

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

**5. Truncated output.** The runaway above logs as it spins and exceeded the
child process's default 1 MB stdout buffer in 1.6 seconds. The captured head
then contained no failure markers at all, and the harness — grepping that head
for failures — reported the mutation as SURVIVED. A false clean bill on the
exact gate built to prevent false clean bills. Treat `ENOBUFS` as a runaway, and
raise `maxBuffer` well past a normal run's output.

A sixth, adjacent: a duplicated row in the mutation table over-reported 23
mutations as 22 for several runs. Count what you ran, not what you listed.

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
