/*
 * Change markers and goals: the two records behind "make a change, see if it helped".
 *
 * A change marker says that something on the site changed at a time, optionally for one page group. A goal
 * says what counts as a conversion: a click on a matching element, or a visit to a matching page. Both are
 * plain data. The collector counts goal conversions per session at intake, and the impact report compares
 * the days before and after a marker. This module is pure and shared by the API, the MCP service and the
 * dashboard.
 */
import { z } from 'zod';
import { matchesTargetingRule, targetingRuleError } from './targeting';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const idText = z.string().regex(ID);

/* ------------------------------------------------------------ change markers */

export const CHANGE_TITLE_MAX = 120;
export const CHANGE_NOTE_MAX = 1000;
export const CHANGE_SOURCE_MAX = 60;
/** Markers kept per project. Further markers are refused until some are deleted. */
export const MAX_CHANGES = 500;
/** The longest a marker may be dated in the past, in days. */
export const CHANGE_MAX_AGE_DAYS = 400;

export const changeCreatedBySchema = z.enum(['owner', 'agent']);
export type ChangeCreatedBy = z.infer<typeof changeCreatedBySchema>;

/**
 * One logged change. `createdBy` is `owner` for a signed-in owner and `agent` for an access token or an
 * automatic detection (`source` then starts with `auto:`). `release` holds the page version label the change
 * was seen under when it is detected automatically, or the site release the agent gave.
 */
export interface ChangeMarker {
  id: string;
  projectId: string;
  /** When the change went live, epoch milliseconds. */
  at: number;
  title: string;
  note?: string;
  /** Page group id the change applies to. Absent means the whole site. */
  pageGroup?: string;
  release?: string;
  createdBy: ChangeCreatedBy;
  source?: string;
  /** The commit a deploy shipped, when a deploy hook or the GitHub Action logged the change. No author is ever stored. */
  commit?: { sha: string; url?: string };
}

/** POST /v1/projects/:projectId/changes */
export const changeInputSchema = z.object({
  title: z.string().trim().min(1).max(CHANGE_TITLE_MAX),
  note: z.string().trim().min(1).max(CHANGE_NOTE_MAX).optional(),
  pageGroup: z.string().trim().min(1).max(300).optional(),
  release: z.string().trim().min(1).max(100).optional(),
  /** Epoch milliseconds. Defaults to now. */
  at: z.number().int().positive().optional(),
  /** Free text such as `claude-code` or `deploy-script`. */
  source: z.string().trim().min(1).max(CHANGE_SOURCE_MAX).optional(),
  /** The commit the change shipped: a hex sha and, optionally, an https link. Never an author. */
  commit: z.object({
    sha: z.string().trim().regex(/^[0-9a-fA-F]{7,64}$/),
    url: z.string().trim().max(500).regex(/^https:\/\/[^\s@]+$/).optional(),
  }).optional(),
});
export type ChangeInput = z.infer<typeof changeInputSchema>;

/** A marker's `source` when a deploy hook logged it: `deploy:netlify`, `deploy:vercel`, `deploy:generic` or `deploy:github-action`. */
export const DEPLOY_SOURCE_PREFIX = 'deploy:';
export const isDeployChange = (marker: Pick<ChangeMarker, 'source'>): boolean => marker.source?.startsWith(DEPLOY_SOURCE_PREFIX) === true;
/** The provider named by a deploy marker's source, or undefined for any other marker. */
export const deployProviderOf = (marker: Pick<ChangeMarker, 'source'>): string | undefined =>
  isDeployChange(marker) ? marker.source!.slice(DEPLOY_SOURCE_PREFIX.length) || undefined : undefined;

export const isAutoChange = (marker: Pick<ChangeMarker, 'source'>): boolean => marker.source?.startsWith('auto:') === true;
/** A marker's id when it was detected automatically: one per page group and page version. */
export const AUTO_CHANGE_SOURCE = 'auto:content';

/** GET /v1/projects/:projectId/changes?from=&to=&pageGroup=, newest first. */
export interface ChangeList { changes: ChangeMarker[]; }

/* --------------------------------------------------------------------- goals */

export const MAX_GOALS = 20;
export const GOAL_NAME_MAX = 60;
export const GOAL_MATCH_MAX = 200;
export const goalKindSchema = z.enum(['click', 'page']);
export type GoalKind = z.infer<typeof goalKindSchema>;
/** How a click goal finds its element: a CSS selector, a `data-hoot-id`, or text in the element's readable label. */
export const goalByValues = ['selector', 'hootId', 'label'] as const;
export const goalBySchema = z.enum(goalByValues);
export type GoalBy = z.infer<typeof goalBySchema>;

const goalName = z.string().trim().min(1).max(GOAL_NAME_MAX);
const selectorMatch = z.string().trim().min(1).max(GOAL_MATCH_MAX).refine(value => !/[{}<>]/.test(value), 'Invalid selector');
const hootIdMatch = z.string().trim().regex(ID);
const labelMatch = z.string().trim().min(2).max(GOAL_MATCH_MAX);
const pageMatch = z.string().trim().superRefine((rule, ctx) => {
  const message = targetingRuleError(rule);
  if (message) ctx.addIssue({ code: 'custom', message });
});

/** What an owner sends to create or replace a goal. */
const clickGoalSchema = z.discriminatedUnion('by', [
  z.object({ kind: z.literal('click'), name: goalName, by: z.literal('selector'), match: selectorMatch }),
  z.object({ kind: z.literal('click'), name: goalName, by: z.literal('hootId'), match: hootIdMatch }),
  z.object({ kind: z.literal('click'), name: goalName, by: z.literal('label'), match: labelMatch }),
]);
export const goalInputSchema = z.discriminatedUnion('kind', [
  clickGoalSchema,
  z.object({ kind: z.literal('page'), name: goalName, match: pageMatch }),
]);
export type GoalInput = z.infer<typeof goalInputSchema>;

/**
 * A conversion definition. `click` goals match a CSS selector (`a[href^="tel:"]`, evaluated in the browser
 * by the tracker), a `data-hoot-id`, or label text (case-insensitive, contained in the element's label).
 * `page` goals match a page path glob (the page targeting syntax) against the recorded path or its
 * locale-free form. `since` is when counting under this definition began: changing what a goal matches
 * restarts it, so a before window never mixes two definitions.
 */
export type Goal = GoalInput & { id: string; since: number };
export const goalSchema = z.intersection(goalInputSchema, z.object({ id: idText, since: z.number().int().min(0) }));
/** Goals as the tracker receives them: only selector goals are evaluated in the page. */
export const trackerGoalSchema = z.object({ id: idText, selector: selectorMatch });
export type TrackerGoal = z.infer<typeof trackerGoalSchema>;

export const normalizeGoalText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** The click fields a goal can match: the recorded selector, the `data-hoot-id` target, the label and any goal ids the tracker saw. */
export interface GoalClick { selector?: string; target?: string; label?: string; goals?: readonly string[]; }

export function goalMatchesClick(goal: Goal, click: GoalClick): boolean {
  if (goal.kind !== 'click') return false;
  if (goal.by === 'label') return click.label !== undefined && normalizeGoalText(click.label).includes(normalizeGoalText(goal.match));
  if (goal.by === 'hootId') return click.target === goal.match || (click.selector?.includes(`[data-hoot-id="${goal.match}"]`) ?? false);
  // A selector goal is decided in the browser, which can test any ancestor; an equal recorded selector counts too.
  return click.goals?.includes(goal.id) === true || click.selector === goal.match;
}

export interface GoalPage { path: string; /** Locale-free path of the page group. */ groupPath?: string; group?: string; }
export function goalMatchesPage(goal: Goal, page: GoalPage): boolean {
  if (goal.kind !== 'page') return false;
  return matchesTargetingRule(goal.match, page.path) || (page.groupPath !== undefined && matchesTargetingRule(goal.match, page.groupPath));
}

/**
 * Goal ids a batch converts. Click goals look at the batch's clicks; page goals look at the page view and are
 * only tested on the first batch of a page view. The result is distinct and in goal order.
 */
export function goalsHit(
  goals: readonly Goal[] | undefined,
  input: { clicks: readonly GoalClick[]; page?: GoalPage },
): string[] {
  if (!goals?.length) return [];
  const hit: string[] = [];
  for (const goal of goals) {
    const matched = goal.kind === 'click'
      ? input.clicks.some(click => goalMatchesClick(goal, click))
      : input.page !== undefined && goalMatchesPage(goal, input.page);
    if (matched) hit.push(goal.id);
  }
  return hit;
}

/** Selector goals, the only ones the tracker has to evaluate in the page. */
export function trackerGoals(goals: readonly Goal[] | undefined): TrackerGoal[] {
  return (goals ?? []).flatMap(goal => (goal.kind === 'click' && goal.by === 'selector' ? [{ id: goal.id, selector: goal.match }] : []));
}

export const goalSummary = (goal: Pick<Goal, 'kind' | 'match'> & { by?: GoalBy }): string =>
  goal.kind === 'page' ? `Visit to ${goal.match}`
    : goal.by === 'label' ? `Click on "${goal.match}"` : goal.by === 'hootId' ? `Click on data-hoot-id ${goal.match}` : `Click on ${goal.match}`;

/** GET /v1/projects/:projectId/goals */
export interface GoalList { goals: Goal[]; }

/** One goal's conversions over a period, counted per session. */
export interface GoalStat {
  goalId: string;
  name: string;
  kind: GoalKind;
  /** Sessions in the period. */
  sessions: number;
  /** Sessions that converted. */
  conversions: number;
  /** conversions / sessions, or null with no sessions. */
  rate: number | null;
  /** 95% Wilson interval of `rate`. */
  interval: [number, number] | null;
  /** When counting under the goal's current definition began. Sessions before it are not counted. */
  since: number;
}
/** GET /v1/projects/:projectId/goals/stats?from=&to= */
export interface GoalStats { from: number; to: number; sessions: number; goals: GoalStat[]; }
