/*
 * Saved segments: a named set of recording filters stored on the project.
 *
 * A saved segment adds no tracking. It is a shortcut for the filters the recordings API already
 * understands, so listing with `segmentId` is the same as passing those filters. Filters sent with
 * the request replace the saved ones, field by field. This module is pure and shared by the API,
 * the MCP service and the dashboard.
 */
import { z } from 'zod';
import { AD_NETWORKS, CHANNELS, IN_APPS } from './sources';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const DAY_MS = 86_400_000;

export const MAX_SAVED_SEGMENTS = 50;
export const SAVED_SEGMENT_NAME_MAX = 60;
/** The longest "last N days" a segment can keep, matching the longest traffic range. */
export const SAVED_SEGMENT_MAX_DAYS = 92;

/**
 * The recording filters a segment can hold. `sinceDays` is relative ("the last 14 days"), so a saved
 * segment stays useful tomorrow. `controlled` is not saved: it follows the dashboard's visitor/controlled switch.
 */
export const savedSegmentFiltersSchema = z.object({
  path: z.string().startsWith('/').max(300).optional(),
  group: z.string().min(1).max(300).optional(),
  locale: z.string().regex(/^(?:[a-z]{2,3})$/).optional(),
  variant: z.string().min(1).max(100).optional(),
  deviceClass: z.enum(['desktop', 'tablet', 'mobile']).optional(),
  minDurationMs: z.number().int().min(1).max(30 * DAY_MS).optional(),
  signal: z.enum(['rage', 'dead', 'error']).optional(),
  utmSource: z.string().trim().min(1).max(100).optional(),
  utmCampaign: z.string().trim().min(1).max(100).optional(),
  referrer: z.string().trim().min(1).max(200).optional(),
  browser: z.enum(['chrome', 'safari', 'firefox', 'edge', 'other']).optional(),
  os: z.enum(['windows', 'macos', 'ios', 'android', 'linux', 'other']).optional(),
  newVisitor: z.boolean().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  subdivision: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/).optional(),
  channel: z.enum(CHANNELS).optional(),
  adNetwork: z.enum(AD_NETWORKS).optional(),
  inApp: z.enum(IN_APPS).optional(),
  entryPage: z.string().startsWith('/').max(200).optional(),
  sinceDays: z.number().int().min(1).max(SAVED_SEGMENT_MAX_DAYS).optional(),
}).strict();
export type SavedSegmentFilters = z.infer<typeof savedSegmentFiltersSchema>;

/** What an editor sends to create or replace a saved segment. At least one filter is required. */
export const savedSegmentInputSchema = z.object({
  name: z.string().trim().min(1).max(SAVED_SEGMENT_NAME_MAX),
  filters: savedSegmentFiltersSchema,
}).refine(input => Object.values(input.filters).some(value => value !== undefined), { message: 'Choose at least one filter', path: ['filters'] });
export type SavedSegmentInput = z.infer<typeof savedSegmentInputSchema>;

export type SavedSegment = SavedSegmentInput & { id: string; createdAt: number };
export const savedSegmentIdSchema = z.string().regex(ID);

/** GET /v1/projects/:projectId/segments */
export interface SavedSegmentList { segments: SavedSegment[]; }

/**
 * Applies a saved segment's filters under the request's own: a filter present in `request` wins.
 * `sinceDays` becomes a `from` time unless the request already has one.
 */
export function mergeSegmentFilters<T extends { from?: number }>(request: T, filters: SavedSegmentFilters, now = Date.now()): T {
  const { sinceDays, ...rest } = filters;
  const merged: Record<string, unknown> = { ...rest };
  for (const [key, value] of Object.entries(request)) if (value !== undefined) merged[key] = value;
  if (sinceDays !== undefined && request.from === undefined) merged.from = now - sinceDays * DAY_MS;
  return merged as T;
}
