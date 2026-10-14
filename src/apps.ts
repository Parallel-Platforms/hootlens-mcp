import type { McpServer } from '@modelcontextprotocol/server';
import { APP_HTML } from './apps.generated.js';

/*
 * MCP Apps: interactive views a host renders inline where it supports them (specification 2026-01-26,
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). Three HTML documents are
 * served as ui:// resources, and three tools carry a pointer to one of them in their metadata. A host without MCP Apps
 * support ignores the metadata and the tools answer exactly as before.
 *
 * The documents come from services/mcp/app (npm run docs:mcp builds them into apps.generated.ts). Each is one file with its
 * script and styles inline. A document makes no request of its own: it gets its data from the tool result the host pushes
 * to it and from tool calls the host runs for it, with the signed-in person's own authorization.
 */

/** The media type of an MCP App document. */
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const APP_NAMES = ['replay', 'heatmap', 'findings'] as const;
export type AppName = (typeof APP_NAMES)[number];

export const APP_RESOURCES: Record<AppName, { uri: string; name: string; title: string; description: string; assets: boolean }> = {
  replay: {
    uri: 'ui://hootlens/replay', name: 'replay-viewer', title: 'Replay viewer', assets: true,
    description: 'An interactive replay of one visit or page view, with play, pause, speed, snag and error markers and the steps of the visit; choosing a step jumps to it.',
  },
  heatmap: {
    uri: 'ui://hootlens/heatmap', name: 'heatmap-viewer', title: 'Heatmap viewer', assets: true,
    description: 'Click density for one heatmap cohort drawn over the page, with the most clicked elements, their snags and how far visitors scrolled.',
  },
  findings: {
    uri: 'ui://hootlens/findings', name: 'findings-viewer', title: 'Findings', assets: false,
    description: 'The pages and devices with the most snags as a short list of cards.',
  },
};

/** The tools whose results these documents show, and the document each one links to. */
export const APP_TOOLS: Record<string, AppName> = {
  get_session_narrative: 'replay',
  get_heatmap: 'heatmap',
  review_findings: 'findings',
};

/** The tool only the documents call. A host that supports MCP Apps keeps it out of the model's tool list. */
export const APP_ONLY_TOOL = 'load_replay';

/** The only site the documents link to, for "Open in Hoot Lens". The directory submission lists this origin as an allowed link URI. */
export const APP_LINK_ORIGIN = 'https://hootlens.com';

/** Dedicated Hoot Lens origin used by ChatGPT to isolate this plugin's UI. The host still serves the HTML resource. */
export const APP_UI_ORIGIN = 'https://mcp.hootlens.com';

/** Tool metadata that points a host at a document. The flat key is the older spelling some hosts still read. */
export const toolUiMeta = (app: AppName) => ({ ui: { resourceUri: APP_RESOURCES[app].uri }, 'ui/resourceUri': APP_RESOURCES[app].uri });
/** Tool metadata for a tool only the documents call. */
export const appOnlyMeta = () => ({ ui: { visibility: ['app'] } });

/**
 * The content security policy a host builds for a document from this metadata. Nothing else loads: no connection
 * (connectDomains is empty, so fetch, XHR and WebSocket are refused), no nested frame from outside, no other base address.
 * The one origin recorded pages may load images, styles and fonts from is the Hoot Lens API's signed asset proxy, which
 * only serves a URL it signed for that project.
 */
export function appCsp(app: AppName, assetOrigin: string | undefined): { resourceDomains?: string[] } {
  if (!APP_RESOURCES[app].assets || !assetOrigin) return {};
  try {
    const origin = new URL(assetOrigin).origin;
    return origin.startsWith('http') ? { resourceDomains: [origin] } : {};
  } catch { return {}; }
}

const resourceMeta = (app: AppName, assetOrigin: string | undefined) => ({ ui: { domain: APP_UI_ORIGIN, csp: appCsp(app, assetOrigin), prefersBorder: false } });

/** Serves the documents as ui:// resources. `assetOrigin` is the origin of the signed asset proxy (the API). */
export function registerApps(server: McpServer, options: { assetOrigin?: string | undefined }): void {
  for (const app of APP_NAMES) {
    const { uri, name, title, description } = APP_RESOURCES[app];
    const _meta = resourceMeta(app, options.assetOrigin);
    server.registerResource(name, uri, { title, description, mimeType: APP_MIME_TYPE, _meta, cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' } } as never, (async (url: URL) => ({
      contents: [{ uri: url.href, mimeType: APP_MIME_TYPE, text: APP_HTML[app], _meta }],
    })) as never);
  }
}
