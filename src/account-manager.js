import { refreshAccessToken, isTokenExpiringSoon, isTokenExpired } from './oauth.js';
import { sameIdentity } from './identity.js';
import { weeklyBucketForModel, modelGlobMatches, modelGlobOverlaps, gatingSource, WEEKLY_BUCKET_KEYS, familyModelsMatching, globCovers, familyPatternFor } from './model.js';
import { SessionTracker } from './session-tracker.js';
import { WindowWatcher } from './window-watcher.js';
import { decideBand, explainBand, pressureOf, assertNever } from './band-decision.js';
import { decidePick, decidingTerms, pressureRank, runnerUp, tiedWith } from './pick-decision.js';

// Re-exported for callers that import these model helpers from here.
export { isFableModel, parseRequestModel, parseAdvisorModel } from './model.js';

// How long after a successful token refresh a forced (post-401) refresh is
// suppressed. Long enough to cover the 401s from requests already in flight
// when the token turned over, short enough that a genuinely bad new token
// recovers on the next request rather than staying stuck.
const FORCED_REFRESH_FLOOR_MS = 10_000;

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) is intentionally excluded.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
  'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset', 'unifiedStatus',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
];

// The quota fields carrying a utilization; each has a `<field>Reset` naming the
// window it is a fraction of.
const UTILIZATION_FIELDS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable'];

// Is `v` a utilization? Only a finite, non-negative number is. Above 1 is real
// (an account in overage), so only the lower bound is enforced — but below 0 is
// not a smaller number, it is more headroom than the window has: `1 - used`
// grows without limit, and one negative value out-scores every healthy account
// by hundreds of orders of magnitude while never reaching the switch threshold
// that would rotate off it.
function isUtilization(v) {
  return Number.isFinite(v) && v >= 0;
}

// Is `v` a window reset? A wall-clock instant, so finite and after the epoch.
// A non-numeric one is worse than a wrong one: `now >= reset` can never hold,
// so _clearExpiredQuotas can never retire that bucket, and an account sitting
// at or over threshold is out of rotation until someone deletes the state file
// by hand — nothing else can repopulate a window that never expires.
function isResetMs(v) {
  return Number.isFinite(v) && v > 0;
}

// Is `v` a counter (a token/request limit or remainder)? Finite and not
// negative; the ratios built from these gate selection.
function isCount(v) {
  return Number.isFinite(v) && v >= 0;
}

// Is `v` a reset timestamp for the standard (API-key) quotas? Stored as the
// upstream string, but read through Date, so it has to survive that.
function isResetStamp(v) {
  return typeof v === 'string' && Number.isFinite(new Date(v).getTime());
}

// The domain of every quota field, by name. EVERY write of a quota value goes
// through setQuotaField, which consults this: a response header, the usage
// endpoint and the restored state file are all equally untrusted inputs, and
// nothing between writing a state file and reading it back guarantees a value
// still means what it did. A field absent from this table is not a quota value.
const QUOTA_DOMAINS = {
  unified5h: isUtilization,
  unified7d: isUtilization,
  unified7dSonnet: isUtilization,
  unified7dFable: isUtilization,
  unified5hReset: isResetMs,
  unified7dReset: isResetMs,
  unified7dSonnetReset: isResetMs,
  unified7dFableReset: isResetMs,
  unifiedStatus: v => typeof v === 'string' && v.length > 0,
  tokensLimit: isCount,
  tokensRemaining: isCount,
  requestsLimit: isCount,
  requestsRemaining: isCount,
  resetsAt: isResetStamp,
};

/** Store `value` in `account.quota[field]` if it is a value that field can
 * hold, and report whether it was stored. The single writer: response headers,
 * the usage-endpoint probe and restored state all come through here, so no
 * out-of-domain value is ever stored in the first place and there is one place
 * to read to know what is accepted. */
function setQuotaField(account, field, value) {
  const inDomain = QUOTA_DOMAINS[field];
  if (!inDomain || !inDomain(value)) return false;
  account.quota[field] = value;
  return true;
}

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,            // utilization 0-1
    unified7d: null,            // utilization 0-1
    unified7dSonnet: null,      // utilization 0-1 (Sonnet-specific weekly bucket)
    unified7dFable: null,       // utilization 0-1 (Fable-specific weekly bucket)
    unified5hReset: null,       // ms timestamp
    unified7dReset: null,       // ms timestamp
    unified7dSonnetReset: null, // ms timestamp
    unified7dFableReset: null,  // ms timestamp
    unifiedStatus: null,        // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

// Build a fresh in-memory account record from a config/disk account object.
// Shared by the constructor and addAccount() so the field set can never drift
// between startup accounts and runtime-added ones (a divergence here once left
// runtime-added accounts without `inFlight`, hanging every request in admit()).
function makeAccount(acct, index) {
  return {
    index,
    name: acct.name,
    type: acct.type,
    accountUuid: acct.accountUuid || null,
    orgUuid: acct.orgUuid || null,
    orgName: acct.orgName || null,
    // One finite numeric form, fixed here so every selector can compare it
    // strictly. `priority` reaches us straight from hand-edited JSON, where a
    // quoted "0" and a bare 0 look the same and are not: strict equality reads
    // them as different tiers, which silently disables the load and reset
    // tiebreaks (every tier holds one account, so the first one always wins)
    // and empties the pressure band's top tier.
    priority: Number(acct.priority) || 0,
    disabled: acct.disabled || false,
    upstream: acct.upstream || null,
    modelMap: acct.modelMap || null,
    models: acct.models || null,
    credential: acct.accessToken || acct.apiKey,
    refreshToken: acct.refreshToken || null,
    expiresAt: acct.expiresAt || null,
    status: 'active',
    // No quota is known at startup, so start probing: the first response for
    // an account reveals its weekly limit and triggers re-evaluation.
    probing: true,
    quota: emptyQuota(),
    usage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      // The two cache fields upstream reports alongside `input_tokens` and that
      // nothing read until now. `totalInputTokens` counts uncached input only,
      // so on its own it understates what a request actually cost this account
      // by whatever the cache served.
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      // The same totals split by weekly bucket. Fable meters into its own
      // weekly, so what a point there costs in 5h capacity is its own
      // question, and a sum across families cannot be taken apart later.
      byBucket: {},
      totalRequests: 0,
      lastUsed: null,
    },
    rateLimitedUntil: null,
    throttledAt: null,
    // Storm control (see admit/release): in-flight upstream requests and the
    // time this account last became the current one (starts a ramp window).
    inFlight: 0,
    rampStartedAt: null,
    // Rate-limit pause (see pauseAccount): a short window during which new
    // requests wait in admit() rather than flooding — set from a 429's
    // retry-after. Distinct from `throttled`/rateLimitedUntil: it does NOT
    // make the account unavailable, so selection never rotates away from it.
    pausedUntil: null,
    // When this account's token was last successfully refreshed. Gates forced
    // (post-401) refreshes so a burst of stale in-flight requests can't rotate
    // the refresh-token family once per request — see ensureTokenFresh.
    _lastRefreshAt: null,
  };
}

// Does a declared `models` entry name `model`? The declared side may carry a
// trailing [Nm] context-length suffix (e.g. "deepseek-v4-pro[1m]"); we match it
// against a bare request too. Shared by _accountOwnsModel's two lookups so the
// predicate can't drift.
// The declared side without its context-length suffix. Its own function because
// TWO things need it and a second copy is a second thing to rot: `modelMatches`
// below, and the enumeration of ids a `models` claim can discriminate on
// (`_claimableIds`). A claim of `x[1m]` answers for a request of plain `x`, so
// any enumeration that lists claim strings verbatim silently misses that id.
function bareModelId(declared) {
  return declared.replace(/\[\d+m\]$/, '');
}

function modelMatches(declared, model) {
  return declared === model || bareModelId(declared) === model;
}

// Follow a by-index account reference through the removal of `removed`: the
// slot is gone, everything above it moves down one. Null when the reference
// named the account that went away.
function remapIndexRef(ref, removed) {
  const idx = Number(ref);
  if (idx === removed) return null;
  return idx > removed ? String(idx - 1) : ref;
}

// A representative model for a route's own globs, used to report what that route
// does right now (which accounts may serve it, and which one it would pick).
// Taken from the route object rather than looked up by name, so two routes
// sharing a name are still each described by their own globs.
function sampleModelFor(route) {
  return route.match[0].replace(/\*/g, '') || 'model';
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, { refreshFn = refreshAccessToken, throttleProbeFloorMs, forcedRefreshFloorMs = FORCED_REFRESH_FLOOR_MS, routes, ramp, distributeSessions = false, sessionTracker, expiryRouting } = {}) {
    // How long a just-minted token is trusted against a forced refresh.
    this._forcedRefreshFloorMs = forcedRefreshFloorMs;
    // Injectable for tests (mirrors Prober's probeFn); defaults to the real
    // OAuth token refresh.
    this._refreshFn = refreshFn;
    this.accounts = accounts.map((acct, index) => makeAccount(acct, index));
    this.currentIndex = 0;
    // Session awareness (issue #109). The tracker is always on (passive — it just
    // observes the x-claude-code-session-id header for the status readout).
    // `distributeSessions` gates the behavioural change: keep each session on its
    // account for cache reuse, but spread NEW sessions across equal-priority
    // accounts by load instead of funnelling them all onto the current one.
    this.sessionTracker = sessionTracker || new SessionTracker();
    this.distributeSessions = !!distributeSessions;
    // Ephemeral per-route manual pins (routeName → account index). Not persisted:
    // like the global manual switch (currentIndex) these are runtime overrides that
    // bias selection for a route's models and reset on restart. A pinned account
    // that becomes ineligible is skipped — routing falls back to best-available.
    this.routePins = new Map();
    this.switchThreshold = switchThreshold;
    this.setRoutes(routes);
    // Expiry-pressure routing (opt-in): prefer accounts whose governing weekly
    // quota is ample AND expires soon, so the quota closest to being lost is
    // spent first. See _topPressureBand for the ranking and the reasoning.
    this.setExpiryRouting(expiryRouting);
    // Rollover-event bookkeeping for pin/current preemption. A jump forward in
    // a governing weekly reset means that window rolled over — the one event
    // that re-opens an otherwise-sticky choice. A pinned session's watcher
    // lives on its SessionTracker record, so it is created, renumbered and
    // evicted with the pin it belongs to; the global current account, which no
    // session owns, keeps its own.
    this._currentSeen = new WindowWatcher();
    // Rollover counters, monotonic since daemon start. They live here rather
    // than on `expiryRouting` because setExpiryRouting REPLACES that object on
    // every config reload, and a counter an operator can zero by touching the
    // config file cannot answer "has this fired since I started watching it".
    this._rolloverStats = { detected: 0, preempted: 0 };
    // Throttle for the stuck-rollover line, keyed by the event it describes —
    // (account index, bucket) — so two genuinely different stuck events are
    // both reported while one busy session cannot repeat either. Keyed by
    // session id it would be unbounded: that id is a client-supplied header.
    this._rolloverStuckLogAt = new Map();
    // Storm control: when rotation switches to a fresh account, a burst of
    // in-flight requests (e.g. dozens of agents failing over together) would all
    // hit it at once and instantly throttle it — cascading down the fleet
    // (issue #84). admit() caps concurrent requests to a just-switched account
    // and ramps the cap up over a short window, so the first few reveal whether
    // it's also near-exhausted before the whole herd commits.
    this.ramp = {
      enabled: true,
      startConc: 1,       // concurrent requests allowed at the instant of a switch
      stepConc: 1,        // cap increase per stepMs
      stepMs: 250,        // → +stepConc every 250ms (default ramps ~4 req/s)
      windowMs: 30_000,   // after this, pacing stops entirely (cap = Infinity)
      pollMs: 50,         // how often a waiting request re-checks the cap
      ...ramp,
    };
    // When every account reads as over-quota we would otherwise refuse locally
    // forever (a stale cached utilization is never re-validated because no
    // request is ever sent). Instead, allow one real upstream probe at most this
    // often to refresh the cached quota. See _selectProbe.
    this.probeIntervalMs = 60_000;
    this._nextProbeAt = 0;
    // Minimum time a 429 hold is respected verbatim before a throttled account
    // becomes probe-eligible (see _isProbeable). Long enough to honor a genuine
    // retry-after, short enough that a stale hold cannot pin the fleet.
    this.throttleProbeFloorMs = throttleProbeFloorMs
      ?? (Number(process.env.TEAMCLAUDE_THROTTLE_PROBE_FLOOR_MS) || 60_000);
  }

  /** Start (or restart) the ramp window for an account that just became current,
   * so a failover burst is paced onto it rather than all landing at once. */
  _beginRamp(account) {
    if (account && this.ramp.enabled) account.rampStartedAt = Date.now();
  }

  /**
   * Make `account` the current one. EVERY writer of currentIndex goes through
   * here, because establishing the account and recording a rollover baseline
   * for it are one act: a baseline is what makes that window's next roll a
   * detected jump rather than a first sight, and an account established
   * without one rides its freshly-rolled window until the following week.
   * Sessions route without ever consulting currentIndex, so a stretch of
   * session traffic is exactly the gap in which that roll goes unseen.
   *
   * The only assignments to currentIndex outside this method are removeAccount's
   * renumbering, which follows the same account through an index shift rather
   * than establishing a different one — and where it does land on a different
   * one, it comes back through here.
   */
  _setCurrent(account) {
    this.currentIndex = account.index;
    this._currentSeen.seed(account.index, this._bucketWindows(account));
  }

  /**
   * Make the account at `index` current on an operator's say-so — the TUI's 's'
   * and the /teamclaude/switch endpoint, which are the same act by two routes.
   * A manual choice establishes an account exactly as rotation's does, so it
   * takes the same baseline with it: parked on an account with none, the fleet
   * reads that account's next weekly roll as a first sight and never preempts
   * off it. Returns false for an index that names no account.
   */
  setCurrentAccount(index) {
    const account = this.accounts[index];
    if (!account) return false;
    this._setCurrent(account);
    return true;
  }

  /** Max concurrent upstream requests allowed to `account` right now. Infinity
   * once the ramp window has elapsed (or ramping is off / never started). */
  _rampCap(account, now = Date.now()) {
    if (!this.ramp.enabled || account.rampStartedAt == null) return Infinity;
    // Clamp to 0: pauseAccount arms rampStartedAt in the FUTURE (pause-end), so a
    // call during the pause would otherwise yield a negative elapsed → negative
    // cap. admit()'s pause branch already guards this, but keep _rampCap sound on
    // its own — a future start simply means "cap is at its floor (startConc)".
    const elapsed = Math.max(0, now - account.rampStartedAt);
    if (elapsed >= this.ramp.windowMs) { account.rampStartedAt = null; return Infinity; }
    return this.ramp.startConc + Math.floor(elapsed / this.ramp.stepMs) * this.ramp.stepConc;
  }

  /**
   * Reserve a concurrency slot on `account` before sending upstream. Waits while
   * the account is in a rate-limit pause (a 429's retry-after window) and while
   * it is over its current ramp cap. Fail-open: returns true once a slot is taken
   * (always eventually — the pause ends and the ramp cap grows), or false if
   * `isAborted()` reports the client went away while waiting. Pair every `true`
   * with a `release(index)`.
   */
  async admit(index, isAborted) {
    const account = this.accounts[index];
    if (!account) return true;
    while (true) {
      if (isAborted?.()) return false;
      const now = Date.now();
      // Rate-limit pause: hold new requests off this account until the window
      // passes instead of flooding it (which would deepen the 429). Not a
      // rotation trigger — the account stays selectable the whole time.
      if (account.pausedUntil && now < account.pausedUntil) {
        await new Promise(r => setTimeout(r, Math.min(account.pausedUntil - now, this.ramp.pollMs * 4)));
        continue;
      }
      const cap = this.ramp.enabled ? this._rampCap(account, now) : Infinity;
      if (account.inFlight < cap) { account.inFlight++; return true; }
      await new Promise(r => setTimeout(r, this.ramp.pollMs));
    }
  }

  /** Release a slot taken by admit(). Safe to call once per successful admit. */
  release(index) {
    const account = this.accounts[index];
    if (account && account.inFlight > 0) account.inFlight--;
  }

  /**
   * Pause an account after a rate-limit (non-quota) 429 so concurrent requests
   * wait in admit() instead of piling on. Unlike markRateLimited this does NOT
   * set `throttled`/rateLimitedUntil, so _isAvailable still returns true and
   * selection never rotates away — rotation is reserved for quota exhaustion.
   * When the pause lifts, the held requests are released through a fresh ramp
   * window (storm control) so they trickle out rather than flood. Extends an
   * existing pause rather than shortening it.
   */
  pauseAccount(index, seconds) {
    const account = this.accounts[index];
    if (!account) return;
    const until = Date.now() + Math.max(0, seconds) * 1000;
    account.pausedUntil = Math.max(account.pausedUntil || 0, until);
    // Arm the ramp to begin when the pause ends: while paused, admit() holds on
    // the pause branch; once it lifts, _rampCap counts from here and releases the
    // backlog gradually (startConc, then +stepConc per step).
    if (this.ramp.enabled) account.rampStartedAt = account.pausedUntil;
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   *
   * `advisorModel` is the second model an advisor request carries (Claude Code's
   * advisor tool, nested in tools[] — see parseAdvisorModel): the advisor
   * sub-inference runs on the SAME account and spends that model's family
   * bucket, so the account must be eligible for both models. When no account
   * satisfies both, selection degrades to executor-only routing so the main
   * request keeps flowing (upstream then fails just the advisor call).
   *
   * `decision` is an optional out-object recording what this selection actually
   * did, for the bookkeeping that runs after it:
   *   - `viaCurrent`: the sticky current-account walk produced this account.
   *     Only such a request may settle that walk's pending rollover — a session
   *     pin, a /tc-acct/ pin and the keep-warm scheduler never consult
   *     `currentIndex`, so confirming one of those would swallow an event
   *     nothing acted on.
   *   - `advisorServed`: false when selection degraded to executor-only, so the
   *     advisor sub-inference is dropped upstream and its family is NOT spent
   *     on the account that serves this request.
   * Hand the same object to recordSession and confirmRouted. Deriving either
   * answer at those call sites instead would be re-deriving it from state that
   * has moved on; absent, both read as "cannot tell", which is the safe
   * direction — an event stays owed rather than being consumed wrongly.
   */
  getActiveAccount(exclude = null, model = null, advisorModel = null, sessionId = null, decision = null) {
    // Clear expired quotas across all accounts and switch proactively if a
    // session reset made a sooner-expiring account the better choice. This runs
    // on every request so the behaviour holds without the TUI render loop.
    this.refreshExpiredQuotas();
    // Session-affinity distribution (opt-in): keep a session on its pinned
    // account for cache reuse, and route a new session to the least-loaded
    // account. Only when enabled, only for a real session, and only outside a
    // manual route pin (which must still win). Falls through to the normal walk
    // if nothing session-eligible is found (e.g. the whole tier is exhausted).
    if (this.distributeSessions && sessionId && !this._pinnedAccountForModel(model, advisorModel)) {
      const acc = this._selectForSession(sessionId, exclude, model, advisorModel);
      // Every account this path can return is filtered through _isAvailable with
      // the advisor's model, so the answer here is always true today. It is
      // asked rather than asserted because the walk below made exactly that
      // argument and a last resort was added underneath it: the record of what
      // was served and the constraint on serving it are the same predicate, or
      // the next branch added here claims a family upstream refuses.
      if (acc) {
        if (decision && advisorModel) decision.advisorServed = this._canServeAdvisor(acc, advisorModel);
        return acc;
      }
    }
    if (advisorModel) {
      const account = this._select(exclude, model, advisorModel, false, decision);
      if (account) {
        // Normally the constraint guarantees this. Its last resort does not:
        // when every account is unavailable, _selectNext reopens whichever one
        // has already reset without re-checking the advisor's bucket. Serving
        // the request from there is that branch's whole purpose; claiming the
        // advisor's family for it is not, since upstream refuses that
        // sub-inference exactly as it does on the degrade path below.
        if (decision) decision.advisorServed = this._canServeAdvisor(account, advisorModel);
        return account;
      }
      // Throttled so a busy advisor session doesn't flood the activity log.
      if (Date.now() >= (this._advisorDegradeLogAt || 0)) {
        this._advisorDegradeLogAt = Date.now() + 60_000;
        console.log(`[TeamClaude] No account eligible for advisor model "${advisorModel}" — routing by request model only`);
      }
      // Degraded: whatever serves this request serves the executor alone.
      if (decision) decision.advisorServed = false;
    }
    return this._select(exclude, model, null, true, decision);
  }

  /** The selection walk getActiveAccount runs: manual pin → current account →
   * best-available. `allowProbe` gates the exhausted-fleet probe fallback so the
   * advisor-constrained pass can fail soft (degrade to executor-only) instead of
   * burning the throttled probe slot on the stricter constraint. */
  _select(exclude, model, advisorModel, allowProbe, decision = null) {
    // getActiveAccount can run this walk twice — an advisor-constrained pass and
    // then, if that comes up empty, a plain one — against the same decision
    // object. Each pass answers for itself: left latched from a pass that found
    // nothing, `viaCurrent` says a manual pin's account came from the current
    // walk, and confirming it swallows an event that walk never acted on.
    if (decision) decision.viaCurrent = false;
    // A manual per-route pin biases selection for that route's models (independent
    // of the global currentIndex). Honored only while eligible — otherwise we fall
    // through to normal best-available selection so requests keep flowing.
    const pinned = this._pinnedAccountForModel(model, advisorModel);
    if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinned.index)) return pinned;
    // Past the manual pin, this request's account comes from the sticky
    // current-account walk — which is what makes it the request entitled to
    // settle that walk's pending rollover, whether it stays put or is moved off.
    if (decision) decision.viaCurrent = true;
    const current = this.accounts[this.currentIndex];
    // `model` scopes availability: an account whose Fable weekly bucket is spent
    // is still fully usable for other models, so it is only excluded when THIS
    // request targets Fable (see _isAvailable).
    // `exclude` is a per-request set of indices already tried this request (e.g.
    // an account that just threw a transport error). It is never a persistent
    // status change — the account stays healthy for the next request.
    // We just learned a probed account's weekly quota — re-evaluate which
    // account is best now that its limit is known.
    if (current && current.requalify) {
      // Consume the flag on the final pass; the advisor-constrained pass leaves
      // it set unless it actually switches, so the requalification isn't lost
      // when that pass comes up empty and selection degrades.
      if (allowProbe) current.requalify = false;
      const next = this._selectNext(exclude, model, advisorModel);
      if (next) { current.requalify = false; return next; }
    }
    if (this._isAvailable(current, model, advisorModel) && !exclude?.has(current.index)) {
      // Rollover preemption (expiry routing): the current account's governing
      // window rolled over, making it the freshest and furthest-dated choice —
      // re-rank instead of staying parked on it until the 98% threshold that
      // low-utilization fleets never reach. Observe on every pass, act only on
      // the final one: the advisor-constrained pass returns early when it
      // succeeds, so a pass that never looked would leave an all-advisor stretch
      // blind to the window turning over, and the next plain request would seed
      // post-roll state and miss the event for good. Detection seeds a first-
      // sight baseline but never advances a window past a pending rollover;
      // only confirmRouted does that, and only once a request has actually been
      // served elsewhere — which is why a pass that cannot act is harmless.
      const rolled = this.expiryRouting.enabled && this.expiryRouting.preempt
        && this._currentRolledOver(current, model);
      if (allowProbe && rolled) {
        const next = this._selectNext(exclude, model, advisorModel);
        // _selectNext re-ranks; it may well hand back the account we are trying
        // to move off, and "nothing else was eligible" is the stuck case, not a
        // preemption. Nothing else in the log distinguishes the two. The move
        // itself is counted where it lands (settleServed), not here: selection
        // only ASKS, and an attempt re-routed here can still fail back.
        if (!next || next.index === current.index) this._noteStuckRollover(current, model);
        if (next) return next;
      }
      const betterExists = this._preemptedBy(current, model, advisorModel, exclude);
      return betterExists ? this._selectNext(exclude, model, advisorModel) : current;
    }
    const next = this._selectNext(exclude, model, advisorModel);
    if (next) return next;
    // No account is under the switch threshold. Before refusing locally, allow a
    // throttled probe so a stale/poisoned cached quota can't pin us in a
    // permanent "all exhausted" state — the probe's real response refreshes the
    // quota (or upstream's own 429 converts soft exhaustion into a hard
    // rate-limit hold). null here means the caller emits the synthetic 429.
    return allowProbe ? this._selectProbe(exclude, model) : null;
  }

  /** Session-affinity selection (opt-in, issue #109). Honor a known session's
   * pin when that account is still eligible and not preempted by a
   * higher-priority one; otherwise route the session to the least-loaded
   * eligible account. Returns null if nothing is eligible, so the caller falls
   * back to the normal quota-driven walk. Does NOT record the pin — that happens
   * on the actual route (recordSession), so retries/failover re-pin naturally. */
  _selectForSession(sessionId, exclude, model, advisorModel) {
    // The pin is per governing bucket, and this request is bound by the
    // EXECUTOR's: one request goes to one account, so the executor's affinity is
    // what binds it and the advisor's model is a constraint on that choice
    // (_isAvailable, below), not a second key. Keyed by _weeklyBucketFor — the
    // request's own bucket — rather than by the window _governingBucket resolves
    // it to, because the lookup happens before an account is chosen and so
    // cannot depend on what any particular account reports.
    const pinIdx = this.sessionTracker.pinnedAccount(sessionId, this._weeklyBucketFor(model));
    if (pinIdx != null) {
      const pinned = this.accounts[pinIdx];
      if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinIdx)) {
        // Rollover preemption (expiry routing): the pinned account's governing
        // window rolled over, so it is now the freshest AND furthest-dated
        // account — keeping the pin would burn the window that just gained a
        // full week while sooner-expiring quota goes unspent. This is the ONLY
        // pressure-driven force on a pin; drain never preempts (see
        // _pinRolledOver). One cache miss per pinned session per rollover.
        if (this.expiryRouting.enabled && this.expiryRouting.preempt
            && this._pinRolledOver(sessionId, pinned, model)) {
          const next = this._pickLeastLoaded(exclude, model, advisorModel);
          if (next && next.index !== pinIdx) {
            // A fleet-wide rollover moves every session pinned to that account at
            // once, so the destination gets the same failover burst any other
            // switch would send it — pace it (issue #84).
            this._beginRamp(next);
            console.log(`[TeamClaude] Session pin on "${pinned.name}" released — its weekly window rolled over; re-routing to "${next.name}"`);
            return next;
          }
          this._noteStuckRollover(pinned, model);
          return pinned;
        }
        // Mirror _select's priority preemption so an operator's priority order
        // still wins over a session's stickiness.
        const betterExists = this.accounts.some(a =>
          this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (pinned.priority || 0));
        if (!betterExists) return pinned;
      }
    }
    return this._pickLeastLoaded(exclude, model, advisorModel);
  }

  /** Best-available biased toward the least measured load, so new sessions
   * spread across equal-priority accounts instead of funnelling onto one. Order:
   * priority → [top pressure band, when expiry routing is on] → least measured
   * load → fewest active sessions → fewest in-flight → highest expiry pressure
   * (inert when expiry routing is off) → soonest weekly reset. */
  _pickLeastLoaded(exclude = null, model = null, advisorModel = null) {
    const now = Date.now();
    const candidates = this._bandedCandidates(exclude, model, advisorModel);
    const decision = decidePick(this._pickSnapshot(candidates, model, now));
    switch (decision.kind) {
      case 'none': return null;
      case 'picked': return candidates.find(a => a.index === decision.index) || null;
      default: return assertNever(decision, '_pickLeastLoaded');
    }
  }

  /**
   * The pick decision's view of a candidate set. Reads the accounts and the
   * session tracker; the decision itself reads neither.
   *
   * `reset` falls back to `-Infinity` rather than to a large number when the
   * governing window is unknown, preserving the pre-existing bias: an account
   * whose reset nobody has reported sorts FIRST on that term, so it gets used
   * and its quota gets discovered.
   *
   * @param {{index: number, priority?: number, inFlight?: number}[]} candidates
   * @param {string | null} model
   * @param {number} now
   * @returns {import('./pick-decision.js').PickSnapshot}
   */
  _pickSnapshot(candidates, model, now, { excludingSession = null, route = undefined } = {}) {
    const pressures = this._pickPressures(candidates, model, now, route);
    return {
      accounts: candidates.map((a, i) => {
        // `excludingSession` is the eviction a NEW session would cause, which
        // the request path has already performed by the time it selects
        // (`server.js:706` begins the session, `:999` selects) and the report
        // has not. Passing it is how the report answers over the set the
        // request will actually meet; the request path passes nothing, because
        // for it the eviction is done rather than pending.
        const measured = this.sessionTracker.loadFor(a.index, now, { excluding: excludingSession });
        return {
          index: a.index,
          priority: a.priority || 0,
          load: measured.context,
          observed: measured.reports,
          sessions: measured.sessions,
          inFlight: a.inFlight || 0,
          pressure: pressures[i],
          reset: this._governingWeeklyReset(a, model, route) || -Infinity,
        };
      }),
    };
  }

  /**
   * Each candidate's expiry pressure as the pick ranks it, positionally aligned
   * with `candidates` because `_bandSnapshot` maps that same array.
   *
   * WITH EXPIRY ROUTING OFF THE TERM IS ABSENT FOR EVERY ACCOUNT, and that is
   * the whole of the off switch. The operator has said not to rank on expiring
   * quota, so the pressure is not unknown, it is not being consulted — a
   * distinct state, named as one. Every account ranking equal makes the term
   * inert rather than special-cased, so the disabled path reduces to the term
   * order that preceded it instead of to a branch someone has to keep correct.
   *
   * @param {{index: number, quota?: Record<string, unknown>}[]} candidates
   * @param {string | null} model
   * @param {number} now
   * @returns {import('./pick-decision.js').PickPressure[]}
   */
  _pickPressures(candidates, model, now, route = undefined) {
    if (!this.expiryRouting.enabled) {
      return candidates.map(() => ({ kind: 'absent', reason: 'expiry-routing-off' }));
    }
    return this._bandSnapshot(candidates, model, now, route).accounts.map(a => pressureOf(a, now));
  }

  /** Record that a session's request was served by an account (always on, even
   * when distribution is off — the readout is passive). This is what pins a
   * session for future affinity, for the buckets this request actually spent. */
  recordSession(sessionId, accountIndex, model = null, advisorModel = null, decision = null, hold = null) {
    if (sessionId) {
      const buckets = this._requestBuckets(model, advisorModel, decision);
      this.sessionTracker.touch(sessionId, accountIndex, buckets, undefined, hold);
      this._seedPinWindows(sessionId, accountIndex, buckets);
    }
  }

  /** The weekly buckets one request spends on the account that serves it: the
   * executor's, plus the advisor's when the request carries one AND that
   * sub-inference will actually run here. An advisor sub-inference runs on the
   * SAME account, so that family's quota is spent — and its cache warmed —
   * there too, which is why both get pinned. But when no account was eligible
   * for both models, selection degraded to executor-only and upstream drops the
   * advisor call: that account served the executor alone, and claiming its
   * family here would pin (and settle) a bucket on an account that never served
   * it — quite possibly one that cannot. Only selection knows which happened,
   * so only an explicit `decision.advisorServed` claims that family: no
   * decision means no evidence, and the safe reading of no evidence is that the
   * session re-routes its advisor traffic next request rather than that this
   * account owns it. */
  _requestBuckets(model, advisorModel = null, decision = null) {
    const buckets = [this._weeklyBucketFor(model)];
    if (advisorModel && decision?.advisorServed) {
      const advisor = this._weeklyBucketFor(advisorModel);
      if (!buckets.includes(advisor)) buckets.push(advisor);
    }
    return buckets;
  }

  /** Mark a session request as in flight / finished. Paired around the whole
   * client request (including retries) so a long streaming completion keeps the
   * session counted as active for its full duration.
   *
   * Returns an opaque HOLD identifying this request, which the caller passes to
   * `recordSession` (so the pins it spends are counted as live) and back to
   * `endSession` (so they stop being). It identifies a request because the
   * session cannot: two concurrent requests share one session id and spend
   * different pins, which is the whole reason the session-level counter could
   * not answer this. Losing it is not fatal, see `endRequest`. */
  beginSession(sessionId) {
    return sessionId ? this.sessionTracker.beginRequest(sessionId) : null;
  }

  endSession(sessionId, hold = null) {
    if (!sessionId) return;
    const s = this.sessionTracker.endRequest(sessionId, hold);
    // The session is quiescent: no attempt is left that could still move it, so
    // where each bucket was last SERVED is now final and any rollover owed on
    // it can be resolved. Settling earlier lets a sibling request that was
    // served off the rolled account bank the move while a slower one is still
    // failing back onto it — the session then rides the rolled account with
    // nothing owed, until that window comes round again a week later.
    //
    // This is also the one moment a preemption is known to have HAPPENED, which
    // is what the counter names. Counted at selection instead it counts the
    // re-routes selection asked for, including the ones that failed back — so it
    // can report more moves than there were rollovers to move.
    if (s && s.inFlight === 0) this._rolloverStats.preempted += s.windows?.settleServed() || 0;
  }

  /** { known, active, perAccount } session counts for status/TUI. */
  sessionStats() {
    return this.sessionTracker.stats();
  }

  /**
   * Like getActiveAccount, but if the selected account's OAuth token has ALREADY
   * expired it blocks on a refresh before returning — so a caller that injects
   * the token immediately (the MITM relay) never sends a dead token and eats a
   * 401. A token that is merely expiring soon (still valid) is left to the
   * caller's opportunistic background refresh; only a hard-expired one blocks.
   */
  async getActiveAccountFresh(exclude = null, model = null, advisorModel = null, sessionId = null, decision = null) {
    const account = this.getActiveAccount(exclude, model, advisorModel, sessionId, decision);
    if (account && account.type === 'oauth' && account.refreshToken
        && isTokenExpired(account.expiresAt)) {
      await this.ensureTokenFresh(account.index); // coalesces with any in-flight refresh
    }
    return account;
  }

  /**
   * Read-only: the index of the account a request for `model` would be served by
   * right now — getActiveAccount's walk (manual pin → the global current account
   * if it can serve the model → best-available) without mutating currentIndex.
   * Returns null when nothing can serve `model` at the moment. The TUI uses this
   * to mark the single account each secondary bucket (Fable/Sonnet) currently
   * routes to — the F7/S7 analogue of the ► that marks the default route's
   * current account.
   *
   * It answers for a SESSION-LESS request and says so here rather than in the
   * caller, because a preview that quietly stood for more than it computes is
   * the shape this branch has been fixing all round. Three things the real walk
   * does are deliberately absent, each because it has no meaning without a
   * request: the exhausted-fleet probe (which mutates and sends traffic), the
   * session-affinity path (there is no session), and rollover preemption (which
   * consumes an event a preview must not spend).
   *
   * THE ENUMERATION STARTS AT `getActiveAccount`, NOT AT `_select`. Walking
   * `_select` alone is how the prologue — `refreshExpiredQuotas`, which clears
   * expired windows and can move `currentIndex` before any selection runs —
   * went unprojected for a round: every branch of the walk was mirrored
   * faithfully against a starting state the request itself would have changed.
   */
  previewRouteIndex(model, observed = this._observedFleet(), route = null) {
    // A PREVIEW, and its only callers are displays: the status report and the
    // TUI. So it observes without writing — asking where a request would go must
    // not be the thing that decides where the next one does. Every read below is
    // of the PROJECTED fleet: the post-prologue state a request would meet,
    // computed on copies, so nothing here consumes the session-reset event
    // `refreshExpiredQuotas` owns.
    const observe = this._observeOpts(observed, route);
    const live = this._pinnedAccountForModel(model, null, route ?? undefined);
    const pinned = live ? observed.accounts[live.index] : null;
    if (pinned && this._isAvailable(pinned, model, null, observe)) return pinned.index;
    const current = observed.accounts[observed.currentIndex];
    // REQUALIFICATION re-ranks unconditionally (`_select`, the branch above the
    // availability check), and it is the ordinary startup state rather than an
    // exotic one: accounts are constructed `probing`, and `applyUsageData` sets
    // `requalify` the moment a weekly window is learned, which the prober does
    // to every account. So a freshly started fleet carries it on every account
    // until a plain request consumes it — and an idle fleet is exactly when
    // someone runs `status`.
    //
    // Projected, never performed. `_selectNext` re-ranks by clearing the flag
    // and calling `_setCurrent`; the preview reaches the same answer through
    // `_pickBestAvailable` and leaves both alone, which is the same split as
    // `_expiredQuotaView` and for the same reason.
    if (current && current.requalify) {
      const next = this._pickBestAvailable(null, model, null, observe);
      if (next) return next.index;
    }
    if (current && this._isAvailable(current, model, null, observe)) {
      // Mirror getActiveAccount's priority preemption: a strictly higher-priority
      // available account wins over a healthy current one; same tier stays put.
      const better = observed.accounts.some(a =>
        this._isAvailable(a, model, null, observe) && (a.priority || 0) < (current.priority || 0));
      if (!better) return current.index;
    }
    const best = this._pickBestAvailable(null, model, null, observe);
    if (best) return best.index;
    // `_selectNext`'s last resort, projected the way requalification is: with
    // nothing eligible a request does not fail, it reopens the account whose
    // hold has already elapsed. Naming it costs nothing and is the difference
    // between "nothing can serve this" and the account every request is landing
    // on. Chosen here, performed only by `_selectNext`.
    const reopened = this._resurrectTarget(null, model, null, observe);
    return reopened ? reopened.index : null;
  }

  _isProbeable(account) {
    if (!account) return false;
    // Never probe an account the operator has taken out of rotation or one
    // whose token is broken — those are hard states, not stale guesses.
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted') return false;
    // A 429 hold is respected verbatim at first, but a hold is a snapshot: the
    // 429 that armed it may itself have been transient (e.g. the retry burst
    // after a network flap), and while it lasts NOTHING revalidates it — so a
    // stale hold pins the fleet in synthetic 429s for up to an hour and only a
    // restart (which wipes the in-memory hold) recovers. After the floor, let
    // the account be probed: the probe's real response either clears the hold
    // (any non-429 → clearRateLimited) or re-arms it with a fresh retry-after.
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return Date.now() >= (account.throttledAt || 0) + this.throttleProbeFloorMs;
    }
    return true;
  }

  /** Highest utilization across the quota dimensions that govern `model` (0-1),
   * used to pick the least-exhausted probe target. Mirrors _isNearQuota: the
   * shared 5-hour bucket plus the model's governing weekly bucket. With no model
   * it falls back to the shared weekly. */
  _maxUtilization(account, model = null) {
    const q = account.quota;
    let max = 0;
    if (q.unified5h != null) max = Math.max(max, q.unified5h);
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null) max = Math.max(max, weeklyVal);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      max = Math.max(max, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      max = Math.max(max, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return max;
  }

  /**
   * THE rule for which weekly bucket governs a request for `model` on this
   * account: the model family's own bucket (unified7dFable for Fable,
   * unified7dSonnet for Sonnet, a route's `bucket` override where one applies)
   * when the account reports a UTILIZATION for it, else the shared unified7d it
   * spends from otherwise. One rule, asked by everything: the availability
   * gate, the pressure ranking and the rollover window key.
   *
   * Presence of the utilization decides it, and only that, because the gate is
   * the one thing that must never read as unknown — an account reporting Fable
   * at 0.9 has to be barred from Fable traffic. When the same bucket reports no
   * reset, its pressure is simply unknown: substituting the shared window's
   * horizon would divide one bucket's headroom by another bucket's clock and
   * rank an account on quota it does not have, steering Fable traffic straight
   * into the most Fable-spent account in the fleet.
   */
  _governingBucket(account, model, route) {
    return this._windowForBucket(account, this._weeklyBucketFor(model, route
      ?? this._routeForModel(model)));
  }

  /**
   * Utilization (0-1) that GATES `model` here: the higher of the governing
   * family bucket and the shared weekly one, or null when neither reports.
   *
   * WHY A MAXIMUM. Family spend meters twice, once in the family bucket and
   * once in the shared one, so the two are not independent. Reading the family
   * bucket alone let an account sitting at `unified7d` 1.00 with
   * `unified7dFable` 0.20 keep serving Fable, and every such request pushed the
   * shared bucket further past its cap. Once the shared bucket is spent, family
   * requests are the only ones still admitted, which makes it a one-way
   * ratchet rather than a bounded overshoot. Upstream measured the coupling
   * directly (issue #175): per-request increment on the shared bucket
   * [+1.14e-4, +5.21e-4] against Fable-only traffic.
   *
   * NULL IS UNREPORTED AND NEVER ZERO. A max is an invitation to floor an
   * absent bucket at 0, and 0 reads as "empty" — the opposite of "unknown", and
   * in the direction that keeps an account serving. If one side is absent the
   * answer is the other; if both are, the answer is null and the gate leaves
   * this dimension alone rather than deciding on it.
   *
   * THE RESET DELIBERATELY DOES NOT FOLLOW. `_governingWeeklyReset` still keys
   * off `_governingBucket`, so the value here and the reset there can now name
   * different buckets. That is safe because no caller pairs them: the value has
   * exactly two consumers, this gate and `_maxUtilization`, and both ask "how
   * close to a cap" without a clock. The one site that needs a value and a
   * reset TOGETHER, `_bandSnapshot`, resolves the bucket once and reads both
   * from it, so its pair stays coherent — and it deliberately does NOT take
   * this maximum, because pressure is headroom over the time until THAT window
   * resets, and maxing across buckets would divide the shared bucket's headroom
   * by the family window's clock. That is the error `_governingBucket` above
   * already warns about. Published pressure is therefore about the governing
   * window and only that; the gate is what accounts for the other bucket, and
   * it runs first, so an account over its shared cap never reaches the band.
   */
  _governingWeekly(account, model) {
    return this._governingWeeklySource(account, model)?.value ?? null;
  }

  /** The same figure with the bucket that produced it, for a caller that has to
   * report which window barred the account. The maximum is taken once, in
   * `gatingSource`; recovering the winner by comparing the two buckets again
   * here would be a second reading of the rule this method exists to have one
   * of. */
  _governingWeeklySource(account, model) {
    return gatingSource(account.quota, this._governingBucket(account, model));
  }

  /** Reset timestamp (ms) of the bucket that governs `model` here, or null when
   * that bucket reports none. Used to spend the soonest-expiring quota first;
   * unknown sorts first, so an account whose governing window is unreported is
   * probed rather than ranked on a window that is not its own. */
  _governingWeeklyReset(account, model, route = undefined) {
    return account.quota[`${this._governingBucket(account, model, route)}Reset`] || null;
  }

  /** True when the family-specific weekly bucket that governs `model` is spent.
   * Unlike _isNearQuota this ignores the shared 5h/weekly caps — it is only used
   * to skip an account for a probe of a model it definitely can't serve. Returns
   * false for families without a dedicated bucket (they share unified7d, already
   * covered by _isNearQuota).
   *
   * FAMILY-ONLY ON PURPOSE, and it does NOT take the maximum `_governingWeekly`
   * now takes. The two answer different questions: this one asks "can this
   * account serve this family at all", the gate asks "is this account near any
   * cap that binds this request". Folding the shared bucket in here would skip
   * accounts for probes they could still have served, and a probe is how a
   * stale cached utilization gets corrected — so it would harden the very state
   * it exists to escape. The next reader will see two similar helpers diverging
   * and wonder whether one was missed: it was not. */
  _modelWeeklyExhausted(account, model) {
    const key = this._governingBucket(account, model);
    if (key === 'unified7d') return false;
    return account.quota[key] >= this.switchThreshold;
  }

  /**
   * Pick an account to send a single revalidation probe upstream when every
   * account reads as over the switch threshold. Throttled to one probe per
   * probeIntervalMs so a genuinely-exhausted fleet isn't hammered — between
   * probes this returns null and the caller falls back to the synthetic 429.
   * The chosen account is the least-utilized probeable one (most likely to have
   * stale headroom), so the refreshed quota corrects the cache fastest.
   */
  _selectProbe(exclude = null, model = null) {
    const now = Date.now();
    if (now < this._nextProbeAt) return null;

    let best = null;
    let bestPriority = Infinity;
    let bestUsage = Infinity;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isProbeable(account)) continue;
      // A family-exhausted account can't serve that family even as a probe — it
      // would just 429 again — so skip it (Fable/Sonnet) and let the caller emit
      // the synthetic 429 when no other account is available.
      if (model && this._modelWeeklyExhausted(account, model)) continue;
      // Same for routing/ownership: a probe for a routed or owned model must not
      // land on an ineligible account (it would just reject the unknown model id).
      if (model && !this._routeAllows(account, model)) continue;
      const priority = account.priority || 0;
      const usage = this._maxUtilization(account, model);
      if (priority < bestPriority ||
          (priority === bestPriority && usage < bestUsage)) {
        bestPriority = priority;
        bestUsage = usage;
        best = account;
      }
    }
    if (!best) return null;

    this._nextProbeAt = now + this.probeIntervalMs;
    this._setCurrent(best);
    this._beginRamp(best);
    if (best.status === 'throttled') {
      console.log(`[TeamClaude] All accounts unavailable — revalidating throttled "${best.name}" with a live request`);
    } else {
      console.log(`[TeamClaude] All accounts over threshold — probing "${best.name}" to refresh quota`);
    }
    return best;
  }

  _isAvailable(account, model = null, advisorModel = null, opts = {}) {
    // The null check is a lookup failure, not an availability question, so it
    // stays here rather than becoming a reason `_availability` could report.
    // Nothing enumerates a missing account, and inventing a code for one would
    // put a value in `excluded[]`'s domain that no fleet can produce.
    if (!account) return false;
    return this._availability(account, model, advisorModel, opts) === null;
  }

  /**
   * WHY an account cannot serve this request, or null when it can.
   *
   * `_isAvailable` is the projection to the boolean selection needs, so the
   * predicate that filters candidates and the report of what it filtered are
   * one evaluation. The alternative — a reporter re-asking the same questions in
   * the same order — is a second implementation of eligibility, and the way it
   * fails is by disagreeing with routing about who is eligible while claiming to
   * explain it.
   *
   * Every branch has its own code, including the two API-key limits that
   * `_isNearQuota` folds into one boolean, because the point of the field is to
   * separate states an operator would act on differently. `bucket` and `detail`
   * are present only where a measurement produced the exclusion.
   *
   * Order matters and is the order selection applies: the first bar found is
   * the one reported, so a disabled account over its weekly cap reads as
   * disabled, which is the fact to act on.
   *
   * @returns {{ reason: string, bucket: string|null, detail: number|null } | null}
   */
  _availability(account, model = null, advisorModel = null, { observe = false, now = Date.now(), route = null } = {}) {
    // Manually disabled accounts are skipped entirely until re-enabled.
    if (account.disabled) return { reason: 'disabled', bucket: null, detail: null };

    // Check rate limit expiry. `now` is the observation's instant when there is
    // one, so a hold that elapses between the projection and this call cannot
    // read as live to one and elapsed to the other.
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (now < account.rateLimitedUntil) {
        return { reason: 'throttled', bucket: null, detail: account.rateLimitedUntil };
      }
      // Past the hold: the account IS available. Writing that back is a state
      // transition the request path owns, so an observer reaches the same
      // answer without performing it.
      if (!observe) {
        account.status = 'active';
        account.rateLimitedUntil = null;
        account.throttledAt = null;
        console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
      }
    }

    if (account.status === 'exhausted') return { reason: 'exhausted', bucket: null, detail: null };
    if (account.status === 'error') return { reason: 'error', bucket: null, detail: null };
    // Model-scoped: _quotaBar checks the shared 5h bucket plus only the weekly
    // bucket that governs this model, so a spent Fable/Sonnet bucket bars just
    // that family — the account still serves every other model normally.
    const bar = this._quotaBar(account, model, { observe, route });
    if (bar) return bar;

    // Route/ownership restriction: a configured route can pin a model pattern to
    // an exclusive set of accounts; failing that, a per-account `models` claim
    // restricts an owned model to its owners. Either way an account not eligible
    // for this model is skipped so the request never lands somewhere it can't run.
    // The entry's route for the EXECUTOR's model, and never for the advisor's:
    // the advisor may belong to a different route, so `_canServeAdvisor` below
    // derives its own. An options bag read by whatever runs next would get this
    // wrong silently, which is why the route is passed rather than ambient.
    if (model && !this._routeAllows(account, model, route ?? this._routeForModel(model))) {
      return { reason: 'route-excluded', bucket: null, detail: null };
    }

    // An advisor request additionally needs the account to serve the ADVISOR's
    // model (the shared buckets were already checked above for the executor).
    if (advisorModel && !this._canServeAdvisor(account, advisorModel)) {
      return { reason: 'advisor-ineligible', bucket: null, detail: null };
    }

    return null;
  }

  /**
   * Can `account` run the ADVISOR's sub-inference — its family bucket has
   * headroom and any route/ownership rule for that model allows this account?
   * The sub-inference runs on whatever account serves the request, so this is
   * both a constraint on selection (_isAvailable) and the fact that decides
   * whether that family's quota is actually spent there (decision.advisorServed).
   * One predicate, because those two answers must never differ: claiming a
   * family the account cannot serve pins — and settles — a bucket for work
   * upstream refused.
   */
  _canServeAdvisor(account, advisorModel) {
    return !this._modelWeeklyExhausted(account, advisorModel)
      && this._routeAllows(account, advisorModel);
  }

  /**
   * The available account that would preempt `account` under the priority rule,
   * or null. A strictly lower priority value wins; within the same tier we stay
   * put, so the common case (every account at the default priority 0) never
   * thrashes. Shared by _select, which enforces it, and eligibility(), which
   * reports it — one predicate so the answer cannot drift from the behaviour.
   */
  _preemptedBy(account, model = null, advisorModel = null, exclude = null) {
    return this.accounts.find(a => this._isAvailable(a, model, advisorModel)
      && !exclude?.has(a.index)
      && (a.priority || 0) < (account.priority || 0)) || null;
  }

  /**
   * Whether the CURRENT-ACCOUNT WALK would route to an account right now, with a
   * short reason when it would not. A caller that records a manual choice (the
   * control plane's switch endpoint) needs to report whether that choice will
   * take effect, not merely that it was stored: the walk drops it on the very
   * next request both when the account cannot serve traffic and when another
   * available account outranks it on priority. Both are asked through the same
   * `_isAvailable` / `_preemptedBy` the walk itself gates on, so the flag cannot
   * promise more than that walk delivers.
   *
   * It answers for that walk and no other, which is the whole scope of a manual
   * switch: a session's pin, a route pin and the keep-warm scheduler never
   * consult `currentIndex`, so with `distributeSessions` on, existing session
   * traffic will not follow this choice however eligible the account is. Asked
   * without a model, since the switch is not about one.
   * @returns {{eligible: boolean, reason?: string}}
   */
  eligibility(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return { eligible: false, reason: 'no such account' };
    // _isAvailable also clears an expired throttle, so the specific reasons below
    // are only consulted once it has actually said no.
    if (!this._isAvailable(account)) {
      if (account.disabled) return { eligible: false, reason: 'disabled' };
      if (account.status === 'error') return { eligible: false, reason: 'in an error state and needs a re-login' };
      if (account.status === 'exhausted') return { eligible: false, reason: 'out of quota' };
      if (account.status === 'throttled') return { eligible: false, reason: 'rate-limited' };
      return { eligible: false, reason: 'at or above the switch threshold' };
    }
    // Healthy, but a higher-priority account preempts it on the next selection.
    // Phrased to read correctly after "<name> is ..." in the caller's message.
    const preemptor = this._preemptedBy(account);
    if (preemptor) {
      return { eligible: false, reason: `outranked by higher-priority account "${preemptor.name}"` };
    }
    return { eligible: true };
  }

  /**
   * Normalize and store the configurable routing table. A route pins a set of
   * model globs to an exclusive set of accounts (and may override the governing
   * quota bucket). Called from the constructor and on config reload.
   *   { name, match: string|string[], accounts?: (name|index)[], bucket? }
   */
  setRoutes(routes) {
    this.routes = (Array.isArray(routes) ? routes : []).map((r, i) => ({
      name: r.name || `route-${i + 1}`,
      match: (Array.isArray(r.match) ? r.match : [r.match]).filter(g => typeof g === 'string' && g),
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : [],
      bucket: r.bucket || null,
      color: r.color || null, // display-only accent for the route's inline marker
    })).filter(r => r.match.length);
    // Drop pins for routes that no longer exist after a reload.
    if (this.routePins?.size) {
      const names = new Set(this.routes.map(r => r.name));
      for (const name of [...this.routePins.keys()]) {
        if (name !== 'fable' && name !== 'sonnet' && !names.has(name)) this.routePins.delete(name);
      }
    }
  }

  /**
   * Normalize and store the expiry-pressure routing config. Off by default —
   * enabling changes which accounts selection considers, so it is an explicit
   * operator choice — and only a literal `true` turns it on, so a hand-edited
   * `"false"` reads as off rather than as the truthy string it is.
   *
   * `tolerance` takes a real finite number and nothing else: absent, null, "",
   * a string, Infinity and NaN all mean "no value given" and take the 1.5
   * default. Coercing instead would read `null` as 0, and an explicit 0 is a
   * meaningful setting — it clamps to 1, the strictest band, where only the
   * highest-pressure account qualifies. Silently landing there from an unset
   * key would look like the feature was disabled rather than tuned; so would
   * Infinity, which bands in every account.
   *
   * These clamps are a convenience for operators, NOT what makes the decision
   * safe. `decideBand` is exported and takes plain numbers, so it guards its own
   * preconditions; a test that routes a degenerate knob through here is testing
   * this normalisation and nothing else.
   *   { enabled?: bool, coverage?: number > 0, tolerance?: number >= 1, preempt?: bool }
   */
  setExpiryRouting(cfg) {
    const c = cfg || {};
    this.expiryRouting = {
      enabled: c.enabled === true,
      tolerance: typeof c.tolerance === 'number' && Number.isFinite(c.tolerance)
        ? Math.max(1, c.tolerance)
        : 1.5,
      preempt: typeof c.preempt === 'boolean' ? c.preempt : true,
      // How much absorptive five-hour capacity the band must add up to,
      // counted in whole accounts. One is the smallest target that describes
      // the fleet at all: it says "keep as much capacity admitted as a single
      // untouched account has". Raising it hedges wider and spends
      // non-expiring quota sooner; it is not derived from any measurement, and
      // nothing here tunes it. Same validation posture as `tolerance`: only a
      // real finite number counts, and it clamps to a positive value because a
      // target of zero admits nobody.
      coverage: typeof c.coverage === 'number' && Number.isFinite(c.coverage)
        ? Math.max(Number.MIN_VALUE, c.coverage)
        : 1,
    };
  }

  /**
   * Expiry pressure of `account` for `model`: headroom in the governing weekly
   * bucket per second until that bucket resets. High pressure = ample quota
   * about to be forfeited — spend it first. Headroom alone ignores expiry;
   * reset time alone steers into nearly-drained accounts; the ratio captures
   * both. Computed on the WEEKLY bucket only: a 5h denominator is ~30x smaller
   * and would numerically drown the weekly horizons this ordering exists to
   * respect — the 5h bucket stays an availability gate (_isNearQuota), not a
   * ranking term.
   * Returns null when the bucket's utilization or reset is unknown; callers
   * rank unknown in the top band, mirroring the unknown-reset probe bias.
   * `now` is passed in by _topPressureBand so every account in one band is
   * scored against the same instant.
   */
  _expiryPressure(account, model = null, now = Date.now()) {
    const pressure = this._pressureVariant(account, model, now);
    switch (pressure.kind) {
      case 'known': return pressure.value;
      case 'absent': return null;
      default: return assertNever(pressure, '_expiryPressure');
    }
  }

  /**
   * The same pressure in the decision layer's own encoding, absence and all.
   *
   * One implementation of pressure, in the decision layer. `_expiryPressure` is
   * the wire's view of it and has to publish `null` where the decision says
   * `absent`, because the payload's `pressure` field is a number and that format
   * is not free to change. Reimplementing the arithmetic for either view would
   * give the published figure and the routing decision separate definitions of
   * the same word.
   *
   * The status payload takes the variant rather than the number so it can
   * publish WHY a pressure is missing beside the null it has to send anyway.
   * Both fields come from this one call, which is what makes "absent exactly
   * when null" a property of the code instead of an agreement between two call
   * sites.
   */
  _pressureVariant(account, model = null, now = Date.now()) {
    const [snapshotAccount] = this._bandSnapshot([account], model, now).accounts;
    return pressureOf(snapshotAccount, now);
  }


  /**
   * The accounts a selection pass may choose from: everything eligible for this
   * request, narrowed to the top pressure band when expiry routing is on.
   * _isAvailable already filters out accounts at or above the switch threshold,
   * so a pick only ever lands on one whose 5-hour quota is still below it; the
   * band then narrows the top priority tier to the accounts whose expiring quota
   * is worth spending (ample AND soon-to-reset), before each caller's own
   * tiebreaks. Shared by both selection loops so they cannot disagree on the
   * candidate set.
   */
  _bandedCandidates(exclude = null, model = null, advisorModel = null, opts = {}) {
    // `opts.fleet` is the only way the accounts under consideration are ever
    // something other than the live ones: an observation hands in the projected
    // fleet (`_observedFleet`) so eligibility, banding, pressure and the pick
    // all read ONE state. Ranking read `account.quota` while availability
    // answered against a projection of it, and the two disagreed about which
    // account a request would get.
    const fleet = opts.fleet || this.accounts;
    return this._topPressureBand(
      fleet.filter(a => !exclude?.has(a.index) && this._isAvailable(a, model, advisorModel, opts)),
      model, opts.now, opts.route);
  }

  /**
   * The accounts selection may choose from when expiry routing is on. Sized by
   * CAPACITY where a five-hour level has been reported — accounts admitted in
   * descending pressure order until their combined headroom covers
   * `coverage` — and by the `tolerance` pressure ratio only as the fallback
   * when no account has reported one, which is the cold-start and probe-off
   * state. Band membership rather than a raw sort keeps the comparison
   * transitive, lets distributeSessions spread load across the admitted set
   * (the #109 protection), and gives hysteresis for free. Pass-through when the
   * feature is off or nothing is known. An account missing either measurement
   * stays in, since being used is how it becomes known, and a non-empty input
   * never bands to empty.
   *
   * Membership says an account is worth spending; it does NOT say the admitted
   * set is near-equal in pressure. Capacity sizing widens deliberately, so a
   * caller that needs the better of two members must compare pressure itself.
   *
   * WHAT THE SET STOPPED GUARANTEEING, and every consumer measured against it.
   * Under the ratio, every member sat within `tolerance` of the maximum, so
   * membership carried a BOUND on how much pressure a caller could lose by
   * picking any member. Capacity sizing removes that bound on purpose, so
   * membership is a statement about ADMISSION and no longer about ordering.
   *
   * Three consumers, which is every call site of `_bandedCandidates`:
   *
   *   `_pickLeastLoaded`      takes it as a SET and ranks within it (decidePick)
   *   `_pickBestAvailable`    takes it as a SET and ranks within it (pressureRank)
   *   `_switchOnSessionReset` uses membership as a VETO, over a choice it now
   *                           ranks by pressure then reset — it ranked on the
   *                           reset timestamp alone until that was fixed, which
   *                           is what made the veto load-bearing
   *
   * That is the whole distinction: ranking within the set never depended on
   * what the set bounded, so both of those are sound either way. The veto is
   * only as strong as the property the set still encodes, so it stopped being
   * sound the moment the band went heterogeneous — which is why that function
   * now ranks pressure itself instead of letting membership stand in for it.
   *
   * The rule for a new consumer: if you are using membership to mean "near the
   * best pressure", it does not mean that. Rank pressure, or state why
   * admission alone is the property you need.
   */
  _topPressureBand(candidates, model = null, now = Date.now(), route = undefined) {
    // One clock for the whole band: pressure rises continuously as a window
    // nears its reset, so scoring accounts at different instants would break an
    // exact tie on the microseconds between two Date.now() reads. Read once
    // here — or handed in by an observation, whose instant this must share —
    // and passed to the decision, which never reads a clock of its own.
    const decision = decideBand(this._bandSnapshot(candidates, model, now, route));
    return this._applyBand(decision, candidates);
  }

  /**
   * A band decision resolved back to candidate objects: the ONE way a decision
   * becomes a list.
   *
   * Selection applies a band and the status report applies the same band, and
   * until this existed each did it with its own copy of the same three lines.
   * They agreed, which is the problem — an edit to one would have let the report
   * describe a candidate set selection never used, and nothing would have said
   * so, because two implementations that currently agree look exactly like one.
   *
   * This does not make them agree; it removes the possibility of disagreement.
   * There is no test that could prove they cannot drift, because the property is
   * structural rather than behavioural. What a test can show, and what the one
   * covering this does show, is that breaking this method breaks BOTH consumers
   * — which is what having one implementation looks like from the outside.
   *
   * Both narrowing variants name the accounts they kept, in the order the caller
   * must see them; which rule chose them is the decision's business and does not
   * change how the choice is applied.
   */
  _applyBand(decision, candidates) {
    switch (decision.kind) {
      case 'passthrough': return candidates;
      case 'banded':
      case 'sized': {
        const byIndex = new Map(candidates.map(a => [a.index, a]));
        return decision.keep.map(i => byIndex.get(i)).filter(Boolean);
      }
      default: return assertNever(decision, '_applyBand');
    }
  }

  /**
   * The band decision's view of a candidate set. Reads the accounts and the
   * config; the decision itself reads neither. `now` is passed in rather than
   * taken here so that a caller wanting to ask what the band WOULD have done at
   * some instant can, and so the pure layer stays drivable from a test.
   *
   * Both halves of each account's ratio come from the ONE bucket
   * `_governingBucket` names. A family bucket reporting a utilization but no
   * window makes that account unknown rather than borrowing the shared window's
   * horizon: dividing one bucket's headroom by another bucket's clock scores an
   * account on quota it does not have.
   *
   * @param {{index: number, priority?: number, quota: Record<string, unknown>}[]} candidates
   * @param {string | null} model
   * @param {number} now
   * @returns {import('./band-decision.js').BandSnapshot}
   */
  _bandSnapshot(candidates, model, now, route = undefined) {
    return {
      now,
      enabled: !!this.expiryRouting.enabled,
      tolerance: this.expiryRouting.tolerance,
      switchThreshold: this.switchThreshold,
      coverage: this.expiryRouting.coverage,
      accounts: candidates.map(a => {
        const key = this._governingBucket(a, model, route);
        const used = a.quota[key];
        const reset = a.quota[`${key}Reset`];
        // `unified5h` is read by its own name rather than through
        // `_governingBucket`, because there is exactly one five-hour bucket per
        // account and it is shared by every family. Resolving it per family
        // would imply a per-family figure upstream does not publish.
        const fiveHour = a.quota.unified5h;
        return {
          index: a.index,
          priority: a.priority || 0,
          utilization: typeof used === 'number' ? used : (used == null ? null : NaN),
          resetAt: typeof reset === 'number' && reset ? reset : null,
          fiveHour: typeof fiveHour === 'number' ? fiveHour : null,
        };
      }),
    };
  }

  /**
   * Did the governing weekly window of a sticky choice ROLL OVER since we last
   * looked? A rollover is the only event that preempts a pin or the current
   * account: it leaves that account freshest AND furthest-dated at once, so a
   * sticky session would silently burn the 7-day-out window for its whole life.
   * Draining the sticky account must NOT preempt — the drain is caused by that
   * session's own traffic, so a threshold rule would re-route on the drain it
   * just caused, spending a cache miss per crossing while the same account is
   * still the right one to spend. Tracking is per quota bucket so a session that
   * alternates models (Opus turns + Fable turns) never sees a false jump from
   * comparing two different buckets' resets. Both sticky choices ask the same
   * question of their own WindowWatcher, which is where the answer is derived.
   */
  _pinRolledOver(sessionId, pinned, model) {
    const seen = this.sessionTracker.windowsFor(sessionId, true);
    if (!seen) return false;
    const bucket = this._weeklyBucketFor(model);
    // Only THIS bucket is seeded from the pinned account. The session's other
    // buckets are pinned to whatever account serves them, so recording this
    // account's windows under them would overwrite a baseline belonging to a
    // different account — and lose the rollover it was there to catch.
    return this._noteRolledOver(seen, pinned.index, bucket, this._bucketWindows(pinned, [bucket]));
  }

  /** As _pinRolledOver, for the global current account — which, unlike a
   * session's pins, is one account for every bucket, so all of them are seeded
   * (an Opus-only stretch must not first-sight the Fable bucket on the very
   * request that should have caught it rolling). */
  _currentRolledOver(current, model) {
    return this._noteRolledOver(
      this._currentSeen,
      current.index, this._weeklyBucketFor(model), this._bucketWindows(current));
  }

  /**
   * Ask `seen` whether a sticky choice's window rolled over, counting a NEWLY
   * detected event exactly once. Both sticky choices come through here, so the
   * counter cannot disagree with the detection it reports.
   *
   * rolledOver re-reports an event still owed on every later pass — that is
   * what keeps a preemption with nowhere to go firing until something moves —
   * so counting its answer would count one weekly rollover once per request and
   * make `rolloversDetected` a traffic meter. The event is the transition from
   * "nothing owed on this bucket here" to "owed".
   */
  _noteRolledOver(seen, idx, bucket, resets) {
    const alreadyOwed = seen.owedOn(bucket, idx);
    const rolled = seen.rolledOver(idx, bucket, resets);
    if (rolled && !alreadyOwed) this._rolloverStats.detected++;
    return rolled;
  }

  /**
   * A rollover fired and moved nothing: every eligible destination was ruled
   * out, so the request stays on the account that just gained a full week.
   * Without this the log reads identically whether nothing rolled over or a
   * rollover is stuck, which is the one failure this feature can have that
   * looks exactly like it working. Throttled like the advisor-degrade line so a
   * busy session cannot flood the log, but per event rather than globally: two
   * accounts stuck at once are two things an operator has to know.
   */
  _noteStuckRollover(account, model) {
    const bucket = this._weeklyBucketFor(model);
    const key = `${account.index}:${bucket}`;
    const now = Date.now();
    if (now < (this._rolloverStuckLogAt.get(key) || 0)) return;
    // The one minute is untested, and deliberately so: this reads the wall clock
    // directly where the rest of the tracker takes an injectable `now`, so
    // nothing can advance time past the throttle to watch the line fire again.
    // Widening it would break no test. Adding a clock parameter for one log
    // throttle would be source that exists only to be tested, which buys less
    // than it costs — the line's CONTENT and its per-(account, bucket) key are
    // both held, and those are what carry the meaning.
    this._rolloverStuckLogAt.set(key, now + 60_000);
    console.log(`[TeamClaude] Account "${account.name}" rolled over its ${bucket} window but no eligible account can take that traffic — still routing there`);
  }

  /**
   * A request for `sessionId` was served by `accountIndex` — the response the
   * client gets, not an attempt that went on to retry somewhere else. This is
   * what consumes a rollover preemption, and the reason detection can safely
   * run on a pass that cannot act: a re-routed attempt that fails and comes
   * back to the rolled-over account leaves the event owed, so the next request
   * preempts again instead of settling on the account that just gained a week.
   * Scoped to the buckets this request spent, since those are the only families
   * whose traffic it can have moved. A no-op unless something is pending, so
   * every request may call it.
   *
   * For a session this only RECORDS where the traffic went; the event settles
   * when the session goes quiescent (see endSession). A sibling request for the
   * same session can be served off the rolled account while a slower one is
   * still failing back onto it, and whichever finishes last is the one that
   * says where the session ended up.
   *
   * The current account's own event is settled only when `decision` says this
   * request came from the walk that owns it. A session's pin, a /tc-acct/ pin
   * and the keep-warm scheduler all route without ever consulting
   * `currentIndex`, so letting one of those confirm it would consume an event
   * that walk never acted on — leaving `current` parked on the account that just
   * gained a full week until the next roll.
   */
  confirmRouted(sessionId, accountIndex, model = null, advisorModel = null, decision = null) {
    const buckets = this._requestBuckets(model, advisorModel, decision);
    if (decision?.viaCurrent) {
      this._rolloverStats.preempted += this._currentSeen.commitOn(accountIndex, buckets);
    }
    if (sessionId) this.sessionTracker.windowsFor(sessionId)?.noteServed(accountIndex, buckets);
  }

  _windowForBucket(account, bucket) {
    if (bucket === 'unified7d') return bucket;
    return account.quota[bucket] == null ? 'unified7d' : bucket;
  }

  /** Every bucket a request could be governed by here: the model families' own
   * weekly buckets and the shared one, plus whatever a configured route's
   * `bucket` override names — an override can make _weeklyBucketFor return a
   * bucket the family table never mentions. */
  _windowKeys() {
    const keys = new Set(WEEKLY_BUCKET_KEYS);
    for (const route of this.routes) if (route.bucket) keys.add(route.bucket);
    return keys;
  }

  /**
   * The baseline a rollover is measured against, as
   * { requestBucket: { window, reset } } — one entry per bucket this account
   * currently resolves a reset for. Every bucket is named, including two that
   * resolve to the same window: the bucket is what a pin, an event and a
   * preemption are each about, and merging two of them under their shared window
   * loses one of the two rollovers.
   *
   * The window rides along because it is what makes the reset meaningful: two
   * resets are comparable only when they are the same window's, and the window a
   * bucket resolves to changes the first time its account reports that family's
   * own utilization.
   */
  _bucketWindows(account, buckets = this._windowKeys()) {
    const out = {};
    for (const bucket of buckets) {
      const window = this._windowForBucket(account, bucket);
      const reset = account.quota[`${window}Reset`];
      if (reset != null) out[bucket] = { window, reset };
    }
    return out;
  }

  /**
   * Seed the rollover detector when a pin is recorded, so a session's very
   * first request already establishes which windows its account had. Without
   * this, a rollover landing before the second honored request — or a pin
   * created while _clearExpiredQuotas has the window nulled — would never be
   * detected and the session would ride the rolled account for its whole life.
   * Scoped to the buckets this request pinned, for the same reason
   * _pinRolledOver is: the session's other buckets belong to other accounts.
   * Skipped entirely when distribution is off: the only reader is
   * _selectForSession, which never runs then, so seeding would just accumulate
   * entries nothing ever consults.
   */
  _seedPinWindows(sessionId, accountIndex, buckets) {
    if (!this.distributeSessions || !this.expiryRouting.enabled || !this.expiryRouting.preempt) return;
    const account = this.accounts[accountIndex];
    if (!account) return;
    this.sessionTracker.windowsFor(sessionId, true)?.seed(accountIndex, this._bucketWindows(account, buckets));
  }

  /** The first configured route whose globs match `model`, or null. */
  _routeForModel(model) {
    if (!model || !this.routes?.length) return null;
    return this.routes.find(r => r.match.some(g => modelGlobMatches(g, model))) || null;
  }

  /** The weekly quota bucket that governs `model` — a matching route's `bucket`
   * override wins, otherwise the model family's default bucket. */
  /**
   * The weekly bucket governing a decision about `model`.
   *
   * `route` is the route the DECISION is about, and it is a parameter because
   * the two callers know different things. A request arrives with an id and
   * must find its route, so it lets this derive one. The routing report is
   * iterating routes and already knows which — and when an earlier route
   * captures this family's representative id, deriving gives that other route's
   * bucket override under this route's name. Six fields were resolved that way
   * and every one of them answered for the wrong route.
   */
  _weeklyBucketFor(model, route = this._routeForModel(model)) {
    return route?.bucket || weeklyBucketForModel(model);
  }

  /** Whether `account` may serve `model`. A matching route with an `accounts`
   * list is exclusive (only listed accounts, by name or index). With no matching
   * route — or a route that lists no accounts — it falls back to the per-account
   * `models` ownership claim (deprecated — use `routes` instead). */
  _routeAllows(account, model, route = this._routeForModel(model)) {
    if (route && route.accounts.length) {
      return route.accounts.includes(account.name) || route.accounts.includes(String(account.index));
    }
    return this._accountOwnsModel(account, model);
  }

  /** @deprecated Use `routes` with an `accounts` list instead.
   *  Returns true if no account claims model ownership, or this account does. */
  _accountOwnsModel(account, model) {
    for (const a of this.accounts) {
      if (a.models && a.models.some(m => modelMatches(m, model))) {
        // Some other account owns this model — this account must own it too.
        return !!(account.models && account.models.some(m => modelMatches(m, model)));
      }
    }
    return true; // no one claims ownership → any account is fine
  }

  /**
   * The routing table for display: every configured route plus an ephemeral,
   * auto-created route for each model family that some account meters with its
   * own weekly bucket but no configured route already covers. Auto-created routes
   * carry `autocreated: true` and are never persisted — they simply surface the
   * per-model quota the server already respects. Each route lists the accounts it
   * can use with a live eligibility flag, plus `target`: the one account it would
   * pick right now. Everything here is derived for display and thrown away — the
   * entries are fresh objects, never the stored (persisted) route definitions.
   */
  getRoutes(observed = this._observedFleet()) {
    const out = this.routes.map(r => ({
      name: r.name, match: r.match, bucket: r.bucket, color: r.color || null, autocreated: false,
      pinned: this._pinnedName(r.name),
      accounts: this._routeAccountsView(r, observed),
      // The model this route's live figures were computed for. Published
      // because `target` and the routing report are answers ABOUT a model, and
      // a consumer cannot otherwise tell which one was asked about. For a
      // configured route it is the glob with its wildcards stripped, which is a
      // representative rather than a model id; the auto-created entries below
      // carry a real one.
      sample: sampleModelFor(r),
      // THE ROUTE, not just its sample. Without it every derivation here
      // re-derives the route from the model — and `_routeForModel` answers
      // about the FIRST route matching that id, which for a later route is
      // some earlier one. A route whose glob strips to a capturable id
      // (`claude-fable-5*` -> `claude-fable-5`) then published the EARLIER
      // route's destination, in the same response where `routing[]` published
      // its own. The round threaded `routing[]` and stopped here.
      target: this._routeTarget(sampleModelFor(r), observed, r),
    }));

    const detected = [];
    if (observed.accounts.some(a => a.quota.unified7dFable != null)) {
      detected.push({ name: 'fable', match: ['*fable*'], sample: 'claude-fable-5' });
    }
    if (observed.accounts.some(a => a.quota.unified7dSonnet != null)) {
      detected.push({ name: 'sonnet', match: ['*sonnet*'], sample: 'claude-sonnet-4-6' });
    }
    for (const d of detected) {
      if (this._routeForModel(d.sample)) continue; // already covered by a configured route
      out.push({
        name: d.name, match: d.match, bucket: null, color: null, autocreated: true,
        pinned: this._pinnedName(d.name),
        accounts: observed.accounts.map(a => ({ name: a.name, eligible: this._isAvailable(a, d.sample, null, this._observeOpts(observed)) })),
        sample: d.sample,
        target: this._routeTarget(d.sample, observed),
      });
    }
    return out;
  }

  /**
   * The band and pick decisions as a report, one entry per routing scope.
   *
   * A REPORT OF A DECISION, never a decision. Nothing reads this back: it is
   * recomputed per status call and thrown away, which is what keeps publishing
   * an explanation from becoming a feedback path into routing. The functions it
   * calls are the ones selection calls, in the order selection calls them, so
   * the entry says what a request arriving now would meet rather than what a
   * second implementation believes it would.
   *
   * The `shared` scope is always present, even on a fleet with no routes at all
   * — otherwise a stock user, whose `routes` is empty, gets no decision report
   * at all, and the state where the fleet is down to one eligible account is
   * exactly where the operator needs one.
   *
   * SCOPED TO A PLAIN REQUEST. Each entry describes a request with no advisor
   * model and nothing already tried, because those are properties of a request
   * in flight and this is a report about the fleet. An entry cannot therefore be
   * read as "what happens to the request I am debugging" when that request
   * carries an advisor; it is what the next plain request meets.
   */
  _routingReport(observed = this._observedFleet()) {
    // The report's clock IS the projection's, not a parameter beside it: two
    // callers passing an instant and a projection taken at a different one is
    // the split this whole round has been closing, one argument list up.
    const now = observed.now;
    const scopes = [{ scope: 'shared', route: null, model: null, match: [], autocreated: false, owner: null, routeIndex: null }];
    // THE ENTRY CARRIES ITS ROUTE'S POSITION, and this is a WIRE ADDITION made
    // deliberately. A consumer joining these entries back to `routes[]` had only
    // `(name, glob)` to do it with, and route NAMES ARE NOT UNIQUE: two routes
    // sharing a name and one glob are indistinguishable, so the later route's
    // line imported the earlier route's entry — naming an owner for traffic it
    // cannot send AND dropping the account that actually serves it. The `owner`
    // field below is the stored route object and would settle it, but it is used
    // internally and never reaches the wire, so no consumer can join on it.
    //
    // The index is taken from THIS iteration rather than from a second call to
    // `getRoutes`, so the join does not rest on two calls agreeing about order.
    // `status.routes` is `getRoutes(observed)` with the same argument, so the
    // positions correspond by construction rather than by convention.
    for (const [routeIndex, route] of this.getRoutes(observed).entries()) {
      // The stored route this view was built from, carried rather than looked
      // up later: the scope's own `match` is a fresh one-glob array, so any
      // identity lookup against it silently finds nothing.
      const owner = this.routes.find(r => r.match === route.match) ?? null;
      // ONE ENTRY PER FAMILY, not per route and not per glob. A route matching
      // two families has two governing buckets and therefore two different
      // bands and two different picks; publishing one entry for it presented
      // the first family's answer as the answer for every family the route
      // matches. Each entry names the glob it came from and the REAL model id
      // its figures were computed for — never the glob with its wildcards
      // filed off, which is an id nobody sends and which resolves to the shared
      // bucket whatever the route actually carries.
      const globs = route.autocreated ? [{ glob: route.match[0], model: route.sample }]
        : route.match.flatMap(glob => this._scopeModelsFor(glob, route, owner).map(model => ({ glob, model })));
      for (const { glob, model } of globs) {
        scopes.push({
          scope: 'route', route: route.name, model, owner, routeIndex,
          // Carried rather than looked up by name later. Route names are not
          // unique — two routes may share one — so a consumer joining an entry
          // back to `routes[]` by name attaches this decision to another
          // route's globs and another route's target.
          match: [glob],
          autocreated: route.autocreated,
        });
      }
    }
    return scopes.map(({ scope, route, model, match, autocreated, routeIndex, owner: scopeRoute }) => {
      // A CAPTURED REPRESENTATIVE PUBLISHES NO PER-ACCOUNT FIGURES. Every
      // figure below is computed FOR THE MODEL, and when an earlier route has
      // taken this entry's representative the model is an id this route never
      // receives — so availability, the band, the ladder and the pick are all
      // answers about somebody else's traffic. That is not a rounding error: it
      // published `route-excluded` against the ONE account serving this route
      // and named a destination serving none of it, which is a line an operator
      // acts on.
      //
      // ABSENCE WITH A STATED REASON, never a silent one. An absence whose
      // cause cannot be told from the payload is how a display ends up deriving
      // its own answer (TC-026), so the marker says which determination removed
      // the figures.
      //
      // NOT SUBSTITUTION. The tempting fix is to evaluate against an id this
      // route DOES receive, and it needs a census of the ids that exist — the
      // same census measured unsafe twice this round: it holds only
      // `FAMILY_MODELS` plus ids named literally in routes and claims, so with
      // an exact `claude-fable-5` route ahead of `*fable*` it sees one Fable id,
      // calls the entry dead, and goes silent on a genuine split. A wrong
      // number is worse than a stated absence, and the round-4 fix at the root
      // (a route's sample becoming a resolvable id) changes the basis anyway.
      //
      // CAPTURE IS NOT ENOUGH ON ITS OWN, and this is where that was learned.
      // Keying only on `_representativeCaptured` suppressed entries whose
      // figures were correct: a route that LISTS its accounts never consults the
      // id, and a fleet declaring no `models` grades identically for any id. So
      // the condition is `_captureDistortsFigures`, which asks whether the
      // representative can move a figure and not merely whether it is somebody
      // else's. The disclosure still fires on capture alone — being named for an
      // id you never receive is worth saying whether or not it changes a number,
      // and the two questions share their first conjunct so they cannot disagree
      // about whether a capture happened.
      //
      // ONE COMPUTATION FOR BOTH RETURNS. The scope's governing bucket is the
      // same question whether or not the figures are published, and writing it
      // twice gave the mutation table two identical anchors — a row that then
      // mutates whichever it finds first and reports on the other.
      const bucket = this._weeklyBucketFor(model, scopeRoute ?? this._routeForModel(model));
      if (this._captureDistortsFigures(model, scopeRoute)) {
        return {
          scope,
          route,
          routeIndex,
          model,
          match,
          autocreated,
          target: null,
          pinnedTo: null,
          bucket,
          familySplit: this._familySplit(model, scopeRoute, match[0] ?? null, autocreated),
          // The marker, and the reason a reader needs to know what is missing
          // and why. Kept as its own field rather than folded into the band, so
          // a consumer asking "are these figures real" does not have to infer
          // it from a band variant.
          figuresAbsent: 'representative-captured',
          band: {
            kind: 'passthrough',
            reason: 'representative-captured',
            target: null,
            achieved: null,
            floor: null,
            // NULL, NOT ZERO. Zero is a figure, and on a live route it is a
            // false one: it reads as "nothing can serve this scope" when the
            // scope is served perfectly well by whoever takes the ids it
            // actually receives. This entry's whole claim is that no figures
            // were computed, so the count of candidates is UNMEASURED rather
            // than measured-and-none — the same distinction every other scalar
            // here already makes.
            candidates: null,
            admitted: [],
            ladder: [],
            excluded: [],
          },
          pick: {
            kind: 'none',
            reason: 'representative-captured',
            account: null,
            runnerUp: null,
            tiedWith: [],
            by: null,
            terms: [],
          },
        };
      }
      // ONE availability evaluation per account, split two ways. The candidates
      // are what the band sees and the rest are `excluded[]` with the reason
      // that removed them, so the two lists cannot disagree about an account and
      // `candidates + excluded.length === accounts.length` holds by construction
      // rather than by two filters agreeing.
      // `scopeRoute` is the route this entry is ABOUT, handed to every
      // derivation below rather than re-derived from the representative id —
      // which, when an earlier route captures that id, is a different route
      // with different accounts, a different bucket override and a different
      // pin.
      const opts = this._observeOpts(observed, scopeRoute);
      const verdicts = observed.accounts.map(account => ({
        account, why: this._availability(account, model, null, opts),
      }));
      const candidates = verdicts.filter(v => v.why === null).map(v => v.account);
      const explained = explainBand(this._bandSnapshot(candidates, model, now, scopeRoute));
      // The SAME projection selection applies, not a copy of it. The report
      // describing a candidate set selection would not have used is the failure
      // this shares a method to make unconstructible.
      const banded = this._applyBand(explained.decision, candidates);
      // WHERE A NEW SESSION GOES, over the set admitting it leaves behind. At
      // the session cap, admitting one evicts the least-recently-seen, and that
      // eviction moves `loadFor` — so the pick computed over the current set is
      // a prediction the request destroys on its way to being served. Null
      // below the cap, where admitting a session costs nothing.
      const evicted = this.sessionTracker.victimForNewSession();
      const pickSnapshot = this._pickSnapshot(banded, model, now,
        { excludingSession: evicted, route: scopeRoute });
      const pick = decidePick(pickSnapshot);
      const nameOf = index => observed.accounts[index]?.name ?? null;

      return {
        scope,
        route,
        routeIndex,
        model,
        match,
        autocreated,
        // WHERE A REQUEST IN THIS SCOPE WOULD ACTUALLY LAND, from the same
        // preview the route table uses: the manual pin first, then the current
        // account if it is still eligible, then priority preemption, then best
        // available. Published because the alternative is a consumer deriving a
        // destination from `currentAccount` and a rule it believes routing
        // follows — which reported a disabled account as where new sessions go,
        // and ignored a manual route pin entirely.
        target: this._routeTarget(model, observed, scopeRoute),
        // Whether a MANUAL ROUTE PIN binds this scope. `_selectRoute` skips the
        // session-distribution path entirely when one is set (`:421`, "which
        // must still win"), so a pin overrides load ranking for new sessions
        // whether or not distribution is on. Without this field a consumer
        // cannot tell that the pick it is reading is not what routing will do.
        pinnedTo: (m => (m ? m.name : null))(this._pinnedAccountForModel(model, null, scopeRoute ?? undefined)),
        // The FAMILY this entry is about. An account that does not meter that
        // family is measured on the shared bucket instead, which is a per-account
        // fallback and so appears on the row rather than here — reading this key
        // as every row's bucket would attribute one window's figure to another.
        bucket,
        // WHAT THIS ENTRY MAY CLAIM ON BEHALF OF THE SET IT COVERS. Null is the
        // ordinary case and says the scope answers as one; a REASON says the
        // figures above are the representative's and names why the rest may
        // differ — divided among accounts by their own claims, or the
        // representative taken by an earlier route. One field carrying its
        // reason rather than a boolean beside an explanation, so the two cannot
        // drift.
        familySplit: this._familySplit(model, scopeRoute, match[0] ?? null, autocreated),
        // Figures below are this entry's own; the suppression branch above is
        // the only path that publishes none.
        figuresAbsent: null,
        band: {
          kind: explained.decision.kind,
          reason: explained.decision.reason ?? null,
          target: explained.decision.kind === 'sized' ? explained.decision.target : null,
          achieved: explained.decision.kind === 'sized' ? explained.decision.achieved : null,
          floor: explained.decision.kind === 'banded' ? explained.decision.floor : null,
          candidates: candidates.length,
          admitted: banded.map(a => a.name),
          ladder: explained.ladder.map(row => ({
            rank: row.rank,
            account: nameOf(row.account.index),
            bucket: this._governingBucket(observed.accounts[row.account.index], model, scopeRoute),
            pressure: row.pressure,
            headroom: row.headroom,
            cumulative: row.cumulative,
            admitted: row.admitted,
            reason: row.reason,
          })),
          excluded: verdicts.filter(v => v.why !== null).map(v => ({
            account: v.account.name,
            reason: v.why.reason,
            bucket: v.why.bucket,
            detail: v.why.detail,
          })),
        },
        pick: {
          kind: pick.kind,
          reason: pick.kind === 'none' ? pick.reason : null,
          account: pick.kind === 'picked' ? nameOf(pick.index) : null,
          runnerUp: nameOf(runnerUp(pickSnapshot, pick) ?? -1),
          tiedWith: tiedWith(pickSnapshot, pick).map(nameOf),
          by: pick.kind === 'picked' ? pick.by : null,
          terms: decidingTerms(pickSnapshot, pick),
        },
      };
    });
  }

  /**
   * The models one of a route's globs answers for: one per weekly bucket the
   * glob can actually carry.
   *
   * ONLY the families this route RECEIVES. Routes are matched in order, so an
   * earlier route can capture a family a later route's glob also names, and
   * publishing an entry for it would claim a destination for traffic this route
   * never sees. The ownership test compares the route the model resolves to
   * with this one by identity rather than by name, because route names are not
   * unique — the same reason `pinnedTo` is carried rather than looked up.
   *
   * TWO STATES, NOT ONE, and the difference is which of them produced the empty
   * list. A glob naming no metered family (`gpt-*`) falls back to its literal
   * core, which resolves to the shared bucket and is the right answer for it:
   * one scope, not one per family. A glob whose families are ALL owned by an
   * earlier route is a different thing entirely — it carries nothing, so it
   * gets no entry. Collapsing the two published a second `*fable*` route with a
   * Fable bucket and a destination for traffic first-match routing sends
   * somewhere else every time.
   */
  _scopeModelsFor(glob, route, owner = null) {
    const named = familyModelsMatching(glob);
    // OWNERSHIP IS COVERAGE, NOT CAPTURE. Asking "does an earlier route capture
    // this family's representative id" answers about ONE id: an exact route for
    // `claude-fable-5` captures the representative while `*fable*` still carries
    // `claude-fable-4` and serves it from another account — and the live route
    // published nothing at all. The question is whether an earlier route's globs
    // COVER this one, which is what decides whether any id is left for it.
    // EVERY EARLIER ROUTE, not just the one the representative resolves to.
    // Asking `_routeForModel` answers about the FIRST route that matches one id,
    // so a cascade hid behind it: with an exact route and then a catch-all ahead
    // of this one, the representative resolves to the exact route, that route
    // covers nothing, and the entry publishes — while the catch-all in between
    // has taken every id this glob could carry. Routes are matched in order, so
    // the question is about the whole prefix of the list, not about one member.
    const before = owner ? this.routes.slice(0, this.routes.indexOf(owner)) : [];
    const owned = named.filter((m) => {
      // THE INTERSECTION, not the glob. An earlier route takes this family away
      // only if it covers what this glob carries OF THAT FAMILY: `*fable*` ahead
      // of `claude-*` takes every Fable id, because every Fable id contains
      // "fable" — while an exact `claude-fable-5` ahead of `*fable*` takes one
      // id and leaves the rest. Where no capture can be shown, the entry is
      // published: an unproven capture would hide a route that carries traffic.
      // The family by its OWN pattern, not by whether it meters its own weekly
      // bucket: `familyGlobFor` answers null for Opus, so an earlier `*opus*`
      // route was never seen to have taken the Opus family at all.
      const famGlob = familyPatternFor(m);
      return !before.some(r => r.match.some(g => globCovers(g, glob)
        || (famGlob && globCovers(g, famGlob))));
    });
    if (owned.length) return owned;
    if (named.length) return [];
    // THE SAME QUESTION AT THE OTHER DOOR. A glob naming no metered family
    // falls back to its own literal core, and that path never asked whether an
    // earlier route had already taken it — so a `gpt-*` route behind a
    // catch-all published a scope, a band and a destination while every real
    // `gpt-4o` request went to the catch-all's account. `*fable*` in the
    // identical shape was suppressed, which is what makes this a door and not a
    // policy: one path asks the coverage question and the other did not.
    const literal = glob.replace(/\*/g, '') || 'model';
    return before.some(r => r.match.some(g => globCovers(g, glob))) ? [] : [literal];
  }

  /**
   * Is the id this entry is NAMED FOR taken by a route ahead of it?
   *
   * THE DISCLOSURE'S QUESTION, and the first of the three the suppression asks.
   * `familySplit` says "an earlier route" on exactly this determination, and
   * `_captureDistortsFigures` starts from it rather than restating it, so an
   * entry cannot disclose the capture while the suppression disagrees that
   * there was one.
   *
   * Capture alone does NOT mean the figures are wrong — see
   * `_captureDistortsFigures` for the two further conditions and why each is
   * needed. Being named for somebody else's id is worth disclosing whether or
   * not it changes a number.
   *
   * Identity, not name: route names are not unique.
   */
  _representativeCaptured(model, route) {
    const owner = this._routeForModel(model);
    return Boolean(route && owner && owner.match !== route.match);
  }

  /**
   * Every id a `models` claim could possibly discriminate on.
   *
   * COMPLETE FOR THIS QUESTION, not merely a sample, and the completeness is a
   * property of `_accountOwnsModel` rather than an aspiration. That function
   * discriminates only when some account's claim `modelMatches` the id, and
   * `modelMatches` is EXACT equality plus the context-length strip — it does not
   * glob-match. So an id no claim names literally (either as written or with
   * `[Nm]` removed) gets `true` from every account, and cannot separate the
   * fleet. Enumerating the claims therefore enumerates the whole space where the
   * answer can be anything but constant.
   *
   * THAT IS LOAD-BEARING AND IT IS PINNED. `a glob-shaped models claim names no
   * id` fails if `_accountOwnsModel` ever starts glob-matching, because at that
   * moment this enumeration stops being complete and the suppression starts
   * missing inversions in silence.
   */
  _claimableIds() {
    const ids = new Set();
    for (const a of this.accounts) {
      for (const declared of a.models || []) {
        ids.add(declared);
        ids.add(bareModelId(declared));
      }
    }
    return ids;
  }

  /**
   * Is anyone BARRED from the representative — the id the figures were computed
   * for?
   *
   * The original question, kept. It nearly went away in favour of the received-id
   * enumeration below and that would have been a trade, not a fix: this half does
   * live work the enumeration provably cannot do. When someone is barred from the
   * representative, the figures grade a RESTRICTED set; an id the route receives
   * that no claim names grades the PERMISSIVE set, every account. Those differ, so
   * the published figures are wrong for that traffic — and the id causing it is
   * nameable from no config text, so nothing can enumerate it.
   *
   * Measured rather than argued: with `a` claiming the representative and `b`
   * claiming nothing, this route published `b: route-excluded` while `b` was
   * permitted on every id the route actually receives.
   */
  _representativeRestricted(model) {
    return this.accounts.some(a => !this._accountOwnsModel(a, model));
  }

  /**
   * Does the route's glob reach ids beyond the ones config names?
   *
   * A wildcard does, by construction — which is the whole reason
   * `_representativeRestricted` is sufficient on its own without any completeness
   * claim. A wildcard-free glob names exactly one id, so there is no unnameable
   * remainder for it to hide.
   */
  _reachesBeyondNamedIds(route) {
    return route.match.some(g => g.includes('*'));
  }

  /**
   * Does ownership discriminate on an id THIS ROUTE ACTUALLY RECEIVES?
   *
   * The half that catches the pass-13 P1. The representative question above is
   * blind to a fleet whose claims name only a SIBLING: nobody is barred from the
   * representative, so it answers "nothing to worry about", while a claim on an id
   * the route does receive grades that traffic a different way. Asked about the
   * ids a claim can discriminate on, that this route's globs match, and that no
   * earlier route takes — `_routeForModel` decides the last part, so the "who gets
   * this id" rule is the routing table's own and not a second opinion.
   *
   * ON THE CENSUS OBJECTION, which this round rejected twice elsewhere. What was
   * rejected was inferring a POSITIVE fact from census ABSENCE — declaring a route
   * dead because no known id reaches it. This infers nothing from absence: it
   * WIDENS suppression when it finds a discriminating id, and finding none leaves
   * the decision to the representative question, which is where the unnameable
   * ids are handled. Neither half claims completeness; together they are
   * sufficient, which is the property that matters.
   */
  _receivedIdDiscriminates(route) {
    for (const id of this._claimableIds()) {
      // ONE TEST, NOT TWO. `_routeForModel` returns the FIRST route whose glob
      // matches, so an id this route owns necessarily matched this route's glob
      // — a separate glob check ahead of it can never disagree. It was written
      // that way and the mutation table proved it: the row neutralising the glob
      // check could not be made to fail, because the owner check already covered
      // every case it did. A guard that never disagrees with the one beside it
      // is one guard wearing two names.
      const owner = this._routeForModel(id);
      if (!owner || owner.match !== route.match) continue;   // an earlier route takes it
      if (this.accounts.some(a => !this._accountOwnsModel(a, id))) return true;
    }
    return false;
  }

  /**
   * Would publishing per-account figures for this entry answer about an id the
   * route never receives — AND get a different answer for having done so?
   *
   * THREE CONJUNCTS, because capture alone suppressed entries whose figures were
   * right. Each one is here because removing it re-admits a measured case:
   *
   *   1. THE REPRESENTATIVE IS CAPTURED. Without this there is no wrong id in
   *      play at all; the entry is named for something it receives.
   *   2. THE ROUTE LISTS NO ACCOUNTS. With a list, `_routeAllows` returns
   *      membership of that list and never consults the id, so the figures are
   *      the route's own however the entry is named. The round tested this
   *      contract directly, and suppressing it reversed a decided answer.
   *   3. OWNERSHIP SEPARATES THE FLEET, asked TWO ways because neither alone is
   *      enough and the second nearly replaced the first. Either some account is
   *      barred from the REPRESENTATIVE and the route's glob reaches ids no
   *      claim names — in which case the figures grade a restricted set while
   *      that traffic is open to everyone — or a claim discriminates on an id
   *      the route actually RECEIVES. On a fleet declaring no `models` at all
   *      both are false and the figures grade the fleet exactly as any served
   *      id would, which is why an unclaimed fleet still publishes.
   *
   * WHAT THIS IS AND IS NOT. It is the condition under which the identity of the
   * representative CAN move a published figure, computed without a census of the
   * ids the route receives. It is not a proof that some figure does move: an
   * entry can pass all three and still coincide with what a served id would have
   * produced. Deciding that needs the id census this round measured unsafe
   * twice, so the residual is a narrow over-suppression, disclosed rather than
   * closed — and it errs toward absence-with-a-reason over a wrong number.
   *
   * DO NOT SIMPLIFY THIS TO TWO TERMS. Both of the tempting drops have a
   * counterexample in the suite, and neither is belt-and-braces:
   *
   *   drop conjunct 2 → `a route that lists its accounts keeps its figures when
   *     its representative is captured` goes red. That entry's figures are not
   *     merely defensible, they are TRUE: it names `b`, and `b` is exactly who
   *     serves the traffic that route receives.
   *   drop conjunct 3 → `the band ranks on the window this route governs` goes
   *     red. That fixture has an EMPTY accounts list, so conjunct 2 does not
   *     save it; what saves it is that nobody declares `models`, which makes
   *     `_accountOwnsModel` true for every account and the captured id grade
   *     the fleet exactly as a served one would.
   *
   * AND DO NOT COLLAPSE CONJUNCT 3's TWO HALVES INTO EITHER ONE. This was tried
   * and shipped wrong: re-keying to the received ids and DROPPING the
   * representative question fixed the sibling-claim inversion and opened another
   * one in the same commit, because a restricted representative differs from an
   * unnamed received id and no enumeration can reach the unnamed one. The
   * reverse collapse fails the sibling-claim case. Each half has its own
   * neutralisation row and its own fixture.
   */
  _captureDistortsFigures(model, route) {
    return this._representativeCaptured(model, route)
      && route.accounts.length === 0
      && ((this._representativeRestricted(model) && this._reachesBeyondNamedIds(route))
        || this._receivedIdDiscriminates(route));
  }

  /**
   * Is this entry's family SERVED AS A UNIT, or split among accounts by their
   * own `models` claims?
   *
   * An entry answers for a family, named by a representative id, and every
   * figure on it — the destination most of all — is that id's. That is the
   * truth for the whole family only while the family routes as one. A per
   * account claim of `claude-fable-5` against another of `claude-fable-4`
   * splits it: two ids, two accounts, and one entry advertising the first as
   * the answer for both.
   *
   * Something splits the family when it reaches into it without covering it,
   * and TWO THINGS CAN: a route ahead of this one, or an account's claim.
   * Where the family has no pattern of its own — the shared bucket, which is
   * the fallback for everything not metered separately — this cannot be
   * decided and answers null, which discloses nothing rather than guessing.
   */
  _familySplit(model, route = undefined, glob = null, autocreated = false) {
    // A SCOPE OF ONE ID CANNOT BE DIVIDED, and this guard has to sit ABOVE
    // EVERY ARM to say so. It was placed between them, so it protected the
    // claims arm and never the representative one, and a scope whose match is a
    // single literal id could still be told its family was split — the
    // over-correction fixed on one arm only. There is nothing to divide here
    // whoever does the dividing: one id has one destination. If that id goes to
    // an earlier route the entry is not SPLIT but DEAD, which is a different
    // fact and is disclosed by the scope determination rather than here.
    if (glob && !glob.includes('*')) return null;
    // THE REPRESENTATIVE IS NOT ALWAYS OURS. An earlier route can take the very
    // id this entry is named by while this route still carries the rest of the
    // family. Asked first among the divisions because it is the stronger
    // statement: not "some ids go elsewhere" but "this one does".
    if (this._representativeCaptured(model, route)) return 'an earlier route';
    // THE FAMILY IS MEASURED BY ITS OWN PATTERN, and asking the BUCKET question
    // instead is what made this field noisy. `familyGlobFor` says which families
    // meter their own weekly bucket, so it answers null for Opus and Haiku —
    // and the scope's glob was then substituted, which is a wider set than the
    // family. An earlier `claude-fable-5` route bites into a `claude-*` scope
    // and takes no Opus id whatever, so every Opus entry under a shared scope
    // was told its family was divided. `familyPatternFor` names the family
    // itself, and the substitution survives only for 'other', the one family
    // that genuinely has no pattern.
    const scopeGlob = familyPatternFor(model) ?? glob;
    if (!scopeGlob) return null;
    const reaches = g => modelGlobOverlaps(g, scopeGlob) && !globCovers(g, scopeGlob);
    // ONE PREDICATE, TWO ACTORS. Reaching in without covering divides the
    // family whoever does it, and an earlier route does it invisibly to the
    // check above: an exact route ahead of this one takes a SIBLING id, the
    // representative still resolves here, and the family is served from two
    // places with one entry speaking for both. Routes match in order, so only
    // the ones ahead of this one can have taken anything.
    // AN AUTOCREATED SCOPE HAS EVERY CONFIGURED ROUTE AHEAD OF IT. It exists
    // only because none of them matched its representative, so it is last by
    // construction — and reading its absent route as "nothing precedes this"
    // made the walk unreachable for exactly the scopes with the most
    // predecessors. With `claude-fable-4` configured to a spent account, the
    // autocreated Fable entry named its own destination while that sibling id
    // could not be served at all, and said nothing.
    const idx = route ? this.routes.indexOf(route) : -1;
    const before = autocreated ? this.routes
      : (idx > 0 ? this.routes.slice(0, idx) : []);
    if (before.some(r => r.match.some(reaches))) return 'an earlier route';
    // A ROUTE WITH AN EXPLICIT ACCOUNTS LIST PINS EVERY ID IT CARRIES, so no
    // account's `models` claim can divide it: `_routeAllows` decides first and
    // sends the whole scope to that list whatever the claims say. Asking the
    // claims anyway reported a division the route makes impossible.
    if (route && route.accounts.length) return null;
    return this.accounts.some(a => (a.models || []).some(reaches)) ? 'model claims' : null;
  }

  /** The name of the account a request for `model` would land on right now, or
   * null when nothing can serve it (every candidate disabled, spent or excluded). */
  _routeTarget(model, observed = this._observedFleet(), route = null) {
    const idx = this.previewRouteIndex(model, observed, route);
    return idx == null ? null : (observed.accounts[idx]?.name ?? null);
  }

  /** The name of the account this route is manually pinned to, or null. */
  _pinnedName(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx]?.name ?? null);
  }

  /** Accounts a configured route can use (all accounts when it lists none), each
   * with a live eligibility flag for a representative model of the route. */
  _routeAccountsView(route, observed = this._observedFleet()) {
    const sample = sampleModelFor(route);
    const inRoute = a => !route.accounts.length
      || route.accounts.includes(a.name) || route.accounts.includes(String(a.index));
    return observed.accounts.filter(inRoute)
      // The route here too: the eligibility half of the same defect. Asked
      // without it, an account this route may use was reported ineligible
      // because an EARLIER route disallows it — the flag said "b cannot serve
      // this" about the one account the route lists.
      .map(a => ({ name: a.name, eligible: this._isAvailable(a, sample, null, this._observeOpts(observed, route)) }));
  }

  /** A representative model id for a route name (configured or auto fable/sonnet),
   * used to test route-allowance when pinning. Null for an unknown route. */
  _routeSample(routeName) {
    const r = this.routes.find(x => x.name === routeName);
    if (r) return r.match[0]?.replace(/\*/g, '') || 'model';
    if (routeName === 'fable') return 'claude-fable-5';
    if (routeName === 'sonnet') return 'claude-sonnet-4-6';
    return null;
  }

  /**
   * Manually pin a route to an account (ephemeral runtime override). Rejects an
   * account the route's exclusivity/ownership rules disallow. Pinning an account
   * that is merely near-quota/throttled is allowed — it acts as a preference and
   * routing falls back to best-available until the pinned account is eligible.
   * Returns { ok, reason? }.
   */
  setRoutePin(routeName, accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return { ok: false, reason: 'no such account' };
    const sample = this._routeSample(routeName);
    if (sample && !this._routeAllows(account, sample)) {
      return { ok: false, reason: `route "${routeName}" does not allow "${account.name}"` };
    }
    this.routePins.set(routeName, accountIndex);
    return { ok: true };
  }

  clearRoutePin(routeName) { this.routePins.delete(routeName); }

  /** The account a route is pinned to, or null. */
  getRoutePin(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx] || null);
  }

  /** The manually-pinned account governing `model`, if any: a configured route's
   * pin wins, else an auto fable/sonnet family pin (only when no configured route
   * covers the model). For an advisor request the executor's pin wins (it is the
   * bulk of the spend); the advisor model's pin applies only when nothing pins
   * the executor. Returns null when nothing is pinned for this model. */
  _pinnedAccountForModel(model, advisorModel = null, route = undefined) {
    return this._pinnedFor(model, route)
      // The ADVISOR's route is its own. Its model may belong to a different
      // route entirely, so it derives rather than inheriting the caller's.
      || (advisorModel ? this._pinnedFor(advisorModel) : null);
  }

  _pinnedFor(model, route = this._routeForModel(model)) {
    if (!model || !this.routePins.size) return null;
    if (route) {
      const idx = this.routePins.get(route.name);
      return idx == null ? null : (this.accounts[idx] || null);
    }
    for (const name of ['fable', 'sonnet']) {
      if (this.routePins.has(name) && modelGlobMatches(`*${name}*`, model)) {
        return this.accounts[this.routePins.get(name)] || null;
      }
    }
    return null;
  }

  /**
   * Clear any quota counters whose reset time has passed. Cheap and safe to
   * call frequently (e.g. from the TUI render loop) — once a counter is cleared
   * it stays null until the next upstream response repopulates it, so the
   * "reset" log fires at most once per window.
   * @returns {{changed: boolean, session: boolean}} what was cleared.
   */
  /**
   * WHICH quota windows have expired, as a projection. Reads; never writes.
   *
   * Split from the clearing below because clearing is not only a tidy-up: a
   * five-hour window whose reset has passed is a session-reset EVENT, and
   * `refreshExpiredQuotas` owns it — it collects the accounts that reset and
   * hands them to `_switchOnSessionReset`. Whoever nulls the fields first
   * consumes that event, because the next reader sees a window that has already
   * gone.
   *
   * That made an observer a participant. `_routingReport` walks availability for
   * every account in every scope, availability asks the quota gate, and the gate
   * cleared: so reading the status ate the rollover the request path would have
   * acted on, and a fleet that had been polled routed somewhere else. Measured
   * on two trees — before this round a poll left the field at 0.99, after it the
   * field came back null and the destination changed.
   *
   * @returns {{ view: object, changed: boolean, session: boolean, cleared: string[] }}
   */
  _expiredQuotaView(account, now = Date.now()) {
    const q = account.quota;
    const view = { ...q };
    const cleared = [];
    let session = false;

    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      view.unified5h = null;
      view.unified5hReset = null;
      cleared.push('session');
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      view.unified7d = null;
      view.unified7dReset = null;
      view.unifiedStatus = null;
      cleared.push('weekly');
    }
    if (q.unified7dSonnet != null && q.unified7dSonnetReset && now >= q.unified7dSonnetReset) {
      view.unified7dSonnet = null;
      view.unified7dSonnetReset = null;
      cleared.push('sonnet');
    }
    if (q.unified7dFable != null && q.unified7dFableReset && now >= q.unified7dFableReset) {
      view.unified7dFable = null;
      view.unified7dFableReset = null;
      cleared.push('fable');
    }
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      view.tokensRemaining = null;
      view.tokensLimit = null;
      view.requestsRemaining = null;
      view.requestsLimit = null;
      view.resetsAt = null;
      cleared.push('standard');
    }

    return { view, changed: cleared.length > 0, session, cleared };
  }

  _clearExpiredQuotas(account) {
    const { view, changed, session, cleared } = this._expiredQuotaView(account);
    if (!changed) return { changed, session };
    if (cleared.includes('session')) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
    }
    if (cleared.includes('weekly')) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
    }
    // In place, not a reassignment. Callers hold `account.quota` across this —
    // the test helpers do, and so does anything that captured it before a sweep
    // — and swapping the object would leave every such reference reading the
    // pre-clear values while the account itself had moved on. Same fields, same
    // object identity.
    Object.assign(account.quota, view);
    return { changed, session };
  }

  /**
   * Clear expired quotas across all accounts. Called from the display loop and
   * the request path so a window expiry (e.g. the 5-hour session quota) resets
   * the view instantly rather than waiting for the next request.
   *
   * When an account's session quota resets, it may have become the better
   * choice — switch to it if its weekly limit expires sooner than the current
   * account's (and it still has weekly quota), so we spend the quota closest to
   * refreshing first.
   */
  refreshExpiredQuotas() {
    let changed = false;
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates) {
    const best = this._sessionResetTarget(candidates);
    if (!best) return;
    this._setCurrent(best);
    this._beginRamp(best);
    console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
  }

  /**
   * WHICH account that switch would move to, or null. Reads; never writes.
   *
   * Split from the applying half above for the reason `_expiredQuotaView` is
   * split from `_clearExpiredQuotas`: this runs in `getActiveAccount`'s
   * PROLOGUE, before any selection, so an observer that does not project it
   * reports where a request would go from a `currentIndex` the request itself
   * would have moved first. It reported the incumbent while every request went
   * to the resetting account.
   *
   * `fleet` and `currentIndex` are parameters rather than reads of `this`
   * because the observed call passes the projected fleet, which is what makes
   * this ONE implementation of the choice rather than the preview's own copy of
   * it.
   */
  _sessionResetTarget(candidates, { fleet = this.accounts, currentIndex = this.currentIndex, now = Date.now(), observe = false } = {}) {
    const opts = { fleet, observe, now };
    const current = fleet[currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone.
    if (!current || current.quota.unified7dReset == null) return null;

    // Only accounts whose weekly expires sooner than the current one's are
    // candidates at all: that is the "and weekly expires sooner" half of what
    // this function is for. Filtering and ranking were one comparison before,
    // and separating them is what lets the ranking below change without moving
    // the trigger.
    const eligible = [];
    for (const acc of candidates) {
      if (acc.index === currentIndex) continue;
      if (!this._isAvailable(acc, null, null, opts)) continue; // enough session & weekly quota left
      // Don't demote to a lower-priority (higher value) account on a reset.
      if ((acc.priority || 0) > (current.priority || 0)) continue;
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < current.quota.unified7dReset) eligible.push(acc);
    }
    if (!eligible.length) return null;

    // One clock for every account compared here, the current one included:
    // pressure rises continuously, so scoring the incumbent at a different
    // instant from its challengers decides a near-tie on the gap between two
    // Date.now() reads. The observed call passes the instant its whole
    // projection was taken at, for the same reason.
    const field = eligible.concat(current);
    const ranks = this._pickPressures(field, null, now).map(pressureRank);
    const rankOf = new Map(field.map((a, i) => [a.index, ranks[i]]));

    let best = null;
    for (const acc of eligible) {
      if (!best) { best = acc; continue; }
      const mine = rankOf.get(acc.index);
      const theirs = rankOf.get(best.index);
      // Highest pressure, then soonest reset — the same order the pick uses, so
      // the two cannot disagree about which of two accounts is worth more.
      if (mine < theirs
        || (mine === theirs && acc.quota.unified7dReset < best.quota.unified7dReset)) best = acc;
    }

    // This choice used to be made on reset time alone — the metric expiry
    // pressure exists to correct — and it decides a WRITE of currentIndex in
    // the caller, which is what these guards protect. TWO of them, because they
    // are different properties and neither implies the other. Band membership says
    // the account is worth spending at all; it was a usable proxy for pressure
    // only while the band WAS the tolerance ratio, and capacity sizing widens it
    // deliberately. The rank comparison says this switch does not leave a
    // strictly better account behind, which membership never claimed.
    if (this.expiryRouting.enabled && !this._bandedCandidates(null, null, null, opts).includes(best)) return null;
    // Strictly worse than what we are on: stay. Equal keeps the reset tiebreak
    // that got us here, and with expiry routing off every rank is absent and
    // equal, so this cannot fire at all.
    if (rankOf.get(best.index) > rankOf.get(current.index)) return null;
    return best;
  }

  /**
   * THE FLEET AS THE NEXT REQUEST WILL FIND IT: every expired window cleared,
   * every elapsed throttle hold reopened, and `currentIndex` moved where the
   * prologue would move it. Computed on copies; nothing here is applied.
   *
   * Every observation — the status payload, the routing report, the route
   * table, the TUI's destination markers — reads this and nothing else, which
   * is the property that replaced a per-question `observe` flag over live
   * state. Two pass-4 findings came from that flag: eligibility answered
   * post-clear while the band ranked the pre-clear numbers beside it, and the
   * preview read a `currentIndex` that `refreshExpiredQuotas` moves before any
   * selection runs. Both are unconstructible against one projected state.
   *
   * ONE CLOCK for the whole projection, for the reason the band takes one: a
   * window that expires between two reads would otherwise be gone from one
   * answer and present in the next, which is the same split in miniature.
   *
   * What it deliberately does NOT project is the two things a request does that
   * an observer must not: consuming the session-reset event (the clear here is
   * on a copy, so the event stays owed to `refreshExpiredQuotas`) and seeding a
   * rollover baseline (`_setCurrent`, which is why the switch below is chosen
   * and not applied).
   *
   * @returns {{ accounts: object[], currentIndex: number }}
   */
  _observedFleet(now = Date.now()) {
    // The projection CARRIES ITS INSTANT. Every clock read downstream of an
    // observation — the throttle-hold comparison, the band snapshot, the pick's
    // pressures, the last resort's "has it passed", the published pressure and
    // pause — reads this rather than the wall clock, because the projection
    // decided expired-or-not at exactly this moment and a later read can put a
    // window on the other side of its own reset. That is finding A's shape
    // again: two views of one account, one call apart.
    const sessionReset = [];
    const accounts = this.accounts.map(a => {
      const { view, session } = this._expiredQuotaView(a, now);
      const copy = { ...a, quota: view };
      // The elapsed throttle hold belongs to the same prologue: `_availability`
      // reopens the account on the next request it is asked about, so an
      // observation that left it throttled would publish a state no request can
      // meet — and would rank it out of a band the request path admits.
      if (copy.status === 'throttled' && copy.rateLimitedUntil && now >= copy.rateLimitedUntil) {
        copy.status = 'active';
        copy.rateLimitedUntil = null;
        copy.throttledAt = null;
      }
      if (session) sessionReset.push(copy);
      return copy;
    });
    let currentIndex = this.currentIndex;
    if (sessionReset.length) {
      const best = this._sessionResetTarget(sessionReset, { fleet: accounts, currentIndex, now, observe: true });
      if (best) currentIndex = best.index;
    }
    return { accounts, currentIndex, now };
  }

  /** The options every read inside an observation is made with: the projected
   * fleet, the instant it was taken at, the promise not to write, and — when
   * the caller is answering ABOUT a route — that route. Built here so a new
   * observation call site cannot pick up three of the four, and so the route,
   * which varies per entry where the other three vary per observation, stays
   * inside the one constructor rather than being spread in by hand. */
  _observeOpts(observed, route = null) {
    return { observe: true, fleet: observed.accounts, now: observed.now, route };
  }

  _isNearQuota(account, model = null) {
    return this._quotaBar(account, model) !== null;
  }

  /**
   * WHICH quota bars this account, or null when none does.
   *
   * Four different windows can bar a request and they call for different
   * actions: a five-hour window that clears within the hour, a weekly one that
   * does not, and two API-key limits that are not windows at all. `_isNearQuota`
   * is the projection to the boolean routing needs, so the gate and the report
   * of the gate are the same evaluation rather than two that agree today.
   *
   * `bucket` names the window the reported figure came from, which for the
   * weekly case is not always the governing bucket: the gate takes a maximum
   * over the family bucket and the shared one, and `gatingSource` says which
   * won. Naming the governing key beside a number the shared bucket produced
   * would put a bucket and a figure from different windows on one line.
   *
   * @returns {{ reason: string, bucket: string|null, detail: number } | null}
   */
  _quotaBar(account, model = null, { observe = false, route = null } = {}) {
    // `observe` means one thing and only one: DO NOT WRITE. It does not also
    // project, because the account handed in is already the projection when the
    // caller is an observer (`_observedFleet`). Projecting here as well was the
    // shape of pass-4's converged finding — this answered post-clear while
    // `_bandSnapshot`, reading the same account's live quota one call later,
    // ranked pre-clear. One state per observation, chosen by the caller; a
    // reader that forgets is then uniformly stale rather than self-contradictory.
    const q = account.quota;
    if (!observe) this._clearExpiredQuotas(account);

    // Shared 5-hour bucket gates every request regardless of model.
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) {
      return { reason: 'five-hour-spent', bucket: 'unified5h', detail: q.unified5h };
    }

    // The HIGHER of the weekly bucket that governs this model and the shared
    // weekly one. Fable and Sonnet meter their own quota, so a spent Fable
    // bucket still bars only Fable — but family spend also meters into the
    // shared bucket, so an account over its overall cap is barred from the
    // families too, which is what stops it ratcheting further past that cap.
    // When the family bucket isn't reported the shared one answers alone.
    // One definition, in `gatingUtilization`; the status row and the TUI tag
    // display this same value rather than deriving it again.
    const weekly = gatingSource(q, this._governingBucket({ ...account, quota: q }, model, route));
    if (weekly != null && weekly.value >= this.switchThreshold) {
      return { reason: 'weekly-spent', bucket: weekly.bucket, detail: weekly.value };
    }

    // Standard quotas (API key accounts). Their own reasons rather than
    // `weekly-spent`: neither is a weekly window, and an account out of tokens
    // wants a different answer from one that is out of week.
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return { reason: 'tokens-spent', bucket: null, detail: used };
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return { reason: 'requests-spent', bucket: null, detail: used };
    }

    return null;
  }

  /**
   * Pick the best available account by selection order, WITHOUT mutating state:
   *   1. lowest `priority` value (operator-controlled; default 0, lower = preferred)
   *   2. then the account with no known weekly quota — using it lets us
   *      discover it
   *   3. then the account with the most expiring quota (headroom per second
   *      until its window resets), when expiry routing is on
   *   4. then the account whose weekly limit expires soonest: that quota is
   *      closest to refreshing, so spending it first preserves accounts whose
   *      weekly window resets further out.
   * With expiry routing off, step 3 is absent for every account and this
   * reduces to the weekly-reset heuristic exactly as before.
   *
   * STEP 3 GENERALISES STEP 4 RATHER THAN COMPETING WITH IT. At equal weekly
   * headroom the two agree — soonest reset IS highest pressure — so they differ
   * only where headroom differs, which is where the timestamp alone was wrong:
   * a nearly-drained account resetting in an hour used to beat one holding 20x
   * the quota that expires in ten. Sizing the band for parallel capacity is what
   * exposed that, because the tolerance ratio had been banding the low-pressure
   * member out before this loop ever saw it. Returns the account or null if none
   * are available.
   */
  _pickBestAvailable(exclude = null, model = null, advisorModel = null, opts = {}) {
    let best = null;
    let bestPriority = Infinity;
    let bestPressure = Infinity;
    let bestReset = Infinity;

    const candidates = this._bandedCandidates(exclude, model, advisorModel, opts);
    // One clock for every candidate, for the reason the band reads one: pressure
    // rises continuously as a window nears its reset, so scoring two accounts at
    // different instants decides an exact tie on the microseconds between two
    // Date.now() reads. An observation hands in its own instant, which is the
    // one its projection was taken at.
    const now = opts.now ?? Date.now();
    const pressures = this._pickPressures(candidates, model, now, opts.route);
    candidates.forEach((account, i) => {
      const priority = account.priority || 0;
      const pressure = pressureRank(pressures[i]);
      // Rank by the reset of the weekly bucket that governs THIS model (Fable and
      // Sonnet have their own), so a Fable request spends the account whose Fable
      // window refreshes soonest while preserving accounts that reset later for
      // Opus/Sonnet. Unknown reset sorts first so we probe and fill it in.
      const weeklyReset = this._governingWeeklyReset(account, model, opts.route) || -Infinity;
      if (priority < bestPriority
          || (priority === bestPriority && pressure < bestPressure)
          || (priority === bestPriority && pressure === bestPressure && weeklyReset < bestReset)) {
        bestPriority = priority;
        bestPressure = pressure;
        bestReset = weeklyReset;
        best = account;
      }
    });
    return best;
  }

  /**
   * Select the active account up front (e.g. on daemon launch, once persisted
   * quota has been restored) so we start on the highest-priority / soonest-
   * resetting account instead of blindly on index 0. Mirrors rotation order.
   * Returns the chosen account, or the existing current one if none are
   * available (the server still starts; requests 429 until a window resets).
   */
  selectActiveAccount() {
    this.refreshExpiredQuotas(); // drop any restored windows that already expired
    const best = this._pickBestAvailable();
    if (!best) return this.accounts[this.currentIndex] || null;
    this._setCurrent(best);
    this._beginRamp(best);
    best.probing = best.quota.unified7dReset == null;
    const wk = best.quota.unified7d != null
      ? `${(best.quota.unified7d * 100).toFixed(1)}% weekly used`
      : 'weekly quota unknown';
    console.log(`[TeamClaude] Starting on account "${best.name}" (priority ${best.priority || 0}, ${wk})`);
    return best;
  }

  _selectNext(exclude = null, model = null, advisorModel = null) {
    const best = this._pickBestAvailable(exclude, model, advisorModel);
    if (best) {
      const switched = best.index !== this.currentIndex;
      this._setCurrent(best);
      // If we switched to an account whose weekly quota is still unknown, flag
      // it so we re-evaluate once that quota is learned (see updateQuota).
      best.probing = best.quota.unified7dReset == null;
      if (switched) {
        this._beginRamp(best);
        console.log(`[TeamClaude] Switched to account "${best.name}"`);
      }
      return best;
    }

    // All accounts unavailable — reopen the one whose window has already passed.
    const reopened = this._resurrectTarget(exclude, model, advisorModel);
    if (!reopened) return null;
    reopened.status = 'active';
    reopened.rateLimitedUntil = null;
    this._setCurrent(reopened);
    this._beginRamp(reopened);
    console.log(`[TeamClaude] Account "${reopened.name}" reset, switching to it`);
    return reopened;
  }

  /**
   * WHICH account the last resort above would reopen, or null. Reads; never
   * writes.
   *
   * A FOURTH way `_select` returns an account, and the one the preview used to
   * miss: with nothing eligible, a request does not 429 while an account whose
   * hold has already elapsed sits there — it reopens that account and is served
   * by it. Read-only callers ask this and name the account; only `_selectNext`
   * performs the reopening. Found while fixing the prologue divergence: the
   * preview said "nothing can serve this" about a fleet every request was being
   * served by.
   *
   * `opts.fleet` is the projected fleet for an observer, as everywhere else.
   */
  _resurrectTarget(exclude = null, model = null, advisorModel = null, opts = {}) {
    const fleet = opts.fleet || this.accounts;
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of fleet) {
      if (exclude?.has(account.index)) continue;
      // Never resurrect a hard-state account: `disabled` is an operator decision
      // and `error` means the token is broken (needs re-login). Selecting either
      // here would send a live request on an account that must not be used and,
      // in the caller, silently clear its throttle/error state. (Mirrors _isAvailable.)
      if (account.disabled || account.status === 'error') continue;
      // A routed/owned model must not fall back to an ineligible account —
      // neither the executor's nor an advisor's.
      // The entry's route for the EXECUTOR's model; the advisor's is its own,
      // as in `_availability`.
      if (model && !this._routeAllows(account, model, opts.route ?? this._routeForModel(model))) continue;
      if (advisorModel && !this._routeAllows(account, advisorModel)) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    return soonestAccount && soonestTime <= (opts.now ?? Date.now()) ? soonestAccount : null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max). Every value goes through
    // setQuotaField, which rejects anything outside the field's domain —
    // parseFloat yields ±Infinity for a "-1e400" header, and a non-finite
    // utilization or reset poisons every comparison downstream. A NaN reset is
    // the worst of them: `now >= reset` never holds, so _clearExpiredQuotas can
    // never retire that bucket again.
    setQuotaField(account, 'unified5h', parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']));
    setQuotaField(account, 'unified7d', parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']));

    setQuotaField(account, 'unified5hReset', parseInt(headers['anthropic-ratelimit-unified-5h-reset'], 10) * 1000);
    setQuotaField(account, 'unified7dReset', parseInt(headers['anthropic-ratelimit-unified-7d-reset'], 10) * 1000);

    // Model-scoped weekly bucket — surfaced in headers as `7d_oi` ("7-day,
    // overage included"). On current subscription plans this is the Fable weekly
    // limit (it correlates with the usage endpoint's Fable-scoped weekly bucket).
    // Utilization here is already a 0-1 fraction (can exceed 1 when in overage).
    setQuotaField(account, 'unified7dFable', parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']));
    setQuotaField(account, 'unified7dFableReset', parseInt(headers['anthropic-ratelimit-unified-7d_oi-reset'], 10) * 1000);

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    setQuotaField(account, 'unifiedStatus', headers['anthropic-ratelimit-unified-status']);

    // Standard rate limits (API key accounts)
    setQuotaField(account, 'tokensLimit', parseInt(headers['anthropic-ratelimit-tokens-limit'], 10));
    setQuotaField(account, 'tokensRemaining', parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10));
    setQuotaField(account, 'requestsLimit', parseInt(headers['anthropic-ratelimit-requests-limit'], 10));
    setQuotaField(account, 'requestsRemaining', parseInt(headers['anthropic-ratelimit-requests-remaining'], 10));

    if (!setQuotaField(account, 'resetsAt', headers['anthropic-ratelimit-tokens-reset'])) {
      setQuotaField(account, 'resetsAt', headers['anthropic-ratelimit-requests-reset']);
    }

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Record one upstream usage report against the account that served it and the
   * session that asked for it.
   *
   * Separate from `updateUsage` rather than folded into it: that one is on the
   * path every existing caller and test already drives, and this adds a second
   * scope (the session) whose lifecycle is not the account's. Keeping them apart
   * means nothing that reads the account totals changes behaviour here.
   *
   * The per-session context recorded here is what the pick's load term ranks
   * on, through `SessionTracker.loadFor`. The cumulative totals beside it steer
   * nothing: they are the measurement a cache-aware migration policy would
   * need, and no such policy exists here.
   */
  recordTokenUsage(accountIndex, sessionId, model, usage) {
    if (!usage) return;
    // The same resolver routing uses, so a token total and a pin agree about
    // which family a request belonged to. Resolved here rather than at the call
    // sites: they parse a wire format and have no business knowing about
    // buckets.
    const bucket = this._weeklyBucketFor(model);
    const account = this.accounts[accountIndex];
    if (account) {
      const read = Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
      const creation = Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
      account.usage.totalCacheReadTokens += read;
      account.usage.totalCacheCreationTokens += creation;
      const per = account.usage.byBucket[bucket]
        || (account.usage.byBucket[bucket] = { cacheReadTokens: 0, cacheCreationTokens: 0 });
      per.cacheReadTokens += read;
      per.cacheCreationTokens += creation;
    }
    this.sessionTracker.recordTokens(sessionId, bucket, usage);
  }

  /**
   * Enable or disable an account. A disabled account is skipped by rotation
   * until re-enabled. Re-enabling also clears a stuck 'error' state (and any
   * lingering rate-limit hold) so the account is retried immediately.
   */
  setDisabled(accountIndex, disabled) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.disabled = disabled;
    if (!disabled && account.status === 'error') {
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" re-enabled — clearing error state`);
    }
  }

  /**
   * Apply quota learned from the OAuth usage endpoint (the background probe).
   * Updates utilization/reset for the 5h, 7d, Sonnet-7d, and Fable-7d buckets WITHOUT
   * touching usage counters — a probe is not real client traffic.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;

    // The usage endpoint is a network input like any other, so it writes
    // through the same validating setter as response headers and restored
    // state: a bucket named here with a non-numeric window would otherwise be
    // one _clearExpiredQuotas can never retire.
    const buckets = [
      ['fiveHour', 'unified5h'],
      ['sevenDay', 'unified7d'],
      ['sevenDaySonnet', 'unified7dSonnet'],
      ['sevenDayFable', 'unified7dFable'],
    ];
    for (const [source, field] of buckets) {
      const reported = usage[source];
      if (!reported) continue;
      setQuotaField(account, field, reported.utilization);
      setQuotaField(account, `${field}Reset`, reported.resetAt);
    }

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    // Marks when the hold was (re-)armed: a revalidation probe is allowed only
    // after throttleProbeFloorMs from here, so a probe that 429s again pushes
    // the next probe out by a full floor rather than hammering upstream.
    account.throttledAt = Date.now();
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Clear a rate-limit hold after live proof it no longer binds: any non-429
   * upstream response on a throttled account (a revalidation probe reaching
   * here, or a hold armed moments before traffic resumed). No-op otherwise.
   */
  clearRateLimited(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account || account.status !== 'throttled') return;
    account.status = 'active';
    account.rateLimitedUntil = null;
    account.throttledAt = null;
    console.log(`[TeamClaude] Account "${account.name}" revalidated — rate limit no longer applies, back in rotation`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // A forced refresh answers a 401, but 401s arrive in bursts: every request
    // already in flight when the token went bad comes back rejected, and each
    // one would force its own refresh. Coalescing only covers refreshes that
    // OVERLAP — these arrive staggered, so they would rotate the refresh-token
    // family once per request and make the proxy the very "other holder
    // rotating the family" that causes this failure in the first place. A 401
    // for a token minted moments ago is stale news from a request sent before
    // the refresh landed, so trust the new token and let the caller retry with
    // it. Only an expiry-driven refresh (force=false) bypasses this — it isn't
    // reacting to a response and can't stampede.
    if (force && account._lastRefreshAt !== null
        && Date.now() - account._lastRefreshAt < this._forcedRefreshFloorMs) {
      return;
    }

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await this._refreshFn(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        account._lastRefreshAt = Date.now();
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        // Re-resolve the position from the ACCOUNT, never from the index this
        // call started with. A removal splices `accounts` (and the config list
        // the callback writes through, which the TUI keeps aligned with it)
        // while this await is outstanding, so the captured index now names a
        // different account — which would receive both of these tokens, while
        // the real owner keeps a refresh token the provider has rotated away.
        // Gone from the list means gone: persist nothing.
        const idx = this.accounts.indexOf(account);
        if (idx >= 0) this._onTokenRefresh?.(idx, newTokens, account);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Reserve 'error' (which drops the account from rotation until re-login)
        // for a GENUINE auth rejection: the refresh token itself is no longer
        // valid — revoked, or invalidated by an account/plan migration. A
        // transient failure (network, 5xx, timeout) must NOT sideline a healthy
        // account: keep its current token and retry on the next request. This is
        // what kept accounts wrongly "errored" after a momentary refresh blip.
        const isAuthRejection = err.status === 400 || err.status === 401 || err.status === 403;
        if (isAuthRejection) {
          account.status = 'error';
          console.error(`[TeamClaude] Account "${account.name}" needs re-login (refresh token rejected) — run: teamclaude login`);
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config. Invoked as
   * (index, tokens, account): the index is re-resolved at the moment of the
   * call, and `account` is the record itself so a consumer can match its own
   * list by identity rather than trusting the two to stay aligned.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    }, account);
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push(makeAccount(acctData, index));
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    const [removed] = this.accounts.splice(index, 1);
    // The record itself outlives the list: a request already past selection
    // holds it and goes on calling release/updateQuota with `account.index`,
    // which every survivor's has just been rewritten to mean someone else's
    // slot. Point it at nothing instead, so those late calls no-op rather than
    // decrementing another account's concurrency or writing this one's quota
    // onto it. (The same shape as the mid-refresh crossing ensureTokenFresh
    // avoids by re-resolving the position from the account.)
    removed.index = -1;
    this.accounts.forEach((a, i) => a.index = i);
    // Removing the CURRENT account leaves a different one in that slot, which is
    // establishing a current account rather than renumbering one — so it goes
    // back through the single writer below, once the watcher it seeds into has
    // itself been renumbered. The other two branches follow the same account
    // through the shift and need no baseline.
    const establishesNewCurrent = this.currentIndex === index;
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
    // Keep route pins pointing at the right account after the index shift: drop a
    // pin on the removed account, decrement pins that sat above it.
    for (const [name, idx] of [...this.routePins.entries()]) {
      if (idx === index) this.routePins.delete(name);
      else if (idx > index) this.routePins.set(name, idx - 1);
    }
    // The index shift a stored account index has to follow: the removed slot is
    // gone and everything above it moves down one. A null result means this
    // entry's account is the one that went away. Every structure below holds
    // one; a structure added later that does too belongs in this block, because
    // an un-shifted index does not fail — it quietly names its neighbour.
    const remap = idx => (idx === index ? null : idx > index ? idx - 1 : idx);
    // A route may name its accounts by INDEX ("accounts": ["2"]) rather than by
    // name, and that index means the same list. Left alone it names a different
    // account after the shift, so the route silently starts serving — and
    // excluding — the wrong ones. Names are unaffected.
    for (const route of this.routes) {
      route.accounts = route.accounts
        .map(a => (/^\d+$/.test(a) ? remapIndexRef(a, index) : a))
        .filter(a => a != null);
    }
    // Session pins are indices into the same list and shift with it: without
    // this, every session pinned above the removed account is served by its
    // neighbour, and the removed account's own sessions land on whatever slid
    // into its slot. Unpinned sessions simply re-route on their next request.
    // Each session's rollover baselines ride the same record and are renumbered
    // with them (see remapAccounts).
    this.sessionTracker.remapAccounts(remap);
    // The current account's detector stores an account index alongside the
    // windows it saw on it, so it shifts with the list too: left alone that
    // index names a DIFFERENT account, whose window would read as a jump and
    // preempt for nothing. Renumber rather than reset — a baseline on an
    // untouched account would otherwise not be rebuilt until after that
    // account's next rollover had already passed unnoticed.
    if (!this._currentSeen.remap(remap)) this._currentSeen = new WindowWatcher();
    // The stuck-rollover throttle is keyed by (account index, bucket) too. Left
    // alone, the account that slid into the removed slot inherits its
    // neighbour's silence and its own stuck rollover — the one failure of this
    // feature that looks exactly like it working — goes unreported for up to a
    // minute. Rebuilt rather than edited in place: two keys can map onto each
    // other, and an in-place pass would drop the survivor it had just written.
    const throttled = new Map();
    for (const [key, at] of this._rolloverStuckLogAt) {
      const sep = key.indexOf(':');
      const moved = remap(Number(key.slice(0, sep)));
      if (moved != null) throttled.set(`${moved}${key.slice(sep)}`, at);
    }
    this._rolloverStuckLogAt = throttled;
    // Last, because it seeds into the watcher the line above may have replaced.
    if (establishesNewCurrent && this.accounts[this.currentIndex]) {
      this._setCurrent(this.accounts[this.currentIndex]);
    }
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      return { accountUuid: a.accountUuid, orgUuid: a.orgUuid, orgName: a.orgName, name: a.name, quota };
    });
  }

  /**
   * Restore quota learned in a previous run. Matches saved entries to accounts
   * by identity. Stale windows are not special-cased here — _clearExpiredQuotas
   * wipes any restored window whose reset time has already passed on first use.
   */
  restoreQuotaState(saved) {
    if (!Array.isArray(saved)) return;
    for (const account of this.accounts) {
      const match = saved.find(s => sameIdentity(s, account));
      if (!match || !match.quota) continue;
      // The state file is as much an input as a response header, and nothing
      // between writing and reading it guarantees a value still means what it
      // did — so every field gets the same domain check on the way back in.
      for (const f of PERSISTED_QUOTA_FIELDS) setQuotaField(account, f, match.quota[f]);
      // A utilization is a fraction OF a window. Where the file names a window
      // and the value it gives is not one, neither half of that pair is
      // trustworthy: a spent bucket whose reset was rejected is one nothing can
      // ever retire — `now >= reset` is never true of a value that is not a
      // time — so the account sits at or over threshold, is never selected, and
      // never gets the response that would correct it. A file carrying no reset
      // at all is a different thing (that window was simply never learned) and
      // its utilization is restored as usual.
      for (const f of UTILIZATION_FIELDS) {
        if (match.quota[`${f}Reset`] != null && account.quota[`${f}Reset`] == null) {
          account.quota[f] = null;
        }
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   *
   * `now` IS A TEST SEAM, NOT A FEATURE. Every field of this payload answers
   * about one instant, and the way that claim fails is a field reading the wall
   * clock a microsecond later — too narrow for any test to catch by waiting.
   * The parameter is how the claim is checked instead of asserted: ask for the
   * payload at an instant ten minutes gone and a field on the wall clock
   * answers about a different fleet than the field beside it.
   *
   * Two things follow, for whoever reads this next. No shipping caller passes
   * it, and nothing here validates it, so a caller that hands over a stale
   * instant gets a confident payload about the past — this is a seam for a
   * test, not an as-of query. And it earns its surface only while a test drives
   * it: if `status-payload.test.js`'s one-clock test goes, take this with it
   * rather than leaving behind a parameter nobody can justify and nobody dares
   * remove.
   */
  getStatus(now = Date.now()) {
    // ONE PROJECTION FOR THE WHOLE PAYLOAD, and one clock behind it. Every
    // section — the routes, the routing report, the per-account rows — answers
    // about the same state: the fleet as the next request will find it. Built
    // once here rather than per section because two projections taken a
    // millisecond apart can straddle a window expiry, and a payload whose
    // ladder ranks an account the row beside it calls spent is the pass-4
    // finding one layer out.
    //
    // `currentAccount` is the projected one for the same reason the
    // destination rows are: after a session reset the prologue moves it before
    // any selection runs, so the live index names an account no request will
    // start from.
    const observed = this._observedFleet(now);
    // The tracker's own share of the owed gauge, reported alongside the session
    // view it is derived from but published under expiryRouting, which is the
    // feature it says something about.
    // BOTH take the payload's instant. Their clock defaults live in
    // `session-tracker.js`, one module out, which is how the sweep that closed
    // this class inside `account-manager.js` walked straight past them: a
    // `Date.now()` enumeration cannot see a default it does not contain. The
    // fields they produce — active sessions, per-account load — sat five
    // minutes from the fleet described beside them.
    //
    // `stats` also sweeps expired sessions at the instant it is given. At the
    // wall clock that is exactly today's behaviour; asked about an earlier one
    // it deletes strictly fewer and moves `_lastSweep` back, which only makes
    // the next ordinary sweep sooner.
    const { pendingRollovers, ...sessions } = this.sessionTracker.stats(now);
    // One walk per account for the whole payload, not one per field read.
    const measured = new Map(observed.accounts.map(a => [a.index, this.sessionTracker.loadFor(a.index, now)]));
    return {
      currentAccount: observed.accounts[observed.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      expiryRouting: {
        ...this.expiryRouting,
        // "Is expiry routing working?" without attaching a debugger or waiting
        // a week — a real weekly window rolls about once per account per week,
        // so there are only a handful of chances to see one. `detected` counts
        // the events, once each at the moment one becomes owed; `preempted`
        // counts the ones a request actually moved, once each at the moment the
        // move is known to have stuck, so it can never exceed `detected`.
        // `owed` is not those two subtracted: it is a gauge read off the live
        // pending state, counting only events nothing has moved yet, so an event
        // that left with the session it belonged to stops being owed and one
        // merely waiting for its session to fall quiet was never owed. Above
        // zero across several minutes is the signature of the silent failure —
        // a rollover that fired and never resolved.
        stats: {
          rolloversDetected: this._rolloverStats.detected,
          rolloversPreempted: this._rolloverStats.preempted,
          rolloversOwed: pendingRollovers + this._currentSeen.pendingCount(),
        },
      },
      routes: this.getRoutes(observed),
      routing: this._routingReport(observed),
      sessions: { ...sessions, distribute: this.distributeSessions },
      accounts: observed.accounts.map(a => {
        // The projection's instant, not a fresh read: a reset falling between
        // the two would be a live window to the projection and a spent one to
        // this figure, on the same row of the same payload.
        const pressure = this._pressureVariant(a, null, now);
        return {
          name: a.name,
          type: a.type,
          orgName: a.orgName || null,
          priority: a.priority || 0,
          disabled: a.disabled || false,
          status: a.status,
          sessions: sessions.perAccount[a.index] || 0,
        // What this account is measurably carrying, and how many upstream
        // reports back that figure. Published together because neither is
        // legible alone: `load: 0` with sessions on the account is a dead token
        // pipeline when `observed` is 0 and a genuinely idle one when it is
        // not, and nothing else on this payload separates them. That is the
        // same distinction `reports` exists for one layer in, at the level an
        // operator actually reads.
          load: measured.get(a.index).context,
          observed: measured.get(a.index).reports,
          // How many requests this account is carrying RIGHT NOW. A live gauge,
          // like `rolloversOwed` and unlike `rolloversDetected`: zero is a
          // measurement meaning nothing is in flight, not a missing reading, and
          // nothing accumulates. It is already a ranking term in `_pickSnapshot`
          // and was the one term an operator could not see, so a pick that went
          // somewhere unexpected had a reason with no field behind it.
          inFlight: a.inFlight || 0,
          // Shared-weekly pressure (model-agnostic view); null while unknown,
          // and `pressureAbsent` says which unknown. A bare null cannot separate
          // a window nobody has reported from a reset instant that never
          // arrived from a value that came back malformed, and those want
          // different actions: wait, wait, or go and look at the account.
          //
          // 'expiry-routing-off' is deliberately NOT in this field's domain.
          // That reason belongs to `_pickPressures`, which answers a
          // model-scoped question about the feature flag. This pressure is
          // computed whether the flag is on or off, so reporting the flag here
          // would call a measured fleet unmeasurable because a feature is
          // switched off.
          pressure: pressure.kind === 'known' ? pressure.value : null,
          pressureAbsent: pressure.kind === 'absent' ? pressure.reason : null,
          quota: { ...a.quota },
          usage: { ...a.usage },
          rateLimitedUntil: a.rateLimitedUntil
            ? new Date(a.rateLimitedUntil).toISOString()
            : null,
          pausedUntil: a.pausedUntil && a.pausedUntil > now
            ? new Date(a.pausedUntil).toISOString()
            : null,
        };
      }),
    };
  }
}
