/*
 * JavaScript error capture, zod-free so the tracker bundle, the collector and the dashboard share one set of rules.
 *
 * The tracker turns an `error` or `unhandledrejection` event into a RecordedError with `captureError`; the
 * collector runs `reapplyErrorPolicy` on every error it receives, so a modified or stale tracker cannot store more
 * than the project's privacy policy allows. The shapes are validated by recordedErrorSchema in errors.ts.
 *
 * What an error can carry, by privacy preset:
 * - strict: the error name, a hash of the normalized message (never the message), and the stack frames' script
 *   locations (script URL without query unless the project keeps queries, line, column, function name).
 * - balanced: the same plus the message with obvious personal data removed (see scrubErrorMessage).
 * - full: the same plus the message as the browser reported it.
 *
 * An error message is free text written by the site's code. It can quote anything the code had in hand, including
 * text a visitor typed. Scrubbing recognises emails, long digit runs, card and phone shapes, bearer and long
 * random-looking tokens, and URL query values. It does not recognise names, addresses or free prose, which is why
 * strict never sends the message at all.
 */
import { stripAdClickParams } from './sources';

export type ErrorKind = 'error' | 'rejection';
export interface ErrorFrame {
  /** Script URL: http or https only, no credentials, no fragment, and no query unless the project keeps queries. */
  url?: string;
  line?: number;
  col?: number;
  fn?: string;
}
export interface RecordedError {
  /** When it happened, epoch ms. The replay places the marker at this time minus the page view's start. */
  at: number;
  kind: ErrorKind;
  /** The error's name, such as TypeError. `Error` when the thrown value had none. */
  name: string;
  /** Not sent under strict. Scrubbed under balanced. */
  message?: string;
  /** 16 hex digits of the normalized message, sent under every preset. It groups errors; it is not a secret. */
  messageHash: string;
  /** True for the browser's "Script error." for a cross-origin script: nothing but that fact is known. */
  opaque?: true;
  frames: ErrorFrame[];
  /** Time of the click this error followed within the link window, so the misfire or pile-up can be tied to it. */
  clickAt?: number;
  /** Selector of that click's element, the same value the click carries. */
  selector?: string;
}

export const ERROR_LIMITS = {
  /** Distinct errors one page view reports. */
  perPageView: 20,
  message: 300,
  frames: 15,
  /** Frames kept in storage and shown. */
  storedFrames: 12,
  url: 300,
  fn: 80,
  name: 60,
  selector: 300,
} as const;
/** An error this soon after a click, on the same page view, is linked to that click. */
export const ERROR_LINK_WINDOW_MS = 2000;

/** Limits of source map storage. */
export const SOURCE_MAP_LIMITS = {
  /** One map, in bytes of JSON. */
  fileBytes: 25 * 1024 * 1024,
  filesPerRelease: 300,
  filesPerProject: 1500,
  file: 300,
} as const;

export interface ErrorPolicy { preset: 'full' | 'balanced' | 'strict'; captureQueryStrings: boolean }

/* ---------------------------------------------------------------- hashing */

/** 16 hex digits from two independent 32-bit mixes. Non-cryptographic: it only has to group equal messages. */
export function hashText(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 0x85ebca6b);
    b ^= b >>> 13;
    b = Math.imul(b, 0xc2b2ae35);
  }
  a ^= b >>> 16;
  b ^= a >>> 15;
  return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0'));
}

/* ---------------------------------------------------------------- messages */

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Eight or more hex digits with at least one letter; digits alone are numbers. */
const HEX_RUN = /\b(?=[0-9]*[a-f])[0-9a-f]{8,}\b/gi;
const NUMBER = /\d+(?:\.\d+)?/g;
const QUOTED = /(["'`])((?:(?!\1).){1,200})\1/g;
const IDENTIFIER = /^[A-Za-z_$][\w$.-]{0,60}$/;

/**
 * The message with the parts that vary between occurrences replaced, so the same bug groups together: URLs, emails,
 * UUIDs, long hex runs, numbers, and quoted text that is not a plain identifier (property and function names inside
 * quotes are kept, because they are what tells two errors apart).
 */
export function normalizeErrorMessage(message: string): string {
  return message.slice(0, 600)
    .replace(URL_IN_TEXT, '<url>')
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .replace(QUOTED, (_all, quote: string, inner: string) => (IDENTIFIER.test(inner) ? `${quote}${inner}${quote}` : `${quote}<text>${quote}`))
    .replace(HEX_RUN, '<hex>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_LIMITS.message);
}

const star = (match: string) => match.replace(/\S/g, '*');
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\b\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g;
const DIGIT_RUN = /\d{6,}/g;
const BEARER = /\b(bearer|basic|token|apikey|api_key|authorization)\b(\s*[:=]?\s*)[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const LONG_TOKEN = /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{24,}\b/g;
const HEX_TOKEN = /\b[0-9a-f]{16,}\b/gi;

/** Query values in URLs become `*`; credentials and fragments are removed. Keys stay, because they name what was asked for. */
export function scrubUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, url => {
    const withoutHash = url.split('#', 1)[0] ?? url;
    const noCredentials = withoutHash.replace(/^(https?:\/\/)[^/?@]*@/i, '$1');
    const query = noCredentials.indexOf('?');
    if (query < 0) return noCredentials;
    const search = noCredentials.slice(query + 1).split('&').map(pair => {
      const equals = pair.indexOf('=');
      return equals < 0 ? pair : `${pair.slice(0, equals)}=*`;
    }).join('&');
    return `${noCredentials.slice(0, query)}?${search}`;
  });
}

/** Balanced redaction of an error message. See the file comment for what this does not catch. */
export function scrubErrorMessage(message: string): string {
  return scrubUrlsInText(message.slice(0, ERROR_LIMITS.message * 2))
    .replace(EMAIL, star)
    .replace(JWT, '[token]')
    .replace(BEARER, (_all, word: string, gap: string) => `${word}${gap}[token]`)
    .replace(LONG_TOKEN, '[token]')
    .replace(HEX_TOKEN, '[token]')
    .replace(CARD, star)
    .replace(PHONE, star)
    .replace(DIGIT_RUN, star)
    // eslint-disable-next-line no-control-regex -- control characters never belong in a recorded message
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .slice(0, ERROR_LIMITS.message);
}

/* ---------------------------------------------------------------- URLs */

/** True for addresses of browser extensions, whose errors belong to the visitor's browser and not to the site. */
export const EXTENSION_URL = /^(?:chrome|moz|safari|safari-web|ms-browser|edge)-extension:/i;

/**
 * A script URL as it may be recorded: http or https only, credentials and fragment removed, and the query kept only
 * when the project keeps queries (ad click parameters never). Anything else (inline, eval, data, blob, extension)
 * has no URL. Under balanced, kept query values are masked.
 */
export function sanitizeScriptUrl(raw: string | undefined, policy: ErrorPolicy): string | undefined {
  if (!raw || raw.length > 2000) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  let query = policy.captureQueryStrings ? stripAdClickParams(url.search) : '';
  if (query && policy.preset !== 'full') {
    query = `?${query.slice(1).split('&').map(pair => { const equals = pair.indexOf('='); return equals < 0 ? pair : `${pair.slice(0, equals)}=*`; }).join('&')}`;
  }
  const clean = `${url.origin}${url.pathname}${query}`;
  return clean.length > ERROR_LIMITS.url ? clean.slice(0, ERROR_LIMITS.url) : clean;
}

/* ---------------------------------------------------------------- stacks */

const lineNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000_000 ? parsed : undefined;
};

/** Characters a function name may hold. No colon, at sign, quote or parenthesis, so a line of message text is never taken for a name. */
const FUNCTION_NAME = /^[\w$.<>[\]/*\s-]{1,80}$/;

const functionName = (value: string | undefined): string | undefined => {
  const name = (value ?? '').replace(/^async\s+/, '').replace(/\s+/g, ' ').trim();
  if (!name || name === '<anonymous>' || name === 'anonymous' || !FUNCTION_NAME.test(name)) return undefined;
  return name;
};

/**
 * Parses a `stack` string from V8 (Chrome, Edge, Node) or from Firefox and Safari into frames. Lines that are not
 * frames (the message, native code) are skipped. Frames keep their raw URL here; sanitize them before recording.
 */
export function parseStack(stack: string | undefined): ErrorFrame[] {
  if (!stack) return [];
  const frames: ErrorFrame[] = [];
  const lines = stack.slice(0, 20_000).split('\n');
  // V8 stacks start with the error's name and message, which can hold anything and must never be read as a frame:
  // when any line is a V8 frame, only V8 frames are parsed.
  const v8 = lines.some(line => /^\s*at\s/.test(line));
  for (const raw of lines) {
    if (frames.length >= ERROR_LIMITS.frames * 2) break;
    const line = raw.trim();
    if (!line || line.length > 2000 || line.includes('[native code]')) continue;
    let fn: string | undefined;
    let location: string;
    if (v8 && !/^at\s/.test(line)) continue;
    if (/^at\s/.test(line)) {
      // V8: "at fn (url:1:2)" or "at url:1:2". An eval frame ends with the evaluating location in parentheses.
      let rest = line.slice(3).trim().replace(/^async\s+/, '');
      const close = rest.endsWith(')') ? rest.lastIndexOf('(') : -1;
      if (close >= 0) { fn = rest.slice(0, close).trim(); rest = rest.slice(close + 1, -1); }
      location = rest.replace(/^eval at [^,]*,\s*/, '');
    } else {
      // Firefox and Safari: "fn@url:1:2" or "@url:1:2".
      const at = line.indexOf('@');
      if (at < 0) continue;
      fn = line.slice(0, at);
      location = line.slice(at + 1);
    }
    const match = /^(.*?):(\d+):(\d+)$/.exec(location) ?? /^(.*?):(\d+)$/.exec(location);
    const url = (match ? match[1] : location).trim();
    const frame: ErrorFrame = {};
    if (url && url !== '<anonymous>' && url !== 'native') frame.url = url;
    const row = lineNumber(match?.[2]);
    const col = lineNumber(match?.[3]);
    if (row !== undefined) frame.line = row;
    if (col !== undefined) frame.col = col;
    const name = functionName(fn);
    if (name) frame.fn = name;
    if (frame.url || frame.fn) frames.push(frame);
  }
  return frames;
}

/** Frames with sanitized URLs. Frames from browser extensions mark the whole error as not the site's (see isExtensionError). */
export function sanitizeFrames(frames: readonly ErrorFrame[], policy: ErrorPolicy, limit: number = ERROR_LIMITS.frames): ErrorFrame[] {
  const clean: ErrorFrame[] = [];
  for (const frame of frames) {
    if (clean.length >= limit) break;
    const url = sanitizeScriptUrl(frame.url, policy);
    const line = frame.line !== undefined && Number.isInteger(frame.line) && frame.line >= 0 && frame.line <= 10_000_000 ? frame.line : undefined;
    const col = frame.col !== undefined && Number.isInteger(frame.col) && frame.col >= 0 && frame.col <= 10_000_000 ? frame.col : undefined;
    const fn = functionName(frame.fn);
    if (!url && !fn) continue;
    clean.push({ ...(url ? { url } : {}), ...(line !== undefined ? { line } : {}), ...(col !== undefined ? { col } : {}), ...(fn ? { fn } : {}) });
  }
  return clean;
}

/** True when any raw frame (or the reporting file) is a browser extension's script. */
export const isExtensionError = (frames: readonly ErrorFrame[], filename?: string): boolean =>
  (filename !== undefined && EXTENSION_URL.test(filename)) || frames.some(frame => frame.url !== undefined && EXTENSION_URL.test(frame.url));

/* ---------------------------------------------------------------- building an error */

/** What the browser hands the tracker for one error. All of it is untrusted text. */
export interface RawError {
  kind: ErrorKind;
  at: number;
  name?: string;
  message?: string;
  stack?: string;
  /** ErrorEvent.filename, lineno and colno: the top frame when there is no stack. */
  filename?: string;
  lineno?: number;
  colno?: number;
  clickAt?: number;
  selector?: string;
}

export const SCRIPT_ERROR_MESSAGE = 'Script error.';
const NAME_PATTERN = /^[A-Za-z_$][\w$.:-]{0,59}$/;

/** A usable error name: identifier-like, at most 60 characters. */
export function errorName(value: unknown, fallback = 'Error'): string {
  return typeof value === 'string' && NAME_PATTERN.test(value.trim()) ? value.trim() : fallback;
}

/**
 * Builds the recorded error for one raw browser error under a privacy policy, or null when it should not be recorded
 * (a browser extension's error, or nothing identifiable). The message hash is taken from the unscrubbed, normalized
 * message so that every preset groups the same bug the same way.
 */
export function captureError(raw: RawError, policy: ErrorPolicy): RecordedError | null {
  const message = (raw.message ?? '').slice(0, 2000);
  const parsed = parseStack(raw.stack);
  const frames = parsed.length || !raw.filename ? parsed : [{ url: raw.filename, line: raw.lineno, col: raw.colno }];
  if (isExtensionError(frames, raw.filename)) return null;
  // A cross-origin script reports only "Script error." with no location. Nothing else about it is known.
  const opaque = message.trim() === SCRIPT_ERROR_MESSAGE && !frames.length;
  const name = errorName(raw.name, raw.kind === 'rejection' ? 'UnhandledRejection' : 'Error');
  if (!message.trim() && !frames.length && !opaque) return null;
  const normalized = normalizeErrorMessage(message);
  const clean = sanitizeFrames(frames, policy);
  const kept = policy.preset === 'strict' ? undefined : policy.preset === 'balanced' ? scrubErrorMessage(message) : message.slice(0, ERROR_LIMITS.message);
  return {
    at: Math.round(raw.at), kind: raw.kind, name,
    ...(kept ? { message: kept } : {}),
    messageHash: hashText(normalized),
    ...(opaque ? { opaque: true as const } : {}),
    frames: clean,
    ...(raw.clickAt !== undefined ? { clickAt: raw.clickAt } : {}),
    ...(raw.selector ? { selector: raw.selector.slice(0, ERROR_LIMITS.selector) } : {}),
  };
}

/** Why the collector refuses an error, or null when it is acceptable (after `reapplyErrorPolicy`). */
export function errorPolicyViolation(error: Pick<RecordedError, 'message'>, policy: ErrorPolicy): string | null {
  return policy.preset === 'strict' && error.message !== undefined ? 'error message not allowed under strict' : null;
}

/**
 * The error as the project's policy allows it, for the collector. URLs are cleaned again, a balanced message is
 * scrubbed again, and a strict project's message is dropped (callers refuse the batch with `errorPolicyViolation`
 * first, so a message never silently travels).
 */
export function reapplyErrorPolicy(error: RecordedError, policy: ErrorPolicy): RecordedError {
  const message = error.message === undefined || policy.preset === 'strict' ? undefined
    : policy.preset === 'balanced' ? scrubErrorMessage(error.message) : error.message.slice(0, ERROR_LIMITS.message);
  const clean: RecordedError = { ...error, frames: sanitizeFrames(error.frames, policy) };
  delete clean.message;
  if (message) clean.message = message;
  return clean;
}

/* ---------------------------------------------------------------- grouping */

/** The frame that identifies where an error came from: the first frame with a script URL, else the first frame. */
export function topFrame(frames: readonly ErrorFrame[]): ErrorFrame | undefined {
  return frames.find(frame => frame.url !== undefined) ?? frames[0];
}

/** Text that names a frame for grouping: script URL without query, line, column and function. */
export function frameKey(frame: ErrorFrame | undefined): string {
  if (!frame) return '';
  const url = (frame.url ?? '').split('?', 1)[0];
  return `${url}:${frame.line ?? ''}:${frame.col ?? ''}:${frame.fn ?? ''}`;
}

/** The parts a fingerprint is made from: name, normalized message hash and the top frame. Hash them with SHA-256 server side. */
export const fingerprintSource = (error: Pick<RecordedError, 'name' | 'messageHash' | 'frames'>): string =>
  `${error.name}\n${error.messageHash}\n${frameKey(topFrame(error.frames))}`;

/**
 * Finds the click an error followed: the error's own `clickAt` when it names a click in `clicks`, else the latest click
 * of any kind that happened within the link window before the error. Returns its index in `clicks`.
 */
export function linkedClickIndex(error: Pick<RecordedError, 'at' | 'clickAt'>, clicks: readonly { timestamp: number; kind: string }[]): number | undefined {
  if (error.clickAt !== undefined) {
    const exact = clicks.findIndex(click => click.timestamp === error.clickAt);
    if (exact >= 0) return exact;
  }
  let best: number | undefined;
  clicks.forEach((click, index) => {
    const gap = error.at - click.timestamp;
    if (gap < 0 || gap > ERROR_LINK_WINDOW_MS) return;
    if (best === undefined || click.timestamp >= clicks[best]!.timestamp) best = index;
  });
  return best;
}

/** `TypeError: message`, or just the name under strict. */
export function describeError(error: { name: string; message?: string; opaque?: boolean }): string {
  if (error.opaque) return 'Script error (a cross-origin script; the browser withholds the details)';
  return error.message ? `${error.name}: ${error.message}` : error.name;
}
