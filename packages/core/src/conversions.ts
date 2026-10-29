import { z } from 'zod';

import { BUSINESS_EVENT_NAME_PATTERN, BUSINESS_EVENT_ID_PATTERN, MAX_BUSINESS_EVENTS_PER_BATCH, MAX_CONVERSION_AMOUNT_MINOR, SUPPORTED_CONVERSION_CURRENCIES } from './business-event-limits';
export * from './business-event-limits';
export const MAX_CONVERSION_ROWS = 50;
export const CONVERSION_DIMENSIONS = ['channel', 'referrer', 'utmSource', 'utmCampaign', 'device', 'entryPage', 'release'] as const;
export type ConversionDimension = typeof CONVERSION_DIMENSIONS[number];
export const conversionDimensionSchema = z.enum(CONVERSION_DIMENSIONS);
export const businessEventSchema = z.object({
  id: z.string().regex(BUSINESS_EVENT_ID_PATTERN),
  name: z.string().regex(BUSINESS_EVENT_NAME_PATTERN),
  at: z.number().int().positive(),
  amountMinor: z.number().int().min(0).max(MAX_CONVERSION_AMOUNT_MINOR).optional(),
  currency: z.enum(SUPPORTED_CONVERSION_CURRENCIES).optional(),
}).strict().refine(event => (event.amountMinor === undefined) === (event.currency === undefined), 'Amount and currency must be supplied together');
export type BusinessEvent = z.infer<typeof businessEventSchema>;
export const businessEventsSchema = z.array(businessEventSchema).max(MAX_BUSINESS_EVENTS_PER_BATCH);
export const serverConversionInputSchema = z.object({ recordingId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), event: businessEventSchema }).strict();
export type ServerConversionInput = z.infer<typeof serverConversionInputSchema>;
export type ConversionProvenance = 'browser_reported' | 'server_reported';
export interface ConversionMoney { currency: string; amountMinor: number | null }
export interface ConversionMetrics {
  visits: number; conversions: number; occurrences: number;
  browserReported: number; serverReported: number;
  revenue: ConversionMoney[];
}
export interface ConversionReportRow extends ConversionMetrics { key: string; label: string; rate: number | null }
export interface ConversionReport {
  from: number; to: number; goalId: string; goalName: string; dimension: ConversionDimension;
  since: number | null;
  coverage: { status: 'complete' | 'partial' | 'unavailable'; note: string };
  totals: ConversionMetrics; rows: ConversionReportRow[]; omittedRows: number;
  windowBasis: 'visit_started';
}
export interface ConversionReceiptResult { recorded: boolean; duplicate: boolean; counted: boolean; matchedGoalIds: string[] }
