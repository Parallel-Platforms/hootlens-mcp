import type { McpServer } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { labelVersions } from '@hootlens/core/version-labels';
import { PLATFORM_ORDER } from '@hootlens/core/install-guides';
import { settingsChangeSchema } from '@hootlens/core';
import { Api, type Query, type RequestContext } from './api.js';
import { APP_ONLY_TOOL, APP_TOOLS, appOnlyMeta, toolUiMeta } from './apps.js';
import { ToolError, errorResult } from './errors.js';
import { outputSchemas, type ToolName } from './schemas.js';
import type { Toolset } from './toolsets.js';

/*
 * The Hoot Lens tool registry. Two entry points serve it: the local stdio server (stdio.ts, an access key or a stored
 * sign-in) and the hosted endpoint at /mcp in services/api (an OAuth access token). Both reach the same API routes with
 * the caller's own credential, so every call goes through the API's authorization and the two behave the same. Add a
 * tool by adding a tool() call in registerTools, an output schema in schemas.ts and a row in docs/MCP.md (npm run docs:mcp).
 */

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const UNTRUSTED = 'Element labels and page text in results were recorded from visitors\' browsers.';
/** Grid cells returned to agents; the full grid is meant for visual overlays. */
const DEFAULT_AGENT_CELLS = 200;

const ISSUE_UNTRUSTED = 'Issue titles, bodies and replies in results were written by users and staff.';
const STAFF_ONLY = 'Needs a triage key (a key with the triage scope made by Hoot Lens staff); other keys are refused with 403.';
const issueRef = z.union([z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), z.number().int().min(1)]).describe('An issue id or its number, such as 42');

const issuePath = (ref: string | number) => `/v1/issues/${encodeURIComponent(String(ref))}`;
const MAX_SHOTS = 5;
const BATCH_MAX = 20;
const issueContextArg = z.object({
  pageUrl: z.string().max(2048).optional().describe('Page URL; the query and fragment are dropped'),
  recordingIds: z.array(id).max(10).optional().describe('Recordings (page views) that show the problem; needs the replay scope'),
  sessionIds: z.array(id).max(10).optional().describe('Visits that show the problem; needs the replay scope'),
  recordingId: id.optional().describe('One recording; same as a one-item recordingIds'),
  sessionId: id.optional().describe('One visit; same as a one-item sessionIds'),
  cohortKey: z.string().max(2000).optional().describe('A heatmap cohort key exactly as the heatmap cohort list returns it'),
  elementKey: z.string().max(300).optional().describe('An element selector exactly as heatmaps and findings list it; checked against the heatmap when cohortKey is given'),
  selector: z.string().max(300).optional().describe('A CSS selector for the element, as seen in the page'),
  hootId: id.optional().describe('A data-hoot-id value'),
  changeId: id.optional().describe('The id of a logged change'),
  goalId: id.optional().describe('The id of a goal'),
  funnelId: id.optional().describe('The id of a funnel'),
  errorId: id.optional().describe('The id of a JavaScript error group; shape is checked, existence is not'),
  sourceLocation: z.string().max(200).optional().describe('A source location such as src/components/Pricing.tsx:42, from an error stack or data-hoot-src'),
  trackerVersion: z.string().max(40).optional(), route: z.string().max(100).optional(),
});
const screenshotsArg = z.array(z.object({
  data: z.string().min(8).describe('Base64 of a PNG, JPEG or WebP image, at most 2 MB once decoded'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional().describe('Checked against the image bytes'),
  name: z.string().max(100).optional(),
})).max(MAX_SHOTS).optional().describe(`Up to ${MAX_SHOTS} screenshots`);
const idempotencyKeyArg = z.string().regex(/^[\x21-\x7e]{1,128}$/).optional().describe('A value that identifies this issue, so a retry with the same value does not create it twice');
const issueFields = {
  kind: z.enum(['bug', 'feature', 'question', 'feedback']),
  title: z.string().min(1).max(140),
  body: z.string().min(1).max(10_000).describe('Markdown text'),
  severity: z.enum(['blocking', 'annoying', 'minor']).optional().describe('blocking: work cannot be done. annoying: in the way, with a workaround. minor: a small rough edge.'),
  projectId: id.optional(),
  context: issueContextArg.optional(),
  relatedIssues: z.array(issueRef).max(10).optional().describe('Issues visible to the key that this one relates to, by id or number'),
};
/** Uploads screenshots to a filed issue one at a time. A failed upload is reported, never raised, because the issue already exists. */
async function uploadScreenshots(t: ToolContext, issueId: string, shots: NonNullable<z.infer<typeof screenshotsArg>>) {
  const attached: unknown[] = [];
  const errors: { index: number; message: string }[] = [];
  for (const [index, shot] of shots.entries()) {
    try {
      const done = await t.issue('POST', `${issuePath(issueId)}/attachments`, { body: { data: shot.data, ...(shot.name ? { name: shot.name } : {}), ...(shot.mediaType ? { contentType: shot.mediaType } : {}) } });
      attached.push(done.attachment);
    } catch (error) {
      errors.push({ index, message: error instanceof Error ? error.message : 'Upload failed' });
    }
  }
  return { attached, errors };
}
interface QueueIssue { id: string; number: number; kind: string; status: string; title: string; priority?: string; labels?: string[]; assignee?: string; needsAttention?: boolean; projectId?: string; updatedAt: number; replyCount: number; lastReplyBy?: string; duplicateOf?: string; severity?: string; filedVia?: string; client?: string; submitter?: { email?: string } }
const compact = (issue: QueueIssue) => ({
  number: issue.number, id: issue.id, kind: issue.kind, status: issue.status, title: issue.title, needsAttention: issue.needsAttention === true,
  ...(issue.priority ? { priority: issue.priority } : {}), ...(issue.labels?.length ? { labels: issue.labels } : {}), ...(issue.assignee ? { assignee: issue.assignee } : {}),
  ...(issue.projectId ? { projectId: issue.projectId } : {}), replies: issue.replyCount, ...(issue.lastReplyBy ? { lastReplyBy: issue.lastReplyBy } : {}),
  updatedAt: issue.updatedAt, ...(issue.duplicateOf ? { duplicateOf: issue.duplicateOf } : {}),
  ...(issue.severity ? { severity: issue.severity } : {}), ...(issue.filedVia ? { filedVia: issue.filedVia } : {}), ...(issue.client ? { client: issue.client } : {}),
});
/** Recording filters shared by list_recordings and list_sessions. */
const recordingFilters = {
  path: z.string().startsWith('/').max(300).optional(),
  group: z.string().min(1).max(300).optional().describe('A page group id as listed in heatmap cohorts, such as /'),
  locale: z.string().regex(/^[a-z]{2,3}$/).optional().describe('Primary language such as es'),
  variant: z.string().min(1).max(100).optional(),
  deviceClass: z.enum(['desktop', 'tablet', 'mobile']).optional(),
  minDurationMs: z.number().int().min(0).optional(),
  signal: z.enum(['rage', 'dead', 'error']).optional(),
  tag: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(32).optional().describe('Only recordings (or visits with a page view) the team tagged with this lower-case tag, such as checkout-bug'),
  utmSource: z.string().max(100).optional(),
  utmCampaign: z.string().max(100).optional(),
  referrer: z.string().max(200).optional(),
  browser: z.enum(['chrome', 'safari', 'firefox', 'edge', 'other']).optional(),
  os: z.enum(['windows', 'macos', 'ios', 'android', 'linux', 'other']).optional(),
  newVisitor: z.boolean().optional(),
  segmentId: id.optional().describe('The id of a saved segment; filters passed as well replace its own'),
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
  include_automated: z.boolean().optional().describe('Also list automated visits (bots, headless browsers, scripted clicking), which are left out by default. Each carries automated: true and the reasons observed. Aggregate counts such as traffic totals exclude them.'),
  include_internal: z.boolean().optional().describe('Also list internal visits (made by the site\'s own team, through the internal link or from a listed address), which are left out by default. Each carries internal: true. Aggregate counts such as traffic totals and goal rates exclude them.'),
  goal: z.string().min(1).max(100).optional().describe('Only visits that converted this goal: a goal id or its name. Unknown goals are refused with 404. A visit counts when it converted the goal under its current definition.'),
  element: z.string().min(1).max(300).optional().describe('Only visits with a click on this element: a data-hoot-id such as home-menu-toggle, an element key exactly as findings and heatmaps list it (its selector), or a selector. Matches visits recorded after this filter shipped; each page view remembers its first 60 distinct clicked elements.'),
};
/** The API filters for include_automated and include_internal: absent or false keeps the default of leaving those visits out. */
const withAutomated = ({ include_automated, include_internal, ...query }: { include_automated?: boolean; include_internal?: boolean } & Record<string, string | number | boolean | undefined>) =>
  ({ ...query, ...(include_automated ? { automated: 'include' } : {}), ...(include_internal ? { internal: 'include' } : {}) });

interface TrafficRow { key: string; sessions: number }
interface TrafficBody {
  from: number; to: number; sessions: number; automatedSessions?: number; daily: { day: string; sessions: number; automated?: number }[];
  goals: { goalId: string; name: string; sessions: number; conversions: number; rate: number | null; interval: [number, number] | null }[];
  visitors: { new: number; returning: number; unknown: number };
  group?: { id: string; name: string };
  [list: string]: unknown;
}
const round = (value: number | null) => value === null ? null : Math.round(value * 1000) / 1000;
/** The traffic response in fewer tokens: ISO dates, days as [day, sessions] pairs without the empty ones, and no empty lists. */
function compactTraffic(body: TrafficBody) {
  const lists = ['referrers', 'utmSources', 'utmCampaigns', 'deviceClasses', 'browsers', 'operatingSystems', 'channels', 'countries', 'adNetworks', 'inApps', 'entryPages', 'languages', 'variants'];
  const gaps = body.notRecorded as { countries: number; channels: number; entryPages: number } | undefined;
  const missing = gaps && (gaps.countries > 0 || gaps.channels > 0 || gaps.entryPages > 0);
  return {
    from: new Date(body.from).toISOString().slice(0, 10), to: new Date(body.to).toISOString().slice(0, 10), sessions: body.sessions,
    ...(body.group ? { pageGroup: body.group } : {}),
    note: body.group
      ? 'Visits that viewed this page group (a visit that viewed two groups counts in both). Only device class, language and variant are counted per page group.'
      : '"(direct)" is a visit without an external referrer; "(other)" pools keys beyond the 100 kept per day; "unknown" means the project privacy policy did not allow the value.',
    dailySessions: body.daily.filter(day => day.sessions > 0).map(day => [day.day, day.sessions]),
    ...(body.automatedSessions ? {
      automatedSessions: body.automatedSessions,
      dailyAutomated: body.daily.filter(day => day.automated).map(day => [day.day, day.automated]),
      automatedNote: 'Visits detected as automated (bots, headless browsers, scripted clicking). They are left out of the visit count and every other count here.',
    } : {}),
    ...Object.fromEntries(lists.filter(name => Array.isArray(body[name]) && (body[name] as TrafficRow[]).length).map(name => [name, (body[name] as TrafficRow[]).map(row => [row.key, row.sessions])])),
    ...(body.group ? {} : { visitors: body.visitors }),
    // Channels, countries and entry pages were counted from a date; earlier visits have none. Say how many, so the lists add up to sessions.
    ...(missing ? {
      notRecorded: gaps,
      sourcesNote: `${body.sourcesCountedFrom ? `Channels, countries and entry pages are counted from ${body.sourcesCountedFrom}; earlier visits have none. ` : ''}notRecorded is the number of visits with no value for each, so each list plus its notRecorded adds up to sessions. A country of "unknown" is a visit counted whose country could not be resolved.`,
    } : {}),
    goals: body.goals.map(goal => ({ goalId: goal.goalId, name: goal.name, sessions: goal.sessions, conversions: goal.conversions, rate: round(goal.rate), interval: goal.interval?.map(round) ?? null })),
  };
}

type Obj = Record<string, unknown>;
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** A link to a resource the client can read with resources/read, returned beside a tool's data. */
export interface ResourceLinkItem { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string }
/** What a tool handler returns: the data, optionally a human sentence (the default is the data as JSON) and links. */
interface ToolOutput { value: Record<string, unknown>; text?: string; links?: ResourceLinkItem[]; /** Images returned as MCP image content, such as an issue screenshot. */ images?: { data: string; mimeType: string }[] }
const out = (value: Record<string, unknown>, links?: ResourceLinkItem[], text?: string): ToolOutput => ({ value, ...(links?.length ? { links } : {}), ...(text !== undefined ? { text } : {}) });

/** The request helpers a handler gets, bound to the tool, the scope it needs and the project it works on. */
interface ToolContext {
  get(path: string, query?: Query): Promise<Obj>;
  post(path: string, body: unknown, options?: { timeoutMs?: number; accept?: number[]; headers?: Record<string, string> }): Promise<{ status: number; body: Obj }>;
  issue(method: 'GET' | 'POST' | 'PATCH', path: string, options?: { query?: Query; body?: unknown; headers?: Record<string, string> }): Promise<Obj>;
}

interface ToolDef<Shape extends z.ZodRawShape> {
  /** The group the tool belongs to; a person turns groups on and off. */
  toolset: Toolset;
  /** Offered whatever toolsets are on, for a tool that every connection needs (whoami). */
  always?: boolean;
  /** The project scope the tool needs, named in the error when the credential lacks it. */
  scope?: 'read' | 'replay' | 'annotate' | 'configure' | 'sites:create';
  /** Takes a required projectId that defaults to the pinned project. */
  scoped?: boolean;
  title: string;
  description: string;
  input: z.ZodObject<Shape>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };
}

export interface ToolOptions {
  /** The origin recorded pages may load assets from (the signed asset proxy), named by the replay tool so a viewer can confine what it loads to it. */
  assetOrigin?: string | undefined;
  /** A project that projectId defaults to, so a person working in one project never has to name it. */
  pinnedProject?: string | undefined;
  /** The toolsets to offer. */
  toolsets: ReadonlySet<Toolset>;
  /** Tools to leave out even though their toolset is on. */
  hide?: ReadonlySet<string> | undefined;
  /** A sentence added after every tool result, for a server whose data needs a standing caveat (the public demo's sample data). */
  notice?: string | undefined;
}

const projectLink = (project: { id: string; name?: string }): ResourceLinkItem => ({ type: 'resource_link', uri: `hootlens://projects/${project.id}`, name: project.name ?? project.id, description: 'Project summary', mimeType: 'application/json' });
export const recordingLink = (projectId: string, recordingId: string): ResourceLinkItem => ({ type: 'resource_link', uri: `hootlens://projects/${projectId}/recordings/${recordingId}`, name: `Recording ${recordingId}`, description: 'Narrative of this page view', mimeType: 'application/json' });
export const heatmapLink = (projectId: string, key: string): ResourceLinkItem => ({ type: 'resource_link', uri: `hootlens://projects/${projectId}/heatmaps/${encodeURIComponent(key)}`, name: 'Heatmap cohort', description: 'Clicks, snags and scroll depth for this cohort', mimeType: 'application/json' });

/* ---------------------------------------------------------------- JavaScript errors */

interface ErrorFrameBody { url?: string; line?: number; col?: number; fn?: string; resolved?: { source: string; line: number; col?: number; name?: string; context?: { line: number; text: string }[] } }
interface ErrorGroupBody {
  id: string; name: string; message?: string; kind: string; opaque?: boolean; location?: string; topFrame?: ErrorFrameBody; count: number; visits: number; firstSeenAt: number; lastSeenAt: number;
  releases: { key: string; count: number }[]; pageRevisions: { key: string; count: number }[]; variants: { key: string; count: number }[]; pageGroups: { key: string; count: number }[]; deviceClasses: { key: string; count: number }[];
  followedClicks: { selector: string; name?: string; count: number }[]; examples: { recordingId?: string; at: number; offsetMs?: number }[];
}
interface ErrorListBody { from: number; to: number; recording: boolean; errors: ErrorGroupBody[]; more: number; dropped?: number }
interface ErrorDetailBody extends ErrorGroupBody { stack: ErrorFrameBody[]; mapped: boolean; cohorts: Obj[] }

const iso = (time: number) => new Date(time).toISOString();
const pairs = (rows: { key: string; count: number }[]) => rows.map(row => [row.key, row.count]);
/** "TypeError: message", or just the name when the message was not recorded. */
const errorTitle = (error: Pick<ErrorGroupBody, 'name' | 'message' | 'opaque'>) =>
  error.opaque ? 'Script error from another origin (the browser withheld the details)' : error.message ? `${error.name}: ${error.message}` : error.name;
/** One error group in few tokens: the title and where it was thrown first, counts as pairs, no empty lists. */
function compactError(error: ErrorGroupBody) {
  return {
    id: error.id, error: errorTitle(error), ...(error.location ? { at: error.location } : {}),
    pageViews: error.count, visits: error.visits, firstSeen: iso(error.firstSeenAt), lastSeen: iso(error.lastSeenAt),
    releases: pairs(error.releases), pageGroups: pairs(error.pageGroups), deviceClasses: pairs(error.deviceClasses),
    ...(error.pageRevisions.length > 1 ? { pageRevisions: pairs(error.pageRevisions) } : {}), ...(error.variants.length > 1 || error.variants[0]?.key !== 'default' ? { variants: pairs(error.variants) } : {}),
    ...(error.followedClicks.length ? { followedClicks: error.followedClicks.map(link => ({ element: link.name ?? link.selector, selector: link.selector, times: link.count })) } : {}),
    ...(error.examples.length ? { examples: error.examples.map(example => ({ recordingId: example.recordingId, offsetMs: example.offsetMs })) } : {}),
  };
}
function compactErrors(list: ErrorListBody) {
  return {
    from: iso(list.from), to: iso(list.to), recording: list.recording,
    note: list.recording
      ? 'Each error counts once per page view. Releases, page groups and device classes are counted separately; a release not listed did not hit the error in this range.'
      : 'This site has not turned on JavaScript error recording (Settings, Capture), so none are recorded.',
    errors: list.errors.map(compactError),
    ...(list.more ? { moreNotShown: list.more } : {}),
    ...(list.dropped ? { droppedOccurrences: list.dropped } : {}),
  };
}
/** A frame as one line: original file and line first when resolved, else the script and position. */
function frameLine(frame: ErrorFrameBody): string {
  const fn = frame.fn ? ` (${frame.fn})` : '';
  if (frame.resolved) return `${frame.resolved.source}:${frame.resolved.line}${frame.resolved.col !== undefined ? `:${frame.resolved.col}` : ''}${frame.resolved.name ? ` ${frame.resolved.name}` : fn}`;
  let path = frame.url ?? '';
  try { path = new URL(path).pathname.replace(/^\/+/, '') || path; } catch { /* keep the text */ }
  return `${path}${frame.line !== undefined ? `:${frame.line}${frame.col !== undefined ? `:${frame.col}` : ''}` : ''}${fn}`.trim();
}
function compactErrorDetail(error: ErrorDetailBody) {
  const resolvedFirst = [...error.stack].sort((a, b) => Number(Boolean(b.resolved)) - Number(Boolean(a.resolved)));
  return {
    ...compactError(error), mapped: error.mapped,
    stack: resolvedFirst.map(frame => ({ frame: frameLine(frame), ...(frame.resolved ? { resolved: true } : {}), ...(frame.resolved?.context ? { source: frame.resolved.context.map(line => `${line.line}${line.line === frame.resolved!.line ? '>' : ' '} ${line.text}`) } : {}) })),
    ...(error.mapped ? {} : { sourceMaps: 'No frame was resolved. Upload this release\'s source maps with: hootlens sourcemaps upload --release <release> <build directory>' }),
    cohorts: error.cohorts,
  };
}
const recordingLinksOf = (projectId: string, errors: { examples: { recordingId?: string }[] }[]): ResourceLinkItem[] =>
  [...new Set(errors.flatMap(error => error.examples.map(example => example.recordingId).filter((value): value is string => typeof value === 'string')))].slice(0, 5).map(rid => recordingLink(projectId, rid));

/** Registers the Hoot Lens tools the options allow on `server`, in a fixed order so tools/list is deterministic. */
export function registerTools(server: McpServer, api: Api, options: ToolOptions): void {
  const pinned = options.pinnedProject;
  const projectArg = (pinned ? id.optional().describe(`The project ID. Defaults to the pinned project ${pinned}.`) : id.describe('The project ID')) as unknown as typeof id;

  function tool<Shape extends z.ZodRawShape>(name: ToolName, def: ToolDef<Shape>, handler: (args: z.infer<z.ZodObject<Shape>>, t: ToolContext) => Promise<ToolOutput>): void {
    if (!(def.always || options.toolsets.has(def.toolset)) || options.hide?.has(name)) return;
    if (def.toolset === 'sites' && (pinned || options.notice)) return;
    server.registerTool(name, {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      outputSchema: outputSchemas[name],
      annotations: { title: def.title, ...(def.annotations ?? {}) },
      // MCP Apps: a pointer to the view that shows this tool's result, or the marker that only a view calls this tool.
      ...(name in APP_TOOLS ? { _meta: toolUiMeta(APP_TOOLS[name]!) } : name === APP_ONLY_TOOL ? { _meta: appOnlyMeta() } : {}),
    } as never, (async (rawArgs: Record<string, unknown>) => {
      try {
        const args = { ...rawArgs };
        if (def.scoped) {
          const projectId = typeof args.projectId === 'string' ? args.projectId : pinned;
          if (projectId === undefined) throw new ToolError('projectId is required because no project is pinned. Call list_projects to choose one, or pin a project with HOOTLENS_PROJECT, a .hootlens.json file or ?project= on the hosted URL.', 'project_required');
          args.projectId = projectId;
        }
        const context = (): RequestContext => ({ tool: name, ...(def.scope ? { scope: def.scope } : {}), ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}) });
        const t: ToolContext = {
          get: async (path, query) => (await api.get(path, query, context())) as Obj,
          post: async (path, body, o) => (await api.request('POST', path, { body, context: context(), ...(o?.headers ? { headers: o.headers } : {}), ...(o?.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o?.accept ? { accept: o.accept } : {}) })) as { status: number; body: Obj },
          issue: async (method, path, o) => (await api.request(method, path, { ...(o?.query ? { query: o.query } : {}), ...(o?.body !== undefined ? { body: o.body } : {}), ...(o?.headers ? { headers: o.headers } : {}), context: context() })).body as Obj,
        };
        const result = await handler(args as z.infer<z.ZodObject<Shape>>, t);
        return { content: [{ type: 'text' as const, text: result.text ?? JSON.stringify(result.value) }, ...(result.links ?? []), ...(result.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })), ...(options.notice ? [{ type: 'text' as const, text: options.notice }] : [])], structuredContent: result.value,
          // The view needs the project of a result when the model named none (a pinned project). It travels in _meta, which the model does not read, so the text and the data are as they were.
          ...(name in APP_TOOLS && typeof args.projectId === 'string' ? { _meta: { 'com.hootlens/app': { projectId: args.projectId } } } : {}) };
      } catch (error) {
        return errorResult(error);
      }
    }) as never);
  }
  tool('whoami', {
    toolset: 'read', always: true, title: 'Check the connection',
    description: `Confirms the connection with one request that reads no recordings. Returns whether it is connected, who is signed in (the account, and the connection or access key acting for it), the scopes this connection holds (read, replay, annotate, triage, configure or account-level sites:create), and every site (project) it can reach with the role and scopes it has there. A missing or expired sign-in returns an error that says so.`,
    input: z.object({}),
    annotations: readOnly,
  }, async (_args, t) => {
    if (options.notice) {
      // The anonymous demo has no account or credential to describe, and reads only the sample site, so it says so.
      const listed = await t.get('/v1/projects') as { projects?: { id: string; name?: string; role?: string }[] };
      const sample = (listed.projects ?? []).map(project => ({ ...project, scopes: ['read', 'replay'], pinned: true }));
      return out({
        connected: true, demo: true, summary: 'Connected to the Hoot Lens demo. Nobody is signed in: this is a read-only sample site with synthetic data, not an account.',
        signedInAs: { credentialKind: 'demo' }, scopes: ['read', 'replay'], siteAccess: 'the demo site only', sites: sample, ...(pinned ? { pinnedProjectId: pinned } : {}), toolsets: [...options.toolsets],
      }, sample.map(projectLink));
    }
    const body = await t.get('/v1/access') as {
      account?: { id?: string; email?: string };
      credential?: { kind?: string; name?: string; client?: string; scopes?: string[]; projects?: 'all' | string[] };
      projects?: { id: string; name?: string; role?: string; scopes?: string[] }[];
    };
    const credential = body.credential ?? {};
    const sites = (body.projects ?? []).map(project => ({ ...project, ...(project.id === pinned ? { pinned: true } : {}) }));
    const signedInAs = {
      ...(body.account?.email ? { email: body.account.email } : {}), ...(body.account?.id ? { accountId: body.account.id } : {}),
      // `person` is a signed-in dashboard session; otherwise an access key or an assistant connection acting for the account.
      credentialKind: credential.kind ?? 'unknown', ...(credential.name ? { connection: credential.name } : {}), ...(credential.client ? { client: credential.client } : {}),
    };
    const scopes = credential.scopes ?? [];
    const summary = `Connected. ${signedInAs.email ?? (credential.name ? `Signed in through ${credential.name}` : 'Signed in')}, with ${scopes.length ? `the ${scopes.join(', ')} scope${scopes.length === 1 ? '' : 's'}` : 'no scopes'}. ${sites.length ? `${sites.length} site${sites.length === 1 ? '' : 's'}: ${sites.map(site => `${site.name ?? site.id} (${site.id}, ${site.role ?? 'member'})`).join(', ')}.` : 'No sites are reachable with this connection.'}`;
    return out({
      connected: true, summary, signedInAs, scopes,
      siteAccess: credential.projects === undefined || credential.projects === 'all' ? 'all your sites' : `${credential.projects.length} chosen site${credential.projects.length === 1 ? '' : 's'}`,
      sites, ...(pinned ? { pinnedProjectId: pinned } : {}), toolsets: [...options.toolsets],
    }, sites.map(projectLink));
  });

  tool('list_projects', {
    toolset: 'read', title: 'List sites',
    description: `Lists the sites (projects) available to this access token, each with the role (owner, editor, viewer or custom) of the person who created the key. A key can do no more than its creator is allowed to do on the site, whatever scopes it was issued with.`,
    input: z.object({}),
    annotations: readOnly,
  }, async (_args, t) => {
    const body = await t.get('/v1/projects');
    const projects = ((body.projects ?? []) as { id: string; name?: string }[]).map(project => ({ ...project, ...(project.id === pinned ? { pinned: true } : {}) }));
    return out({ ...body, projects, ...(pinned ? { pinnedProjectId: pinned } : {}) }, projects.map(projectLink));
  });

  tool('create_site', {
    toolset: 'sites', scope: 'sites:create', title: 'Create a site',
    description: 'Creates a site in the authenticated owner\'s own Hoot Lens account and returns its project ID and platform-specific installation code. Requires a verified owner and explicitly approved OAuth sites:create permission for all sites. Personal access tokens, anonymous demo and project-pinned connections cannot use it. The API enforces available site slots atomically. Within 24 hours, a retry with the same idempotencyKey and identical site arguments recovers the original site; after a timeout, creation may already have succeeded. Idempotency protection expires after 24 hours. Balanced privacy is the default; strict is also available. Consent is required before capture. Site creation, tag installation and received recording data are separate states; installation and recording are returned as not_checked.',
    input: z.object({
      name: z.string().trim().min(1).max(80).describe('The website\'s name'),
      origins: z.array(z.string().url().max(2048).refine(value => {
        try {
          const url = new URL(value);
          return !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '') && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
        } catch { return false; }
      }, 'Exact HTTPS origins exclude credentials, paths, queries and fragments. Localhost HTTP is allowed for development.')).min(1).max(20).describe('Exact website origins, for example https://example.com'),
      privacyPreset: z.enum(['balanced', 'strict']).default('balanced').describe('Balanced masks form values; strict also masks page text. Capture requires consent.'),
      idempotencyKey: z.string().regex(/^[\x21-\x7e]{8,128}$/).describe('Stable key for this intended site, such as a UUID. The same key and identical site arguments recover the original site within 24 hours.'),
      platform: z.enum(PLATFORM_ORDER as [string, ...string[]]).optional().describe('The installation platform. Default html.'),
      variant: z.enum(['app', 'pages']).optional().describe('For nextjs: app (default) or pages.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name, origins, privacyPreset, idempotencyKey, platform, variant }, t) => {
    const created = (await t.post('/v1/projects', { name, origins, privacy: { preset: privacyPreset }, consent: 'required' }, { headers: { 'Idempotency-Key': idempotencyKey }, timeoutMs: 20000 })).body;
    const project = z.looseObject({ id, name: z.string().optional() }).parse(created.project);
    let install: Obj | undefined;
    try { install = await t.get(`/v1/projects/${project.id}/install-snippet`, { platform, variant }); } catch { /* Creation succeeded. Report the site and a safe follow-up, without creating another site. */ }
    return out({ ...created, projectId: project.id, dashboardUrl: `https://hootlens.com/app/installation?project=${encodeURIComponent(project.id)}`, ...(install ? { install } : {}), installationAvailable: install !== undefined, setupStatus: { site: 'created', installation: 'not_checked', recording: 'not_checked', consent: 'required' }, next: [
      install ? 'Install this snippet on the intended public pages and arrange consent before capture.' : `Site created. Call get_install_snippet with projectId ${project.id} to retrieve the tag. Do not create a replacement site.`,
      'Required consent: connect your consent platform with data-consent-source="onetrust", "cookiebot" or "gcm", or add data-consent-source="hootlens" for an explicit visitor control. Custom consent integrations must report the visitor\'s actual choice. See https://hootlens.com/docs/INSTALL.md.',
      'Idempotency protects retries for 24 hours. After that, call list_projects and inspect the intended origins before deciding whether another creation is needed.',
      `Call check_install with projectId ${project.id} after installation. Only the install check can report whether the tag loaded and recording data arrived.`,
      ...(!options.toolsets.has('install') || !options.toolsets.has('read') ? ['This connection hides some setup tools. Enable the read and install toolsets to list existing sites, retrieve snippets and check installation, or open the installation page above.'] : []),
    ] }, [projectLink(project)]);
  });

  tool('get_install_snippet', {
    toolset: 'install', scope: 'read', scoped: true, title: 'Get install tag',
    description: `Returns the exact Hoot Lens install for a project and platform: the one script tag, the file or screen it goes in, the code for that platform (Next.js App Router layout.tsx or Pages _document, Vite index.html, Nuxt app.head, SvelteKit app.html, Angular index.html, Astro layout, WordPress, Shopify theme.liquid, Google Tag Manager Custom HTML, Remix, Gatsby, Webflow, Squarespace, Wix, or plain html), the site's allowed addresses and how to check the install. Takes platform (default html, the raw tag). The project ID is public and the snippet contains no secret. Needs the read scope.`,
    input: z.object({ projectId: projectArg, platform: z.enum(PLATFORM_ORDER as [string, ...string[]]).optional().describe('The site\'s platform. Default html.'), variant: z.enum(['app', 'pages']).optional().describe('For nextjs: app (App Router, the default) or pages (Pages Router). One router per snippet.') }),
    annotations: readOnly,
  }, async ({ projectId, platform, variant }, t) => out(await t.get(`/v1/projects/${projectId}/install-snippet`, { platform, variant })));

  tool('check_install', {
    toolset: 'install', scope: 'read', scoped: true, title: 'Check the install',
    description: `Checks whether Hoot Lens is installed and working on a project's site. Fetches the page (the project's first allowed site by default, or a url on one of its allowed sites) and reports whether the tag is in the HTML with the right project ID, any Content Security Policy problem, the detected platform, whether the tag has loaded in a visitor's browser, whether the first data has arrived and the most recent refused batches by reason, with a next step. Needs only the read scope: it can look only at the project's own allowed sites, not at an arbitrary address (the dashboard's own page checker takes any address and needs the owner). Limit: 10 checks a minute. A tag added by Google Tag Manager or JavaScript does not appear in the HTML; tagLoaded and dataReceived report whether visitors have loaded it. ${UNTRUSTED}`,
    input: z.object({ projectId: projectArg, url: z.string().url().max(2048).optional().describe('A page on one of the project\'s allowed sites. Default: the first allowed site\'s home page.') }),
    annotations: { ...readOnly, openWorldHint: true },
  }, async ({ projectId, url }, t) => out(await t.issue('POST', `/v1/projects/${projectId}/install-verify`, { body: url ? { url } : {} })));

  tool('start_setup', {
    toolset: 'install', title: 'Start setup for a site',
    description: `Starts a Hoot Lens setup for a website that has no Hoot Lens site (project) yet. It needs no account or sign-in. Takes the owner's email address and the site address. Hoot Lens emails that person ONE link ("Confirm that <agent name> may set up Hoot Lens for <site>"). The project does not exist, and nothing is recorded, until they open it. The result has the exact install tag, where it goes, a claimId and a pollToken. The tag is safe to commit because the project id is public. Until the person confirms, the collector refuses the tag's data with project_pending and Hootlens.status() reports reason project-pending. The pollToken is a secret. Limit: 5 requests an hour per address and per network. It returns no access token; after confirmation, the Hoot Lens MCP server's normal sign-in reads the data.`,
    input: z.object({
      email: z.string().trim().email().max(254).describe('The email address of the person who owns the website and will confirm. The confirmation link is sent only to this address.'),
      siteOrigin: z.string().trim().min(1).max(300).describe('The site to measure, such as https://www.example.com. Only the origin is used. The scheme is https, except http://localhost for testing on this computer.'),
      projectName: z.string().trim().min(1).max(80).optional().describe('A name for the project. Default: the site\'s host name.'),
      agentName: z.string().trim().min(1).max(60).optional().describe('The agent\'s name as shown to the person in the email, such as Claude Code or Cursor. Letters, numbers and simple punctuation only.'),
      agentVersion: z.string().trim().max(40).optional().describe('The agent\'s version, if known.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, siteOrigin, projectName, agentName, agentVersion }, t) => {
    const body = { email, siteOrigin, ...(projectName ? { projectName } : {}), ...(agentName ? { agent: { name: agentName, ...(agentVersion ? { version: agentVersion } : {}) } } : {}) };
    return out((await t.post('/v1/onboarding/claims', body, { timeoutMs: 20000 })).body);
  });

  tool('check_setup', {
    toolset: 'install', title: 'Check a setup request',
    description: `Checks the status of a setup that was started without an account. Takes the claimId and pollToken from the start response. Returns status "pending" (the person has not opened the confirmation link yet), "confirmed" or "expired". When confirmed it returns the projectId, the dashboard link and an install summary: whether the tag has loaded, whether the first batch of data has arrived, any recent refusals by reason, and the next step. The tag stops until the next page load after a project_pending refusal. When expired, nothing was created. It returns no access token.`,
    input: z.object({
      claimId: z.string().uuid().describe('The claimId returned when the setup started.'),
      pollToken: z.string().regex(/^hl_clp_[A-Za-z0-9_-]{43}$/).describe('The pollToken returned when the setup started. A secret.'),
    }),
    annotations: { ...readOnly, openWorldHint: true },
  }, async ({ claimId, pollToken }, t) => out(await t.get(`/v1/onboarding/claims/${claimId}`, { poll: pollToken })));

  tool('list_recordings', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List recordings',
    description: `Lists recording segments (one per page view) newest first, one page at a time. Returns nextCursor, which the cursor argument accepts for the next page; a page can be shorter than limit when filters skip records. Filters: exact path, page group, language, variant, device class, minimum duration, snag type (signal=rage for pile-ups, dead for no-shows, error for misfires), campaign source or name, referrer origin or host, browser, operating system, new or returning visitor, a start time range in epoch milliseconds, a saved segment (segmentId; filters passed with it replace the segment's own), tag (lower-case words the team added; each recording lists its tags), goal (only page views that converted a goal; each recording lists goalIds) and element (only page views with a click on a data-hoot-id, an element key or a selector). Each recording carries utm, browser, os (families, not versions or raw user agents) and isNewVisitor when the project privacy policy allows them. A recording that left the page through a link carries exitTo: a same-site path, or another site's origin only, with no query or fragment. Automated visits (detected bots, headless browsers and scripted clicking) are left out unless include_automated is true; they carry automated: true and the reasons observed, and a suspected visit carries automation.level suspected but is not left out. Internal visits (made by the site's own team) are left out unless include_internal is true; they carry internal: true. Cohorts for release, revision, variant, route and device class stay separate. Tags in results were written by the project's team.`,
    input: z.object({
      projectId: projectArg,
      cursor: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      ...recordingFilters,
    }),
    annotations: readOnly,
  }, async ({ projectId, ...query }, t) => out(await t.get(`/v1/projects/${projectId}/recordings`, withAutomated(query))));

  tool('list_sessions', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List visits',
    description: `Lists visits (a session in the API: the page views of one person, stitched together by the tracker) newest first, one page at a time, each with a one-line summary, page count, ordered paths, device class, browser and os (families such as chrome and android, when the project privacy policy stored them), and click, pile-up (rage), no-show (dead) and misfire (error) totals. Each visit lists the goals it converted (goals: [{ goalId, name }], under each goal's current definition) and, when its last click left through a link, where it went (exitTo: a same-site path, or another site's origin only; the summary says "Exited to /pricing."). A visit with snags carries topSnag, the element with the most snag clicks in the visit (kind pile-up, no-show or misfire, count, selector, and name, label, context (when it has no label) or interactive: false when known; context and interactive mean the same as on a heatmap element), and its summary ends with it, for example "Most snags: 2 pile-ups on 'Create Workspace'." Visits recorded before topSnag was kept have none. Accepts the same filters as the recording list, including segmentId, include_automated (automated visits are left out by default), include_internal (the site team's own visits are left out by default; they carry internal: true), goal (only visits that converted a goal, by id or name) and element (only visits that clicked a data-hoot-id, an element key or a selector, for example every visit that tapped home-menu-toggle); a visit is listed when any of its page views matches. Returns nextCursor, which the cursor argument accepts for the next page.`,
    input: z.object({
      projectId: projectArg,
      cursor: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      ...recordingFilters,
    }),
    annotations: readOnly,
  }, async ({ projectId, ...query }, t) => out(await t.get(`/v1/projects/${projectId}/sessions`, withAutomated(query))));

  tool('list_segments', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List saved segments',
    description: `Lists the project's saved segments: named sets of recording filters, such as mobile visitors from a campaign. Returns each segment's id, name and filters; the id is accepted as segmentId by the recording and session lists. Segments are set by owners and editors in the dashboard.`,
    input: z.object({ projectId: projectArg }),
    annotations: readOnly,
  }, async ({ projectId }, t) => out(await t.get(`/v1/projects/${projectId}/segments`)));

  tool('get_traffic', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Get traffic',
    description: `Returns where visits come from. Visits over a date range (default the last 30 days; from and to in epoch milliseconds, at most 92 days, UTC day granularity) by referrer origin, campaign source, campaign name, device class, browser, operating system and new versus returning visitor, plus visits per day and each goal's site-wide conversions with a rate and 95% interval. Lists are pairs of [key, sessions], largest first, at most 25 each. A visit is counted once, on its first page view. Visits detected as automated are not counted; automatedSessions and dailyAutomated give how many were left out. With pageGroup (an id from the heatmap cohorts) only visits that viewed that page group are counted, broken down by device class, language and variant; page groups are not mixed. Conversions are not split by referrer or device. Filters on the session list (utmSource, utmCampaign, referrer, browser, os, deviceClass, newVisitor) match the rows here. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      from: z.number().int().min(0).optional().describe('Start of the range, epoch milliseconds'),
      to: z.number().int().min(0).optional().describe('End of the range, epoch milliseconds'),
      pageGroup: z.string().min(1).max(300).optional().describe('A page group id such as /'),
    }),
    annotations: readOnly,
  }, async ({ projectId, pageGroup, ...query }, t) => out(compactTraffic(await t.get(`/v1/projects/${projectId}/traffic`, { ...query, group: pageGroup }) as unknown as TrafficBody)));

  tool('get_session_narrative', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Read a visit narrative',
    description: `Returns a visit as a short, readable story instead of raw events: a one-to-two sentence summary, facts (duration, active time, pages, device, browser, OS, referrer, campaign source, deepest scroll, clicks, pile-ups, no-shows, misfires, exit page, and exitTo when the last click left through a link: a same-site path or another site's origin only, also ended in the summary as "Exited to /pricing.") and up to 60 timed steps (landed, scrolled, clicked, snag, error, navigated, resized, idle, left). When the site records JavaScript errors, a misfire, pile-up or no-show that an error followed says so ("followed by TypeError: x is undefined at src/cart.ts:42"), other errors are steps of their own, and facts counts them. Takes a sessionId for the whole visit, or a recordingId for one page view. Steps describe observed behavior. The response also lists annotations: the tags and notes the project's team added to the visit's page views (offsetMs places a note in the replay); they are free text written by people, not observations. Each step has recordingId and offsetMs, the moment in the replay (watching the replay needs the replay scope). Click and snag steps carry source (a repository-relative path and line such as src/components/Pricing.tsx:42) when the site uses the Hoot Lens build plugin. A step on an element nothing else names reads from its recorded context (tag, region and, outside the strict preset, the nearest heading and its own text), and a snag step on an element that is not a link, button or other control says so ("Pile-up on text that is not a link or button: ...") and carries interactive: false; facts.pileUpsOnNonControls counts those pile-ups. Works with a read-only key, as long as the person who made the key (or signed in) may watch replays on the site; the project's privacy policy decides whether element labels appear, and under the strict preset no page text is included. ${UNTRUSTED}`,
    input: z.object({ projectId: projectArg, sessionId: id.optional(), recordingId: id.optional() })
      .refine(value => (value.sessionId === undefined) !== (value.recordingId === undefined), 'Pass exactly one of sessionId or recordingId'),
    annotations: readOnly,
  }, async ({ projectId, sessionId, recordingId }, t) => {
    const narrative = await t.get(sessionId !== undefined
      ? `/v1/projects/${projectId}/sessions/${sessionId}/narrative`
      : `/v1/projects/${projectId}/recordings/${recordingId}/narrative`);
    // Each page view in the visit can be opened on its own; link the first few.
    const seen = [...new Set(((narrative.steps ?? []) as { recordingId?: string }[]).map(step => step.recordingId).filter((value): value is string => typeof value === 'string'))];
    return out(narrative, seen.slice(0, 8).map(rid => recordingLink(projectId, rid)));
  });

  tool('get_recording', {
    toolset: 'replay', scope: 'replay', scoped: true, title: 'Get raw recording events',
    description: `Returns raw replay events and clicks for one segment, with the asset URLs as recorded from visitors' browsers, and the team's tags and notes on it (notes are free text written by people, with an optional offsetMs into the replay). Needs the replay scope. The response is large. ${UNTRUSTED}`,
    input: z.object({ projectId: projectArg, recordingId: id }),
    annotations: readOnly,
  }, async ({ projectId, recordingId }, t) => {
    // The replay-gated read goes first, so a key without the replay scope is told that, not that the notes were missing.
    const detail = await t.get(`/v1/projects/${projectId}/recordings/${recordingId}`, { assets: 'raw' });
    const annotations = await t.get(`/v1/projects/${projectId}/recordings/${recordingId}/notes`) as { notes: unknown[]; tags: string[] };
    return out({ ...detail, tags: annotations.tags, notes: annotations.notes });
  });

  tool('load_replay', {
    toolset: 'replay', scope: 'replay', scoped: true, title: 'Load a replay for the viewer',
    description: `Returns the recorded events of one page view with its viewport, click kinds and JavaScript errors, for the replay viewer. Asset URLs in the events are first-party links signed for the project, so a viewer loads nothing from a customer address; assetOrigin names the origin those links use. Needs the replay scope. ${UNTRUSTED}`,
    input: z.object({ projectId: projectArg, recordingId: id }),
    annotations: readOnly,
  }, async ({ projectId, recordingId }, t) => {
    const detail = await t.get(`/v1/projects/${projectId}/recordings/${recordingId}`) as { recording?: Obj; events?: unknown[]; errors?: unknown[] };
    const recording = detail.recording ?? {};
    const clicks = Array.isArray(recording.clicks) ? (recording.clicks as { timestamp?: unknown; kind?: unknown }[]).map(click => ({ timestamp: click.timestamp, kind: click.kind })) : [];
    const events = detail.events ?? [];
    return out({
      projectId, ...(options.assetOrigin ? { assetOrigin: options.assetOrigin } : {}),
      recording: { id: recording.id, path: recording.path, deviceClass: recording.deviceClass, viewport: recording.viewport, startedAt: recording.startedAt, endedAt: recording.endedAt, clicks },
      events, errors: detail.errors ?? [],
    }, undefined, `Replay events of recording ${recordingId}: ${events.length} events.`);
  });

  tool('add_note', {
    toolset: 'annotate', scope: 'annotate', scoped: true, title: 'Add a note to a recording',
    description: `Adds a short text note (up to 1,000 characters) to a recording, optionally at a moment in it (offsetMs), shown to the team when they open the replay. Needs a key with the annotate scope; the note is shown as written by an agent with the key's name. A recording holds at most 100 notes. Returns the note with its id.`,
    input: z.object({
      projectId: projectArg,
      recordingId: id.describe('The page view to annotate: the recordingId of one page view'),
      text: z.string().trim().min(1).max(1000).describe('The note, in plain words'),
      offsetMs: z.number().int().min(0).max(86_400_000).optional().describe('Milliseconds from the start of the recording; omit for a note on the whole recording'),
    }),
    annotations: writes,
  }, async ({ projectId, recordingId, ...note }, t) => out((await t.post(`/v1/projects/${projectId}/recordings/${recordingId}/notes`, note)).body, [recordingLink(projectId, recordingId)]));

  tool('review_findings', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Review findings',
    description: `Returns observed click and snag counts for a site. By default (groupBy "revision") they are grouped by page, page revision, variant and device class: the automatic release and page version ids (auto-..., auto-...+2, unversioned) that one version of a page can be spread over are folded into one row, while releases the team named or logged are kept apart. Each row reports how many heatmap cohorts it folds (foldedCohorts), the key of the largest (key) and how many release or page version ids were merged (versionCount). With detail true, a folded row also lists every folded cohort key (cohortKeys, the largest first) and the ids merged (versionIds). groupBy "cohort" returns the fine-grained view, one row per heatmap cohort (page, release or page version id, revision, variant and device class). Historical five-part cohorts have variantScope "pooled" and stay apart from single-variant cohorts; label them as historical pooled totals. Each row lists up to 5 example recordings (recordingId, startedAt and, when known, at: the epoch-millisecond time of the snag). Elements with misfires or pile-ups carry followedBy when a JavaScript error followed clicks on them (id, name, message, location such as src/cart.ts:42, summed across folded cohorts), and errors lists the most widespread errors of the last 14 days. Snags are counts of page behavior and are not a measure of emotion. An element carries a name when the team gave it one in the dashboard, and its selector. An element carries context when the tracker recorded it with the click: tag (such as div, li, p or img), region (the nearest data-hoot-region, data-hoot-id ancestor, or section with an id or aria-label, else the nearest landmark tag) and, under the full and balanced privacy presets only, heading (the nearest h1 to h3 text above it) and text (the element's own text, shortened); the strict preset records tag and region only, and nothing is recorded from private regions or form fields. An element carries interactive: false when the clicked target was not a link, button or other control (a link, button or control role, a tabindex, or a pointer cursor), so a pile-up there is on something that is not a control. Each row counts pileUpsOnNonControls (pile-ups on listed elements with interactive: false), and the response sums them. An element carries a source (a repository-relative path and line such as src/components/Pricing.tsx:42, present when the site uses the Hoot Lens build plugin); it is a repository path, not a URL, and it is the most recent location seen for the element in that cohort. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      groupBy: z.enum(['revision', 'cohort']).optional().describe('revision (default): fold automatic version ids of one page revision, variant and device class; historical pooled cohorts stay separate. cohort: one row per heatmap cohort, with every release and page version id kept apart.'),
      detail: z.boolean().optional().describe('true lists every folded cohort key (cohortKeys) and release or page version id (versionIds) on folded rows. Default false: only their counts (foldedCohorts, versionCount), with key the largest cohort.'),
    }),
    annotations: readOnly,
  }, async ({ projectId, groupBy, detail }, t) => out(await t.get(`/v1/projects/${projectId}/findings`, { groupBy: groupBy ?? 'revision', ...(detail ? { detail: 'true' } : {}) })));

  tool('explain_snags', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Explain snags',
    description: `Explains the snags (pile-ups, no-shows and misfires) for one heatmap cohort, or for one element in it. Returns a short explanation with the evidence counts, possible causes, changes to try and what to check in recordings, plus the exact aggregated summary that was sent to OpenAI to write it. Only aggregated counts leave Hoot Lens: no recordings, page text or visitor identifiers. Refused with 403 unless the project owner turned on AI explanations in Settings. Falls back to rule-based text if the model is unavailable (status "fallback"). Results are cached per summary and rate limited. Generated explanations use the account's current monthly allowance; saved results are not counted. When the allowance is used, the response reports that state and a valid reset date when available; saved results remain available. The explanation is generated text that describes page behavior and can be wrong; it does not establish emotion or a certain cause. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      cohortKey: z.string().min(1).max(2000).describe('The cohort key exactly as heatmaps and findings return it'),
      selector: z.string().min(1).max(300).optional().describe('A selector, as heatmaps and findings list it, to explain one element; omit to explain the page group'),
    }),
    // Generation uses account allowance; an expired or unsaved cache can charge a retry again.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async ({ projectId, cohortKey, selector }, t) => {
    // Explanations can take longer than a read. Only the known allowance code is a non-error state.
    const answer = await t.post(`/v1/projects/${projectId}/explanations`, { cohortKey, ...(selector ? { selector } : {}) }, { timeoutMs: 45000, accept: [402] });
    if (answer.status === 402 && answer.body.code === 'ai_allowance') {
      const resetsAt = answer.body.resetsAt;
      const resetDate = typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt) && resetsAt > 0 && resetsAt <= 8_640_000_000_000_000
        ? new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(resetsAt))
        : undefined;
      const message = `The current AI explanation allowance is used.${resetDate ? ` It resets on ${resetDate}.` : ''} Saved results remain available.`;
      return out({ status: 'allowance_used', message }, undefined, message);
    }
    if (answer.status === 402) throw new ToolError('Hoot Lens refused explanation generation (402). This response is not an AI allowance notification.', 'api_error', 402);
    return out(answer.body);
  });

  tool('list_heatmaps', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List heatmap cohorts',
    description: `Lists heatmap cohorts with visit, segment and click counts, most recently active first. Each new six-part cohort key identifies one page group, release, revision, variant and device class. Historical five-part keys remain readable and have variantScope "pooled"; their counts and cells pool variants and cannot be used as variant-specific evidence. Select a returned key with variantScope "single" and the requested variant for a variant-specific map. versionLabel names the cohort's version by when it was live (UTC), such as "Current version (since Oct 5, 3:12 PM)" or "Earlier version (Sep 29 to Oct 5)"; the key itself holds internal release and page version ids.`,
    input: z.object({ projectId: projectArg }),
    annotations: readOnly,
  }, async ({ projectId }, t) => {
    const list = await t.get(`/v1/projects/${projectId}/heatmaps`) as { cohorts?: Parameters<typeof labelVersions>[0] };
    const changes = await t.get(`/v1/projects/${projectId}/changes`, { limit: 200 }).catch(() => ({ changes: [] })) as { changes?: Parameters<typeof labelVersions>[1] };
    // Each cohort also gets a readable name for its version (when it was live), so a person is never pointed at an internal id.
    const labels = labelVersions(list.cohorts ?? [], changes.changes ?? [], { locale: 'en-US', timeZone: 'UTC' });
    return out({ ...list, cohorts: (list.cohorts ?? []).map(cohort => ({ ...cohort, versionLabel: labels.get(cohort.key)?.label })) });
  });

  tool('get_heatmap', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Get a heatmap',
    description: `Returns one exact heatmap cohort. New six-part keys select one variant; historical five-part keys return variantScope "pooled" and unsplittable totals across variants. Includes most-clicked elements by selector with pile-up (rage), no-show (dead) and misfire (error) counts, scroll depth shares per 10% band, typical document size, and the densest click grid cells ([column, row, count] with cellSize CSS pixels) and the densest pointer dwell cells ([column, row, weight], in moves; both lists carry truncatedFrom when cut to maxCells). An element carries a name when the team gave it one in the dashboard, and its selector. An element carries context when the tracker recorded it with the click: tag (such as div, li, p or img), region (the nearest data-hoot-region, data-hoot-id ancestor, or section with an id or aria-label, else the nearest landmark tag) and, under the full and balanced privacy presets only, heading (the nearest h1 to h3 text above it) and text (the element's own text, shortened); the strict preset records tag and region only, and nothing is recorded from private regions or form fields. An element carries interactive: false when the clicked target was not a link, button or other control (a link, button or control role, a tabindex, or a pointer cursor), so a pile-up there is on something that is not a control. An element carries a source (a repository-relative path and line such as src/components/Pricing.tsx:42, present when the site uses the Hoot Lens build plugin); it is a repository path, not a URL, and it is the most recent location seen for the element in that cohort. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      key: z.string().min(1).max(2000).describe('The cohort key exactly as the heatmap cohort list returns it'),
      maxCells: z.number().int().min(0).max(20000).optional().describe(`Densest grid cells to return, default ${DEFAULT_AGENT_CELLS}. Omit or use a positive value for a visual click map. 0 returns the element and scroll summaries without click density.`),
    }),
    annotations: readOnly,
  }, async ({ projectId, key, maxCells }, t) => {
    const aggregate = await t.get(`/v1/projects/${projectId}/heatmaps/${encodeURIComponent(key)}`) as { grid?: { cellSize: number; cells: unknown[] }; moves?: { cellSize: number; cells: unknown[] } };
    const limit = maxCells ?? DEFAULT_AGENT_CELLS;
    // Both grids arrive densest first; the pointer dwell grid can hold thousands of cells, so it is cut the same way.
    const cut = <G extends { cells: unknown[] }>(grid: G): G => (grid.cells.length > limit ? { ...grid, cells: grid.cells.slice(0, limit), truncatedFrom: grid.cells.length } : grid);
    return out({ key, ...aggregate, ...(aggregate.grid ? { grid: cut(aggregate.grid) } : {}), ...(aggregate.moves ? { moves: cut(aggregate.moves) } : {}) }, [heatmapLink(projectId, key)]);
  });

  tool('list_changes', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List logged changes',
    description: `Lists logged changes (change markers), newest first: what changed, when, and for which page group. Includes changes logged through the API by agents, changes the owner logged, and changes Hoot Lens detected automatically when a page's content changed (source starts with "auto:"). Each has an id. pageGroup also returns site-wide changes.`,
    input: z.object({
      projectId: projectArg,
      pageGroup: z.string().min(1).max(300).optional().describe('A page group id or name, or a path such as /pricing'),
      from: z.number().int().min(0).optional().describe('Earliest change time, epoch milliseconds'),
      to: z.number().int().min(0).optional().describe('Latest change time, epoch milliseconds'),
    }),
    annotations: readOnly,
  }, async ({ projectId, ...query }, t) => out(await t.get(`/v1/projects/${projectId}/changes`, query)));

  tool('log_change', {
    toolset: 'annotate', scope: 'annotate', scoped: true, title: 'Log a change',
    description: `Logs a change shipped to the site as a change marker, with the page group it affects and a short description of what changed (for example "Shortened the hero headline and moved Request an appointment above the fold"), so the days before and after it can be compared. Needs a key with the annotate scope; the marker is recorded as made by an agent. Returns the marker with its id. Kind "measurement" marks a change that only changes how counting works and nothing visitors see or do, such as adding data-hoot-id to existing links or renaming a goal's element: its impact report gives no verdict and notes that a jump in a goal or count reflects new counting, not visitor behavior. Other changes use the default kind.`,
    input: z.object({
      projectId: projectArg,
      title: z.string().trim().min(1).max(120).describe('Short name of the change'),
      note: z.string().trim().min(1).max(1000).optional().describe('A plain-words description of what changed and why.'),
      pageGroup: z.string().trim().min(1).max(300).optional().describe('Page group id or name from heatmap cohorts or Settings, or a path such as /pricing. Omit for a site-wide change.'),
      release: z.string().trim().min(1).max(100).optional().describe('Site release or commit the change shipped in'),
      at: z.number().int().positive().optional().describe('When it went live, epoch milliseconds. Defaults to now.'),
      kind: z.enum(['standard', 'measurement']).optional().describe('measurement: the change only changes counting (for example adding data-hoot-id to existing links), not what visitors see or do. Default standard.'),
    }),
    annotations: writes,
  }, async ({ projectId, ...change }, t) => out((await t.post(`/v1/projects/${projectId}/changes`, { source: 'mcp', ...change })).body));

  tool('change_impact', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Did the change help?',
    description: `Compares the days before and after one logged change (default 14 days each side, or back to the previous change), per page group, and returns a one-sentence summary plus the numbers: visits on each side, each goal's conversion rate (visits converting over visits) with a 95% Wilson interval, the difference and a verdict of "Too few visits to tell", "No clear change" or a rise or fall marked "likely real" or "could be chance"; snags per 100 visits; the share of page views that reached half the page; and the elements whose share of clicks moved most. This is a before and after comparison, not an A/B test, and it does not establish that the change caused the difference. deviceClass and locale filters compare like with like. A change logged with kind "measurement" (it only changed how counting works) gets measurementOnly: true and the verdict "counting-changed" for its goals instead of a rise or fall, because the numbers moved when counting changed. changeId identifies a logged change. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      changeId: id,
      days: z.number().int().min(1).max(45).optional().describe('Days each side runs at most, default 14'),
      deviceClass: z.enum(['desktop', 'tablet', 'mobile']).optional(),
      locale: z.string().regex(/^[a-z]{2,3}$/).optional().describe('Primary language such as es'),
    }),
    annotations: readOnly,
  }, async ({ projectId, changeId, ...query }, t) => {
    const report = await t.get(`/v1/projects/${projectId}/changes/${changeId}/impact`, query) as { summary?: string };
    return out({ summary: report.summary, ...report });
  });

  tool('list_goals', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List goals',
    description: `Lists the project's goals: what counts as a conversion (a click on a matching element, or a visit to a matching page). Impact reports include a conversion rate for each goal. Goals are set by the owner in Settings.`,
    input: z.object({ projectId: projectArg }),
    annotations: readOnly,
  }, async ({ projectId }, t) => out(await t.get(`/v1/projects/${projectId}/goals`)));

  tool('list_funnels', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List funnels',
    description: `Lists the project's funnels: named, ordered sequences of 2 to 8 goals, such as visit the homepage, click Request an appointment, reach the appointment page. Returns each funnel's id, name and steps (goal ids). When the site has goals but no funnels, the response also has suggestions: starter funnels (homepage to each goal, or all goals in the order visits usually reach them), each with a change in the settings-change format. Funnels are set by the owner in the dashboard.`,
    input: z.object({ projectId: projectArg }),
    annotations: readOnly,
  }, async ({ projectId }, t) => out(await t.get(`/v1/projects/${projectId}/funnels`)));

  tool('get_funnel', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Get funnel drop-off',
    description: `Returns, for one funnel, how many visits reached each step (a visit reaches a step only after reaching the steps before it, in order), the share of the previous step and of step 1 that continued with a 95% Wilson interval, and for every step but the last the number of visits that did not continue plus up to 5 example sessionIds. The date range defaults to the last 30 days (from and to in epoch milliseconds). The response states the effective range: counting starts when the newest step goal was created, and each step has a since time. Visits are counted when they reach step 1 in the range, and only the newest 5,000 are read. Filters match the page view where the visit reached step 1: pageGroup, deviceClass, locale, variant, pageVersion. funnelId identifies one funnel. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      funnelId: id,
      from: z.number().int().min(0).optional().describe('Start of the range, epoch milliseconds'),
      to: z.number().int().min(0).optional().describe('End of the range, epoch milliseconds'),
      pageGroup: z.string().min(1).max(300).optional().describe('A page group id as listed in heatmap cohorts, such as /'),
      deviceClass: z.enum(['desktop', 'tablet', 'mobile']).optional(),
      locale: z.string().regex(/^[a-z]{2,3}$/).optional().describe('Primary language such as es'),
      variant: z.string().min(1).max(100).optional(),
      pageVersion: z.string().min(1).max(100).optional(),
    }),
    annotations: readOnly,
  }, async ({ projectId, funnelId, ...query }, t) => out(await t.get(`/v1/projects/${projectId}/funnels/${funnelId}/stats`, query)));

  tool('weekly_summary', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Weekly summary',
    description: `Returns the same content as the project's weekly digest email as structured data, for the seven complete UTC days ending yesterday (or ending on weekEnding, or on today so far with includeToday) against the seven before: visits (automated visits are left out and their share is noted, with a plain note when there are few visits), the elements whose snags (pile-ups, no-shows or misfires) changed most with this week's and last week's counts and up to two example recordingIds each (viewing recordings needs the replay scope), where visits came from (sources: the top channels and countries, the visits in smaller ones, and the visits not recorded, because channels and countries are counted only from 2026-10-07 and the lists add up to the visit count), each goal's conversions with last week's rate and a "few visits" flag, the changes logged in the week and any "Did it help?" verdicts that became available (quoted from the impact report), a funnel drop-off headline for each of up to two funnels, and one item worth watching. When the site has goals but no funnels the response also has suggestions.funnels (starter funnels, each with a settings change). Every number is observed and aggregated; under the strict privacy preset element names come from page identifiers and not page text. Week-over-week differences are counts, not significance verdicts or causes. A week with no recorded visits returns noData true. Needs the read scope. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      weekEnding: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Last day of the 7-day window, YYYY-MM-DD (UTC), a complete day before today. Defaults to yesterday.'),
      includeToday: z.boolean().optional().describe('End the window on today, a UTC day still in progress, so a project that started recently or a busy day is counted. Not with weekEnding. Without it, visits so far today are only noted (visits.afterWindow).'),
    }),
    annotations: readOnly,
  }, async ({ projectId, weekEnding, includeToday }, t) => out(await t.get(`/v1/projects/${projectId}/weekly-summary`, { weekEnding, includeToday })));

  tool('suggest_pages_to_record', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Suggest pages to record',
    description: `Finds pages that visitors reach from recorded pages but that Hoot Lens does not record. Reads the link targets of recent link clicks on recorded pages (from their replays, over the last 14 days, at most 30 recordings) and lists the in-site pages that no targeting rule records, with the clicks and visits that went there, the recorded pages the links were on and a settings change that starts recording each one (applying it needs the configure scope and the site owner). Only links with a known destination count: the strict privacy preset keeps no link targets, so nothing is suggested there, and exits that are not link clicks (typed addresses, the back button, script navigation) are not counted. A site that records every page has nothing to suggest except pages an exclude rule keeps out. Needs the read scope. ${UNTRUSTED}`,
    input: z.object({ projectId: projectArg }),
    annotations: readOnly,
  }, async ({ projectId }, t) => out(await t.get(`/v1/projects/${projectId}/page-suggestions`)));

  /* ----------------------------------------------------- site settings (configure) */

  tool('get_site_settings', {
    toolset: 'configure', scope: 'configure', scoped: true, title: 'Get site settings',
    description: `Reads the settings that a settings change can alter: which pages are recorded (include and exclude rules), the privacy preset with its masks, blocked regions, unmasked inputs and query string setting, per-path privacy presets (such as safe-form), goals and funnels, and which of those areas this credential can change (canChange: owners all five areas, editors goals and funnels only). Needs the configure scope.`,
    input: z.object({ projectId: projectArg }),
    annotations: readOnly,
  }, async ({ projectId }, t) => out(await t.get(`/v1/projects/${projectId}/settings`)));

  tool('preview_settings_change', {
    toolset: 'configure', scope: 'configure', scoped: true, title: 'Preview a settings change',
    description: `Previews a change to the site's Hoot Lens setup without making it. Returns the exact diff (one sentence per change), the effects from the site's own data (for example which recorded pages would stop being recorded, or how many visits a page goal would have matched last week), warnings, and a change token valid for 10 minutes. Nothing is changed. Settings changes are two steps: a preview returns a change token, and applying that token commits the change. Agent credentials can make capture stricter or add things to measure, not looser: removing a mask or block selector, unmasking an input, keeping query strings, moving to a less strict privacy preset and removing or loosening a path preset are refused (403, privacy_weakening_refused). Areas: targeting (addInclude, removeInclude, addExclude, removeExclude: page path globs such as /champions or /blog/*; with no include rule every page is recorded, and adding one narrows capture to the listed pages, which the warnings state), goals (add, update by id, remove by id; click goals match by selector, hootId or label, page goals match a path glob), funnels (add with 2 to 8 steps, each a goal id or exact goal name, including a goal added in the same change; remove by id), privacy (stricter only: preset, addMaskTextSelectors, addBlockSelectors, removeUnmaskInputSelectors, captureQueryStrings false) and pathPresets (set: [{match, preset}] where preset is safe-form, balanced or strict; safe-form records clicks and steps on application and contact forms but no field values, even when the site preset is full, and ignores the site's unmasked-input allowlist and query strings there). Owners can change every area; editors can change goals and funnels. Needs the configure scope.`,
    input: z.object({ projectId: projectArg, changes: settingsChangeSchema.describe('The settings areas to change; areas left out are unchanged.') }),
    annotations: readOnly,
  }, async ({ projectId, changes }, t) => {
    const body = (await t.post(`/v1/projects/${projectId}/settings-changes/preview`, { changes })).body;
    return out(body, undefined, body.changed === false ? String(body.message ?? 'Nothing would change.') : undefined);
  });

  tool('apply_settings_change', {
    toolset: 'configure', scope: 'configure', scoped: true, title: 'Apply a previewed settings change',
    description: `Applies the settings change that a preview token holds, and nothing else: the token holds the exact change. It is refused (409, settings_changed) if the site's settings changed since the preview, or (410, preview_expired) after 10 minutes. The change is logged in the site's access log as made by this agent. Agent credentials can make capture stricter or add things to measure, not looser: removing a mask or block selector, unmasking an input, keeping query strings, moving to a less strict privacy preset and removing or loosening a path preset are refused (403, privacy_weakening_refused). Pages and masks take effect for visitors within about 90 seconds. Needs the configure scope.`,
    input: z.object({ projectId: projectArg, token: z.string().min(16).max(12000).describe('The change token returned by the preview, unchanged') }),
    // Replaces and removes settings (rules, goals, funnels), so clients may ask before running it. It never loosens privacy.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ projectId, token }, t) => out((await t.post(`/v1/projects/${projectId}/settings-changes/apply`, { token })).body));

  tool('list_errors', {
    toolset: 'read', scope: 'read', scoped: true, title: 'List JavaScript errors',
    description: `Lists the JavaScript errors the site's pages threw (an uncaught error or an unhandled promise rejection), grouped by fingerprint (error name, normalized message and top stack frame), most affected first. Each has the error as "TypeError: message" (under the strict privacy preset only the name, because the message is not recorded), where it was thrown (at: the original source file and line such as src/cart/total.ts:42 when a source map for that release was uploaded with "hootlens sourcemaps upload", else the script file with line and column), how many page views and visits it hit, first and last seen, and the releases, page groups and device classes it appeared in, each counted separately. followedClicks names the elements whose click the error came right after (within 2 seconds); a misfire is such a click. examples (needs the replay scope) are recordings with offsetMs at the moment of the error. Filters: pageGroup, release (the build id the site reports), deviceClass and from/to (epoch milliseconds, default the last 30 days). recording false means the site has not turned error recording on in Settings. errorId identifies a group for the full stack and cohorts. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      pageGroup: z.string().min(1).max(300).optional().describe('A page group id as listed in heatmap cohorts, such as /'),
      release: z.string().min(1).max(100).optional().describe('The release (build id) the errors happened under'),
      deviceClass: z.enum(['desktop', 'tablet', 'mobile']).optional(),
      from: z.number().int().min(0).optional().describe('Start of the range, epoch milliseconds'),
      to: z.number().int().min(0).optional().describe('End of the range, epoch milliseconds'),
      limit: z.number().int().min(1).max(100).optional().describe('Error groups to return, default 25'),
    }),
    annotations: readOnly,
  }, async ({ projectId, pageGroup, ...query }, t) => {
    const list = await t.get(`/v1/projects/${projectId}/errors`, { ...query, group: pageGroup }) as unknown as ErrorListBody;
    return out(compactErrors(list), recordingLinksOf(projectId, list.errors));
  });

  tool('get_error', {
    toolset: 'read', scope: 'read', scoped: true, title: 'Get a JavaScript error',
    description: `Returns one JavaScript error group (errorId is its id): the error and where it was thrown, the stack with resolved frames first (original source file, line and function; with a few lines of the source around each frame, only when the uploaded source maps embed the source), the elements whose click it followed, the cohorts it appeared in (page group, release, page revision, variant and device class together, each with counts and last seen) and, with the replay scope, example recordings with offsetMs at the moment of the error. mapped reports whether any frame was resolved through a source map; frames resolve to original file and line when the release's maps were uploaded with "hootlens sourcemaps upload --release <id> <dir>". Under the strict privacy preset the message is not recorded, only its hash. Source paths are relative, not absolute. ${UNTRUSTED}`,
    input: z.object({
      projectId: projectArg,
      errorId: z.string().regex(/^[0-9a-f]{16}$/).describe('The id of an error group'),
      from: z.number().int().min(0).optional().describe('Start of the range, epoch milliseconds, default the last 30 days'),
      to: z.number().int().min(0).optional().describe('End of the range, epoch milliseconds'),
    }),
    annotations: readOnly,
  }, async ({ projectId, errorId, ...query }, t) => {
    const detail = await t.get(`/v1/projects/${projectId}/errors/${errorId}`, query) as unknown as ErrorDetailBody;
    return out(compactErrorDetail(detail), recordingLinksOf(projectId, [detail]));
  });

  /* ------------------------------------------------------------- issues and feedback */

  tool('submit_issue', {
    toolset: 'feedback', title: 'Report an issue to Hoot Lens',
    description: `Files a bug report, feature request, question or feedback with the Hoot Lens team. Works with any access key; the issue belongs to the key's creator, who sees it in the dashboard under Feedback, and only they and staff can see it. It is marked as filed by an agent, with this key's name. The body holds what happened and what was expected. Optional: severity (blocking, annoying or minor: how much it hurts, as judged by the reporter, not a staff priority); projectId (a site the key can read) with context evidence, each checked to exist on that site: recordingIds and sessionIds (up to 10 visits each; needs a key with the replay scope), cohortKey (a heatmap cohort key), elementKey (an element selector as the heatmap lists it), selector or hootId, changeId, goalId, funnelId, errorId, sourceLocation (path:line); also pageUrl (no query or fragment), trackerVersion and route; relatedIssues (up to 10 ids or numbers of issues visible to the key); screenshots (up to ${MAX_SHOTS} PNG, JPEG or WebP images as base64, at most 2 MB each, metadata is removed; the hosted connector accepts a whole request of only 512 KB, so large images need the local server or the dashboard). A retry with the same idempotencyKey does not file the issue twice. Limits: 40 issues an hour counting everything the creator files, 100 open at once. ${ISSUE_UNTRUSTED}`,
    input: z.object({ ...issueFields, idempotencyKey: idempotencyKeyArg, screenshots: screenshotsArg }),
    annotations: writes,
  }, async ({ idempotencyKey, screenshots, ...issue }, t) => {
    const created = await t.issue('POST', '/v1/issues', { body: issue, headers: { 'Idempotency-Key': idempotencyKey ?? randomUUID() } });
    const filed = created.issue as { id?: string } | undefined;
    if (!screenshots?.length || !filed?.id) return out(created);
    const result = await uploadScreenshots(t, filed.id, screenshots);
    return out({ ...created, screenshots: result.attached, ...(result.errors.length ? { screenshotErrors: result.errors } : {}) });
  });

  tool('submit_issues', {
    toolset: 'feedback', title: 'Report several issues to Hoot Lens',
    description: `Files up to ${BATCH_MAX} issues in one request. Each item takes the same fields as a single issue (kind, title, body, severity, projectId, context, relatedIssues, screenshots) and its own idempotencyKey, and gets its own number, status and replies. Items are filed in order and one failed item does not block the others: the result lists, for each item by index, created, replayed (a retry of an item already filed) or failed with the reason. A stable idempotencyKey per item (for example a short slug) means a retry of the whole request does not file an issue twice. A batch counts once per issue against the same limits as a single issue (40 an hour, 100 open at once). Screenshots are uploaded after the issues are filed, and a failed upload does not undo an issue. ${ISSUE_UNTRUSTED}`,
    input: z.object({ issues: z.array(z.object({ ...issueFields, idempotencyKey: idempotencyKeyArg, screenshots: screenshotsArg })).min(1).max(BATCH_MAX) }),
    annotations: writes,
  }, async ({ issues }, t) => {
    const batch = await t.issue('POST', '/v1/issues/batch', { body: { issues: issues.map(({ screenshots: _shots, idempotencyKey, ...issue }) => ({ ...issue, idempotencyKey: idempotencyKey ?? randomUUID() })) } });
    const results = (batch.results as { index: number; status: string; issue?: { id?: string } }[] | undefined) ?? [];
    const screenshotErrors: { index: number; errors: { index: number; message: string }[] }[] = [];
    for (const result of results) {
      const shots = issues[result.index]?.screenshots;
      if (!shots?.length || !result.issue?.id || result.status === 'failed') continue;
      const uploaded = await uploadScreenshots(t, result.issue.id, shots);
      if (uploaded.errors.length) screenshotErrors.push({ index: result.index, errors: uploaded.errors });
    }
    return out({ ...batch, ...(screenshotErrors.length ? { screenshotErrors } : {}) });
  });

  tool('find_similar_issues', {
    toolset: 'feedback', title: 'Find similar issues before filing',
    description: `Finds likely duplicates of an issue before it is filed. Takes the title (and optionally projectId and matching context) and returns up to 10 issues the key's creator can already see that look alike, each with a score from 0 to 1 and the reasons in plain words: shared title words, the same element, the same page or dashboard view, or the same heatmap, change, goal, funnel or visit. Matching is simple and explainable (normalized title words plus shared ids), not a search engine. Staff keys compare against the whole queue; every other key compares only against issues its creator reported, so other people's issues are not revealed. Nothing is filed. Limit: 60 checks an hour. ${ISSUE_UNTRUSTED}`,
    input: z.object({
      title: z.string().min(1).max(140),
      projectId: id.optional(),
      context: issueContextArg.omit({ trackerVersion: true }).optional(),
      limit: z.number().int().min(1).max(10).optional().describe('Matches to return, default 5'),
    }),
    annotations: { ...readOnly, idempotentHint: true },
  }, async (args, t) => out(await t.issue('POST', '/v1/issues/similar', { body: args })));

  tool('list_my_issues', {
    toolset: 'feedback', title: 'List my reported issues',
    description: `Lists the issues this key's creator reported, newest activity first, without their text. Filters: status (open, in_progress, completed, wont_do) and kind. Returns nextCursor, which the cursor argument accepts for more. ${ISSUE_UNTRUSTED}`,
    input: z.object({
      status: z.array(z.enum(['open', 'in_progress', 'completed', 'wont_do'])).max(4).optional(),
      kind: z.array(z.enum(['bug', 'feature', 'question', 'feedback'])).max(4).optional(),
      projectId: id.optional(),
      cursor: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    annotations: readOnly,
  }, async ({ status, kind, ...rest }, t) => out(await t.issue('GET', '/v1/issues', {
    query: { ...rest, mine: true, ...(status?.length ? { status: status.join(',') } : {}), ...(kind?.length ? { kind: kind.join(',') } : {}) },
  })));

  tool('get_issue', {
    toolset: 'feedback', title: 'Read an issue',
    description: `Returns one issue with its replies and status history, plus what it carries: severity, evidence in context (linked visits, heatmap, element, change, goal, funnel), relatedIssues (only ones the key can see), attachments (screenshot ids), and filedVia with the client name when an agent filed it. The creator of the key sees their own issue and its public replies; staff (triage keys) also see internal notes, the assignee, labels and priority. Other people's issues are not found. ${ISSUE_UNTRUSTED}`,
    input: z.object({ issueId: issueRef }),
    annotations: readOnly,
  }, async ({ issueId }, t) => out(await t.issue('GET', issuePath(issueId))));

  tool('reply_issue', {
    toolset: 'feedback', title: 'Reply to an issue',
    description: `Adds a reply to an issue the key can see. A reply from the person who reported it is shown to staff; a reply from staff is shown to the submitter. With internal set, a staff-only note is added that the submitter cannot see (needs a triage key). A reply on a completed issue does not reopen it; a status change does. Limit: 60 replies an hour. ${ISSUE_UNTRUSTED}`,
    input: z.object({ issueId: issueRef, body: z.string().min(1).max(10_000).describe('Markdown text'), internal: z.boolean().optional().describe('Staff-only note, hidden from the submitter') }),
    annotations: writes,
  }, async ({ issueId, ...reply }, t) => out(await t.issue('POST', `${issuePath(issueId)}/replies`, { body: reply })));

  tool('triage_queue', {
    toolset: 'issues', title: 'Staff triage queue',
    description: `Returns the staff triage queue, compact: issues needing attention first (new with no staff reply, or whose newest reply is from the submitter), then the other open and in-progress issues. Each item has number, kind, status, title, severity (set by the reporter), priority, labels, assignee, replies, updatedAt and whether an agent filed it (filedVia agent, with the client name). Filters: kind, status, projectId, label, assignee (a user id, me, or none), severity or filedVia (person or agent). ${STAFF_ONLY} ${ISSUE_UNTRUSTED}`,
    input: z.object({
      limit: z.number().int().min(1).max(50).optional().describe('Items to return, default 20'),
      kind: z.array(z.enum(['bug', 'feature', 'question', 'feedback'])).max(4).optional(),
      status: z.array(z.enum(['open', 'in_progress', 'completed', 'wont_do'])).max(4).optional(),
      projectId: id.optional(),
      label: z.string().max(32).optional(),
      assignee: z.string().max(200).optional(),
      severity: z.enum(['blocking', 'annoying', 'minor']).optional().describe('What the reporter said'),
      filedVia: z.enum(['person', 'agent']).optional().describe('Filed by a person in the dashboard, or by an agent through an access key or OAuth'),
    }),
    annotations: readOnly,
  }, async ({ limit = 20, kind, status, ...filters }, t) => {
    const common = { ...filters, ...(kind?.length ? { kind: kind.join(',') } : {}) };
    const attention = await t.issue('GET', '/v1/issues', { query: { ...common, needsAttention: true, ...(status?.length ? { status: status.join(',') } : {}), limit } }) as unknown as { issues: QueueIssue[]; nextCursor?: string };
    const rest = attention.issues.length < limit
      ? await t.issue('GET', '/v1/issues', { query: { ...common, needsAttention: false, status: status?.length ? status.join(',') : 'open,in_progress', limit: limit - attention.issues.length } }) as unknown as { issues: QueueIssue[] }
      : { issues: [] };
    return out({ issues: [...attention.issues, ...rest.issues].map(compact), moreNeedingAttention: attention.nextCursor !== undefined });
  });

  tool('issue_feed', {
    toolset: 'issues', title: 'Staff issue feed',
    description: `Returns the staff feed of what changed on issues, oldest first: created, replied (public or internal), status and updated events, each with a cursor. The since argument takes the last cursor processed (or now for a first request that ignores history) and returns only newer activity; each event names the issue number. Events carry titles but no bodies, and are kept for 30 days. ${STAFF_ONLY} ${ISSUE_UNTRUSTED}`,
    input: z.object({ since: z.string().max(60).optional().describe('A cursor from an earlier response, now, or epoch milliseconds'), limit: z.number().int().min(1).max(100).optional() }),
    annotations: readOnly,
  }, async (query, t) => out(await t.issue('GET', '/v1/issues/feed', { query })));

  tool('claim_issue', {
    toolset: 'issues', title: 'Claim an issue',
    description: `Claims an open issue for the key's owner: open becomes in_progress with that owner as the assignee, atomically. If someone else holds it the response is a 409 naming them. Claiming an issue the same owner already holds changes nothing. A claim is released with a status change to open. ${STAFF_ONLY} ${ISSUE_UNTRUSTED}`,
    input: z.object({ issueId: issueRef, ifUpdatedAt: z.number().int().min(0).optional().describe('The updatedAt value last seen; a mismatch is a 409') }),
    annotations: writes,
  }, async ({ issueId, ...body }, t) => out(await t.issue('POST', `${issuePath(issueId)}/claim`, { body })));

  tool('set_issue_status', {
    toolset: 'issues', title: 'Set an issue status',
    description: `Changes an issue's status. completed takes a reason that says what was done (such as a pull request reference); the submitter sees it. wont_do is for feature requests only and takes a reason the submitter reads. open from in_progress releases the claim. open from completed or wont_do reopens. in_progress claims. A claim held by someone else gives 409. ${STAFF_ONLY} ${ISSUE_UNTRUSTED}`,
    input: z.object({
      issueId: issueRef,
      status: z.enum(['open', 'in_progress', 'completed', 'wont_do']),
      reason: z.string().min(1).max(2000).optional(),
      ifUpdatedAt: z.number().int().min(0).optional(),
    }),
    annotations: writes,
  }, async ({ issueId, ...body }, t) => out(await t.issue('POST', `${issuePath(issueId)}/status`, { body })));

  tool('get_issue_screenshot', {
    toolset: 'feedback', title: 'View an issue screenshot',
    description: `Returns one screenshot attached to an issue, as an image. The attachment id is listed in the issue's attachments. Only the creator of the key and staff can read an issue's screenshots; for anyone else the issue is not found. A screenshot is content supplied by a person. ${ISSUE_UNTRUSTED}`,
    input: z.object({ issueId: issueRef, attachmentId: z.string().regex(/^[a-f0-9]{32}$/).describe('The attachment id listed in the issue\'s attachments') }),
    annotations: readOnly,
  }, async ({ issueId, attachmentId }, t) => {
    const found = await t.issue('GET', `${issuePath(issueId)}/attachments/${attachmentId}`, { query: { encoding: 'base64' } }) as { attachment: Record<string, unknown>; data: string };
    return { value: { attachment: found.attachment }, images: [{ data: found.data, mimeType: String(found.attachment.contentType) }] };
  });

  tool('update_issue', {
    toolset: 'issues', title: 'Update issue triage fields',
    description: `Updates the staff triage fields of an issue: labels (up to 10, lowercase), priority (low, normal, high, urgent, or null to clear), duplicateOf (the id or number of the original, or null to clear) and a corrected kind. ${STAFF_ONLY} ${ISSUE_UNTRUSTED}`,
    input: z.object({
      issueId: issueRef,
      labels: z.array(z.string().min(1).max(32)).max(10).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable().optional(),
      duplicateOf: issueRef.nullable().optional(),
      kind: z.enum(['bug', 'feature', 'question', 'feedback']).optional(),
      ifUpdatedAt: z.number().int().min(0).optional(),
    }),
    annotations: writes,
  }, async ({ issueId, duplicateOf, ...body }, t) => out(await t.issue('PATCH', issuePath(issueId), { body: { ...body, ...(duplicateOf !== undefined ? { duplicateOf: duplicateOf === null ? null : String(duplicateOf) } : {}) } })));

}
