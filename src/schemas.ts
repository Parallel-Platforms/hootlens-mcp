import { z } from 'zod';

/*
 * Output schemas, one per tool. They are deliberately loose: they name the fields a program can rely on and let
 * everything else through, so a new field in an API response never breaks a tool call. Fields that may be absent
 * are optional. A response that lacks a field marked required here is a bug, and the tests catch it.
 */

const open = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
/** A tool result: every top-level field is optional, so a response that omits one still passes and the schema documents rather than polices. */
const result = (shape: Record<string, z.ZodType>) => z.looseObject(Object.fromEntries(Object.entries(shape).map(([name, type]) => [name, type.optional()])));
const str = z.string();
const num = z.number();
const strings = z.array(z.string());
const rows = (shape: z.ZodRawShape) => z.array(z.looseObject(shape));
const signalCounts = { clickCount: num.optional(), rageClickCount: num.optional(), deadClickCount: num.optional(), errorClickCount: num.optional() };

export const projectSummary = open({
  id: str, name: str.optional(), role: z.enum(['owner', 'editor', 'viewer', 'custom']).optional(), origins: strings.optional(),
  pinned: z.boolean().optional().describe('True for the project this server is pinned to'),
});

const noteLike = open({ id: str.optional(), text: str.optional(), offsetMs: num.optional() });

export const outputSchemas = {
  whoami: result({
    connected: z.boolean(), demo: z.boolean(), summary: str,
    signedInAs: open({ email: str.optional(), accountId: str.optional(), credentialKind: str.optional(), connection: str.optional(), client: str.optional() }),
    scopes: strings, siteAccess: str,
    sites: z.array(open({ id: str, name: str.optional(), role: str.optional(), scopes: strings.optional(), pinned: z.boolean().optional() })),
    pinnedProjectId: str, toolsets: strings,
  }),
  list_projects: result({ projects: z.array(projectSummary), pinnedProjectId: str.optional().describe('The project IDs default to when the server is pinned') }),
  create_site: result({ project: projectSummary, projectId: str, dashboardUrl: str, install: open({}), installationAvailable: z.boolean(), setupStatus: open({ site: z.literal('created'), installation: z.literal('not_checked'), recording: z.literal('not_checked'), consent: z.literal('required') }), next: strings }),
  get_install_snippet: result({ projectId: str, platform: str, label: str.optional(), where: str.optional(), tag: str, steps: strings.optional(), blocks: rows({ code: str, file: str.optional() }).optional(), allowedOrigins: strings.optional(), verify: strings.optional(), platforms: strings.optional() }),
  check_install: result({ url: str, tagLoaded: z.boolean(), dataReceived: z.boolean(), problems: rows({ id: str, severity: str, title: str, detail: str.optional(), fix: str.optional() }), recentRejections: rows({ reason: str, count: num }), next: str, checkError: str.optional(), lastCollectAt: num.optional(), check: open({}).optional() }),
  start_setup: result({ claimId: str, pollToken: str, status: str, projectId: str, projectName: str, siteOrigin: str, expiresAt: num, emailSent: z.boolean(), installTag: str, where: str.optional(), steps: strings.optional(), next: str, help: str.optional() }),
  check_setup: result({ claimId: str, status: z.enum(['pending', 'confirmed', 'expired']), projectId: str.optional(), projectName: str.optional(), siteOrigin: str.optional(), dashboardUrl: str.optional(), expiresAt: num.optional(), install: open({ tagLoaded: z.boolean(), dataReceived: z.boolean(), next: str }).optional(), next: str.optional() }),
  list_recordings: result({ recordings: rows({ id: str, sessionId: str.optional(), path: str.optional(), startedAt: num.optional(), endedAt: num.optional(), tags: strings.optional(), automated: z.boolean().optional(), internal: z.boolean().optional(), goalIds: strings.optional(), exitTo: str.optional(), ...signalCounts }), nextCursor: str.optional() }),
  list_sessions: result({ sessions: rows({ sessionId: str, startedAt: num.optional(), endedAt: num.optional(), pageCount: num.optional(), paths: strings.optional(), device: str.optional(), summary: str.optional(), automated: z.boolean().optional(), internal: z.boolean().optional(), goals: rows({ goalId: str, name: str }).optional(), exitTo: str.optional(), ...signalCounts }), nextCursor: str.optional() }),
  list_segments: result({ segments: rows({ id: str, name: str, filters: open({}).optional() }) }),
  get_traffic: result({ from: str, to: str, sessions: num, pageGroup: open({ id: str, name: str.optional() }).optional(), note: str.optional(), dailySessions: z.array(z.tuple([str, num])), goals: rows({ goalId: str, name: str.optional(), sessions: num.optional(), conversions: num.optional() }), visitors: open({ new: num, returning: num, unknown: num }).optional(), automatedSessions: num.optional() }),
  get_session_narrative: result({ summary: str.optional(), facts: open({}).optional(), steps: rows({ text: str, recordingId: str.optional(), offsetMs: num.optional(), source: str.optional() }).optional(), annotations: z.unknown().optional() }),
  get_recording: result({ recording: open({ id: str.optional() }).optional(), events: z.array(z.unknown()).optional(), clicks: z.array(z.unknown()).optional(), tags: strings.optional(), notes: z.array(noteLike).optional() }),
  load_replay: result({ projectId: str, assetOrigin: str, recording: open({ id: str.optional(), path: str.optional(), deviceClass: str.optional() }), events: z.array(z.unknown()), errors: z.array(z.unknown()) }),
  add_note: result({ note: open({ id: str.optional(), text: str.optional(), offsetMs: num.optional() }) }),
  review_findings: result({ segments: num.optional(), signal: z.unknown().optional(), sample: str.optional(), cohorts: rows({ key: str, clicks: num.optional(), frictionClicks: num.optional() }) }),
  list_errors: result({ from: str, to: str, recording: z.boolean(), errors: rows({ id: str, error: str, at: str.optional(), pageViews: num, visits: num, firstSeen: str, lastSeen: str, releases: z.array(z.unknown()), pageGroups: z.array(z.unknown()), deviceClasses: z.array(z.unknown()) }), moreNotShown: num.optional(), droppedOccurrences: num.optional(), note: str.optional() }),
  get_error: result({ id: str, error: str, at: str.optional(), mapped: z.boolean(), pageViews: num, visits: num, stack: rows({ frame: str, resolved: z.boolean().optional(), source: strings.optional() }), cohorts: z.array(z.unknown()), sourceMaps: str.optional() }),
  explain_snags: result({ status: str.optional(), message: str.optional(), explanation: z.unknown().optional() }),
  list_heatmaps: result({ cohorts: rows({ key: str, path: str.optional(), deviceClass: str.optional(), sessions: num.optional(), clicks: num.optional(), versionLabel: str.optional() }) }),
  get_heatmap: result({ key: str, path: str.optional(), deviceClass: str.optional(), selectors: rows({ selector: str, name: str.optional().describe('The name the team gave this element, when it has one'), clicks: num }).optional(), scrollDepths: z.array(num).optional(), grid: open({ cellSize: num, cells: z.array(z.unknown()) }).optional() }),
  list_changes: result({ changes: rows({ id: str, at: num, title: str, pageGroup: str.optional(), createdBy: str.optional(), source: str.optional() }) }),
  log_change: result({ change: open({ id: str, at: num, title: str }) }),
  change_impact: result({ summary: str.optional() }),
  list_goals: result({ goals: rows({ id: str.optional(), name: str.optional() }) }),
  list_funnels: result({ funnels: rows({ id: str.optional(), name: str.optional(), steps: z.array(z.unknown()).optional() }) }),
  get_funnel: result({ steps: z.array(z.unknown()).optional() }),
  weekly_summary: result({ noData: z.boolean().optional() }),
  suggest_pages_to_record: result({ suggestions: rows({ path: str, clicks: num, visits: num, from: strings, reason: z.enum(['excluded', 'not-included']), change: open({}) }), recordings: open({ read: num, withLinks: num }), note: str.optional() }),
  get_site_settings: result({ projectId: str, role: str, privacy: open({ preset: str }), targeting: open({ include: strings, exclude: strings }), pathPresets: rows({ match: str, preset: str }), goals: rows({ id: str, name: str }), funnels: rows({ id: str, name: str }), canChange: strings, note: str }),
  preview_settings_change: result({ changed: z.boolean(), token: str.optional(), expiresAt: num.optional(), diff: rows({ area: str, action: str, summary: str }), effects: strings, warnings: strings, message: str.optional() }),
  apply_settings_change: result({ applied: z.boolean(), appliedAt: num.optional(), diff: rows({ area: str, action: str, summary: str }), areas: strings.optional(), message: str.optional() }),
  submit_issue: result({ issue: open({ number: num, id: str.optional() }) }),
  submit_issues: result({
    results: rows({ index: num, status: z.enum(['created', 'replayed', 'failed']), issue: open({ number: num, id: str.optional() }).optional(), error: open({ status: num, message: str }).optional() }),
    created: num, replayed: num, failed: num,
    screenshotErrors: z.array(z.unknown()).optional(),
  }),
  find_similar_issues: result({ matches: rows({ number: num, id: str, title: str, status: str, kind: str, score: num, reasons: strings, mine: z.boolean().optional() }), checked: num, scope: str }),
  get_issue_screenshot: result({ attachment: open({ id: str, contentType: str.optional() }) }),
  list_my_issues: result({ issues: z.array(z.unknown()), nextCursor: str.optional() }),
  get_issue: result({ issue: open({}) }),
  reply_issue: result({}),
  triage_queue: result({ issues: rows({ number: num, status: str, title: str }), moreNeedingAttention: z.boolean() }),
  issue_feed: result({}),
  claim_issue: result({}),
  set_issue_status: result({}),
  update_issue: result({}),
} satisfies Record<string, z.ZodType>;

export type ToolName = keyof typeof outputSchemas;
