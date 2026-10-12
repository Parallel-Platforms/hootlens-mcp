/*
 * JavaScript errors: the intake schema and the shapes the API, dashboard and MCP tools share. The capture rules
 * (parsing, scrubbing, hashing, linking) are in error-capture.ts, which has no dependencies.
 */
import { z } from 'zod';
import { ERROR_LIMITS, type ErrorFrame, type RecordedError } from './error-capture';

export * from './error-capture';

export const errorFrameSchema = z.object({
  url: z.string().max(ERROR_LIMITS.url).optional(),
  line: z.number().int().min(0).max(10_000_000).optional(),
  col: z.number().int().min(0).max(10_000_000).optional(),
  fn: z.string().max(ERROR_LIMITS.fn).optional(),
});

/** One error as the tracker sends it in a batch. The collector checks it against the project's privacy policy. */
export const recordedErrorSchema = z.object({
  at: z.number().int().positive(),
  kind: z.enum(['error', 'rejection']),
  name: z.string().regex(/^[A-Za-z_$][\w$.:-]{0,59}$/),
  message: z.string().max(ERROR_LIMITS.message).optional(),
  messageHash: z.string().regex(/^[0-9a-f]{16}$/),
  opaque: z.literal(true).optional(),
  frames: z.array(errorFrameSchema).max(ERROR_LIMITS.frames),
  clickAt: z.number().int().positive().optional(),
  selector: z.string().max(ERROR_LIMITS.selector).optional(),
});
export const recordedErrorsSchema = z.array(recordedErrorSchema).max(ERROR_LIMITS.perPageView);

/* ---------------------------------------------------------------- API shapes */

/** A stack frame mapped to the original source through the release's source map. */
export interface ResolvedFrame {
  /** Path inside the project's source, never absolute: `src/cart/total.ts`. */
  source: string;
  line: number;
  col?: number;
  /** Original function or variable name, when the map names it. */
  name?: string;
  /** Lines around `line`, only when the map embeds the source. */
  context?: { line: number; text: string }[];
}
export interface StackFrameView extends ErrorFrame {
  resolved?: ResolvedFrame;
}

/** An error of a page view, for the replay timeline and the narrative. */
export interface RecordingError extends RecordedError {
  /** The error group's id: the fingerprint of name, normalized message and top frame. */
  id: string;
  /** `src/cart/total.ts:42` when a source map resolved the top frame, else the script file and position. */
  location?: string;
  frames: StackFrameView[];
}

export interface ErrorCount { key: string; count: number }
export interface ErrorExample {
  /** Page view the error happened in. Present only for callers with the replay scope. */
  recordingId?: string;
  /** When it happened, epoch ms. */
  at: number;
  /** Milliseconds from the start of the page view, the position to seek to. Present with recordingId. */
  offsetMs?: number;
}
/** An error that followed clicks on an element within the link window (see ERROR_LINK_WINDOW_MS), as findings report it. */
export interface LinkedError {
  /** The error group's id; read it with GET /errors/:errorId or get_error. */
  id: string;
  name: string;
  message?: string;
  /** `src/cart/total.ts:42` when a source map resolved it. */
  location?: string;
  /** Page views in which it followed a click on the element. */
  count: number;
}
/** Elements whose click was followed by this error within the link window. */
export interface ErrorFollowed { selector: string; label?: string; name?: string; count: number }

export interface ErrorGroup {
  /** The fingerprint: a 16-digit hex id of the error's name, normalized message and top stack frame. */
  id: string;
  name: string;
  /** Absent under strict, where only the message hash is kept. */
  message?: string;
  messageHash: string;
  kind: 'error' | 'rejection';
  /** True for the browser's "Script error." for a cross-origin script. */
  opaque?: true;
  /** `src/cart/total.ts:42` when a source map resolved it, else the script file with line and column. */
  location?: string;
  topFrame?: StackFrameView;
  /** Page views that hit it (an error counts once per page view) and distinct visits. */
  count: number;
  visits: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Each dimension is counted on its own; a release, revision, variant, page group or device class is never merged with another. */
  releases: ErrorCount[];
  pageRevisions: ErrorCount[];
  variants: ErrorCount[];
  pageGroups: ErrorCount[];
  deviceClasses: ErrorCount[];
  followedClicks: ErrorFollowed[];
  examples: ErrorExample[];
}

/** GET /v1/projects/:projectId/errors?from=&to=&group=&release=&deviceClass=&limit= */
export interface ErrorList {
  from: number;
  to: number;
  /** False when the site has not turned error recording on: nothing is recorded, so the list is empty. */
  recording: boolean;
  errors: ErrorGroup[];
  /** Groups left out by `limit`. */
  more: number;
  /** Occurrences that could not be kept because a day already held the most distinct errors it can. */
  dropped?: number;
}

/** One cohort an error appeared in: page group, release, page revision, variant and device class together. */
export interface ErrorCohort {
  pageGroup: string;
  release: string;
  pageVersion?: string;
  pageRevision: string;
  variant: string;
  deviceClass: 'desktop' | 'tablet' | 'mobile';
  count: number;
  visits: number;
  lastSeenAt: number;
}

/** GET /v1/projects/:projectId/errors/:errorId */
export interface ErrorDetail extends ErrorGroup {
  stack: StackFrameView[];
  /** True when frames were mapped to original source with an uploaded source map. */
  mapped: boolean;
  /** The most recent cohorts, newest first, at most 50. */
  cohorts: ErrorCohort[];
}

/** Source maps the project holds for a release. File names only, never contents. */
export interface SourceMapRelease {
  release: string;
  files: number;
  bytes: number;
  uploadedAt: number;
  /** True when the maps embed the original source (sourcesContent), so errors can show a few lines of it. */
  hasSourceContent: boolean;
}
/** GET /v1/projects/:projectId/sourcemaps */
export interface SourceMapList { releases: SourceMapRelease[] }
/** PUT /v1/projects/:projectId/sourcemaps?release=&file= with the source map as the JSON body. */
export interface SourceMapUpload { release: string; file: string; bytes: number }
