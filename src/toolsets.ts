/*
 * Toolsets let a person offer an assistant only the groups it needs. The default includes the customer catalog:
 * read, replay, annotation, settings, installation, site creation, and feedback. Customer tools stay discoverable
 * when permission must be requested later; execution
 * still requires the credential's scopes and the person's current site permissions. Staff tools remain scope-filtered.
 */

export const TOOLSETS = ['read', 'replay', 'annotate', 'configure', 'install', 'sites', 'feedback', 'issues'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const TOOLSET_INFO: Record<Toolset, { summary: string; scope?: string }> = {
  read: { summary: 'Sites (projects), visits, recording lists, narratives, heatmaps, findings, JavaScript errors, traffic, conversion outcomes, goals, funnels, changes and the weekly summary.' },
  replay: { summary: 'Raw replay events and clicks of one recording. Needs the replay scope.', scope: 'replay' },
  annotate: { summary: 'Add notes to recordings and log changes. Execution requires the annotate scope.', scope: 'annotate' },
  configure: { summary: 'Read the site\'s settings, preview a change to page targeting, goals, funnels or privacy, and apply exactly what was previewed. Privacy can only get stricter. Execution requires the configure scope.', scope: 'configure' },
  install: { summary: 'Install tags for a platform and the install checker.' },
  sites: { summary: 'Create a site in the signed-in owner\'s account, within its site allowance. Requires explicit OAuth sites:create permission for all sites and an unpinned connection. Personal access tokens cannot create sites.', scope: 'sites:create' },
  feedback: { summary: 'Report bugs and ideas to the Hoot Lens team and follow your own reports.' },
  issues: { summary: 'Hoot Lens staff triage tools. Only offered when the credential has the triage scope.', scope: 'triage' },
};

/** Staff-only discovery remains separate from the customer catalog. */
const REQUIRED_SCOPE: Partial<Record<Toolset, string>> = { issues: 'triage' };
const DEFAULTS: readonly Toolset[] = ['read', 'replay', 'annotate', 'configure', 'install', 'sites', 'feedback'];

export interface ToolsetRequest {
  /** What the person asked for. Absent means the defaults. */
  requested?: readonly Toolset[] | undefined;
  /** The scopes the credential holds, when known. Used to limit staff-only discovery, never to grant execution. */
  scopes?: readonly string[] | undefined;
}

export interface ParsedToolsets { toolsets: Toolset[] | undefined; unknown: string[] }

/**
 * Reads a comma separated list such as "read,annotate". `default` stands for the defaults and `all` for every
 * toolset. Returns undefined toolsets for an empty value.
 */
export function parseToolsets(raw: string | undefined): ParsedToolsets {
  if (raw === undefined || raw.trim() === '') return { toolsets: undefined, unknown: [] };
  const names = raw.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  const out = new Set<Toolset>();
  const unknown: string[] = [];
  for (const name of names) {
    if (name === 'all') TOOLSETS.forEach(toolset => out.add(toolset));
    else if (name === 'default') DEFAULTS.forEach(toolset => out.add(toolset));
    else if ((TOOLSETS as readonly string[]).includes(name)) out.add(name as Toolset);
    else unknown.push(name);
  }
  return { toolsets: TOOLSETS.filter(toolset => out.has(toolset)), unknown };
}

export const unknownToolsetsMessage = (unknown: string[]) =>
  `Unknown toolset${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}. Valid toolsets: ${TOOLSETS.join(', ')}, plus "default" and "all".`;

/** The toolsets to offer, in a fixed order. */
export function enabledToolsets({ requested, scopes }: ToolsetRequest): Set<Toolset> {
  const holds = (scope: string) => scopes?.includes(scope) ?? false;
  const base = requested ?? [...DEFAULTS, 'issues' as const];
  return new Set(TOOLSETS.filter(toolset => base.includes(toolset) && (REQUIRED_SCOPE[toolset] === undefined || holds(REQUIRED_SCOPE[toolset]!))));
}

/** Toolsets the person asked for that the credential's scopes rule out, so a launcher can say why they are missing. */
export function unavailableToolsets({ requested, scopes }: ToolsetRequest): Toolset[] {
  if (requested === undefined || scopes === undefined) return [];
  return requested.filter(toolset => REQUIRED_SCOPE[toolset] !== undefined && !scopes.includes(REQUIRED_SCOPE[toolset]!));
}

/**
 * Tools to leave out for a credential, from the body of GET /v1/access. A narrative is a readable replay, so the API
 * refuses it unless the person behind the credential may watch replays on the site; when none of the sites the
 * credential reaches allows that, the tool is not offered. If the answer does not say, nothing is hidden.
 */
export function narrativeHidden(access: unknown): string[] {
  const projects = (access as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects) || !projects.length) return [];
  const known = projects.filter((project): project is { permissions: unknown[] } => Array.isArray((project as { permissions?: unknown } | null)?.permissions));
  if (known.length !== projects.length) return [];
  return known.some(project => project.permissions.includes('replay')) ? [] : ['get_session_narrative'];
}
