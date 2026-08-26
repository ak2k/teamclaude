import { blockedState, familyModel, modelsForGlob, modelFamily, gatingUtilization } from './model.js';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

export function renderStatus(status, { color = process.stdout.isTTY, now = Date.now() } = {}) {
  const paint = colors(color);
  const lines = [];
  const probe = status.probe || { enabled: false, intervalSeconds: 0, accounts: [] };
  const warm = status.warm || { enabled: false, intervalSeconds: 0, accounts: [] };
  const accounts = status.accounts || [];
  const blocked = (status.blockedModels || []).filter(p => typeof p === 'string' && p.length);

  lines.push(paint.bold('TeamClaude status'));
  lines.push(`${paint.dim('Active'.padEnd(12))} ${paint.cyan(status.currentAccount || 'none')}`);
  lines.push(`${paint.dim('Switch at'.padEnd(12))} ${formatPercent(status.switchThreshold)}`);
  const decision = chooseScope(status.routing, blocked);
  // A decision with nothing to say collapses to one row here, beside `Switch
  // at`, rather than rendering an eleven-line block about a rule that is not
  // running. Naming a state costs a phrase; it does not earn a section. That
  // matters most for the stock fleet, where expiry routing is off by default
  // and the full block would be a caption for a rule that never ran, a list of
  // ranks the code never computed, and two destination rows restating `Active`.
  if (decision && decision.band.kind === 'passthrough') {
    lines.push(`${paint.dim('Selection'.padEnd(12))} `
      + `${selectionSummary(decision, status.sessions?.distribute !== false)}`);
  }
  // Only when something is blocked: a always-visible "Blocked" row would be
  // noise for the common case, but its ABSENCE is what made a blocked model
  // read as available — the per-account Models row reports quota headroom and
  // knows nothing about the blocklist.
  if (blocked.length) {
    lines.push(`${paint.dim('Blocked'.padEnd(12))} ${paint.red(blocked.join(', '))}`);
  }
  if (status.sessions) {
    lines.push(`${paint.dim('Sessions'.padEnd(12))} ${formatSessions(status.sessions, paint)}`);
  }
  lines.push(`${paint.dim('Probe'.padEnd(12))} ${formatProbeSummary(probe, now, paint)}`);
  if (warm.enabled) {
    lines.push(`${paint.dim('Keep-warm'.padEnd(12))} ${formatProbeSummary(warm, now, paint)}`);
  }
  if (status.server?.startedAt || status.server?.uptimeSeconds != null) {
    lines.push(`${paint.dim('Server'.padEnd(12))} ${formatServerSummary(status.server, now)}`);
  }
  lines.push('');

  for (const line of decisionLines(decision, status, blocked, paint)) lines.push(line);

  for (const line of routingLines(status.routes, blocked, paint, status.routing)) lines.push(line);

  for (const account of accounts) {
    lines.push(renderAccountHeader(account, status.currentAccount, paint, now));
    for (const quotaLine of quotaLines(account, now, paint)) {
      lines.push(`  ${quotaLine}`);
    }
    const routing = modelRoutingLine(account, status.switchThreshold, blocked, now, paint);
    if (routing) lines.push(`  ${routing}`);
    lines.push(`  ${paint.dim('Usage'.padEnd(8))} ${formatUsage(account.usage, now)}`);
    lines.push(`  ${paint.dim('Probe'.padEnd(8))} ${formatAccountProbe(account.name, probe, now, paint)}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function colors(enabled) {
  const wrap = code => value => enabled ? `${ESC}${code}m${value}${RESET}` : String(value);
  return {
    rgb: (r, g, b, value) => enabled ? `${ESC}38;2;${r};${g};${b}m${value}${RESET}` : String(value),
    bold: wrap(1),
    dim: wrap(2),
    gray: wrap(90),
    green: wrap(32),
    yellow: wrap(33),
    red: wrap(31),
    blue: wrap(34),
    magenta: wrap(35),
    cyan: wrap(36),
  };
}

// Paint a route's name/globs in its configured color, defaulting to cyan.
const ROUTE_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
function paintRoute(paint, color, value) {
  const fn = ROUTE_COLORS.includes(String(color || '').toLowerCase()) ? paint[color.toLowerCase()] : paint.cyan;
  return fn(value);
}

/**
 * The scope whose decision the compact block reports.
 *
 * `routing[]` carries one entry per scope and the block is one block, so one
 * has to be chosen and the choice has to be stated rather than fall out of an
 * array index. A route scope is preferred over `shared` because it is the more
 * specific answer: its band ranks on the family's own weekly window, which is
 * the figure a reader chasing a family's routing is after. Among routes the
 * first is taken, and the block names the ones it is not showing.
 *
 * A scope whose band decided nothing is not preferred over one that did: there
 * is no reason to show a passthrough route while a sized shared scope has a
 * ladder to publish.
 */
function chooseScope(routing, blocked) {
  const entries = Array.isArray(routing) ? routing : [];
  if (!entries.length) return null;
  const speaks = e => e.band.kind !== 'passthrough' && scopeState(e, blocked) !== 'blocked';
  // A scope the blocklist only reaches PART of still carries traffic, so it can
  // win the block — but never over one it does not reach at all, since the
  // clear scope's destination is the answer for every request in it.
  const clear = e => scopeState(e, blocked) === 'clear';
  return entries.find(e => e.scope === 'route' && speaks(e) && clear(e))
    ?? entries.find(e => e.scope === 'route' && speaks(e))
    ?? entries.find(speaks)
    ?? entries.find(e => e.scope === 'shared')
    ?? entries.find(e => scopeState(e, blocked) !== 'blocked')
    ?? entries[0];
}

/**
 * What the blocklist does to this scope: `blocked`, `partial` or `clear`.
 *
 * The blocklist is answered at the server with a 400 (`server.js:668`), so a
 * blocked family never reaches routing at all. `routing[]` still computes a band
 * for it — the report is about the fleet, and the fleet's quota is real — but a
 * scope nothing can be routed to must not win the compact block, or the block
 * answers "where does the next request go" for traffic that gets a 400, and does
 * it on the same screen as the `Blocked` row saying so.
 *
 * Answered by `blockedState`, which is also what the Routing line and the
 * per-account Models row ask. They used to ask three different questions and
 * disagree out loud: a concrete `claude-fable-4` rendered a live Fable decision
 * above a Routing line calling that route blocked and a Models row calling the
 * family blocked.
 *
 * The shared scope has no model and so is never blocked, which is what makes it
 * a safe fallback.
 */
function scopeState(entry, blocked) {
  if (entry.model == null) return 'clear';
  return blockedState(blocked, { models: [entry.model], globs: entry.match || [] });
}

/**
 * The one-row form, for a decision that ranked nothing.
 *
 * Each passthrough reason gets its own words because they are different states:
 * a feature that is off, a fleet with one account, a fleet with none, and a
 * fleet nobody has reported a quota window for yet. `single-candidate` covers
 * the last two — `decideBand` guards `accounts.length <= 1`, so an EMPTY
 * candidate set arrives here too, and a caption that assumed one candidate
 * would assert an eligible account on a fully throttled fleet, which is the
 * state where the operator most needs the truth.
 *
 * TWO RULES ARE OFF ON THE STOCK FLEET, not one. Expiry routing is off by
 * default and so is session distribution, and this row spoke only about the
 * first: it opened with `load-ranked` on the DEFAULT configuration, where a new
 * session follows the current account and nothing is ranked by load at all. The
 * expanded block already says `distribution off; not load-ranked`, so the
 * collapsed form was the one place the screen contradicted itself — and it is
 * the form the stock fleet always gets.
 */
function selectionSummary(entry, distributing) {
  const n = entry.band.candidates;
  const ranking = distributing ? 'load-ranked' : 'distribution off; not load-ranked';
  switch (entry.band.reason) {
    case 'disabled':
      return `${ranking} · expiry routing off · ${n} account${n === 1 ? '' : 's'} eligible`;
    case 'no-known-pressure':
      return `${ranking} · no quota window reported yet · ${n} eligible`;
    // NOT A RANKING STATE AT ALL. This scope is named for an id a route ahead
    // of it takes, so no per-account figures were computed for it — and saying
    // "0 eligible" about that would report an empty fleet rather than an
    // unasked question. The count is deliberately absent from the sentence.
    case 'representative-captured':
      return 'no figures: an earlier route takes the id this scope is named for';
    case 'single-candidate':
      if (n > 0) return 'one eligible account; nothing to choose between';
      // NOTHING ELIGIBLE IS NOT NOTHING SERVED. With every account barred, a
      // request does not fail — the last resort reopens whichever one's window
      // has already passed, and `target` names it. This line said nothing was
      // eligible two rows under `Active spent`, on a fleet where every request
      // was being served by `spent`. The preview learned to name that
      // destination this round; the one-row collapse never read it, so the
      // round made a true line false.
      return entry.target
        ? `nothing under the threshold; the next request reopens ${entry.target}`
        : 'no eligible account right now';
    default:
      return `${ranking} · ${n} eligible`;
  }
}

/**
 * The rule the band is running, in one sentence.
 *
 * Exported because the caption is graded against the decision it describes, by
 * the suite and by the branch's own caption gate: the sentence that prints and
 * the sentence that is checked have to be the same object, or what is checked
 * is a caption nobody sees.
 *
 * The three `banded` reasons share a caption because the rule that is RUNNING
 * is the same ratio rule in all three; only the reason it is running differs,
 * and that belongs in the `Band` row where the state is reported.
 *
 * The coverage figure is interpolated from the decision rather than written
 * into the sentence, so it cannot go stale against a reconfigured target.
 *
 * NOUNS: the ordering numerator is unspent weekly quota, and `headroom` is
 * reserved for the five-hour bucket, which is what `headroomOf`, the ladder's
 * headroom column and `--json` all mean by the word. Calling the weekly
 * numerator headroom would send a reader who learned the word here to the wrong
 * bucket in the payload.
 */
export function ruleCaption(band) {
  switch (band.kind) {
    case 'sized':
      return 'within the best priority tier, most unspent weekly quota per hour '
        + `before it resets goes first, until ${formatTarget(band.target)} accounts `
        + 'of 5h headroom are covered; accounts missing either measurement are '
        + 'admitted regardless';
    case 'banded':
      return 'within the best priority tier, everything within the tolerance ratio '
        + 'of the best unspent-weekly-per-hour; accounts with no pressure reading '
        + 'are admitted regardless';
    default:
      return null;
  }
}

/** Three decimals wherever a capacity figure appears. `achieved >= coverage` is
 * evaluated raw, so a coarser display can show a target reached while admission
 * continues: 0.4976 + 0.4976 + 0.51 sums to 1.5052 but reads `+0.50 +0.50
 * +0.51` at two decimals, and the reader sees a third account admitted after
 * the target was apparently met. */
function formatCapacity(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
}

/** The configured target, which is a knob rather than a sum. Three decimals
 * exist to stop a rounded TOTAL from contradicting the admission it describes;
 * the target is never summed, so `1.0` reads better than `1.000` and cannot
 * mislead. Trailing zeros past the first are dropped for the same reason. */
function formatTarget(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** Greedy wrap on whitespace. Never splits a word, so a long account name or a
 * bucket key stays greppable in the output. */
function wrapCaption(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** The rank a row prints, or `p-` where the band computed no order: absent
 * pressure under sizing, every row under the ratio rule, every lower-tier row.
 * A number there asserts an ordering that was never performed. */
function rankLabel(row) {
  return row.rank == null ? 'p-' : `p${row.rank}`;
}

/**
 * The compact Decision block: the answer first, then the summary, then the
 * evidence, then the rule.
 *
 * `New session` and `Next request` open it because they are the question
 * `status` is run to ask; the ladder is evidence for them, and the caption is
 * read once and never again.
 *
 * Everything here is read from `routing[]`. The only arithmetic is finding the
 * rank at which the published running total first reached the published target,
 * which is a scan over numbers the decision already emitted rather than a
 * replay of the rule that produced them.
 */
function decisionLines(entry, status, blocked, paint) {
  if (!entry || entry.band.kind === 'passthrough') return [];
  const out = [];
  const { band, pick } = entry;
  const others = (status.routing || []).filter(e => e !== entry);
  // A ROUTE IS NOT AN ANSWER when it spans families: `claude-*` has one entry
  // per family, each with its own bucket, band and destination, and they were
  // rendering as `broad: sized, broad: sized` with nothing to tell them apart —
  // while the header named the glob, which reads as though the destinations
  // below covered all of it. Threading the route fixed which route an entry
  // answers for; this is the other axis, aggregation WITHIN one route, and it
  // needs the family said out loud. Silent when the route has one entry, so the
  // qualifier means "there are others" rather than becoming decoration.
  const scopeName = (e) => {
    const base = e.route || 'shared';
    if (!e.route) return base;
    const siblings = (status.routing || []).filter(x => x.route === e.route);
    return siblings.length > 1 ? `${base} (${modelFamily(e.model)})` : base;
  };
  // The scope in the route's own vocabulary, read from the ENTRY rather than
  // looked up in `routes[]` by name. Route names are not unique, and a join by
  // name attached this decision to another route's globs and another route's
  // target. The entry names the single glob its own figures were computed for.
  const scope = entry.scope === 'route' ? entry.match.join(' ') : 'shared weekly';
  const auto = entry.autocreated ? `  ${paint.dim('(auto)')}` : '';
  const family = entry.route && (status.routing || []).filter(x => x.route === entry.route).length > 1
    ? paint.dim(` (${modelFamily(entry.model)})`) : '';
  out.push(`${paint.bold('Decision')}  ${paint.cyan(scope)}${family}${auto}  ${paint.dim(`[${entry.bucket}]`)}`);

  // BOTH DESTINATION ROWS REPORT WHAT THE PATH RETURNS. Neither describes a
  // rule, because a rule stated in the block is a claim the block cannot check:
  // "follows the current account" asserted that new sessions go to an account
  // that was disabled and would never have been served, and it was true of the
  // rule and false of the fleet.
  //
  // `entry.target` is the routing preview for this scope's model — pin, then a
  // still-eligible current account, then priority preemption, then best
  // available. It is what a request arriving now actually meets.
  const term = pick.by === 'first' ? 'no term discriminated' : `by ${pick.by}`;
  const distributing = status.sessions?.distribute !== false;
  // The pick only describes where a new session goes when the session path is
  // the one that runs. It is skipped when distribution is off, and skipped
  // again when a manual route pin is set for this scope — a pin wins over load
  // ranking whether or not distribution is on. In both cases the router sends a
  // new session to the same place it sends anything else.
  // A pin that EXISTS is not a pin that ACTED. `setRoutePin` documents pinning a
  // near-quota or throttled account as supported — it acts as a preference and
  // routing falls back to best-available until the pinned account is eligible —
  // so branching on the pin's existence credited a pin that had fallen through,
  // for a destination the ordinary ranking chose. Worse than a wrong label: it
  // replaced the true reason with a false one, so a reader debugging why traffic
  // sits on that account was sent to look at the pin.
  // WHICH PATH RUNS is the question, and it is answered by the pin's EXISTENCE:
  // `_selectRoute:421` skips the session-distribution path whenever a pin is set
  // for this scope, eligible or not. So while any pin is set, a new session goes
  // wherever the router's own order sends it — `entry.target` — and no pick term
  // applies at all.
  //
  // Keying this branch on whether the pin was HONOURED instead was wrong in the
  // other direction: it corrected the reason and broke the destination, naming
  // the load-ranked winner on a fleet where load ranking never ran. Honoured
  // versus fell-through is a property of the REASON, not of the destination.
  const pinHonoured = Boolean(entry.pinnedTo) && entry.target === entry.pinnedTo;
  if (!distributing || entry.pinnedTo) {
    // Three states, three sentences. A pin that fell through still names itself:
    // the operator set it and is watching for it, and silence reads as no pin.
    let why;
    if (pinHonoured) why = `route pin${distributing ? '' : '; distribution off'}`;
    else if (entry.pinnedTo) {
      why = `pin to ${entry.pinnedTo} is not eligible; the router's own order decided`
        + (distributing ? '' : '; distribution off');
    } else why = 'distribution off; not load-ranked';
    if (entry.target) {
      out.push(`  ${paint.dim('New session'.padEnd(13))}${paint.dim('→')} ${entry.target} `
        + `${paint.dim(`(${why})`)}`);
    } else {
      out.push(`  ${paint.dim('New session'.padEnd(13))}${paint.dim('nothing eligible')}`);
    }
  } else if (pick.kind === 'picked') {
    const tie = pick.tiedWith.length
      ? `first of ${pick.tiedWith.length + 1} tied on every term, config order`
      : term;
    out.push(`  ${paint.dim('New session'.padEnd(13))}${paint.dim('→')} ${pick.account} ${paint.dim(`(${tie})`)}`);
  } else {
    out.push(`  ${paint.dim('New session'.padEnd(13))}${paint.dim('nothing eligible for this scope')}`);
  }

  if (entry.target) {
    const held = band.admitted.includes(entry.target) ? '' : '; not in the admitted set';
    const label = entry.target === status.currentAccount ? 'current' : 'would serve now';
    out.push(`  ${paint.dim('Next request'.padEnd(13))}${paint.dim('→')} ${entry.target} ${paint.dim(`(${label}${held})`)}`);
  } else {
    // A PAYLOAD FROM ANOTHER BUILD CAN REACH HERE; one from this build cannot.
    // Locally the two conditions exclude each other: this block is skipped
    // entirely for a passthrough band, `decideBand` passes through whenever the
    // candidate set is one account or none, and any candidate at all gives the
    // preview a destination — so a rendered block always has a target.
    //
    // The renderer does not only render local payloads. `tui-remote` and
    // `teamclaude status` fetch them from other hosts, which run their own patch
    // level, and a producer whose band and preview disagree sends exactly this
    // shape. Printing the honest words for it costs a branch; assuming the
    // invariant travels with the JSON costs a screen that names an account the
    // payload does not contain.
    out.push(`  ${paint.dim('Next request'.padEnd(13))}${paint.dim('nothing eligible')}`);
  }
  // The destinations above are the representative's, and on a split family they
  // are not the whole answer. Printed only when it applies, for the reason the
  // ladder's bucket is: an always-present qualifier is a column, and a column
  // is ignored.
  if (entry.familySplit) {
    // Two different facts, said differently: an earlier route taking this very
    // id is not the same as the family being divided among accounts, and a
    // reader acts on them differently.
    const why = entry.familySplit === 'an earlier route'
      ? `answers for ${entry.model}, which an earlier route receives; this route carries the rest`
      : `answers for ${entry.model}; other ids in this scope are claimed by other accounts`;
    out.push(`  ${paint.dim('Scope'.padEnd(13))}${paint.dim(why)}`);
  }

  out.push(`  ${paint.dim('Band'.padEnd(13))}${bandSummary(band)}`);

  // THE LADDER IS A SEQUENCE, so it renders in the order the band walked it.
  // Grouping the admitted rows above the held ones reordered it: an account
  // admitted by the exemption sorts LAST — after coverage was already met — so
  // partitioning lifted it above a row the walk reached first, and the block
  // published an admission order that did not happen. That is the defect this
  // whole phase exists to remove, committed by the renderer on the very field
  // built to prevent it.
  //
  // `Admit` labels the first row of each contiguous run of admissions, so a run
  // interrupted by a held row is labelled again rather than merged with the
  // first. Two `Admit` runs look odd and are true; one merged run reads well and
  // is not.
  const rank = metAtRank(band);
  const coveredAt = !targetMet(band) ? 'not needed'
    : rank == null ? 'not needed; already covered' : `not needed; covered at p${rank}`;
  let previous = null;
  for (const row of band.ladder) {
    const group = row.admitted ? 'Admit' : 'Spare';
    let label = ' '.repeat(13);
    if (group !== previous) {
      label = group.padEnd(13);
      // The held run carries the reason it was not needed, once, where it starts.
      if (group === 'Spare') {
        out.push(`  ${paint.dim(label)}${paint.dim(coveredAt)}`);
        label = ' '.repeat(13);
      }
    }
    out.push(`  ${paint.dim(label)}${ladderRow(row, entry.bucket, paint)}`);
    previous = group;
  }
  if (band.excluded.length) {
    // Accounts the band never saw. Without this row they are absent from both
    // lists and the block silently describes a smaller fleet than the one the
    // reader is looking at.
    const first = band.excluded[0];
    out.push(`  ${paint.dim('Skipped'.padEnd(13))}${excludedRow(first, paint)}`);
    for (const row of band.excluded.slice(1)) out.push(`  ${' '.repeat(13)}${excludedRow(row, paint)}`);
  }
  // Wrapped at the label column rather than left to the terminal, which would
  // break it at whatever column the window happens to be and re-flow the whole
  // block on a resize.
  for (const [i, part] of wrapCaption(ruleCaption(band), 62).entries()) {
    out.push(`  ${paint.dim((i === 0 ? 'Rule' : '').padEnd(13))}${paint.dim(part)}`);
  }
  if (others.length) {
    // A blocked scope reads `blocked`, not its band variant: the variant would
    // describe a decision about traffic the server refuses before selection. A
    // partly blocked one keeps its variant — traffic still flows through it —
    // and says so.
    const names = others.map((e) => {
      const state = scopeState(e, blocked);
      // A split family is disclosed HERE as well as in the block, because that
      // is where it lands: claims that split a family leave its entry with one
      // candidate, so the entry collapses to passthrough and never wins the
      // block. Disclosing it only there would disclose it exactly never.
      const split = e.familySplit ? `, split by ${e.familySplit}` : '';
      if (state === 'blocked') return `${scopeName(e)}: blocked${split}`;
      // A SUPPRESSED SCOPE IS NOT A BAND VARIANT. Its band reads `passthrough`
      // because there was nothing to rank, and printing that word here would
      // describe a decision this scope never made. It has one fact worth the
      // line: nobody computed figures for it, because the id it is named for
      // belongs to a route ahead of it.
      if (e.figuresAbsent === 'representative-captured') {
        return `${scopeName(e)}: no figures, an earlier route takes its id`;
      }
      return `${scopeName(e)}: ${e.band.kind}${state === 'partial' ? ', partly blocked' : ''}${split}`;
    }).join(', ');
    out.push(`  ${paint.dim('Other scopes'.padEnd(13))}${paint.dim(names)}`);
  }
  out.push('');
  return out;
}

/** `sized · 1.837x the 1.000 target · met at p2 · 2 of 4 candidates`. The `x`
 * is load-bearing: `1.837 of 1.0` implies a portion, and 1.837 is not a portion
 * of 1.0, so the phrase reads as the same N-of-M alarm the figure is not. */
function bandSummary(band) {
  const of = `${band.admitted.length} of ${band.candidates} candidate${band.candidates === 1 ? '' : 's'}`;
  if (band.kind === 'sized') {
    const rank = metAtRank(band);
    // `met at p-` rather than a fabricated ordinal or a bare "met": `p-` is the
    // ladder's own token for a row the band did not order, so it points at the
    // row that carried the total across instead of naming a rank that is not
    // there.
    const where = !targetMet(band) ? ' · target not met'
      : rank == null ? ' · met at p-' : ` · met at p${rank}`;
    return `sized · ${formatCapacity(band.achieved)}x the ${formatTarget(band.target)} target${where} · ${of}`;
  }
  return `ratio rule · floor ${band.floor.toExponential(3)} · ${of} (${band.reason})`;
}

/**
 * WHETHER the admitted set reached the target: a state, read from the two
 * figures the decision published.
 *
 * Kept separate from the rank below because they are different questions with
 * different domains. Deriving the state from the rank overloaded null with two
 * meanings — *never reached* and *reached on a row that has no rank* — and the
 * second is ordinary: an absent-pressure row is admitted by the exemption, the
 * sort could not order it, so its rank is legitimately null while its
 * cumulative is what carried the total past the target. Reading that as "not
 * met" printed `1.200x the 1.0 target · target not met` — the evidence and its
 * denial seven words apart on one line.
 */
function targetMet(band) {
  return band.kind === 'sized' && band.target != null && band.achieved != null
    && band.achieved >= band.target;
}

/**
 * WHICH rank crossed the target, or null when the crossing row had none.
 *
 * Null here means "no ordinal to point at" and never "not reached" — that is
 * `targetMet`'s question, asked and answered before this one is. A scan over
 * emitted numbers, not a replay of the admission loop that emitted them.
 */
function metAtRank(band) {
  if (!targetMet(band)) return null;
  for (const row of band.ladder) {
    if (row.cumulative != null && row.cumulative >= band.target) return row.rank;
  }
  return null;
}

/** `p1  +0.959  name`, or a bare figure where measured capacity was not added,
 * or a word where there was no measurement to add. */
function ladderRow(row, scopeBucket, paint) {
  const rank = rankLabel(row).padEnd(4);
  let capacity;
  // `+` means THIS ROW'S HEADROOM IS IN `achieved`, which is exactly the rows
  // whose `cumulative` is non-null: the walk passed through them and moved the
  // running total. Keying it on `admitted` instead printed a contribution for
  // rows the coverage sum never included — a lower-tier account, appended
  // wholesale and never ranked, showed `+0.745` on a fleet whose `achieved` was
  // 1.796, so the three printed contributions summed to 2.541. Under the ratio
  // rule there is no coverage total at all, so no row contributes there either.
  const contributed = row.cumulative != null && row.headroom.kind === 'known';
  if (row.headroom.kind === 'absent') capacity = paint.dim('exempt'.padEnd(7));
  else if (contributed) capacity = `+${formatCapacity(row.headroom.value)}`.padEnd(7);
  else capacity = ` ${formatCapacity(row.headroom.value)}`.padEnd(7);
  const note = row.pressure.kind === 'absent' ? paint.dim(`  (${row.pressure.reason})`) : '';
  // THE WINDOW THIS ROW'S FIGURE CAME FROM, when it is not the one the block's
  // header names. An account that does not meter the scope's family is measured
  // on the shared weekly instead — `_routingReport` publishes that per row for
  // exactly this reason — and without it a reader sees an ordinary rank under
  // `[unified7dFable]` and concludes the account has a Fable reading. It does
  // not. Silent when the buckets match, so the annotation means "this one is
  // different" rather than becoming a column.
  //
  // The `Skipped` rows below already name their bucket, and for the same
  // reason: a bucket and a figure from different windows on one line. This is
  // the row type that never got that fix.
  const bucket = row.bucket && scopeBucket && row.bucket !== scopeBucket
    ? paint.dim(`  ${row.bucket}`) : '';
  return `${paint.dim(rank)}${capacity} ${row.account}${bucket}${note}`;
}

/** An account the band never saw, and the measurement that removed it. */
function excludedRow(row, paint) {
  const detail = typeof row.detail === 'number' && row.bucket
    ? ` ${row.bucket} ${formatCapacity(row.detail)}`
    : '';
  // padEnd, not a fixed slice: the longest reason is wider than the column, and
  // truncating it would run the code into the account name.
  return `${paint.dim(`${row.reason} `.padEnd(20))}${row.account}${paint.dim(detail)}`;
}

// The routing table: one line per route (configured first, then auto-detected),
// listing the model globs it matches and the accounts it can use, each colored
// by live eligibility. Auto-created routes (a family metered separately with no
// configured route) are tagged (auto); a bucket override shows in [brackets].
// THIS LINE RENDERS IN THE DEFAULT CONFIGURATION, which is why the withdrawal
// has to reach it. With expiry routing off every scope is passthrough, the
// Decision block collapses to its one-row form, and the `Other scopes` line
// that carries the suppression notice is never emitted — so the only thing on
// screen about a suppressed route was this table, listing accounts that were
// graded for an id the route does not receive. The payload withdrew the claim
// and the default screen went on making it.
//
// THE JOIN, and its limit stated rather than assumed. A `routing[]` entry names
// its route and carries the single glob it was built from; a `routes[]` entry
// carries all of them. Matching on the name ALONE is the trap this codebase
// keeps flagging — route names are not unique — so the glob has to agree too.
// Two routes sharing BOTH a name and a glob are still indistinguishable here;
// that is a narrower ambiguity than the one it replaces, and it is the most a
// consumer of this payload can do without an id on the entries.
function suppressedScopesFor(route, routeIndex, routing) {
  if (!Array.isArray(routing)) return { matched: false, any: false, all: false, published: [] };
  // THE JOIN IS BY POSITION, WHICH IS INJECTIVE. `(name, glob)` was not: route
  // names are not unique, so a later route sharing a name and a glob with an
  // earlier one imported the earlier one's entry — which both named an owner
  // for traffic this route cannot send AND dropped the account that actually
  // serves it. The comment that used to sit here called that an
  // indistinguishability and disclosed it as a limit; it is an INVERSION, which
  // is the class this round exists to close, so it is fixed rather than
  // disclosed.
  //
  // The mode is chosen ONCE PER PAYLOAD rather than per entry, because a
  // half-indexed payload is not a thing the producer emits and joining some
  // entries one way and some another would be a third behaviour nobody tested.
  const indexed = routing.some(e => e && e.scope === 'route' && Number.isInteger(e.routeIndex));
  const mine = indexed
    ? routing.filter(e => e && e.scope === 'route' && e.routeIndex === routeIndex)
    // LEGACY, and it is the non-injective join: kept only so a payload produced
    // before `routeIndex` existed still renders. It carries the collision above.
    // A payload from this version always takes the branch overhead.
    : routing.filter(e => e && e.scope === 'route' && e.route === route.name
      && Array.isArray(e.match) && (route.match || []).includes(e.match[0]));
  if (!mine.length) return { matched: false, any: false, all: false, published: [] };
  const hit = mine.filter(e => e.figuresAbsent === 'representative-captured');
  return {
    // Whether this route has per-scope figures AT ALL. It is what decides where
    // the route line's names come from, and it is deliberately not the same
    // question as `any`: a route with nothing suppressed still has published
    // scopes whose admissions are the only per-account figures anyone computed.
    matched: true,
    any: hit.length > 0,
    all: hit.length === mine.length,
    // The scopes that DID publish. A route with two globs can have one scope
    // suppressed and one measured, and the measured one's account lists are the
    // only per-account figures on this route anybody computed.
    published: mine.filter(e => e.figuresAbsent == null),
  };
}

/**
 * Account names for a route from the scopes that PUBLISHED figures.
 *
 * This is the route line's ONE naming rule, and it applies whenever the route
 * has routing entries at all — not only when some of them were suppressed.
 * It was gated on partial suppression once, and that gate WAS the defect: with
 * nothing captured the line fell through to `routes[].accounts`, which is
 * graded by `getRoutes` against the route's stripped sample — an id no claim
 * matches — so every account came back eligible and the line named accounts
 * every measured scope of the same route excluded. Fixing that for the mixed
 * case and leaving the all-published case is how this codebase produced the
 * same defect five times: the rule has to be the rule, not a branch.
 *
 * UNION SEMANTICS, stated because the scopes can disagree: an account admitted
 * by AT LEAST ONE published scope is named; an account excluded by ALL of them
 * is not named at all — not even in red. Disagreement resolves toward naming,
 * because the route really can send that account traffic for the scope that
 * admits it.
 *
 * The red spelling elsewhere means "this route lists it and it is not eligible
 * right now", a statement `routes[].accounts` can make because it is the
 * route's configured list. Here there is no such list to draw on: the names are
 * synthesised from measured scopes, so an account those scopes all exclude has
 * no positive claim on this route and printing it puts an owner on screen for
 * traffic the route cannot send it.
 *
 * Returns null when NO scope published, which the caller must not paint from
 * `routes[].accounts` — see its comment.
 */
/**
 * WHERE A ROUTE'S ACCOUNT NAMES COME FROM — the decision, separated from the
 * painting so that every surface answers it the same way.
 *
 * It exists because the round fixed this rule in `status-renderer.js` and left
 * `tui.js` reading `getRoutes().accounts` — the stripped-sample view — so the
 * payload withdrew a claim and a second screen went on making it. That is the
 * pass-13 P2 shape in a different file, and a rule that lives in one renderer
 * is a rule the next renderer does not have.
 *
 * Returns one of:
 *   { source: 'scopes',        admitted: Set }  names come from the union of
 *                                               published, unblocked scopes
 *   { source: 'route-accounts' }                no routing entries for this
 *                                               route: its CONFIGURED list is
 *                                               the only account information
 *                                               and naming from it is right
 *   { source: 'none', reason }                  nothing may be named:
 *                                               'captured' | 'blocked' | 'unmeasured'
 *
 * `routeIndex` is the join key and it must be this route's position in the same
 * `routes` array the payload's `routeIndex` counts against.
 */
export function routeNaming(route, routeIndex, routing, blocked = []) {
  const suppressed = suppressedScopesFor(route, routeIndex, routing);
  if (!suppressed.matched) {
    // NO ENTRIES IS TWO DIFFERENT FACTS, and collapsing them painted a dead
    // route from the configured list. SCOPELESS means no routing derivation
    // exists to consult — the legacy wire shape, or a route with no globs — and
    // there `routes[].accounts` is the operator's own configured list and is
    // the right thing to name. COVERAGE-DEAD means the derivation exists, this
    // route HAS globs, and it produced no entry at all: every id it is named
    // for is taken by an earlier route, so it can receive nothing. Naming
    // owners there offers accounts for traffic that can never arrive.
    //
    // This EXTENDS the honest-empty form rather than adding a regime: it is the
    // same "name nobody, say why" the captured and blocked cases already use.
    const derivable = Array.isArray(routing)
      && routing.some(e => e && e.scope === 'route');
    if (derivable && (route.match || []).length) {
      return { source: 'none', reason: 'coverage-dead' };
    }
    return { source: 'route-accounts' };
  }
  if (suppressed.all) return { source: 'none', reason: 'captured' };
  const liveScopes = (suppressed.published || []).filter(e =>
    blockedState(blocked, { models: [e.model], globs: e.match || [] }) !== 'blocked');
  if (!liveScopes.length) {
    return { source: 'none', reason: suppressed.published.length ? 'blocked' : 'unmeasured' };
  }
  // WHICH FIELD ANSWERS "WHO CAN SERVE THIS ROUTE", chosen by measurement
  // rather than by the field's name — and `band.admitted` alone is the WRONG
  // answer, which is the direction-trade this rewrite came within one commit of
  // shipping.
  //
  // A band SIZES. `candidates` counts the field, `admitted` is the subset kept
  // to meet the coverage target, `excluded` holds accounts that genuinely
  // cannot serve, and `ladder` is the candidate field itself. An account can be
  // in the ladder, able to serve, and NOT admitted — it is SPARE
  // (`reason: 'coverage-met'`). Naming only `admitted` drops it: measured, the
  // route line went from `→ a b c` to `→ a b` on a fleet where `c` can serve.
  // That is f45431a's failure — trading a direction instead of adding one —
  // pointed at a renderer, and it would have spread from a few routes to every
  // route the moment this rule stopped being gated on partial suppression.
  //
  // The two regimes need one rule, so it UNIONS rather than choosing:
  //   passthrough  ladder is EMPTY and `admitted` is the can-serve set
  //   sized        ladder is the candidate field and is a superset of `admitted`
  // Per scope, an account that scope EXCLUDES is dropped — excluded accounts do
  // not appear in the ladder today, but subtracting them is asked rather than
  // assumed. Across scopes the union then does the right thing on its own: an
  // account one scope excludes and another admits is still named, because it
  // really can take that other scope's traffic.
  const admitted = new Set();
  for (const entry of liveScopes) {
    const band = entry.band || {};
    const cannot = new Set((band.excluded || []).map(x => x.account));
    for (const name of band.admitted || []) if (!cannot.has(name)) admitted.add(name);
    for (const row of band.ladder || []) if (!cannot.has(row.account)) admitted.add(row.account);
  }
  // WHAT `admitted` MEANS, and the sentence the last cycle needed and did not
  // have: it is the accounts that can serve THE ENTRY'S OWN `model` — the
  // representative id the scope was graded on — sized by the band. It is NOT
  // "the accounts that can serve this route", and the two come apart exactly
  // when the route's glob reaches ids beyond the representative AND claims
  // discriminate among them. `familySplit` is the payload's own flag that this
  // has happened: the entry says out loud that the family is split and its
  // figures do not generalise to the rest of it.
  //
  // So a route whose measured basis is a PROPER SUBSET of what it can receive
  // may not present its names as the whole answer. Measured: an account owning
  // the representative and another owning only a sibling gave `→ fiveOwner`
  // while `claude-fable-4` reached the same route and `fourOwner` served it —
  // a set that excludes a known server while appearing complete.
  //
  // THE MARKER, NOT A WIDER SET, and the reason is this round's own defect
  // class. Naming the sibling's owner would mean deciding from here which
  // accounts can serve ids no entry was graded on — a display deriving
  // eligibility independently of the thing that decides it, which is the class
  // this round has now found seven times. Publishing that guess would be worse
  // than disclosing the gap. The names stay exactly the measured-admitted set;
  // the line stops claiming to be complete. Closing it properly means grading
  // the entry on the ids the route RECEIVES, which is round 4a item 1.
  const basisGap = liveScopes.map(e => e.familySplit).find(Boolean) || null;
  return { source: 'scopes', admitted, partial: suppressed.any, basisGap };
}

function scopeAccountNames(admitted, paint) {
  return admitted.size
    ? [...admitted].map(name => paint.green(name)).join(' ')
    : paint.gray('(none)');
}

function routingLines(routes, blocked, paint, routing) {
  if (!Array.isArray(routes) || routes.length === 0) return [];
  const lines = [paint.bold('Routing')];
  // The index is the join key, so it is carried rather than recomputed: this is
  // the same array the payload's `routeIndex` counts against.
  for (const [routeIndex, route] of routes.entries()) {
    const globs = route.match || [];
    const match = globs.join(', ');
    const suppressed = suppressedScopesFor(route, routeIndex, routing);
    // WHERE THE NAMES COME FROM is decided by `routeNaming`, not here, so that
    // this line and the TUI's route glyphs cannot answer it differently. The
    // round fixed the rule in this file and left tui.js reading the
    // sample-graded list, which is how one payload ended up with two screens
    // disagreeing about the same route.
    const naming = routeNaming(route, routeIndex, routing, blocked);
    // A route every one of whose models is blocked can carry no traffic at all —
    // say so, rather than listing eligible accounts it will never reach. Asked
    // of `blockedState`, the same classification the Decision block and the
    // Models row use, so this line cannot call a route dead while the block
    // above it reports where that route's next request goes.
    const state = globs.length
      ? blockedState(blocked, { models: globs.flatMap(modelsForGlob), globs })
      : 'clear';
    // A SUPPRESSED SCOPE HAS NO ACCOUNTS TO NAME. The eligibility flags on this
    // route were computed for the id its entry is named by, and an earlier route
    // takes that id — so listing them here would name owners for traffic this
    // route never sees. Blocked still wins: a route that can carry nothing at
    // all is the stronger statement, and it is true whichever id was asked
    // about.
    // ONE NAMING RULE, and `matched` is what selects it — NOT the suppression
    // state. If this route has routing entries, its names come from the scopes
    // that published; `routes[].accounts` is the fallback ONLY where no routing
    // entry matches this route at all, because that field answers for the
    // route's STRIPPED SAMPLE and would name accounts the measured scopes
    // exclude. Gating this on partial suppression is what let the all-published
    // case keep painting from the sample after the mixed case was fixed.
    //
    // WHICH ROUTES STILL TAKE THE FALLBACK: those with no matching `routing[]`
    // entry — an autocreated route (its scope is not a configured route), a
    // route whose globs produced no entry, and any caller rendering a payload
    // with no `routing` array at all (the pre-suppression wire shape). For
    // those, `routes[].accounts` is the only account information in the payload
    // and it is the route's own configured list, so naming from it is right.
    // AND ONLY SCOPES THE BLOCKLIST HAS NOT KILLED. A published scope whose own
    // model is blocked carries nothing, so an account admitted solely there is
    // an owner offered for traffic this route cannot send it — the same
    // sentence this round already used to reject naming from the stripped
    // sample. The `(partly blocked)` tag beside such a name does not save it:
    // "the caveat beside it did not save it" is the rule, not a spelling.
    // Asked of `blockedState` per scope, the same classification the Decision
    // block asks per entry, so the line cannot call a scope live while the
    // block above it calls that scope blocked.
    const fromScopes = naming.source === 'scopes'
      ? scopeAccountNames(naming.admitted, paint) : null;
    const fromRoute = (route.accounts || [])
      .map(a => (a.eligible ? paint.green(a.name) : paint.red(a.name))).join(' ')
      || paint.gray('(none)');
    // MATCHED BUT NO LIVE SCOPE TO NAME FROM. Two ways to reach it, and the
    // line says which, because "nobody measured this" and "everything measured
    // is blocked" are different facts about the route.
    //
    // THIS MUST NOT FALL THROUGH TO `fromRoute`, which is why it is a branch
    // rather than a `||`: with no live scope, `scopeAccountNames` returns null,
    // and without this the blocklist filter above would hand the line straight
    // back to the stripped-sample painter — reintroducing the defect through
    // the door the fix just closed.
    //
    // Keyed on the SETS, not on `fromScopes === null`. Those coincide here, but
    // deriving one branch's condition from another branch's output makes a
    // neutralisation row mean something other than its label — reverting the
    // gate above would otherwise have fired this message on a fully measured
    // route, so a row named for the gate would have mutated two things.
    //
    // The no-scope-published half is unreachable today: `figuresAbsent` is
    // exactly 'representative-captured' or null, so captured ∪ published =
    // matched. It is written anyway because it is the branch that would
    // SILENTLY restore the defect the moment a second withheld-reason string is
    // added.
    const noneMeasured = naming.source !== 'none' || naming.reason === 'captured' ? null
      : naming.reason === 'blocked'
        ? paint.gray('no figures: every measured scope of this route is blocked')
        : naming.reason === 'coverage-dead'
          ? paint.gray('an earlier route takes every id this route is named for')
          : paint.gray('no figures for any scope of this route');
    const accounts = state === 'blocked'
      ? paint.red('blocked')
      : suppressed.all
        ? paint.gray('no figures: an earlier route takes the id this route is named for')
        : (noneMeasured || fromScopes || fromRoute);
    // Some but not all: the names above are the measured scopes' own, and the
    // line still says part of this route went unmeasured rather than presenting
    // a partial answer as a whole one.
    const someAbsent = suppressed.any && !suppressed.all && state !== 'blocked'
      ? paint.dim(' (some scopes have no figures)') : '';
    // THE MEASURED BASIS DOES NOT COVER THE ROUTE. The names above are right
    // for the id each scope was graded on, and this route reaches ids those
    // figures do not speak for — so the line says so rather than presenting a
    // representative's answer as the route's. Without it the line named a set
    // that excluded a known server while appearing complete, which is the one
    // thing the naming rule may never do.
    const splitBasis = naming.basisGap && state !== 'blocked'
      ? paint.dim(` (split by ${naming.basisGap}; other ids may go elsewhere)`) : '';
    const partly = state === 'partial' ? paint.dim(' (partly blocked)') : '';
    const tag = route.autocreated ? paint.dim(' (auto)') : route.bucket ? paint.dim(` [${route.bucket}]`) : '';
    const pin = route.pinned ? paint.dim(` [pinned: ${route.pinned}]`) : '';
    // padEnd on the raw text, color after, so ANSI codes don't throw off alignment.
    const label = paintRoute(paint, route.color, match.padEnd(16));
    lines.push(`  ${label} ${paint.dim('→')} ${accounts}${someAbsent}${splitBasis}${partly}${tag}${pin}`);
  }
  lines.push('');
  return lines;
}

function renderAccountHeader(account, currentAccount, paint, now) {
  const current = account.name === currentAccount;
  const marker = current ? paint.cyan('>') : ' ';
  const name = current ? paint.bold(account.name) : account.name;
  const status = formatAccountStatus(account, now, paint);
  const org = account.orgName ? ` ${paint.dim(account.orgName)}` : '';
  const sess = account.sessions ? ` ${paint.dim(`${account.sessions} sess`)}` : '';
  return `${marker} ${name} ${paint.dim(`(${account.type}, prio ${account.priority || 0})`)} ${status}${org}${sess}`;
}

// "2 active / 3 known · distributing" — the running-sessions readout.
function formatSessions(sessions, paint) {
  const active = sessions.active || 0;
  const known = sessions.known || 0;
  const mode = sessions.distribute ? paint.green('distributing') : paint.dim('single-account');
  return `${active} active / ${known} known ${paint.dim('·')} ${mode}`;
}

function formatAccountStatus(account, now, paint) {
  const parts = [];
  if (account.disabled) parts.push(paint.gray('disabled'));

  const status = account.status || 'unknown';
  const colored = status === 'active'
    ? paint.green(status)
    : status === 'throttled'
      ? paint.yellow(status)
      : status === 'error' || status === 'exhausted'
        ? paint.red(status)
        : status;
  parts.push(colored);

  const throttleAt = parseTs(account.rateLimitedUntil);
  if (throttleAt && throttleAt > now) {
    parts.push(`throttle ${formatDuration(throttleAt - now)}`);
  }

  return parts.join(' / ');
}

// Per-account, per-family eligibility — the "some accounts are disabled for
// specific models" view. Only rendered for accounts that meter a family
// separately (a Sonnet or Fable weekly bucket), since that is the only case
// where a request's model changes where it can route. A family reads ✗ when the
// shared 5h bucket is spent (blocks everything) or when the utilization that
// GATES it is over the switch threshold, which is the higher of its own weekly
// bucket and the shared weekly one, since family spend meters into both. The
// reset shown is the family bucket's, so it says when that model becomes
// available again on this account.
//
// That gating value comes from `gatingUtilization`, the same function the router
// gates on, rather than being recomputed here. This row DISPLAYS a routing
// decision, so a second derivation of it is a copy that drifts - and it drifted:
// reading the family bucket alone printed `Fable ✓` on an account the routing
// line three lines above had already marked unavailable, in one render.
function modelRoutingLine(account, threshold, blocked, now, paint) {
  const q = account.quota || {};
  const quota = q;
  if (q.unified7dSonnet == null && q.unified7dFable == null) return null;
  const t = Number(threshold);
  const fiveOver = q.unified5h != null && !Number.isNaN(t) && q.unified5h >= t;

  const cell = (label, bucketKey, reset) => {
    // The blocklist outranks quota: a blocked family cannot be served however
    // much headroom the account has, so it must not read ✓. Reporting quota
    // alone is what made a fully-blocked model look available. Classified by
    // the same `blockedState` the Decision block and the Routing line ask, so a
    // single blocked id cannot read as the whole family here while the block
    // above reports that family's next destination.
    const familyState = blockedState(blocked,
      { models: [familyModel(label)], globs: [`*${label.toLowerCase()}*`] });
    if (familyState === 'blocked') {
      return `${label} ${paint.red('⊘')}${paint.dim(' blocked')}`;
    }
    // The GATE's value, not this bucket's. Family spend meters into the shared
    // weekly too, so an account under its family cap can be over the shared one
    // and unable to serve the family at all. Reading `weekly` alone printed
    // `Fable OK` three lines under a routing line that had just refused it.
    const gating = gatingUtilization(quota, bucketKey);
    const weeklyOver = gating != null && !Number.isNaN(t) && gating >= t;
    const mark = fiveOver || weeklyOver ? paint.red('✗') : paint.green('✓');
    // The recovery time is the LATEST of the buckets currently over the
    // threshold, not this bucket's reset. The gating value is a maximum, so it
    // only falls below the threshold once EVERY blocking bucket has rolled:
    // showing the family reset beside a mark the shared bucket produced told an
    // operator that a week-long block clears tomorrow.
    const over = [];
    if (!Number.isNaN(t)) {
      const own = quota?.[bucketKey];
      if (own != null && own >= t) over.push(parseTs(reset));
      if (bucketKey !== 'unified7d' && quota?.unified7d != null && quota.unified7d >= t) {
        over.push(parseTs(quota.unified7dReset));
      }
    }
    // An unreported reset among the blockers means the recovery time is unknown,
    // and a known-but-earlier one would understate it. Say nothing rather than
    // name a time that is not when this clears.
    const resetTs = over.length && over.every(Boolean) ? Math.max(...over) : null;
    const when = weeklyOver && resetTs && resetTs > now ? paint.dim(` ${formatDuration(resetTs - now)}`) : '';
    // Some of this family's ids are blocked and some are not, so neither ⊘ nor a
    // bare quota mark is the truth. The mark still answers the quota question;
    // the tag answers the blocklist's.
    const partly = familyState === 'partial' ? paint.dim(' partly blocked') : '';
    return `${label} ${mark}${when}${partly}`;
  };

  const cells = [cell('Opus', 'unified7d', q.unified7dReset)];
  if (q.unified7dSonnet != null) cells.push(cell('Sonnet', 'unified7dSonnet', q.unified7dSonnetReset));
  if (q.unified7dFable != null) cells.push(cell('Fable', 'unified7dFable', q.unified7dFableReset));
  return `${paint.dim('Models'.padEnd(8))} ${cells.join('   ')}`;
}

function quotaLines(account, now, paint) {
  const quota = account.quota || {};
  const lines = [];

  if (quota.unified5h != null || quota.unified7d != null || quota.unified7dSonnet != null || quota.unified7dFable != null) {
    lines.push(formatQuotaLine('Session', quota.unified5h, quota.unified5hReset, now, paint));
    lines.push(formatQuotaLine('Weekly', quota.unified7d, quota.unified7dReset, now, paint));
    if (quota.unified7dSonnet != null) {
      lines.push(formatQuotaLine('Sonnet', quota.unified7dSonnet, quota.unified7dSonnetReset, now, paint));
    }
    if (quota.unified7dFable != null) {
      lines.push(formatQuotaLine('Fable', quota.unified7dFable, quota.unified7dFableReset, now, paint));
    }
    return lines;
  }

  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const ratio = 1 - quota.tokensRemaining / quota.tokensLimit;
    lines.push(formatQuotaLine('Tokens', ratio, quota.resetsAt, now, paint));
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const ratio = 1 - quota.requestsRemaining / quota.requestsLimit;
    lines.push(formatQuotaLine('Requests', ratio, quota.resetsAt, now, paint));
  }
  if (lines.length === 0) lines.push(`${paint.dim('Quota'.padEnd(8))} ${paint.gray('unknown')}`);
  return lines;
}

function formatQuotaLine(label, ratio, resetAt, now, paint) {
  const resetTs = parseTs(resetAt);
  const reset = resetTs && resetTs > now ? ` reset ${formatDuration(resetTs - now)}` : '';
  return `${paint.dim(label.padEnd(8))} ${usageBar(ratio, paint)} ${formatPercent(ratio)}${reset}`;
}

function usageBar(ratio, paint) {
  if (ratio == null || Number.isNaN(Number(ratio))) return `[${paint.gray('??????????????????')}]`;
  const width = 18;
  const safeRatio = Math.max(0, Math.min(1, Number(ratio)));
  const full = Math.round(safeRatio * width);
  const fill = Array.from({ length: full }, (_, i) => {
    const [r, g, b] = gradientColor(i, width);
    return paint.rgb(r, g, b, '█');
  }).join('');
  return `[${fill}${paint.gray('░'.repeat(width - full))}]`;
}

function gradientColor(index, width) {
  const t = width <= 1 ? 1 : index / (width - 1);
  const from = t < 0.5 ? [35, 209, 96] : [245, 185, 40];
  const to = t < 0.5 ? [245, 185, 40] : [239, 68, 68];
  const p = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return from.map((value, i) => Math.round(value + (to[i] - value) * p));
}

function formatProbeSummary(probe, now, paint) {
  if (!probe.enabled) return paint.gray('off (passive only)');
  const bits = [`on every ${formatDuration((probe.intervalSeconds || 0) * 1000)}`];
  if (probe.running) bits.push(paint.yellow('running'));
  const last = parseTs(probe.lastRunFinishedAt);
  if (last) bits.push(`last ${formatAgo(last, now)}`);
  const next = parseTs(probe.nextRunAt);
  if (next && next > now) bits.push(`next ${formatDuration(next - now)}`);
  return bits.join(', ');
}

function formatAccountProbe(accountName, probe, now, paint) {
  const row = (probe.accounts || []).find(account => account.name === accountName);
  if (!probe.enabled) return paint.gray('off');
  if (!row) return paint.gray('never');
  if (row.status === 'not-applicable') return paint.gray('not applicable');
  const status = row.status === 'ok'
    ? paint.green('ok')
    : row.status === 'running'
      ? paint.yellow('running')
      : row.status === 'never'
        ? paint.gray('never')
        : paint.red(row.status || 'error');
  const last = parseTs(row.lastProbedAt || row.startedAt);
  const when = last ? ` ${formatAgo(last, now)}` : '';
  const duration = typeof row.durationMs === 'number' ? `, ${Math.round(row.durationMs)}ms` : '';
  const error = row.error ? `, ${safeLine(row.error)}` : '';
  return `${status}${when}${duration}${error}`;
}

function safeLine(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function formatUsage(usage = {}, now) {
  const requests = usage.totalRequests || 0;
  const tokens = (usage.totalInputTokens || 0) + (usage.totalOutputTokens || 0);
  const last = parseTs(usage.lastUsed);
  const lastText = last ? `, last ${formatAgo(last, now)}` : '';
  return `${requests} req, ${formatNumber(tokens)} tok${lastText}`;
}

function formatServerSummary(server, now) {
  if (server.uptimeSeconds != null) return `up ${formatDuration(server.uptimeSeconds * 1000)}`;
  const started = parseTs(server.startedAt);
  return started ? `up ${formatDuration(now - started)}` : 'unknown';
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Math.round(Number(value) * 100)}%`;
}

function formatNumber(value) {
  const num = Number(value) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function formatAgo(timestamp, now) {
  const delta = now - timestamp;
  if (delta < 0) return `in ${formatDuration(-delta)}`;
  return `${formatDuration(delta)} ago`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d${remHours}h` : `${days}d`;
}

function parseTs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
