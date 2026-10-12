/*
 * Internal traffic: visits by the site's own team (staff, testing), which would otherwise dilute goal rates.
 *
 * A visit is internal in one of two ways, both chosen by the site owner in Settings:
 * - the browser opened the site's internal link (`?hootlens=internal`), which sets a flag in that browser's own
 *   local storage and is reported by the tracker with every batch, or
 * - the request address at intake is on the owner's list of IP addresses or ranges. The collector compares the
 *   address and keeps only the answer. The address itself is never stored or logged.
 *
 * Internal visits are kept and labelled, and reach no aggregate (traffic, findings, heatmaps, goals, funnels,
 * weekly summary, plan usage), the same way automated visits and test visits do. Lists leave them out unless asked.
 *
 * This module has no dependencies so the browser bundle and the dashboard can import it.
 */

/** Query parameter the tracker watches for. `internal` marks this browser, `external` clears the mark. */
export const INTERNAL_LINK_PARAM = 'hootlens';
export const INTERNAL_LINK_ON = 'internal';
export const INTERNAL_LINK_OFF = 'external';
/** Most address rules a site can list. */
export const INTERNAL_IP_RULE_LIMIT = 30;
/** Narrowest ranges accepted, so one typo cannot mark every visitor as internal. */
export const INTERNAL_MIN_PREFIX_V4 = 8;
export const INTERNAL_MIN_PREFIX_V6 = 32;

/** How a site's team is told apart from visitors. Both ways are off until the owner turns them on. */
export interface InternalTraffic {
  /** Visits from browsers that opened the internal link are internal. */
  browser: boolean;
  /** IP addresses or CIDR ranges (`203.0.113.7`, `198.51.100.0/24`, `2001:db8::/48`). Normalized by `normalizeIpRules`. */
  ips: string[];
}

/** The link a team member opens once in each browser. */
export const internalLink = (origin: string, on = true): string => {
  const url = new URL('/', origin);
  url.searchParams.set(INTERNAL_LINK_PARAM, on ? INTERNAL_LINK_ON : INTERNAL_LINK_OFF);
  return url.toString();
};

/* ------------------------------------------------------------------ address parsing */

interface ParsedAddress { family: 4 | 6; value: bigint }

function parseV4(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseV6(text: string): bigint | undefined {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.includes(':::')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]!;
      if (piece.includes('.')) {
        // An embedded IPv4 address ends the text and stands for two groups.
        if (index !== pieces.length - 1) return undefined;
        const v4 = parseV4(piece);
        if (v4 === undefined) return undefined;
        groups.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  };
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (!head || !tail) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) is the IPv4 address it wraps. */
const MAPPED_PREFIX = 0xffffn;

function parseAddress(text: string): ParsedAddress | undefined {
  if (text.includes(':')) {
    const value = parseV6(text);
    if (value === undefined) return undefined;
    if (value >> 32n === MAPPED_PREFIX) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  const value = parseV4(text);
  return value === undefined ? undefined : { family: 4, value };
}

interface CompiledRule { family: 4 | 6; network: bigint; prefix: number }

function compileRule(text: string): CompiledRule | { error: string } {
  const [address, length, ...extra] = text.split('/');
  if (extra.length || !address) return { error: 'Use an address such as 203.0.113.7 or a range such as 198.51.100.0/24' };
  const parsed = parseAddress(address);
  if (!parsed) return { error: `"${text}" is not an IP address or range` };
  const bits = parsed.family === 4 ? 32 : 128;
  let prefix = bits;
  if (length !== undefined) {
    if (!/^\d{1,3}$/.test(length)) return { error: `"${text}" has an unreadable range length` };
    prefix = Number(length);
    if (prefix > bits) return { error: `"${text}" has a range length above ${bits}` };
  }
  const floor = parsed.family === 4 ? INTERNAL_MIN_PREFIX_V4 : INTERNAL_MIN_PREFIX_V6;
  if (prefix < floor) return { error: `"${text}" covers too many addresses. Use a range of /${floor} or narrower` };
  const host = BigInt(bits - prefix);
  return { family: parsed.family, network: (parsed.value >> host) << host, prefix };
}

/** The rule as it is stored: an IPv4-mapped address becomes its IPv4 form, text is trimmed and lower-cased. */
function canonical(text: string): string {
  const lower = text.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})(\/(\d{1,3}))?$/.exec(lower);
  if (mapped) return mapped[3] !== undefined ? `${mapped[1]}/${Math.max(0, Number(mapped[3]) - 96)}` : mapped[1]!;
  return lower;
}

/** A connection address in the form a rule stores it, or undefined when it cannot be read. */
export function ruleForAddress(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const text = canonical(ip);
  return parseAddress(text) ? text : undefined;
}

/** Validated, de-duplicated rules in the order given, or the first problem in plain words. */
export function normalizeIpRules(input: readonly string[]): { ok: true; rules: string[] } | { ok: false; error: string } {
  const rules: string[] = [];
  for (const raw of input) {
    const text = canonical(raw);
    if (!text) continue;
    const compiled = compileRule(text);
    if ('error' in compiled) return { ok: false, error: compiled.error };
    if (!rules.includes(text)) rules.push(text);
  }
  if (rules.length > INTERNAL_IP_RULE_LIMIT) return { ok: false, error: `List at most ${INTERNAL_IP_RULE_LIMIT} addresses or ranges` };
  return { ok: true, rules };
}

const compiledRules = new Map<string, CompiledRule[]>();

/** True when the address is one of the rules. An address that cannot be read matches nothing. */
export function ipMatchesRules(ip: string | undefined, rules: readonly string[] | undefined): boolean {
  if (!ip || !rules?.length) return false;
  const address = parseAddress(ip.trim().toLowerCase());
  if (!address) return false;
  const cacheKey = rules.join('\n');
  let compiled = compiledRules.get(cacheKey);
  if (!compiled) {
    compiled = rules.flatMap(rule => {
      const result = compileRule(canonical(rule));
      return 'error' in result ? [] : [result];
    });
    if (compiledRules.size >= 200) compiledRules.clear();
    compiledRules.set(cacheKey, compiled);
  }
  const bits = address.family === 4 ? 32 : 128;
  return compiled.some(rule => {
    if (rule.family !== address.family) return false;
    const host = BigInt(bits - rule.prefix);
    return (address.value >> host) << host === rule.network;
  });
}

/* ------------------------------------------------------------------ exit destination */

/** Longest exit destination: a path, or an origin. */
export const EXIT_MAX_LENGTH = 300;
// eslint-disable-next-line no-control-regex -- control characters never belong in a recorded address
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * True for a destination the tracker may report when a click leaves the page: a same-site path with no query or
 * fragment (`/pricing`), or another site's origin alone (`https://example.org`, never a path, query or fragment,
 * never credentials).
 */
export function isExitDestination(value: string): boolean {
  if (!value || value.length > EXIT_MAX_LENGTH || CONTROL.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//') && !/[?#\\]/.test(value);
  return /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(value);
}
