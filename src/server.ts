import { McpServer } from '@modelcontextprotocol/server';
import { Api, type ApiFetch, type Surface } from './api.js';
import { buildInstructions } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';
import { enabledToolsets, type Toolset } from './toolsets.js';
import { MCP_PACKAGE_VERSION } from './version.js';

/** The server identity both entry points report. */
export const MCP_SERVER_INFO = { name: 'hootlens', title: 'Hoot Lens', version: MCP_PACKAGE_VERSION, websiteUrl: 'https://hootlens.com' } as const;

export interface ServerConfig {
  /** Where the server runs, which decides how errors tell a person to sign in again. */
  surface: Surface;
  /** A project that projectId arguments default to. */
  pinnedProject?: string | undefined;
  /** The toolsets the person asked for. Absent means the defaults. */
  toolsets?: readonly Toolset[] | undefined;
  /** The scopes the credential holds, when known. Toolsets they cannot use are not offered. */
  scopes?: readonly string[] | undefined;
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
  const server = new McpServer({ ...MCP_SERVER_INFO }, {
    instructions: buildInstructions(toolsets, config.pinnedProject),
    cacheHints: {
      'server/discover': { ttlMs: 5 * MINUTE_MS, cacheScope: 'private' },
      'tools/list': { ttlMs: 5 * MINUTE_MS, cacheScope: 'private' },
      'prompts/list': { ttlMs: HOUR_MS, cacheScope: 'private' },
      'resources/list': { ttlMs: MINUTE_MS, cacheScope: 'private' },
      'resources/templates/list': { ttlMs: HOUR_MS, cacheScope: 'private' },
    },
  });
  registerTools(server, api, { pinnedProject: config.pinnedProject, toolsets });
  registerPrompts(server, toolsets, config.pinnedProject);
  registerResources(server, api, config.pinnedProject);
  return server;
}
