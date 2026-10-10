/*
 * Where the sign-in from `hootlens-mcp login` is kept. In order of preference:
 *  - macOS: the login Keychain, through /usr/bin/security.
 *  - Linux: the Secret Service (GNOME Keyring, KWallet), through libsecret's secret-tool.
 *  - Anything else, or when those tools are missing or fail: a file in the user config directory (mode 0600 in a 0700
 *    directory, written atomically).
 * The token set is one JSON document per API origin. Commands are run through an injectable runner so tests never touch
 * a real keychain, and so no command line ever carries a token (see the notes on each backend).
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_API_URL, LEGACY_API_URL } from '../credentials.js';
import { STORE_NAME } from './constants.js';

export interface TokenSet {
  version: 1;
  /** The API origin this sign-in is for (the keychain account). */
  apiUrl: string;
  /** The MCP resource the tokens were issued for. */
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs a program with optional standard input. Resolves with code 127 when the program does not exist. Never rejects. */
export type Runner = (command: string, args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<RunResult>;

export const systemRunner: Runner = (command, args, options = {}) => new Promise(resolve => {
  let settled = false;
  const done = (result: RunResult) => { if (!settled) { settled = true; resolve(result); } };
  try {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); done({ code: 124, stdout, stderr: `${stderr}timed out` }); }, options.timeoutMs ?? 10_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); done({ code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 126, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  } catch (error) { done({ code: 126, stdout: '', stderr: error instanceof Error ? error.message : 'could not start' }); }
});

export interface StoreDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  run: Runner;
  home: string;
}
export const defaultStoreDeps = (env: Record<string, string | undefined>): StoreDeps => ({ env, platform: process.platform, run: systemRunner, home: env.HOME ?? env.USERPROFILE ?? homedir() });

/* ------------------------------------------------------------ serialization */

function parseTokenSet(value: unknown): TokenSet | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const set = value as Partial<TokenSet>;
  if (set.version !== 1) return undefined;
  const strings = [set.apiUrl, set.resource, set.issuer, set.tokenEndpoint, set.clientId, set.accessToken, set.refreshToken];
  if (strings.some(item => typeof item !== 'string' || !item)) return undefined;
  if (!Array.isArray(set.scopes) || typeof set.expiresAt !== 'number') return undefined;
  return set as TokenSet;
}

/* ------------------------------------------------------------------ the file */

/** The config directory: %APPDATA%\hootlens-mcp on Windows, otherwise $XDG_CONFIG_HOME or ~/.config, then hootlens-mcp. */
export function configDirectory(deps: Pick<StoreDeps, 'env' | 'platform' | 'home'>): string {
  if (deps.platform === 'win32') return join(deps.env.APPDATA || join(deps.home, 'AppData', 'Roaming'), STORE_NAME);
  return join(deps.env.XDG_CONFIG_HOME || join(deps.home, '.config'), STORE_NAME);
}
export const credentialsFile = (deps: Pick<StoreDeps, 'env' | 'platform' | 'home'>) => join(configDirectory(deps), 'credentials.json');

async function readFileMap(deps: StoreDeps): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(credentialsFile(deps), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Writes the whole file atomically: a temporary file in the same directory, flushed, then renamed over the old one. */
async function writeFileMap(deps: StoreDeps, map: Record<string, unknown>): Promise<void> {
  const target = credentialsFile(deps);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (deps.platform !== 'win32') await chmod(directory, 0o700).catch(() => undefined);
  const temporary = join(directory, `.credentials.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(map, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/* ----------------------------------------------------------------- keychains */

/**
 * macOS. `security add-generic-password -w <secret>` would put the token in the process list, and its prompt form reads
 * from the terminal, not stdin. `security -i` reads commands from standard input, so the command (and the token inside
 * it) never appears in any argument list. The value is base64url JSON, which has no characters that need quoting.
 * Reading uses `find-generic-password -w`, which prints the secret to stdout only.
 */
const SECURITY = '/usr/bin/security';
const quoteForSecurity = (value: string) => {
  if (/["\\\s]/.test(value)) throw new Error('value cannot be passed to security');
  return `"${value}"`;
};
const encode = (set: TokenSet) => Buffer.from(JSON.stringify(set), 'utf8').toString('base64url');
const decode = (text: string): TokenSet | undefined => {
  try { return parseTokenSet(JSON.parse(Buffer.from(text.trim(), 'base64url').toString('utf8'))); } catch { return undefined; }
};

interface Backend {
  name: string;
  read(account: string): Promise<TokenSet | undefined>;
  write(account: string, set: TokenSet): Promise<boolean>;
  remove(account: string): Promise<boolean>;
}

const macKeychain = (deps: StoreDeps): Backend => ({
  name: 'macOS Keychain',
  async read(account) {
    const result = await deps.run(SECURITY, ['find-generic-password', '-s', STORE_NAME, '-a', account, '-w']);
    return result.code === 0 ? decode(result.stdout) : undefined;
  },
  async write(account, set) {
    let command: string;
    try { command = `add-generic-password -U -s ${quoteForSecurity(STORE_NAME)} -a ${quoteForSecurity(account)} -w ${quoteForSecurity(encode(set))}\n`; } catch { return false; }
    return (await deps.run(SECURITY, ['-i'], { input: command })).code === 0;
  },
  async remove(account) {
    const result = await deps.run(SECURITY, ['delete-generic-password', '-s', STORE_NAME, '-a', account]);
    // 44: the item was not there.
    return result.code === 0 || result.code === 44;
  },
});

/** Linux. secret-tool takes the secret on standard input for `store`, so it is never in an argument list. */
const secretService = (deps: StoreDeps): Backend => ({
  name: 'Secret Service',
  async read(account) {
    const result = await deps.run('secret-tool', ['lookup', 'service', STORE_NAME, 'account', account]);
    return result.code === 0 ? decode(result.stdout) : undefined;
  },
  async write(account, set) {
    return (await deps.run('secret-tool', ['store', '--label', 'Hoot Lens MCP sign-in', 'service', STORE_NAME, 'account', account], { input: encode(set) })).code === 0;
  },
  async remove(account) {
    const result = await deps.run('secret-tool', ['clear', 'service', STORE_NAME, 'account', account]);
    return result.code === 0;
  },
});

const fileBackend = (deps: StoreDeps): Backend => ({
  name: 'credentials file',
  async read(account) { return parseTokenSet((await readFileMap(deps))[account]); },
  async write(account, set) {
    const map = await readFileMap(deps);
    map[account] = set;
    try { await writeFileMap(deps, map); return true; } catch { return false; }
  },
  async remove(account) {
    const map = await readFileMap(deps);
    if (!(account in map)) return true;
    delete map[account];
    try { await writeFileMap(deps, map); return true; } catch { return false; }
  },
});

export interface TokenStore {
  read(apiUrl: string): Promise<TokenSet | undefined>;
  /** Saves the set. Returns where it went (for the message after login). Throws when nothing worked. */
  write(set: TokenSet): Promise<string>;
  remove(apiUrl: string): Promise<void>;
}

/** The account is the API origin, so one machine can hold a sign-in for production and for a staging API. */
export const accountOf = (apiUrl: string) => new URL(apiUrl).origin;

export function createTokenStore(deps: StoreDeps): TokenStore {
  const keychain = deps.platform === 'darwin' ? macKeychain(deps) : deps.platform === 'linux' ? secretService(deps) : undefined;
  const file = fileBackend(deps);
  const readAccount = async (account: string) => {
    if (keychain) { const found = await keychain.read(account); if (found) return found; }
    return file.read(account);
  };
  const removeAccount = async (account: string) => {
    if (keychain) await keychain.remove(account);
    await file.remove(account);
  };
  const defaultAccount = accountOf(DEFAULT_API_URL);
  const legacyAccount = accountOf(LEGACY_API_URL);
  const store: TokenStore = {
    async read(apiUrl) {
      const account = accountOf(apiUrl);
      const found = await readAccount(account);
      if (found || account !== defaultAccount) return found;
      // Before 1.0.1 the default API origin was the Cloud Run host. Move that sign-in to the new key, keeping its tokens
      // and endpoints, so nobody has to sign in again. If saving fails, the old entry is left in place and still used.
      const legacy = await readAccount(legacyAccount);
      if (!legacy) return undefined;
      const moved: TokenSet = { ...legacy, apiUrl: DEFAULT_API_URL };
      try {
        await store.write(moved);
        await removeAccount(legacyAccount).catch(() => undefined);
      } catch { return legacy; }
      return moved;
    },
    async write(set) {
      const account = accountOf(set.apiUrl);
      if (keychain && await keychain.write(account, set)) {
        // A file left from an earlier fallback must not keep an old refresh token alive.
        await file.remove(account).catch(() => undefined);
        return keychain.name;
      }
      // The keychain failed: drop any older item there so a read never prefers a refresh token that has been rotated away.
      if (keychain) await keychain.remove(account).catch(() => undefined);
      if (await file.write(account, set)) return `${file.name} (${credentialsFile(deps)})`;
      throw new Error('Could not save the sign-in to the keychain or to a file in the config directory.');
    },
    async remove(apiUrl) {
      const account = accountOf(apiUrl);
      await removeAccount(account);
      // Signing out of the default API also clears a sign-in still saved under the old default.
      if (account === defaultAccount) await removeAccount(legacyAccount).catch(() => undefined);
    },
  };
  return store;
}
