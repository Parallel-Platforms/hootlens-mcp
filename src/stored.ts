/*
 * The credential the local server uses when HOOTLENS_PAT is not set: the sign-in saved by `hootlens-mcp login`.
 * It serves the access token and renews it with the rotating refresh token. Several MCP servers (one per editor window)
 * can share one stored sign-in, so every refresh first looks at the store: if another process already rotated the pair,
 * that pair is used instead of spending a refresh token that no longer works.
 */
import type { Credential } from './credentials.js';
import { RELOGIN_COMMAND } from './cli/constants.js';
import { InvalidGrant, expiresSoon, refreshTokens, type Fetcher } from './cli/oauth.js';
import { createTokenStore, defaultStoreDeps, type TokenSet, type TokenStore } from './cli/store.js';

export interface StoredDeps {
  store?: TokenStore;
  fetch?: Fetcher;
  now?: () => number;
  /** Where messages for the person go. Defaults to stderr: stdout carries the MCP protocol. */
  err?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const signedOutMessage = `The Hoot Lens sign-in has ended (it was revoked, or unused for 30 days). Run "${RELOGIN_COMMAND}" to sign in again.`;

/** The sign-in saved for this API, as a Credential. Undefined when there is none. */
export async function storedCredentialWith(env: Record<string, string | undefined>, base: string, deps: StoredDeps = {}): Promise<Credential | undefined> {
  const store = deps.store ?? createTokenStore(defaultStoreDeps(env));
  const fetcher: Fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const err = deps.err ?? ((text: string) => { process.stderr.write(text); });
  const sleep = deps.sleep ?? wait;
  let current: TokenSet | undefined;
  try { current = await store.read(base); } catch { current = undefined; }
  if (!current) return undefined;
  let held: TokenSet = current;
  let inflight: Promise<boolean> | undefined;
  let announced = false;
  const signedOut = () => {
    if (!announced) { announced = true; err(`[hootlens-mcp] ${signedOutMessage}\n`); }
    return false;
  };

  async function renew(): Promise<boolean> {
    // Another process may already have rotated the pair.
    let latest: TokenSet | undefined;
    try { latest = await store.read(base); } catch { latest = undefined; }
    if (!latest) return signedOut();
    if (latest.refreshToken !== held.refreshToken) {
      held = latest;
      if (!expiresSoon(held, now())) return true;
    }
    let grant;
    try {
      grant = await refreshTokens(fetcher, held, now);
    } catch (error) {
      if (!(error instanceof InvalidGrant)) {
        err(`[hootlens-mcp] Could not renew the Hoot Lens sign-in: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        return false;
      }
      // Rejected. The server tolerates a refresh sent twice at once but answers the second with this error, so give a
      // process that won the race a moment to save its pair, then look again.
      for (const delay of [200, 500, 1200]) {
        await sleep(delay);
        try { latest = await store.read(base); } catch { latest = undefined; }
        if (latest && latest.refreshToken !== held.refreshToken) { held = latest; return true; }
      }
      await store.remove(base).catch(() => undefined);
      return signedOut();
    }
    const next: TokenSet = { ...held, accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: grant.expiresAt, scopes: grant.scopes };
    // The old refresh token is dead as soon as the server answered, so the new pair is saved before anything uses it.
    try { await store.write(next); } catch { err('[hootlens-mcp] Could not save the renewed sign-in. It works until this server stops.\n'); }
    held = next;
    return true;
  }
  const refresh = () => (inflight ??= renew().finally(() => { inflight = undefined; }));

  return {
    source: 'stored sign-in',
    async token() {
      if (expiresSoon(held, now())) await refresh();
      return held.accessToken;
    },
    refresh,
  };
}

export const storedCredential = (env: Record<string, string | undefined>, base: string): Promise<Credential | undefined> => storedCredentialWith(env, base);
