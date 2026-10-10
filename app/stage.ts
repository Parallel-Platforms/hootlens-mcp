/*
 * The stage a recorded page plays on, shared by the replay and heatmap viewers. It is the dashboard's rrweb Replayer with
 * the same safeguards, in a viewer that has no network access of its own:
 *
 *  - rrweb draws the page inside an iframe whose sandbox allows same-origin access and nothing else (no scripts, no forms,
 *    no popups), so recorded content cannot run code. The iframe is inert: it takes no focus and no pointer input.
 *  - Before rrweb sees the events, every URL that would load is confined to the asset origin the server named (the signed
 *    first-party proxy of the Hoot Lens API) and any other address is replaced with a blocked one. The host's content
 *    security policy for this view allows the same single origin, so a forged address cannot load either way.
 *  - The page's size, scale and frame come from the geometry module the dashboard shares (packages/core/src/replay-fit.ts).
 */
import { Replayer } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { confineAssetUrls, rewriteReplayEvents } from '@hootlens/core/replay-assets';
import { FRAME_MARGIN, fitToStage, validSize, type FrameKind, type Size } from '@hootlens/core/replay-fit';
import { h } from './dom';

export type RecordedEvent = { type: number; timestamp: number; data?: unknown };

export interface StageLoad {
  events: RecordedEvent[];
  /** The origin recorded assets may load from: the signed asset proxy of the API. Nothing else loads. */
  assetOrigin: string | undefined;
  viewport: Size;
  frame: FrameKind;
  touch: boolean;
  /** Show the whole document at its recorded width, scaled to the stage width (the heatmap), not a window onto it. */
  document?: boolean;
}

/** rrweb mouse interaction types used for the tap ripple. */
const TOUCH_START = 7;
const CLICK = 2;
const RIPPLE_MS = 500;

export class Stage {
  readonly element: HTMLElement;
  private device = h('div', { class: 'rs-device' });
  private screen = h('div', { class: 'rs-screen' });
  private scaled = h('div', { class: 'rs-scaled' });
  private mount = h('div', { class: 'rs-mount' });
  private ripple = h('span', { class: 'rs-ripple', 'aria-hidden': 'true', hidden: true });
  private skeleton = h('div', { class: 'rs-skeleton', 'aria-hidden': 'true' });
  private message = h('p', { class: 'rs-message', role: 'status' });
  private player: Replayer | null = null;
  private viewport: Size = { width: 1280, height: 720 };
  private frame: FrameKind = 'none';
  private touch = false;
  private docMode = false;
  private width = 0;
  private events: RecordedEvent[] = [];
  private openingOffset = 0;
  private ticker = 0;
  private maxHeight: () => number;
  private blocked = false;
  /** Called when playback ends on its own. */
  onFinish: () => void = () => undefined;
  /** Called while the playhead moves, in milliseconds from the first event. */
  onPosition: (ms: number) => void = () => undefined;
  /** Called after the stage was laid out again, with the page scale (document mode). */
  onLayout: () => void = () => undefined;
  /** Called when something the page needs (an image, a font or a style) was refused by the host or the proxy. */
  onAssetsBlocked: () => void = () => undefined;
  private resizeObserver: ResizeObserver;

  constructor(maxHeight: () => number) {
    this.maxHeight = maxHeight;
    this.scaled.append(this.mount, this.ripple);
    this.screen.append(this.scaled);
    this.device.append(this.screen);
    this.element = h('div', { class: 'rs-stage', 'data-testid': 'stage' }, this.device, this.skeleton, this.message);
    this.resizeObserver = new ResizeObserver(() => { this.width = this.element.clientWidth; this.layout(); });
    this.resizeObserver.observe(this.element);
    this.layout();
  }

  /** Shows a loading skeleton (no message) or a short note in place of the page. */
  showState(state: 'loading' | 'note' | 'page', note = ''): void {
    this.element.dataset.state = state;
    this.message.textContent = state === 'note' ? note : '';
    this.skeleton.hidden = state !== 'loading';
    this.message.hidden = state !== 'note';
    this.screen.style.visibility = state === 'page' ? 'visible' : 'hidden';
  }

  /** Builds the player. Throws when the recording cannot be replayed. */
  load(input: StageLoad): void {
    this.destroyPlayer();
    this.events = input.events;
    this.viewport = validSize(input.viewport.width, input.viewport.height) ? input.viewport : { width: 1280, height: 720 };
    this.frame = input.frame;
    this.touch = input.touch;
    this.docMode = input.document === true;
    this.blocked = false;
    this.element.dataset.touch = input.touch ? 'true' : 'false';
    this.mount.replaceChildren();
    const allowed = input.assetOrigin ? [originOf(input.assetOrigin)].filter((value): value is string => !!value) : [];
    const confined = rewriteReplayEvents(input.events, { replace: confineAssetUrls(allowed) });
    const opening = input.events.find(event => event.type === 2);
    this.openingOffset = opening ? opening.timestamp - input.events[0]!.timestamp + 1 : 0;
    const player = new Replayer(confined as unknown as eventWithTime[], {
      root: this.mount,
      mouseTail: false,
      showWarning: false,
      blockClass: 'hootlens-block',
      triggerFocus: false,
      // Never run script from a recording and never replay canvas through a worker.
      UNSAFE_replayCanvas: false,
    });
    const iframe = this.mount.querySelector('iframe');
    if (iframe) {
      iframe.tabIndex = -1;
      iframe.inert = true;
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('title', 'Recorded page');
    }
    const fitDocument = () => {
      // The heatmap shows the page at its typical document size, as the dashboard does, so the iframe takes that size.
      if (!this.docMode || !iframe) return;
      iframe.setAttribute('width', String(this.viewport.width));
      iframe.setAttribute('height', String(this.viewport.height));
      iframe.style.width = `${this.viewport.width}px`;
      iframe.style.height = `${this.viewport.height}px`;
    };
    player.on('resize', (size: unknown) => {
      const next = size as Size;
      if (this.docMode) { fitDocument(); return; }
      if (validSize(next.width, next.height)) { this.viewport = { width: next.width, height: next.height }; this.layout(); }
    });
    fitDocument();
    player.on('finish', () => { this.stopTicker(); this.onFinish(); });
    const watch = () => this.watchViolations();
    player.on('fullsnapshot-rebuilded', watch);
    this.player = player;
    this.pause(0);
    this.watchViolations();
    this.layout();
    this.showState('page');
  }

  /** The recorded page's document, when one is built. */
  get document(): Document | null {
    return this.mount.querySelector('iframe')?.contentDocument ?? null;
  }

  private watchViolations(): void {
    const view = this.mount.querySelector('iframe')?.contentWindow;
    if (!view) return;
    const flag = (event: Event) => {
      const directive = (event as SecurityPolicyViolationEvent).effectiveDirective;
      if (this.blocked || !/^(img|style|font|media)-src|default-src/.test(directive)) return;
      this.blocked = true;
      this.onAssetsBlocked();
    };
    view.addEventListener('securitypolicyviolation', flag);
    this.document?.addEventListener('securitypolicyviolation', flag);
  }

  /** True when a page asset was refused. */
  get assetsBlocked(): boolean { return this.blocked; }

  get duration(): number {
    return this.events.length ? Math.max(0, this.events[this.events.length - 1]!.timestamp - this.events[0]!.timestamp) : 0;
  }

  get origin(): number { return this.events[0]?.timestamp ?? 0; }

  get time(): number { return Math.min(this.duration, Math.max(0, this.player?.getCurrentTime() ?? 0)); }

  /** Shows the page as it was at `ms` and holds there. */
  pause(ms?: number): void {
    if (!this.player) return;
    this.stopTicker();
    if (ms === undefined) this.player.pause();
    else this.player.pause(Math.max(Math.min(ms, this.duration), this.openingOffset));
    this.drawRipple(ms ?? this.time);
  }

  play(from: number): void {
    if (!this.player) return;
    if (from < this.openingOffset) this.player.pause(this.openingOffset);
    this.player.play(Math.min(from, this.duration));
    this.stopTicker();
    this.ticker = window.setInterval(() => {
      const now = this.time;
      this.drawRipple(now);
      this.onPosition(now);
    }, 100);
  }

  setSpeed(speed: number): void { this.player?.setConfig({ speed }); }

  /** Moves the stage to a snapshot at a time on the page and draws nothing else: used by the heatmap viewer. */
  freezeAt(ms: number): void { this.pause(ms); }

  private stopTicker(): void {
    window.clearInterval(this.ticker);
    this.ticker = 0;
  }

  /** The tap ripple: where a touch began in the last half second. Static under reduced motion (CSS). */
  private drawRipple(ms: number): void {
    if (!this.touch) { this.ripple.hidden = true; return; }
    const at = this.origin + ms;
    // Events are in time order: find the last one at or before the playhead, then look back half a second.
    let low = 0, high = this.events.length - 1, last = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.events[middle]!.timestamp <= at) { last = middle; low = middle + 1; } else high = middle - 1;
    }
    let found: { x: number; y: number } | undefined;
    for (let index = last; index >= 0; index--) {
      const event = this.events[index]!;
      if (at - event.timestamp > RIPPLE_MS) break;
      const data = event.data as { source?: number; type?: number; x?: number; y?: number } | undefined;
      if (event.type === 3 && data?.source === 2 && (data.type === TOUCH_START || data.type === CLICK) && typeof data.x === 'number' && typeof data.y === 'number') { found = { x: data.x, y: data.y }; break; }
    }
    this.ripple.hidden = !found;
    if (found) { this.ripple.style.left = `${found.x}px`; this.ripple.style.top = `${found.y}px`; }
  }

  /** Fits the page to the stage in both directions, keeping proportions. Never magnifies past recorded pixels. */
  layout(): void {
    if (this.docMode) { this.layoutDocument(); return; }
    this.element.style.removeProperty('overflow-y');
    const fit = fitToStage({ viewport: this.viewport, stage: { width: this.width, maxHeight: this.maxHeight() }, frame: this.frame });
    const margin = FRAME_MARGIN[this.frame];
    this.element.dataset.frame = this.frame;
    this.element.style.height = `${Math.round(fit.stageHeight)}px`;
    Object.assign(this.device.style, { width: `${fit.frame.width}px`, height: `${fit.frame.height}px`, left: `${fit.left}px`, top: `${margin.top}px` });
    Object.assign(this.screen.style, { width: `${fit.screen.width}px`, height: `${fit.screen.height}px`, left: `${fit.inset}px`, top: `${fit.inset}px` });
    Object.assign(this.scaled.style, { width: `${this.viewport.width}px`, height: `${this.viewport.height}px`, transform: `scale(${fit.scale})` });
    this.scaled.style.setProperty('--rs-inv', String(1 / fit.scale));
    this.onLayout();
  }

  /** The whole document scaled to the stage width. A tall page is cropped to the room there is; full screen shows more. */
  private layoutDocument(): void {
    const scale = this.width > 0 ? Math.min(1, Math.max(0.05, this.width / this.viewport.width)) : 1;
    const full = this.viewport.height * scale;
    const room = this.maxHeight();
    this.element.dataset.frame = 'none';
    this.element.dataset.cropped = full > room ? 'true' : 'false';
    this.element.style.height = `${Math.round(Math.min(full, room))}px`;
    this.element.style.overflowY = full > room ? 'auto' : 'hidden';
    Object.assign(this.device.style, { width: `${this.viewport.width * scale}px`, height: `${full}px`, left: '0px', top: '0px' });
    Object.assign(this.screen.style, { width: `${this.viewport.width * scale}px`, height: `${full}px`, left: '0px', top: '0px' });
    Object.assign(this.scaled.style, { width: `${this.viewport.width}px`, height: `${this.viewport.height}px`, transform: `scale(${scale})` });
    this.scaled.style.setProperty('--rs-inv', String(1 / scale));
    this.pageScale = scale;
    this.onLayout();
  }

  /** Scale of the document in the heatmap layout. */
  pageScale = 1;

  private destroyPlayer(): void {
    this.stopTicker();
    this.player?.destroy();
    this.player = null;
  }

  destroy(): void {
    this.destroyPlayer();
    this.resizeObserver.disconnect();
  }

  /** The screen the heatmap overlay is drawn over, at display size. */
  get screenLayer(): HTMLElement { return this.screen; }

  /** A blank page of the given document size, for a heatmap without a snapshot behind it. */
  blank(size: Size): void {
    this.destroyPlayer();
    this.events = [];
    this.mount.replaceChildren();
    this.docMode = true;
    this.viewport = validSize(size.width, size.height) ? size : { width: 1280, height: 1600 };
    this.element.dataset.touch = 'false';
    this.layout();
    this.showState('page');
  }
}

function originOf(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}
