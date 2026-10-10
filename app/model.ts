/*
 * The pure logic of the viewers, with no DOM: what a tool result means, where markers sit on the timeline, which step the
 * playhead has reached and which links the viewer may offer. Tested in tests/mcp-apps.test.ts without a browser.
 */
import { SIGNAL_TERMS, type SignalKind } from '../../../apps/web/src/terms';

/* ---------------------------------------------------------------- what the tools return */

export type StepKind = 'landed' | 'scrolled' | 'clicked' | 'snag' | 'error' | 'navigated' | 'resized' | 'idle' | 'left';
export interface Step { atMs?: number; clock?: string; kind?: StepKind | string; text: string; recordingId?: string; offsetMs?: number; selector?: string; source?: string }
export interface Facts {
  durationMs?: number; activeMs?: number; pages?: string[]; device?: string; browser?: string; os?: string; maxScrollPercent?: number;
  clicks?: number; touch?: boolean; pileUps?: number; noShows?: number; misfires?: number; errors?: number; exitPage?: string;
}
export interface NarrativeResult { summary?: string; facts?: Facts; steps?: Step[]; omittedSteps?: number; omittedPages?: number; note?: string; annotations?: { recordingId: string; path: string; tags: string[]; notes: { text?: string; offsetMs?: number }[] }[] }

export type ClickKind = 'click' | 'rage-click' | 'dead-click' | 'error-click';
export interface RecordedClick { timestamp: number; kind?: ClickKind | string }
export interface RecordedError { at: number; name?: string; message?: string; location?: string; id?: string }
export interface RecordingMeta { id?: string; path?: string; deviceClass?: string; viewport?: { width: number; height: number }; startedAt?: number; clicks?: RecordedClick[] }
export interface ReplayResult {
  projectId?: string; assetOrigin?: string;
  recording?: RecordingMeta; events?: { type: number; timestamp: number; data?: unknown }[]; errors?: RecordedError[];
  tags?: string[]; notes?: { text?: string; offsetMs?: number }[];
}

export interface HeatmapResult {
  key?: string; path?: string; deviceClass?: string; sessions?: number; segments?: number; clicks?: number;
  docWidth?: number; docHeight?: number;
  grid?: { cellSize: number; cells: [number, number, number][]; truncatedFrom?: number };
  selectors?: { selector: string; label?: string; name?: string; source?: string; clicks: number; rageClicks?: number; deadClicks?: number; errorClicks?: number }[];
  scrollDepths?: number[];
  reference?: { recordingId: string; timestamp: number };
}

export interface FindingsResult {
  sample?: string; segments?: number; signal?: { label?: string; evidence?: string };
  cohorts?: { key: string; path?: string; deviceClass?: string; revision?: string; clicks?: number; sessions?: number; frictionClicks?: number; rageClicks?: number; deadClicks?: number; errorClicks?: number; foldedCohorts?: number; selectors?: { selector: string; name?: string; label?: string; source?: string; rageClicks?: number; deadClicks?: number; errorClicks?: number }[] }[];
  errors?: { id: string; error?: string; name?: string; pageViews?: number }[];
}

const ID = /^[a-zA-Z0-9_-]{1,80}$/;

/* ---------------------------------------------------------------- time and words */

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const KIND_NAME: Record<string, string> = {
  click: 'Click',
  'rage-click': SIGNAL_TERMS['rage-click'].name,
  'dead-click': SIGNAL_TERMS['dead-click'].name,
  'error-click': SIGNAL_TERMS['error-click'].name,
  'js-error': 'JavaScript error',
};
/** The word for a marker kind. A plain press on a touch visit is a tap. */
export const markerName = (kind: string, touch: boolean): string => (kind === 'click' && touch ? 'Tap' : KIND_NAME[kind] ?? 'Click');
export const SNAG_KINDS: readonly SignalKind[] = ['rage-click', 'dead-click', 'error-click'];

/** "1 pile-up", "3 no-shows". */
export function snagCount(kind: SignalKind, count: number): string {
  const term = SIGNAL_TERMS[kind];
  return `${count.toLocaleString('en-US')} ${(count === 1 ? term.name : term.plural ?? `${term.name}s`).toLowerCase()}`;
}

/* ---------------------------------------------------------------- the timeline */

export interface TimelineMarker { key: string; kind: MarkerKindName; offsetMs: number; label: string }
export type MarkerKindName = ClickKind | 'js-error';

/** Rank when several markers share a spot: the most telling one shows. */
const RANK: Record<string, number> = { 'js-error': 5, 'error-click': 4, 'rage-click': 3, 'dead-click': 2, click: 1 };

/** Markers for one page view, in time order. Click times are relative to the first event, as the dashboard places them. */
export function timelineMarkers(input: { origin: number; durationMs: number; clicks: readonly RecordedClick[] | undefined; errors: readonly RecordedError[] | undefined; touch: boolean }): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  const clamp = (ms: number) => Math.min(Math.max(0, input.durationMs), Math.max(0, ms));
  (input.clicks ?? []).forEach((click, index) => {
    const kind: MarkerKindName = click.kind === 'rage-click' || click.kind === 'dead-click' || click.kind === 'error-click' ? click.kind : 'click';
    const offsetMs = clamp(click.timestamp - input.origin);
    out.push({ key: `c${index}`, kind, offsetMs, label: `${markerName(kind, input.touch)} at ${formatClock(offsetMs)}` });
  });
  [...(input.errors ?? [])].sort((a, b) => a.at - b.at).forEach((error, index) => {
    const offsetMs = clamp(error.at - input.origin);
    out.push({ key: `e${index}`, kind: 'js-error', offsetMs, label: `${error.name ?? 'Error'} at ${formatClock(offsetMs)}` });
  });
  return out.sort((a, b) => a.offsetMs - b.offsetMs || RANK[b.kind]! - RANK[a.kind]!);
}

/**
 * Thins markers so each is at least `minGapPx` from the last one shown on a timeline `widthPx` wide. Where several share a
 * spot, the most telling one is kept. Snags and errors are never dropped for a plain click.
 */
export function placeMarkers(markers: readonly TimelineMarker[], durationMs: number, widthPx: number, minGapPx = 14): (TimelineMarker & { percent: number; hidden: number })[] {
  const shown: (TimelineMarker & { percent: number; hidden: number; px: number })[] = [];
  for (const marker of markers) {
    const px = durationMs > 0 && widthPx > 0 ? Math.min(1, marker.offsetMs / durationMs) * widthPx : 0;
    const last = shown[shown.length - 1];
    if (last && px - last.px < minGapPx) {
      last.hidden++;
      if (RANK[marker.kind]! > RANK[last.kind]!) Object.assign(last, { key: marker.key, kind: marker.kind, offsetMs: marker.offsetMs, label: marker.label });
      continue;
    }
    shown.push({ ...marker, px, hidden: 0, percent: durationMs > 0 ? Math.min(100, (marker.offsetMs / durationMs) * 100) : 0 });
  }
  return shown.map(({ px: _px, ...rest }) => rest);
}

/** The step the playhead has reached on this page view, or -1. Matches the dashboard's rule. */
export function reachedStep(steps: readonly Step[], recordingId: string | undefined, positionMs: number): number {
  let reached = -1;
  steps.forEach((step, index) => {
    if (step.recordingId === recordingId && (step.offsetMs ?? 0) <= positionMs + 50) reached = index;
  });
  return reached;
}

/** The page views a narrative covers, in the order their steps first appear. */
export function pageViews(steps: readonly Step[]): string[] {
  return [...new Set(steps.map(step => step.recordingId).filter((id): id is string => typeof id === 'string' && ID.test(id)))];
}

/** A document size the heatmap can draw: a number the page could plausibly have, else the fallback. */
export const documentSize = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 200 && value <= 40_000 ? Math.round(value) : fallback;

/* ---------------------------------------------------------------- links */

/** The only address the viewers link to. The directory submission lists the same origin. */
export const APP_ORIGIN = 'https://hootlens.com';

/** A link to the dashboard, or undefined when an id is not the shape the dashboard uses. */
export function dashboardUrl(kind: 'recordings' | 'heatmaps' | 'overview', projectId: string | undefined, extra: { recordingId?: string; at?: number } = {}): string | undefined {
  if (!projectId || !ID.test(projectId)) return undefined;
  const query = new URLSearchParams({ project: projectId });
  if (extra.recordingId && ID.test(extra.recordingId)) query.set('recording', extra.recordingId);
  if (extra.at !== undefined && Number.isFinite(extra.at) && extra.at > 0) query.set('at', String(Math.round(extra.at)));
  return `${APP_ORIGIN}${kind === 'overview' ? '/app' : `/app/${kind}`}?${query.toString()}`;
}

/* ---------------------------------------------------------------- reading results */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A tool's input as the viewers read it: ids only, in the shape the API accepts. */
export function idArg(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

/** The project a result belongs to: the input, else the result's own marker. */
export function projectOf(args: Record<string, unknown> | undefined, meta: Record<string, unknown> | undefined): string | undefined {
  const marker = meta?.['com.hootlens/app'];
  return idArg(args?.projectId) ?? (isRecord(marker) ? idArg(marker.projectId) : undefined);
}

/** True when a recorded event list can be played: an opening snapshot and at least one more event. */
export const playable = (events: readonly { type: number }[] | undefined): boolean => !!events && events.length >= 2 && events.some(event => event.type === 2);
