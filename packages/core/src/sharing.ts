/*
 * Share links for one recording, one whole session or one heatmap cohort. A link is a random token shown once;
 * only its SHA-256 hash is stored. The public endpoints take the token in a POST body and return only the shared
 * resource. A link stops working when it is revoked or expires, when the shared recording is deleted, or when its
 * creator no longer has the annotate permission on the project.
 */
import { z } from 'zod';
import type { HeatmapAggregate, Narrative, Recording, RecordingSummary } from './index';

export const SHARE_KINDS = ['recording', 'session', 'heatmap'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
export const SHARE_EXPIRY_DAYS = [1, 7, 30] as const;
export const SHARE_DEFAULT_DAYS = 7;
/** Live (unrevoked, unexpired) links one project can hold. */
export const SHARE_MAX_ACTIVE = 100;
export const SHARE_TOKEN_PREFIX = 'hl_shr_';
export const SHARE_TOKEN_PATTERN = /^hl_shr_[A-Za-z0-9_-]{43}$/;

export const shareInputSchema = z.object({
  kind: z.enum(SHARE_KINDS),
  /** A recording ID, a session ID, or a heatmap cohort key. */
  target: z.string().min(1).max(2000),
  expiresInDays: z.union(SHARE_EXPIRY_DAYS.map(days => z.literal(days)) as [z.ZodLiteral<1>, z.ZodLiteral<7>, z.ZodLiteral<30>]).default(SHARE_DEFAULT_DAYS),
});
export type ShareInput = z.infer<typeof shareInputSchema>;
export const shareTokenSchema = z.object({ token: z.string().regex(SHARE_TOKEN_PATTERN) });
export const shareEventsSchema = shareTokenSchema.extend({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) });

/** A share link as stored. */
export interface ShareLinkRecord {
  id: string;
  projectId: string;
  /** The person who made the link. Their role is checked again every time the link is opened. */
  creatorId: string;
  kind: ShareKind;
  /** The recording ID, session ID, or canonical heatmap cohort key. */
  target: string;
  /** A short description for the owner's list, such as the page path. */
  label: string;
  hash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

/** What the dashboard lists. The token and its hash are never listed. */
export interface ShareSummary {
  id: string;
  kind: ShareKind;
  label: string;
  createdAt: number;
  expiresAt: number;
  /** True when the caller made it. */
  mine: boolean;
  /** Who made it, shown to the owner for links that are not theirs: the member's email. */
  creator?: string;
}

/** A page view as a shared link shows it: no project ID, tags or other project data. */
export type SharedSegment = Omit<RecordingSummary, 'projectId' | 'tags'>;
export type SharedRecording = Omit<Recording, 'projectId' | 'tags'>;

/** POST /v1/share/recording */
export interface SharedRecordingView {
  kind: 'recording' | 'session';
  expiresAt: number;
  /** One page view for a recording link, every available page view of the visit for a session link. */
  segments: SharedSegment[];
  narrative?: Narrative;
}
/** POST /v1/share/recording/events */
export interface SharedRecordingDetail { recording: SharedRecording; events: unknown[] }

/** POST /v1/share/heatmap. The cohort key and the reference recording's ID stay on the server. */
export interface SharedHeatmapView {
  expiresAt: number;
  heatmap: Omit<HeatmapAggregate, 'key' | 'reference'> & { reference?: { timestamp: number } };
}
/** POST /v1/share/heatmap/reference */
export interface SharedHeatmapReference { events: unknown[]; timestamp: number }

/** A copy of `value` without the named fields, for responses that must not carry them. */
export function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}
