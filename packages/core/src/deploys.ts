/*
 * Deploy hooks: a project's signed webhook endpoints that turn a finished production deploy into a change marker,
 * so "Did it help?" has a before and after without anyone calling log_change. This module is pure and shared by
 * the API and the dashboard. The signing secret is never part of a summary.
 */
import { z } from 'zod';
import { CHANGE_TITLE_MAX, DEPLOY_SOURCE_PREFIX } from './changes';

export const DEPLOY_PROVIDERS = ['netlify', 'vercel', 'generic'] as const;
export const deployProviderSchema = z.enum(DEPLOY_PROVIDERS);
export type DeployProvider = z.infer<typeof deployProviderSchema>;
export const DEPLOY_PROVIDER_LABELS: Record<DeployProvider, string> = { netlify: 'Netlify', vercel: 'Vercel', generic: 'Any CI (signed JSON)' };

/** Active hooks per project. */
export const MAX_DEPLOY_HOOKS = 10;
/** Hook records kept per project, revoked ones included. Revoked hooks older than 30 days are dropped when a hook is created. */
export const MAX_DEPLOY_HOOK_RECORDS = 50;
export const DEPLOY_HOOK_LABEL_MAX = 60;
export const DEPLOY_SECRET_PREFIX = 'hl_dhk_';
/** Longest signing secret a person may paste for a provider that makes its own (Vercel). */
export const DEPLOY_SECRET_MAX = 256;
export const DEPLOY_SECRET_MIN = 16;

export const DELIVERY_STATUSES = ['recorded', 'duplicate', 'ignored', 'limit'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  recorded: 'Change logged',
  duplicate: 'Already logged',
  ignored: 'Ignored (not a production deploy)',
  limit: 'Not logged: change limit reached',
};

/** What is stored for a hook. `secret` is sealed with a server key; it is absent until a Vercel hook is given its secret, and after revocation. */
export interface DeployHookRecord {
  id: string;
  projectId: string;
  provider: DeployProvider;
  label?: string;
  createdBy: string;
  createdAt: number;
  secret?: string;
  /** Only production deploys log a change. Otherwise every deploy does. */
  productionOnly: boolean;
  /** Page group id every change from this hook names. Absent means the whole site. */
  pageGroup?: string;
  /** The last request with a valid signature. */
  lastDeliveryAt?: number;
  lastDeliveryStatus?: DeliveryStatus;
  lastDeliveryTitle?: string;
  /** The last request whose signature did not match, so a wrong secret is visible while setting up. */
  lastRejectedAt?: number;
  revokedAt?: number;
}

/** What the dashboard receives. */
export interface DeployHookSummary {
  id: string;
  provider: DeployProvider;
  label?: string;
  createdAt: number;
  productionOnly: boolean;
  pageGroup?: string;
  /** False for a Vercel hook whose signing secret has not been saved yet: it rejects every request until then. */
  hasSecret: boolean;
  lastDeliveryAt?: number;
  lastDeliveryStatus?: DeliveryStatus;
  lastDeliveryTitle?: string;
  lastRejectedAt?: number;
  /** Path of the delivery URL. The dashboard prefixes the API origin. */
  path: string;
}
export const deployHookPath = (id: string): string => `/v1/hooks/deploy/${id}`;

export const deployHookSummary = (hook: DeployHookRecord): DeployHookSummary => ({
  id: hook.id, provider: hook.provider, createdAt: hook.createdAt, productionOnly: hook.productionOnly,
  hasSecret: hook.secret !== undefined, path: deployHookPath(hook.id),
  ...(hook.label !== undefined ? { label: hook.label } : {}),
  ...(hook.pageGroup !== undefined ? { pageGroup: hook.pageGroup } : {}),
  ...(hook.lastDeliveryAt !== undefined ? { lastDeliveryAt: hook.lastDeliveryAt } : {}),
  ...(hook.lastDeliveryStatus !== undefined ? { lastDeliveryStatus: hook.lastDeliveryStatus } : {}),
  ...(hook.lastDeliveryTitle !== undefined ? { lastDeliveryTitle: hook.lastDeliveryTitle } : {}),
  ...(hook.lastRejectedAt !== undefined ? { lastRejectedAt: hook.lastRejectedAt } : {}),
});

/** A hook as the API returns it: the summary plus the full delivery URL on the API origin the request used. */
export interface DeployHookView extends DeployHookSummary { url: string }
/** GET /v1/projects/:projectId/deploy-hooks. `available` is false when the server has no key to seal secrets with, so no hook can be created yet. */
export interface DeployHookList { hooks: DeployHookView[]; available: boolean }

/** POST /v1/projects/:projectId/deploy-hooks */
export const deployHookInputSchema = z.object({
  provider: deployProviderSchema,
  label: z.string().trim().min(1).max(DEPLOY_HOOK_LABEL_MAX).optional(),
  productionOnly: z.boolean().default(true),
  /** A page group id or name from Settings. Absent means the whole site. */
  pageGroup: z.string().trim().min(1).max(300).optional(),
});
export type DeployHookInput = z.infer<typeof deployHookInputSchema>;

/** PATCH /v1/projects/:projectId/deploy-hooks/:hookId. `pageGroup: null` returns the hook to the whole site. */
export const deployHookUpdateSchema = z.object({
  label: z.string().trim().min(1).max(DEPLOY_HOOK_LABEL_MAX).nullable().optional(),
  productionOnly: z.boolean().optional(),
  pageGroup: z.string().trim().min(1).max(300).nullable().optional(),
}).refine(value => Object.keys(value).length > 0, 'Nothing to change');

/** POST /v1/projects/:projectId/deploy-hooks/:hookId/secret. A Vercel hook needs the secret Vercel showed; the others get a new one made here. */
export const deployHookSecretSchema = z.object({ secret: z.string().min(DEPLOY_SECRET_MIN).max(DEPLOY_SECRET_MAX).regex(/^[\x21-\x7e]+$/, 'Secret has unexpected characters').optional() });

/** The answer to creating a hook or changing its secret. `secret` is shown once and is absent for a Vercel hook. */
export interface DeployHookCreated { hook: DeployHookView; secret?: string }

/** The only generic hook body. Extra fields are ignored. Times are epoch milliseconds or ISO 8601 text. */
export const genericDeploySchema = z.object({
  /** Your deploy or run id. Repeating it never logs a second change. */
  id: z.string().trim().min(1).max(200),
  /** `production` (the default when absent) or anything else, such as `staging`. */
  environment: z.string().trim().min(1).max(60).optional(),
  /** `success` (the default when absent) or `succeeded`. Anything else is ignored. */
  status: z.string().trim().min(1).max(40).optional(),
  /** The change title, usually the commit message. Only its first line is kept. */
  title: z.string().max(2000).optional(),
  sha: z.string().trim().min(4).max(64).regex(/^[0-9a-fA-F]+$/).optional(),
  commitUrl: z.string().trim().max(500).optional(),
  release: z.string().trim().min(1).max(100).optional(),
  at: z.union([z.number().int().positive(), z.string().max(40)]).optional(),
});
export type GenericDeploy = z.infer<typeof genericDeploySchema>;

/** The marker `source` for a provider. */
export const deploySource = (provider: DeployProvider | 'github-action'): string => `${DEPLOY_SOURCE_PREFIX}${provider}`;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/**
 * A change title from a commit message: the first non-empty line, control characters removed, any email address
 * replaced, whitespace collapsed and the length capped. Returns undefined when nothing is left.
 */
export function deployTitle(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const first = message.split(/\r?\n/).map(line => line.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()).find(line => line.length > 0);
  if (!first) return undefined;
  const clean = first.replace(EMAIL, '[email removed]');
  return clean.length > CHANGE_TITLE_MAX ? `${clean.slice(0, CHANGE_TITLE_MAX - 1).trimEnd()}…` : clean;
}

/** A commit link worth storing: https, no credentials, no fragment, a sensible length. Anything else is dropped. */
export function deployCommitUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch { return undefined; }
}

/** Seven characters of a commit sha, for display. */
export const shortSha = (sha: string): string => sha.slice(0, 7);
