/*
 * Touch recordings. rrweb already records what a finger does: a touch press and release as mouse interactions
 * (types 7 and 9, with the pointer type 2 on the click that follows), finger movement as touch move positions
 * (source 6) and scrolling as scroll events. This module only reads those events, so it needs no extra capture
 * and no text. Pure functions with no Node or browser APIs.
 */
import { segmentDeviceClass, type Segment } from './index';

/** rrweb incremental source numbers used here. */
const SOURCE_MOUSE_MOVE = 1;
const SOURCE_MOUSE_INTERACTION = 2;
const SOURCE_TOUCH_MOVE = 6;
/** rrweb mouse interaction types for touch: start, move departed, end, cancel. */
export const TOUCH_INTERACTIONS = [7, 8, 9, 10] as const;
/** rrweb pointer type for a finger. */
export const POINTER_TOUCH = 2;

interface LooseEvent { type: number; data?: unknown }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined;

/** What the events say about the input device. */
export function inputEvidence(events: readonly LooseEvent[]): { touch: boolean; mouse: boolean } {
  let touch = false;
  let mouse = false;
  for (const event of events) {
    if (event.type !== 3) continue;
    const data = record(event.data);
    const source = data?.source;
    if (source === SOURCE_TOUCH_MOVE) touch = true;
    else if (source === SOURCE_MOUSE_MOVE) mouse = true;
    else if (source === SOURCE_MOUSE_INTERACTION) {
      const type = data?.type;
      if ((TOUCH_INTERACTIONS as readonly unknown[]).includes(type) || data?.pointerType === POINTER_TOUCH) touch = true;
    }
    if (touch && mouse) break;
  }
  return { touch, mouse };
}

/**
 * Whether a recording is a touch visit, so the dashboard says "tap" and draws fingers, not a cursor. The events
 * decide when they show touch or mouse input; without them (a list row) the device class decides.
 */
export function isTouchRecording(
  recording: Pick<Segment, 'deviceClass' | 'viewport'>,
  events?: readonly LooseEvent[],
): boolean {
  const device = segmentDeviceClass(recording);
  if (events && events.length) {
    const { touch, mouse } = inputEvidence(events);
    if (touch) return true;
    if (mouse) return false;
  }
  return device !== 'desktop';
}

/** The device frame drawn around a replay: a phone or tablet frame for those device classes, none for desktop. */
export type DeviceFrame = 'phone' | 'tablet' | 'none';
export function deviceFrameFor(recording: Pick<Segment, 'deviceClass' | 'viewport'>): DeviceFrame {
  const device = segmentDeviceClass(recording);
  return device === 'mobile' ? 'phone' : device === 'tablet' ? 'tablet' : 'none';
}

/** Tag of the custom replay event the tracker records for pinch zoom and the visible area. Mirrored in the tracker. */
export const VISUAL_VIEWPORT_TAG = 'hootvv';

export interface VisualViewportState {
  /** Pinch zoom, 1 for none. */
  scale: number;
  /** Visible size in CSS pixels. */
  width: number;
  height: number;
  /** Top-left corner of the visible area inside the layout viewport. */
  left: number;
  top: number;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The visual viewport state a replay event carries, or undefined when it is some other event. */
export function readVisualViewportEvent(event: LooseEvent): VisualViewportState | undefined {
  if (event.type !== 5) return undefined;
  const data = record(event.data);
  if (data?.tag !== VISUAL_VIEWPORT_TAG) return undefined;
  const payload = record(data.payload);
  if (!payload) return undefined;
  const { s, w, h, x, y } = payload;
  if (!finite(s) || !finite(w) || !finite(h) || !finite(x) || !finite(y) || s <= 0 || w <= 0 || h <= 0) return undefined;
  return { scale: s, width: w, height: h, left: x, top: y };
}
