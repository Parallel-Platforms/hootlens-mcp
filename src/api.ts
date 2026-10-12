import { DASHBOARD_ACCESS_PAGE, ToolError, grantAdvice, rateLimitMessage, retrySeconds, unknownProjectMessage, type ProjectBrief } from './errors.js';

/** The part of a response the tools read. */
export interface ApiResponse { ok: boolean; status: number; json(): Promise<unknown>; /** A response header, when the transport can read headers. */ header?(name: string): string | null }
/** Sends one request to the Hoot Lens API as the caller. `path` includes the query string; the transport adds the credential. */
export type ApiFetch = (path: string, init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number }) => Promise<ApiResponse>;

/** Where the server is running, which decides how a person fixes a rejected credential. */
export type Surface = 'stdio' | 'hosted';

/** What a request is for, so a failure can say which scope or project was the problem. */
export interface RequestContext {
  tool: string;
  /** The project scope the route needs. */
  scope?: 'read' | 'replay' | 'annotate' | 'configure' | 'sites:create';
  projectId?: string;
}

export type Query = Record<string, string | number | boolean | undefined>;
export interface RequestOptions { query?: Query; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; context: RequestContext; /** Statuses to return to the caller instead of raising. */ accept?: number[] }

interface ErrorBody { error?: unknown; code?: unknown; assignee?: unknown }

const STAFF_ONLY = 'This tool needs a triage key (a key with the triage scope made by Hoot Lens staff).';

export class Api {
  constructor(private readonly call: ApiFetch, readonly surface: Surface, readonly pinned?: string) {}

  private url(path: string, query: Query = {}) {
    const url = new URL(path, 'http://hootlens.invalid');
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return `${url.pathname}${url.search}`;
  }

  /** How a person replaces a credential that was refused. */
  private reconnectAdvice() {
    return this.surface === 'hosted'
      ? 'Reconnect the Hoot Lens connector to sign in again.'
      : `Run "npx -y @hootlens/mcp login" to sign in again, or set HOOTLENS_PAT to a current access key (dashboard, ${DASHBOARD_ACCESS_PAGE}).`;
  }

  /** The projects this credential can reach, for messages that name them. Never throws. */
  async accessibleProjects(): Promise<ProjectBrief[] | undefined> {
    try {
      const response = await this.call('/v1/projects', { method: 'GET', timeoutMs: 8000 });
      if (!response.ok) return undefined;
      const body = await response.json() as { projects?: { id?: unknown; name?: unknown; role?: unknown }[] };
      return (body.projects ?? []).filter(project => typeof project.id === 'string').map(project => ({ id: String(project.id), name: typeof project.name === 'string' ? project.name : String(project.id), ...(typeof project.role === 'string' ? { role: project.role } : {}) }));
    } catch { return undefined; }
  }

  /** Sends a request and returns the parsed body, or raises a ToolError that says what to do next. */
  async request(method: 'GET' | 'POST' | 'PATCH', path: string, options: RequestOptions): Promise<{ status: number; body: unknown }> {
    const { context } = options;
    let response: ApiResponse;
    try {
      response = await this.call(this.url(path, options.query), {
        method,
        ...(options.headers || options.body !== undefined ? { headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers } } : {}),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        timeoutMs: options.timeoutMs ?? 15000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if ((error instanceof Error && error.name === 'TimeoutError') || /took too long|timed out|timeout/i.test(message)) {
        if (context.tool === 'create_site') throw new ToolError('Hoot Lens did not answer create_site in time. The site may already have been created. Retry within 24 hours with exactly the same idempotencyKey and site arguments to recover it safely. After 24 hours, inspect list_projects before creating again.', 'timeout');
        throw new ToolError(`Hoot Lens did not answer ${context.tool} in time. Try again; for large projects narrow the request with a smaller limit or date range.`, 'timeout');
      }
      if (context.tool === 'create_site') throw new ToolError('Could not reach the Hoot Lens API. The site may already have been created. Check the connection and retry within 24 hours with exactly the same idempotencyKey and site arguments. After 24 hours, inspect list_projects before creating again.', 'unavailable');
      throw new ToolError(`Could not reach the Hoot Lens API (${message || 'network error'}). Check the connection${this.surface === 'stdio' ? ' and HOOTLENS_API_URL' : ''}, then try again.`, 'unavailable');
    }
    if (response.ok || options.accept?.includes(response.status)) {
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    }
    throw await this.failure(response, context);
  }

  async get(path: string, query: Query | undefined, context: RequestContext): Promise<unknown> {
    return (await this.request('GET', path, { ...(query ? { query } : {}), context })).body;
  }

  private async failure(response: ApiResponse, context: RequestContext): Promise<ToolError> {
    const detail = await response.json().catch(() => undefined) as ErrorBody | undefined;
    // The API's own sentence is useful ("A change cannot be dated in the future"), but it is text from across a network
    // boundary: only a short, plain sentence with no token-like run in it is passed on.
    const apiMessage = typeof detail?.error === 'string' && detail.error.length < 200 && /^[\p{L}\p{N} ,.'"():;/_-]+$/u.test(detail.error) && !/[A-Za-z0-9_-]{24,}/.test(detail.error) ? detail.error.replace(/[.\s]+$/, '') : undefined;
    const { status } = response;
    const { projectId, scope, tool } = context;

    if (status === 401) {
      return new ToolError(`Hoot Lens refused the credential (401): ${apiMessage ?? 'it is missing, expired or revoked, or its creator lost access'}. ${this.reconnectAdvice()}`, 'unauthenticated', 401);
    }
    if (status === 429) {
      const seconds = retrySeconds(response.header?.('retry-after'));
      return new ToolError(rateLimitMessage(seconds) + (apiMessage ? ` (${apiMessage}.)` : ''), 'rate_limited', 429, seconds ?? 60);
    }
    if (status === 403) {
      if (scope === 'sites:create') {
        return new ToolError(`${tool} was refused (403): ${apiMessage ?? 'This connection cannot create sites'}. Sign in as the verified account owner and explicitly approve sites:create for all sites. Personal access tokens and project-pinned connections cannot create sites.`, 'missing_scope', 403);
      }
      // Settings tools can only make privacy stricter. Say so plainly rather than hinting at a missing scope.
      if (detail?.code === 'privacy_weakening_refused') {
        return new ToolError(`${tool} was refused (403): ${apiMessage ?? 'it would make privacy looser'}. Nothing was changed. The site owner can make this change in Hoot Lens settings.`, 'privacy_weakening_refused', 403);
      }
      if (detail?.code === 'staff_only') return new ToolError(`${STAFF_ONLY} Other keys are refused.`, 'staff_only', 403);
      if (projectId !== undefined) {
        const projects = await this.accessibleProjects();
        if (projects !== undefined && !projects.some(project => project.id === projectId)) {
          return new ToolError(unknownProjectMessage(projectId, projects, this.pinned), 'unknown_project', 403);
        }
      }
      // A specific refusal ('AI explanations are turned off for this project') is more useful than a scope hint.
      if (apiMessage && !/does not permit|role on this (project|site)/i.test(apiMessage)) return new ToolError(`${tool} was refused (403): ${apiMessage}.`, 'api_error', 403);
      if (scope !== undefined) {
        return new ToolError(`${tool} was refused (403). It needs the "${scope}" scope on project ${projectId ?? 'this project'}, and this credential does not have it (or the person who made it no longer has the permission that allows it: for example, viewers cannot annotate). ${grantAdvice(scope)}`, 'missing_scope', 403);
      }
      return new ToolError(`Hoot Lens refused ${tool} (403)${apiMessage ? `: ${apiMessage}` : ''}. The credential may lack the scope or project access this needs. ${grantAdvice('read')}`, 'missing_scope', 403);
    }
    if (status === 404) {
      if (projectId !== undefined && (apiMessage === 'Site not found' || apiMessage === 'Project not found')) {
        return new ToolError(unknownProjectMessage(projectId, await this.accessibleProjects(), this.pinned), 'unknown_project', 404);
      }
      return new ToolError(`Not found (404)${apiMessage ? `: ${apiMessage}` : ''}. It may not exist, may have been deleted or expired (recordings are kept for the site's retention period), or may belong to a site this credential cannot reach. Check the ID against ${tool === 'get_recording' || tool === 'get_session_narrative' || tool === 'add_note' ? 'list_sessions or list_recordings' : 'the matching list tool'}.`, 'not_found', 404);
    }
    if (status === 400 || status === 422) {
      return new ToolError(`Hoot Lens rejected the request to ${tool}: ${apiMessage ?? 'Invalid request fields'}. Check the arguments against the tool's input schema.`, 'invalid_argument', status);
    }
    if (status === 409) {
      if (tool === 'create_site') return new ToolError(`Conflict (409): ${apiMessage ?? 'This idempotency key was used for a different site request'}. Retry with the original arguments and key. Use a new key only for a separate intended site.`, 'conflict', 409);
      const holder = typeof detail?.assignee === 'string' ? ` Current assignee: ${detail.assignee}.` : '';
      return new ToolError(`Conflict (409): ${apiMessage ?? 'The change conflicts with the current state'}.${holder} Read the item again and retry if it still applies.`, 'conflict', 409);
    }
    if (status >= 500) {
      if (tool === 'create_site') return new ToolError(`Hoot Lens had a problem answering create_site (status ${status}). Retry within 24 hours with exactly the same idempotencyKey and site arguments; the site may already exist. After 24 hours, inspect list_projects before creating again.`, 'unavailable', status);
      return new ToolError(`Hoot Lens had a problem answering ${tool} (status ${status}). Try again in a moment.`, 'unavailable', status);
    }
    if (status === 402 && tool === 'create_site') return new ToolError(`${apiMessage ?? 'This account has no available site slots'}. The account owner can review the plan in Hoot Lens. No site was created.`, 'site_limit_reached', 402);
    return new ToolError(`Hoot Lens returned ${status} for ${tool}${apiMessage ? `: ${apiMessage}` : ''}.`, 'api_error', status);
  }
}
