/*
 * Funnels: an ordered list of existing goals, and how many sessions got through them in order.
 *
 * A funnel adds no new tracking. Each step is a goal, so the collector's goal matching and its one-hit-per-session
 * records are the data. A session reaches step k only if it hit goals 1 to k, each first hit at or after the
 * previous step's first hit. This module is pure and shared by the API, the MCP service and the dashboard.
 */
import { z } from 'zod';
import { goalSummary, type Goal, type GoalKind } from './changes';
import { rateSide } from './impact';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const idText = z.string().regex(ID);

export const MAX_FUNNELS = 20;
export const FUNNEL_NAME_MAX = 60;
export const FUNNEL_MIN_STEPS = 2;
export const FUNNEL_MAX_STEPS = 8;
/** Example sessions returned for each drop-off. */
export const FUNNEL_EXAMPLES = 5;
/** Sessions that entered a funnel are read up to this many (newest first); beyond it the report says so. */
export const FUNNEL_MAX_SESSIONS = 5000;

/** What an owner sends to create or replace a funnel. Each step names a goal that exists in the project. */
export const funnelInputSchema = z.object({
  name: z.string().trim().min(1).max(FUNNEL_NAME_MAX),
  steps: z.array(z.object({ goalId: idText })).min(FUNNEL_MIN_STEPS).max(FUNNEL_MAX_STEPS),
}).refine(input => new Set(input.steps.map(step => step.goalId)).size === input.steps.length, { message: 'A goal can be used once in a funnel', path: ['steps'] });
export type FunnelInput = z.infer<typeof funnelInputSchema>;

export const funnelSchema = z.intersection(funnelInputSchema, z.object({ id: idText, createdAt: z.number().int().min(0) }));
export type Funnel = FunnelInput & { id: string; createdAt: number };

/** GET /v1/projects/:projectId/funnels */
export interface FunnelList { funnels: Funnel[]; }

/** Cohort filters. Each matches the page view where the session reached step 1, so cohorts stay separate. */
export interface FunnelFilters {
  pageGroup?: string;
  deviceClass?: 'desktop' | 'tablet' | 'mobile';
  locale?: string;
  variant?: string;
  pageVersion?: string;
}

/** A goal's first hit in one session. */
export interface FunnelHit { at: number; recordingId?: string; /** Device class and language of the page view where the goal was hit. */ device?: string; locale?: string; }
/** One session's hits on the funnel's goals, plus the page context where it hit the first one. */
export interface FunnelSession {
  sessionId: string;
  hits: Readonly<Record<string, FunnelHit>>;
  entry: { group?: string; device?: string; variant?: string; locale?: string; version?: string };
}

export interface FunnelRate { rate: number | null; /** 95% Wilson interval. */ interval: [number, number] | null; }
/** One example of a visit that stopped: the session, and the page view and moment where it last reached the funnel. */
export interface FunnelExample { sessionId: string; recordingId?: string; device?: string; locale?: string; /** When the session reached this step, epoch ms. */ at: number; }
export interface FunnelDropOff {
  /** Sessions that reached this step and not the next. */
  count: number;
  /** Up to FUNNEL_EXAMPLES session ids, most recent first. */
  exampleSessionIds: string[];
  /** The same sessions with the recording and time of their last step, to open the replay at that moment. */
  examples: FunnelExample[];
}
export interface FunnelStepStat {
  index: number;
  goalId: string;
  /** The goal's name. */
  name: string;
  goalKind: GoalKind;
  /** Plain description of what the goal matches. */
  description: string;
  /** When counting under this goal's current definition began. */
  since: number;
  /** Sessions that reached this step. */
  reached: number;
  /** Of the previous step's sessions. Null on step 1. */
  fromPrevious: FunnelRate | null;
  /** Of the sessions that reached step 1. */
  fromFirst: FunnelRate;
  /** Sessions lost between this step and the next. Absent on the last step. */
  dropOff?: FunnelDropOff;
}
export interface FunnelStats {
  funnelId: string;
  name: string;
  /** The requested window, epoch ms. */
  from: number;
  to: number;
  /** The window actually measured: `from` raised to the latest goal start, and `to`. */
  effectiveFrom: number;
  effectiveTo: number;
  /** Sessions that reached step 1 in the window. */
  sessions: number;
  /** True when more than FUNNEL_MAX_SESSIONS sessions entered and only the newest were counted. */
  truncated: boolean;
  filters: FunnelFilters;
  steps: FunnelStepStat[];
  /** Plain-language limits that apply to these numbers. */
  notes: string[];
}

export function entryMatches(session: FunnelSession, filters: FunnelFilters): boolean {
  const entry = session.entry;
  return (filters.pageGroup === undefined || entry.group === filters.pageGroup)
    && (filters.deviceClass === undefined || entry.device === filters.deviceClass)
    && (filters.locale === undefined || entry.locale === filters.locale)
    && (filters.variant === undefined || entry.variant === filters.variant)
    && (filters.pageVersion === undefined || entry.version === filters.pageVersion);
}

/**
 * Computes a funnel from the sessions that hit its first goal. Pure: `goals` are the project's goals (every
 * step must exist), `sessions` carry each goal's first hit. A hit before its goal's `since` is ignored, so a
 * goal whose definition changed never counts under the old one. Sessions are examined newest entry first.
 */
export function computeFunnel(
  funnel: Pick<Funnel, 'id' | 'name' | 'steps'>,
  goals: readonly Goal[],
  sessions: readonly FunnelSession[],
  window: { from: number; to: number; filters?: FunnelFilters; truncated?: boolean },
): FunnelStats {
  const filters = window.filters ?? {};
  const steps = funnel.steps.map(step => {
    const goal = goals.find(candidate => candidate.id === step.goalId);
    if (!goal) throw new Error(`Goal ${step.goalId} not found`);
    return goal;
  });
  const lastStart = Math.max(...steps.map(goal => goal.since));
  const effectiveFrom = Math.max(window.from, lastStart);
  const reachedBy: string[][] = steps.map(() => []);
  const hitOf = new Map<string, FunnelHit>();
  const entries = new Map<string, number>();
  for (const session of sessions) {
    if (!entryMatches(session, filters)) continue;
    let previous = -Infinity;
    for (const [index, goal] of steps.entries()) {
      const hit = session.hits[goal.id];
      if (!hit || hit.at < goal.since || hit.at < previous) break;
      if (index === 0 && (hit.at < effectiveFrom || hit.at > window.to)) break;
      previous = hit.at;
      reachedBy[index]!.push(session.sessionId);
      hitOf.set(`${index}|${session.sessionId}`, hit);
      if (index === 0) entries.set(session.sessionId, hit.at);
    }
  }
  const examplesOf = (ids: readonly string[], index: number): FunnelExample[] =>
    [...ids].sort((a, b) => (entries.get(b) ?? 0) - (entries.get(a) ?? 0)).slice(0, FUNNEL_EXAMPLES).map(sessionId => {
      const hit = hitOf.get(`${index}|${sessionId}`)!;
      return { sessionId, ...(hit.recordingId ? { recordingId: hit.recordingId } : {}), ...(hit.device ? { device: hit.device } : {}), ...(hit.locale ? { locale: hit.locale } : {}), at: hit.at };
    });
  const first = reachedBy[0]!.length;
  const stats: FunnelStepStat[] = steps.map((goal, index) => {
    const reached = reachedBy[index]!.length;
    const previousReached = index === 0 ? 0 : reachedBy[index - 1]!.length;
    const side = (of: number): FunnelRate => { const value = rateSide(of, reached); return { rate: value.rate, interval: value.interval }; };
    const step: FunnelStepStat = {
      index, goalId: goal.id, name: goal.name, goalKind: goal.kind, description: goalSummary(goal), since: goal.since, reached,
      fromPrevious: index === 0 ? null : side(previousReached), fromFirst: side(first),
    };
    if (index < steps.length - 1) {
      const next = new Set(reachedBy[index + 1]);
      const dropped = reachedBy[index]!.filter(id => !next.has(id));
      const examples = examplesOf(dropped, index);
      step.dropOff = { count: dropped.length, exampleSessionIds: examples.map(example => example.sessionId), examples };
    }
    return step;
  });
  const notes = [
    'A session reaches a step only after reaching the steps before it, each first hit at or after the previous one. A visitor who did a later step first is not counted for it.',
    'Counts are sessions whose first step fell in the window. Later steps count whenever they happened.',
  ];
  if (effectiveFrom > window.from) notes.push('Counting began after the start of the range because a step goal was created or changed then, so earlier sessions are not measured.');
  if (window.truncated) notes.push(`More than ${FUNNEL_MAX_SESSIONS} sessions entered this funnel. Only the newest ${FUNNEL_MAX_SESSIONS} are counted.`);
  return {
    funnelId: funnel.id, name: funnel.name, from: window.from, to: window.to, effectiveFrom, effectiveTo: window.to,
    sessions: first, truncated: window.truncated === true, filters, steps: stats, notes,
  };
}
