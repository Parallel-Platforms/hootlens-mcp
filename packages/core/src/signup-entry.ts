import { z } from 'zod';
import { CLAIM_TOKEN_PATTERN } from './onboarding';
import { OAUTH_REQUEST_PREFIX } from './oauth';

export const SIGNUP_ENTRY_WINDOW_MS = 30 * 60_000;
export const SIGNUP_ENTRY_KINDS = ['website', 'app_authorization', 'agent_setup', 'invitation'] as const;
export const SIGNUP_AUTH_METHODS = ['password', 'google'] as const;

const publicHost = (value: string): string | undefined => {
  const host = value.toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !host.includes('.') || /^[\d.]+$/.test(host) || /[:/@?#%\\\s]/.test(host)) return undefined;
  if (/(?:^|\.)(?:localhost|local|internal|lan|test|invalid|example|onion)$/.test(host)) return undefined;
  const labels = host.split('.');
  if (labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) || labels.at(-1)!.length < 2 || /^\d+$/.test(labels.at(-1)!)) return undefined;
  return host;
};

/** Extracts a public hostname only. Credentials, private hosts, paths, queries, and fragments are never retained. */
export function sanitizeSignupReferrerHost(value: string): string | undefined {
  if (!value || value.length > 4096) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return publicHost(url.hostname);
  } catch { return undefined; }
}

/** A known public page family, without identifiers from invitation, authorization, or workspace URLs. */
export function safeSignupLandingPath(value: string): string | undefined {
  if (!value || value.length > 200 || /[?#%\\\s]/.test(value)) return undefined;
  const path = value.replace(/\/$/, '') || '/';
  if (['/', '/app', '/demo', '/faq', '/privacy', '/terms', '/learn', '/guides', '/compare'].includes(path)) return path === '/' || path === '/app' ? path : `${path}/`;
  return /^\/(?:learn|guides|compare)\/[a-z\d]+(?:-[a-z\d]+)*$/.test(path) ? `${path}/` : undefined;
}

const referrerHostSchema = z.string().max(253).refine(value => publicHost(value) === value, 'Use a normalized public hostname only');
const landingPathSchema = z.string().max(200).refine(value => safeSignupLandingPath(value) === value, 'Use a recognized public landing path only');
const oauthRequestIdSchema = z.string().regex(new RegExp(`^${OAUTH_REQUEST_PREFIX}[A-Za-z0-9_-]{43}$`));
export const signupEntryRequestSchema = z.object({
  entry: z.enum(SIGNUP_ENTRY_KINDS), authMethod: z.enum(SIGNUP_AUTH_METHODS),
  referrerHost: referrerHostSchema.optional(), landingPath: landingPathSchema.optional(),
  oauthRequestId: oauthRequestIdSchema.optional(), claimToken: z.string().regex(CLAIM_TOKEN_PATTERN).optional(),
  inviteToken: z.string().regex(/^hl_inv_[A-Za-z0-9_-]{43}$/).optional(),
}).strict().superRefine((value, ctx) => {
  for (const [field, entry] of [['oauthRequestId', 'app_authorization'], ['claimToken', 'agent_setup'], ['inviteToken', 'invitation']] as const) {
    if ((value[field] !== undefined) !== (value.entry === entry)) ctx.addIssue({ code: 'custom', path: [field], message: `Provide ${field} only for ${entry}` });
  }
});
export type SignupEntryRequest = z.infer<typeof signupEntryRequestSchema>;

export const signupEntrySchema = z.object({
  version: z.literal(1), recordedAt: z.number().finite().nonnegative(), accountCreatedAt: z.number().finite().nonnegative(),
  entry: z.enum(SIGNUP_ENTRY_KINDS), authMethod: z.enum(SIGNUP_AUTH_METHODS),
  referrerHost: referrerHostSchema.optional(), landingPath: landingPathSchema.optional(),
  app: z.object({ name: z.string().trim().min(1).max(120).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Use one line'), nameVerified: z.literal(false) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.recordedAt < value.accountCreatedAt || value.recordedAt - value.accountCreatedAt > SIGNUP_ENTRY_WINDOW_MS) ctx.addIssue({ code: 'custom', path: ['recordedAt'], message: 'Signup entry must be recorded shortly after account creation' });
  if (value.app && value.entry !== 'app_authorization' && value.entry !== 'agent_setup') ctx.addIssue({ code: 'custom', path: ['app'], message: 'App names apply only to an app or agent setup flow' });
});
export type SignupEntry = z.infer<typeof signupEntrySchema>;
