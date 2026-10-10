/*
 * The connection to the host: the MCP Apps protocol (JSON-RPC 2.0 over postMessage, specification 2026-01-26,
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), the part of it these
 * viewers use. It is written out here instead of bundling @modelcontextprotocol/ext-apps because that SDK brings its
 * protocol schema library with it (about 580 KB of each document, against a few KB here). tests/mcp-apps-browser.test.ts
 * runs the real SDK's host side (AppBridge) against this client, so the two stay in step.
 *
 * The viewers never call the Hoot Lens API and hold no credential: the host runs every tool call the viewer makes
 * (tools/call) on the signed-in person's behalf, through the connection that is already authorized, so the same scopes and
 * project access apply as for the model's own calls.
 */

const PROTOCOL_VERSION = '2026-01-26';
const REQUEST_TIMEOUT_MS = 120_000;

export interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

export type Called<T> = { ok: true; value: T; meta?: Record<string, unknown> } | { ok: false; message: string };

export interface HostContext {
  theme?: 'light' | 'dark';
  styles?: { variables?: Record<string, string | undefined> };
  displayMode?: string;
  availableDisplayModes?: string[];
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  [key: string]: unknown;
}

export interface Started {
  /** Calls a tool of this server through the host. Resolves with the structured result, or a short reason it failed. */
  call<T>(name: string, args: Record<string, unknown>): Promise<Called<T>>;
  /** Asks the host to open a link. Only hootlens.com addresses are ever passed here. */
  open(url: string): Promise<void>;
  /** True when the host offers a full screen view. */
  canFullscreen(): boolean;
  mode(): string;
  setMode(mode: 'inline' | 'fullscreen'): Promise<string>;
}

export interface Handlers {
  /** The input the model gave the tool (arguments), when the host sends it. */
  input?(args: Record<string, unknown>): void;
  /** The tool result the viewer shows. */
  result(result: ToolResult): void;
  /** The host changed size, theme or display mode. */
  context?(): void;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: number }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of a failed tool result, kept short. */
function failure(result: ToolResult): string {
  const text = result.content?.find(item => item.type === 'text')?.text ?? 'The tool reported an error.';
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function applyContext(context: HostContext, onChange: () => void): void {
  const root = document.documentElement;
  if (context.theme === 'light' || context.theme === 'dark') {
    root.setAttribute('data-theme', context.theme);
    root.style.colorScheme = context.theme;
  }
  // Only custom properties are taken, so a host cannot set anything else on the document.
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith('--') && typeof value === 'string') root.style.setProperty(name, value);
  }
  const insets = context.safeAreaInsets;
  if (insets) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) if (Number.isFinite(insets[side])) root.style.setProperty(`--hl-inset-${side}`, `${insets[side]}px`);
  }
  if (typeof context.displayMode === 'string') root.dataset.mode = context.displayMode;
  onChange();
}

export async function start(name: string, handlers: Handlers): Promise<Started> {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let context: HostContext = {};

  const post = (message: Record<string, unknown>) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const request = <T>(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error(`The host did not answer ${method} in time.`)); }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    post({ id, method, params });
  });

  window.addEventListener('message', event => {
    // Only the host answers: ignore anything that did not come from the parent window.
    if (event.source !== window.parent) return;
    const message = event.data as unknown;
    if (!isObject(message) || message.jsonrpc !== '2.0') return;
    const { id, method } = message;
    if (typeof method !== 'string') {
      // A response to one of our requests.
      if (typeof id !== 'number') return;
      const waiting = pending.get(id);
      if (!waiting) return;
      pending.delete(id);
      window.clearTimeout(waiting.timer);
      if (isObject(message.error)) waiting.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'The host refused the request.'));
      else waiting.resolve(message.result);
      return;
    }
    const params = isObject(message.params) ? message.params : {};
    if (id !== undefined) {
      // A request from the host. The viewers answer the two every app must and refuse the rest.
      if (method === 'ping' || method === 'ui/resource-teardown') post({ id, result: {} });
      else post({ id, error: { code: -32601, message: `${method} is not supported by this view` } });
      return;
    }
    if (method === 'ui/notifications/tool-input') handlers.input?.(isObject(params.arguments) ? params.arguments : {});
    else if (method === 'ui/notifications/tool-result') handlers.result(params as ToolResult);
    else if (method === 'ui/notifications/host-context-changed') {
      const patch = params as HostContext;
      context = { ...context, ...patch, ...(patch.styles ? { styles: { ...context.styles, ...patch.styles, variables: { ...context.styles?.variables, ...patch.styles.variables } } } : {}) };
      applyContext(context, () => handlers.context?.());
    }
  });

  const initialized = await request<{ hostContext?: HostContext }>('ui/initialize', {
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    appInfo: { name, version: '1.0.0' },
    protocolVersion: PROTOCOL_VERSION,
  }, 30_000);
  context = isObject(initialized) && isObject(initialized.hostContext) ? initialized.hostContext as HostContext : {};
  post({ method: 'ui/notifications/initialized', params: {} });
  // The first application of the host's theme happens before the caller has the connection, so it reports no change.
  applyContext(context, () => undefined);

  // Tell the host how tall the view is, so an inline card fits its content.
  let queued = false;
  let lastWidth = 0;
  let lastHeight = 0;
  const reportSize = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const root = document.documentElement;
      const previous = root.style.height;
      root.style.height = 'max-content';
      const height = Math.ceil(root.getBoundingClientRect().height);
      root.style.height = previous;
      const width = Math.ceil(window.innerWidth);
      if (width !== lastWidth || height !== lastHeight) { lastWidth = width; lastHeight = height; post({ method: 'ui/notifications/size-changed', params: { width, height } }); }
    });
  };
  reportSize();
  const observer = new ResizeObserver(reportSize);
  observer.observe(document.documentElement);
  observer.observe(document.body);

  return {
    async call<T>(tool: string, args: Record<string, unknown>): Promise<Called<T>> {
      try {
        const result = await request<ToolResult>('tools/call', { name: tool, arguments: args });
        if (!isObject(result)) return { ok: false, message: 'The host sent no result.' };
        if (result.isError) return { ok: false, message: failure(result) };
        const meta = isObject(result._meta) ? result._meta : undefined;
        return { ok: true, value: result.structuredContent as T, ...(meta ? { meta } : {}) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message.slice(0, 240) : 'The host could not run the tool.' };
      }
    },
    async open(url: string) {
      try { await request('ui/open-link', { url }, 30_000); } catch { /* the host refused or the person cancelled */ }
    },
    canFullscreen: () => context.availableDisplayModes?.includes('fullscreen') === true,
    mode: () => context.displayMode ?? 'inline',
    async setMode(mode) {
      try {
        const result = await request<{ mode?: string }>('ui/request-display-mode', { mode }, 15_000);
        if (typeof result.mode === 'string') { context = { ...context, displayMode: result.mode }; document.documentElement.dataset.mode = result.mode; }
      } catch { /* the host kept the mode it had */ }
      return context.displayMode ?? 'inline';
    },
  };
}
