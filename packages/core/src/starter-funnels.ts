/*
 * Starter funnels: what to suggest when a site has goals but no funnels. Pure. Two kinds:
 * - homepage: from the homepage to one goal ("Homepage to Request a tour"), the plainest question a funnel answers.
 * - visit-order: every goal in the order visitors usually reach them, when the visits show a clear order.
 * Each suggestion carries a settings change, ready for preview_settings_change.
 */
import type { Goal, GoalInput } from './changes';
import { FUNNEL_MAX_STEPS, FUNNEL_NAME_MAX, type Funnel } from './funnels';
import type { SettingsChange } from './settings-change';

export const HOMEPAGE_GOAL_NAME = 'Visit the homepage';
/** Homepage funnels suggested at most, so the list stays short. */
export const STARTER_HOMEPAGE_FUNNELS = 3;
/** Sessions that hit two goals a pair needs before their order counts as data. */
export const STARTER_MIN_PAIR_SESSIONS = 20;

export interface FunnelSuggestion {
  name: string;
  basis: 'homepage' | 'visit-order';
  /** Goal names in step order. */
  steps: string[];
  /** One sentence on why this funnel, in observed terms. */
  reason: string;
  /** Pass this to preview_settings_change (or POST /settings-changes/preview) to create the funnel. It also adds the homepage goal when the site has none. */
  change: SettingsChange;
}

/** How often goal `a` was first reached before goal `b` in the same visit, and how many visits reached both. */
export interface PairOrder { before: number; after: number }
/** Keyed `${a}|${b}` for the goal ids in sorted order. */
export type PairOrders = ReadonlyMap<string, PairOrder>;
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const isHomepage = (goal: Goal): boolean => goal.kind === 'page' && goal.match === '/';
const clip = (text: string): string => (text.length > FUNNEL_NAME_MAX ? `${text.slice(0, FUNNEL_NAME_MAX - 1)}…` : text);

/**
 * Orders goals by how visits reached them: goal A comes before B when more of the visits that reached both reached A
 * first. Returns undefined unless every adjacent pair has STARTER_MIN_PAIR_SESSIONS visits and a clear majority (at least 60%).
 */
export function goalsInVisitOrder(goals: readonly Goal[], pairs: PairOrders): Goal[] | undefined {
  const wins = new Map(goals.map(goal => [goal.id, 0]));
  const decided = (a: Goal, b: Goal): Goal | undefined => {
    const order = pairs.get(pairKey(a.id, b.id));
    if (!order) return undefined;
    const total = order.before + order.after;
    if (total < STARTER_MIN_PAIR_SESSIONS) return undefined;
    const aFirst = a.id < b.id ? order.before : order.after;
    const share = aFirst / total;
    return share >= 0.6 ? a : share <= 0.4 ? b : undefined;
  };
  for (const [index, a] of goals.entries()) {
    for (const b of goals.slice(index + 1)) {
      const winner = decided(a, b);
      if (winner) wins.set(winner.id, (wins.get(winner.id) ?? 0) + 1);
    }
  }
  const ordered = [...goals].sort((a, b) => (wins.get(b.id) ?? 0) - (wins.get(a.id) ?? 0) || a.since - b.since || (a.id < b.id ? -1 : 1));
  // Every adjacent pair must have been decided in that order, or the order is a guess.
  for (let index = 0; index < ordered.length - 1; index++) if (decided(ordered[index]!, ordered[index + 1]!)?.id !== ordered[index]!.id) return undefined;
  return ordered;
}

/**
 * Suggestions for a site with goals and no funnels. Empty when it has funnels, fewer than one non-homepage goal, or
 * when `existing` already has a funnel (the caller passes the site's funnels so a stale call stays quiet).
 */
export function suggestStarterFunnels(goals: readonly Goal[], existing: readonly Funnel[], pairs?: PairOrders): FunnelSuggestion[] {
  if (existing.length || !goals.length) return [];
  const homepage = goals.find(isHomepage);
  const targets = goals.filter(goal => !isHomepage(goal));
  const out: FunnelSuggestion[] = [];

  for (const target of targets.slice(0, STARTER_HOMEPAGE_FUNNELS)) {
    const name = clip(`Homepage to ${target.name}`);
    const add: GoalInput[] = homepage ? [] : [{ kind: 'page', name: HOMEPAGE_GOAL_NAME, match: '/' }];
    out.push({
      name, basis: 'homepage', steps: [homepage?.name ?? HOMEPAGE_GOAL_NAME, target.name],
      reason: `Shows how many visits that reach the homepage go on to "${target.name}"${homepage ? '' : `. This also adds the goal "${HOMEPAGE_GOAL_NAME}" (a visit to /), counted from now`}.`,
      change: { ...(add.length ? { goals: { add } } : {}), funnels: { add: [{ name, steps: [homepage?.id ?? HOMEPAGE_GOAL_NAME, target.id] }] } },
    });
  }

  if (pairs && goals.length >= 2) {
    const ordered = goalsInVisitOrder(goals.slice(0, FUNNEL_MAX_STEPS), pairs);
    if (ordered) {
      const name = clip(`${ordered[0]!.name} to ${ordered[ordered.length - 1]!.name}`);
      out.push({
        name, basis: 'visit-order', steps: ordered.map(goal => goal.name),
        reason: 'Visits that reached more than one of these goals usually reached them in this order.',
        change: { funnels: { add: [{ name, steps: ordered.map(goal => goal.id) }] } },
      });
    }
  }
  return out;
}
