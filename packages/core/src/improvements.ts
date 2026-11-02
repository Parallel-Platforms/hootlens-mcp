import { z } from 'zod';

export const IMPROVEMENT_KINDS = ['element', 'javascript-error', 'funnel-dropoff'] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];
export const IMPROVEMENT_SIGNAL_LABELS = { repeated: 'pile-up', unresponsive: 'no-show', misfires: 'misfire' } as const;

const identifier = z.string().min(1).max(200);
export const improvementContextSchema = z.object({
  pageGroup: z.string().min(1).max(300),
  version: z.string().max(200),
  /** Raw release is preserved separately when the source actually retains it. */
  release: z.string().max(100).optional(),
  revision: z.string().max(150).nullable(),
  variant: z.string().max(100),
  variantScope: z.enum(['single', 'pooled', 'unknown']),
  deviceClass: z.enum(['desktop', 'tablet', 'mobile', 'unknown']),
  locale: z.string().max(100).optional(),
}).strict();
export type ImprovementContext = z.infer<typeof improvementContextSchema>;
export const improvementGoalDefinitionsSchema = z.array(z.object({ id: identifier, since: z.number().int().min(0) }).strict()).min(2).max(8);

/** Retained work keeps identifiers only, never labels, messages, counts, or replay moments. */
export const improvementSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('element'), context: improvementContextSchema, cohortKey: z.string().min(1).max(2000), selector: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal('javascript-error'), context: improvementContextSchema, fingerprint: z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
  z.object({
    kind: z.literal('funnel-dropoff'), context: improvementContextSchema,
    funnelId: identifier, stepGoalId: identifier, nextGoalId: identifier,
    goalDefinitions: improvementGoalDefinitionsSchema,
  }).strict(),
]);
export type ImprovementSource = z.infer<typeof improvementSourceSchema>;

/** Stable tuple order makes a source's server hash independent of JSON object insertion order. */
export function improvementSourceKey(input: ImprovementSource): string {
  const source = improvementSourceSchema.parse(input);
  const context = source.context;
  const tuple = [context.pageGroup, context.version, context.release ?? null, context.revision, context.variant, context.variantScope, context.deviceClass, context.locale ?? null];
  if (source.kind === 'element') return JSON.stringify([source.kind, tuple, source.cohortKey, source.selector]);
  if (source.kind === 'javascript-error') return JSON.stringify([source.kind, tuple, source.fingerprint]);
  return JSON.stringify([source.kind, tuple, source.funnelId, source.stepGoalId, source.nextGoalId, source.goalDefinitions.map(goal => [goal.id, goal.since])]);
}

export interface ImprovementEvidence {
  recordingId: string;
  at: number;
  kind: 'rage-click' | 'dead-click' | 'error-click' | 'javascript-error' | 'funnel-step';
}
export interface ImprovementCoverage {
  status: 'available' | 'partial';
  notes: string[];
  /** Absent for cumulative retained element counters, which have no date axis. */
  from?: number;
  to?: number;
}
export interface ImprovementFinding {
  id: string;
  kind: ImprovementKind;
  title: string;
  observed: string;
  nextStep: string;
  source: ImprovementSource;
  counts: {
    value: number;
    unit: 'snag-events' | 'page-views' | 'sessions';
    /** Bounded selector shard candidates can omit part of an element's retained total. */
    lowerBound?: boolean;
    denominator?: { value: number; unit: 'clicks' | 'sessions' };
  };
  /** Element signal counts are events, not a distinct visitor or session count. */
  signals?: { repeated: number; unresponsive: number; misfires: number };
  evidence: ImprovementEvidence[];
  coverage: ImprovementCoverage;
  lastSeenAt: number;
}
export interface ImprovementSourceCoverage {
  status: 'available' | 'partial' | 'unavailable' | 'disabled';
  notes: string[];
  from?: number;
  to?: number;
  limit?: number;
}
export interface ImprovementFeed {
  items: ImprovementFinding[];
  generatedAt: number;
  sources: Record<'elements' | 'errors' | 'funnels', ImprovementSourceCoverage>;
}
