import { McpServer } from '@modelcontextprotocol/server';
import { Api, type ApiFetch, type Surface } from './api.js';
import { registerApps } from './apps.js';
import { buildInstructions } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';
import { enabledToolsets, type Toolset } from './toolsets.js';
import { MCP_PACKAGE_VERSION } from './version.js';

/** The server identity both entry points report. */
export const MCP_SERVER_INFO = { name: 'hootlens', title: 'Hoot Lens', version: MCP_PACKAGE_VERSION, websiteUrl: 'https://hootlens.com' } as const;
/** The icons clients may show for the server (MCP Implementation.icons), the same mark as the website's favicon. */
export const MCP_SERVER_ICONS = [
  { src: 'https://hootlens.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
  { src: 'https://hootlens.com/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
];

export interface ServerConfig {
  /** Where the server runs, which decides how errors tell a person to sign in again. */
  surface: Surface;
  /** A project that projectId arguments default to. */
  pinnedProject?: string | undefined;
  /** The toolsets the person asked for. Absent means the defaults. */
  toolsets?: readonly Toolset[] | undefined;
  /** The scopes the credential holds, when known. Toolsets they cannot use are not offered. */
  scopes?: readonly string[] | undefined;
  /** Tools to leave out of an otherwise enabled toolset. */
  hide?: readonly string[] | undefined;
  /** The origin of the API's signed asset proxy. The replay and heatmap views are allowed to load page assets from it and nothing else. */
  assetOrigin?: string | undefined;
  /** A standing caveat: added to the server instructions and after every tool result. The public demo uses it to say its data is synthetic. */
  notice?: string | undefined;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Builds a server with the tools, prompts and resources the config allows. `call` reaches the API as the caller, so
 * authorization is decided by the API on every request. The hosted route builds one per request (stateless); the stdio
 * server builds one per connection. Tool order is fixed, so tools/list is deterministic.
 *
 * Cache hints apply to protocol 2026-07-28 only. Lists depend on the credential (scopes, toolsets, pin), so they are
 * private; the documents contain nothing about a person and are public.
 */
export function createHootLensServer(call: ApiFetch, config: ServerConfig): McpServer {
  const toolsets = enabledToolsets({ requested: config.toolsets, scopes: config.scopes });
  const api = new Api(call, config.surface, config.pinnedProject);
  const server = new McpServer({ ...MCP_SERVER_INFO, icons: MCP_SERVER_ICONS }, {
    instructions: config.notice ? `${config.notice}\n\n${buildInstructions(toolsets, config.pinnedProject)}` : buildInstructions(toolsets, config.pinnedProject),
    // The lists never change during a connection (the hosted route builds a server per request), so no list-changed
    // notifications are offered. Offering them makes 2026-07-28 clients hold a subscriptions/listen stream open.
    capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } },
    cacheHints: {
      'server/discover': { ttlMs: 5 * MINUTE_MS, cacheScope: 'private' },
      'tools/list': { ttlMs: 5 * MINUTE_MS, cacheScope: 'private' },
      'prompts/list': { ttlMs: HOUR_MS, cacheScope: 'private' },
      'resources/list': { ttlMs: MINUTE_MS, cacheScope: 'private' },
      'resources/templates/list': { ttlMs: HOUR_MS, cacheScope: 'private' },
    },
  });
  registerTools(server, api, { assetOrigin: config.assetOrigin, pinnedProject: config.pinnedProject, toolsets, hide: config.hide ? new Set(config.hide) : undefined, notice: config.notice });
  registerPrompts(server, toolsets, config.pinnedProject);
  registerResources(server, api, config.pinnedProject);
  registerApps(server, { assetOrigin: config.assetOrigin });
  return server;
}
