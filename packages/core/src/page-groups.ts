/*
 * Page groups: one logical page across locales, experiment variants and trailing-slash or
 * query differences. This module is pure and has no dependencies beyond the targeting
 * matcher, so the browser tracker, the collector and the dashboard run the same rules.
 *
 * A visit's group is the first configured group whose `match` globs (the same syntax as page
 * targeting) match its recorded path or its normalized path, else an automatic group named by
 * the normalized path. Normalizing strips a leading locale segment (`/es`, `/fr-ca`), maps a
 * bare locale root to `/`, ignores the query string and drops a trailing slash.
 */
import { matchesTargetingRule, pathSegments } from './targeting';

export interface PageGroup { id: string; name: string; match: string[]; }
/** Project-level grouping options. Absent fields use the defaults below. */
export interface GroupingOptions {
  /** Leading path segments treated as locales. Replaces DEFAULT_LOCALE_PREFIXES when set. */
  localePrefixes?: readonly string[];
  /** Query parameters that name an experiment variant, added to DEFAULT_VARIANT_PARAMS. */
  variantParams?: readonly string[];
  /** What starts a new page version: a new `release`, or a change in the page's own `content`. Absent means `content`. */
  pageVersionMode?: PageVersionMode;
}
/**
 * How a page's version is derived. `release` follows the site's release label, so a site-wide deploy starts a new
 * version for every page. `content` follows the page's structural fingerprint, so the version changes only when
 * that page group's content changes, with or without a deploy.
 */
export type PageVersionMode = 'release' | 'content';
export const PAGE_VERSION_MODES: readonly PageVersionMode[] = ['release', 'content'];
export const DEFAULT_PAGE_VERSION_MODE: PageVersionMode = 'content';
export const pageVersionModeOf = (options: Pick<GroupingOptions, 'pageVersionMode'> | undefined): PageVersionMode =>
  options?.pageVersionMode ?? DEFAULT_PAGE_VERSION_MODE;

/** Common ISO 639-1 codes. Codes that are also everyday page names (`no`, `to`, `as`) are left out. */
export const DEFAULT_LOCALE_PREFIXES: readonly string[] = [
  'af', 'am', 'ar', 'az', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fr', 'ga', 'gl', 'gu',
  'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk', 'km', 'ko', 'lo', 'lt', 'lv', 'mk', 'ml', 'mr', 'ms', 'mt',
  'my', 'nb', 'ne', 'nl', 'nn', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk',
  'ur', 'uz', 'vi', 'xh', 'yo', 'zh', 'zu',
];
/** Query parameters read as experiment variants. `utm_content` is a campaign field and is deliberately not here. */
export const DEFAULT_VARIANT_PARAMS: readonly string[] = ['experience', 'variant', 'ab', 'exp', '_vwo', 'optimizely'];
export const MAX_GROUPS = 50;
export const MAX_GROUP_RULES = 20;
export const MAX_VARIANT_VALUE = 100;
export const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PARAM_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
export const LOCALE_PREFIX_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/;

// eslint-disable-next-line no-control-regex -- control characters never belong in a variant value
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Primary language subtag of a BCP 47 tag, lower case: `es-MX` is `es`. Undefined when it is not a language tag. */
export function normalizeLocale(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

function localeOfSegment(segment: string, prefixes: ReadonlySet<string>): string | undefined {
  const lower = segment.toLowerCase();
  if (prefixes.has(lower)) return lower.split(/[-_]/)[0];
  const region = /^([a-z]{2,3})[-_][a-z]{2,4}$/.exec(lower);
  return region && prefixes.has(region[1]) ? region[1] : undefined;
}

export interface ExperimentParam { name: string; value: string; }
type QueryInput = string | URLSearchParams | undefined | null;

function paramsOf(path: string, query: QueryInput): URLSearchParams {
  if (query instanceof URLSearchParams) return query;
  const fromPath = path.includes('?') ? path.slice(path.indexOf('?') + 1).split('#')[0] : '';
  const text = typeof query === 'string' ? query : fromPath;
  try { return new URLSearchParams(text); } catch { return new URLSearchParams(); }
}

/** The first experiment parameter in a query, by query order. Names compare case-insensitively. */
export function detectExperiment(query: QueryInput, extra: readonly string[] = []): ExperimentParam | undefined {
  if (!query) return undefined;
  const names = new Set([...DEFAULT_VARIANT_PARAMS, ...extra].map(name => name.toLowerCase()));
  let params: URLSearchParams;
  try { params = query instanceof URLSearchParams ? query : new URLSearchParams(query); } catch { return undefined; }
  for (const [name, raw] of params) {
    const value = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VARIANT_VALUE);
    if (value && names.has(name.toLowerCase())) return { name: name.toLowerCase(), value };
  }
  return undefined;
}

export interface NormalizedPage {
  /** Path without locale prefix, query or trailing slash. */
  path: string;
  /** Primary language from a locale prefix such as `/es`. */
  locale?: string;
  /** Experiment parameter found in `query`, or in the path's own query string. */
  experiment?: ExperimentParam;
}

/**
 * Normalizes a recorded path for grouping. `query` is a query string or URLSearchParams; when
 * omitted, a query string inside `path` is used. The query never changes the returned path: it
 * only supplies the experiment parameter.
 */
export function normalizePagePath(path: string, query?: QueryInput, options: GroupingOptions = {}): NormalizedPage {
  const prefixes = new Set((options.localePrefixes ?? DEFAULT_LOCALE_PREFIXES).map(prefix => prefix.toLowerCase()));
  const segments = pathSegments(path);
  const locale = segments.length ? localeOfSegment(segments[0], prefixes) : undefined;
  const rest = locale ? segments.slice(1) : segments;
  const result: NormalizedPage = { path: `/${rest.join('/')}` };
  if (locale) result.locale = locale;
  const experiment = detectExperiment(paramsOf(path, query), options.variantParams);
  if (experiment) result.experiment = experiment;
  return result;
}

/** Variant label stored on a recording: `experience=legacy-home-a`. */
export const experimentLabel = (experiment: ExperimentParam): string => `${experiment.name}=${experiment.value}`.slice(0, MAX_VARIANT_VALUE);

/** Readable variant for lists: the common `experience=` and `variant=` names are dropped. */
export function variantDisplay(variant: string): string {
  return variant.replace(/^(?:experience|variant)=/, '');
}

const HASHED = /^h[0-9a-f]{8}$/;
/** Short non-cryptographic hash for strict projects: `h` plus 8 hex digits. Identical in the tracker and the collector. */
export function hashExperimentValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const DIGIT_RUN = /\d{6,}/g;
const star = (match: string) => match.replace(/\S/g, '*');
/** Balanced redaction of a short value: emails, card-like numbers and digit runs of six or more. */
export const redactExperimentValue = (value: string): string => value.replace(EMAIL, star).replace(CARD, star).replace(DIGIT_RUN, star);

/**
 * Applies the privacy preset to an experiment parameter, in the tracker and again in the collector.
 * Only allow-listed names pass in every preset. Full keeps the value, balanced redacts it and strict
 * replaces it with a hash, so strict projects never store the readable value.
 */
export function gateExperiment(
  experiment: ExperimentParam | undefined, preset: 'full' | 'balanced' | 'strict', extra: readonly string[] = [],
): ExperimentParam | undefined {
  if (!experiment || !PARAM_NAME_PATTERN.test(experiment.name)) return undefined;
  const allowed = new Set([...DEFAULT_VARIANT_PARAMS, ...extra].map(name => name.toLowerCase()));
  const name = experiment.name.toLowerCase();
  if (!allowed.has(name)) return undefined;
  const clean = experiment.value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VARIANT_VALUE);
  if (!clean) return undefined;
  if (preset === 'strict') return { name, value: HASHED.test(clean) ? clean : hashExperimentValue(clean) };
  return { name, value: preset === 'balanced' ? redactExperimentValue(clean) : clean };
}

export interface ResolvedGroup {
  /** The configured group's id, or the normalized path for an automatic group. */
  id: string;
  custom: boolean;
  /** Normalized path. */
  path: string;
  locale?: string;
}

/** The first group whose rules match the path or its normalized form, else the automatic group. */
export function resolvePageGroup(path: string, groups: readonly PageGroup[] = [], options: GroupingOptions = {}): ResolvedGroup {
  const normalized = normalizePagePath(path, undefined, options);
  for (const group of groups) {
    if (group.match.some(rule => matchesTargetingRule(rule, path) || matchesTargetingRule(rule, normalized.path))) {
      return { id: group.id, custom: true, path: normalized.path, ...(normalized.locale ? { locale: normalized.locale } : {}) };
    }
  }
  return { id: normalized.path, custom: false, path: normalized.path, ...(normalized.locale ? { locale: normalized.locale } : {}) };
}

/** Name for an automatic group: the home page, or the normalized path. */
export const autoGroupName = (path: string): string => (path === '/' ? 'Homepage' : path);

/** Display name for a group id, from the project's groups. */
export function pageGroupName(id: string, groups: readonly Pick<PageGroup, 'id' | 'name'>[] = []): string {
  return groups.find(group => group.id === id)?.name ?? autoGroupName(id);
}

/** A language in its own words (`es` is "Español"), so visitors' languages read the way they do on the site. */
export function localeName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch { /* Unsupported locale data. */ }
  return code.toUpperCase();
}
