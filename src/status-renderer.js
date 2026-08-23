import { blockedState, familyModel, modelsForGlob, gatingUtilization } from './model.js';

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
    lines.push(`${paint.dim('Selection'.padEnd(12))} ${selectionSummary(decision)}`);
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

  for (const line of routingLines(status.routes, blocked, paint)) lines.push(line);

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
 */
function selectionSummary(entry) {
  const n = entry.band.candidates;
  switch (entry.band.reason) {
    case 'disabled':
      return `load-ranked · expiry routing off · ${n} account${n === 1 ? '' : 's'} eligible`;
    case 'no-known-pressure':
      return `load-ranked · no quota window reported yet · ${n} eligible`;
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
      return `load-ranked · ${n} eligible`;
  }
}

/**
 * The rule the band is running, in one sentence.
 *
 * Exported because `tools/verify-caption.mjs` grades this exact string against
 * the decision it describes: the sentence that prints and the sentence that is
 * checked have to be the same object, or the gate guards a caption nobody sees.
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
  // The scope in the route's own vocabulary, read from the ENTRY rather than
  // looked up in `routes[]` by name. Route names are not unique, and a join by
  // name attached this decision to another route's globs and another route's
  // target. The entry names the single glob its own figures were computed for.
  const scope = entry.scope === 'route' ? entry.match.join(' ') : 'shared weekly';
  const auto = entry.autocreated ? `  ${paint.dim('(auto)')}` : '';
  out.push(`${paint.bold('Decision')}  ${paint.cyan(scope)}${auto}  ${paint.dim(`[${entry.bucket}]`)}`);

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
    out.push(`  ${paint.dim('Next request'.padEnd(13))}${paint.dim('nothing eligible')}`);
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
    out.push(`  ${paint.dim(label)}${ladderRow(row, paint)}`);
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
      if (state === 'blocked') return `${e.route || 'shared'}: blocked`;
      return `${e.route || 'shared'}: ${e.band.kind}${state === 'partial' ? ', partly blocked' : ''}`;
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
function ladderRow(row, paint) {
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
  return `${paint.dim(rank)}${capacity} ${row.account}${note}`;
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
function routingLines(routes, blocked, paint) {
  if (!Array.isArray(routes) || routes.length === 0) return [];
  const lines = [paint.bold('Routing')];
  for (const route of routes) {
    const globs = route.match || [];
    const match = globs.join(', ');
    // A route every one of whose models is blocked can carry no traffic at all —
    // say so, rather than listing eligible accounts it will never reach. Asked
    // of `blockedState`, the same classification the Decision block and the
    // Models row use, so this line cannot call a route dead while the block
    // above it reports where that route's next request goes.
    const state = globs.length
      ? blockedState(blocked, { models: globs.flatMap(modelsForGlob), globs })
      : 'clear';
    const accounts = state === 'blocked'
      ? paint.red('blocked')
      : (route.accounts || [])
        .map(a => (a.eligible ? paint.green(a.name) : paint.red(a.name))).join(' ') || paint.gray('(none)');
    const partly = state === 'partial' ? paint.dim(' (partly blocked)') : '';
    const tag = route.autocreated ? paint.dim(' (auto)') : route.bucket ? paint.dim(` [${route.bucket}]`) : '';
    const pin = route.pinned ? paint.dim(` [pinned: ${route.pinned}]`) : '';
    // padEnd on the raw text, color after, so ANSI codes don't throw off alignment.
    const label = paintRoute(paint, route.color, match.padEnd(16));
    lines.push(`  ${label} ${paint.dim('→')} ${accounts}${partly}${tag}${pin}`);
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
