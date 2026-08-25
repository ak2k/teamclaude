import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedState, familyModel, isFableModel, modelGlobOverlaps, modelsForGlob, parseRequestModel, TopLevelFieldFinder } from '../src/model.js';

test('isFableModel matches the Fable family only', () => {
  assert.equal(isFableModel('claude-fable-5'), true);
  assert.equal(isFableModel('claude-opus-4-8'), false);
  assert.equal(isFableModel('claude-sonnet-5'), false);
  assert.equal(isFableModel(null), false);
  assert.equal(isFableModel(undefined), false);
});

test('parseRequestModel reads the top-level model', () => {
  assert.equal(parseRequestModel('{"model":"claude-fable-5","max_tokens":1}'), 'claude-fable-5');
  assert.equal(parseRequestModel(Buffer.from('{ "model" : "claude-opus-4-8" }')), 'claude-opus-4-8');
  assert.equal(parseRequestModel('{"max_tokens":1}'), null);
  assert.equal(parseRequestModel(''), null);
  assert.equal(parseRequestModel(null), null);
});

test('parseRequestModel ignores a "model" key nested in conversation content', () => {
  // A user message literally contains `"model":"DECOY"`; the real field comes
  // after it at the top level. A regex would grab DECOY — the structural finder
  // must return the top-level value.
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'here is json: {"model":"DECOY-should-be-ignored"}' }],
    system: [{ type: 'text', text: '"model": "ALSO-DECOY"' }],
    model: 'claude-fable-5',
  });
  assert.equal(parseRequestModel(body), 'claude-fable-5');
});

test('parseRequestModel ignores a nested model even when it appears first', () => {
  const body = '{"metadata":{"model":"nested-decoy"},"model":"claude-opus-4-8"}';
  assert.equal(parseRequestModel(body), 'claude-opus-4-8');
});

test('TopLevelFieldFinder resolves across chunk boundaries', () => {
  // Split the body mid-key and mid-value to exercise the streaming state.
  const full = '{"max_tokens":1,"model":"claude-fable-5","stream":true}';
  const finder = new TopLevelFieldFinder('model');
  let out = null;
  for (let i = 0; i < full.length; i += 3) {
    out = finder.push(Buffer.from(full.slice(i, i + 3), 'utf8'));
    if (finder.done) break;
  }
  assert.equal(out, 'claude-fable-5');
  assert.equal(finder.done, true);
});

test('TopLevelFieldFinder marks done (absent) once the root object closes', () => {
  const finder = new TopLevelFieldFinder('model');
  assert.equal(finder.push(Buffer.from('{"max_tokens":1}')), null);
  assert.equal(finder.done, true); // root closed without the field → stop early
});

// One classification for the whole screen. The three answers matter: a family
// every id of which is blocked, one the blocklist merely reaches, and one it
// does not touch are three different things to tell an operator, and reporting
// the middle one as either of the others is how the Decision block came to
// render a live destination above a Routing line calling the same route dead.
// FULL IS A PROPERTY OF THE GLOB, not of the representatives. `FAMILY_MODELS`
// is one id per family — a representative, not a census — and this file used to
// assert the opposite: that blocking `claude-fable-5` blocks Fable. It does not.
// `claude-fable-4` and every dated variant of `claude-fable-5` match the same
// route and are still served, so the route is `partial` and the old expectation
// was the defect written down as an expectation.
test('blockedState separates a family fully blocked from one only partly blocked', () => {
  const fable = { models: [familyModel('Fable')], globs: ['*fable*'] };
  assert.equal(blockedState(['*fable*'], fable), 'blocked');
  assert.equal(blockedState(['*'], fable), 'blocked', 'the catch-all blocks every family');
  assert.equal(blockedState(['claude-fable-5'], fable), 'partial',
    'blocking the representative id reports the whole family dead while its siblings are served');
  assert.equal(blockedState(['claude-fable-4'], fable), 'partial',
    'a single id that is not the representative takes the whole family out of service');
  assert.equal(blockedState(['claude-fable-5-20260101'], fable), 'partial',
    'a dated variant, which is the ordinary shape of a concrete block');
  assert.equal(blockedState(['*opus*'], fable), 'clear');
  assert.equal(blockedState([], fable), 'clear');
  assert.equal(blockedState(null, fable), 'clear');
  assert.equal(blockedState([null, 42, '*fable*'], fable), 'blocked',
    'a malformed entry beside a real one changes the answer');
});

// WHERE THE WILDCARD SITS is the whole question, and comparing stripped cores
// threw it away: `*fable`, `fable*` and `*fable*` all reduced to `fable` and all
// claimed to cover a `*fable*` route. `*fable` matches only ids ENDING in
// "fable" — not one id that route carries — and the screen called the route dead
// on the strength of it.
test('globCovers answers on the pattern\'s shape, not on its letters', () => {
  const route = { globs: ['*fable*'] };
  assert.equal(blockedState(['*fable*'], route), 'blocked', 'the infix pattern genuinely covers it');
  assert.equal(blockedState(['*'], route), 'blocked');
  assert.equal(blockedState(['*fable'], route), 'partial',
    'a suffix-only pattern matches no id this route carries, and claimed to cover all of them');
  assert.equal(blockedState(['fable*'], route), 'partial',
    'a prefix-only pattern claims ids that do not start with fable');
  // The direction that must keep working: a wider infix pattern covers a
  // narrower glob, because every id matching the narrow one contains the core.
  assert.equal(blockedState(['*fable*'], { globs: ['*claude-fable*'] }), 'blocked');
  assert.equal(blockedState(['*claude-fable*'], { globs: ['*fable*'] }), 'partial',
    'the narrow pattern was read as covering the wide glob');
  // A prefix pattern DOES cover a glob whose own prefix extends it.
  assert.equal(blockedState(['claude-*'], { globs: ['claude-fable-*'] }), 'blocked');
  assert.equal(blockedState(['claude-fable-*'], { globs: ['claude-*'] }), 'partial');
});

// ONE OCCURRENCE CANNOT SATISFY TWO SEGMENTS. `fable*fable*` requires "fable"
// twice; `fable*` guarantees it once. Reading the pattern's prefix and its
// interior literal against the same glob segment let a pattern claim coverage it
// does not have, and `fablex` is the witness: it matches the glob, escapes the
// pattern, and was reported as blocked.
test('globCovers refuses a literal that would be consumed twice', () => {
  assert.equal(blockedState(['fable*fable*'], { globs: ['fable*'] }), 'partial');
  assert.equal(blockedState(['*a*a*'], { globs: ['a*'] }), 'partial',
    'the two-middle shape was already refused, which is why this only showed with a prefix');
  // The directions that must keep working, so the refusal is not a blanket one.
  assert.equal(blockedState(['claude-*'], { globs: ['claude-fable-*'] }), 'blocked');
  assert.equal(blockedState(['*fable*'], { globs: ['*claude-fable*'] }), 'blocked');
  assert.equal(blockedState(['fable*'], { globs: ['fable-x*'] }), 'blocked',
    'a prefix pattern still covers a glob whose own prefix extends it');
});

test('blockedState reserves `blocked` for a pattern that covers the whole glob', () => {
  // Coverage is decidable for the shapes in use and conservative elsewhere: an
  // unsure answer is `partial`, which understates a block rather than calling a
  // live route dead.
  assert.equal(blockedState(['*fable*'], { globs: ['*fable*'] }), 'blocked');
  assert.equal(blockedState(['*fable*'], { globs: ['*claude-fable*'] }), 'blocked',
    'a narrower glob is covered by a wider pattern: every id matching it matches the pattern');
  assert.equal(blockedState(['*claude-fable*'], { globs: ['*fable*'] }), 'partial',
    'a wider glob is not covered by a narrower pattern, and this is the direction that overstates');
  assert.equal(blockedState(['claude-fable-5'], { globs: ['claude-fable-5'] }), 'blocked',
    'a concrete pattern covers an identical concrete glob and nothing else');
  // A scope with no glob at all is exactly its ids, so they decide it.
  assert.equal(blockedState(['*fable*'], { models: ['claude-fable-5'] }), 'blocked');
  const both = { models: ['claude-opus-4-5', 'claude-fable-5'], globs: ['claude-*'] };
  assert.equal(blockedState(['*fable*'], both), 'partial');
  assert.equal(blockedState(['claude-*'], both), 'blocked');
});

test('modelsForGlob answers with real model ids, and never with the glob', () => {
  assert.deepEqual(modelsForGlob('*fable*'), ['claude-fable-5']);
  assert.deepEqual(modelsForGlob('claude-*'),
    ['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-fable-5']);
  // A glob naming no metered family is one scope on the shared bucket, which is
  // its literal core — the one case where the stripped string is the answer.
  assert.deepEqual(modelsForGlob('gpt-*'), ['gpt-']);
  assert.deepEqual(modelsForGlob('*'), ['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-fable-5']);
});

test('modelGlobOverlaps compares literal cores in both directions', () => {
  assert.equal(modelGlobOverlaps('*fable*', '*fable*'), true);
  assert.equal(modelGlobOverlaps('claude-fable-5', '*fable*'), true);
  assert.equal(modelGlobOverlaps('*fable*', 'claude-fable-5'), true);
  assert.equal(modelGlobOverlaps('*', '*fable*'), true);
  assert.equal(modelGlobOverlaps('*opus*', '*fable*'), false);
  assert.equal(modelGlobOverlaps(undefined, '*fable*'), false);
});
