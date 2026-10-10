/*
 * The weekly digest, as data. Everything is observed and aggregated: visit counts, snag counts by element, goal
 * conversions, logged changes and the "Did it help?" verdicts that already exist. It never carries visitor details, and
 * under the strict privacy preset it never carries element text, only names derived from the page's own identifiers.
 *
 * The same structure feeds the email, the in-dashboard preview and the `weekly_summary` agent tool, so all three say
 * the same thing. The functions here are pure: the API reads the counts, these functions decide what is said.
 */
import type { ChangeMarker, Goal, GoalKind, GoalStat } from './changes';
import { elementName, sentenceName, type ElementNameSource } from './element-name';
import type { FunnelStats } from './funnels';
import { IMPACT_MIN_VISITS, formatRate, rateSide, type ConversionVerdict } from './impact';
import type { PrivacyPreset } from './index';
import { CHANNEL_LABELS, countryName, isChannel, percentText, topShares, type ShareRow } from './sources';

const DAY_MS = 86_400_000;
export const DIGEST_DAYS = 7;
/** Elements shown under "snag changes". */
export const DIGEST_MAX_ELEMENTS = 3;
/** Example recordings linked for each element. */
export const DIGEST_MAX_EXAMPLES = 2;
/** An element needs at least this many snags in one of the two weeks to be listed, so one stray click is not a change. */
export const DIGEST_MIN_ELEMENT_SNAGS = 3;
/** Below this many visits, a week's rate is shown with a note instead of a comparison. */
export const DIGEST_FEW_VISITS = IMPACT_MIN_VISITS;
/** A no-data note is sent at most once in this many days. */
export const DIGEST_NO_DATA_DAYS = 28;
/**
 * The first UTC day the hosted service counted snags by element. Visits and heatmap cohorts were counted before, so a
 * week that starts earlier has visits and findings but no element snag counts for the days before this one, and an empty
 * list there means "not counted", not "no snags". Days before it only matter to windows that reach back that far, so the
 * note this drives goes quiet on its own about two weeks later.
 */
export const ELEMENT_SNAG_COUNTERS_FROM = '2026-10-06';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const dayStart = (time: number) => Date.parse(utcDay(time));

/* ------------------------------------------------------------ period */

export interface DigestWindow {
  /** First millisecond of the first day and last millisecond of the last day, UTC. */
  from: number;
  to: number;
  /** UTC days, `YYYY-MM-DD`, oldest first. */
  days: string[];
}
export interface DigestPeriod {
  current: DigestWindow;
  previous: DigestWindow;
  /** The last day of the current window, `YYYY-MM-DD`. */
  weekEnding: string;
  /** "Sep 28 to Oct 4, 2026" */
  label: string;
  /** True when the last day is today (UTC), which is still in progress, so the window holds a partial day. */
  includesToday: boolean;
}

const windowEndingAt = (lastDayStart: number): DigestWindow => {
  const first = lastDayStart - (DIGEST_DAYS - 1) * DAY_MS;
  return { from: first, to: lastDayStart + DAY_MS - 1, days: Array.from({ length: DIGEST_DAYS }, (_, index) => utcDay(first + index * DAY_MS)) };
};

const shortDate = (time: number) => new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The seven complete UTC days ending yesterday, and the seven before them. `weekEnding` names another last day, which
 * must be a complete day (before today). The Monday digest therefore covers the Monday to Sunday that just ended.
 * `includeToday` ends the window on today instead, a day still in progress, for a project that is only a few days old
 * or a reader who wants the latest visits; it cannot be combined with `weekEnding`.
 */
export function digestPeriod(now: number, weekEnding?: string, options: { includeToday?: boolean } = {}): DigestPeriod {
  const today = dayStart(now);
  let last = today - DAY_MS;
  if (options.includeToday) {
    if (weekEnding !== undefined) throw new RangeError('includeToday and weekEnding cannot be used together');
    last = today;
  } else if (weekEnding !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnding) || Number.isNaN(Date.parse(weekEnding)) || utcDay(Date.parse(weekEnding)) !== weekEnding) throw new RangeError('weekEnding must be a date such as 2026-10-04');
    last = Date.parse(weekEnding);
    if (last >= today) throw new RangeError('weekEnding must be a complete day before today (UTC)');
  }
  const current = windowEndingAt(last);
  const previous = windowEndingAt(last - DIGEST_DAYS * DAY_MS);
  const year = new Date(current.to).getUTCFullYear();
  return {
    current, previous, weekEnding: utcDay(last), includesToday: last === today,
    label: `${shortDate(current.from)} to ${shortDate(current.to)}, ${year}${last === today ? ' (today so far)' : ''}`,
  };
}

/* --------------------------------------------------------- goal stats */

/** A day's sessions and per-goal conversions, from site-wide counters or from one page group's stats. */
export interface DayCounts { sessions: number; goals: Record<string, number>; automated?: number; /** Sessions by channel id and by ISO country (or `unknown`), when the counters have them. */ channels?: Record<string, number>; countries?: Record<string, number> }

/** A goal's conversions over a period: sessions that converted of sessions, with a 95% Wilson interval. */
export function goalStat(goal: Goal, sessions: number, conversions: number): GoalStat {
  const side = rateSide(sessions, conversions);
  return { goalId: goal.id, name: goal.name, kind: goal.kind, sessions, conversions: side.conversions, rate: side.rate, interval: side.interval, since: goal.since };
}

/**
 * Every goal's conversions over `days`. A goal counts only the days after it began, so a goal added today never shows a
 * rate over days it could not have counted. The day the goal began counts too: a visit later that day is one the goal
 * could see. That day's sessions from before the goal existed are in the denominator, so the first day can only
 * understate the rate.
 */
export function goalStatsOver(goals: readonly Goal[], days: readonly string[], perDay: ReadonlyMap<string, DayCounts>): GoalStat[] {
  return goals.map(goal => {
    const first = new Date(goal.since).toISOString().slice(0, 10);
    let visits = 0;
    let converted = 0;
    for (const day of days) {
      if (day < first) continue;
      visits += perDay.get(day)?.sessions ?? 0;
      converted += perDay.get(day)?.goals[goal.id] ?? 0;
    }
    return goalStat(goal, visits, converted);
  });
}

/* ------------------------------------------------------------- shapes */

export type SnagKind = 'pile-up' | 'no-show' | 'misfire';
const SNAG_WORDS: Record<SnagKind, { one: string; many: string }> = {
  'pile-up': { one: 'Pile-up', many: 'Pile-ups' },
  'no-show': { one: 'No-show', many: 'No-shows' },
  misfire: { one: 'Misfire', many: 'Misfires' },
};

/** One element's snags on one UTC day, from the daily element counters. */
export interface DigestSnagRow { day: string; id: string; selector: string; label?: string; pileUps: number; noShows: number; misfires: number }
export interface SnagCounts { pileUps: number; noShows: number; misfires: number; total: number }

export interface DigestExample {
  recordingId: string;
  /** When the click happened, epoch ms. */
  at: number;
}

export interface DigestElement {
  /** Stable id of the element within the project. */
  id: string;
  selector: string;
  /** Readable name. Under strict this comes from the selector only, never from page text. */
  name: string;
  nameSource: ElementNameSource;
  thisWeek: SnagCounts;
  /** Null when the week before is outside what is kept. */
  lastWeek: SnagCounts | null;
  /** The kind with the most snags this week, or null when no kind leads. */
  leadKind: SnagKind | null;
  /** "No-shows on Request an appointment: 12 this week, 3 last week" */
  text: string;
  /** Up to two recordings that show it this week. Present only when the reader may open recordings and a sampled click exists. */
  examples: DigestExample[];
}

export interface DigestGoal {
  goalId: string;
  name: string;
  kind: GoalKind;
  thisWeek: { visits: number; conversions: number; rate: number | null; interval: [number, number] | null };
  lastWeek: { visits: number; conversions: number; rate: number | null; interval: [number, number] | null } | null;
  /** This week's rate minus last week's, in percentage points. Null when either rate is unknown. */
  differencePoints: number | null;
  /** True when either week has fewer than DIGEST_FEW_VISITS visits, so the comparison is not meaningful. */
  fewVisits: boolean;
  text: string;
}

export interface DigestChange {
  id: string;
  at: number;
  title: string;
  pageGroup?: string;
  /** Present for changes Hoot Lens detected itself. */
  detected: boolean;
}
/** A "Did it help?" verdict that became available since the last digest. The text is the impact report's own wording. */
export interface DigestVerdict {
  changeId: string;
  title: string;
  /** The impact report's own summary: the verdict wording and both visit counts, without the caveat in VERDICT_CAVEAT, which is stated once per section. */
  summary: string;
  /** The lead goal's verdict kind in the report. */
  kind: ConversionVerdict['kind'];
}
/** What every "Did it help?" result is: said once where results are listed, not on each. */
export const VERDICT_CAVEAT = 'Before and after, not an A/B test.';

export interface DigestFunnel {
  funnelId: string;
  name: string;
  /** Sessions that reached the first step, and the last. */
  entered: number;
  completed: number;
  completionRate: number | null;
  /** The step-to-step loss that lost the most sessions. Absent when nobody dropped. */
  largestDrop?: { from: string; to: string; lost: number; of: number };
  fewVisits: boolean;
  lastWeek: { entered: number; completed: number; completionRate: number | null } | null;
  text: string;
}

/** The week's largest channels and countries, as shares of its visits. */
export interface DigestSources {
  channels: ShareRow[]; countries: ShareRow[];
  /** Share of visits whose country was not resolved, when large enough to matter. */
  unknownCountryShare?: number;
  /** One factual sentence, or empty when the counters held nothing. */
  text: string;
}

export type WatchKind = 'goal-fall' | 'new-snags' | 'automated-share' | 'none';
export interface DigestWatch { kind: WatchKind; text: string }

export interface WeeklyDigest {
  projectId: string;
  projectName: string;
  generatedAt: number;
  period: { from: number; to: number; weekEnding: string; label: string; previousFrom: number; previousTo: number; /** The last day is today and still in progress. */ includesToday: boolean };
  /** The privacy preset in force. Under strict, element names never come from page text. */
  privacy: PrivacyPreset;
  /** True when there were no recorded visits this week. The other sections are then empty. */
  noData: boolean;
  visits: {
    thisWeek: number;
    lastWeek: number | null;
    /** Percent change from last week, or null when last week has too few visits to say. */
    changePercent: number | null;
    automated: { thisWeek: number; lastWeek: number | null };
    /** Automated visits as a share of all visits (human plus automated) this week. Null with none. */
    automatedShare: number | null;
    fewVisits: boolean;
    /** Visits recorded today (UTC, still in progress) that fall after this window. Present only when the caller asked and there were some. */
    afterWindow?: number;
    text: string;
  };
  snags: {
    elements: DigestElement[]; totalThisWeek: number; totalLastWeek: number | null; text: string;
    /** Present when some days of the two weeks have visits but no element snag counters, because counting started on this UTC day (`YYYY-MM-DD`). */
    countedFrom?: string;
  };
  /** Where visits came from. Empty on days counted before sources were. */
  sources: DigestSources;
  goals: DigestGoal[];
  changes: { logged: DigestChange[]; verdicts: DigestVerdict[]; /** Present when there are verdicts. */ verdictNote?: string };
  funnels: DigestFunnel[];
  watch: DigestWatch;
  /** What the numbers cannot say. Always present. */
  notes: string[];
}

export const DIGEST_NOTES: readonly string[] = [
  'Counts are observed in recorded visits. Automated visits are left out of every count except the automated share.',
  'A week with few visits can swing on a handful of them, so small comparisons are marked and not read as a trend.',
];

/* ------------------------------------------------------------ helpers */

const total = (counts: { pileUps: number; noShows: number; misfires: number }): SnagCounts => ({ ...counts, total: counts.pileUps + counts.noShows + counts.misfires });
const emptyCounts = (): SnagCounts => total({ pileUps: 0, noShows: 0, misfires: 0 });

function leadOf(counts: SnagCounts): SnagKind | null {
  const entries: [SnagKind, number][] = [['pile-up', counts.pileUps], ['no-show', counts.noShows], ['misfire', counts.misfires]];
  const present = entries.filter(([, value]) => value > 0);
  return present.length === 1 ? present[0]![0] : null;
}

function snagBreakdown(counts: SnagCounts): string {
  const parts: string[] = [];
  if (counts.pileUps) parts.push(plural(counts.pileUps, 'pile-up'));
  if (counts.noShows) parts.push(plural(counts.noShows, 'no-show'));
  if (counts.misfires) parts.push(plural(counts.misfires, 'misfire'));
  return parts.join(', ');
}

/** "No-shows on Request an appointment: 12 this week, 3 last week". With mixed kinds: "Snags on X: 12 this week (9 no-shows, 3 misfires), 3 last week". */
export function snagSentence(name: string, thisWeek: SnagCounts, lastWeek: SnagCounts | null): string {
  const lead = leadOf(thisWeek);
  const subject = lead ? SNAG_WORDS[lead].many : 'Snags';
  const detail = lead || thisWeek.total === 0 ? '' : ` (${snagBreakdown(thisWeek)})`;
  const before = lastWeek === null ? 'no earlier week to compare' : `${lastWeek.total.toLocaleString('en-US')} last week`;
  return `${subject} on ${name}: ${thisWeek.total.toLocaleString('en-US')} this week${detail}, ${before}`;
}

/* ------------------------------------------------------------ builder */

export interface DigestFunnelInput { current: FunnelStats; previous?: FunnelStats | undefined }

export interface DigestInput {
  project: { id: string; name: string; preset: PrivacyPreset };
  now: number;
  period: DigestPeriod;
  /** Whether the week before is still inside what the project keeps. */
  previousAvailable: boolean;
  /** Per UTC day counters covering both windows. */
  perDay: ReadonlyMap<string, DayCounts>;
  /** Human visits so far today, when today falls after the window and the caller wants them noted. */
  afterWindow?: number;
  goals: readonly Goal[];
  snags: readonly DigestSnagRow[];
  /** Names the team gave elements, by selector. They win over page-derived names under every preset. */
  elementNames?: ReadonlyMap<string, string>;
  /** The first UTC day with element snag counters. Defaults to ELEMENT_SNAG_COUNTERS_FROM; tests and other deployments set their own. */
  elementCountersFrom?: string;
  /** Example recordings by element id, already limited to this week and to what the reader may open. */
  examples?: Readonly<Record<string, readonly DigestExample[]>>;
  changes: readonly ChangeMarker[];
  verdicts: readonly DigestVerdict[];
  funnels: readonly DigestFunnelInput[];
}

const sumDays = (days: readonly string[], perDay: ReadonlyMap<string, DayCounts>, field: 'sessions' | 'automated'): number =>
  days.reduce((sum, day) => sum + (perDay.get(day)?.[field] ?? 0), 0);

function funnelItem(input: DigestFunnelInput): DigestFunnel {
  const { current, previous } = input;
  const steps = current.steps;
  const entered = steps[0]?.reached ?? 0;
  const completed = steps[steps.length - 1]?.reached ?? 0;
  const completionRate = entered > 0 ? completed / entered : null;
  let largest: DigestFunnel['largestDrop'];
  steps.forEach((step, index) => {
    const lost = step.dropOff?.count ?? 0;
    if (lost > 0 && (!largest || lost > largest.lost)) largest = { from: step.name, to: steps[index + 1]?.name ?? '', lost, of: step.reached };
  });
  const fewVisits = entered < DIGEST_FEW_VISITS;
  const earlier = previous ? (() => {
    const first = previous.steps[0]?.reached ?? 0;
    const last = previous.steps[previous.steps.length - 1]?.reached ?? 0;
    return { entered: first, completed: last, completionRate: first > 0 ? last / first : null };
  })() : null;
  const lead = entered === 0
    ? `${current.name}: no visits reached the first step this week.`
    : `${current.name}: ${plural(entered, 'visit')} reached the first step and ${plural(completed, 'visit')} reached the last${completionRate === null ? '' : ` (${formatRate(completionRate)})`}.`;
  const drop = largest ? ` The largest drop was between ${largest.from} and ${largest.to}: ${plural(largest.lost, 'visit')} of ${largest.of.toLocaleString('en-US')} did not continue.` : '';
  const before = earlier && earlier.completionRate !== null && entered > 0 && completionRate !== null ? ` Last week: ${formatRate(earlier.completionRate)} of ${plural(earlier.entered, 'visit')}.` : '';
  const few = fewVisits && entered > 0 ? ` Only ${plural(entered, 'visit')}.` : '';
  return {
    funnelId: current.funnelId, name: current.name, entered, completed, completionRate, ...(largest ? { largestDrop: largest } : {}), fewVisits, lastWeek: earlier,
    text: `${lead}${drop}${before}${few}`,
  };
}

const sumMaps = (days: readonly string[], perDay: ReadonlyMap<string, DayCounts>, field: 'channels' | 'countries'): Record<string, number> => {
  const total: Record<string, number> = {};
  for (const day of days) for (const [key, value] of Object.entries(perDay.get(day)?.[field] ?? {})) total[key] = (total[key] ?? 0) + value;
  return total;
};

/** The week's top channels and countries. Shares are of the week's visits, so a visit with no channel or country counts in neither. */
export function digestSources(days: readonly string[], perDay: ReadonlyMap<string, DayCounts>, visits: number): DigestSources {
  const channelCounts = sumMaps(days, perDay, 'channels');
  const countryCounts = sumMaps(days, perDay, 'countries');
  const channels = topShares(channelCounts, visits, key => (isChannel(key) ? CHANNEL_LABELS[key] : key));
  const countries = topShares(countryCounts, visits, key => countryName(key), 3, ['unknown']);
  const unknown = visits > 0 ? (countryCounts.unknown ?? 0) / visits : 0;
  const list = (rows: ShareRow[]) => rows.map(row => `${row.label} ${percentText(row.share)} (${plural(row.count, 'visit')})`).join(', ');
  const parts = [
    channels.length ? `Top channels: ${list(channels)}.` : '',
    countries.length ? `Top countries: ${list(countries)}.` : '',
    countries.length && unknown >= 0.1 ? `${percentText(unknown)} of visits had no country resolved.` : '',
  ].filter(Boolean);
  return { channels, countries, ...(countries.length && unknown >= 0.1 ? { unknownCountryShare: unknown } : {}), text: parts.join(' ') };
}

/** Builds the digest from counts already read. Pure. */
export function buildWeeklyDigest(input: DigestInput): WeeklyDigest {
  const { period, perDay, project } = input;
  const strict = project.preset === 'strict';
  const visits = sumDays(period.current.days, perDay, 'sessions');
  const automated = sumDays(period.current.days, perDay, 'automated');
  const lastVisits = input.previousAvailable ? sumDays(period.previous.days, perDay, 'sessions') : null;
  const lastAutomated = input.previousAvailable ? sumDays(period.previous.days, perDay, 'automated') : null;
  const everything = visits + automated;
  const automatedShare = everything > 0 ? automated / everything : null;
  const changePercent = lastVisits !== null && lastVisits >= 20 ? ((visits - lastVisits) / lastVisits) * 100 : null;

  const visitText = lastVisits === null
    ? `${plural(visits, 'visit')} this week. The week before is outside what this site keeps.`
    : `${plural(visits, 'visit')} this week, ${plural(lastVisits, 'visit')} last week${changePercent === null ? '' : ` (${changePercent >= 0 ? '+' : ''}${Math.round(changePercent)}%)`}.`;
  const automatedText = automated > 0 && automatedShare !== null ? ` ${plural(automated, 'automated visit')} (${Math.round(automatedShare * 100)}% of all visits) ${automated === 1 ? 'is' : 'are'} left out of these counts.` : '';
  const fewVisits = visits < DIGEST_FEW_VISITS;
  const after = input.afterWindow !== undefined && input.afterWindow > 0 && !period.includesToday ? input.afterWindow : undefined;
  const afterText = after === undefined ? '' : ` ${plural(after, 'visit')} so far today (a day still in progress) ${after === 1 ? 'is' : 'are'} not in this window; ask for includeToday to count ${after === 1 ? 'it' : 'them'}.`;
  const todayText = period.includesToday ? ' The last day is today, which is still in progress, so this window holds a partial day.' : '';
  const visitsOut: WeeklyDigest['visits'] = {
    thisWeek: visits, lastWeek: lastVisits, changePercent, automated: { thisWeek: automated, lastWeek: lastAutomated }, automatedShare, fewVisits,
    ...(after !== undefined ? { afterWindow: after } : {}),
    text: `${visitText}${todayText}${automatedText}${fewVisits && visits > 0 ? ' Few visits, so week to week changes can come from a handful of visits.' : ''}${afterText}`,
  };

  // Element counters only exist from ELEMENT_SNAG_COUNTERS_FROM. Days with visits before it say nothing about snags.
  const countersFrom = input.elementCountersFrom ?? ELEMENT_SNAG_COUNTERS_FROM;
  const uncovered = (days: readonly string[]) => days.filter(day => day < countersFrom && (perDay.get(day)?.sessions ?? 0) > 0);
  const currentUncovered = uncovered(period.current.days);
  const previousSnagsKnown = input.previousAvailable && uncovered(period.previous.days).length === 0;
  const previousUncounted = input.previousAvailable && !previousSnagsKnown;

  // Snags by element.
  const current = new Map<string, { selector: string; label?: string; counts: SnagCounts }>();
  const previous = new Map<string, SnagCounts>();
  const currentDays = new Set(period.current.days);
  const previousDays = new Set(period.previous.days);
  for (const row of input.snags) {
    const counts = { pileUps: row.pileUps, noShows: row.noShows, misfires: row.misfires };
    if (currentDays.has(row.day)) {
      const entry = current.get(row.id) ?? { selector: row.selector, counts: emptyCounts() };
      entry.counts = total({ pileUps: entry.counts.pileUps + counts.pileUps, noShows: entry.counts.noShows + counts.noShows, misfires: entry.counts.misfires + counts.misfires });
      if (row.label) entry.label = row.label;
      current.set(row.id, entry);
    } else if (previousSnagsKnown && previousDays.has(row.day)) {
      const entry = previous.get(row.id) ?? emptyCounts();
      previous.set(row.id, total({ pileUps: entry.pileUps + counts.pileUps, noShows: entry.noShows + counts.noShows, misfires: entry.misfires + counts.misfires }));
    }
  }
  // An element seen only last week still counts: it may have gone quiet, which is a change worth showing.
  const labels = new Map<string, { selector: string; label?: string }>();
  for (const row of input.snags) if (!labels.has(row.id) || row.label) labels.set(row.id, { selector: row.selector, ...(row.label ? { label: row.label } : {}) });
  const ids = new Set([...current.keys(), ...previous.keys()]);
  const elements: DigestElement[] = [...ids].map(id => {
    const meta = labels.get(id)!;
    const thisWeek = current.get(id)?.counts ?? emptyCounts();
    const lastWeek = previousSnagsKnown ? previous.get(id) ?? emptyCounts() : null;
    // Under strict the label is never used, even if one was stored before the preset changed.
    const named = elementName(meta.selector, strict ? undefined : meta.label, input.elementNames?.get(meta.selector));
    return {
      id, selector: meta.selector, name: sentenceName(named), nameSource: named.source, thisWeek, lastWeek, leadKind: leadOf(thisWeek),
      text: snagSentence(sentenceName(named), thisWeek, lastWeek), examples: [...(input.examples?.[id] ?? [])].slice(0, DIGEST_MAX_EXAMPLES),
    };
  }).filter(element => Math.max(element.thisWeek.total, element.lastWeek?.total ?? 0) >= DIGEST_MIN_ELEMENT_SNAGS && (element.lastWeek === null || element.thisWeek.total !== element.lastWeek.total))
    .sort((a, b) => Math.abs(b.thisWeek.total - (b.lastWeek?.total ?? 0)) - Math.abs(a.thisWeek.total - (a.lastWeek?.total ?? 0)) || b.thisWeek.total - a.thisWeek.total || (a.id < b.id ? -1 : 1))
    .slice(0, DIGEST_MAX_ELEMENTS);
  const totalThisWeek = [...current.values()].reduce((sum, entry) => sum + entry.counts.total, 0);
  const totalLastWeek = previousSnagsKnown ? [...previous.values()].reduce((sum, counts) => sum + counts.total, 0) : null;
  const snagBody = elements.length
    ? `${plural(totalThisWeek, 'snag')} (pile-ups, no-shows or misfires) counted on elements this week${totalLastWeek === null ? '' : `, ${totalLastWeek.toLocaleString('en-US')} last week`}. The elements that changed most:`
    : totalThisWeek === 0 && (totalLastWeek ?? 0) === 0 ? 'No snags were counted on any element this week or last.' : `${plural(totalThisWeek, 'snag')} this week, spread thinly: no element reached ${DIGEST_MIN_ELEMENT_SNAGS} in either week.`;
  const startDay = new Date(Date.parse(countersFrom)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const lead = `Snags are counted by element only from ${startDay}`;
  // The empty list means "not counted" on those days, so it must not read as a quiet week.
  let snagText = snagBody;
  let notCounted = false;
  if (currentUncovered.length) {
    notCounted = true;
    const n = currentUncovered.length;
    const coverage = `${lead}. ${plural(n, 'day')} of this week with visits ${n === 1 ? 'is' : 'are'} earlier, so ${n === 1 ? 'it is' : 'they are'} not in these counts. Findings and the list of recordings with snags cover ${n === 1 ? 'it' : 'them'}.`;
    snagText = !elements.length && totalThisWeek === 0 ? coverage : `${coverage} ${snagBody}`;
  } else if (previousUncounted) {
    notCounted = true;
    snagText = `${lead}, so last week is not compared. ${snagBody}`;
  }

  // Goals.
  const goalNow = goalStatsOver(input.goals, period.current.days, perDay);
  const goalBefore = input.previousAvailable ? goalStatsOver(input.goals, period.previous.days, perDay) : null;
  const goals: DigestGoal[] = goalNow.map((now, index) => {
    const before = goalBefore?.[index] ?? null;
    const side = (stat: GoalStat) => ({ visits: stat.sessions, conversions: stat.conversions, rate: stat.rate, interval: stat.interval });
    const difference = before && now.rate !== null && before.rate !== null ? (now.rate - before.rate) * 100 : null;
    const few = now.sessions < DIGEST_FEW_VISITS || (before !== null && before.sessions < DIGEST_FEW_VISITS);
    const rateNow = now.rate === null ? 'no visits' : `${formatRate(now.rate)} (${now.conversions.toLocaleString('en-US')} of ${plural(now.sessions, 'visit')})`;
    const rateBefore = before === null ? 'no earlier week to compare' : before.rate === null ? 'no visits last week' : `${formatRate(before.rate)} last week (${before.conversions.toLocaleString('en-US')} of ${plural(before.sessions, 'visit')})`;
    const note = few ? ' Few visits, so this is a small sample and not a trend.' : '';
    return {
      goalId: now.goalId, name: now.name, kind: now.kind, thisWeek: side(now), lastWeek: before ? side(before) : null, differencePoints: difference, fewVisits: few,
      text: `${now.name}: ${rateNow} this week, ${rateBefore}.${note}`,
    };
  });

  // Changes and verdicts.
  const logged: DigestChange[] = input.changes.filter(change => change.at >= period.current.from && change.at <= period.current.to)
    .sort((a, b) => a.at - b.at).slice(0, 10)
    .map(change => ({ id: change.id, at: change.at, title: change.title, ...(change.pageGroup ? { pageGroup: change.pageGroup } : {}), detected: change.source?.startsWith('auto:') === true }));

  const funnels = input.funnels.map(funnelItem);

  // One item worth watching: the first rule that applies, strongest evidence first.
  let watch: DigestWatch = { kind: 'none', text: 'Nothing stood out this week.' };
  const fell = goals.filter(goal => !goal.fewVisits && goal.lastWeek && goal.thisWeek.rate !== null && goal.lastWeek.rate !== null && goal.lastWeek.rate > 0 && goal.thisWeek.rate < goal.lastWeek.rate * 0.8)
    .sort((a, b) => (a.differencePoints ?? 0) - (b.differencePoints ?? 0))[0];
  const fresh = elements.filter(element => element.lastWeek !== null && element.lastWeek.total === 0 && element.thisWeek.total >= 5).sort((a, b) => b.thisWeek.total - a.thisWeek.total)[0];
  if (fell) {
    watch = { kind: 'goal-fall', text: `${fell.name} converted ${formatRate(fell.thisWeek.rate!)} of visits this week against ${formatRate(fell.lastWeek!.rate!)} last week. Check what changed on the pages that lead to it.` };
  } else if (fresh) {
    watch = { kind: 'new-snags', text: `${fresh.name} had no snags last week and ${plural(fresh.thisWeek.total, 'snag')} this week. Watch a replay to see what happens there.` };
  } else if (automatedShare !== null && automated >= 20 && automatedShare >= 0.3) {
    watch = { kind: 'automated-share', text: `${Math.round(automatedShare * 100)}% of this week's visits were automated (${automated.toLocaleString('en-US')} of ${everything.toLocaleString('en-US')}). They are left out of the counts above, but a high share can mean crawlers are using up your recording allowance.` };
  }

  return {
    projectId: project.id, projectName: project.name, generatedAt: input.now,
    period: { from: period.current.from, to: period.current.to, weekEnding: period.weekEnding, label: period.label, previousFrom: period.previous.from, previousTo: period.previous.to, includesToday: period.includesToday },
    privacy: project.preset, noData: visits === 0, visits: visitsOut,
    snags: { elements, totalThisWeek, totalLastWeek, text: snagText, ...(notCounted ? { countedFrom: countersFrom } : {}) },
    sources: visits > 0 ? digestSources(period.current.days, perDay, visits) : { channels: [], countries: [], text: '' }, goals, changes: { logged, verdicts: [...input.verdicts], ...(input.verdicts.length ? { verdictNote: VERDICT_CAVEAT } : {}) }, funnels, watch,
    notes: [...DIGEST_NOTES],
  };
}
