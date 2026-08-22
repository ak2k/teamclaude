import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_MAX } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';

// Per-session token accounting. Upstream reports what a request cost in a
// `usage` object, and until now only `input_tokens` and `output_tokens` were
// read off it: the two cache fields were discarded, and nothing was attributed
// to the session that caused the spend.
//
// Nothing steers on any of this. These tests pin what is recorded and, just as
// importantly, what is not: the counters are a measurement, and a measurement
// that quietly double counts or resurrects evicted state is worse than none.

const SID = 'sess-a';
const accounts = (names) => names.map(n => ({ name: n, type: 'apikey', apiKey: `k-${n}` }));

// Totals are per weekly bucket, so every assertion has to name one. These are
// the two families that meter separately, which is the whole reason for the
// split: an Opus point and a Fable point are not the same thing.
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const OPUS_BUCKET = 'unified7d';
const FABLE_BUCKET = 'unified7dFable';
const tokensFor = (t, id, bucket = OPUS_BUCKET) => t.sessions.get(id).tokens.get(bucket);

// The shape upstream sends at `message_start`: the input side, including both
// cache fields, with output present but not yet meaningful.
const startUsage = (over = {}) => ({
  input_tokens: 12,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 300,
  output_tokens: 1,
  ...over,
});

// The shape at `message_delta`: output only.
const deltaUsage = (over = {}) => ({ output_tokens: 500, ...over });

function trackerWith(sessionId = SID) {
  const t = new SessionTracker();
  t.touch(sessionId);
  return t;
}

test('a usage report is attributed to the session that caused it', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  const got = tokensFor(t, SID);
  assert.equal(got.cacheRead, 4000);
  assert.equal(got.cacheCreation, 300);
  assert.equal(got.input, 12);
  assert.equal(got.reports, 1);
});

// The tracker sums every report it is handed: that is what makes a session
// total a total across the turns of a conversation. It follows that the
// streaming path must hand it one report per message rather than one per SSE
// event, which is asserted end to end in streaming-usage-merge.test.js.
test('successive reports accumulate into the session total', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  const got = tokensFor(t, SID);
  assert.equal(got.input, 24, 'a second turn adds to the running total');
  assert.equal(got.cacheRead, 8000);
  assert.equal(got.reports, 2);
});

// `context` is the size of the last context read, not a running total. Summing
// it across a conversation answers a question nobody asks, and a delta report
// carries no input side at all, so it must not reset it either.
test('context tracks the latest input side and survives an output-only report', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  assert.equal(tokensFor(t, SID).context, 4312);
  t.recordTokens(SID, OPUS_BUCKET, deltaUsage());
  assert.equal(tokensFor(t, SID).context, 4312,
    'an output-only report has nothing to say about context size');
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 9000 }));
  assert.equal(tokensFor(t, SID).context, 9312,
    'the next turn read a bigger context, and that is the current one');
});

// The id is a client-supplied header, so a report for a session that is not
// tracked must not create a record: that would let usage reports defeat the cap
// eviction exists to enforce.
test('a report for an untracked session is dropped, not resurrected', () => {
  const t = new SessionTracker();
  assert.equal(t.recordTokens('never-seen', OPUS_BUCKET, startUsage()), null);
  assert.equal(t.sessions.size, 0, 'a usage report created a session record');
  assert.equal(t.recordTokens(null, OPUS_BUCKET, startUsage()), null);
  assert.equal(t.sessions.size, 0);
});

test('a report for an evicted session is dropped', () => {
  const t = new SessionTracker({ maxSessions: 2 });
  t.touch('a'); t.touch('b'); t.touch('c');      // 'a' is evicted by the cap
  assert.equal(t.sessions.has('a'), false, 'the fixture did not evict, so this proves nothing');
  assert.equal(t.recordTokens('a', OPUS_BUCKET, startUsage()), null);
  assert.equal(t.sessions.size, 2, 'the evicted session came back through its usage report');
});

// A stream that fails after the first report keeps what was observed: the
// context was read upstream and charged, and the client leaving refunds nothing.
test('a stream that stops after its first report keeps what it spent', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  const got = tokensFor(t, SID);
  assert.equal(got.cacheRead, 4000);
  assert.equal(got.output, 1, 'only what was reported');
  assert.equal(got.reports, 1);
});

test('a malformed report contributes zero rather than poisoning the totals', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  t.recordTokens(SID, OPUS_BUCKET, { input_tokens: null, cache_read_input_tokens: 'lots', output_tokens: undefined });
  const got = tokensFor(t, SID);
  for (const [k, v] of Object.entries(got)) {
    assert.ok(Number.isFinite(v), `${k} is ${v}`);
  }
  assert.equal(got.cacheRead, 4000, 'a non-numeric field added nothing');
});

// The totals ride the session record's own lifecycle: one cap, one TTL, one
// eviction policy for everything scoped to a session.
test('the totals die with the record, and a reused id starts clean', () => {
  let now = 1000;
  const t = new SessionTracker({ knownTtlMs: 100, now: () => now });
  t.touch(SID);
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  assert.equal(tokensFor(t, SID).cacheRead, 4000);
  now += 500;                                   // idled past the known window
  t.touch(SID);                                 // same string, a new session
  assert.equal(t.sessions.get(SID).tokens.size, 0,
    'a new session inherited the tokens of the one that used its id');
});

// ── what the fleet view reports ──────────────────────────────────────────────

test('stats totals the known sessions and the live cached footprint', () => {
  const t = new SessionTracker();
  t.touch('a'); t.touch('b');
  t.recordTokens('a', OPUS_BUCKET, startUsage());
  t.recordTokens('b', OPUS_BUCKET, startUsage({ cache_read_input_tokens: 1000 }));
  const s = t.stats();
  assert.equal(s.tokens.cacheRead, 5000);
  assert.equal(s.tokens.input, 24);
  assert.equal(s.tokens.reports, 2);
  assert.equal(s.tokens.activeContext, 4312 + 1312, 'the footprint sums the ACTIVE sessions');
  assert.equal(s.max, SESSION_MAX);
});

test('an idle session keeps its totals but leaves the live footprint', () => {
  let now = 1000;
  const t = new SessionTracker({ activeTtlMs: 100, now: () => now });
  t.touch('a');
  t.recordTokens('a', OPUS_BUCKET, startUsage());
  assert.equal(t.stats().tokens.activeContext, 4312);
  now += 500;                                   // still known, no longer active
  const s = t.stats();
  assert.equal(s.active, 0);
  assert.equal(s.tokens.cacheRead, 4000, 'a known session still counts toward the totals');
  assert.equal(s.tokens.activeContext, 0, 'an idle session is not part of the live footprint');
});

// ── the account side ─────────────────────────────────────────────────────────

test('the cache fields are totalled against the account that served them', () => {
  const am = new AccountManager(accounts(['a', 'b']), 0.98);
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, OPUS, startUsage());
  am.recordTokenUsage(0, SID, OPUS, startUsage());
  assert.equal(am.accounts[0].usage.totalCacheReadTokens, 8000);
  assert.equal(am.accounts[0].usage.totalCacheCreationTokens, 600);
  assert.equal(am.accounts[1].usage.totalCacheReadTokens, 0, 'the other account was charged');
});

test('an account report with no session still lands on the account', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.recordTokenUsage(0, null, OPUS, startUsage());
  assert.equal(am.accounts[0].usage.totalCacheReadTokens, 4000,
    'a request without a session id is still a real spend by this account');
});

test('recordTokenUsage leaves the existing account totals alone', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.recordTokenUsage(0, null, OPUS, startUsage());
  assert.equal(am.accounts[0].usage.totalInputTokens, 0,
    'the uncached-input total is updateUsage\'s to keep, and this must not touch it');
  assert.equal(am.accounts[0].usage.totalOutputTokens, 0);
});

// ── the families meter separately ────────────────────────────────────────────

// The point of keying by bucket. A session that talks to both families holds two
// contexts and two burn rates, and which of them is under pressure is exactly
// the question a routing decision asks.
test('a session that spans two families keeps their totals apart', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  t.recordTokens(SID, FABLE_BUCKET, startUsage({ cache_read_input_tokens: 90, input_tokens: 3 }));
  assert.equal(tokensFor(t, SID, OPUS_BUCKET).cacheRead, 4000);
  assert.equal(tokensFor(t, SID, FABLE_BUCKET).cacheRead, 90);
  assert.equal(tokensFor(t, SID, OPUS_BUCKET).context, 4312);
  assert.equal(tokensFor(t, SID, FABLE_BUCKET).context, 393,
    'the two families reported different context sizes and one overwrote the other');
});

test('a report with no bucket is dropped rather than pooled', () => {
  const t = trackerWith();
  assert.equal(t.recordTokens(SID, null, startUsage()), null);
  assert.equal(t.sessions.get(SID).tokens.size, 0,
    'a report that named no family landed somewhere anyway');
});

test('stats reports each family and the total across them', () => {
  const t = new SessionTracker();
  t.touch('a');
  t.recordTokens('a', OPUS_BUCKET, startUsage());
  t.recordTokens('a', FABLE_BUCKET, startUsage({ cache_read_input_tokens: 90, input_tokens: 3 }));
  const s = t.stats();
  assert.equal(s.tokens.byBucket[OPUS_BUCKET].cacheRead, 4000);
  assert.equal(s.tokens.byBucket[FABLE_BUCKET].cacheRead, 90);
  assert.equal(s.tokens.cacheRead, 4090, 'the total across families is not reported');
  assert.equal(s.tokens.byBucket[OPUS_BUCKET].activeContext, 4312);
  assert.equal(s.tokens.byBucket[FABLE_BUCKET].activeContext, 393);
  assert.equal(s.tokens.activeContext, 4705, 'the live footprint sums the families');
});

test('the account totals are split by family and still sum', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, OPUS, startUsage());
  am.recordTokenUsage(0, SID, FABLE, startUsage({ cache_read_input_tokens: 90 }));
  const u = am.accounts[0].usage;
  assert.equal(u.byBucket[OPUS_BUCKET].cacheReadTokens, 4000);
  assert.equal(u.byBucket[FABLE_BUCKET].cacheReadTokens, 90);
  assert.equal(u.totalCacheReadTokens, 4090, 'the flat total no longer agrees with the split');
});

// An advisor request reports once, and the two inferences inside it are not
// separable in that report. It lands on the executing model's family, and this
// pins that rather than leaving it to be discovered.
test('an advisor request lands on the executing model\'s family', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, OPUS, startUsage());   // executor Opus, advisor elsewhere
  assert.equal(am.sessionTracker.sessions.get(SID).tokens.get(FABLE_BUCKET), undefined,
    'a bucket the request did not execute on was charged');
  assert.equal(am.sessionTracker.sessions.get(SID).tokens.get(OPUS_BUCKET).cacheRead, 4000);
});

// ---------------------------------------------------------------------------
// SPLIT-FAMILY ATTRIBUTION. A session holds one pin per weekly family, and
// those pins commonly name DIFFERENT accounts: 20.1% of the 1504 sessions in
// the transcript corpus span more than one family. `loadFor` tested the pin per
// session and then summed every bucket, so each account the session touched was
// charged the session's whole context and the pick could not tell them apart.
// ---------------------------------------------------------------------------

test('a session split across two accounts charges each one only what it served', () => {
  const now = 1_000_000;
  const t = new SessionTracker({ now: () => now });
  t.touch(SID, 0, [OPUS_BUCKET], now);
  t.touch(SID, 1, [FABLE_BUCKET], now);
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 100000 }), now);
  t.recordTokens(SID, FABLE_BUCKET, startUsage({ cache_read_input_tokens: 7000 }), now);

  // The premise: this really is ONE session pinned to two DIFFERENT accounts.
  // Without it the assertions below hold trivially on a fixture that never
  // reached the split at all.
  const pins = t.sessions.get(SID).pins;
  assert.equal(pins.get(OPUS_BUCKET).idx, 0);
  assert.equal(pins.get(FABLE_BUCKET).idx, 1);
  const rest = startUsage().cache_creation_input_tokens + startUsage().input_tokens;

  const a0 = t.loadFor(0, now);
  const a1 = t.loadFor(1, now);
  assert.equal(a0.context, 100000 + rest, 'account 0 was charged context it never served');
  assert.equal(a1.context, 7000 + rest, 'account 1 was charged context it never served');
  assert.notEqual(a0.context, a1.context, 'both accounts read the same total, so the split was pooled');
  assert.equal(a0.reports, 1, 'reports must be attributed the same way as the context behind them');
  assert.equal(a1.reports, 1);
});

test('a split session still counts as one active session on each account it holds', () => {
  const now = 1_000_000;
  const t = new SessionTracker({ now: () => now });
  t.touch(SID, 0, [OPUS_BUCKET], now);
  t.touch(SID, 1, [FABLE_BUCKET], now);
  // Cardinality is a property of the relationship, not of the spend: the
  // session genuinely is live on both accounts, so both see one. Only the token
  // quantities are divided, and this pins that the fix did not divide both.
  assert.equal(t.loadFor(0, now).sessions, 1);
  assert.equal(t.loadFor(1, now).sessions, 1);
});

test('the consolidated walk agrees with the count it replaced, on every account', () => {
  const now = 1_000_000;
  const t = new SessionTracker({ now: () => now });
  t.touch('s1', 0, [OPUS_BUCKET], now);
  t.touch('s1', 1, [FABLE_BUCKET], now);
  t.touch('s2', 0, [OPUS_BUCKET, FABLE_BUCKET], now);
  t.touch('s3', 2, [OPUS_BUCKET], now);
  // `activeCountFor` is the public API the session term used before the three
  // walks were folded into one. The folded walk now derives its count from a
  // per-PIN test where that one tests the session, so the two agreeing is a
  // real claim rather than a restatement.
  for (const idx of [0, 1, 2, 3]) {
    assert.equal(t.loadFor(idx, now).sessions, t.activeCountFor(idx, now),
      `account ${idx}: the folded walk and activeCountFor disagree`);
  }
});

// ---------------------------------------------------------------------------
// PER-PIN IN-FLIGHT ACCOUNTING. The in-flight exemption used to read the
// session-level counter and then guess that the outstanding request was
// spending the most recently placed pin. True for one request, false for two.
// These two tests are a pair on purpose: the first is the case that must now
// count, the second is the case that must still NOT, so the first is not bought
// by making every pin of a live session count forever.
// ---------------------------------------------------------------------------

test('two concurrent requests on one session each hold their own account', () => {
  const now = 1_000_000;
  let clock = now;
  const t = new SessionTracker({ activeTtlMs: 60_000, now: () => clock });

  const holdA = t.beginRequest(SID, clock);
  t.touch(SID, 0, [OPUS_BUCKET], clock, holdA);
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 100000 }), clock);

  // Far past activeTtlMs, so only the in-flight arm can keep account 0 counted.
  clock += 10 * 60_000;
  const holdB = t.beginRequest(SID, clock);
  t.touch(SID, 1, [FABLE_BUCKET], clock, holdB);
  t.recordTokens(SID, FABLE_BUCKET, startUsage({ cache_read_input_tokens: 7000 }), clock);

  assert.equal(t.sessions.get(SID).inFlight, 2, 'the fixture does not have two requests in flight');
  assert.ok(clock - t.sessions.get(SID).pins.get(OPUS_BUCKET).at > 60_000,
    'the older pin is still inside the active window, so freshness would carry it anyway');

  assert.equal(t.activeCountFor(0, clock), 1, 'the account carrying a live stream read as idle');
  assert.ok(t.loadFor(0, clock).context > 100000,
    'a live 100000-token context was not counted as load on the account serving it');
  assert.equal(t.activeCountFor(1, clock), 1);
});

test('a pin nobody is spending still ages out, even while the session is alive', () => {
  const now = 1_000_000;
  let clock = now;
  const t = new SessionTracker({ activeTtlMs: 60_000, now: () => clock });

  const holdA = t.beginRequest(SID, clock);
  t.touch(SID, 0, [OPUS_BUCKET], clock, holdA);
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 100000 }), clock);
  t.endRequest(SID, holdA, clock);           // the Opus stream finishes

  // A second request keeps the SESSION alive on another account. Account 0's pin
  // is now stale and nothing is spending it.
  clock += 10 * 60_000;
  const holdB = t.beginRequest(SID, clock);
  t.touch(SID, 1, [FABLE_BUCKET], clock, holdB);

  assert.ok(t.sessions.get(SID).inFlight > 0, 'the session is not live, so this proves nothing');
  assert.equal(t.activeCountFor(0, clock), 0,
    'an hour-cold pin counted as load because some OTHER request was in flight');
  assert.equal(t.loadFor(0, clock).context, 0);
  assert.equal(t.activeCountFor(1, clock), 1);
});

test('one request ending releases its own pin while a sibling is still in flight', () => {
  const now = 1_000_000;
  let clock = now;
  const t = new SessionTracker({ activeTtlMs: 60_000, now: () => clock });

  const holdA = t.beginRequest(SID, clock);
  t.touch(SID, 0, [OPUS_BUCKET], clock, holdA);
  const holdB = t.beginRequest(SID, clock);
  t.touch(SID, 1, [FABLE_BUCKET], clock, holdB);

  t.endRequest(SID, holdA, clock);           // the Opus request finishes
  clock += 10 * 60_000;                      // its pin is now well past the window

  // The drain at zero cannot be what releases this: the Fable request is still
  // outstanding, so `inFlight` never reaches 0. Only the explicit release can,
  // which is what makes this the test that distinguishes the two paths -- the
  // seam row severing the explicit release SURVIVED the whole suite until it
  // existed, because every other case let the drain cover it.
  assert.equal(t.sessions.get(SID).inFlight, 1, 'the drain would fire, so this proves nothing');
  assert.equal(t.activeCountFor(0, clock), 0,
    'a finished request kept holding its pin because only the drain releases holds');
  assert.equal(t.activeCountFor(1, clock), 1, 'the sibling still in flight lost its own hold');
});

// A session id does not identify a RECORD. Eviction and idle-expiry both
// replace the record while the id lives on, and a request in flight outlives
// its own record in exactly those cases. Its hold then names something gone.
test('a hold from an evicted record has no authority over its replacement', () => {
  const now = 1_000_000;
  const t = new SessionTracker({ activeTtlMs: 60_000, maxSessions: 1, now: () => now });

  const h1 = t.beginRequest(SID, now);
  t.touch(SID, 0, [OPUS_BUCKET], now, h1);
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 100000 }), now);

  // A cap of one makes the eviction deterministic: admitting any other session
  // evicts this record even though its request is still in flight.
  t.beginRequest('other', now);
  t.touch('other', 1, [OPUS_BUCKET], now);
  assert.ok(!t.sessions.has(SID), 'the record was not evicted, so this tests nothing');

  // A new request under the same id builds a NEW record with its own hold.
  const h2 = t.beginRequest(SID, now);
  t.touch(SID, 0, [OPUS_BUCKET], now, h2);
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 50000 }), now);
  assert.notEqual(h1.rid, h2.rid, 'the two holds share an identity, so ownership cannot be tested');
  const before = t.loadFor(0, now);
  assert.equal(before.sessions, 1);

  // The ORIGINAL request finishes and releases a hold on a record that is gone.
  t.endRequest(SID, h1, now);

  const after = t.loadFor(0, now);
  assert.equal(after.sessions, 1, 'a foreign hold ended the replacement\'s live request');
  assert.equal(after.context, before.context, 'a foreign hold drained the replacement\'s load');
  assert.equal(t.sessions.get(SID).inFlight, 1, 'a foreign hold decremented a stranger\'s in-flight count');
});

test('a hold from an evicted record cannot claim a pin on its replacement either', () => {
  const now = 1_000_000;
  const t = new SessionTracker({ activeTtlMs: 60_000, maxSessions: 1, now: () => now });

  const h1 = t.beginRequest(SID, now);
  t.beginRequest('other', now);
  t.touch('other', 1, [OPUS_BUCKET], now);
  assert.ok(!t.sessions.has(SID), 'the record was not evicted, so this tests nothing');

  t.beginRequest(SID, now);                       // rebuilds the record
  // The evicted request now pins, carrying a hold the new record never issued.
  t.touch(SID, 0, [OPUS_BUCKET], now, h1);
  assert.equal(t.sessions.get(SID).pinHolds.size, 0,
    'a foreign hold claimed a pin on a record that never issued it');
});

test('passing a clock where the hold goes is refused, not silently ignored', () => {
  const t = new SessionTracker({ now: () => 1_000_000 });
  t.beginRequest(SID, 1_000_000);
  assert.throws(() => t.endRequest(SID, 1_000_000), /hold must be the object/,
    'a number in the hold slot was accepted, which is how it used to corrupt lastSeen');
});

test('a hold lost by its caller is drained when the session goes quiet', () => {
  const now = 1_000_000;
  let clock = now;
  const t = new SessionTracker({ activeTtlMs: 60_000, now: () => clock });

  const hold = t.beginRequest(SID, clock);
  t.touch(SID, 0, [OPUS_BUCKET], clock, hold);
  // The caller loses the token and ends the request without it, which is the
  // shape an unpaired release takes. Left standing, the pin would be counted as
  // loaded for as long as the record survives.
  t.endRequest(SID, null, clock);

  clock += 10 * 60_000;
  assert.equal(t.sessions.get(SID).inFlight, 0);
  assert.equal(t.activeCountFor(0, clock), 0, 'a lost hold kept a stale pin counted forever');
  assert.equal(t.sessions.get(SID).pinHolds.size, 0, 'the hold was never drained');
});

test('a bucket whose pin has gone stale stops counting, and takes its context with it', () => {
  const now = 1_000_000;
  const t = new SessionTracker({ now: () => now, activeTtlMs: 60_000 });
  // Both buckets are on the SAME account, so the session-level pin test cannot
  // separate them: only the per-pin test can drop the hour-cold one.
  t.touch(SID, 0, [FABLE_BUCKET], now - 3_600_000);
  t.recordTokens(SID, FABLE_BUCKET, startUsage({ cache_read_input_tokens: 90000 }), now - 3_600_000);
  t.touch(SID, 0, [OPUS_BUCKET], now);
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 1000 }), now);

  const measured = t.loadFor(0, now);
  assert.equal(measured.sessions, 1, 'the session is still active through its fresh Opus pin');
  assert.ok(measured.context < 90000,
    'an hour-cold Fable context is still counted as load the account is carrying now');
  assert.equal(measured.reports, 1, 'the stale bucket\'s report is still being counted');
});
