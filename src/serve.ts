import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DEFAULT_API_URL, patCredential, type Credential } from './credentials.js';
import { findPin } from './pin.js';
import { createHootLensServer } from './server.js';
import { narrativeHidden, parseToolsets, unavailableToolsets, unknownToolsetsMessage, type Toolset } from './toolsets.js';
import type { ApiFetch } from './api.js';
import { MCP_PACKAGE_VERSION } from './version.js';

/*
 * The local stdio server. It reaches the Hoot Lens API over HTTPS with the person's own credential, so the API decides
 * every call. Everything it says to a person goes to stderr; stdout carries only the protocol.
 */

const log = (message: string) => process.stderr.write(`[hootlens-mcp] ${message}\n`);

export const USAGE = `hootlens-mcp ${MCP_PACKAGE_VERSION}

Usage: hootlens-mcp [options]          run the MCP server on stdio
       hootlens-mcp login|logout|whoami|doctor

Options:
  --project <id>       default projectId for tools (also HOOTLENS_PROJECT or a .hootlens.json file)
  --toolsets <list>    comma separated: read, replay, annotate, configure, install, sites, feedback, issues, default, all (also HOOTLENS_TOOLSETS)
  --version, --help

Environment:
  HOOTLENS_PAT         an access key (dashboard, Settings, AI assistant). Without it, the sign-in from "hootlens-mcp login" is used.
  HOOTLENS_API_URL     the API origin (default ${DEFAULT_API_URL})
`;

export interface Flags { project?: string; toolsets?: string; help: boolean; version: boolean; unknown: string[] }

export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { help: false, version: false, unknown: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++index];
    if (name === '--project') { const found = value(); if (found !== undefined) flags.project = found; else flags.unknown.push(arg); }
    else if (name === '--toolsets') { const found = value(); if (found !== undefined) flags.toolsets = found; else flags.unknown.push(arg); }
    else if (name === '--help' || name === '-h') flags.help = true;
    else if (name === '--version' || name === '-v') flags.version = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

/** What the credential may do, from GET /v1/access. Undefined when the API cannot say; the API still decides each call. */
async function credentialScopes(call: ApiFetch): Promise<string[] | undefined> {
  try {
    const response = await call('/v1/access', { method: 'GET', timeoutMs: 6000 });
    if (!response.ok) return undefined;
    const body = await response.json() as { credential?: { scopes?: unknown } };
    const scopes = body.credential?.scopes;
    return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : undefined;
  } catch { return undefined; }
}

/** Tools to leave out because the person behind the credential cannot use them anywhere: no site where they may watch replays means no narratives. */
async function unusableTools(call: ApiFetch): Promise<string[]> {
  try {
    const response = await call('/v1/access', { method: 'GET', timeoutMs: 6000 });
    if (!response.ok) return [];
    return narrativeHidden(await response.json());
  } catch { return []; }
}

/** The fetch used by the tools: the API origin, the bearer token, one refresh-and-retry after a 401. */
export function apiFetchFor(base: string, credential: Credential): ApiFetch {
  const send = async (path: string, init: Parameters<ApiFetch>[1]) => fetch(new URL(path, base), {
    method: init.method, ...(init.body !== undefined ? { body: init.body } : {}),
    headers: { Authorization: `Bearer ${await credential.token()}`, 'User-Agent': `hootlens-mcp/${MCP_PACKAGE_VERSION}`, ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs), redirect: 'error',
  });
  return async (path, init) => {
    let response = await send(path, init);
    if (response.status === 401 && credential.refresh && await credential.refresh()) response = await send(path, init);
    return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown>, header: name => response.headers.get(name) };
  };
}

/** Starts the stdio server. Resolves when the input closes. */
export async function runServer(argv: readonly string[], env: Record<string, string | undefined>, resolveCredential: (env: Record<string, string | undefined>, base: string) => Promise<Credential | undefined>): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) { process.stdout.write(USAGE); return; }
  if (flags.version) { process.stdout.write(`${MCP_PACKAGE_VERSION}\n`); return; }
  if (flags.unknown.length) { log(`Unknown option ${flags.unknown.join(' ')}. Run with --help.`); process.exitCode = 2; return; }

  const base = env.HOOTLENS_API_URL ?? DEFAULT_API_URL;
  let parsedBase: URL;
  try { parsedBase = new URL(base); } catch { log('HOOTLENS_API_URL is not a valid URL.'); process.exitCode = 1; return; }
  if (parsedBase.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedBase.hostname)) { log('Use HTTPS for remote APIs (HOOTLENS_API_URL).'); process.exitCode = 1; return; }

  const pat = env.HOOTLENS_PAT?.trim();
  const credential = pat ? patCredential(pat) : await resolveCredential(env, base);
  if (!credential) {
    log('No credential. Run "npx -y @hootlens/mcp login" to sign in with your browser, or set HOOTLENS_PAT to an access key (dashboard, Settings, AI assistant).');
    process.exitCode = 1;
    return;
  }

  const parsed = parseToolsets(flags.toolsets ?? env.HOOTLENS_TOOLSETS);
  if (parsed.unknown.length) { log(unknownToolsetsMessage(parsed.unknown)); process.exitCode = 2; return; }
  const lookup = findPin({ flag: flags.project, env, cwd: process.cwd() });
  for (const warning of lookup.warnings) log(warning);

  const call = apiFetchFor(base, credential);
  const scopes = await credentialScopes(call);
  const hidden = await unusableTools(call);
  const missing = unavailableToolsets({ requested: parsed.toolsets, scopes });
  if (missing.length) log(`Not offering ${missing.join(', ')}: the credential lacks the scope they need. Add it in the dashboard under Settings, AI assistant.`);
  if (lookup.pin) log(`Pinned to project ${lookup.pin.projectId} (${lookup.pin.source === 'file' ? lookup.pin.file : lookup.pin.source === 'env' ? 'HOOTLENS_PROJECT' : '--project'}).`);
  log(`Serving ${parsedBase.origin} with ${credential.source}${scopes ? ` (scopes: ${scopes.join(', ')})` : ''}.`);

  serveStdio(() => createHootLensServer(call, { surface: 'stdio', assetOrigin: parsedBase.origin, pinnedProject: lookup.pin?.projectId, toolsets: parsed.toolsets as Toolset[] | undefined, scopes, ...(hidden.length ? { hide: hidden } : {}) }));
}
