import { z } from 'zod';
import { PLATFORM_ORDER } from './install-guides';

export const SETUP_RETENTION_DAYS = 90;
export const SETUP_EVENTS = ['website_form_shown', 'website_submitted', 'website_added', 'website_failed', 'installation_opened', 'platform_selected', 'method_selected', 'handoff_copied', 'consent_instructions_viewed', 'verification_failed', 'evidence_opened'] as const;
export const setupEventSchema = z.enum(SETUP_EVENTS);
const time = z.number().finite().nonnegative();
const origin = z.string().max(300).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === value && (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); } catch { return false; }
}, 'Use an exact website origin without a path, query, or credentials.');
export const setupObservationSchema = z.object({
  event: setupEventSchema,
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(), origin: origin.optional(),
  platform: z.enum(PLATFORM_ORDER).optional(), method: z.enum(['self', 'coding_agent', 'developer']).optional(),
  consentSource: z.enum(['hootlens', 'onetrust', 'cookiebot', 'gcm', 'custom']).optional(),
  consentCategory: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/).optional(),
  variant: z.enum(['app', 'pages']).optional(),
  issue: z.enum(['create_failed', 'check_failed', 'handoff_failed']).optional(),
}).strict();
export type SetupObservation = z.infer<typeof setupObservationSchema>;
export const accountSetupSchema = z.object({
  version: z.literal(1), userId: z.string().min(1).max(200), startedAt: time, updatedAt: time, expiresAt: time,
  origin: origin.optional(), projectId: setupObservationSchema.shape.projectId,
  platform: setupObservationSchema.shape.platform, method: setupObservationSchema.shape.method,
  consentSource: setupObservationSchema.shape.consentSource, consentCategory: setupObservationSchema.shape.consentCategory,
  variant: setupObservationSchema.shape.variant,
  milestones: z.partialRecord(setupEventSchema, time),
  lastIssue: z.object({ code: z.enum(['create_failed', 'check_failed', 'handoff_failed']), at: time }).optional(),
});
export type AccountSetup = z.infer<typeof accountSetupSchema>;

/** Client observations describe setup actions, never proof of installation or recorded data. */
export function nextAccountSetup(previous: AccountSetup | undefined, userId: string, observation: SetupObservation, at: number): AccountSetup {
  const input = setupObservationSchema.parse(observation);
  const current = previous && previous.expiresAt > at ? previous : undefined;
  if (current && current.userId !== userId) throw new Error('Setup owner differs');
  const changedSite = Boolean((input.projectId && current?.projectId && input.projectId !== current.projectId) || (input.origin && current?.origin && input.origin !== current.origin));
  if (current && at < current.updatedAt) {
    if (changedSite) return current;
    return accountSetupSchema.parse({ ...current, startedAt: Math.min(current.startedAt, at), milestones: { ...current.milestones, [input.event]: Math.min(current.milestones[input.event] ?? at, at) } });
  }
  const base = changedSite ? undefined : current;
  const updatedAt = Math.max(at, base?.updatedAt ?? at);
  const next = accountSetupSchema.parse({
    ...base, version: 1, userId, startedAt: base?.startedAt ?? at, updatedAt, expiresAt: updatedAt + SETUP_RETENTION_DAYS * 86_400_000,
    ...(input.origin ? { origin: input.origin } : {}), ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.platform ? { platform: input.platform } : {}), ...(input.method ? { method: input.method } : {}),
    ...(input.variant ? { variant: input.variant } : input.platform && input.platform !== base?.platform ? { variant: undefined } : {}),
    ...(input.consentSource ? { consentSource: input.consentSource, consentCategory: input.consentCategory } : input.consentCategory ? { consentCategory: input.consentCategory } : {}),
    milestones: { ...base?.milestones, [input.event]: Math.min(base?.milestones[input.event] ?? at, at) },
    ...(input.issue ? { lastIssue: { code: input.issue, at } } : input.event === 'website_added' || input.event === 'evidence_opened' ? { lastIssue: undefined } : {}),
  });
  for (const key of ['lastIssue', 'consentCategory', 'variant'] as const) if (next[key] === undefined) delete next[key];
  return next;
}
