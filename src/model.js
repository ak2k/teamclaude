// Model-id helpers shared by the request path (server + MITM relay) and account
// selection. Kept dependency-free so the low-level h2/h1 relay can peek a
// request's model without pulling in the account-manager graph.

// A request targets the Fable model family when its `model` id names Fable
// (e.g. "claude-fable-5"). Account selection uses this to gate the Fable-only
// weekly bucket: a Fable-exhausted account still serves every other model.
export function isFableModel(model) {
  return typeof model === 'string' && /fable/i.test(model);
}

// The model "family" a request belongs to. Anthropic meters some families with
// their own weekly quota bucket (Fable, Sonnet) on top of the shared 5-hour and
// weekly buckets, so the family decides which bucket governs a given request —
// letting an account whose Fable bucket is spent keep serving Opus/Sonnet.
// Returns a stable lowercase tag; unknown ids fall back to 'other'.
export function modelFamily(model) {
  if (typeof model !== 'string' || !model) return 'other';
  if (/fable/i.test(model)) return 'fable';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  if (/haiku/i.test(model)) return 'haiku';
  return 'other';
}

// Quota buckets on an account (see AccountManager emptyQuota). The shared 5-hour
// bucket applies to every request; the weekly bucket depends on the family.
// A family with no dedicated weekly bucket falls back to the shared 'unified7d'.
const FAMILY_WEEKLY_BUCKET = {
  fable: 'unified7dFable',
  sonnet: 'unified7dSonnet',
};

// The weekly quota bucket key that governs a model, e.g. a Fable request is
// gated by 'unified7dFable' rather than the shared 'unified7d'. Used by account
// selection so a spent family bucket only bars that family's requests.
export function weeklyBucketForModel(model) {
  return FAMILY_WEEKLY_BUCKET[modelFamily(model)] || 'unified7d';
}

// Every bucket weeklyBucketForModel can name: the family-specific ones plus the
// shared bucket the rest fall back to. Exported for callers that must cover all
// of them at once (the rollover baseline seeds one window per bucket), so
// adding a family here cannot leave a second copy of this list behind.
export const WEEKLY_BUCKET_KEYS = Object.freeze(
  [...new Set([...Object.values(FAMILY_WEEKLY_BUCKET), 'unified7d'])]);

// One CONCRETE model id per weekly bucket a request can meter into, in the
// order a reader meets them: the shared bucket first, then the families that
// meter their own.
//
// A GLOB IS NOT A MODEL, which is what these exist to stop. Stripping the
// wildcards off `claude-*` yields `claude-`, an id nobody sends, whose family
// resolves to 'other' and therefore to the shared weekly bucket — so a route
// spanning Opus and Fable published the shared bucket's band, its ladder and
// its destination as the answer for Fable requests that are metered somewhere
// else entirely. Answering per family means answering with an id that family
// actually uses.
export const FAMILY_MODELS = Object.freeze(['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-fable-5']);

// The family representatives a glob can carry, in FAMILY_MODELS order. Empty
// when the glob names no family this proxy meters separately (`gpt-*`), which
// the caller reads as "one scope, on the shared bucket" rather than as an error.
export function familyModelsMatching(glob) {
  return FAMILY_MODELS.filter(m => modelGlobMatches(glob, m));
}

// Match a shell-style glob against a model id. Only `*` is special (matches any
// run of characters, including none); every other character is literal. The
// comparison is case-insensitive. Used by configurable routes so a pattern like
// `*fable*` or `claude-opus-*` selects the models a route handles.
export function modelGlobMatches(glob, model) {
  if (typeof glob !== 'string' || typeof model !== 'string') return false;
  const re = '^' + glob.split('*').map(escapeRegExp).join('.*') + '$';
  return new RegExp(re, 'i').test(model);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Do two model globs describe any model in common? Used to tell whether a route
// is fully shadowed by the blocklist. Exact glob intersection is not decidable
// in general, so this compares literal cores (the pattern with `*` removed) in
// both directions: `claude-fable-5` overlaps `*fable*`, and a bare `*` (empty
// core) overlaps everything. Display-only, and deliberately inclusive — the
// authoritative per-request gate still matches the concrete model id.
export function modelGlobOverlaps(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const core = s => s.replace(/\*/g, '').toLowerCase();
  const ca = core(a);
  const cb = core(b);
  return ca.includes(cb) || cb.includes(ca);
}

// The models a route glob answers for: the family representatives it can carry,
// or its own literal core when it names no family this proxy meters separately.
// One definition, because the routing report expands a glob into scopes with it
// and the status view classifies the same glob against the blocklist with it —
// two rules there would put a scope on screen that the line under it calls
// dead.
export function modelsForGlob(glob) {
  const family = familyModelsMatching(glob);
  return family.length ? family : [String(glob ?? '').replace(/\*/g, '') || 'model'];
}

// The representative model id for a family name (`Fable`, `opus`), or null.
export function familyModel(family) {
  const key = String(family ?? '').toLowerCase();
  return FAMILY_MODELS.find(m => modelFamily(m) === key) || null;
}

// WHAT THE BLOCKLIST DOES to a thing that carries models — a routing scope, a
// route, a family row. Three answers, because two of them were being reported
// as one and by three different rules: `blocked` when every model it can carry
// is matched, `partial` when the blocklist reaches some of them, `clear` when
// it reaches none.
//
// ONE CLASSIFICATION FOR ONE SCREEN. The Decision block matched the blocklist
// against a scope's model, the Routing line overlapped it against the glob, and
// the per-account Models row matched a family NAME, so a concrete id like
// `claude-fable-4` rendered a live Fable decision above a Routing line calling
// the same route blocked. Which of the three was right is not the interesting
// part: a reader cannot act on a screen that contradicts itself.
//
// `models` are concrete ids and decide the FULL answer; `globs` decide only
// whether the blocklist touches this thing at all, since glob intersection is
// not decidable in general (see modelGlobOverlaps). Deliberately advisory, as
// before: the authoritative gate is the per-request check in server.js.
export function blockedState(patterns, { models = [], globs = [] } = {}) {
  const list = (Array.isArray(patterns) ? patterns : []).filter(p => typeof p === 'string' && p);
  const ids = models.filter(m => typeof m === 'string' && m);
  if (!list.length) return 'clear';
  const hits = ids.filter(m => list.some(p => modelGlobMatches(p, m)));
  if (ids.length && hits.length === ids.length) return 'blocked';
  if (hits.length) return 'partial';
  return globs.some(g => list.some(p => modelGlobOverlaps(p, g))) ? 'partial' : 'clear';
}

// Streaming, byte-exact locator for a TOP-LEVEL string field of a JSON object,
// fed incrementally. It tracks JSON structure (container stack, key/value,
// string/escape) so it ONLY matches the field at depth 1 of the root object —
// a `"model": "..."` sitting inside conversation text (a message, a tool result)
// is nested deeper and is never mistaken for the real field. No regex, no
// whole-body buffering, so the relay can peek just the first frames.
export class TopLevelFieldFinder {
  constructor(field) {
    this.field = field;               // target key at the root, e.g. 'model'
    this.isObj = [];                  // container stack: true=object, false=array
    this.awaitingKey = false;         // at an object, the next string is a key
    this.inStr = false;
    this.esc = false;
    this.readingKey = false;
    this.readingValue = false;        // accumulating the target field's value
    this.curKey = null;               // last key seen in the current object
    this.buf = [];                    // key/value byte accumulation
    this.value = null;                // the found value, or null
    this.done = false;                // found it, or the root object closed without it
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  #atRoot() { return this.isObj.length === 1 && this.isObj[0] === true; }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.readingKey || this.readingValue) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.readingKey || this.readingValue) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.readingKey) {
          this.curKey = Buffer.from(this.buf).toString('utf8'); this.buf = []; this.readingKey = false;
        } else if (this.readingValue) {
          this.value = Buffer.from(this.buf).toString('utf8'); this.buf = [];
          this.readingValue = false; this.done = true;             // the one top-level field we want
        }
        return;
      }
      if (this.readingKey || this.readingValue) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b: this.isObj.push(true); this.awaitingKey = true; this.curKey = null; break;   // {
      case 0x5b: this.isObj.push(false); this.awaitingKey = false; break;                     // [
      case 0x7d: case 0x5d:                                                                    // } ]
        this.isObj.pop(); this.curKey = null;
        if (this.isObj.length === 0) this.done = true;             // root closed → field absent
        break;
      case 0x3a: this.awaitingKey = false; break;                  // :
      case 0x2c: this.awaitingKey = this.isObj[this.isObj.length - 1] === true; break;        // ,
      case 0x22:                                                   // string begins
        if (this.awaitingKey && this.isObj[this.isObj.length - 1]) {
          this.readingKey = true; this.buf = [];
        } else if (this.#atRoot() && this.curKey === this.field) {
          this.readingValue = true; this.buf = [];
        }
        this.inStr = true; this.esc = false;
        break;
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract the requested model id from a JSON request body (Buffer or string).
// Uses the streaming top-level finder so it is exact (never matches a `model`
// key nested in conversation content) and cheap on large bodies (it stops as
// soon as the top-level field resolves). Returns null if absent.
export function parseRequestModel(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    return new TopLevelFieldFinder('model').push(buf);
  } catch { return null; }
}

// Byte-exact locator for the SECOND model an advisor request carries: Claude
// Code's advisor tool (`anthropic-beta: advisor-tool-…`) keeps the executor in
// the top-level `model` field and nests the advisor's model inside the tools
// array — `tools: [{ type: "advisor_20260301", name: "advisor", model: "…" }]`.
// The advisor sub-inference runs on the same account and spends that model's
// quota bucket, so account selection must see it (issue #98).
//
// Same byte-machine discipline as TopLevelFieldFinder: it walks the container
// stack and only reads `type`/`model` strings that are DIRECT fields of an
// object element of the ROOT object's `tools` array — a "model" inside a tool's
// input_schema or inside conversation text is deeper (or under another root
// key) and never matches. Elements are judged when they close, so field order
// within the tool object doesn't matter.
export class AdvisorModelFinder {
  constructor() {
    this.stack = [];                  // frames: {isObj, key, awaitingKey}
    this.inStr = false;
    this.esc = false;
    this.reading = null;              // 'key' | 'type' | 'model' while in a string
    this.buf = [];
    this.toolType = null;             // fields of the tools[] element being read
    this.toolModel = null;
    this.value = null;                // the advisor model, once found
    this.done = false;
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  // The stack is exactly [root object (last key "tools"), array, element object].
  #inToolElement() {
    const s = this.stack;
    return s.length === 3 && s[0].isObj && s[0].key === 'tools' && !s[1].isObj && s[2].isObj;
  }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.reading) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.reading) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.reading) {
          const text = Buffer.from(this.buf).toString('utf8');
          if (this.reading === 'key') this.stack[this.stack.length - 1].key = text;
          else if (this.reading === 'type') this.toolType = text;
          else this.toolModel = text;
          this.reading = null;
          this.buf = [];
        }
        return;
      }
      if (this.reading) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b:                                                   // {
        this.stack.push({ isObj: true, key: null, awaitingKey: true });
        if (this.#inToolElement()) { this.toolType = null; this.toolModel = null; }
        break;
      case 0x5b: this.stack.push({ isObj: false, key: null, awaitingKey: false }); break; // [
      case 0x7d:                                                   // }
        if (this.#inToolElement()
            && typeof this.toolType === 'string' && /^advisor/i.test(this.toolType)
            && this.toolModel) {
          this.value = this.toolModel;
          this.done = true;
        }
        // fall through: pop like ]
      case 0x5d:                                                   // ]
        this.stack.pop();
        if (this.stack.length === 0) this.done = true;             // root closed → absent
        break;
      case 0x3a: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = false; break; } // :
      case 0x2c: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = true; break; }  // ,
      case 0x22: {                                                 // string begins
        const t = this.stack[this.stack.length - 1];
        if (t?.isObj && t.awaitingKey) this.reading = 'key';
        else if (this.#inToolElement() && (t.key === 'type' || t.key === 'model')) this.reading = t.key;
        else this.reading = null;                                  // uninteresting string: skip bytes
        this.buf = [];
        this.inStr = true;
        this.esc = false;
        break;
      }
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract the advisor model from a JSON request body, or null when the request
// carries no advisor tool. Gated on a cheap byte search for "advisor" so the
// full structural scan only runs on bodies that could possibly contain one —
// for everything else this is a single Buffer.includes.
export function parseAdvisorModel(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (!buf.includes('advisor')) return null;
    return new AdvisorModelFinder().push(buf);
  } catch { return null; }
}

/**
 * The utilization that GATES a request whose weekly bucket is `bucketKey`: the
 * higher of that bucket and the shared `unified7d`, or null when neither is
 * reported.
 *
 * ONE DEFINITION, because the gate and every display of it answer the SAME
 * question - can this account serve this family right now. A second derivation
 * of one question is a copy that drifts, and it did: the routing gate took this
 * maximum while `status`'s Models row and the TUI's blocked tag each kept
 * reading the family bucket alone, so one render showed `Fable OK` on an
 * account routing had just refused. Two derivations of two DIFFERENT questions
 * are two functions, which is why pressure does not use this: pressure is
 * headroom over the time until that window resets, and maxing across buckets
 * would divide one bucket's headroom by another bucket's clock.
 *
 * Family spend meters twice, in the family bucket and again in the shared one,
 * so an account under its family cap can still be over the shared one. Reading
 * the family bucket alone let it keep serving that family and push the shared
 * bucket further past its cap, which is a one-way ratchet: once the shared
 * bucket is spent, family requests are the only ones still admitted.
 *
 * NULL IS UNREPORTED AND NEVER ZERO. `Math.max` coerces null to 0, and 0 reads
 * as "empty" - the opposite of "unknown", in the direction that keeps an
 * account serving. Both absent cases are handled before the maximum rather than
 * falling into it. The `own == null` branch is unreachable from both callers
 * today (the manager resolves the key with the same `== null` test, and the
 * renderers only ask about a family they have already seen reported); it is
 * kept because without it a third caller passing an absent family bucket would
 * silently get `max(0, shared)`, which is the coercion this paragraph exists to
 * prevent.
 */
export function gatingUtilization(quota, bucketKey) {
  return gatingSource(quota, bucketKey)?.value ?? null;
}

/**
 * The same gate, saying WHICH bucket produced the figure.
 *
 * A caller reporting why an account was barred has to name a bucket, and the
 * value is a maximum over two of them: printing the governing bucket's key
 * beside a number that came from the shared one is the two-buckets-one-word
 * defect this file's header is about, committed by the report instead of by the
 * gate. So the maximum is taken once, here, and the winner is carried out with
 * it rather than reconstructed by comparing the two buckets a second time.
 *
 * `gatingUtilization` is the projection for the callers that only need the
 * number, which is all of routing. Null means neither bucket is reported, and
 * is never a zero.
 *
 * @param {Record<string, number|null|undefined>|null|undefined} quota
 * @param {string} bucketKey
 * @returns {{ value: number, bucket: string } | null}
 */
export function gatingSource(quota, bucketKey) {
  const own = quota?.[bucketKey] ?? null;
  // Already the shared bucket: max(x, x) is x.
  if (bucketKey === 'unified7d') return own == null ? null : { value: own, bucket: bucketKey };
  const shared = quota?.unified7d ?? null;
  if (own == null) return shared == null ? null : { value: shared, bucket: 'unified7d' };
  if (shared == null) return { value: own, bucket: bucketKey };
  // Ties name the family bucket rather than the shared one. Both are true at
  // equality, and the family key is the more specific of the two answers to
  // "which window is this account out of for this model".
  return shared > own ? { value: shared, bucket: 'unified7d' } : { value: own, bucket: bucketKey };
}
