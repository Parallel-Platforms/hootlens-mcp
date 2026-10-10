/*
 * Billing contract: plans, subscription state, usage and the pure rules that turn them into
 * limits. The plan table is the single place prices and limits live; the API, the dashboard and
 * the Stripe setup script all read it.
 */
import { z } from 'zod';

export const planIdSchema = z.enum(['free', 'starter', 'growth', 'pro']);
export type PlanId = z.infer<typeof planIdSchema>;
export const paidPlanIdSchema = z.enum(['starter', 'growth', 'pro']);
export type PaidPlanId = z.infer<typeof paidPlanIdSchema>;
export const billingIntervalSchema = z.enum(['month', 'year']);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export interface Plan {
  id: PlanId;
  name: string;
  /** Price per month in US cents when billed monthly. */
  monthlyCents: number;
  /** Price per year in US cents: ten months, so two months free. */
  annualCents: number;
  /** Recorded sessions per UTC calendar month, shared by all of an account's sites. */
  sessionsPerMonth: number;
  /** Sites (projects) per account. null means unlimited. */
  sites: number | null;
  /** Longest retention a site may use, in days. */
  retentionDays: number;
  /** AI explanations generated per UTC calendar month, shared by all of an account's sites. Saved results do not count. */
  aiExplanationsPerMonth: number;
}

const plan = (id: PlanId, name: string, monthlyDollars: number, sessionsPerMonth: number, sites: number | null, retentionDays: number, aiExplanationsPerMonth: number): Plan =>
  ({ id, name, monthlyCents: monthlyDollars * 100, annualCents: monthlyDollars * 1000, sessionsPerMonth, sites, retentionDays, aiExplanationsPerMonth });

export const PLANS: readonly Plan[] = [
  plan('free', 'Free', 0, 1_000, 1, 7, 10),
  plan('starter', 'Starter', 39, 10_000, 3, 30, 100),
  plan('growth', 'Growth', 99, 50_000, 10, 90, 500),
  plan('pro', 'Pro', 499, 200_000, null, 90, 2_000),
];
export const TRIAL_DAYS = 14;
/**
 * Billing intervals customers can choose and the setup script creates prices for. Annual prices exist in the
 * plan table but are not offered until the owner confirms them.
 */
export const OFFERED_INTERVALS: readonly BillingInterval[] = ['month'];
/** How long a past due subscription keeps recording before capture pauses. */
export const PAST_DUE_GRACE_DAYS = 7;
/** Capture warnings start at this share of the monthly cap. */
export const USAGE_WARNING_SHARE = 0.8;
/** Recording continues this share past the monthly allowance before it pauses (Starter pauses after 11,000 sessions). */
export const USAGE_GRACE_SHARE = 0.1;
const DAY_MS = 86_400_000;

export const planById = (id: PlanId): Plan => PLANS.find(candidate => candidate.id === id) ?? PLANS[0];
/** The price lookup key used for a paid plan and interval in Stripe. */
export const priceLookupKey = (id: PaidPlanId, interval: BillingInterval): string => `hootlens_${id}_${interval}`;
export function parsePriceLookupKey(key: string | null | undefined): { plan: PaidPlanId; interval: BillingInterval } | undefined {
  const match = /^hootlens_(starter|growth|pro)_(month|year)$/.exec(key ?? '');
  return match ? { plan: match[1] as PaidPlanId, interval: match[2] as BillingInterval } : undefined;
}

export const subscriptionStatusSchema = z.enum(['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** The subscription state kept from Stripe events. */
export interface SubscriptionState {
  id: string;
  status: SubscriptionStatus;
  plan: PaidPlanId;
  interval: BillingInterval;
  trialEnd?: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  /** When payment first failed in the current run of failures. Cleared once paid. */
  pastDueSince?: number;
  /** Stripe event time (seconds) of the newest event applied, so older events are ignored. */
  eventAt: number;
}

/** One account's billing record. Absent subscription means the Free plan. */
export interface BillingRecord {
  ownerId: string;
  customerId?: string;
  subscription?: SubscriptionState;
  /** Set once a subscription has existed, so a returning customer gets no second trial. */
  trialUsed: boolean;
  /** Complimentary plan granted by an operator (scripts/billing-comp.ts). Never writable through an API route. */
  compPlan?: CompPlan;
  updatedAt: number;
}

export interface CompPlan {
  plan: PlanId;
  /** Epoch ms after which the grant no longer applies. Absent means it does not expire. */
  until?: number;
}

/** What any member of a project may learn about capture. It carries no plan, payment or usage detail. */
export interface ProjectCaptureStatus {
  capture: CaptureStatus;
  reason?: PauseReason;
}

export type CaptureStatus = 'on' | 'paused';
export type PauseReason = 'usage_cap' | 'payment_overdue';

export interface EffectivePlan {
  plan: Plan;
  /** The subscription state that applies, if any. */
  subscription?: SubscriptionState;
  /** Payment has been failing for longer than the grace period. */
  paymentOverdue: boolean;
  /** When the past due grace period ends or ended. */
  graceEndsAt?: number;
  /** The plan comes from a complimentary grant. Such accounts are never paused. */
  complimentary?: boolean;
  compUntil?: number;
}

/** Free applies without a subscription. Trialing counts as the chosen plan. past_due keeps it for the grace period. */
export const compActive = (comp: CompPlan | undefined, now: number): comp is CompPlan => comp !== undefined && (comp.until === undefined || comp.until > now);
const rank = (id: PlanId): number => PLANS.findIndex(candidate => candidate.id === id);

/** The larger of an active complimentary plan, the subscription's plan and Free. A winning comp is never paused. */
export function effectivePlan(record: BillingRecord | undefined, now: number): EffectivePlan {
  const paid = subscriptionPlan(record, now);
  const comp = record?.compPlan;
  if (compActive(comp, now) && rank(comp.plan) >= rank(paid.plan.id)) {
    return { plan: planById(comp.plan), paymentOverdue: false, complimentary: true, ...(comp.until === undefined ? {} : { compUntil: comp.until }) };
  }
  return paid;
}

function subscriptionPlan(record: BillingRecord | undefined, now: number): EffectivePlan {
  const subscription = record?.subscription;
  if (!subscription) return { plan: planById('free'), paymentOverdue: false };
  switch (subscription.status) {
    case 'trialing':
    case 'active':
      return { plan: planById(subscription.plan), subscription, paymentOverdue: false };
    case 'past_due': {
      const graceEndsAt = (subscription.pastDueSince ?? record?.updatedAt ?? now) + PAST_DUE_GRACE_DAYS * DAY_MS;
      return { plan: planById(subscription.plan), subscription, paymentOverdue: now >= graceEndsAt, graceEndsAt };
    }
    case 'unpaid':
      return { plan: planById(subscription.plan), subscription, paymentOverdue: true };
    default:
      return { plan: planById('free'), paymentOverdue: false };
  }
}

/** Sessions at which recording pauses: the allowance plus the grace share. */
export const sessionPauseAt = (plan: Pick<Plan, 'sessionsPerMonth'>): number => plan.sessionsPerMonth + Math.floor(plan.sessionsPerMonth * USAGE_GRACE_SHARE);
/** Sessions that may still be recorded this month past the allowance, or 0 when the account is within it or recording has paused. */
export const graceSessionsLeft = (plan: Pick<Plan, 'sessionsPerMonth'>, sessions: number): number =>
  sessions >= plan.sessionsPerMonth ? Math.max(0, sessionPauseAt(plan) - sessions) : 0;

export function captureState(effective: EffectivePlan, sessions: number): { capture: CaptureStatus; reason?: PauseReason } {
  if (effective.complimentary) return { capture: 'on' };
  if (effective.paymentOverdue) return { capture: 'paused', reason: 'payment_overdue' };
  if (sessions >= sessionPauseAt(effective.plan)) return { capture: 'paused', reason: 'usage_cap' };
  return { capture: 'on' };
}

/** The usage emails: 80% of the allowance, the allowance itself (recording continues through the grace), and the pause. */
export type UsageThreshold = 'warning' | 'limit' | 'paused';
export const USAGE_THRESHOLDS: readonly UsageThreshold[] = ['warning', 'limit', 'paused'];
/** Sessions at which each threshold is reached. */
export const usageThresholdSessions = (plan: Pick<Plan, 'sessionsPerMonth'>): Record<UsageThreshold, number> =>
  ({ warning: Math.ceil(plan.sessionsPerMonth * USAGE_WARNING_SHARE), limit: plan.sessionsPerMonth, paused: sessionPauseAt(plan) });
/** The highest threshold a session count has reached, if any. */
export function reachedThreshold(plan: Pick<Plan, 'sessionsPerMonth'>, sessions: number): UsageThreshold | undefined {
  const at = usageThresholdSessions(plan);
  return [...USAGE_THRESHOLDS].reverse().find(threshold => sessions >= at[threshold]);
}

/** `YYYY-MM` of a time in UTC, the usage period. */
export const usageMonth = (time: number): string => new Date(time).toISOString().slice(0, 7);
/** Start of the next UTC month, when the session count resets. */
export function nextUsageReset(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** The 402 message when a month's AI explanations are used up. Dates are UTC, like the allowance itself. */
export function aiAllowanceMessage(planName: string, resetsAt: number): string {
  const reset = new Date(resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `This month's AI explanation allowance for the ${planName} plan is used; it resets on ${reset}. Upgrade for more.`;
}
/** The API error code that goes with that message, so clients can show the state instead of a failure. */
export const AI_ALLOWANCE_CODE = 'ai_allowance';

export interface BillingSummary {
  /** False when the server has no Stripe keys: checkout is unavailable. */
  configured: boolean;
  /** HOOTLENS_BILLING_ENABLED is on and Stripe keys exist. The dashboard shows billing only when this is true. */
  enabled: boolean;
  /** False until HOOTLENS_BILLING_ENFORCED=true: limits are shown but nothing is limited or paused. */
  enforced: boolean;
  /** The plan is a complimentary grant, not a subscription. */
  complimentary: boolean;
  /** The complimentary grant has no end date. */
  compLifetime?: boolean;
  compUntil?: number;
  plan: PlanId;
  planName: string;
  /** free, or the Stripe status of the subscription. */
  status: 'free' | SubscriptionStatus;
  interval?: BillingInterval;
  trialEnd?: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  /** Payment is failing; recording continues until graceEndsAt. */
  pastDue: boolean;
  graceEndsAt?: number;
  /** A first-time subscriber gets a trial on checkout. */
  trialAvailable: boolean;
  hasCustomer: boolean;
  usage: {
    month: string;
    sessions: number;
    sessionLimit: number;
    /** Recording pauses at this many sessions: the allowance plus 10%. */
    sessionPauseAt: number;
    /** Sessions that may still be recorded past the allowance before recording pauses. 0 while within the allowance. */
    graceSessionsLeft: number;
    resetsAt: number;
    sites: number;
    siteLimit: number | null;
    retentionDays: number;
  };
  capture: CaptureStatus;
  pauseReason?: PauseReason;
  /** AI explanations generated this UTC month against the plan's allowance. Saved results are not counted. */
  ai: { used: number; limit: number };
}
