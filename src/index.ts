/*
 * The Hoot Lens MCP package. `createHootLensServer` builds the server; the stdio entry (stdio.ts) and the hosted route
 * (services/api/src/mcp-route.ts) both call it, so they expose the same tools, prompts and resources.
 */
export { createHootLensServer, MCP_SERVER_INFO, type ServerConfig } from './server.js';
export { Api, type ApiFetch, type ApiResponse, type Surface } from './api.js';
export { ToolError, type ToolErrorCode } from './errors.js';
export { TOOLSETS, enabledToolsets, narrativeHidden, parseToolsets, unknownToolsetsMessage, unavailableToolsets, type Toolset } from './toolsets.js';
export { MCP_PACKAGE_VERSION } from './version.js';
