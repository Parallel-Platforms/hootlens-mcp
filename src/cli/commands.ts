import { DEFAULT_API_URL, patCredential, type Credential } from '../credentials.js';
import { MCP_PACKAGE_VERSION } from '../version.js';
import { storedCredentialWith } from '../stored.js';
import { systemOpener, type Opener } from './browser.js';
import { DEFAULT_LOGIN_SCOPES, RELOGIN_COMMAND } from './constants.js';
import { login } from './login.js';
import { CliError, revokeToken, type Fetcher } from './oauth.js';
import { createTokenStore, defaultStoreDeps, type TokenStore } from './store.js';

export const COMMANDS = ['login', 'logout', 'whoami'] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (value: string | undefined): value is Command => COMMANDS.includes(value as Command);

export interface CliIo {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: Fetcher;
  open?: Opener;
  store?: TokenStore;
  now?: () => number;
  /** The OAuth client_id to log in with. Tests and development only. */
  clientId?: string;
  loginTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const HELP: Record<Command, string> = {
  login: `Usage: hootlens-mcp login [--scopes read,replay,annotate,configure]

Signs in through your browser and saves the sign-in (macOS Keychain, Linux Secret Service, or a private file in your config directory).
The default scopes are ${DEFAULT_LOGIN_SCOPES.join(', ')}. You choose the projects to share in the browser.
HOOTLENS_API_URL selects the API. HOOTLENS_PAT, when set, overrides the saved sign-in at run time.
`,
  logout: `Usage: hootlens-mcp logout

Deletes the saved sign-in and asks the server to end it.
`,
  whoami: `Usage: hootlens-mcp whoami

Shows who the saved sign-in (or HOOTLENS_PAT) is, its scopes and projects, and when the access token expires. Exits with status 1 when signed out.
`,
};

const defaultFetch: Fetcher = (input, init) => fetch(input, init);

function parseScopes(args: string[]): { scopes: string[] } | { error: string } {
  let scopes: string[] = [...DEFAULT_LOGIN_SCOPES];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = arg.startsWith('--scopes=') ? arg.slice('--scopes='.length) : undefined;
    if (inline !== undefined || arg === '--scopes') {
      const value = inline ?? args[++index];
      if (value === undefined) return { error: '--scopes needs a list, for example --scopes read,replay' };
      scopes = value.split(/[\s,]+/).filter(Boolean);
      if (!scopes.length) return { error: '--scopes needs at least one scope' };
    } else return { error: `Unknown option ${arg}.` };
  }
  return { scopes: [...new Set(['read', ...scopes])] };
}

/** Runs login, logout or whoami. Returns the exit status. */
export async function runCommand(command: Command, args: string[], io: CliIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.out(HELP[command]); return 0; }
  const fetcher = io.fetch ?? defaultFetch;
  const store = io.store ?? createTokenStore(defaultStoreDeps(io.env));
  const apiUrl = io.env.HOOTLENS_API_URL ?? DEFAULT_API_URL;
  try { new URL(apiUrl); } catch { io.err('HOOTLENS_API_URL is not a valid URL.\n'); return 1; }

  try {
    if (command === 'login') {
      const parsed = parseScopes(args);
      if ('error' in parsed) { io.err(`${parsed.error}\n\n${HELP.login}`); return 2; }
      await login({ apiUrl, scopes: parsed.scopes }, {
        env: io.env, fetch: fetcher, open: io.open ?? systemOpener(io.env), store, out: io.out, err: io.err,
        ...(io.now ? { now: io.now } : {}), ...(io.clientId ? { clientId: io.clientId } : {}), ...(io.loginTimeoutMs ? { timeoutMs: io.loginTimeoutMs } : {}),
      });
      return 0;
    }
    if (args.length) { io.err(`Unknown option ${args[0]}.\n\n${HELP[command]}`); return 2; }

    if (command === 'logout') {
      const set = await store.read(apiUrl);
      if (!set) { io.out(`Not signed in to ${new URL(apiUrl).origin}. Nothing to remove.\n`); return 0; }
      // Removed first: a person who runs logout must end up signed out even if the server cannot be reached.
      await store.remove(apiUrl);
      const revoked = await revokeToken(fetcher, set, AbortSignal.timeout(5000));
      io.out(revoked ? `Signed out of ${set.apiUrl}. The sign-in was ended at the server.\n` : `Signed out of ${set.apiUrl} on this machine. The server could not be reached, so the connection may still be listed under Connected apps in the dashboard; remove it there.\n`);
      return 0;
    }

    return await whoami(apiUrl, io, fetcher, store);
  } catch (error) {
    io.err(`${error instanceof CliError || error instanceof Error ? error.message : 'Something went wrong.'}\n`);
    return 1;
  }
}

async function whoami(apiUrl: string, io: CliIo, fetcher: Fetcher, store: TokenStore): Promise<number> {
  const pat = io.env.HOOTLENS_PAT?.trim();
  const credential: Credential | undefined = pat
    ? patCredential(pat)
    : await storedCredentialWith(io.env, apiUrl, { store, fetch: fetcher, err: io.err, ...(io.now ? { now: io.now } : {}), ...(io.sleep ? { sleep: io.sleep } : {}) });
  if (!credential) { io.err(`Not signed in to ${new URL(apiUrl).origin}. Run "${RELOGIN_COMMAND}", or set HOOTLENS_PAT.\n`); return 1; }

  const call = async () => fetcher(new URL('/v1/access', apiUrl).toString(), {
    headers: { Authorization: `Bearer ${await credential.token()}`, Accept: 'application/json', 'User-Agent': `hootlens-mcp/${MCP_PACKAGE_VERSION}` },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  let response: Response;
  try {
    response = await call();
    if (response.status === 401 && credential.refresh && await credential.refresh()) response = await call();
  } catch (error) {
    io.err(`Could not reach ${new URL(apiUrl).origin} (${error instanceof Error ? error.message : 'network error'}).\n`);
    return 1;
  }
  if (response.status === 401) {
    io.err(pat ? 'The API rejected HOOTLENS_PAT. Make a new access key in the dashboard (Settings, AI assistant).\n' : `The API rejected the saved sign-in. Run "${RELOGIN_COMMAND}" to sign in again.\n`);
    return 1;
  }
  if (!response.ok) { io.err(`The API answered ${response.status}.\n`); return 1; }
  const body = await response.json() as {
    credential?: { kind?: string; name?: string; client?: string; scopes?: string[]; projects?: 'all' | string[] };
    projects?: { id: string; name: string; role: string; scopes: string[] }[];
  };
  const info = body.credential ?? {};
  const lines = [`Signed in to ${new URL(apiUrl).origin}`];
  lines.push(`Credential: ${pat ? 'HOOTLENS_PAT' : 'saved sign-in'} (${info.kind ?? 'unknown'}${info.name ? `, "${info.name}"` : ''})`);
  lines.push(`Scopes: ${info.scopes?.length ? info.scopes.join(', ') : 'none'}`);
  if (info.projects !== undefined) lines.push(`Shared projects: ${info.projects === 'all' ? 'all of your projects' : `${info.projects.length} chosen`}`);
  if (!pat) {
    const set = await store.read(apiUrl).catch(() => undefined);
    if (set) lines.push(`Access token expires: ${new Date(set.expiresAt).toISOString()} (renewed automatically)`);
  }
  const projects = body.projects ?? [];
  lines.push(projects.length ? `Projects (${projects.length}):` : 'Projects: none reachable with this credential');
  for (const project of projects) lines.push(`  ${project.name} (${project.id}), ${project.role}: ${project.scopes.join(', ') || 'no scopes'}`);
  io.out(`${lines.join('\n')}\n`);
  return 0;
}
