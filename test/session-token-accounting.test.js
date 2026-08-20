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
