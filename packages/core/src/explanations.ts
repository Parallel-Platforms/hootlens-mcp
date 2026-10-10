import { z } from 'zod';
import type { DeviceClass } from './index.js';

/*
 * AI snag explanations. The API sends OpenAI an aggregated summary (ExplanationInput) and shows the
 * validated answer next to the evidence. Nothing here carries recordings, events, DOM text, URLs with
 * queries, visitor identifiers or referrers. See docs/AI.md.
 */

/** Per-project switch, stored as `Project.ai`. Absent means off. */
export const aiSettingsSchema = z.object({ explanations: z.boolean() });
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export const projectAi = (project: { ai?: AiSettings }): AiSettings => project.ai ?? { explanations: false };
/** New full and balanced projects start with explanations on; strict starts off. */
export const defaultAiSettings = (preset: 'full' | 'balanced' | 'strict'): AiSettings => ({ explanations: preset !== 'strict' });

/** POST /v1/projects/:projectId/explanations body. The cohort key is the heatmap key; the selector is optional. */
export const explanationRequestSchema = z.object({
  cohortKey: z.string().min(1).max(2000),
  selector: z.string().trim().min(1).max(300).optional(),
});
export type ExplanationRequest = z.infer<typeof explanationRequestSchema>;

export interface ExplanationElementInput {
  selector: string;
  /** Present only when the privacy policy allows labels (never under strict). */
  label?: string;
  clicks: number;
  clickSharePercent: number | null;
  /** Pile-ups, no-shows and misfires together. */
  snags: number;
  pileUps: number;
  noShows: number;
  misfires: number;
}
export interface ExplanationComparisonInput {
  release: string;
  variant: string;
  visits: number;
  clicks: number;
  snagClicks: number;
  snagSharePercent: number | null;
  /** This cohort's snag share minus the other's, in percentage points. */
  snagShareChangePoints: number | null;
  /** The same element in the other cohort, when it is listed there. */
  element?: { clicks: number; pileUps: number; noShows: number; misfires: number };
}
/** The exact summary sent to the model. Built field by field, so nothing else can be added by accident. */
export interface ExplanationInput {
  schemaVersion: 1;
  scope: 'element' | 'page';
  cohort: {
    pathTemplate: string; deviceClass: DeviceClass; release: string; variant: string;
    visits: number; pageViews: number; clicks: number; snagClicks: number; snagSharePercent: number | null;
  };
  snagTotals: { pileUps: number; noShows: number; misfires: number };
  elements: ExplanationElementInput[];
  scrollReach: { atPercent: number; reachedPercent: number }[];
  comparison?: ExplanationComparisonInput;
  definitions: { pileUp: string; noShow: string; misfire: string };
}

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number];
export interface ExplanationContent {
  title: string;
  /** What the data shows, with counts. */
  observation: string;
  /** Hedged possibilities, 1 to 3. */
  likelyCauses: string[];
  /** Concrete changes to try, 1 to 3. */
  suggestedFixes: string[];
  /** What to look for when watching the example recordings, 1 to 3. */
  recordingChecks: string[];
  confidence: { level: ConfidenceLevel; reason: string };
}
export interface ExplanationExample {
  recordingId: string;
  startedAt: number;
  /** When the first snag of the example happened, epoch ms. Absent on examples recorded before this was kept; open the recording at its start then. */
  at?: number;
  /** First snag time per element in the example, so a link for one element opens at that element's snag. */
  elements?: { selector: string; at: number }[];
  signals: ('rage' | 'dead' | 'error')[];
}
export type ExplanationFallbackReason = 'not_configured' | 'timeout' | 'upstream_error' | 'rejected';
/** Rule-based text shown when the model is unavailable or its answer failed validation. */
export interface ExplanationFallback {
  reason: ExplanationFallbackReason;
  title: string;
  observation: string;
  suggestions: string[];
}
/** POST /v1/projects/:projectId/explanations */
export interface ExplanationResponse {
  status: 'generated' | 'cached' | 'fallback';
  explanation?: ExplanationContent;
  model?: string;
  generatedAt?: number;
  fallback?: ExplanationFallback;
  /** Exactly what was (or would have been) sent to the model. */
  input: ExplanationInput;
  /** Recent recordings of the same page group with snags. Only for owners and replay-scoped tokens. Never sent to the model. */
  examples: ExplanationExample[];
}
