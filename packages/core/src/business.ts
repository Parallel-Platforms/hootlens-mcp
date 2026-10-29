import { z } from 'zod';
import { signupEntrySchema } from './signup-entry';
import { SIGNUP_CHANNELS, SIGNUP_ASSISTANTS } from './signup-source';

const count = z.number().int().nonnegative();
export const businessCoverageSchema = z.object({ status: z.enum(['complete', 'partial', 'unavailable']), read: count, limit: count, note: z.string() });
const conversion = z.object({ channel: z.string(), registered: count, ownedSite: count, acceptedData: count, paidActive: count, investigated: count.optional() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const businessInvestigationReportSchema = z.object({
  investigatingAccounts: count, investigationDays: count, firstObservedAccounts: count,
  eligibleReturnAccounts: count, returnedAccounts: count, startedAt: z.number().finite().nonnegative().nullable(),
  historyFrom: z.number().finite().nonnegative(), retentionDays: z.literal(90),
  daily: z.array(z.object({ day, accounts: count })).max(30),
  sources: z.array(z.object({ channel: z.string(), accounts: count })).max(2000),
  clientAttribution: z.literal('unknown'),
});
export const businessReportSchema = z.object({
  generatedAt: z.number(), window: z.object({ from: z.number(), to: z.number(), days: z.literal(30) }),
  accounts: z.object({ registered: count, excluded: count, disabled: count, siteOwners: count }),
  plans: z.object({ free: count, paidActive: count, trial: count, complimentary: count, pastDue: count, other: count, unknown: count }),
  sites: z.object({ total: count, acceptedData: count, activeInWindow: count }),
  acquisition: z.object({ cohort: count, rows: z.array(conversion), attribution: z.literal('optional_self_reported'), note: z.string() }),
  activity: z.object({ activeAccounts: count, agentApiAccounts: count, accountDays: count, agentApiDays: count, observedFrom: z.number().nullable(), note: z.string() }),
  investigations: businessInvestigationReportSchema.optional(),
  coverage: z.object({ accounts: businessCoverageSchema, projects: businessCoverageSchema, billing: businessCoverageSchema, attribution: businessCoverageSchema, origins: businessCoverageSchema.optional(), activity: businessCoverageSchema, investigations: businessCoverageSchema.optional() }),
  limitations: z.array(z.string()),
});
export type BusinessReport = z.infer<typeof businessReportSchema>;
export type BusinessCoverage = z.infer<typeof businessCoverageSchema>;
export const businessResponseSchema = z.object({ status: z.enum(['ready', 'building', 'error']), report: businessReportSchema.nullable(), error: z.string().nullable() });
export type BusinessResponse = z.infer<typeof businessResponseSchema>;

const timestamp = z.number().finite().nonnegative().nullable();
export const businessPlanStatusSchema = z.enum(['free', 'paidActive', 'trial', 'complimentary', 'pastDue', 'other', 'unknown']);
export const businessAccountInsightSchema = z.object({
  id: z.string(), email: z.string().nullable(), displayName: z.string().nullable(), emailVerified: z.boolean(), disabled: z.boolean(),
  population: z.enum(['customer', 'internal', 'disabled', 'anonymous']), excludedReason: z.string().nullable(),
  createdAt: timestamp, lastSignInAt: timestamp, planStatus: businessPlanStatusSchema, acquisitionChannel: z.string().nullable(),
  planName: z.string().nullable().optional(), signupEntry: signupEntrySchema.nullable().optional(),
  signupSource: z.object({ channel: z.enum(SIGNUP_CHANNELS), assistant: z.enum(SIGNUP_ASSISTANTS).optional() }).nullable().optional(),
  signInMethods: z.array(z.string().max(80)).max(10).optional(),
  sites: z.array(z.object({ id: z.string(), name: z.string(), hostnames: z.array(z.string()), createdAt: timestamp, lastConfigFetchAt: timestamp, lastCollectAt: timestamp })).max(2000),
  activity: z.object({ accountDays: count, agentApiDays: count, firstObservedAt: timestamp, lastObservedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
  investigations: z.object({ days: count, firstRetainedAt: timestamp, lastObservedDay: day.nullable() }).optional(),
  stage: z.enum(['registered', 'site_created', 'tracker_seen', 'data_accepted', 'evidence_read', 'unknown']),
});
export type BusinessAccountInsight = z.infer<typeof businessAccountInsightSchema>;
export const businessAccountDirectorySchema = z.object({
  generatedAt: z.number().finite().nonnegative(), window: businessReportSchema.shape.window,
  accounts: z.array(businessAccountInsightSchema).max(2000), coverage: businessReportSchema.shape.coverage, limitations: z.array(z.string()),
});
export type BusinessAccountDirectory = z.infer<typeof businessAccountDirectorySchema>;
export const businessAccountsResponseSchema = z.object({ status: z.enum(['ready', 'building', 'error']), directory: businessAccountDirectorySchema.nullable(), error: z.string().nullable() });
export type BusinessAccountsResponse = z.infer<typeof businessAccountsResponseSchema>;
