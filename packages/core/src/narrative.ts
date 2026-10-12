/*
 * Session narrative: a readable, step-by-step account of one visit, for agents and for the
 * dashboard player. Pure and deterministic, no LLM, no I/O.
 *
 * It describes observed behavior only: where the page was, what scrolled, what was clicked and
 * where clicks showed pile-ups, no-shows or misfires. It never states emotion or intent.
 *
 * Page text enters the output through exactly one door: `Click.label`, which the tracker already
 * computed under the project's privacy policy. Under the strict preset even that is ignored, so a
 * strict narrative contains no text that came from the page. Everything else is a path, a
 * developer-set `data-hoot-id`, an element kind or a number.
 */
import { agentLabel } from './agent';
import { describeError, linkedClickIndex } from './error-capture';
import type { RecordingError } from './errors';
import { isTouchRecording } from './touch';
import { NOT_INTERACTIVE_PHRASE, describeContext, topSnagPhrase, type ElementContext, type TopSnag } from './element-context';
import {
  segmentDeviceClass, VISIT_IDLE_MS,
  type BrowserName, type Click, type DeviceClass, type OsName, type PrivacyPreset, type RecordingDetail,
} from './index';

/** Gaps in activity longer than this are reported as idle time. */
export const NARRATIVE_IDLE_MS = 10_000;
/** Most steps one narrative returns. */
export const NARRATIVE_MAX_STEPS = 60;
/** Most page views read into one session narrative. */
export const NARRATIVE_MAX_PAGES = 25;
/** Scroll milestones, in percent of the document height. */
export const NARRATIVE_SCROLL_MILESTONES = [25, 50, 75, 100] as const;

/**
 * Signal names, matching apps/web/src/terms.ts (Snags vocabulary). tests/narrative.test.ts checks
 * they stay in step, because core cannot import from the web app.
 */
export const NARRATIVE_TERMS = { pileUp: 'pile-up', noShow: 'no-show', misfire: 'misfire' } as const;

export type NarrativeStepKind = 'landed' | 'scrolled' | 'clicked' | 'snag' | 'error' | 'navigated' | 'resized' | 'idle' | 'left';

export interface NarrativeStep {
  /** Milliseconds since the visit began. */
  atMs: number;
  /** `atMs` as m:ss (or h:mm:ss), the way the text reads. */
  clock: string;
  kind: NarrativeStepKind;
  text: string;
  /** Page view the moment belongs to. Open it with the replay scope to watch it. */
  recordingId: string;
  /** Milliseconds from the start of that page view's recording, the position to seek to. */
  offsetMs: number;
  /** Selector of the clicked element, for click and snag steps. */
  selector?: string;
  /** Element label quoted in `text`. Absent under the strict preset. */
  label?: string;
  /** Source file and line (`src/Pricing.tsx:42`) behind the clicked element, when the site's build plugin stamped it. Open that file to see the code. */
  source?: string;
  /** False when the clicked element is not a link, button or other control. Present only on click and snag steps for such elements. */
  interactive?: false;
}

export interface NarrativeFacts {
  /** Time on the site without long idle time: stretches of 30 minutes or more with no visitor activity are left out. */
  durationMs: number;
  /** Elapsed time from the first to the last moment of the visit. Equals `durationMs` unless the visit sat idle for 30 minutes or more. */
  elapsedMs: number;
  /** Duration minus idle gaps of 10 seconds or more. */
  activeMs: number;
  /** Distinct page paths in the order first visited. */
  pages: string[];
  device: DeviceClass;
  browser?: BrowserName;
  os?: OsName;
  /** Referrer origin of the landing page. */
  referrer?: string;
  utmSource?: string;
  /** Deepest point of the page reached, in percent of document height, maximum over page views. 0 when unknown. */
  maxScrollPercent: number;
  clicks: number;
  /** True when the visit was made by touch, so the text says taps. */
  touch: boolean;
  /** Episodes (three or more rapid clicks on one element), not individual clicks. */
  pileUps: number;
  /** Pile-up episodes on an element that is not a link, button or other control. Absent when none. */
  pileUpsOnNonControls?: number;
  noShows: number;
  misfires: number;
  /** Distinct JavaScript errors recorded in the visit. Absent when the site does not record them or none happened. */
  errors?: number;
  exitPage: string;
  /** Where the visit went when its last click left the page: a same-site path, or another site's origin only. Absent when no link click ended it. */
  exitTo?: string;
}

export interface Narrative {
  summary: string;
  facts: NarrativeFacts;
  steps: NarrativeStep[];
  /** Steps left out to stay within the cap. */
  omittedSteps: number;
  /** Page views left out because they were unavailable or over the page cap. */
  omittedPages: number;
  /** "…N more" text when anything was left out. */
  note?: string;
}

export interface NarrativeOptions {
  /** The project's privacy preset. Defaults to strict, the safest reading. */
  privacy?: PrivacyPreset;
  maxSteps?: number;
  /** Page views the caller could not load or chose not to, counted in `omittedPages`. */
  omittedPages?: number;
  /** Names the team gave elements, by selector. A named element reads by that name under every preset. */
  elementNames?: ReadonlyMap<string, string>;
}

const STEP_ORDER: Record<NarrativeStepKind, number> = {
  landed: 0, navigated: 1, resized: 2, scrolled: 3, clicked: 4, snag: 5, error: 6, idle: 7, left: 8,
};

// ---------------------------------------------------------------------------------------------
// Formatting

export function narrativeClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "45 s", "1 min 12 s", "2 min", "1 h 5 min". */
export function narrativeSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)); // floors, like the player clock, so "21 s" sits beside 0:21
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const article = (noun: string) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}


// ---------------------------------------------------------------------------------------------
// Element descriptions

const KIND_BY_ACTION: Partial<Record<NonNullable<Click['actionType']>, string>> = {
  link: 'link', button: 'button', submit: 'submit button', toggle: 'toggle',
};
const KIND_BY_TAG: Record<string, string> = {
  a: 'link', button: 'button', input: 'input', select: 'dropdown', textarea: 'text area', img: 'image', picture: 'image',
  svg: 'icon', summary: 'disclosure', label: 'label', form: 'form', video: 'video', audio: 'audio player',
  span: 'text', p: 'text', li: 'text', td: 'text', th: 'text', h1: 'text', h2: 'text', h3: 'text', h4: 'text', h5: 'text', h6: 'text',
};

/** Identifier words: "home-menu-toggle" becomes "home menu toggle". */
export function humanizeHootId(value: string): string {
  return value.replace(/[-_.:]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
}

interface ElementInfo {
  /** Words from the nearest data-hoot-id in the selector. */
  hootId?: string;
  /** True when that marker is on the clicked element itself, not an ancestor. */
  hootIdOnTarget: boolean;
  /** Element kind in plain words, without an article. */
  kind: string;
  label?: string;
  /** Tag, region and (outside strict) heading and own text of the element. Used when nothing else names it. */
  context?: ElementContext;
  /** The recorded context as one phrase. */
  contextText?: string;
  /** True when the tracker said the target is not a link, button or other control. */
  inactive: boolean;
  /** Where in the viewport the press landed, in words. Only used when nothing names the element. */
  place?: string;
}

function lastSegment(selector: string): string {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** "near the top left of the screen": a coarse place from the press position, as fractions of the viewport. */
export function placePhrase(x: number | undefined, y: number | undefined, touch: boolean): string | undefined {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const vertical = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : 'middle';
  const horizontal = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
  const area = touch ? 'screen' : 'window';
  if (vertical === 'middle' && horizontal === 'center') return `in the middle of the ${area}`;
  if (vertical === 'middle') return `on the ${horizontal} side of the ${area}`;
  if (horizontal === 'center') return `near the ${vertical} of the ${area}`;
  return `near the ${vertical} ${horizontal} of the ${area}`;
}

function describeElement(click: Click, allowLabel: boolean, touch = false, names?: ReadonlyMap<string, string>): ElementInfo {
  const selector = click.selector ?? '';
  const last = lastSegment(selector);
  const hootMatches = [...selector.matchAll(/\[data-hoot-id="([^"]{1,80})"\]/g)];
  let hootId = hootMatches.length ? humanizeHootId(hootMatches[hootMatches.length - 1][1]) : undefined;
  let hootIdOnTarget = hootId !== undefined && last.includes('[data-hoot-id=');
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(last)?.[1]?.toLowerCase();
  // Older clicks carry no selector; their target is the marker, or else the tag name.
  if (!selector && click.target && !(click.target.toLowerCase() in KIND_BY_TAG) && /^[\w.:-]{1,80}$/.test(click.target)) {
    hootId = humanizeHootId(click.target);
    hootIdOnTarget = true;
  }
  const kind = KIND_BY_ACTION[click.actionType ?? 'other'] ?? (tag ? KIND_BY_TAG[tag] : undefined)
    ?? (!selector && KIND_BY_TAG[click.target?.toLowerCase() ?? ''] ? KIND_BY_TAG[click.target.toLowerCase()] : undefined) ?? 'element';
  // A name the team wrote is quoted like a label but is never visitor text, so it applies under every preset.
  const custom = click.selector ? names?.get(click.selector) : undefined;
  const label = custom ?? (allowLabel && typeof click.label === 'string'
    ? click.label.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined
    : undefined);
  const place = placePhrase(click.x, click.y, touch);
  // Strict never carries page text; a context that arrives with some anyway is cut back to its tag and region.
  const context = click.context ? (allowLabel ? click.context : { ...(click.context.tag ? { tag: click.context.tag } : {}), ...(click.context.region ? { region: click.context.region } : {}) }) : undefined;
  const contextText = describeContext(context);
  return {
    hootId: hootId || undefined, hootIdOnTarget: Boolean(hootId) && hootIdOnTarget, kind, ...(label ? { label } : {}),
    ...(contextText ? { context, contextText } : {}), inactive: click.interactive === false, ...(place ? { place } : {}),
  };
}

/**
 * Label, else data-hoot-id, else the recorded context, else element kind. Never invents text. `flagInactive` is for snags:
 * a pile-up on something that is not a link or button says so, because tapping text people expect to act is the signal.
 */
function subject(info: ElementInfo, flagInactive = false): string {
  // The tracker's name for a control in a private region that carries no site-authored identifier.
  if (info.hootId === 'private control' && info.hootIdOnTarget && !info.label) return 'a private control';
  // An element that carries text of its own reads as text, whatever its tag.
  const noun = info.kind === 'text' || (info.kind === 'element' && info.context?.text) ? 'text' : `${article(info.kind)} ${info.kind}`;
  const inactive = flagInactive && info.inactive;
  if (info.label) return inactive ? `'${info.label}' (${NOT_INTERACTIVE_PHRASE})` : `'${info.label}'`;
  if (info.hootId && info.hootIdOnTarget) return inactive ? `the ${info.hootId} (${NOT_INTERACTIVE_PHRASE})` : `the ${info.hootId}`;
  if (info.contextText) return inactive ? `${noun} that is ${NOT_INTERACTIVE_PHRASE}: ${info.contextText}` : `${noun}: ${info.contextText}`;
  if (info.hootId) return inactive ? `${noun} in the ${info.hootId} that is ${NOT_INTERACTIVE_PHRASE}` : `${noun} in the ${info.hootId}`;
  // Nothing names it and its role is unknown: the best readable description is where it was.
  const where = info.kind === 'element' && info.place ? `${noun} ${info.place}` : noun;
  return inactive ? `${where} that is ${NOT_INTERACTIVE_PHRASE}` : where;
}

function clickText(click: Click, info: ElementInfo, touch: boolean): string {
  if (click.actionType === 'toggle') return `Toggled ${subject(info)}`;
  const verb = touch ? 'Tapped' : 'Clicked';
  if (info.label && ['link', 'button', 'submit button'].includes(info.kind)) return `${verb} the ${info.kind} '${info.label}'`;
  return `${verb} ${subject(info)}`;
}

// ---------------------------------------------------------------------------------------------
// Events

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** rrweb incremental sources that come from the visitor: pointer, scroll, resize, input, touch, media, drag, selection. */
const ACTIVITY_SOURCES = new Set([1, 2, 3, 4, 5, 6, 7, 12, 14]);

/** A step carrying its absolute timestamp until the visit clock is known. */
type Draft = NarrativeStep & { timestamp: number };

interface PageFacts {
  steps: Draft[];
  /** The page view was a touch visit, so it says taps. */
  touch: boolean;
  startMs: number;
  endMs: number;
  idleMs: number;
  /** Idle gaps of VISIT_IDLE_MS or more, which are not time spent. Part of `idleMs`. */
  longIdleMs: number;
  maxScrollPercent: number;
  scrolled: boolean;
  clicks: number;
  /** Subject of each pile-up episode, as written in the text. */
  pileUps: string[];
  /** Pile-up episodes on an element the tracker said is not a link, button or other control. */
  inactivePileUps: number;
  noShows: number;
  misfires: number;
  errors: number;
}

/** `TypeError: x is undefined at src/cart.ts:42`. Under strict the message was never recorded, so only the name and place read. */
function errorText(error: RecordingError): string {
  return error.location ? `${describeError(error)} at ${error.location}` : describeError(error);
}

function readPage(detail: RecordingDetail, privacy: PrivacyPreset, names?: ReadonlyMap<string, string>): PageFacts {
  const { recording } = detail;
  const events = [...detail.events].sort((a, b) => a.timestamp - b.timestamp);
  const clicks = [...(recording.clicks ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  const allowLabel = privacy !== 'strict';
  const touch = isTouchRecording(recording, events);
  const startMs = events[0]?.timestamp ?? recording.startedAt;
  // The visit ends where the replay ends: the last recorded event. This is the player's own duration (first to last event),
  // so the summary and the clock agree. A press can come after it: a tap on a link that unloads the page is recorded by
  // the click tracker a moment after the replay recorder has stopped. The end never precedes the last press, so "Left"
  // is always the final step. Only a recording too short to play falls back to the recorded interval.
  const lastClickAt = clicks[clicks.length - 1]?.timestamp ?? 0;
  const endMs = events.length >= 2
    ? Math.max(events[events.length - 1].timestamp, lastClickAt, startMs)
    : Math.max(lastClickAt, recording.endedAt ?? 0, startMs);
  const steps: Draft[] = [];
  const add = (timestamp: number, kind: NarrativeStepKind, text: string, extra: { selector?: string; label?: string; source?: string; interactive?: false } = {}) =>
    steps.push({
      atMs: 0, clock: '', kind, text, recordingId: recording.id, offsetMs: Math.max(0, timestamp - startMs), timestamp,
      ...(extra.selector ? { selector: extra.selector } : {}), ...(extra.label ? { label: extra.label } : {}), ...(extra.source ? { source: extra.source } : {}),
      ...(extra.interactive === false ? { interactive: false as const } : {}),
    });
  // The context is quoted in the step's text, so the step does not repeat it.
  const elementExtra = (info: ElementInfo) => (info.inactive ? { interactive: false as const } : {});

  // Document height: the recorded scroll measure, else the latest click's measurement.
  const docHeight = recording.scroll?.docHeight
    ?? [...clicks].reverse().find(click => click.docHeight)?.docHeight;
  let viewportHeight = recording.viewport.height;
  const rootId = (() => {
    const snapshot = events.find(event => event.type === 2);
    return num(record(record(snapshot?.data)?.node)?.id);
  })();

  // Resizes, scroll and activity, in time order.
  let sawMeta = false;
  let lastResizeAt = -Infinity;
  let announcedWidth = recording.viewport.width;
  let announcedHeight = viewportHeight;
  let pendingResize: { at: number; width: number; height: number } | undefined;
  const flushResize = () => {
    if (!pendingResize) return;
    const { at, width, height } = pendingResize;
    pendingResize = undefined;
    if (width !== announcedWidth || Math.abs(height - announcedHeight) >= 100) {
      // On a touch device a swap between portrait and landscape is the visitor turning the device, not resizing a window.
      const turned = touch && (width > height) !== (announcedWidth > announcedHeight);
      add(at, 'resized', turned
        ? `Turned the ${width > height ? 'device to landscape' : 'device to portrait'} (${width} by ${height} px)`
        : `Resized the ${touch ? 'screen' : 'window'} to ${width} by ${height} px`);
      announcedWidth = width;
      announcedHeight = height;
    }
  };

  const milestoneStart = docHeight ? Math.round(Math.min(1, viewportHeight / docHeight) * 100) : 0;
  let reached = Math.max(0, ...NARRATIVE_SCROLL_MILESTONES.filter(m => m <= milestoneStart));
  let maxDepth = recording.scroll?.maxDepth ?? 0;
  let scrolled = recording.scroll ? recording.scroll.maxDepth > recording.viewport.height + 2 : false;
  const activity: number[] = [startMs, endMs];

  for (const event of events) {
    if (event.type === 4) {
      const data = record(event.data);
      const width = num(data?.width);
      const height = num(data?.height);
      if (width && height) {
        if (!sawMeta) { sawMeta = true; announcedWidth = width; announcedHeight = height; viewportHeight = height; continue; }
        if (event.timestamp - lastResizeAt > 1000) flushResize();
        pendingResize = { at: event.timestamp, width, height };
        lastResizeAt = event.timestamp;
        viewportHeight = height;
      }
      continue;
    }
    if (event.type !== 3) continue;
    const data = record(event.data);
    const source = num(data?.source);
    if (source === undefined || !ACTIVITY_SOURCES.has(source)) continue;
    activity.push(event.timestamp);
    if (source === 4) {
      const width = num(data?.width);
      const height = num(data?.height);
      if (width && height) {
        if (event.timestamp - lastResizeAt > 1000) flushResize();
        pendingResize = { at: event.timestamp, width, height };
        lastResizeAt = event.timestamp;
        viewportHeight = height;
      }
    } else if (source === 3 && (rootId === undefined || num(data?.id) === rootId)) {
      const y = num(data?.y);
      if (y === undefined) continue;
      if (y > 0) scrolled = true;
      const depth = y + viewportHeight;
      maxDepth = Math.max(maxDepth, docHeight ? Math.min(depth, docHeight) : depth);
      if (!docHeight) continue;
      const percent = depth >= docHeight - 2 ? 100 : Math.floor((depth / docHeight) * 100);
      const milestone = Math.max(0, ...NARRATIVE_SCROLL_MILESTONES.filter(m => m <= percent));
      if (milestone > reached) {
        reached = milestone;
        add(event.timestamp, 'scrolled', `Scrolled to ${milestone}% of the page`);
      }
    }
  }
  flushResize();

  // Clicks. A pile-up is a run on one element, each tap within a second of the last, with a
  // pile-up click in it; the taps before that click are part of the same episode.
  // A JavaScript error within two seconds after a click belongs to that click. When the click is a snag, the error is
  // part of its sentence; otherwise it is a step of its own.
  const errors = [...(detail.errors ?? [])].sort((a, b) => a.at - b.at);
  const followed = new Map<number, RecordingError>();
  const standalone: RecordingError[] = [];
  for (const error of errors) {
    const index = linkedClickIndex(error, clicks);
    const click = index === undefined ? undefined : clicks[index];
    if (index !== undefined && click && click.kind !== 'click' && !followed.has(index)) followed.set(index, error);
    else standalone.push(error);
  }
  const keyOf = (click: Click) => String(click.nodeId ?? click.selector ?? click.target);
  const pileUps: string[] = [];
  let noShows = 0;
  let misfires = 0;
  let inactivePileUps = 0;
  for (let index = 0; index < clicks.length;) {
    let end = index + 1;
    while (end < clicks.length && keyOf(clicks[end]) === keyOf(clicks[index]) && clicks[end].timestamp - clicks[end - 1].timestamp < 1000) end++;
    const run = clicks.slice(index, end);
    for (const click of run) activity.push(click.timestamp);
    if (run.some(click => click.kind === 'rage-click')) {
      const info = describeElement(run[run.length - 1], allowLabel, touch, names);
      const span = run[run.length - 1].timestamp - run[0].timestamp;
      const linkedError = run.map(click => followed.get(clicks.indexOf(click))).find(found => found !== undefined);
      const text = `${capitalize(NARRATIVE_TERMS.pileUp)} on ${subject(info, true)} (${run.length} taps in ${(span / 1000).toFixed(1)} s${linkedError ? `, followed by ${errorText(linkedError)}` : ''})`;
      pileUps.push(subject(info));
      const runSource = [...run].reverse().find(click => click.source)?.source;
      add(run[0].timestamp, 'snag', text, { ...(run[0].selector ? { selector: run[0].selector } : {}), ...(info.label ? { label: info.label } : {}), ...(runSource ? { source: runSource } : {}), ...elementExtra(info) });
      if (info.inactive) inactivePileUps++;
    } else {
      for (const click of run) {
        const info = describeElement(click, allowLabel, touch, names);
        const extra = { ...(click.selector ? { selector: click.selector } : {}), ...(info.label ? { label: info.label } : {}), ...(click.source ? { source: click.source } : {}), ...elementExtra(info) };
        if (click.kind === 'dead-click') {
          noShows++;
          const linkedError = followed.get(clicks.indexOf(click));
          add(click.timestamp, 'snag', `${capitalize(NARRATIVE_TERMS.noShow)} on ${subject(info, true)} (${touch ? 'tapped' : 'clicked'}, nothing changed on the page${linkedError ? `, followed by ${errorText(linkedError)}` : ''})`, extra);
        } else if (click.kind === 'error-click') {
          misfires++;
          const linkedError = followed.get(clicks.indexOf(click));
          add(click.timestamp, 'snag', `${capitalize(NARRATIVE_TERMS.misfire)} on ${subject(info, true)} (${linkedError ? `followed by ${errorText(linkedError)}` : `a script error followed the ${touch ? 'tap' : 'click'}`})`, extra);
        } else {
          add(click.timestamp, 'clicked', clickText(click, info, touch), extra);
        }
      }
    }
    index = end;
  }

  for (const error of standalone) {
    activity.push(error.at);
    add(error.at, 'error', `JavaScript error: ${errorText(error)}`);
  }

  // Idle gaps, within this page view only.
  activity.sort((a, b) => a - b);
  let idleMs = 0;
  let longIdleMs = 0;
  for (let index = 1; index < activity.length; index++) {
    const gap = activity[index] - activity[index - 1];
    if (gap > NARRATIVE_IDLE_MS) {
      idleMs += gap;
      if (gap >= VISIT_IDLE_MS) longIdleMs += gap;
      add(activity[index - 1], 'idle', `Idle for ${narrativeSpan(gap)}`);
    }
  }

  const percentOf = (depth: number) => (docHeight ? Math.min(100, depth >= docHeight - 2 ? 100 : Math.round((depth / docHeight) * 100)) : 0);
  return {
    steps, touch, startMs, endMs, idleMs, longIdleMs, scrolled, noShows, misfires, pileUps, inactivePileUps, clicks: clicks.length, errors: errors.length,
    maxScrollPercent: percentOf(maxDepth),
  };
}

// ---------------------------------------------------------------------------------------------
// Summary

function hostOf(origin: string): string {
  try { return new URL(origin).host || origin; } catch { return origin; }
}

function visitSentence(input: {
  device: DeviceClass; durationMs: number; paths: string[]; browser?: BrowserName; os?: OsName;
}): string {
  const distinct = [...new Set(input.paths)];
  const where = distinct.length <= 1
    ? `on ${distinct[0] ?? '/'}`
    : `across ${plural(input.paths.length, 'page')} (${distinct.slice(0, 4).join(', ')}${distinct.length > 4 ? `, and ${distinct.length - 4} more` : ''})`;
  const agent = agentLabel(input.browser, input.os);
  return `${capitalize(input.device)} visit of ${narrativeSpan(input.durationMs)} ${where}${agent ? ` (${agent})` : ''}.`;
}

function snagPhrase(counts: { pileUps: string[]; noShows: number; misfires: number }): string | undefined {
  const parts: string[] = [];
  if (counts.pileUps.length === 1) parts.push(`1 ${NARRATIVE_TERMS.pileUp} on ${counts.pileUps[0]}`);
  else if (counts.pileUps.length) parts.push(plural(counts.pileUps.length, NARRATIVE_TERMS.pileUp));
  if (counts.noShows) parts.push(plural(counts.noShows, NARRATIVE_TERMS.noShow));
  if (counts.misfires) parts.push(plural(counts.misfires, NARRATIVE_TERMS.misfire));
  return parts.length ? `had ${joinList(parts)}` : undefined;
}

/** The summary of a built narrative. */
function summarize(facts: NarrativeFacts, scrolled: boolean, pileUpTargets: string[], idleMs: number): string {
  const pieces: string[] = [];
  if (scrolled && facts.maxScrollPercent > 0) pieces.push(`scrolled to ${facts.maxScrollPercent}%`);
  if (facts.clicks) pieces.push(`made ${plural(facts.clicks, facts.touch ? 'tap' : 'click')}`);
  const snags = snagPhrase({ pileUps: pileUpTargets, noShows: facts.noShows, misfires: facts.misfires });
  if (snags) pieces.push(snags);
  if (facts.errors) pieces.push(`hit ${plural(facts.errors, 'JavaScript error')}`);
  if (idleMs > 0) pieces.push(`was idle for ${narrativeSpan(idleMs)}`);
  const second = pieces.length ? `${capitalize(joinList(pieces))}.` : `No ${facts.touch ? 'taps' : 'clicks'} or scrolling were recorded.`;
  const left = facts.elapsedMs - facts.durationMs;
  const note = left > 0 ? ` The page then sat open for ${narrativeSpan(left)} with no activity, which is not counted as time on the site.` : '';
  return `${visitSentence({ device: facts.device, durationMs: facts.durationMs, paths: facts.pages, browser: facts.browser, os: facts.os })} ${second}${note}${facts.exitTo ? ` ${exitSentence(facts.exitTo)}` : ''}`;
}

/**
 * One line for a session list, from summary fields only (no events). Click counts here are per
 * click, so "pile-up clicks" counts the rapid clicks themselves; a narrative counts episodes.
 */
export function sessionOneLiner(input: {
  device: DeviceClass; durationMs: number; paths: string[]; browser?: BrowserName; os?: OsName;
  clickCount: number; rageClickCount: number; deadClickCount: number; errorClickCount: number;
  /** Where the visit went when it left through a link. See exitSentence. */
  exitTo?: string;
  /** The element with the most snag clicks. The line ends with it. */
  topSnag?: TopSnag;
}): string {
  const pieces: string[] = [];
  const press = input.device === 'desktop' ? 'click' : 'tap';
  if (input.clickCount) {
    const snags = [
      input.rageClickCount ? plural(input.rageClickCount, `${NARRATIVE_TERMS.pileUp} ${press}`) : '',
      input.deadClickCount ? plural(input.deadClickCount, NARRATIVE_TERMS.noShow) : '',
      input.errorClickCount ? plural(input.errorClickCount, NARRATIVE_TERMS.misfire) : '',
    ].filter(Boolean);
    pieces.push(`Made ${plural(input.clickCount, press)}${snags.length ? `, including ${joinList(snags)}` : ''}.`);
  } else {
    pieces.push(`No ${press}s were recorded.`);
  }
  return `${visitSentence(input)} ${pieces[0]}${input.exitTo ? ` ${exitSentence(input.exitTo)}` : ''}${input.topSnag ? ` Most snags: ${topSnagPhrase(input.topSnag)}.` : ''}`;
}

/** "Exited to /pricing." for a link that left the page: a same-site path, or another site's origin only. */
export const exitSentence = (exitTo: string): string => `Exited to ${exitTo}.`;

// ---------------------------------------------------------------------------------------------
// Build

function capSteps(steps: NarrativeStep[], max: number): NarrativeStep[] {
  if (steps.length <= max) return steps;
  // Landing, navigation, snags and the exit always stay; the rest fills what room remains.
  const must = (step: NarrativeStep) => ['landed', 'navigated', 'snag', 'error', 'left'].includes(step.kind);
  const keep = new Set<NarrativeStep>();
  const required = steps.filter(must);
  const left = required.find(step => step.kind === 'left');
  const head = required.filter(step => step !== left).slice(0, left ? max - 1 : max);
  head.forEach(step => keep.add(step));
  if (left) keep.add(left);
  for (const kind of ['idle', 'clicked', 'scrolled', 'resized'] as const) {
    for (const step of steps) {
      if (keep.size >= max) break;
      if (step.kind === kind) keep.add(step);
    }
  }
  return steps.filter(step => keep.has(step));
}

/**
 * Narrative of one visit from its page views, in play order. A single RecordingDetail makes a
 * one-page visit; a session passes the detail of each of its segments.
 */
export function buildNarrative(details: RecordingDetail[], options: NarrativeOptions = {}): Narrative | undefined {
  const privacy = options.privacy ?? 'strict';
  const max = options.maxSteps ?? NARRATIVE_MAX_STEPS;
  const ordered = [...details].sort((a, b) =>
    (a.recording.pageIndex ?? 0) - (b.recording.pageIndex ?? 0) || a.recording.startedAt - b.recording.startedAt);
  const used = ordered.slice(0, NARRATIVE_MAX_PAGES);
  const omittedPages = details.length - used.length + (options.omittedPages ?? 0);
  const first = used[0]?.recording;
  if (!first) return undefined;

  const pages = used.map(detail => ({ detail, read: readPage(detail, privacy, options.elementNames) }));
  const origin = pages[0].read.startMs;
  const raw: NarrativeStep[] = [];
  pages.forEach(({ detail, read }, index) => {
    const { recording } = detail;
    const at = (timestamp: number) => Math.max(0, timestamp - origin);
    const arrival = index === 0
      ? `Landed on ${recording.path}${recording.referrer ? ` from ${hostOf(recording.referrer)}` : ''}${recording.utm?.source ? ` (campaign source: ${recording.utm.source})` : ''}`
      : pages[index - 1].detail.recording.path === recording.path
        ? `Loaded ${recording.path} again`
        : `Went to ${recording.path}`;
    raw.push({ atMs: at(read.startMs), clock: '', kind: index === 0 ? 'landed' : 'navigated', text: arrival, recordingId: recording.id, offsetMs: 0 });
    for (const step of read.steps) {
      const { timestamp, ...rest } = step;
      raw.push({ ...rest, atMs: at(timestamp) });
    }
  });
  const last = pages[pages.length - 1];
  // Leaving is the last thing that happens: never before any step already read, whichever page view it came from.
  const leftAt = Math.max(last.read.endMs - origin, ...raw.map(step => step.atMs), 0);
  raw.push({
    atMs: leftAt, clock: '', kind: 'left',
    text: last.detail.recording.exitTo ? `Left ${last.detail.recording.path} through a link to ${last.detail.recording.exitTo}` : `Left ${last.detail.recording.path} (end of recording)`,
    recordingId: last.detail.recording.id, offsetMs: Math.max(0, origin + leftAt - last.read.startMs),
  });

  const sorted = raw
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.atMs - b.step.atMs || STEP_ORDER[a.step.kind] - STEP_ORDER[b.step.kind] || a.index - b.index)
    .map(({ step }) => ({ ...step, clock: narrativeClock(step.atMs) }));
  const steps = capSteps(sorted, max);
  const omittedSteps = sorted.length - steps.length;

  const elapsedMs = Math.max(0, Math.max(...pages.map(page => page.read.endMs)) - origin, leftAt);
  // A tab left open is not time spent: stretches of 30 minutes or more without activity are not part of the duration.
  const durationMs = Math.max(0, elapsedMs - pages.reduce((total, page) => total + page.read.longIdleMs, 0));
  const idleMs = pages.reduce((total, page) => total + page.read.idleMs, 0);
  const referrer = first.referrer;
  const utmSource = first.utm?.source;
  const facts: NarrativeFacts = {
    durationMs, elapsedMs, activeMs: Math.max(0, durationMs - Math.max(0, idleMs - pages.reduce((total, page) => total + page.read.longIdleMs, 0))),
    pages: [...new Set(used.map(detail => detail.recording.path))],
    device: segmentDeviceClass(first),
    ...(first.browser ? { browser: first.browser } : {}), ...(first.os ? { os: first.os } : {}),
    ...(referrer ? { referrer } : {}), ...(utmSource ? { utmSource } : {}),
    maxScrollPercent: Math.max(0, ...pages.map(page => page.read.maxScrollPercent)),
    clicks: pages.reduce((total, page) => total + page.read.clicks, 0),
    touch: pages.filter(page => page.read.touch).length > pages.length / 2,
    pileUps: pages.reduce((total, page) => total + page.read.pileUps.length, 0),
    ...(pages.some(page => page.read.inactivePileUps) ? { pileUpsOnNonControls: pages.reduce((total, page) => total + page.read.inactivePileUps, 0) } : {}),
    noShows: pages.reduce((total, page) => total + page.read.noShows, 0),
    misfires: pages.reduce((total, page) => total + page.read.misfires, 0),
    ...(pages.some(page => page.read.errors) ? { errors: pages.reduce((total, page) => total + page.read.errors, 0) } : {}),
    exitPage: used[used.length - 1].recording.path,
    ...(used[used.length - 1].recording.exitTo ? { exitTo: used[used.length - 1].recording.exitTo } : {}),
  };
  // The summary lists every page view, not only distinct paths, when it counts them.
  const summaryFacts = { ...facts, pages: used.map(detail => detail.recording.path) };
  const summary = summarize(summaryFacts, pages.some(page => page.read.scrolled), pages.flatMap(page => page.read.pileUps), Math.max(0, idleMs - (elapsedMs - durationMs)));

  const notes: string[] = [];
  if (omittedSteps) notes.push(`…${omittedSteps} more ${omittedSteps === 1 ? 'step' : 'steps'} not shown`);
  if (omittedPages) notes.push(`…${omittedPages} more page ${omittedPages === 1 ? 'view' : 'views'} not read`);
  return { summary, facts, steps, omittedSteps, omittedPages, ...(notes.length ? { note: notes.join('; ') } : {}) };
}
