/*
 * Overview trends: page views, clicks and the snag rate over the last 7 complete UTC days, against the 7 days before.
 *
 * The numbers come from the daily activity counters the collector keeps (one per UTC day: page views, clicks and snag
 * clicks), which count the same things as the Overview totals: recorded page views of real visits, with automated
 * visits and controlled test visits left out. A window is compared only when every one of its days was counted, so a
 * project whose counters began last week shows its figures without a comparison and never a rise against a half-empty
 * week. The functions here are pure; the API reads the counters and these decide what is said.
 */
import { z } from 'zod';

const DAY_MS = 86_400_000;
export const TREND_DAYS = 7;
/** A percentage change is stated only when the week before had at least this many; below it a change is stated as a count. */
export const TREND_MIN_PERCENT_BASE = 20;
/** The snag rate of a week is compared only when both weeks have at least this many clicks. */
export const TREND_MIN_RATE_CLICKS = 100;

const dayText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int();

/** One UTC day of the daily activity counters. */
export const activityDaySchema = z.object({ day: dayText, pageViews: count, clicks: count, snags: count });
export type ActivityDay = z.infer<typeof activityDaySchema>;

export const trendTotalsSchema = z.object({
  pageViews: count.min(0),
  clicks: count.min(0),
  /** Clicks that were a pile-up, no-show or misfire. */
  snags: count.min(0),
  /** Snags as a share of clicks, 0 to 1; null without clicks. */
  snagRate: z.number().min(0).max(1).nullable(),
});
export type TrendTotals = z.infer<typeof trendTotalsSchema>;

export const trendChangeSchema = z.object({
  direction: z.enum(['up', 'down', 'flat']),
  /** Current minus previous. */
  absolute: count,
  /** Whole percent against the week before. Absent when the week before had too few to make a percentage fair. */
  percent: z.number().int().optional(),
});
export type TrendChange = z.infer<typeof trendChangeSchema>;

export const snagRateChangeSchema = z.object({
  direction: z.enum(['up', 'down', 'flat']),
  /** Percentage points, one decimal, current minus previous. */
  points: z.number(),
});
export type SnagRateChange = z.infer<typeof snagRateChangeSchema>;

const windowSchema = z.object({ from: dayText, to: dayText });

/**
 * GET /v1/projects/:projectId/trends. `status` says what could be shown: `compared` has both weeks, `current-only` has
 * the last 7 days but the week before was not fully counted, `not-covered` has neither and callers fall back to totals.
 */
export const overviewTrendsSchema = z.object({
  status: z.enum(['compared', 'current-only', 'not-covered']),
  windows: z.object({ current: windowSchema, previous: windowSchema }),
  /** The first UTC day every count of which is complete. Absent until counting has begun for the project. */
  countedFrom: dayText.optional(),
  current: trendTotalsSchema.optional(),
  previous: trendTotalsSchema.optional(),
  changes: z.object({
    pageViews: trendChangeSchema,
    clicks: trendChangeSchema,
    /** Absent when either week has fewer than TREND_MIN_RATE_CLICKS clicks. */
    snagRate: snagRateChangeSchema.optional(),
  }).optional(),
});
export type OverviewTrends = z.infer<typeof overviewTrendsSchema>;

const utcDay = (time: number): string => new Date(time).toISOString().slice(0, 10);
const dayStart = (time: number): number => Date.parse(utcDay(time));

export interface TrendWindow { from: string; to: string; days: string[] }

/** The 7 complete UTC days ending yesterday and the 7 before them, oldest day first. */
export function trendWindows(now: number): { current: TrendWindow; previous: TrendWindow } {
  const lastDay = dayStart(now) - DAY_MS;
  const windowEnding = (last: number): TrendWindow => {
    const days = Array.from({ length: TREND_DAYS }, (_, index) => utcDay(last - (TREND_DAYS - 1 - index) * DAY_MS));
    return { from: days[0]!, to: days[TREND_DAYS - 1]!, days };
  };
  return { current: windowEnding(lastDay), previous: windowEnding(lastDay - TREND_DAYS * DAY_MS) };
}

/**
 * The first UTC day whose counts are complete. Counting began at some point on the day of `since` (the first batch the
 * collector counted), so that day is partial, unless the project itself was created that day: then nothing came earlier.
 */
export function countedFrom(since: string | undefined, createdAt: number | undefined): string | undefined {
  if (since === undefined) return undefined;
  if (createdAt !== undefined && utcDay(createdAt) === since) return since;
  return utcDay(Date.parse(since) + DAY_MS);
}

/** Whether every day of a window was counted and is still kept. Day strings compare in order. */
export function windowCovered(window: Pick<TrendWindow, 'from'>, first: string | undefined, retention: { now: number; retentionDays: number }): boolean {
  if (first === undefined || window.from < first) return false;
  return window.from >= utcDay(retention.now - retention.retentionDays * DAY_MS);
}

export function sumActivity(days: readonly string[], perDay: ReadonlyMap<string, ActivityDay> | readonly ActivityDay[]): TrendTotals {
  const map = perDay instanceof Map ? perDay : new Map((perDay as readonly ActivityDay[]).map(entry => [entry.day, entry]));
  let pageViews = 0; let clicks = 0; let snags = 0;
  for (const day of days) {
    const entry = (map as ReadonlyMap<string, ActivityDay>).get(day);
    // A retraction on a later day can leave a day below zero; it reads as zero.
    pageViews += Math.max(0, entry?.pageViews ?? 0);
    clicks += Math.max(0, entry?.clicks ?? 0);
    snags += Math.max(0, entry?.snags ?? 0);
  }
  return { pageViews, clicks, snags, snagRate: clicks > 0 ? Math.min(1, snags / clicks) : null };
}

/** How a count changed. Percent only when the week before had enough to make one fair; zero before gives the count alone. */
export function changeOf(current: number, previous: number): TrendChange {
  const absolute = current - previous;
  if (previous < TREND_MIN_PERCENT_BASE) return { direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat', absolute };
  const percent = Math.round((absolute / previous) * 100);
  return { direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat', absolute, percent };
}

/** The snag rate change in points, or undefined when either week is too thin to compare. */
export function snagRateChange(current: TrendTotals, previous: TrendTotals): SnagRateChange | undefined {
  if (current.snagRate === null || previous.snagRate === null) return undefined;
  if (current.clicks < TREND_MIN_RATE_CLICKS || previous.clicks < TREND_MIN_RATE_CLICKS) return undefined;
  const points = Math.round((current.snagRate - previous.snagRate) * 1000) / 10;
  return { direction: points > 0 ? 'up' : points < 0 ? 'down' : 'flat', points };
}

export interface TrendInput {
  now: number;
  /** The day the project's activity counters first counted, `YYYY-MM-DD`. Undefined when nothing was counted yet. */
  since: string | undefined;
  createdAt?: number;
  retentionDays: number;
  /** Counter days read for both windows. Days with no counter document may be missing. */
  days: readonly ActivityDay[];
}

export function buildOverviewTrends(input: TrendInput): OverviewTrends {
  const windows = trendWindows(input.now);
  const first = countedFrom(input.since, input.createdAt);
  const shape = { windows: { current: { from: windows.current.from, to: windows.current.to }, previous: { from: windows.previous.from, to: windows.previous.to } }, ...(first ? { countedFrom: first } : {}) };
  const retention = { now: input.now, retentionDays: input.retentionDays };
  if (!windowCovered(windows.current, first, retention)) return { status: 'not-covered', ...shape };
  const current = sumActivity(windows.current.days, input.days);
  if (!windowCovered(windows.previous, first, retention)) return { status: 'current-only', ...shape, current };
  const previous = sumActivity(windows.previous.days, input.days);
  const rate = snagRateChange(current, previous);
  return {
    status: 'compared', ...shape, current, previous,
    changes: { pageViews: changeOf(current.pageViews, previous.pageViews), clicks: changeOf(current.clicks, previous.clicks), ...(rate ? { snagRate: rate } : {}) },
  };
}

const format = (n: number) => n.toLocaleString('en-US');

/** "Up 18%", "Down 3" or "No change". The comparison base is said once, beside the figures, or by describeChange. */
export function changeLabel(change: TrendChange): string {
  if (change.direction === 'flat') return 'No change';
  const size = change.percent !== undefined ? `${format(Math.abs(change.percent))}%` : format(Math.abs(change.absolute));
  return `${change.direction === 'up' ? 'Up' : 'Down'} ${size}`;
}
/** "Up 18% on the week before". */
export const describeChange = (change: TrendChange): string => `${changeLabel(change)} on the week before`;

/** "0.4 points higher" or "Same". Neutral wording: a lower snag rate is better, but the words do not judge it. */
export function snagRateChangeLabel(change: SnagRateChange): string {
  if (change.direction === 'flat') return 'No change';
  const points = Math.abs(change.points);
  return `${points.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${points === 1 ? 'point' : 'points'} ${change.direction === 'up' ? 'higher' : 'lower'}`;
}
/** "0.4 points higher than the week before". */
export const describeSnagRateChange = (change: SnagRateChange): string =>
  change.direction === 'flat' ? 'No change on the week before' : `${snagRateChangeLabel(change)} than the week before`;
