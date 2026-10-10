import type { FrameKind, Size } from '@hootlens/core/replay-fit';

/** The shorter side below which a touch device is drawn as a phone, whichever way it is held (the dashboard's rule). */
const PHONE_SHORT_SIDE = 600;

/**
 * The frame for a recording at its size: none for desktop, a phone while the shorter side is phone sized, else a tablet.
 * Same rule as apps/web/src/dashboard/replayFit.ts, which cannot be imported here without pulling in the whole core
 * module (and its schema library) for one lookup.
 */
export function frameKindFor(recording: { deviceClass?: string }, current: Size): FrameKind {
  if (recording.deviceClass !== 'mobile' && recording.deviceClass !== 'tablet') return 'none';
  return Math.min(current.width, current.height) < PHONE_SHORT_SIDE ? 'phone' : 'tablet';
}

/** The frame of a heatmap cohort, which is bucketed by device class and has no single window. */
export const frameForDevice = (device: string | undefined): FrameKind => (device === 'mobile' ? 'phone' : device === 'tablet' ? 'tablet' : 'none');
