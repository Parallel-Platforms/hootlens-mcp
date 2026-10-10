/*
 * "Did it help?": the arithmetic and wording behind a change impact report.
 *
 * The report compares the days before and the days after a change marker, per page group. It is an
 * observational before and after, not a controlled experiment: traffic mix, seasonality, campaigns and other
 * changes can move the numbers on their own. Everything here is a count, a rate, an interval or a wording
 * rule, so the API, the MCP service and the dashboard say the same thing. No function claims a cause.
 */
import type { ChangeMarker, Goal } from './changes';
import type { DeviceClass } from './index';

/** Visits each side needs before a conversion rate is compared. Matches the release comparison. */
export const IMPACT_MIN_VISITS = 30;
export const IMPACT_DEFAULT_DAYS = 14;
export const IMPACT_MAX_DAYS = 45;
/** Aggregate counts are kept at least this many days, whatever the project's recording retention. */
export const STATS_MIN_RETENTION_DAYS = 60;
/** Two-sided p-value below which a difference is called likely real, and below which it is called possibly chance. */
export const LIKELY_REAL_P = 0.05;
export const COULD_BE_CHANCE_P = 0.2;
const Z95 = 1.959963984540054;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------- maths */

/** Standard normal cumulative distribution (Abramowitz and Stegun 26.2.17, error under 1e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const density = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/** 95% Wilson score interval for `successes` of `n`. Null with no observations. */
export function wilsonInterval(successes: number, n: number, z = Z95): [number, number] | null {
  if (!(n > 0)) return null;
  const s = Math.min(Math.max(successes, 0), n);
  const p = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Pooled two-proportion z-test. `p` is two-sided; a pooled rate of 0 or 1 has no spread, so z is 0 and p is 1. */
export function twoProportionZTest(successesA: number, nA: number, successesB: number, nB: number): { z: number; p: number } {
  if (!(nA > 0) || !(nB > 0)) return { z: 0, p: 1 };
  const pooled = (successesA + successesB) / (nA + nB);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (!(spread > 0)) return { z: 0, p: 1 };
  const z = (successesB / nB - successesA / nA) / spread;
  return { z, p: z === 0 ? 1 : Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

/** `3.1%`: one decimal place, so 3.1% is never shown as 3%. */
export const formatRate = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/* ------------------------------------------------------------------ report */

/** What one side (before or after) counted for one page group. All counts are observed, none is estimated. */
export interface SideStats {
  /** Distinct sessions that viewed the page group. */
  visits: number;
  /** Rapid-click pile-ups, no-shows and misfires, counted per click. */
  snags: number;
  /** Page views whose scroll depth was measured, and how many of those reached half the page. */
  scrollMeasured: number;
  scrollHalf: number;
  /** Sessions that viewed the page group and converted, by goal id. */
  goals: Record<string, number>;
}
export const emptySide = (): SideStats => ({ visits: 0, snags: 0, scrollMeasured: 0, scrollHalf: 0, goals: {} });

export type VerdictKind = 'too-few' | 'no-baseline' | 'no-clear-change' | 'rose' | 'fell';
export type VerdictCertainty = 'likely-real' | 'could-be-chance';
export interface ConversionVerdict {
  kind: VerdictKind;
  certainty?: VerdictCertainty;
  /** The plain-language verdict, for example `Conversion rose from 3.1% to 4.6% (likely real)`. */
  text: string;
  /** Two-sided p-value of the two-proportion z-test, when both sides had enough visits. */
  p?: number;
  /** Visits still needed on each side before the rates are compared. */
  needMore?: { before: number; after: number };
}

export interface RateSide {
  visits: number;
  conversions: number;
  rate: number | null;
  /** 95% Wilson interval of `rate`. */
  interval: [number, number] | null;
}
export const rateSide = (visits: number, conversions: number): RateSide => {
  const converted = Math.min(Math.max(conversions, 0), Math.max(visits, 0));
  return { visits, conversions: converted, rate: visits > 0 ? converted / visits : null, interval: wilsonInterval(converted, visits) };
};

/** Verdict for one goal. Never claims more than the counts support, and never names a cause. */
export function conversionVerdict(before: RateSide, after: RateSide, options: { minVisits?: number; goalSince?: number; beforeFrom?: number } = {}): ConversionVerdict {
  const min = options.minVisits ?? IMPACT_MIN_VISITS;
  if (options.goalSince !== undefined && options.beforeFrom !== undefined && options.goalSince > options.beforeFrom) {
    return { kind: 'no-baseline', text: 'No baseline: this goal was added after the before period began' };
  }
  const needBefore = Math.max(0, min - before.visits);
  const needAfter = Math.max(0, min - after.visits);
  if (needBefore || needAfter) {
    return { kind: 'too-few', text: `Too few visits to tell (need ${needBefore + needAfter} more)`, needMore: { before: needBefore, after: needAfter } };
  }
  const { p } = twoProportionZTest(before.conversions, before.visits, after.conversions, after.visits);
  const from = before.rate ?? 0;
  const to = after.rate ?? 0;
  const direction = to > from ? 'rose' : to < from ? 'fell' : undefined;
  if (!direction || p >= COULD_BE_CHANCE_P) return { kind: 'no-clear-change', text: 'No clear change', p };
  const certainty: VerdictCertainty = p < LIKELY_REAL_P ? 'likely-real' : 'could-be-chance';
  const note = certainty === 'likely-real' ? 'likely real' : 'could be chance';
  return { kind: direction, certainty, text: `Conversion ${direction} from ${formatRate(from)} to ${formatRate(to)} (${note})`, p };
}

export interface GoalImpact {
  goalId: string;
  name: string;
  before: RateSide;
  after: RateSide;
  /** after.rate minus before.rate, in percentage points. Null when either side has no visits. */
  differencePoints: number | null;
  verdict: ConversionVerdict;
}

export function goalImpact(goal: Pick<Goal, 'id' | 'name' | 'since'>, before: SideStats, after: SideStats, beforeFrom: number): GoalImpact {
  const b = rateSide(before.visits, before.goals[goal.id] ?? 0);
  const a = rateSide(after.visits, after.goals[goal.id] ?? 0);
  return {
    goalId: goal.id, name: goal.name, before: b, after: a,
    differencePoints: b.rate === null || a.rate === null ? null : (a.rate - b.rate) * 100,
    verdict: conversionVerdict(b, a, { goalSince: goal.since, beforeFrom }),
  };
}

export const per100 = (count: number, visits: number): number | null => (visits > 0 ? (count / visits) * 100 : null);
export const scrollReach = (side: Pick<SideStats, 'scrollMeasured' | 'scrollHalf'>): number | null =>
  (side.scrollMeasured > 0 ? Math.min(1, side.scrollHalf / side.scrollMeasured) : null);

/** One element's share of clicks before and after. The fields match the release comparison's rows, A being before and B after. */
export interface ElementShareChange {
  selector: string;
  label?: string;
  /** The name the team gave this element, when it has one. */
  name?: string;
  clicksA: number;
  clicksB: number;
  shareA: number | null;
  shareB: number | null;
  deltaPoints: number | null;
  presence: 'both' | 'only-a' | 'only-b';
  absenceUncertain: boolean;
}
export interface ClickCount { selector: string; label?: string; clicks: number; }

/**
 * Click-share changes between two lists of element click counts, largest absolute change first. Shares are
 * of each side's own total, so a side with more traffic does not look busier.
 */
export function elementShareChanges(before: readonly ClickCount[], after: readonly ClickCount[], limit = 5): { rows: ElementShareChange[]; beforeClicks: number; afterClicks: number } {
  const total = (rows: readonly ClickCount[]) => rows.reduce((sum, row) => sum + row.clicks, 0);
  const beforeClicks = total(before);
  const afterClicks = total(after);
  const a = new Map(before.map(row => [row.selector, row]));
  const b = new Map(after.map(row => [row.selector, row]));
  const rows: ElementShareChange[] = [...new Set([...a.keys(), ...b.keys()])].map(selector => {
    const x = a.get(selector);
    const y = b.get(selector);
    const clicksA = x?.clicks ?? 0;
    const clicksB = y?.clicks ?? 0;
    const shareA = beforeClicks > 0 ? clicksA / beforeClicks : null;
    const shareB = afterClicks > 0 ? clicksB / afterClicks : null;
    const label = y?.label ?? x?.label;
    return {
      selector, ...(label ? { label } : {}), clicksA, clicksB, shareA, shareB,
      deltaPoints: shareA === null || shareB === null ? null : (shareB - shareA) * 100,
      presence: x && y ? 'both' as const : x ? 'only-a' as const : 'only-b' as const,
      absenceUncertain: false,
    };
  });
  rows.sort((p, q) => Math.abs(q.deltaPoints ?? 0) - Math.abs(p.deltaPoints ?? 0) || (q.clicksA + q.clicksB) - (p.clicksA + p.clicksB) || p.selector.localeCompare(q.selector));
  return { rows: rows.slice(0, limit), beforeClicks, afterClicks };
}

export interface ImpactWindow {
  /** First and last instant counted: whole UTC days. `to` is the last millisecond of the last day. */
  from: number;
  to: number;
  /** UTC days counted, `YYYY-MM-DD`. */
  days: string[];
  /** Why the window is this long: the default length, the previous or next change marker, today, or the oldest data kept. */
  basis: 'days' | 'previous-change' | 'next-change' | 'to-date' | 'retention';
}

export const utcDay = (time: number): string => new Date(time).toISOString().slice(0, 10);
const dayStart = (time: number): number => Date.parse(utcDay(time));

/**
 * The days before and after a change. The day of the change is left out of both sides, because daily counts
 * cannot tell which of its visits came before the change. Before runs back `days` days, or to the day after
 * the previous marker; after runs forward `days` days, or to the day before the next marker, or to today.
 */
export function impactWindows(
  at: number,
  options: { days?: number; previousAt?: number; nextAt?: number; now?: number; oldestKept?: number } = {},
): { before: ImpactWindow; after: ImpactWindow } {
  const length = Math.min(Math.max(Math.floor(options.days ?? IMPACT_DEFAULT_DAYS), 1), IMPACT_MAX_DAYS);
  const now = options.now ?? Date.now();
  const changeDay = dayStart(at);
  const build = (first: number, last: number, basis: ImpactWindow['basis']): ImpactWindow => {
    const days: string[] = [];
    for (let time = first; time <= last; time += DAY_MS) days.push(utcDay(time));
    return { from: first, to: days.length ? last + DAY_MS - 1 : first, days, basis };
  };
  let beforeFirst = changeDay - length * DAY_MS;
  let beforeBasis: ImpactWindow['basis'] = 'days';
  if (options.previousAt !== undefined && options.previousAt < at && dayStart(options.previousAt) + DAY_MS > beforeFirst) {
    beforeFirst = dayStart(options.previousAt) + DAY_MS;
    beforeBasis = 'previous-change';
  }
  if (options.oldestKept !== undefined && dayStart(options.oldestKept) > beforeFirst) {
    beforeFirst = dayStart(options.oldestKept);
    beforeBasis = 'retention';
  }
  const afterFirst = changeDay + DAY_MS;
  let afterLast = Math.min(changeDay + length * DAY_MS, dayStart(now));
  let afterBasis: ImpactWindow['basis'] = changeDay + length * DAY_MS <= dayStart(now) ? 'days' : 'to-date';
  if (options.nextAt !== undefined && options.nextAt > at && dayStart(options.nextAt) - DAY_MS < afterLast) {
    afterLast = dayStart(options.nextAt) - DAY_MS;
    afterBasis = 'next-change';
  }
  return { before: build(beforeFirst, changeDay - DAY_MS, beforeBasis), after: build(afterFirst, afterLast, afterBasis) };
}

export interface GroupImpact {
  /** Page group id and its display name. */
  group: string;
  name: string;
  before: { window: ImpactWindow; visits: number };
  after: { window: ImpactWindow; visits: number };
  /** Visits each side still needs before rates are compared. */
  needMore: { before: number; after: number };
  goals: GoalImpact[];
  snagsPer100: { before: number | null; after: number | null; snagsBefore: number; snagsAfter: number };
  /** Share of measured page views that reached half the page. */
  scrollReach: { before: number | null; after: number | null; measuredBefore: number; measuredAfter: number };
  elements: {
    rows: ElementShareChange[];
    /** Sampled clicks behind the shares. A sample is at most a few thousand clicks per heatmap cohort. */
    clicksBefore: number;
    clicksAfter: number;
    /** Set when there are too few sampled clicks to show shares, or the samples are no longer kept. */
    note?: string;
  };
}

export interface ImpactReport {
  change: ChangeMarker;
  /** Days each side runs at most. */
  days: number;
  filters: { deviceClass?: DeviceClass; locale?: string };
  goals: Pick<Goal, 'id' | 'name'>[];
  groups: GroupImpact[];
  /** One sentence for people and agents. Observed numbers only. */
  summary: string;
  /** What the numbers cannot say. Always present. */
  caveats: string[];
  generatedAt: number;
}

export const IMPACT_CAVEATS: readonly string[] = [
  'Before and after, not an A/B test: seasonality, campaigns and traffic mix move numbers too.',
  'The day of the change is left out of both sides.',
];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * One sentence about the report. It names the page group, the goal, the observed rates and the sample sizes,
 * and carries the verdict's own certainty wording. With nothing to compare it says what is missing.
 */
export function impactSummary(report: Pick<ImpactReport, 'change' | 'groups' | 'goals'>): string {
  const { change, groups } = report;
  const subject = change.pageGroup === undefined ? 'The change' : `The change to ${groups[0]?.name ?? change.pageGroup}`;
  if (!groups.length) return `${subject} has no recorded visits to compare yet.`;
  if (!report.goals.length) {
    const g = groups[0];
    const snags = g.snagsPer100;
    if (snags.before === null || snags.after === null) return `${subject}: no goals are set, and there are too few visits to compare snags.`;
    return `${subject}: no goals are set. Snags per 100 visits went from ${snags.before.toFixed(1)} to ${snags.after.toFixed(1)} (${plural(g.before.visits, 'visit')} before, ${plural(g.after.visits, 'visit')} after).`;
  }
  const lead = groups[0];
  const compared = lead.goals.find(goal => goal.verdict.kind === 'rose' || goal.verdict.kind === 'fell')
    ?? lead.goals.find(goal => goal.verdict.kind === 'no-clear-change')
    ?? lead.goals[0];
  const sample = `${plural(lead.before.visits, 'visit')} before, ${plural(lead.after.visits, 'visit')} after`;
  if (!compared) return `${subject}: no goals to compare.`;
  const rates = compared.before.rate !== null && compared.after.rate !== null ? ` (${formatRate(compared.before.rate)} to ${formatRate(compared.after.rate)})` : '';
  const verdict = compared.verdict.kind === 'rose' || compared.verdict.kind === 'fell'
    ? `${compared.name} conversion ${compared.verdict.kind}${rates}, ${compared.verdict.certainty === 'likely-real' ? 'likely real' : 'could be chance'}`
    : `${compared.name}: ${compared.verdict.text.charAt(0).toLowerCase()}${compared.verdict.text.slice(1)}`;
  return `${subject}: ${verdict}. ${sample}. Before and after, not an A/B test.`;
}
