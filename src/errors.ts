import { OAUTH_SCOPE_INFO, type OAuthScope } from '@hootlens/core';

/*
 * Errors a tool call can end in. Each message says what went wrong and what the caller can do next, because the reader
 * is usually an assistant that will relay it to a person. Messages never contain recorded content or credentials.
 */

/** A stable, machine-readable reason, carried in the result's `_meta["hootlens/error"].code`. */
export type ToolErrorCode =
  | 'unauthenticated' | 'missing_scope' | 'unknown_project' | 'project_required' | 'not_found' | 'rate_limited' | 'invalid_argument'
  | 'staff_only' | 'conflict' | 'timeout' | 'unavailable' | 'api_error';

/** The place in the dashboard where keys and connected apps are managed. */
export const DASHBOARD_ACCESS_PAGE = 'Settings, then AI assistant';

export class ToolError extends Error {
  constructor(message: string, readonly code: ToolErrorCode, readonly status?: number, readonly retryAfterSeconds?: number) { super(message); }
}

export const scopeLabel = (scope: string) => (scope in OAUTH_SCOPE_INFO ? OAUTH_SCOPE_INFO[scope as OAuthScope].label : scope);

/** How to obtain a scope the credential lacks. */
export const grantAdvice = (scope: string) =>
  `To add it, reconnect the app and tick "${scopeLabel(scope)}" on the Hoot Lens consent screen, or make a new access key that includes "${scope}" in the dashboard under ${DASHBOARD_ACCESS_PAGE}.`;

export interface ProjectBrief { id: string; name: string; role?: string }

export function unknownProjectMessage(projectId: string, projects: ProjectBrief[] | undefined, pinned: string | undefined): string {
  const list = projects === undefined
    ? 'Call list_projects to see the projects this credential can reach.'
    : projects.length === 0
      ? `This credential can reach no projects. Grant one in the dashboard under ${DASHBOARD_ACCESS_PAGE}.`
      : `Projects available to this credential: ${projects.slice(0, 20).map(project => `${project.name} (${project.id})`).join(', ')}${projects.length > 20 ? `, and ${projects.length - 20} more` : ''}.`;
  const pin = pinned !== undefined && pinned === projectId ? ' This is the pinned project (HOOTLENS_PROJECT, .hootlens.json or ?project=); fix or remove the pin.' : '';
  return `Project "${projectId}" was not found, or this credential cannot reach it.${pin} ${list}`;
}

export function rateLimitMessage(seconds: number | undefined, what = 'Hoot Lens'): string {
  return `${what} is rate limiting this credential. Retry in ${seconds ?? 60} seconds; do not retry sooner.`;
}

/** `Retry-After` is seconds or an HTTP date. */
export function retrySeconds(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - now) / 1000));
}

/** The result a failed tool call returns: text for the reader, a code for programs. */
export function errorResult(error: unknown) {
  const known = error instanceof ToolError ? error : undefined;
  const message = error instanceof Error ? error.message : 'The tool failed for an unknown reason.';
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
    _meta: { 'hootlens/error': { code: known?.code ?? 'api_error', ...(known?.status !== undefined ? { status: known.status } : {}), ...(known?.retryAfterSeconds !== undefined ? { retryAfterSeconds: known.retryAfterSeconds } : {}) } },
  };
}
