/*
 * Likely duplicates among issues, with simple matching a person can check by eye: the words two titles share, and the
 * same element, page or evidence ids. There is no model and no fuzzy search; every match says why it matched.
 * The caller decides which issues may be compared, so this never widens what anyone can see.
 */
import type { IssueContext, IssueKind, IssueStatus } from './issues';
import { normalizeIssueContext } from './issues';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'these', 'those', 'my', 'our', 'we', 'i', 'you', 'not', 'no', 'when', 'after', 'before', 'does', 'do', 'did', 'doesnt', 'dont', 'cant',
  'can', 'cannot', 'will', 'would', 'should', 'could', 'has', 'have', 'had', 'as', 'if', 'then', 'than', 'so', 'too', 'very', 'just', 'still', 'again',
]);

/** Lower case words without accents, punctuation or filler, with a plural or simple verb ending removed. */
export function titleTokens(title: string): string[] {
  const words = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !STOP_WORDS.has(word));
  const stem = (word: string) => {
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  };
  return [...new Set(words.map(stem))];
}

export interface SimilarityProbe { title: string; projectId?: string | undefined; context?: Partial<IssueContext> & { recordingId?: string; sessionId?: string } | undefined }
export interface SimilarityCandidate extends SimilarityProbe {
  id: string;
  number: number;
  kind: IssueKind;
  status: IssueStatus;
  updatedAt: number;
}
export interface SimilarIssue { id: string; number: number; kind: IssueKind; status: IssueStatus; title: string; score: number; reasons: string[] }

/** A match needs at least this score. */
export const SIMILARITY_THRESHOLD = 0.4;
const WEIGHTS = { title: 0.8, element: 0.25, page: 0.1, evidence: 0.15 } as const;
/** Share of title words (Dice coefficient) below this counts for nothing unless the two issues name the same element. */
const MIN_TITLE_OVERLAP = 0.3;

const hootIdOf = (selector: string | undefined) => /\[data-hoot-id=(?:"([^"]{1,80})"|'([^']{1,80})')\]/.exec(selector ?? '')?.slice(1).find(Boolean);
function elementIds(context: IssueContext | undefined): string[] {
  const source = context?.sourceLocation ? [`src:${context.sourceLocation}`] : [];
  const ids = [context?.hootId, hootIdOf(context?.elementKey), hootIdOf(context?.selector)].filter((value): value is string => !!value).map(value => `hoot:${value}`);
  const selectors = [context?.elementKey, context?.selector].filter((value): value is string => !!value).map(value => `sel:${value}`);
  return [...ids, ...selectors, ...source];
}
const sharesAny = (a: readonly string[] | undefined, b: readonly string[] | undefined) => !!a?.length && !!b?.length && a.some(item => b.includes(item));
const pathOf = (pageUrl: string) => { try { return new URL(pageUrl).pathname; } catch { return pageUrl; } };

/** How alike two issues are, with the reasons. Undefined when they are not alike enough to mention. */
export function compareIssueSimilarity(probe: SimilarityProbe, candidate: SimilarityCandidate): SimilarIssue | undefined {
  const a = normalizeIssueContext(probe.context);
  const b = normalizeIssueContext(candidate.context);
  const left = new Set(titleTokens(probe.title));
  const right = new Set(titleTokens(candidate.title));
  const shared = [...left].filter(word => right.has(word));
  const overlap = left.size + right.size === 0 ? 0 : (2 * shared.length) / (left.size + right.size);
  const reasons: string[] = [];
  let score = 0;
  if (overlap >= MIN_TITLE_OVERLAP) {
    score += WEIGHTS.title * overlap;
    reasons.push(`Titles share ${shared.slice(0, 6).join(', ')} (${Math.round(overlap * 100)}% word overlap)`);
  }
  const sameElement = sharesAny(elementIds(a), elementIds(b));
  if (sameElement) { score += WEIGHTS.element; reasons.push('Same element'); }
  const sameSite = probe.projectId !== undefined && probe.projectId === candidate.projectId;
  if (sameSite && a?.route && a.route === b?.route) { score += WEIGHTS.page; reasons.push(`Same dashboard view (${a.route})`); }
  else if (a?.pageUrl && b?.pageUrl && pathOf(a.pageUrl) === pathOf(b.pageUrl) && (sameSite || probe.projectId === undefined)) { score += WEIGHTS.page; reasons.push(`Same page (${pathOf(a.pageUrl)})`); }
  const evidence: string[] = [];
  if (sameSite) {
    if (a?.cohortKey && a.cohortKey === b?.cohortKey) evidence.push('heatmap');
    if (a?.changeId && a.changeId === b?.changeId) evidence.push('change');
    if (a?.goalId && a.goalId === b?.goalId) evidence.push('goal');
    if (a?.funnelId && a.funnelId === b?.funnelId) evidence.push('funnel');
    if (a?.errorId && a.errorId === b?.errorId) evidence.push('error');
    if (sharesAny(a?.recordingIds, b?.recordingIds)) evidence.push('visit recording');
    if (sharesAny(a?.sessionIds, b?.sessionIds)) evidence.push('visit');
  }
  if (evidence.length) { score += WEIGHTS.evidence; reasons.push(`Same ${evidence.join(', ')}`); }
  if (score < SIMILARITY_THRESHOLD || (overlap < MIN_TITLE_OVERLAP && !sameElement)) return undefined;
  return { id: candidate.id, number: candidate.number, kind: candidate.kind, status: candidate.status, title: candidate.title, score: Math.round(Math.min(1, score) * 100) / 100, reasons };
}

/** The best matches first, at most `limit`. Equal scores put the most recently updated first. */
export function findSimilarIssues(probe: SimilarityProbe, candidates: readonly SimilarityCandidate[], limit = 5): SimilarIssue[] {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate.updatedAt]));
  return candidates
    .flatMap(candidate => compareIssueSimilarity(probe, candidate) ?? [])
    .sort((x, y) => y.score - x.score || (byId.get(y.id) ?? 0) - (byId.get(x.id) ?? 0))
    .slice(0, limit);
}
