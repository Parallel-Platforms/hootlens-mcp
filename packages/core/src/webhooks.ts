/*
 * Webhooks: a site's signed endpoints that receive Hoot Lens events, so an automation (a coding agent routine, a GitHub
 * Action, a chat bot) can react on its own. This module is pure and shared by the API and the dashboard. The signing
 * secret is never part of a summary, and an event carries ids, counts, names the dashboard already shows and links,
 * never recorded page content, visitor details or event streams.
 *
 * New events are added to WEBHOOK_EVENT_TYPES and WEBHOOK_EVENT_LABELS only; endpoints subscribe by type, so an event
 * added later reaches nobody until they choose it. Payloads are versioned by `version`; a field is only ever added.
 */
import { z } from 'zod';
import type { SnagKind } from './digest';

/** Events an endpoint can subscribe to, in the order the dashboard lists them. `test.ping` is sent only by "Send test event". */
export const WEBHOOK_SUBSCRIBABLE_EVENTS = ['snag.spike', 'finding.new', 'change.verdict'] as const;
export const WEBHOOK_EVENT_TYPES = [...WEBHOOK_SUBSCRIBABLE_EVENTS, 'test.ping'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export type WebhookSubscribableEvent = (typeof WEBHOOK_SUBSCRIBABLE_EVENTS)[number];
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export const webhookSubscribableSchema = z.enum(WEBHOOK_SUBSCRIBABLE_EVENTS);

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, { label: string; description: string }> = {
  'snag.spike': { label: 'Snag spike', description: 'An element had far more pile-ups, no-shows or misfires than usual in the last 24 hours.' },
  'finding.new': { label: 'New finding', description: 'An element with repeated snags newly appears as a top finding for a page group.' },
  'change.verdict': { label: 'Did it help? result', description: 'A logged change has enough visits for its before and after comparison, or the result changed.' },
  'test.ping': { label: 'Test event', description: 'Sent by Send test event to check the address and the signature.' },
};

/** The payload schema version. A breaking change would add a new number and keep sending the old one to existing endpoints. */
export const WEBHOOK_PAYLOAD_VERSION = 1;
/** Active and disabled endpoints per site. */
export const MAX_WEBHOOK_ENDPOINTS = 5;
export const WEBHOOK_LABEL_MAX = 60;
export const WEBHOOK_URL_MAX = 2000;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Attempts kept on a delivery for the log, and deliveries listed per endpoint. */
export const WEBHOOK_ATTEMPTS_KEPT = 10;
export const WEBHOOK_DELIVERIES_LISTED = 25;
/** Each attempt gives up after this long. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Delay before attempt n+1 after attempt n fails: 7 attempts in all, the last about 20 hours after the first. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
/** A delivery is abandoned after this long, whatever the attempts left. */
export const WEBHOOK_MAX_AGE_MS = 24 * 3_600_000;
/** An endpoint with this many failed attempts in a row, the first at least WEBHOOK_DISABLE_AFTER_MS ago, is switched off. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 10;
export const WEBHOOK_DISABLE_AFTER_MS = 2 * 24 * 3_600_000;
/** Delivery records are deleted this long after they were made. */
export const WEBHOOK_LOG_KEEP_MS = 30 * 24 * 3_600_000;
/** Longest piece of a response kept in the delivery log. */
export const WEBHOOK_SNIPPET_MAX = 200;

export type WebhookDisabledReason = 'manual' | 'failures';
export type WebhookAttemptError = 'timeout' | 'dns' | 'connect' | 'blocked' | 'tls' | 'status' | 'secret' | 'unavailable';

export interface WebhookAttempt {
  at: number;
  /** The HTTP status the endpoint answered with, when it answered. */
  status?: number;
  latencyMs: number;
  /** Why there was no 2xx answer: what went wrong, never the address resolved. */
  error?: WebhookAttemptError;
  /** The start of the response body (a few characters, control characters removed), for a non-2xx answer only. */
  snippet?: string;
}

/** What is stored for an endpoint. `secret` is sealed with a server key (the same box as deploy hooks). */
export interface WebhookEndpointRecord {
  id: string;
  projectId: string;
  url: string;
  label?: string;
  events: WebhookSubscribableEvent[];
  secret: string;
  createdBy: string;
  createdAt: number;
  secretRotatedAt?: number;
  enabled: boolean;
  disabledAt?: number;
  disabledReason?: WebhookDisabledReason;
  /** Failed attempts in a row, and when the first of them happened. Reset by a 2xx answer or by enabling the endpoint. */
  consecutiveFailures: number;
  failingSince?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastStatus?: number;
}

export interface WebhookEndpointSummary {
  id: string;
  url: string;
  label?: string;
  events: WebhookSubscribableEvent[];
  createdAt: number;
  secretRotatedAt?: number;
  enabled: boolean;
  disabledAt?: number;
  disabledReason?: WebhookDisabledReason;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastStatus?: number;
}

export const webhookEndpointSummary = (endpoint: WebhookEndpointRecord): WebhookEndpointSummary => ({
  id: endpoint.id, url: endpoint.url, events: endpoint.events, createdAt: endpoint.createdAt, enabled: endpoint.enabled, consecutiveFailures: endpoint.consecutiveFailures,
  ...(endpoint.label !== undefined ? { label: endpoint.label } : {}),
  ...(endpoint.secretRotatedAt !== undefined ? { secretRotatedAt: endpoint.secretRotatedAt } : {}),
  ...(endpoint.disabledAt !== undefined ? { disabledAt: endpoint.disabledAt } : {}),
  ...(endpoint.disabledReason !== undefined ? { disabledReason: endpoint.disabledReason } : {}),
  ...(endpoint.lastSuccessAt !== undefined ? { lastSuccessAt: endpoint.lastSuccessAt } : {}),
  ...(endpoint.lastFailureAt !== undefined ? { lastFailureAt: endpoint.lastFailureAt } : {}),
  ...(endpoint.lastStatus !== undefined ? { lastStatus: endpoint.lastStatus } : {}),
});

/** GET /v1/projects/:projectId/webhooks. `available` is false when the server has no key to seal secrets with. */
export interface WebhookEndpointList { endpoints: WebhookEndpointSummary[]; available: boolean; limit: number }
/** The answer to creating an endpoint or rotating its secret. `secret` is shown once. */
export interface WebhookEndpointCreated { endpoint: WebhookEndpointSummary; secret?: string }

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'cancelled'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** One event for one endpoint, as stored in the outbox. `body` is the exact JSON text that is signed and sent, so every retry carries the same bytes. */
export interface WebhookDeliveryRecord {
  id: string;
  projectId: string;
  endpointId: string;
  eventId: string;
  type: WebhookEventType;
  body: string;
  createdAt: number;
  status: WebhookDeliveryStatus;
  /** All attempts made, though only the latest WEBHOOK_ATTEMPTS_KEPT are in `attempts`. */
  attemptCount: number;
  attempts: WebhookAttempt[];
  /** While pending: when the next attempt is due. */
  nextAttemptAt?: number;
  /** While an instance is attempting it: nobody else starts before this. */
  leaseUntil?: number;
  deliveredAt?: number;
  /** When the record is deleted. */
  expiresAt: number;
}

export interface WebhookDeliverySummary {
  id: string;
  eventId: string;
  type: WebhookEventType;
  createdAt: number;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  attempts: WebhookAttempt[];
  nextAttemptAt?: number;
  deliveredAt?: number;
}
export const webhookDeliverySummary = (delivery: WebhookDeliveryRecord): WebhookDeliverySummary => ({
  id: delivery.id, eventId: delivery.eventId, type: delivery.type, createdAt: delivery.createdAt, status: delivery.status, attemptCount: delivery.attemptCount, attempts: delivery.attempts,
  ...(delivery.nextAttemptAt !== undefined && delivery.status === 'pending' ? { nextAttemptAt: delivery.nextAttemptAt } : {}),
  ...(delivery.deliveredAt !== undefined ? { deliveredAt: delivery.deliveredAt } : {}),
});
export interface WebhookDeliveryList { deliveries: WebhookDeliverySummary[] }
/** POST .../test. The attempt is made at once, so the answer carries its result. */
export interface WebhookTestResult { delivery: WebhookDeliverySummary; ok: boolean }

/** Milliseconds to wait before the attempt that follows `failedAttempts` failures, or undefined when the delivery is out of attempts. */
export const webhookRetryDelay = (failedAttempts: number): number | undefined => WEBHOOK_RETRY_DELAYS_MS[failedAttempts - 1];

/* ------------------------------------------------------------------ requests */

const labelSchema = z.string().trim().min(1).max(WEBHOOK_LABEL_MAX);
const eventsSchema = z.array(webhookSubscribableSchema).min(1, 'Choose at least one event').max(WEBHOOK_SUBSCRIBABLE_EVENTS.length)
  .transform(events => WEBHOOK_SUBSCRIBABLE_EVENTS.filter(type => events.includes(type)));
/** The first checks of an endpoint address. The API then resolves the host and refuses private addresses, which no schema can do. */
export const webhookUrlSchema = z.string().trim().min(1).max(WEBHOOK_URL_MAX).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, 'Use an https address without a username, password or # fragment');

/** POST /v1/projects/:projectId/webhooks */
export const webhookInputSchema = z.object({ url: webhookUrlSchema, label: labelSchema.optional(), events: eventsSchema });
export type WebhookInput = z.infer<typeof webhookInputSchema>;

/** PATCH /v1/projects/:projectId/webhooks/:endpointId. `label: null` clears the name; `enabled: true` after an automatic stop resets the failure count. */
export const webhookUpdateSchema = z.object({
  url: webhookUrlSchema.optional(),
  label: labelSchema.nullable().optional(),
  events: eventsSchema.optional(),
  enabled: z.boolean().optional(),
}).refine(value => Object.keys(value).length > 0, 'Nothing to change');

/** POST .../secret has no fields. The empty object is accepted so a client can send JSON. */
export const webhookRotateSchema = z.object({}).strict();
/** POST .../test sends a test.ping. */
export const webhookTestSchema = z.object({ event: z.literal('test.ping').optional() }).strict();

/* ------------------------------------------------------------------ event payloads */

export interface WebhookLinks {
  /** The site's overview in the dashboard. */
  dashboard: string;
  /** The webhooks settings, where deliveries are listed. */
  settings?: string;
  /** A recording opened at the moment of a snag. */
  replays?: string[];
  heatmap?: string;
}

/** Ids a Hoot Lens MCP tool takes as arguments, so an agent can continue without parsing a URL. All are optional because they depend on the event. */
export interface WebhookMcpIds {
  projectId: string;
  /** `change_impact` and `list_changes`. */
  changeId?: string;
  /** `review_findings` and `explain_snags`: the heatmap cohort key. */
  cohortKey?: string;
  /** `explain_snags`: the element selector. */
  selector?: string;
  /** `get_recording` and `get_session_narrative`. */
  recordingIds?: string[];
  /** `change_impact` and findings: the page group id. */
  pageGroup?: string;
}

export interface SnagSpikeData {
  element: { id: string; name: string; selector: string };
  /** The kind that makes up most of the element's snags over the last two days, when one does. */
  leadKind?: SnagKind;
  /** Snags in the last 24 hours, the usual number for 24 hours, and the count that had to be exceeded. */
  snags: { last24h: number; usual: number; threshold: number };
  /** The change logged shortly before the spike began, when there is one. */
  change?: { id: string; title: string; at: number; release?: string };
  /** Visits in the same 24 hours. */
  visitsLast24h: number;
}
export interface FindingNewData {
  finding: {
    id: string;
    kind: SnagKind;
    pageGroup: { id: string; name: string };
    element: { name: string; selector: string };
    signals: { pileUps: number; noShows: number; misfires: number };
    clicks: number;
    visits: number;
    release: string;
  };
}
export interface ChangeVerdictData {
  change: { id: string; title: string; at: number; release?: string; pageGroup?: string };
  /** The wording the dashboard and the pull request comment show. */
  summary: string;
  pageGroup: { id: string; name: string; visitsBefore: number; visitsAfter: number };
}
export interface TestPingData { message: string }

export interface WebhookEventMap {
  'snag.spike': SnagSpikeData;
  'finding.new': FindingNewData;
  'change.verdict': ChangeVerdictData;
  'test.ping': TestPingData;
}

/** The JSON body of every delivery. */
export interface WebhookEvent<T extends WebhookEventType = WebhookEventType> {
  /** Stable for the event: a retry or a second delivery of it has the same id. Also sent as the webhook-id header. */
  id: string;
  type: T;
  version: typeof WEBHOOK_PAYLOAD_VERSION;
  /** ISO 8601, when Hoot Lens made the event. */
  createdAt: string;
  site: { id: string; name: string };
  data: WebhookEventMap[T];
  links: WebhookLinks;
  ids: WebhookMcpIds;
}
