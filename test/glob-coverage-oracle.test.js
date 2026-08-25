import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globCovers, modelGlobMatches } from '../src/model.js';

// AN ORACLE, NOT A TABLE OF WITNESSES.
//
// `globCovers` was wrong at four shapes across four passes, and each fix was
// graded by the witness that had just been supplied: a doubled literal at the
// front, then the same at the back, then a wildcard-free glob. Every one of
// those tests passed while the next shape was already broken, because a table
// is complete against the dimensions its author thought of and nothing else.
//
// So the grading here is not a table. True coverage — does EVERY id matching
// the glob also match the pattern — is decidable by enumeration over a bounded
// id space, so this computes it directly and compares `globCovers` against it
// over the whole cross-product of shapes. Whatever dimensions anyone would have
// named (wildcard position, repeated literals, exact-vs-exact, wildcard-free
// candidate) are covered by construction, because the space is every shape.
//
// THE TWO DIRECTIONS ARE NOT EQUAL, which is why they are asserted separately:
//
//   OVERSTATE   says covered, is not. A LIVE route reads as fully blocked and
//               its scope is suppressed. Loud, wrong, and asserted to be ZERO.
//   UNDERSTATE  says not covered, is. A covered route reads as live. Silent,
//               and the documented conservative direction of this function.
//
// The understates are frozen as an exact set rather than a count, so a NEW one
// fails here even if an old one is fixed in the same change. Closing them needs
// real glob-language inclusion, which is a round-4 item; see the residual entry
// that cites this space.
//
// SOUNDNESS, stated rather than assumed: enumeration over ids up to ID_LEN is
// not a proof for all strings. It is reliable here because every shape is at
// most SHAPE_LEN symbols over a two-letter alphabet, so any distinguishing
// witness can be taken far shorter than ID_LEN. A disagreement found here is
// real; agreement is strong evidence rather than a theorem.

const ALPHA = ['a', 'b'];
const SHAPE_LEN = 4;
const ID_LEN = 8;

function shapes(maxLen) {
  const out = [];
  const rec = (s) => {
    if (s.length) out.push(s);
    if (s.length === maxLen) return;
    for (const c of [...ALPHA, '*']) rec(s + c);
  };
  rec('');
  // `**` denotes the same language as `*` and only inflates the space.
  return [...new Set(out.map(s => s.replace(/\*{2,}/g, '*')))];
}

function ids(maxLen) {
  const out = [];
  const rec = (s) => {
    out.push(s);
    if (s.length === maxLen) return;
    for (const c of ALPHA) rec(s + c);
  };
  rec('');
  return out;
}

// The 54 pairs where `globCovers` is conservative and true coverage holds. All
// ten patterns are wildcard-on-one-end with an interior literal; the pattern
// requires two occurrences of something the glob guarantees once in a position
// the decomposition cannot see. Frozen as pairs so a new one cannot hide behind
// a stable count.
const KNOWN_UNDERSTATES = new Set([
  '*a*a|*aa', '*a*a|*aaa', '*a*a|*aba', '*a*a|*baa', '*a*a|b*aa',
  '*a*b|*aab', '*a*b|*ab', '*a*b|*abb', '*a*b|*bab', '*a*b|b*ab',
  '*ab*|*a*b', '*ab*|a*b', '*ab*|a*b*', '*ab*|a*ba', '*ab*|a*bb', '*ab*|aa*b', '*ab*|ba*b',
  '*b*a|*aba', '*b*a|*ba', '*b*a|*baa', '*b*a|*bba', '*b*a|a*ba',
  '*b*b|*abb', '*b*b|*bab', '*b*b|*bb', '*b*b|*bbb', '*b*b|a*bb',
  '*ba*|*b*a', '*ba*|ab*a', '*ba*|b*a', '*ba*|b*a*', '*ba*|b*aa', '*ba*|b*ab', '*ba*|bb*a',
  'a*a*|aa*', 'a*a*|aa*b', 'a*a*|aaa*', 'a*a*|aab*', 'a*a*|aba*',
  'a*b*|aab*', 'a*b*|ab*', 'a*b*|ab*a', 'a*b*|aba*', 'a*b*|abb*',
  'b*a*|ba*', 'b*a*|ba*b', 'b*a*|baa*', 'b*a*|bab*', 'b*a*|bba*',
  'b*b*|bab*', 'b*b*|bb*', 'b*b*|bb*a', 'b*b*|bba*', 'b*b*|bbb*',
]);

test('globCovers agrees with an enumerated coverage oracle in the loud direction', () => {
  const PATS = shapes(SHAPE_LEN);
  const IDS = ids(ID_LEN);
  assert.ok(PATS.length > 80 && IDS.length > 400,
    'the space collapsed; a passing run over three shapes would prove nothing');

  // The id set each shape matches, as a bitset over IDS.
  const lang = new Map();
  for (const p of PATS) {
    const bits = new Uint8Array(IDS.length);
    for (let i = 0; i < IDS.length; i++) bits[i] = modelGlobMatches(p, IDS[i]) ? 1 : 0;
    lang.set(p, bits);
  }
  const trueCoverage = (pattern, glob) => {
    const P = lang.get(pattern);
    const G = lang.get(glob);
    for (let i = 0; i < IDS.length; i++) if (G[i] && !P[i]) return { covers: false, escape: IDS[i] };
    return { covers: true, escape: null };
  };

  const overstates = [];
  const understates = [];
  for (const pattern of PATS) {
    for (const glob of PATS) {
      const said = globCovers(pattern, glob);
      const { covers, escape } = trueCoverage(pattern, glob);
      if (said === covers) continue;
      if (said) overstates.push(`globCovers(${pattern}, ${glob}) claims coverage; ${escape} escapes it`);
      else understates.push(`${pattern}|${glob}`);
    }
  }

  // A live route reported dead. Every one of these has an executable escape.
  assert.deepEqual(overstates, [],
    'globCovers claims coverage it does not have, so a live route reads as blocked');

  // The conservative direction, frozen as a set: an old one fixed is as much a
  // change to declare as a new one appearing.
  const unexpected = understates.filter(k => !KNOWN_UNDERSTATES.has(k));
  assert.deepEqual(unexpected, [],
    'a NEW conservative answer appeared; a covered route now reads live where it did not');
  const closed = [...KNOWN_UNDERSTATES].filter(k => !understates.includes(k));
  assert.deepEqual(closed, [],
    'a known conservative answer was closed; good, and the frozen set must be updated with it');
});

// The invariant the guard states, asserted directly as well as through the
// oracle: for a candidate with no wildcard there is exactly one id in the scope,
// so coverage and membership are the same question. Kept because the oracle
// grades the ANSWER while this names the REASON, and the reason is what the
// three preceding fixes each missed.
test('for a wildcard-free glob, coverage is membership', () => {
  const cases = [
    ['claude-*-5', 'claude-5'], ['claude-fable-5*5', 'claude-fable-5'],
    ['*fable*', 'claude-fable-5'], ['claude-*', 'claude-fable-5'],
    ['claude-fable-*', 'claude-opus-4-5'], ['*opus*', 'claude-fable-5'],
    ['claude-fable-5', 'claude-fable-5'], ['*', 'claude-fable-5'],
  ];
  for (const [pattern, glob] of cases) {
    assert.equal(globCovers(pattern, glob), modelGlobMatches(pattern, glob),
      `globCovers(${pattern}, ${glob}) disagrees with whether the pattern matches that one id`);
  }
});
