/*
 * Email notifications: who gets what, and the rules that decide when an alert is worth sending.
 *
 * Two kinds of email exist. The weekly digest summarises the last seven complete UTC days. Alerts are sent when
 * something observed changes sharply: a spike of snags on one element, a tracker that went quiet, or a goal whose
 * conversion rate fell well below its own baseline. Everything here is a count, a rate or an interval from data the
 * dashboard already shows. No rule claims a cause, and none reads visitor details or page text.
 *
 * The rules are pure: they take counts and answer whether to alert, with the evidence, so the thresholds are testable
 * and the same wording is used wherever an alert is shown.
 */
import { z } from 'zod';
import type { Goal } from './changes';
import { wilsonInterval } from './impact';
import type { ProjectRole } from './teams';

export const ALERT_KINDS = ['snag-spike', 'tracker-silence', 'goal-drop'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const alertKindSchema = z.enum(ALERT_KINDS);
export const ALERT_LABELS: Record<AlertKind, string> = {
  'snag-spike': 'Snag spike',
  'tracker-silence': 'Tag silence',
  'goal-drop': 'Goal drop',
};

/** What a person receives for one project. */
export interface NotificationPrefs { digest: boolean; alerts: boolean; firstVisit: boolean }

/** Stored per user and project. An unset field means "use the default for the role". */
export interface NotificationPrefRecord {
  projectId: string;
  userId: string;
  digest?: boolean;
  alerts?: boolean;
  /** The one email when the site's first visit arrives. */
  firstVisit?: boolean;
  /** Alert kind to the time (epoch ms) until which that kind is muted for this person. */
  muted?: Partial<Record<AlertKind, number>>;
  /**
   * Email links carry this number. Raising it makes every link already sent stop working (an unsubscribe link does not
   * expire by time, so this is how one is revoked). Absent means 0.
   */
  linkVersion?: number;
  updatedAt: number;
}

/** The owner gets the digest, alerts and the first visit email unless they turn them off. Members get none until they turn them on. */
export function defaultNotificationPrefs(role: ProjectRole): NotificationPrefs {
  return role === 'owner' ? { digest: true, alerts: true, firstVisit: true } : { digest: false, alerts: false, firstVisit: false };
}

export function effectiveNotificationPrefs(role: ProjectRole, record: Pick<NotificationPrefRecord, 'digest' | 'alerts' | 'firstVisit'> | undefined): NotificationPrefs {
  const defaults = defaultNotificationPrefs(role);
  return { digest: record?.digest ?? defaults.digest, alerts: record?.alerts ?? defaults.alerts, firstVisit: record?.firstVisit ?? defaults.firstVisit };
}

/** The kinds still muted at `now`, with when each mute ends. */
export function activeMutes(record: Pick<NotificationPrefRecord, 'muted'> | undefined, now: number): Partial<Record<AlertKind, number>> {
  const active: Partial<Record<AlertKind, number>> = {};
  for (const kind of ALERT_KINDS) {
    const until = record?.muted?.[kind];
    if (typeof until === 'number' && until > now) active[kind] = until;
  }
  return active;
}

export const notificationPrefsUpdateSchema = z.object({ digest: z.boolean().optional(), alerts: z.boolean().optional(), firstVisit: z.boolean().optional(), unmute: z.array(alertKindSchema).min(1).max(ALERT_KINDS.length).optional() })
  .refine(update => update.digest !== undefined || update.alerts !== undefined || update.firstVisit !== undefined || update.unmute !== undefined, 'Send digest, alerts, firstVisit, unmute or a combination');

/** GET /v1/projects/:projectId/notifications: the signed-in person's settings for one project. */
export interface NotificationSettings {
  projectId: string;
  role: ProjectRole;
  prefs: NotificationPrefs;
  /** What the role gets when nothing has been chosen. */
  defaults: NotificationPrefs;
  /** Alert kinds muted from an email link, with the time each mute ends. */
  muted: Partial<Record<AlertKind, number>>;
  /** The address emails go to, when it is known and verified. Never another person's. */
  email?: string;
  /** Whether this environment sends email at all. Staging and local development do not. */
  emailEnabled: boolean;
}

/* --------------------------------------------------------------- thresholds */

/**
 * Every threshold in one place, so the rules, the tests and the documentation agree. They are deliberately
 * conservative: an alert that fires on noise teaches people to ignore the next one.
 */
export const ALERT_THRESHOLDS = {
  snagSpike: {
    /** Snags counted in the last 24 hours, against the same 24 hour window each of the 7 days before. */
    windowHours: 24,
    baselineDays: 7,
    multiplier: 3,
    minSnags: 10,
    /** Visits that began in the last 24 hours, so a handful of visitors cannot raise an alert. */
    minVisits: 30,
    /** Within this many hours of a change marker the rule is a little more sensitive, because a release is the likeliest cause to look at first. */
    markerHours: 24,
    markerMultiplier: 2,
    markerMinSnags: 6,
    markerMinVisits: 20,
  },
  silence: {
    /** No accepted batch for this long. */
    hours: 6,
    /** The project normally receives at least this many visits a day, averaged over `baselineDays`. */
    minDailyVisits: 20,
    baselineDays: 14,
    /** Visits expected in those hours, from the project's own hour-of-day pattern, so an overnight gap is not silence. */
    minExpectedVisits: 5,
    /** Days of hour-of-day data needed before the pattern is trusted. */
    minProfileDays: 3,
  },
  goalDrop: {
    /** The two most recent complete UTC days, against the 14 complete days before them. */
    recentDays: 2,
    baselineDays: 14,
    /** Visits in each window. */
    minVisits: 100,
  },
} as const;

/** A project's change markers within a time window, newest first. Only what an alert needs. */
export interface MarkerRef { id: string; title: string; at: number; release?: string }

/* --------------------------------------------------------------- snag spike */

/** One element's snags by UTC hour: `hours` has one count per hour from `start`, oldest first. */
export interface SnagSeries {
  id: string;
  selector: string;
  label?: string;
  /** Epoch ms of the first hour. */
  start: number;
  hours: number[];
  /** Per kind totals over the whole series, for the wording. */
  kinds?: { pileUps: number; noShows: number; misfires: number };
}

export interface SnagSpike {
  id: string;
  selector: string;
  label?: string;
  /** Snags in the last 24 hours. */
  recent: number;
  /** Median snags per 24 hours over the 7 windows before. */
  median: number;
  /** The count that had to be exceeded. */
  threshold: number;
  /** A change marker logged shortly before the spike began, when there is one. */
  marker?: MarkerRef;
}

const HOUR_MS = 3_600_000;
const median = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Sum of an hour series over [from, to), counting hours outside the series as zero. */
export function sumHours(series: Pick<SnagSeries, 'start' | 'hours'>, from: number, to: number): number {
  let total = 0;
  for (let index = 0; index < series.hours.length; index++) {
    const at = series.start + index * HOUR_MS;
    if (at >= from && at < to) total += Math.max(0, series.hours[index] ?? 0);
  }
  return total;
}

/**
 * Elements whose snags in the last 24 hours exceed the larger of 3 times their trailing 7 day median and 10, with at
 * least 30 visits in those hours. A change marker logged within 24 hours before the window ends relaxes the rule to 2
 * times the median, 6 snags and 20 visits, and is named. Strongest spike first.
 */
export function evaluateSnagSpikes(input: { now: number; series: readonly SnagSeries[]; visitsLast24h: number; markers?: readonly MarkerRef[] }): SnagSpike[] {
  const t = ALERT_THRESHOLDS.snagSpike;
  const windowMs = t.windowHours * HOUR_MS;
  const end = Math.floor(input.now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const start = end - windowMs;
  const marker = [...(input.markers ?? [])].filter(candidate => candidate.at <= input.now && candidate.at >= input.now - t.markerHours * HOUR_MS).sort((a, b) => b.at - a.at)[0];
  const multiplier = marker ? t.markerMultiplier : t.multiplier;
  const minSnags = marker ? t.markerMinSnags : t.minSnags;
  const minVisits = marker ? t.markerMinVisits : t.minVisits;
  if (input.visitsLast24h < minVisits) return [];
  const spikes: SnagSpike[] = [];
  for (const series of input.series) {
    const recent = sumHours(series, start, end);
    const windows = Array.from({ length: t.baselineDays }, (_, index) => sumHours(series, start - (index + 1) * windowMs, start - index * windowMs));
    const typical = median(windows);
    const threshold = Math.max(multiplier * typical, minSnags);
    if (recent > threshold) {
      spikes.push({ id: series.id, selector: series.selector, ...(series.label ? { label: series.label } : {}), recent, median: typical, threshold, ...(marker ? { marker } : {}) });
    }
  }
  return spikes.sort((a, b) => b.recent - b.threshold - (a.recent - a.threshold) || (a.id < b.id ? -1 : 1));
}

/* ----------------------------------------------------------- tracker silence */

export interface SilenceInput {
  now: number;
  /** When the last batch was accepted, epoch ms. Undefined when none ever was. */
  lastAcceptedAt: number | undefined;
  /** Visits per UTC day over the baseline days, oldest first. */
  dailyVisits: readonly number[];
  /** Visits by hour of day (index 0 to 23) summed over `profileDays` days that carry hour data. */
  hourTotals: readonly number[];
  profileDays: number;
  /** Recording is paused for the account, so silence is expected. */
  paused?: boolean;
}

export interface Silence {
  /** Whole hours since the last accepted batch. */
  quietHours: number;
  lastAcceptedAt: number;
  averageDailyVisits: number;
  /** Visits expected in the quiet hours, from the project's own pattern. */
  expectedVisits: number;
}

export function evaluateTrackerSilence(input: SilenceInput): Silence | undefined {
  const t = ALERT_THRESHOLDS.silence;
  if (input.paused || input.lastAcceptedAt === undefined) return undefined;
  const quietMs = input.now - input.lastAcceptedAt;
  if (quietMs < t.hours * HOUR_MS) return undefined;
  const days = input.dailyVisits.slice(-t.baselineDays);
  if (days.length < t.baselineDays) return undefined;
  const averageDailyVisits = days.reduce((sum, value) => sum + value, 0) / days.length;
  if (averageDailyVisits < t.minDailyVisits) return undefined;
  if (input.profileDays < t.minProfileDays) return undefined;
  // The hours of the quiet stretch, in the project's usual rhythm. Only the 6 hours before now are used: a longer
  // silence is still the same alert, and the first 6 hours are the ones that must have been busy.
  let expected = 0;
  for (let index = 1; index <= t.hours; index++) expected += (input.hourTotals[new Date(input.now - index * HOUR_MS).getUTCHours()] ?? 0) / input.profileDays;
  if (expected < t.minExpectedVisits) return undefined;
  return { quietHours: Math.floor(quietMs / HOUR_MS), lastAcceptedAt: input.lastAcceptedAt, averageDailyVisits, expectedVisits: expected };
}

/* ---------------------------------------------------------------- goal drop */

export interface GoalWindow { visits: number; conversions: number }
export interface GoalDrop {
  goalId: string;
  name: string;
  recent: GoalWindow & { rate: number; interval: [number, number] };
  baseline: GoalWindow & { rate: number; interval: [number, number] };
}

/** True when two 95% intervals do not overlap and `a` lies entirely below `b`. */
export const intervalBelow = (a: readonly [number, number], b: readonly [number, number]): boolean => a[1] < b[0];

/**
 * Goals whose conversion rate over the two most recent complete days sits entirely below the 95% Wilson interval of
 * their 14 day baseline, with at least 100 visits in each window. The intervals not overlapping is a conservative
 * bar: a drop that only looks large on a small sample does not pass. A goal that began inside the baseline is
 * compared over the days it existed, and needs the same 100 visits.
 */
export function evaluateGoalDrops(goals: readonly Pick<Goal, 'id' | 'name'>[], recent: Readonly<Record<string, GoalWindow>>, baseline: Readonly<Record<string, GoalWindow>>): GoalDrop[] {
  const t = ALERT_THRESHOLDS.goalDrop;
  const drops: GoalDrop[] = [];
  for (const goal of goals) {
    const r = recent[goal.id];
    const b = baseline[goal.id];
    if (!r || !b || r.visits < t.minVisits || b.visits < t.minVisits) continue;
    const ri = wilsonInterval(r.conversions, r.visits);
    const bi = wilsonInterval(b.conversions, b.visits);
    if (!ri || !bi || !intervalBelow(ri, bi)) continue;
    drops.push({ goalId: goal.id, name: goal.name, recent: { ...r, rate: r.conversions / r.visits, interval: ri }, baseline: { ...b, rate: b.conversions / b.visits, interval: bi } });
  }
  return drops.sort((a, b) => (b.baseline.rate - b.recent.rate) - (a.baseline.rate - a.recent.rate) || (a.goalId < b.goalId ? -1 : 1));
}

/* -------------------------------------------------------------- link tokens */

/** What a signed email link authorises. Each kind is single purpose: a mute link cannot unsubscribe and the reverse. */
export const EMAIL_LINK_KINDS = ['unsubscribe-digest', 'unsubscribe-alerts', 'unsubscribe-first-visit', 'mute-alert'] as const;
export type EmailLinkKind = (typeof EMAIL_LINK_KINDS)[number];
/** A mute lasts this long, and so does the link that sets it. */
export const MUTE_DAYS = 7;
