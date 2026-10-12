import { z } from 'zod';
import { aiSettingsSchema, type AiSettings } from './explanations.js';
import { elementContextSchema, type ElementContext, type TopSnag } from './element-context';
import { SOURCE_LOCATION_MAX_LENGTH, parseSourceLocation } from './source-location';
export * from './explanations.js';
import { TARGETING_MAX_RULES, targetingRuleError } from './targeting';
import { type PathPreset } from './path-privacy';
import { pathPresetsSchema } from './path-preset-schema';
import { GROUP_ID_PATTERN, LOCALE_PREFIX_PATTERN, MAX_GROUPS, MAX_GROUP_RULES, MAX_VARIANT_VALUE, PARAM_NAME_PATTERN, type GroupingOptions, type PageGroup } from './page-groups';
import { MAX_GOALS, trackerGoalSchema, type Goal, type GoalStat } from './changes';
import { PREVIEW_ORIGIN_LIMIT } from './preview-origins';
import type { Funnel } from './funnels';
import type { SavedSegment } from './saved-segments';
import type { ElementDisplayName } from './element-display-names';
import type { AutomationReason, AutomationVerdict } from './automation';
import { INTERNAL_IP_RULE_LIMIT, isExitDestination, normalizeIpRules, EXIT_MAX_LENGTH, type InternalTraffic } from './internal-traffic';

export * from './automation';
export * from './internal-traffic';
export * from './automation-agents';
export * from './changes';
export * from './deploys';
export * from './webhooks';
export * from './version-labels';
export * from './element-context';
export * from './impact';
export * from './funnels';
export * from './page-suggestions';
export * from './starter-funnels';
export * from './saved-segments';
export * from './element-name';
export * from './element-display-names';
export * from './notifications';
export * from './digest';
export * from './replay-seek';
export * from './trends';
export * from './sources';
export * from './errors';
import { recordedErrorsSchema, type LinkedError, type RecordingError } from './errors';

export * from './targeting';
export * from './path-privacy';
export * from './path-preset-schema';
import { AD_NETWORKS, CHANNELS, IN_APPS, type AdNetwork, type Channel, type InApp } from './sources';
import { DEFAULT_CONSENT_REGIONS, MAX_CONSENT_REGIONS, normalizeConsentRegions } from './consent-regions';

export * from './consent-regions';
export * from './page-groups';
export * from './signup-source';
export * from './business';

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

/*
 * Privacy policy, configured per project by the customer and enforced in both the
 * tracker and the collector.
 *
 * - full: real text, images (by URL, never inlined), SVG, all CSS, custom elements and
 *   shadow DOM. Form input values are masked.
 * - balanced: like full, with emails, phone numbers, card numbers and long digit runs
 *   redacted from text before transmission.
 * - strict: all text masked, media and custom element trees blocked (the original
 *   pilot policy).
 *
 * Every preset keeps a fixed floor that customers cannot turn off: password, payment
 * and one-time-code fields are never recorded, `[data-hoot-private]` regions are
 * blocked, and other input values are masked unless a selector in
 * `unmaskInputSelectors` explicitly allows that input.
 */
export const privacyPresetSchema = z.enum(['full', 'balanced', 'strict']);
const selectorSchema = z.string().trim().min(1).max(200).refine(s => !/[{}<>]/.test(s), 'Invalid selector');
export const privacyPolicySchema = z.object({
  preset: privacyPresetSchema,
  /** Elements whose text is masked even when the preset shows text. */
  maskTextSelectors: z.array(selectorSchema).max(50).default([]),
  /** Elements replaced by an empty placeholder of the same size. */
  blockSelectors: z.array(selectorSchema).max(50).default([]),
  /** Inputs whose values may be recorded. Never applies to password, payment or one-time-code fields. */
  unmaskInputSelectors: z.array(selectorSchema).max(20).default([]),
  /** Keep URL query strings in recorded paths. Fragments are always dropped. */
  captureQueryStrings: z.boolean().default(false),
  /**
   * Keep digits in campaign parameter values (`utm_*`). Balanced and strict redact long digit runs everywhere, which
   * turns numeric ad-platform ids ({campaignid}, {adgroupid}) into `*`. These are marketing labels, so an owner can keep
   * them. Email addresses in campaign values are still redacted, and nothing else changes. Absent means off.
   */
  keepCampaignDigits: z.boolean().optional(),
});
export type PrivacyPreset = z.infer<typeof privacyPresetSchema>;
export type PrivacyPolicy = z.infer<typeof privacyPolicySchema>;
export const defaultPrivacyPolicy = (preset: PrivacyPreset = 'full'): PrivacyPolicy =>
  ({preset, maskTextSelectors: [], blockSelectors: [], unmaskInputSelectors: [], captureQueryStrings: false});
/** Autocomplete tokens and input types that are never recorded under any policy. */
export const NEVER_RECORD_INPUT_TYPES = ['password'] as const;
/** Matches one autocomplete token. Use `neverRecordAutocomplete` for a whole attribute value. */
export const NEVER_RECORD_AUTOCOMPLETE = /^(?:cc-|current-password|new-password|one-time-code)/;
/** True when any whitespace-separated autocomplete token names a payment, password or one-time-code field. */
export const neverRecordAutocomplete = (value: string): boolean =>
  value.toLowerCase().split(/\s+/).some(token => NEVER_RECORD_AUTOCOMPLETE.test(token));
/**
 * DOM attributes that hold URLs. Fragments are always stripped. Query strings are stripped from
 * navigational attributes unless `captureQueryStrings` is on, and kept on resource attributes
 * (images, media, objects, CSS `url()`) in full and balanced so replay can load them.
 */
/** Navigational URLs (links, form targets): fragments always stripped, query strings unless `captureQueryStrings`. */
export const DOM_NAVIGATION_ATTRIBUTES = ['href', 'action', 'formaction', 'xlink:href', 'cite', 'longdesc', 'ping', 'manifest', 'codebase'] as const;
export const DOM_RESOURCE_ATTRIBUTES = ['src', 'srcset', 'imagesrcset', 'poster', 'data', 'background', 'icon', 'lowsrc', 'dynsrc'] as const;
export const DOM_URL_ATTRIBUTES = [...DOM_NAVIGATION_ATTRIBUTES, ...DOM_RESOURCE_ATTRIBUTES] as const;
/** Selector that is always blocked, whatever the policy. */
export const ALWAYS_PRIVATE_SELECTOR = '[data-hoot-private]';

/*
 * Visitor consent, configured per project.
 * - implied: record unless the site calls setConsent(false). Global Privacy Control and
 *   Do Not Track still disable capture.
 * - required: record only after the site calls setConsent(true).
 * - regional: behave as required for visitors in `consentRegions`, and as implied for everyone else.
 *   The API resolves this per request, so the tracker only ever sees implied or required.
 */
export const consentModeSchema = z.enum(['implied', 'required', 'regional']);
export type ConsentMode = z.infer<typeof consentModeSchema>;
/** What a visitor's tracker is held to once any region has been resolved. */
export const effectiveConsentSchema = z.enum(['implied', 'required']);
export type EffectiveConsent = z.infer<typeof effectiveConsentSchema>;
/** Why a visitor got their mode: their region, an unknown region (asked first), or the project's fixed setting. */
export const consentReasonSchema = z.enum(['region', 'region-unknown', 'project']);
export type ConsentReason = z.infer<typeof consentReasonSchema>;
export const consentRegionsSchema = z.array(z.string().trim().max(8)).max(MAX_CONSENT_REGIONS)
  .transform((codes, ctx) => {
    const normalized = normalizeConsentRegions(codes);
    if (!normalized) ctx.issues.push({code: 'custom', message: 'Use country codes such as DE, subdivisions such as US-WA, or EEA, EU, UK and CH', input: codes});
    return normalized ?? [];
  });

/**
 * Page targeting, configured per project. Absent means every path is recorded. See
 * `evaluatePageTargeting` for the glob semantics shared by the tracker, collector and dashboard.
 */
const targetingRuleSchema = z.string().superRefine((rule, ctx) => {
  const message = targetingRuleError(rule);
  if (message) ctx.addIssue({code: 'custom', message});
});
export const pageTargetingSchema = z.object({
  include: z.array(targetingRuleSchema).max(TARGETING_MAX_RULES).default([]),
  exclude: z.array(targetingRuleSchema).max(TARGETING_MAX_RULES).default([]),
});

/** A query parameter name that carries an experiment variant. */
const variantParamSchema = z.string().trim().regex(PARAM_NAME_PATTERN);
/**
 * Page groups, configured per project. `match` rules use the targeting glob syntax and are tested against
 * the recorded path and its locale-free form, so `/` also matches `/es`. The first matching group wins;
 * pages in no group form an automatic group named by their normalized path.
 */
export const pageGroupSchema = z.object({
  id: z.string().regex(GROUP_ID_PATTERN),
  name: z.string().trim().min(1).max(60),
  match: z.array(targetingRuleSchema).min(1).max(MAX_GROUP_RULES),
});
export const pageGroupsSchema = z.array(pageGroupSchema).max(MAX_GROUPS)
  .refine(groups => new Set(groups.map(group => group.id)).size === groups.length, 'Group ids must be unique');
/** Overrides for grouping. Absent fields use DEFAULT_LOCALE_PREFIXES and DEFAULT_VARIANT_PARAMS. */
export const groupingOptionsSchema = z.object({
  localePrefixes: z.array(z.string().trim().toLowerCase().regex(LOCALE_PREFIX_PATTERN)).max(300).optional(),
  variantParams: z.array(variantParamSchema).max(20).optional(),
  /** `content` (the default) starts a new page version when the page's own content changes; `release` follows the site release. */
  pageVersionMode: z.enum(['release', 'content']).optional(),
});

/** The owner's internal traffic rules: whether the internal link counts, and the listed addresses (validated and normalized). */
export const internalTrafficSchema = z.object({
  browser: z.boolean(),
  ips: z.array(z.string().trim().max(60)).max(INTERNAL_IP_RULE_LIMIT).default([]),
}).transform((value, ctx): InternalTraffic => {
  const normalized = normalizeIpRules(value.ips);
  if (!normalized.ok) {
    ctx.issues.push({ code: 'custom', message: normalized.error, input: value.ips, path: ['ips'] });
    return { browser: value.browser, ips: [] };
  }
  return { browser: value.browser, ips: normalized.rules };
});

/** Tracker configuration served publicly by GET /v1/projects/:projectId/config. */
export const trackerConfigSchema = z.object({
  projectId: idSchema,
  privacy: privacyPolicySchema,
  /** The mode in force for this visitor: a regional project is resolved by the API. */
  consent: effectiveConsentSchema,
  consentReason: consentReasonSchema.optional(),
  /** Fraction of new sessions to record, 0 to 1. */
  sampleRate: z.number().min(0).max(1).default(1),
  /** 'paused' tells the tracker not to start new sessions (plan cap reached). Absent means on. */
  capture: z.enum(['on', 'paused']).optional(),
  /** Page paths to record. Absent records every path. */
  targeting: pageTargetingSchema.optional(),
  /** Per-path presets: stricter privacy on matching pages. Absent means none. */
  pathPresets: pathPresetsSchema.optional(),
  /** Extra query parameters that name an experiment variant, beyond the built-in list. */
  variantParams: z.array(variantParamSchema).max(20).optional(),
  /** Selector goals the tracker tests clicks against in the page. Only ids leave the browser, never the page. */
  goals: z.array(trackerGoalSchema).max(MAX_GOALS).optional(),
  /** True when the site records JavaScript errors. Absent means off (projects created before error recording). */
  errors: z.boolean().optional(),
});
export type TrackerConfig = z.infer<typeof trackerConfigSchema>;

export const deviceClassSchema = z.enum(['desktop', 'tablet', 'mobile']);
export type DeviceClass = z.infer<typeof deviceClassSchema>;
/** Heatmaps bucket visitors by device class rather than exact pixel viewport size. */
export function deviceClass(viewportWidth: number): DeviceClass {
  if (viewportWidth < 768) return 'mobile';
  if (viewportWidth < 1024) return 'tablet';
  return 'desktop';
}

/** Longest element label, in characters. */
export const LABEL_MAX_LENGTH = 60;
export const clickKindSchema = z.enum(['click', 'rage-click', 'dead-click', 'error-click']);
export const clickSchema = z.object({
  /** Viewport-relative position, 0 to 1. Kept for replay overlays. */
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  timestamp: z.number().int().positive(), target: z.string().max(120),
  kind: clickKindSchema,
  actionType: z.enum(['toggle','submit','link','button','other']).optional(),
  response: z.enum(['changed','unchanged','unknown']).optional(),
  /** Set when the tracker recorded the press because the site paused capture before the click event: the click is inferred from pointerdown. */
  inferred: z.literal('pointerdown').optional(),
  nodeId: z.number().int().positive().optional(),
  offsetX: z.number().min(0).max(1).optional(),
  offsetY: z.number().min(0).max(1).optional(),
  /** Document position in CSS pixels, including scroll. Required for full-page heatmaps. */
  pageX: z.number().min(0).max(100000).optional(),
  pageY: z.number().min(0).max(1000000).optional(),
  /** Document size in CSS pixels when the click happened. */
  docWidth: z.number().min(1).max(100000).optional(),
  docHeight: z.number().min(1).max(1000000).optional(),
  /** Stable CSS selector of the clicked element, for element-level click counts. */
  selector: z.string().max(300).optional(),
  /**
   * Short readable name of the clicked element, such as "Buy now". Computed in the browser from
   * its accessible name or visible text under the project's privacy policy: omitted in strict,
   * redacted in balanced, never read from private, masked, blocked or form regions.
   */
  label: z.string().max(LABEL_MAX_LENGTH).optional(),
  /**
   * Where the clicked element is written in the site's source, as `path:line`, read from the nearest `data-hoot-src` a
   * Hoot Lens build plugin stamped. Developer-authored like `data-hoot-id`; a value that is not a repository-relative
   * `path:line` is dropped by the tracker and rejected here.
   */
  source: z.string().max(SOURCE_LOCATION_MAX_LENGTH).refine(value => parseSourceLocation(value) !== undefined, 'Invalid source location').optional(),
  /** Ids of the project's selector goals this click matched in the page. The collector ignores ids that are not the project's goals. */
  goals: z.array(idSchema).max(10).optional(),
  /**
   * Short context of the clicked element (tag, region, and under full and balanced the nearest heading and its own text),
   * computed in the browser under the project's privacy policy. See element-context.ts.
   */
  context: elementContextSchema.optional(),
  /** False when the clicked target is not a link, button or other control. Omitted when the tracker did not say; older trackers never send it. */
  interactive: z.boolean().optional(),
});
export const scrollSchema = z.object({
  /** Deepest bottom edge of the viewport reached, in document CSS pixels. */
  maxDepth: z.number().min(0).max(1000000),
  docHeight: z.number().min(1).max(1000000),
});
/** Longest campaign parameter value, in characters. */
export const UTM_MAX_LENGTH = 100;
const utmValue = z.string().trim().min(1).max(UTM_MAX_LENGTH);
/** Campaign parameters from the session's landing URL. */
export const utmSchema = z.object({
  source: utmValue.optional(), medium: utmValue.optional(), campaign: utmValue.optional(),
  term: utmValue.optional(), content: utmValue.optional(),
  /** utm_id, utm_source_platform, utm_creative_format and utm_marketing_tactic: the GA4 extension parameters. */
  id: utmValue.optional(), sourcePlatform: utmValue.optional(), creativeFormat: utmValue.optional(), marketingTactic: utmValue.optional(),
});
export type Utm = z.infer<typeof utmSchema>;
/** The ad network whose click ID parameter was on the landing URL. The ID itself is never sent. See sources.ts. */
export const adNetworkSchema = z.enum(AD_NETWORKS);
/** The app whose in-app browser showed the page, from the user agent. The user agent itself is never sent. */
export const inAppSchema = z.enum(IN_APPS);
export const channelSchema = z.enum(CHANNELS);
export const browserSchema = z.enum(['chrome', 'safari', 'firefox', 'edge', 'other']);
export const osSchema = z.enum(['windows', 'macos', 'ios', 'android', 'linux', 'other']);
export type BrowserName = z.infer<typeof browserSchema>;
export type OsName = z.infer<typeof osSchema>;
export const segmentSchema = z.object({
  id: idSchema, sessionId: idSchema, projectId: idSchema,
  path: z.string().startsWith('/').max(300).refine(v => !v.includes('#')),
  revision: z.string().min(1).max(150), buildId: z.string().max(100),
  variant: z.string().max(100), viewport: z.object({ width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000) }),
  startedAt: z.number().int().positive(),
  /** Defaults from viewport width when absent (older trackers). */
  deviceClass: deviceClassSchema.optional(),
  /** Position of this page view within the session, starting at 0. */
  pageIndex: z.number().int().min(0).max(10000).optional(),
  /** Referrer origin only, never a full URL. */
  referrer: z.string().max(200).optional(),
  /** Campaign parameters of the session's landing page, repeated on every segment of the session. */
  utm: utmSchema.optional(),
  /** Coarse browser family and operating system. The raw user agent is never sent. */
  browser: browserSchema.optional(), os: osSchema.optional(),
  /** Name of the ad network whose click ID parameter was on the landing URL, repeated on every segment of the session. The ID is never sent. */
  adNetwork: adNetworkSchema.optional(),
  /** Name of the app whose in-app browser showed the page. */
  inApp: inAppSchema.optional(),
  /** True when this browser had not recorded a session for this site before. Omitted in strict. */
  isNewVisitor: z.boolean().optional(),
  /** Primary language tag of `<html lang>`, such as `es`. */
  locale: z.string().regex(/^[a-z]{2,3}$/).optional(),
  /**
   * True when the visitor's browser had translated the page (Chrome Translate and the like) at its first snapshot.
   * Then `locale` is the language they read, `pageFingerprint` is absent, and the visit stays in the page version
   * its source language already has. See tracker translation.ts.
   */
  translated: z.literal(true).optional(),
  /** The page's own language, such as `en`, when it was read before the translation. Only with `translated`. */
  sourceLocale: z.string().regex(/^[a-z]{2,3}$/).optional(),
  /**
   * The experiment parameter of the page URL, sent only when the recorded path has no query string.
   * The collector applies the privacy preset again: strict keeps allow-listed names with hashed values.
   */
  experimentParam: z.object({
    name: z.string().regex(PARAM_NAME_PATTERN), value: z.string().min(1).max(MAX_VARIANT_VALUE),
  }).optional(),
  /**
   * Hash of the page's visible structure at its first snapshot (tags, markers and the order of headings,
   * buttons and links; text under the full and balanced presets, never strict). 8 to 16 hex digits. The collector derives the page
   * version from it. It carries no page content.
   */
  pageFingerprint: z.string().regex(/^[0-9a-f]{8,16}$/).optional(),
});
/**
 * Pointer movement grid. Cells are page coordinates divided by `MOVE_CELL_SIZE`; the weight is how many
 * sampled pointer positions (about one every 100 ms) fell in the cell. It carries no element, text or
 * identity, only where the pointer was, so every privacy preset may send it. Touch devices do not.
 */
export const MOVE_CELL_SIZE = 40;
/** Cells per batch. */
export const MAX_MOVE_CELLS = 400;
/** Plotted area: 5,000 px wide and 50,000 px tall. Cells outside it are rejected, not clipped. */
export const MAX_MOVE_COLUMNS = 125;
export const MAX_MOVE_ROWS = 1250;
/** Most weight one cell can carry in a batch (about 100 seconds of rest). */
export const MAX_MOVE_WEIGHT = 1000;
export const movesSchema = z.object({
  cellSize: z.literal(MOVE_CELL_SIZE),
  cells: z.array(z.tuple([
    z.number().int().min(0).max(MAX_MOVE_COLUMNS - 1),
    z.number().int().min(0).max(MAX_MOVE_ROWS - 1),
    z.number().int().min(1).max(MAX_MOVE_WEIGHT),
  ])).max(MAX_MOVE_CELLS),
}).refine(moves => new Set(moves.cells.map(([column, row]) => `${column}_${row}`)).size === moves.cells.length, 'Duplicate movement cells');
export type Moves = z.infer<typeof movesSchema>;
/** Batches arrive uncompressed up to this size, or gzip-compressed with Content-Encoding: gzip. */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const MAX_COMPRESSED_BATCH_BYTES = 1024 * 1024;
export const batchSchema = z.object({
  segment: segmentSchema, sequence: z.number().int().min(0).max(100000),
  // rrweb event types 0 to 6. Type 5 (custom) is reserved for Hoot Lens events.
  events: z.array(z.object({ type: z.number().int().min(0).max(6), timestamp: z.number().int().positive(), data: z.unknown() })).max(500),
  clicks: z.array(clickSchema).max(500), endedAt: z.number().int().positive(),
  scroll: scrollSchema.optional(),
  /** Pointer dwell since the previous batch. Optional, desktop pointers only. */
  moves: movesSchema.optional(),
  /** True for the final batch sent while the page unloads. */
  final: z.boolean().optional(),
  /** Bitmask of automation signals the tracker observed in this page load, see AUTOMATION_BITS. Omitted when none. */
  auto: z.number().int().min(0).max(65535).optional(),
  /** True when this browser opened the site's internal link (see internal-traffic.ts). The collector honors it only if the site allows it. */
  internal: z.literal(true).optional(),
  /**
   * Where the visitor went when a click left the page, on the final batch: a same-site path with no query or fragment, or another
   * site's origin only. See isExitDestination. Never a full URL.
   */
  exit: z.string().max(EXIT_MAX_LENGTH).refine(isExitDestination, 'Invalid exit destination').optional(),
  /** JavaScript errors of this page view since the previous batch. Dropped by the collector unless the project records errors. */
  errors: recordedErrorsSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.endedAt < v.segment.startedAt) ctx.addIssue({code:'custom', message:'Invalid recording interval'});
  if (!v.events.length && !v.clicks.length && !v.scroll && !v.moves?.cells.length && !v.errors?.length) ctx.addIssue({code:'custom', message:'Empty batch'});
});
export type Click = z.infer<typeof clickSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type Batch = z.infer<typeof batchSchema>;
export type Scroll = z.infer<typeof scrollSchema>;
/** A segment as stored: `group` is assigned by the collector from the project's page groups. */
export interface GroupedSegment extends Segment {
  /**
   * Where the visitor was, from the request address at the visit's first batch. The address is never stored.
   * `country` is ISO 3166-1 alpha-2, `subdivision` ISO 3166-2 such as `US-WA` (balanced and full only). Absent when unknown.
   */
  country?: string; subdivision?: string;
  /** Default channel of the visit, derived by the collector for the visit's first page view. See classifyChannel. */
  channel?: Channel;
  group?: string;
  /**
   * The page version the collector derived for this page view: a release label, or in content mode the
   * release the page's current content was first seen under. Absent in release mode and on older recordings,
   * where the release (`buildId`) is the version.
   */
  pageVersion?: string;
}
export interface Recording extends GroupedSegment {
  endedAt: number; clicks: Click[]; eventCount: number; batchCount: number; scroll?: Scroll;
  /** Time on the page without idle time, and the idle time left out. See RecordingSummary.durationMs. */
  durationMs?: number; idleMs?: number;
  /** See RecordingSummary: strong automation signals fired for this page view. */
  automated?: true;
  automation?: AutomationVerdict;
  /** True when the site's team made this page view (internal link or listed address). Internal visits reach no aggregate and, by default, are left out of lists. */
  internal?: true;
  /** Ids of the goals this page view converted, under the goal definitions at the time. Absent when none. */
  goalIds?: string[];
  /** Where the page view's last link led when a click left the page: a same-site path, or another site's origin only. Absent when no click left it. */
  exitTo?: string;
}
/** Deliberate validation visits stay available without becoming customer findings. */
export function isControlledRecording(recording:Pick<Segment,'variant'>):boolean {
  return recording.variant==='controlled-validation' || recording.variant.startsWith('controlled-validation-');
}
export interface Project {
  id: string; name: string; origins: string[]; ownerId: string; createdAt: number; retentionDays: number;
  /** Absent on projects created before configurable privacy; treat as strict. */
  privacy?: PrivacyPolicy;
  /** Absent on projects created before configurable consent; treat as required. */
  consent?: ConsentMode;
  /** Regions asked first when `consent` is regional. Absent means the default list. */
  consentRegions?: string[];
  sampleRate?: number;
  /** Absent on projects created before AI explanations; treat as off. */
  ai?: AiSettings;
  /** Patterns for preview deploy hosts (preview-origins.ts). They may send test visits only. Absent means none. */
  previewOrigins?: string[];
  /** Page paths to record. Absent records every path. */
  targeting?: { include: string[]; exclude: string[] };
  /** Per-path privacy presets, such as safe-form for application forms. Only ever stricter than `privacy`. Absent means none. */
  pathPresets?: PathPreset[];
  /** Page groups in match order. Absent means every page is in its automatic group. */
  pageGroups?: PageGroup[];
  /** Locale prefix, experiment parameter and page version mode overrides. */
  grouping?: GroupingOptions;
  /** How the site's own team is told apart from visitors (see internal-traffic.ts). Absent means nobody is. Owner only. */
  internalTraffic?: InternalTraffic;
  /** What counts as a conversion. Absent means none are set. */
  goals?: Goal[];
  /** Ordered goal sequences. Absent means none are set. */
  funnels?: Funnel[];
  /** Named recording filters. Absent means none are saved. */
  savedSegments?: SavedSegment[];
  /** Names the team gave elements, by selector. Absent means none are set. Written by owners and editors. */
  elementNames?: ElementDisplayName[];
  /** When privacy, consent, sample rate or page targeting last changed. Absent if never changed after creation. */
  updatedAt?: number;
  /** Record JavaScript errors. Absent on projects created before error recording; treat as off until the owner turns it on. */
  errorCapture?: boolean;
}
export const projectPrivacy = (project: Pick<Project,'privacy'>): PrivacyPolicy => project.privacy ?? defaultPrivacyPolicy('strict');
/** Whether the site records JavaScript errors. Projects created before the setting existed stay off until the owner turns it on. */
export const projectErrorCapture = (project: Pick<Project,'errorCapture'>): boolean => project.errorCapture === true;
export const projectConsent = (project: Pick<Project,'consent'>): ConsentMode => project.consent ?? 'required';
export const projectConsentRegions = (project: Pick<Project,'consentRegions'>): string[] => project.consentRegions ?? [...DEFAULT_CONSENT_REGIONS];
export interface TokenRecord { id: string; projectId: string; ownerId: string; name: string; hash: string; scopes: TokenScope[]; createdAt: number; expiresAt: number; revokedAt?: number;
  /** Assistant the key was made for (a label only; it grants nothing). */
  client?: TokenClient;
  /** When the key last authorized a request. Written at most once an hour. */
  lastUsedAt?: number; }
/**
 * `annotate` lets a key log and remove change markers. It is separate from `read` and `replay` and grants neither.
 * `configure` lets a key preview and apply changes to the site's settings (page targeting, goals, funnels, stricter privacy).
 * It is effective only for owners (editors: goals and funnels) and can never weaken privacy.
 */
export const PROJECT_TOKEN_SCOPES = ['read', 'replay', 'annotate', 'configure'] as const;
export type ProjectTokenScope = (typeof PROJECT_TOKEN_SCOPES)[number];
/**
 * `triage` lets a key work the issues queue as staff. Only staff can put it on a key, it acts only while its creator is
 * still staff, and it grants no project permission at all: it is not one of PROJECT_TOKEN_SCOPES.
 */
export const TOKEN_SCOPES = [...PROJECT_TOKEN_SCOPES, 'triage'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const TOKEN_CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'vscode', 'other'] as const;
export type TokenClient = (typeof TOKEN_CLIENTS)[number];
export const TOKEN_EXPIRY_DAYS = [30, 60, 90] as const;
export type OwlState = 'curious' | 'friction' | 'quiet';
export function owlSignal(clicks: Click[]): { state: OwlState; label: string; evidence: string } {
  const friction = clicks.filter(c => c.kind !== 'click' && !(c.actionType==='toggle' && c.response==='changed')).length;
  if (friction) return {state:'friction', label:'Snags spotted', evidence:`Hoot spotted ${friction} ${friction === 1 ? 'snag' : 'snags'} (pile-ups, no-shows or misfires).`};
  if (clicks.length) return {state:'curious', label:'Exploring', evidence:`${clicks.length} observed clicks. This describes behavior, not emotion.`};
  return {state:'quiet', label:'No snags spotted', evidence:'No snags were captured in this selection.'};
}
/**
 * A visit ends after this long without the visitor doing anything (30 minutes, the usual analytics inactivity timeout).
 * The tracker starts a new visit when the visitor comes back after it, and the collector leaves the idle time out of a
 * visit's duration. Mirrored by SESSION_IDLE_MS in the tracker, which cannot import the main entry.
 */
export const VISIT_IDLE_MS = 30 * 60 * 1000;
export const segmentDeviceClass = (s: Pick<Segment,'deviceClass'|'viewport'>): DeviceClass => s.deviceClass ?? deviceClass(s.viewport.width);
/**
 * Heatmaps group by page group, release, page revision and device class. Locale and variant are
 * dimensions inside the cohort, not part of its key. Viewports are bucketed by device class so
 * visitors with slightly different window sizes aggregate together. Revision changes only with
 * explicit page versions or data-hoot-region markers, never with viewport size.
 *
 * A segment with no `group` (recorded before page groups) keeps its original key, which names one
 * path and one variant: a group of a single path.
 */
export function heatmapKey(s: GroupedSegment): string {
  if (s.group === undefined) return JSON.stringify([s.projectId,s.path,s.buildId,s.revision,s.variant,segmentDeviceClass(s)]);
  return JSON.stringify([s.projectId,s.group,s.pageVersion ?? s.buildId,s.revision,segmentDeviceClass(s)]);
}
export function aggregateHeatmap(recordings: Recording[], key: string) {
  const selected = recordings.filter(s => heatmapKey(s) === key);
  const clicks = selected.flatMap(s=>s.clicks);
  return { key, sessions: new Set(selected.map(s=>s.sessionId)).size, segments:selected.length, clicks, scrollDepths:scrollDepths(selected), signal:owlSignal(clicks) };
}
/** Share of segments whose viewport reached each 10% band of the page, index 0 = top. */
export function scrollDepths(recordings: Pick<Recording,'scroll'>[]): number[] {
  const measured = recordings.flatMap(r => r.scroll ? [Math.min(1, r.scroll.maxDepth / r.scroll.docHeight)] : []);
  return Array.from({length:10}, (_, band) => measured.length ? measured.filter(depth => depth >= band / 10).length / measured.length : 0);
}

/*
 * API response shapes shared by the API, dashboard and MCP service.
 */
/** One click on a recording's timeline: milliseconds from the start of the page view, and what kind of click. */
export interface ClickMark {
  t: number; k: Click['kind'];
  /** Where the click landed down the document, 0 (top) to 1 (bottom), to three places. Absent when the document height was not recorded and on marks kept before this field. */
  y?: number;
}
/** Marks kept per page view: up to this many snags and this many plain clicks. */
export const MAX_CLICK_MARKS = 40;
export interface RecordingSummary extends Segment {
  /**
   * Where the page view's clicks fell on its timeline, for the Recordings list. Bounded, in time order. Absent on
   * recordings made before marks were kept, and when a page view has no clicks.
   */
  marks?: ClickMark[];
  /** Page group id: a configured group, or the normalized path. Absent on recordings made before page groups. */
  group?: string;
  /** Where the visitor was and the visit's default channel; see GroupedSegment. Absent when unknown, and `channel` on all but a visit's first page view. */
  country?: string; subdivision?: string; channel?: Channel;
  /** The page version the collector derived (content mode). Absent in release mode, where `buildId` is the version. */
  pageVersion?: string;
  endedAt: number; eventCount: number; batchCount: number; scroll?: Scroll;
  /**
   * Time on the page, in milliseconds, without idle time: stretches of 30 minutes or more with no visitor activity (a tab
   * left open) are left out, and so is a trailing stretch that long. `endedAt - startedAt` is the elapsed time and can be
   * far longer. Absent on older recordings, where the elapsed time is all there is.
   */
  durationMs?: number;
  /** The idle time left out of `durationMs`. Absent when none was. */
  idleMs?: number;
  clickCount: number; rageClickCount: number; deadClickCount: number; errorClickCount: number;
  /** JavaScript errors recorded in the page view (distinct errors, at most 20). Absent when none. */
  errorCount?: number;
  /** Labels the team put on the recording, from the project's tag vocabulary. Absent when it has none. */
  tags?: string[];
  /** True when strong automation signals fired. Automated visits are left out of every aggregate and, by default, out of lists. */
  automated?: true;
  /** The signals behind `automated`, or behind a suspected visit (`automation.level` is `suspected` and `automated` is absent). */
  automation?: AutomationVerdict;
  /** True when the site's team made this page view (internal link or listed address). Internal visits reach no aggregate and, by default, are left out of lists. */
  internal?: true;
  /** Ids of the goals this page view converted, under the goal definitions at the time. Absent when none. */
  goalIds?: string[];
  /** Where the page view's last link led when a click left the page: a same-site path, or another site's origin only. Absent when no click left it. */
  exitTo?: string;
}
/**
 * GET /v1/projects/:projectId/recordings?cursor=&limit=&path=&deviceClass=&minDurationMs=&signal=rage|dead|error&controlled=exclude|include|only
 *   &automated=exclude|include|only&utmSource=&utmCampaign=&referrer=&browser=&os=&newVisitor=true|false&from=&to=&group=&locale=&variant=&tag=
 *   &country=&subdivision=&channel=&adNetwork=&inApp=&entryPage=&internal=exclude|include|only&goal=&element=
 * `controlled` defaults to exclude, so deliberate validation visits stay out of normal lists. `automated` defaults to
 * exclude, so automated visits stay out too; `include` lists both and `only` lists just the automated ones. `internal` works the
 * same way for the site team's own visits. `goal` is a goal id or name: only page views that converted it. `element` is a
 * `data-hoot-id`, an element key as findings and heatmaps list it, or a selector: only page views with a click on it.
 */
export interface RecordingPage { recordings: RecordingSummary[]; nextCursor?: string; }
/** One visit made of page views stitched by the tracker's shared sessionId. */
export interface SessionSummary {
  sessionId: string; startedAt: number; endedAt: number;
  /** Time on the site without idle time, the sum of the page views' `durationMs`. `endedAt - startedAt` is the elapsed time. Absent on older visits. */
  durationMs?: number;
  /** The idle time left out of `durationMs`. Absent when none was. */
  idleMs?: number;
  pageCount: number;
  /** Page paths in play order, one entry per page view (at most 50). */
  paths: string[];
  /** Page group id of each page view, parallel to `paths`. */
  groups?: string[];
  /** Distinct languages of the page views. */
  locales?: string[];
  /** Device class of the first page view. */
  device: DeviceClass;
  /** Browser family and operating system of the first page view, when the project's privacy policy stored them. No versions. */
  browser?: BrowserName; os?: OsName;
  /**
   * Where the visit came from, from its first page view: referrer origin, default channel, ad network (click ID name only),
   * in-app browser, country and subdivision (ISO codes), and the entry page (path without query). Each is absent when unknown.
   */
  referrer?: string; channel?: Channel; adNetwork?: AdNetwork; inApp?: InApp;
  country?: string; subdivision?: string; entryPage?: string;
  /** Deepest scroll reached in any page view, in percent of the document. Absent when none was measured. */
  maxScrollPercent?: number;
  /** Click marks of the page views on the session's timeline (milliseconds from `startedAt`), bounded. */
  marks?: ClickMark[];
  clickCount: number; rageClickCount: number; deadClickCount: number; errorClickCount: number;
  /** True when any page view of the visit is automated. */
  automated?: true;
  /** The distinct reasons behind the automated or suspected page views, strongest first. */
  automationReasons?: AutomationReason[];
  /** True when any page view of the visit is internal (made by the site's team). */
  internal?: true;
  /** The goals the visit converted, in goal order, under the goal definitions in force when each page view was recorded. Absent when none. */
  goals?: { goalId: string; name: string }[];
  /**
   * Where the visit went when it left through a link: a same-site path, or another site's origin only, never a query or
   * fragment. Set only when the last page view ended with a click on a link that left the page and no later page view followed.
   */
  exitTo?: string;
  /**
   * One or two sentences describing the visit, built from the fields above and the first page view's
   * browser and operating system. Counts are per click, so "pile-up clicks" are the rapid clicks
   * themselves. `GET /sessions/:sessionId/narrative` has the step-by-step account.
   */
  summary: string;
  /**
   * The element with the most snag clicks in this visit and which snag kind it had most, from the visit's own clicks. The
   * summary ends with it. Absent when the visit had none, and for visits recorded before this was kept.
   */
  topSnag?: TopSnag;
}
/**
 * GET /v1/projects/:projectId/sessions?cursor=&limit=&path=&group=&locale=&variant=&deviceClass=&minDurationMs=&signal=&controlled=
 * Accepts the recording filters, with limit up to 50. A session is listed when any of its page views matches
 * and is ordered by its newest matching page view. `controlled` defaults to exclude.
 */
export interface SessionPage { sessions: SessionSummary[]; nextCursor?: string; }
/** GET /v1/projects/:projectId/sessions/:sessionId, segments ordered by pageIndex, then startedAt. */
export interface SessionDetail { sessionId: string; segments: RecordingSummary[]; }
/** GET /v1/projects/:projectId/recordings/:id */
export interface RecordingDetail { recording: Recording; events: Batch['events'];
  /** JavaScript errors of the page view in time order, when the site records them and the page view had any. */
  errors?: RecordingError[]; }
/** Segments and clicks for one locale or variant inside a cohort. `(other)` folds in values beyond the first 20. */
export interface DimensionCount { key: string; segments: number; clicks: number; }
export const OTHER_DIMENSION = '(other)';
export const MAX_DIMENSION_KEYS = 20;
export interface HeatmapCohortSummary {
  key: string;
  /** Page group id: a configured group, or the normalized path. Absent on older servers; use `cohortGroup`. */
  group?: string;
  /** Normalized path of the first visit; for a cohort recorded before page groups, its path. */
  path: string;
  /** The cohort's release or, when `pageVersion` is set, its page version label: the third part of the key. */
  buildId: string;
  /** Set when the collector derived the page version from the page's content. Equal to `buildId`. */
  pageVersion?: string;
  revision: string;
  /** Empty for page group cohorts, where variants are a dimension. Set on cohorts recorded before page groups. */
  variant: string; deviceClass: DeviceClass;
  sessions: number; segments: number; clicks: number; lastSeenAt: number;
  /** Language and variant breakdowns inside the cohort, most page views first, at most 21 each. */
  locales?: DimensionCount[]; variants?: DimensionCount[];
}
/** The page group of a cohort. A cohort recorded before page groups is a group of its own path. */
export const cohortGroup = (cohort: Pick<HeatmapCohortSummary, 'group' | 'path'>): string => cohort.group ?? cohort.path;
/** GET /v1/projects/:projectId/heatmaps */
export interface HeatmapCohortList { cohorts: HeatmapCohortSummary[]; }
export interface SelectorClicks { selector: string; /** Most recent readable element label, when the project's policy allows one. */ label?: string; /** Source file and line (`src/Pricing.tsx:42`) from the most recent click on this element in this cohort, when the site's build plugin stamped it. */ source?: string; /** The name the team gave this element, when it has one. It wins over `label`. */ name?: string;
  /** Short context from the most recent click on this element in this cohort: tag, region and, under full and balanced, the nearest heading and its own text. */
  context?: ElementContext;
  /** False when the element is not a link, button or other control (a pile-up here is on something that is not interactive). Absent when it is, or when the tracker did not say. */
  interactive?: false;
  clicks: number; rageClicks: number; deadClicks: number; errorClicks: number;
  /** JavaScript errors that followed clicks on this element within two seconds, most often first. Present only when the site records errors and some did. */
  followedBy?: LinkedError[];
}
/** GET /v1/projects/:projectId/heatmaps/:key (key URL-encoded) */
export interface HeatmapAggregate extends HeatmapCohortSummary {
  /** Click density in document CSS pixels; each cell is [column, row, count]. */
  grid: { cellSize: number; cells: [number, number, number][] };
  /** Typical document size for the cohort, used to scale the overlay. */
  docWidth: number; docHeight: number;
  /** Pointer dwell in document CSS pixels; each cell is [column, row, weight]. Shows pointer position, not attention. */
  moves: { cellSize: number; cells: [number, number, number][] };
  /** Most-clicked elements, at most 200. */
  selectors: SelectorClicks[];
  /** Share of segments reaching each 10% band of the page; index 0 is the top. */
  scrollDepths: number[];
  /** Recording whose opening snapshot renders behind the overlay. */
  reference?: { recordingId: string; timestamp: number };
}
/** Cap on stored click samples per heatmap cohort, and the most one response returns. */
export const CLICK_SAMPLE_CAPACITY = 2000;
/** One sampled click with the visit context it was recorded under. Only fields that passed intake validation. */
export interface ClickSample {
  pageX: number; pageY: number; kind: Click['kind']; timestamp: number;
  label?: string; selector?: string;
  /** Referrer origin of the page view. */
  referrer?: string; utmSource?: string;
  /** Language and experiment variant of the page view. */
  locale?: string; variant?: string;
  deviceClass: DeviceClass; browser?: BrowserName; isNewVisitor?: boolean;
  /** Present only for callers with the replay scope. */
  recordingId?: string;
}
/**
 * GET /v1/projects/:projectId/heatmaps/:key/clicks?limit= (read scope; recordingId needs replay scope).
 * A uniform random sample of the cohort's clicks, at most CLICK_SAMPLE_CAPACITY. `total` counts every click
 * in the cohort, including any recorded before sampling began.
 */
export interface HeatmapClickSamples { key: string; total: number; capacity: number; clicks: ClickSample[]; }
export interface TrafficCount { key: string; sessions: number; }
/** A country (ISO 3166-1 alpha-2, or `unknown`) with its largest subdivisions (ISO 3166-2) for the top countries. */
export interface CountryTrafficCount extends TrafficCount { regions?: TrafficCount[]; }
export interface TrafficDay {
  day: string; sessions: number;
  /** Automated visits that began this day and were left out of `sessions`. Omitted on page group traffic. */
  automated?: number;
}
/**
 * GET /v1/projects/:projectId/traffic?from=&to=&group= (epoch ms, UTC day granularity, at most 92 days, default the last 30).
 * Sessions are counted once, on their first accepted batch, excluding controlled-validation and automated visits.
 */
export interface TrafficSummary {
  from: number; to: number; sessions: number;
  /** Visits classified automated, left out of every count here. Site-wide traffic only. */
  automatedSessions?: number;
  /** One entry per UTC day from the day of `from` to the day of `to`, oldest first, zeros included. */
  daily: TrafficDay[];
  /**
   * Conversions per goal, counted over the days since each goal began. Site-wide, or for the page group when one is
   * named. They are not split by referrer, device or browser, because conversions are counted per day only.
   */
  goals: GoalStat[];
  /** Referrer origins; `(direct)` is a session without an external referrer. At most 25 per list. */
  referrers: TrafficCount[]; utmSources: TrafficCount[]; utmCampaigns: TrafficCount[];
  deviceClasses: TrafficCount[]; browsers: TrafficCount[]; operatingSystems: TrafficCount[];
  visitors: { new: number; returning: number; unknown: number };
  /**
   * Where visits come from (see sources.ts). `countries` are ISO 3166-1 codes or `unknown`; the five largest carry `regions`
   * (ISO 3166-2 codes, balanced and full projects only). `channels` are channel ids, `adNetworks` and `inApps` the closed
   * names, `entryPages` the first page's path. At most 25 per list; a list is empty for days counted before it existed.
   */
  countries: CountryTrafficCount[]; channels: TrafficCount[]; adNetworks: TrafficCount[]; inApps: TrafficCount[]; entryPages: TrafficCount[];
  /**
   * Visits in the range that carry no value for a source, so each list plus its gap adds up to `sessions`: days before
   * channels, countries and entry pages were counted, and visits that did not begin on their first page view. Site-wide
   * traffic only. A visit with a country that could not be resolved is counted under `unknown`, not here.
   */
  notRecorded?: { countries: number; channels: number; entryPages: number };
  /** The first UTC day channels, countries and entry pages are counted (`YYYY-MM-DD`), set when the range starts before it and has visits that lack them. */
  sourcesCountedFrom?: string;
  /**
   * Set when the request named a page group (`?group=`). Then `sessions` counts sessions that viewed the group
   * (a session that viewed two groups is in both), `deviceClasses`, `languages` and `variants` come from the page
   * stats, and the referrer, campaign, browser, operating system, visitor and source lists are empty because those are
   * counted per visit, not per page group.
   */
  group?: { id: string; name: string };
  languages?: TrafficCount[]; variants?: TrafficCount[];
}
/** PATCH /v1/projects/:projectId, responding with {project: Project}. */
export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  origins: z.array(z.string().url()).min(1).max(20).optional(),
  /** Owner only. An empty list removes them. See preview-origins.ts for the accepted patterns. */
  previewOrigins: z.array(z.string().max(300)).max(PREVIEW_ORIGIN_LIMIT).optional(),
  privacy: privacyPolicySchema.optional(),
  consent: consentModeSchema.optional(),
  consentRegions: consentRegionsSchema.optional(),
  sampleRate: z.number().min(0).max(1).optional(),
  targeting: pageTargetingSchema.optional(),
  /** Owner only. An empty list removes them. */
  pathPresets: pathPresetsSchema.optional(),
  pageGroups: pageGroupsSchema.optional(),
  grouping: groupingOptionsSchema.optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  ai: aiSettingsSchema.optional(),
  /** Owner only. Turning both ways off removes the setting. */
  internalTraffic: internalTrafficSchema.optional(),
  errorCapture: z.boolean().optional(),
});
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

/** One observed version of a page: a recorded path with its language and variant. */
export interface PageVersion {
  /** Path as recorded, including any locale prefix. */
  path: string;
  locale?: string;
  variant?: string;
  /** Distinct visits. */
  visits: number;
}
export interface PageGroupSuggestion {
  /** Proposed group id and name. */
  id: string; name: string;
  /** Proposed rules. */
  match: string[];
  versions: PageVersion[];
  /** Distinct visits across all versions. */
  visits: number;
  /** True when a configured group already matches every version. */
  covered: boolean;
}
/**
 * GET /v1/projects/:projectId/page-groups/suggestions (read scope). Clusters the project's recent recordings
 * (at most 1,000) by normalized path and experiment parameter. Only clusters with two or more versions are
 * suggested; `observed` lists the most visited versions (at most 200) for previewing group rules.
 */
export interface PageGroupSuggestions {
  suggestions: PageGroupSuggestion[];
  observed: PageVersion[];
  /** Recordings read. */
  recordings: number;
  /** True when older recordings were left out. */
  truncated: boolean;
}

/*
 * Install verification. The API records when a project's tag was last seen and why
 * intake refused recent batches. Reasons never carry payload content.
 */
export const INSTALL_REJECTION_LIMIT = 20;
export type InstallRejectionReason =
  | 'origin_not_registered' | 'privacy_validation_failed' | 'invalid_payload' | 'outside_time_window'
  | 'recording_deleted' | 'recording_conflict' | 'capacity' | 'path_not_targeted' | 'policy_changed';
/** Longest rejection rule description kept in install status. */
export const INSTALL_DETAIL_MAX_LENGTH = 80;
export interface InstallRejection {
  reason: InstallRejectionReason;
  /**
   * The specific rule that refused the batch, in plain words such as "unsafe CSS" or "label not allowed
   * under strict". Chosen from a fixed set of rule names; it never carries page content. Absent for
   * records written before rules were kept.
   */
  detail?: string;
  /** Origin the batch came from, when it parsed as an origin. */
  origin?: string;
  at: number;
  /** Times this reason and origin were recorded; writes are throttled, so this is a lower bound. */
  count: number;
}
/** GET /v1/projects/:projectId/install-status */
export interface InstallStatus {
  projectId: string;
  lastConfigFetchAt?: number;
  lastConfigOrigin?: string;
  lastCollectAt?: number;
  lastCollectOrigin?: string;
  /** Reported by the tracker when it sends a version; absent today. */
  trackerVersion?: string;
  recentRejections: InstallRejection[];
}
/** Platforms the install checker can recognise from a page's HTML. */
export const INSTALL_PLATFORM_IDS = ['nextjs', 'nuxt', 'sveltekit', 'astro', 'angular', 'gatsby', 'remix', 'vite', 'wordpress', 'shopify', 'webflow', 'squarespace', 'wix', 'gtm'] as const;
export type InstallPlatformId = typeof INSTALL_PLATFORM_IDS[number];
export type InstallPlatformConfidence = 'high' | 'medium' | 'low';
export interface InstallPlatformGuess {
  id: InstallPlatformId; confidence: InstallPlatformConfidence;
  /** For Next.js: the router the page looks built with, when the HTML says. */
  variant?: 'app' | 'pages';
}
export type InstallCheckSeverity = 'ok' | 'info' | 'warn' | 'error';
export interface InstallCheckFinding { id: string; severity: InstallCheckSeverity; title: string; detail: string; fix?: string; }
/** POST /v1/projects/:projectId/install-check with {url, apiOrigin?} */
export interface InstallCheckResult {
  url: string;
  /** Origin of the page that was checked. */
  origin: string;
  originRegistered: boolean;
  httpStatus?: number;
  tagFound: boolean;
  projectIdMatches: boolean | null;
  csp: { present: boolean; scriptAllowed: boolean | null; connectAllowed: boolean | null };
  gtmDetected: boolean;
  /** Best guess at the site's platform, or null when nothing in the HTML identifies one. */
  platform: InstallPlatformGuess | null;
  /** Set when the address redirects to a different host, which the checker does not follow. */
  redirectsTo?: string;
  truncated: boolean;
  findings: InstallCheckFinding[];
}
export * from './agent';
export * from './narrative';
export * from './touch';
export * from './teams';
export * from './settings-change';
export * from './oauth';
export * from './issues';
export * from './issue-similarity';
export * from './annotations';
export * from './sharing';

/** A link an owner gives a developer. The token is shown once; only its hash is stored. */
export interface InstallShareRecord {
  id: string; projectId: string; ownerId: string; hash: string;
  /** Platform the owner had selected, so the developer sees the same steps. */
  platform?: InstallPlatformId;
  /** API origin to put in the tag as data-endpoint, when the workspace uses its own. */
  endpoint?: string;
  createdAt: number; expiresAt: number; revokedAt?: number;
}
/** GET /v1/install-shares/:token. Public. Nothing else about the project is ever returned. */
export interface InstallSharePage {
  projectId: string;
  tag: string;
  platform: InstallPlatformId | null;
  status: { tagLoaded: boolean; dataReceived: boolean };
  expiresAt: number;
}
export * from './replay-assets';
export * from './install-guides';
export * from './preview-origins';
export * from './billing';
export * from './github';
export * from './onboarding';
export * from './source-location';
