/*
 * Geometry for a replay stage: scale a recorded viewport to fit the space a viewer has, in both directions, and size the
 * quiet phone or tablet frame around it. Pure, with no imports, so the dashboard and the MCP App viewers share it and
 * every case is tested without a browser.
 */
import type { DeviceFrame } from './touch';

export interface Size {
  width: number;
  height: number;
}

export type FrameKind = DeviceFrame;

/** Frame thickness on each side, in screen pixels (not scaled with the page). */
export const FRAME_BEZEL: Record<FrameKind, number> = { phone: 8, tablet: 10, none: 0 };
/**
 * Space kept clear around a framed device so its rounded corners and shadow are not cramped. The bottom has more,
 * for the line that says what the visitor's screen was showing (zoomed in, covered by the keyboard).
 */
export const FRAME_MARGIN: Record<FrameKind, { x: number; top: number; bottom: number }> = {
  phone: { x: 16, top: 16, bottom: 36 },
  tablet: { x: 16, top: 16, bottom: 36 },
  none: { x: 0, top: 0, bottom: 0 },
};
/** Smallest scale the stage will use; below this a replay is a speck. */
export const MIN_SCALE = 0.05;

export interface FitInput {
  /** The recorded viewport, or the region of it being shown. */
  viewport: Size;
  /** Room the stage has: its measured width (0 before it is measured) and the tallest it may be. */
  stage: { width: number; maxHeight: number };
  frame: FrameKind;
  /** The most the page may be magnified. 1 keeps recorded pixels truthful. */
  maxScale?: number;
}

export interface Fit {
  /** Scale applied to the recorded page. */
  scale: number;
  /** The scaled page, which is what the visitor's screen showed. */
  screen: Size;
  /** The screen plus its frame. */
  frame: Size;
  /** Height the stage takes: the frame plus the clear margin above and below. */
  stageHeight: number;
  /** Where the frame starts, centred in the stage width. */
  left: number;
  /** Offset of the screen inside the frame. */
  inset: number;
}

const positive = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * Scale so the whole viewport shows, whichever of width or height is tighter, keeping its proportions and centring it.
 * A tall phone in a wide stage is limited by height; a wide desktop in a narrow stage by width; a tablet in landscape by
 * whichever the stage allows. Before the stage is measured (width 0) only the height limits the scale.
 */
export function fitToStage({ viewport, stage, frame, maxScale = 1 }: FitInput): Fit {
  const width = positive(viewport.width, 1);
  const height = positive(viewport.height, 1);
  const bezel = FRAME_BEZEL[frame];
  const margin = FRAME_MARGIN[frame];
  const byWidth = stage.width > 0 ? (stage.width - 2 * (bezel + margin.x)) / width : Infinity;
  const byHeight = (positive(stage.maxHeight, 600) - 2 * bezel - margin.top - margin.bottom) / height;
  const scale = Math.max(MIN_SCALE, Math.min(maxScale, byWidth, byHeight));
  const screen = { width: width * scale, height: height * scale };
  const framed = { width: screen.width + 2 * bezel, height: screen.height + 2 * bezel };
  return {
    scale,
    screen,
    frame: framed,
    stageHeight: framed.height + margin.top + margin.bottom,
    left: Math.max(0, (stage.width - framed.width) / 2),
    inset: bezel,
  };
}

/** True when a recorded size is a usable viewport. */
export const validSize = (width: unknown, height: unknown): boolean =>
  typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1;
