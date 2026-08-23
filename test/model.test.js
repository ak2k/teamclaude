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
test('blockedState separates a family fully blocked from one only partly blocked', () => {
  const fable = { models: [familyModel('Fable')], globs: ['*fable*'] };
  assert.equal(blockedState(['*fable*'], fable), 'blocked');
  assert.equal(blockedState(['claude-fable-5'], fable), 'blocked',
    'the id the family is represented by blocks it');
  assert.equal(blockedState(['*'], fable), 'blocked', 'the catch-all blocks every family');
  assert.equal(blockedState(['claude-fable-4'], fable), 'partial',
    'a single id that is not the representative takes the whole family out of service');
  assert.equal(blockedState(['*opus*'], fable), 'clear');
  assert.equal(blockedState([], fable), 'clear');
  assert.equal(blockedState(null, fable), 'clear');
  assert.equal(blockedState([null, 42, '*fable*'], fable), 'blocked',
    'a malformed entry beside a real one changes the answer');
});

test('blockedState is answered on models, and on globs only for the partial case', () => {
  // A glob is never enough to call something fully blocked: glob intersection
  // is not decidable, so `blocked` is reserved for concrete ids that match.
  assert.equal(blockedState(['*fable*'], { models: [], globs: ['*fable*'] }), 'partial');
  assert.equal(blockedState(['*fable*'], { models: ['claude-fable-5'], globs: ['*fable*'] }), 'blocked');
  // Every model of a many-family scope must be matched, or it still carries some.
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
