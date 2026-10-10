/*
 * Page targeting: which page paths a project records. This module is pure and has no
 * dependencies, so the browser tracker, the collector and the dashboard preview all run
 * the same matcher.
 *
 * Patterns are path globs:
 * - An exact path matches itself: `/pricing`.
 * - `*` matches any characters within one path segment: `/blog/*`, `/docs/v*`.
 * - A segment that is exactly `**` matches zero or more whole segments: `/app/**`
 *   matches `/app`, `/app/x` and `/app/x/y`, but never `/application`.
 * - `/` matches only the home page and `/**` matches every page.
 *
 * Matching is case-sensitive. Paths are normalized before comparing: any query string or
 * fragment is dropped, percent-encoding is decoded (so `/caf%C3%A9` equals `/café`, and
 * an encoded slash `%2F` stays inside its segment), `.` and `..` segments are resolved,
 * repeated slashes collapse, and a trailing slash is ignored (`/about/` equals `/about`).
 *
 * A path is recorded when it matches any include rule, or include is empty, and it
 * matches no exclude rule. Exclude always wins.
 */

export const TARGETING_MAX_RULES = 50;
export const TARGETING_RULE_MAX_LENGTH = 200;

export interface PageTargeting { include: string[]; exclude: string[]; }
export type TargetingList = 'include' | 'exclude';
export type TargetingReason = 'no-rules' | 'excluded' | 'included' | 'not-included';
export interface TargetingDecision {
  recorded: boolean;
  reason: TargetingReason;
  /** The rule that decided the outcome. Absent when no rule applied. */
  rule?: string;
  list?: TargetingList;
}

/** Why a rule cannot be used, or undefined when it is valid. */
export function targetingRuleError(rule: unknown): string | undefined {
  if (typeof rule !== 'string') return 'A rule must be text.';
  if (!rule) return 'A rule cannot be empty.';
  if (rule.length > TARGETING_RULE_MAX_LENGTH) return `A rule can have at most ${TARGETING_RULE_MAX_LENGTH} characters.`;
  if (!rule.startsWith('/')) return 'A rule must start with /.';
  if (/[?#]/.test(rule)) return 'A rule must not include a query string or fragment.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(rule)) return 'A rule must not include spaces, control characters or backslashes.';
  for (const segment of rule.split('/')) {
    if (segment.includes('**') && segment !== '**') return 'Use ** only as a whole path segment, such as /app/**.';
    const decoded = decodeSegment(segment);
    if (decoded === '.' || decoded === '..') return 'A rule must not include . or .. segments.';
  }
  return undefined;
}

/** Validates both lists, returning the first problem found. */
export function targetingError(targeting: unknown): string | undefined {
  if (!targeting || typeof targeting !== 'object') return 'Targeting must be an object.';
  const input = targeting as Record<string, unknown>;
  for (const list of ['include', 'exclude'] as const) {
    const rules = input[list];
    if (!Array.isArray(rules)) return `${list} must be a list.`;
    if (rules.length > TARGETING_MAX_RULES) return `At most ${TARGETING_MAX_RULES} ${list} rules are allowed.`;
    for (const rule of rules) {
      const error = targetingRuleError(rule);
      if (error) return error;
    }
  }
  return undefined;
}

function decodeSegment(segment: string): string {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* Malformed escapes stay literal. */ }
  // An encoded slash must not split the segment.
  return decoded.replace(/\//g, '%2F');
}

/** Normalized path segments; the root path is an empty list. */
export function pathSegments(path: string): string[] {
  const end = path.search(/[?#]/);
  const bare = end < 0 ? path : path.slice(0, end);
  const result: string[] = [];
  for (const raw of bare.split('/')) {
    if (!raw) continue;
    const segment = decodeSegment(raw);
    if (segment === '.') continue;
    if (segment === '..') { result.pop(); continue; }
    result.push(segment);
  }
  return result;
}

/** A pattern segment: literal pieces separated by `*` wildcards. */
type Token = {kind: 'deep'} | {kind: 'glob'; pieces: string[]};

function compile(rule: string): Token[] {
  return rule.split('/').filter(Boolean).map((raw): Token => {
    if (raw === '**') return {kind: 'deep'};
    // Split on the raw wildcard first, so an encoded %2A stays a literal asterisk.
    return {kind: 'glob', pieces: raw.split('*').map(decodeSegment)};
  });
}

/** Linear-time wildcard match of one segment against literal pieces separated by `*`. */
function segmentMatches(pieces: string[], segment: string): boolean {
  if (pieces.length === 1) return pieces[0] === segment;
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (segment.length < first.length + last.length || !segment.startsWith(first) || !segment.endsWith(last)) return false;
  let position = first.length;
  const limit = segment.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = segment.indexOf(piece, position);
    if (found < 0 || found + piece.length > limit) return false;
    position = found + piece.length;
  }
  return true;
}

/** True when the glob `rule` matches `path`. Invalid rules never match. */
export function matchesTargetingRule(rule: string, path: string): boolean {
  if (targetingRuleError(rule)) return false;
  const tokens = compile(rule);
  const segments = pathSegments(path);
  // memo[i][j]: tokens[i..] match segments[j..]
  const memo: (boolean | undefined)[][] = tokens.map(() => []);
  const walk = (i: number, j: number): boolean => {
    if (i === tokens.length) return j === segments.length;
    const cached = memo[i][j];
    if (cached !== undefined) return cached;
    const token = tokens[i];
    const result = token.kind === 'deep'
      ? walk(i + 1, j) || (j < segments.length && walk(i, j + 1))
      : j < segments.length && segmentMatches(token.pieces, segments[j]) && walk(i + 1, j + 1);
    memo[i][j] = result;
    return result;
  };
  return walk(0, 0);
}

/** The first rule in `rules` that matches `path`. */
function firstMatch(rules: readonly string[], path: string): string | undefined {
  return rules.find(rule => matchesTargetingRule(rule, path));
}

/**
 * Decides whether `path` is recorded and which rule decided it. Absent or empty targeting
 * records every path.
 */
export function evaluatePageTargeting(path: string, targeting?: Partial<PageTargeting> | null): TargetingDecision {
  const include = targeting?.include ?? [];
  const exclude = targeting?.exclude ?? [];
  const excluded = firstMatch(exclude, path);
  if (excluded !== undefined) return {recorded: false, reason: 'excluded', rule: excluded, list: 'exclude'};
  if (!include.length) return {recorded: true, reason: 'no-rules'};
  const included = firstMatch(include, path);
  if (included !== undefined) return {recorded: true, reason: 'included', rule: included, list: 'include'};
  return {recorded: false, reason: 'not-included'};
}

export const isPathTargeted = (path: string, targeting?: Partial<PageTargeting> | null): boolean => evaluatePageTargeting(path, targeting).recorded;
