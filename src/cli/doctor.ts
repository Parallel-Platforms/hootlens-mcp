import { z } from 'zod';
import { DEFAULT_API_URL, LEGACY_API_URL } from '../credentials.js';
import { findPin } from '../pin.js';
import { enabledToolsets, parseToolsets, TOOLSET_INFO, TOOLSETS, type Toolset } from '../toolsets.js';
import { MCP_PACKAGE_VERSION } from '../version.js';
import type { CliIo } from './commands.js';
import { createTokenStore, defaultStoreDeps, type TokenSet } from './store.js';

const DEADLINE_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const scopes = z.enum(['read', 'replay', 'annotate', 'configure', 'sites:create', 'triage']);
const scopeList = z.array(scopes).max(6);
const projectId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const accessSchema = z.object({
  account: z.object({ canCreateSites: z.boolean() }).optional(),
  credential: z.object({ kind: z.enum(['oauth', 'pat', 'person']), scopes: scopeList, projects: z.union([z.literal('all'), z.array(projectId).max(2000)]) }),
  projects: z.array(z.object({ id: projectId, scopes: scopeList })).max(2000),
});
type Check = { code: string; status: 'passed' | 'failed' | 'skipped' | 'warning'; message: string; recovery?: string };
export interface DoctorReport {
  schemaVersion: 1; packageVersion: string; mode: 'configuration' | 'authenticated-metadata'; ok: boolean;
  apiOrigin?: string; transport: 'stdio'; credentialSource: 'HOOTLENS_PAT' | 'saved-sign-in' | 'none';
  project?: { id: string; source: 'flag' | 'env' | 'file' }; requestedToolsets: readonly Toolset[] | 'default';
  access?: { scopes: string[]; projectCount: number; enabledToolsets: Toolset[]; siteCreationAuthorized: boolean };
  authenticatedMetadataVerified: boolean; investigationVerified: false; checks: Check[];
}
type Options = { json: boolean; authenticated: boolean; project?: string; toolsets?: string; trustedApi?: string };
class ProbeError extends Error { constructor(readonly code: string) { super(code); } }

function optionsFor(args: string[]): Options {
  const result: Options = { json: args.includes('--json'), authenticated: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf('=');
    const key = equals < 0 ? arg : arg.slice(0, equals);
    if (seen.has(key)) throw new ProbeError('INVALID_OPTIONS');
    seen.add(key);
    if (key === '--json' && equals < 0) result.json = true;
    else if (key === '--authenticated' && equals < 0) result.authenticated = true;
    else if (key === '--project' || key === '--toolsets' || key === '--trust-api') {
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (!value || value.startsWith('--')) throw new ProbeError('INVALID_OPTIONS');
      if (key === '--project') { if (!projectId.safeParse(value).success) throw new ProbeError('PROJECT_CONFIG_INVALID'); result.project = value; }
      else if (key === '--toolsets') result.toolsets = value;
      else result.trustedApi = originFor(value);
    } else throw new ProbeError('INVALID_OPTIONS');
  }
  return result;
}

function originFor(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProbeError('API_URL_INVALID'); }
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new ProbeError('API_URL_INVALID');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new ProbeError('API_URL_INVALID');
  return url.origin;
}

/** A timeout also covers injected providers and streamed bodies that ignore an abort signal. */
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      listener = () => reject(new ProbeError('TIMEOUT'));
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { void response.body?.cancel().catch(() => {}); throw new ProbeError('RESPONSE_INVALID'); }
  if (!response.body) throw new ProbeError('RESPONSE_INVALID');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await bounded(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BYTES) throw new ProbeError('RESPONSE_INVALID');
      parts.push(item.value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; }
    catch { throw new ProbeError('RESPONSE_INVALID'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function storedIsBound(set: TokenSet, origin: string): boolean {
  try {
    const storedOrigin = originFor(set.apiUrl);
    const allowed = storedOrigin === origin || (origin === DEFAULT_API_URL && storedOrigin === LEGACY_API_URL);
    const resource = new URL(set.resource);
    return allowed && !resource.username && !resource.password && !resource.hash && !resource.search
      && resource.pathname === '/mcp' && (resource.origin === origin || (origin === DEFAULT_API_URL && resource.origin === LEGACY_API_URL))
      && typeof set.accessToken === 'string' && set.accessToken.length > 0 && Number.isFinite(set.expiresAt);
  } catch { return false; }
}

export async function runDoctor(args: string[], io: CliIo): Promise<number> {
  const report: DoctorReport = { schemaVersion: 1, packageVersion: MCP_PACKAGE_VERSION, mode: 'configuration', ok: false, transport: 'stdio', credentialSource: 'none', requestedToolsets: 'default', authenticatedMetadataVerified: false, investigationVerified: false, checks: [] };
  const add = (code: string, status: Check['status'], message: string, recovery?: string) => report.checks.push({ code, status, message, ...(recovery ? { recovery } : {}) });
  let json = args.includes('--json');
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), io.doctorTimeoutMs ?? DEADLINE_MS);
  const signal = controller.signal;
  let options: Options;
  try {
    options = optionsFor(args); json = options.json;
    report.mode = options.authenticated ? 'authenticated-metadata' : 'configuration';
    report.apiOrigin = originFor(io.env.HOOTLENS_API_URL ?? DEFAULT_API_URL);
    const parsed = parseToolsets(options.toolsets ?? io.env.HOOTLENS_TOOLSETS);
    if (parsed.unknown.length || (options.toolsets !== undefined && !parsed.toolsets?.length)) throw new ProbeError('TOOLSETS_INVALID');
    report.requestedToolsets = parsed.toolsets ?? 'default';
    if (!parsed.toolsets) add('DEFAULT_TOOLSETS', 'warning', 'Default toolsets include installation and feedback tools that can submit requests.', 'Choose --toolsets read,replay for an investigation connection.');
    if (!parsed.toolsets || parsed.toolsets.includes('read')) add('EXPLANATION_USAGE', 'warning', "Read tools include explain_snags. When site AI explanations are enabled, it can send aggregated counts to the explanation provider and use the site owner's monthly account AI allowance. Doctor does not call it.", 'Inspect the offered tools and site AI settings before requesting an explanation.');
    const pin = findPin({ flag: options.project, env: io.env, cwd: io.cwd ?? process.cwd() });
    if (pin.warnings.length) throw new ProbeError('PROJECT_CONFIG_INVALID');
    if (pin.pin) report.project = { id: pin.pin.projectId, source: pin.pin.source };
    add('CONFIG_VALID', 'passed', 'The API origin, project selection and toolsets are valid.');

    const fetcher = io.fetch ?? fetch;
    const request = async (path: string, token?: string) => {
      let response: Response;
      try { response = await bounded(fetcher(`${report.apiOrigin}${path}`, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json', 'User-Agent': `hootlens-mcp/${MCP_PACKAGE_VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }), signal); }
      catch (error) { throw error instanceof ProbeError ? error : new ProbeError(signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ProbeError(response.status === 401 ? 'CREDENTIAL_REJECTED' : response.status === 403 ? 'ACCESS_DENIED' : 'SERVICE_UNAVAILABLE');
      }
      return readJson(response, signal);
    };
    const metadata = async () => {
      const [health, resource, issuer] = await Promise.all([request('/health'), request('/.well-known/oauth-protected-resource'), request('/.well-known/oauth-authorization-server')]);
      const healthy = z.object({ ready: z.literal(true) }).safeParse(health);
      const protectedResource = z.object({ resource: z.literal(`${report.apiOrigin}/mcp`), authorization_servers: z.array(z.literal(report.apiOrigin!)).min(1), scopes_supported: scopeList }).safeParse(resource);
      const oauth = z.object({ issuer: z.literal(report.apiOrigin!), code_challenge_methods_supported: z.array(z.string()).refine(values => values.includes('S256')), authorization_endpoint: z.literal(`${report.apiOrigin}/oauth/authorize`), token_endpoint: z.literal(`${report.apiOrigin}/oauth/token`) }).safeParse(issuer);
      if (!healthy.success || !protectedResource.success || !oauth.success) throw new ProbeError('METADATA_INVALID');
      add('PUBLIC_METADATA_VALID', 'passed', 'The service is ready and its MCP identity and OAuth metadata agree.');
    };
    // No credential is sent to public probes. Metadata must validate before the optional access read.
    await metadata();
    if (options.authenticated && ![DEFAULT_API_URL, LEGACY_API_URL].includes(report.apiOrigin)
      && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(report.apiOrigin).hostname)
      && options.trustedApi !== report.apiOrigin) throw new ProbeError('CUSTOM_API_NOT_TRUSTED');
    const pat = io.env.HOOTLENS_PAT?.trim();
    let token: string | undefined;
    if (pat) { token = pat; report.credentialSource = 'HOOTLENS_PAT'; add('PAT_SELECTED', 'passed', 'HOOTLENS_PAT takes precedence over saved sign-in.'); }
    else {
      const deps = defaultStoreDeps(io.env);
      const store = io.store ?? createTokenStore({ ...deps, run: (command, values, options) => deps.run(command, values, { ...options, timeoutMs: 1000 }) }, { migrateLegacy: false });
      const saved = await bounded(store.read(report.apiOrigin), signal);
      if (!saved) add('SIGNED_OUT', 'failed', 'No local credential is available.', 'Run npx -y @hootlens/mcp login --scopes read,replay, then repeat this check.');
      else if (!storedIsBound(saved, report.apiOrigin)) add('CREDENTIAL_BINDING_INVALID', 'failed', 'The saved sign-in does not match the selected API.', 'Sign in to the intended API again.');
      else {
        report.credentialSource = 'saved-sign-in';
        if (saved.expiresAt <= (io.now ?? Date.now)()) add('ACCESS_TOKEN_EXPIRED', 'failed', 'The saved access token has expired. Doctor does not refresh it.', 'Run npx -y @hootlens/mcp whoami to renew normally, then repeat doctor --authenticated.');
        else { token = saved.accessToken; add('SAVED_SIGN_IN_PRESENT', 'passed', 'A matching, unexpired saved access token is available.'); }
      }
    }
    if (options.authenticated && token) {
      const parsedAccess = accessSchema.safeParse(await request('/v1/access', token));
      if (!parsedAccess.success) throw new ProbeError('ACCESS_METADATA_INVALID');
      const access = parsedAccess.data;
      const enabled = enabledToolsets({ requested: parsed.toolsets, scopes: access.credential.scopes });
      const desired: readonly Toolset[] = parsed.toolsets ?? ['read', 'replay', 'install', 'feedback'];
      const selected = report.project ? access.projects.filter(project => project.id === report.project!.id) : access.projects;
      if (report.project && !selected.length) add('PROJECT_NOT_AUTHORIZED', 'failed', 'The selected project is not reachable with this credential.', 'Use whoami to inspect approved projects, then correct the pin or reconnect the intended site.');
      const needed = [...new Set(desired.map(toolset => toolset === 'read' || toolset === 'install' ? 'read' : TOOLSET_INFO[toolset].scope).filter((value): value is string => value !== undefined))];
      const held = new Set<string>(selected.flatMap(project => project.scopes));
      if (access.credential.scopes.includes('triage')) held.add('triage');
      const canCreate = access.account?.canCreateSites === true && access.credential.kind === 'oauth' && access.credential.scopes.includes('sites:create') && access.credential.projects === 'all' && !report.project;
      if (canCreate) held.add('sites:create');
      if (!selected.length && desired.some(toolset => ['read', 'replay', 'annotate', 'configure', 'install'].includes(toolset))) add('NO_PROJECTS', 'failed', 'No approved site is available for this workflow.', 'Add a site in the dashboard, or explicitly authorize owner site creation before connecting again.');
      if (needed.some(scope => !held.has(scope))) add('SCOPES_INSUFFICIENT', 'failed', 'The requested toolsets require access this connection does not have.', 'Reconnect with the required scopes and site permissions, or choose narrower toolsets.');
      if (desired.includes('sites') && !canCreate) add('SITE_CREATION_UNAVAILABLE', 'failed', 'Site creation requires owner-authorized OAuth for all sites and an unpinned connection.', 'Use a separate owner connection with optional sites:create approval; site slots are enforced when creating.');
      report.access = { scopes: access.credential.scopes, projectCount: access.projects.length, enabledToolsets: TOOLSETS.filter(toolset => enabled.has(toolset) && (toolset !== 'sites' || canCreate)), siteCreationAuthorized: canCreate };
      report.authenticatedMetadataVerified = true;
      add('ACCESS_METADATA_VERIFIED', 'passed', 'The API accepted the credential and returned validated access metadata. No recording or tool was read.');
    } else add('AUTH_CHECK_SKIPPED', 'skipped', 'Authenticated access has not been verified.', 'Use doctor --authenticated to check existing access metadata.');
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : 'DIAGNOSTIC_FAILED';
    const recovery: Record<string, string> = {
      INVALID_OPTIONS: 'Use doctor --help for supported options.', API_URL_INVALID: 'Use an HTTPS API origin without credentials, paths, queries or fragments.',
      TOOLSETS_INVALID: `Choose toolsets from ${TOOLSETS.join(', ')}, default or all.`, PROJECT_CONFIG_INVALID: 'Correct --project, HOOTLENS_PROJECT or the nearest .hootlens.json.',
      CREDENTIAL_REJECTED: 'Replace the configured PAT or sign in again; a PAT overrides saved sign-in.', ACCESS_DENIED: 'Check account verification and granted access.',
      CUSTOM_API_NOT_TRUSTED: 'Inspect apiOrigin, then repeat with --trust-api <expected-origin> only if you trust that API. No credential was sent.',
      TIMEOUT: 'Check your network and service status, then retry.', NETWORK_ERROR: 'Check your network and the configured API origin, then retry.',
    };
    add(code, 'failed', 'The diagnostic could not verify this check.', recovery[code] ?? 'Check the API status and version, then retry or contact support@hootlens.com.');
  }
  // Stop sibling public probes as well when an earlier probe fails before the deadline.
  controller.abort();
  clearTimeout(deadline);
  report.ok = !report.checks.some(check => check.status === 'failed');
  io.out(json ? `${JSON.stringify(report)}\n` : `Hoot Lens MCP ${report.packageVersion}: ${report.mode}\n${report.checks.map(check => `${check.status}: ${check.message}${check.recovery ? ` ${check.recovery}` : ''}`).join('\n')}\nInvestigation completion has not been verified.\n`);
  return report.ok ? 0 : report.checks.some(check => ['INVALID_OPTIONS', 'API_URL_INVALID', 'TOOLSETS_INVALID', 'PROJECT_CONFIG_INVALID'].includes(check.code)) ? 2 : 1;
}
