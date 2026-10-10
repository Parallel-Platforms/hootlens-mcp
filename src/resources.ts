import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { Api } from './api.js';
import { DOCS } from './docs.generated.js';
import { ToolError, unknownProjectMessage } from './errors.js';

/*
 * Resources: things a client can read or attach without a tool call. The documents are static text; the project,
 * recording narrative and heatmap templates read the same API routes the tools use, with the caller's own credential.
 */

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const JSON_TYPE = 'application/json';
const MARKDOWN = 'text/markdown';
const HOUR_MS = 3_600_000;

export const DOC_RESOURCES = [
  { name: 'docs-install', uri: 'hootlens://docs/install', doc: 'install', title: 'Install guide', description: 'How to add the Hoot Lens tag to a site, per platform, and verify it.' },
  { name: 'docs-tracker', uri: 'hootlens://docs/tracker', doc: 'tracker', title: 'Tracker reference', description: 'What the browser tracker captures, masks and never captures, and its public methods.' },
  { name: 'docs-api', uri: 'hootlens://docs/api', doc: 'api', title: 'API reference', description: 'The Hoot Lens HTTP API, access keys, scopes and the OAuth flow.' },
  { name: 'docs-mcp', uri: 'hootlens://docs/mcp', doc: 'mcp', title: 'MCP server reference', description: 'Setup per client, toolsets, pinning, prompts, resources and every tool.' },
] as const;

const asText = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: JSON_TYPE, text: JSON.stringify(value) }] });
const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value) ?? '';

function checkedId(value: string | string[] | undefined, what: string): string {
  const id = one(value);
  if (!ID.test(id)) throw new ToolError(`"${id.slice(0, 40)}" is not a valid ${what}.`, 'invalid_argument');
  return id;
}

export function registerResources(server: McpServer, api: Api, pinnedProject?: string): void {
  for (const { name, uri, doc, title, description } of DOC_RESOURCES) {
    server.registerResource(name, uri, { title, description, mimeType: MARKDOWN, cacheHint: { ttlMs: HOUR_MS, cacheScope: 'public' } }, async url => ({
      contents: [{ uri: url.href, mimeType: MARKDOWN, text: DOCS[doc] || `${title} is not bundled in this build.` }],
    }));
  }

  const projects = async () => (await api.accessibleProjects()) ?? [];
  const context = (tool: string, projectId: string, scope: 'read' | 'replay' = 'read') => ({ tool, scope, projectId });

  server.registerResource('project', new ResourceTemplate('hootlens://projects/{projectId}', {
    list: async () => ({
      resources: (await projects()).filter(project => !pinnedProject || project.id === pinnedProject).map(project => ({
        uri: `hootlens://projects/${project.id}`, name: project.name, title: project.name, description: `Hoot Lens project ${project.id}${project.role ? `, your role: ${project.role}` : ''}`, mimeType: JSON_TYPE,
      })),
    }),
    complete: { projectId: async value => (await projects()).map(project => project.id).filter(id => id.startsWith(value)).slice(0, 50) },
  }), {
    title: 'Project', description: 'One Hoot Lens project: its name, role, allowed sites, privacy and consent settings, goals, funnels and saved segments.', mimeType: JSON_TYPE, cacheHint: { ttlMs: 60_000, cacheScope: 'private' },
  }, async (uri, variables) => {
    const projectId = checkedId(variables.projectId, 'project ID');
    const list = await api.get('/v1/projects', undefined, { tool: 'resources/read', projectId }) as { projects?: { id: string }[] };
    const project = (list.projects ?? []).find(candidate => candidate.id === projectId);
    if (!project) throw new ToolError(unknownProjectMessage(projectId, await api.accessibleProjects(), pinnedProject), 'unknown_project', 404);
    return asText(uri, { project });
  });

  server.registerResource('recording-narrative', new ResourceTemplate('hootlens://projects/{projectId}/recordings/{recordingId}', {
    list: undefined,
  }), {
    title: 'Recording narrative', description: 'The timed story of one page view: summary, facts, steps and the team\'s notes. Element labels and page text were recorded from visitors\' browsers.', mimeType: JSON_TYPE, cacheHint: { ttlMs: 120_000, cacheScope: 'private' },
  }, async (uri, variables) => {
    const projectId = checkedId(variables.projectId, 'project ID');
    const recordingId = checkedId(variables.recordingId, 'recording ID');
    return asText(uri, await api.get(`/v1/projects/${projectId}/recordings/${recordingId}/narrative`, undefined, context('resources/read', projectId)));
  });

  server.registerResource('heatmap', new ResourceTemplate('hootlens://projects/{projectId}/heatmaps/{key}', {
    list: async () => {
      if (!pinnedProject) return { resources: [] };
      const body = await api.get(`/v1/projects/${pinnedProject}/heatmaps`, undefined, context('resources/list', pinnedProject)).catch(() => ({ cohorts: [] })) as { cohorts?: { key: string; path: string; deviceClass: string; clicks: number }[] };
      return {
        resources: (body.cohorts ?? []).slice(0, 25).map(cohort => ({
          uri: `hootlens://projects/${pinnedProject}/heatmaps/${encodeURIComponent(cohort.key)}`, name: `${cohort.path} (${cohort.deviceClass})`, description: `${cohort.clicks} clicks`, mimeType: JSON_TYPE,
        })),
      };
    },
  }), {
    title: 'Heatmap cohort', description: 'Clicks, snags and scroll depth for one heatmap cohort (one page, release, revision, variant and device class). The key is the heatmap cohort key, URL-encoded. Element labels and page text were recorded from visitors\' browsers.', mimeType: JSON_TYPE, cacheHint: { ttlMs: 60_000, cacheScope: 'private' },
  }, async (uri, variables) => {
    const projectId = checkedId(variables.projectId, 'project ID');
    let key = one(variables.key);
    try { key = decodeURIComponent(key); } catch { /* use the raw value */ }
    if (!key || key.length > 2000) throw new ToolError('The heatmap key is missing or too long. Use a key from list_heatmaps.', 'invalid_argument');
    const aggregate = await api.get(`/v1/projects/${projectId}/heatmaps/${encodeURIComponent(key)}`, undefined, context('resources/read', projectId)) as { grid?: { cellSize: number; cells: unknown[] } };
    const limit = 200;
    return asText(uri, aggregate.grid && aggregate.grid.cells.length > limit
      ? { key, ...aggregate, grid: { ...aggregate.grid, cells: aggregate.grid.cells.slice(0, limit), truncatedFrom: aggregate.grid.cells.length } }
      : { key, ...aggregate });
  });
}
