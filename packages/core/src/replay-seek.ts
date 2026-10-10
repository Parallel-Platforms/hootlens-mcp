/** How long before a snag a replay opens, so the viewer sees what led up to it. */
export const SNAG_LEAD_IN_MS = 2000;

/**
 * Where to open a replay for an event at `at` (epoch ms): `leadInMs` earlier, and never before `notBefore` (the
 * recording's start) when that is known. Returns undefined for a missing or invalid time, which opens the start.
 */
export function replaySeekTime(at: unknown, notBefore?: number, leadInMs: number = SNAG_LEAD_IN_MS): number | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return undefined;
  const floor = typeof notBefore === 'number' && Number.isFinite(notBefore) ? notBefore : 0;
  return Math.max(floor, Math.round(at - leadInMs));
}
