/*
 * `hootlens-mcp login`: the OAuth authorization code flow with PKCE (S256) for a native app. The client is identified by a
 * Client ID Metadata Document, the browser comes back to a loopback listener, and the answer is accepted only when it
 * carries this login's `state` and the authorization server's own `iss` (RFC 9207). Nothing here prints a token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CLI_CALLBACK_PATH, CLI_CALLBACK_PORTS, CLI_CLIENT_ID, LOGIN_TIMEOUT_MS, cliRedirectUri } from './constants.js';
import { headless, type Opener } from './browser.js';
import { CliError, discover, exchangeCode, type Fetcher } from './oauth.js';
import type { TokenSet, TokenStore } from './store.js';

export interface LoginDeps {
  env: Record<string, string | undefined>;
  fetch: Fetcher;
  open: Opener;
  store: TokenStore;
  /** Normal output (stdout). */
  out: (text: string) => void;
  /** Progress and the link to open (stderr). */
  err: (text: string) => void;
  now?: () => number;
  clientId?: string;
  ports?: readonly number[];
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}
export interface LoginOptions { apiUrl: string; scopes: string[] }

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

interface CallbackResult { code: string }

const PAGE = (title: string, message: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body></html>`;
function reply(res: ServerResponse, status: number, title: string, message: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  res.end(PAGE(title, message));
}

/** Binds the first free port of the list on 127.0.0.1. */
async function listen(server: Server, ports: readonly number[]): Promise<number> {
  for (const port of ports) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => { if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false); else reject(error); };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(true); });
    });
    if (bound) return (server.address() as AddressInfo).port;
  }
  throw new CliError(`Ports ${ports.join(', ')} on 127.0.0.1 are all in use. Close the program using them and run login again.`);
}

export async function login(options: LoginOptions, deps: LoginDeps): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const clientId = deps.clientId ?? CLI_CLIENT_ID;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const server = createServer();
  let timeoutReject: (error: Error) => void = () => undefined;
  const timedOut = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
  controller.signal.addEventListener('abort', () => timeoutReject(new CliError('Timed out after 5 minutes waiting for the sign-in. Run login again.')), { once: true });
  timedOut.catch(() => undefined);
  try {
    const found = await Promise.race([discover(options.apiUrl, deps.fetch, controller.signal), timedOut]);
    for (const scope of options.scopes) {
      if (!/^[a-z][a-z-]{0,30}$/.test(scope)) throw new CliError(`"${scope}" is not a valid scope.`);
      if (found.scopesSupported.length && !found.scopesSupported.includes(scope)) throw new CliError(`The server does not offer the scope "${scope}". It offers: ${found.scopesSupported.join(', ')}.`);
    }

    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');

    let settle: { resolve: (value: CallbackResult) => void; reject: (error: Error) => void } = { resolve: () => undefined, reject: () => undefined };
    const result = new Promise<CallbackResult>((resolve, reject) => { settle = { resolve, reject }; });
    result.catch(() => undefined);
    let port = 0;
    let finished = false;
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Only the listener's own address is accepted as Host, so a web page cannot reach it through a rebound DNS name.
      if (req.method !== 'GET' || url.pathname !== CLI_CALLBACK_PATH) return reply(res, 404, 'Not found', 'Nothing is here.');
      if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 400, 'Not accepted', 'This request was not addressed to the sign-in listener.');
      const given = url.searchParams.get('state');
      if (given === null || !safeEqual(given, state)) return reply(res, 400, 'Not accepted', 'This link does not belong to the sign-in that is waiting. Go back to your terminal and start login again if you need to.');
      if (finished) return reply(res, 400, 'Already used', 'This sign-in link was already used.');
      finished = true;
      const issuer = url.searchParams.get('iss');
      if (issuer === null ? found.issParameterSupported : issuer !== found.issuer) {
        reply(res, 400, 'Sign-in stopped', 'The answer did not come from the Hoot Lens server this login started with, so it was not used.');
        return settle.reject(new CliError('The authorization response did not carry the expected issuer (iss). Not continuing.'));
      }
      const error = url.searchParams.get('error');
      if (error) {
        reply(res, 200, 'Sign-in was not completed', 'You can close this tab and return to your terminal.');
        return settle.reject(new CliError(error === 'access_denied' ? 'The sign-in was declined in the browser.' : `The sign-in was not completed (${error}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}).`));
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 2048) {
        reply(res, 400, 'Sign-in stopped', 'The answer had no authorization code.');
        return settle.reject(new CliError('The authorization response had no code.'));
      }
      reply(res, 200, 'Signed in to Hoot Lens', 'You can close this tab and return to your terminal.');
      settle.resolve({ code });
    });

    port = await listen(server, deps.ports ?? CLI_CALLBACK_PORTS);
    const redirectUri = cliRedirectUri(port);
    const authorize = new URL(found.authorizationEndpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256',
      state, scope: options.scopes.join(' '), resource: found.resource,
    }).toString();

    deps.err('Opening your browser to sign in to Hoot Lens.\n');
    deps.err(`If it does not open, visit this link:\n${authorize.toString()}\n`);
    if (headless(deps.env, deps.platform ?? process.platform)) deps.err('This looks like a remote shell, so the browser cannot open here. Open the link on a machine with a browser; it must be able to reach this machine on 127.0.0.1 (for example through an SSH port forward of port ' + port + ').\n');
    else deps.open(authorize.toString()).catch(() => deps.err('Could not open a browser automatically.\n'));

    const callback = await Promise.race([result, timedOut]);
    const grant = await Promise.race([
      exchangeCode(deps.fetch, { tokenEndpoint: found.tokenEndpoint, clientId, code: callback.code, verifier, redirectUri, resource: found.resource, requestedScopes: options.scopes, now, signal: controller.signal }),
      timedOut,
    ]);
    const set: TokenSet = {
      version: 1, apiUrl: new URL(options.apiUrl).origin, resource: found.resource, issuer: found.issuer, tokenEndpoint: found.tokenEndpoint,
      ...(found.revocationEndpoint !== undefined ? { revocationEndpoint: found.revocationEndpoint } : {}),
      clientId, scopes: grant.scopes, accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: grant.expiresAt,
    };
    const where = await deps.store.write(set);
    deps.out(`Signed in to ${set.apiUrl} with the scopes ${set.scopes.join(', ')}.\nSaved the sign-in in the ${where}.\n`);
    deps.out('Access renews automatically. If this sign-in goes unused for 30 days, or you disconnect the app in the dashboard, run login again.\n');
    return set;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
