import { z } from 'zod';
import { changeInputSchema, type ChangeMarker } from './changes';
import { improvementSourceSchema, type ImprovementSource } from './improvements';

export const MAX_FINDING_WORK = 500;
export const MAX_FINDING_WORK_HISTORY = 100;
export const FINDING_WORK_LIST_HISTORY = 3;
export const MAX_FINDING_WORK_BYTES = 512 * 1024;
export const FINDING_SNOOZE_MAX_DAYS = 90;
export const FINDING_WORK_STATUSES = ['open', 'in_progress', 'snoozed', 'dismissed', 'fixed'] as const;
export type FindingWorkStatus = (typeof FINDING_WORK_STATUSES)[number];
export const findingWorkIdSchema = z.string().regex(/^finding_[0-9a-f]{64}$/);
const userId = z.string().min(1).max(200);
const time = z.number().int().positive();

/** A saved link is a reference, not proof of a GitHub issue's state or access. */
export const findingGithubUrlSchema = z.string().max(500).refine(value => {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/(?:issues|pull)\/[1-9][0-9]*$/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}, 'Use a GitHub issue or pull request link without query parameters or fragments.');

export const findingDeploymentSchema = changeInputSchema.omit({ source: true, pageGroup: true }).strict();
export const findingWorkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('reopen') }).strict(),
  z.object({ type: z.literal('assign'), userId: userId.nullable() }).strict(),
  z.object({ type: z.literal('snooze'), until: time }).strict(),
  z.object({ type: z.literal('dismiss'), reason: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ type: z.literal('linkGithub'), url: findingGithubUrlSchema.nullable() }).strict(),
  z.object({ type: z.literal('linkChange'), changeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable() }).strict(),
  z.object({ type: z.literal('deploy'), change: findingDeploymentSchema }).strict(),
]);
export type FindingWorkAction = z.infer<typeof findingWorkActionSchema>;
export const findingWorkRequestSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  expectedRevision: z.number().int().min(0),
  action: findingWorkActionSchema,
}).strict();
export type FindingWorkRequest = z.infer<typeof findingWorkRequestSchema>;

const findingHistorySchema = z.object({
  at: time, actorId: userId, action: z.enum(['start', 'reopen', 'assign', 'snooze', 'dismiss', 'linkGithub', 'linkChange', 'deploy']),
  revision: z.number().int().positive(), status: z.enum(FINDING_WORK_STATUSES),
  assigneeId: userId.optional(), until: time.optional(), reason: z.string().max(500).optional(),
  githubUrl: findingGithubUrlSchema.optional(), changeId: z.string().max(200).optional(),
}).strict();
export type FindingWorkEvent = z.infer<typeof findingHistorySchema>;
export const findingWorkSchema = z.object({
  id: findingWorkIdSchema, projectId: z.string().min(1).max(200), source: improvementSourceSchema,
  revision: z.number().int().positive(), status: z.enum(FINDING_WORK_STATUSES),
  assigneeId: userId.optional(), snoozedUntil: time.optional(), reason: z.string().max(500).optional(),
  githubUrl: findingGithubUrlSchema.optional(), changeId: z.string().max(200).optional(),
  createdAt: time, updatedAt: time,
  history: z.array(findingHistorySchema).max(MAX_FINDING_WORK_HISTORY),
}).strict();
export type FindingWork = z.infer<typeof findingWorkSchema>;
export type FindingWorkView = FindingWork & { effectiveStatus: FindingWorkStatus; changeAvailable: boolean; historyCount: number; historyTruncated: boolean };
export interface FindingWorkList { items: FindingWorkView[]; limit: number; }
export interface FindingAssignee { userId: string; name: string; role: string; }

/** Receipts are bounded server metadata and never returned by the API. */
export type FindingWorkRecord = FindingWork & { operations: { id: string; hash: string; revision: number }[] };
export const findingWorkRecordSchema = findingWorkSchema.extend({
  operations: z.array(z.object({ id: z.string().min(16).max(80), hash: z.string().regex(/^[0-9a-f]{64}$/), revision: z.number().int().positive() }).strict()).max(MAX_FINDING_WORK_HISTORY),
}).strict();

export function effectiveFindingStatus(work: Pick<FindingWork, 'status' | 'snoozedUntil'>, now: number): FindingWorkStatus {
  return work.status === 'snoozed' && (work.snoozedUntil ?? 0) <= now ? 'open' : work.status;
}

export class FindingWorkError extends Error {
  constructor(readonly code: 'stale' | 'operation_conflict' | 'missing_evidence' | 'invalid_action' | 'missing_change', message: string) { super(message); }
}
export interface FindingWorkApply {
  projectId: string; id: string; actorId: string; at: number; request: FindingWorkRequest; requestHash: string;
  source?: ImprovementSource;
  /** The store reads this marker in the same atomic operation, or creates it with the work. */
  change?: ChangeMarker;
}
export interface FindingWorkApplied { record: FindingWorkRecord; replayed: boolean; }

/** Pure mutation used inside both stores' atomic writes. An old revision never overwrites another person's work. */
export function applyFindingWork(current: FindingWorkRecord | undefined, input: FindingWorkApply): FindingWorkApplied {
  const { request, at, actorId } = input;
  if (current && (current.id !== input.id || current.projectId !== input.projectId)) throw new FindingWorkError('invalid_action', 'This finding belongs to a different site.');
  const known = current?.operations.find(operation => operation.id === request.operationId);
  if (known) {
    if (known.hash !== input.requestHash) throw new FindingWorkError('operation_conflict', 'This action was already used for different changes. Refresh and try again.');
    return { record: current!, replayed: true };
  }
  if ((current?.revision ?? 0) !== request.expectedRevision) throw new FindingWorkError('stale', 'Someone changed this finding. Refresh it before saving your changes.');
  if (!current && !input.source) throw new FindingWorkError('missing_evidence', 'This finding is no longer in the current evidence. Refresh Improvements and choose a current finding.');
  const source = current?.source ?? improvementSourceSchema.parse(input.source);
  const base: FindingWorkRecord = current ? structuredClone(current) : {
    id: input.id, projectId: input.projectId, source, revision: 0, status: 'open', createdAt: at, updatedAt: at, history: [], operations: [],
  };
  const action = request.action;
  const event: FindingWorkEvent = { at, actorId, action: action.type, revision: base.revision + 1, status: base.status };
  switch (action.type) {
    case 'start': case 'reopen':
      base.status = action.type === 'start' ? 'in_progress' : 'open';
      delete base.snoozedUntil; delete base.reason; delete base.changeId;
      break;
    case 'assign':
      if (action.userId === null) delete base.assigneeId;
      else { base.assigneeId = action.userId; event.assigneeId = action.userId; }
      break;
    case 'snooze':
      if (action.until <= at || action.until > at + FINDING_SNOOZE_MAX_DAYS * 86_400_000) throw new FindingWorkError('invalid_action', 'Choose a future snooze date within 90 days.');
      base.status = 'snoozed'; base.snoozedUntil = action.until; event.until = action.until;
      break;
    case 'dismiss':
      base.status = 'dismissed'; delete base.snoozedUntil;
      if (action.reason) { base.reason = action.reason; event.reason = action.reason; } else delete base.reason;
      break;
    case 'linkGithub':
      if (action.url === null) delete base.githubUrl;
      else { base.githubUrl = action.url; event.githubUrl = action.url; }
      break;
    case 'linkChange': case 'deploy': {
      const changeId = action.type === 'linkChange' ? action.changeId : input.change?.id;
      if (changeId === null) { delete base.changeId; if (base.status === 'fixed') base.status = 'open'; break; }
      if (!input.change || input.change.id !== changeId || input.change.projectId !== input.projectId) throw new FindingWorkError('missing_change', 'That deployed change is no longer available on this site.');
      if (input.change.at > at || input.change.kind === 'measurement') throw new FindingWorkError('invalid_action', 'Choose a deployed page change. A future or measurement-only change cannot record a fix.');
      if (source.kind !== 'funnel-dropoff' && input.change.pageGroup !== undefined && input.change.pageGroup !== source.context.pageGroup) throw new FindingWorkError('invalid_action', 'That deployed change applies to a different page.');
      base.status = 'fixed'; base.changeId = changeId; event.changeId = changeId;
      delete base.snoozedUntil; delete base.reason;
      break;
    }
  }
  base.revision++; base.updatedAt = Math.max(base.updatedAt, at); event.status = base.status;
  base.history = [...base.history, event].slice(-MAX_FINDING_WORK_HISTORY);
  base.operations = [...base.operations, { id: request.operationId, hash: input.requestHash, revision: base.revision }].slice(-MAX_FINDING_WORK_HISTORY);
  return { record: findingWorkRecordSchema.parse(base), replayed: false };
}

export function publicFindingWork(record: FindingWorkRecord, now: number, changeAvailable: boolean, historyLimit = MAX_FINDING_WORK_HISTORY): FindingWorkView {
  const { operations, ...work } = record;
  void operations;
  return { ...work, history: work.history.slice(-historyLimit), historyCount: work.revision, historyTruncated: work.revision > Math.min(historyLimit, work.history.length), effectiveStatus: effectiveFindingStatus(work, now), changeAvailable };
}
