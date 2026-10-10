/*
 * The OAuth client side of `hootlens-mcp login`: discovery (RFC 9728 protected resource metadata, then RFC 8414
 * authorization server metadata), the token exchange, refresh and revocation. Nothing here prints a token.
 */
import { REFRESH_MARGIN_MS } from './constants.js';
import type { TokenSet } from './store.js';
import { MCP_PACKAGE_VERSION } from '../version.js';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** An error whose message is safe and useful to show a person. */
export class CliError extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_BODY = 256 * 1024;

/** An https URL, or http on a loopback host (local development). */
export function secureUrl(value: unknown, what: string): URL {
  if (typeof value !== 'string') throw new CliError(`${what} is missing from the server's metadata.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError(`${what} is not a valid URL.`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new CliError(`${what} must use https.`);
  if (url.username || url.password || url.hash) throw new CliError(`${what} must not contain credentials or a fragment.`);
  return url;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_BODY) throw new CliError('The server sent a response that is too large.');
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new CliError('The server sent a response that is not JSON.');
}

async function getJson(fetcher: Fetcher, url: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': `hootlens-mcp/${MCP_PACKAGE_VERSION}` }, redirect: 'error', ...(signal ? { signal } : {}) }); } catch (error) {
    throw new CliError(`Could not reach ${new URL(url).origin} (${error instanceof Error ? error.message : 'network error'}).`);
  }
  if (!response.ok) throw new CliError(`${new URL(url).origin} answered ${response.status} for ${new URL(url).pathname}.`);
  return readJson(response);
}

export interface Discovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** True when the server says it adds `iss` to authorization responses (RFC 9207). */
  issParameterSupported: boolean;
  scopesSupported: string[];
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Finds the MCP resource, its authorization server and the endpoints, and checks that they agree with each other. */
export async function discover(apiUrl: string, fetcher: Fetcher, signal?: AbortSignal): Promise<Discovery> {
  const api = secureUrl(apiUrl, 'The API URL');
  const protectedResource = await getJson(fetcher, `${api.origin}/.well-known/oauth-protected-resource`, signal);
  const resource = secureUrl(protectedResource.resource, 'The MCP resource');
  if (resource.search || resource.pathname.replace(/\/+$/, '') === '') throw new CliError('The MCP resource has an unexpected shape.');
  const servers = strings(protectedResource.authorization_servers);
  if (servers.length === 0) throw new CliError('The server does not name an authorization server.');
  const issuer = secureUrl(servers[0], 'The authorization server');
  if (issuer.search) throw new CliError('The authorization server URL must not have a query.');
  const issuerString = issuer.pathname === '/' ? issuer.origin : `${issuer.origin}${issuer.pathname.replace(/\/+$/, '')}`;
  const wellKnown = issuer.pathname === '/' ? `${issuer.origin}/.well-known/oauth-authorization-server` : `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/+$/, '')}`;
  const metadata = await getJson(fetcher, wellKnown, signal);
  if (metadata.issuer !== issuerString) throw new CliError('The authorization server metadata names a different issuer than the one it was found for. Not continuing.');
  const endpoint = (name: string, label: string) => {
    const url = secureUrl(metadata[name], label);
    if (url.origin !== issuer.origin) throw new CliError(`${label} is not on the authorization server's origin. Not continuing.`);
    return url.toString();
  };
  if (!strings(metadata.code_challenge_methods_supported).includes('S256')) throw new CliError('The authorization server does not support PKCE with S256.');
  if (!strings(metadata.grant_types_supported).includes('authorization_code')) throw new CliError('The authorization server does not support the authorization code flow.');
  return {
    // Sent back exactly as the server reported it.
    resource: protectedResource.resource as string,
    issuer: issuerString,
    authorizationEndpoint: endpoint('authorization_endpoint', 'The authorization endpoint'),
    tokenEndpoint: endpoint('token_endpoint', 'The token endpoint'),
    ...(metadata.revocation_endpoint !== undefined ? { revocationEndpoint: endpoint('revocation_endpoint', 'The revocation endpoint') } : {}),
    issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    scopesSupported: strings(metadata.scopes_supported),
  };
}

/* -------------------------------------------------------------------- tokens */

export type TokenGrant = Pick<TokenSet, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scopes'>;

/** A rejected grant: the code or refresh token is invalid, expired, revoked or already used. */
export class InvalidGrant extends CliError {}

async function postForm(fetcher: Fetcher, url: string, fields: Record<string, string>, signal: AbortSignal | undefined): Promise<Response> {
  try {
    return await fetcher(url, {
      method: 'POST', redirect: 'error', ...(signal ? { signal } : {}),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': `hootlens-mcp/${MCP_PACKAGE_VERSION}` },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (error) {
    throw new CliError(`Could not reach the token endpoint (${error instanceof Error ? error.message : 'network error'}).`);
  }
}

async function parseTokenResponse(response: Response, now: number, fallbackScopes: string[]): Promise<TokenGrant> {
  const body = await readJson(response).catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : String(response.status);
    const description = typeof body.error_description === 'string' ? body.error_description : '';
    if (code === 'invalid_grant') throw new InvalidGrant(description || 'The sign-in was rejected.');
    throw new CliError(`The token endpoint refused the request (${code})${description ? `: ${description}` : ''}.`);
  }
  const access = body.access_token;
  const refresh = body.refresh_token;
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) throw new CliError('The token endpoint did not return an access token and a refresh token.');
  if (typeof body.token_type === 'string' && body.token_type.toLowerCase() !== 'bearer') throw new CliError('The token endpoint returned a token type other than Bearer.');
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return { accessToken: access, refreshToken: refresh, expiresAt: now + lifetime * 1000, scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : fallbackScopes };
}

export async function exchangeCode(
  fetcher: Fetcher,
  options: { tokenEndpoint: string; clientId: string; code: string; verifier: string; redirectUri: string; resource: string; requestedScopes: string[]; now?: () => number; signal?: AbortSignal },
): Promise<TokenGrant> {
  const response = await postForm(fetcher, options.tokenEndpoint, {
    grant_type: 'authorization_code', code: options.code, redirect_uri: options.redirectUri, client_id: options.clientId, code_verifier: options.verifier, resource: options.resource,
  }, options.signal);
  return parseTokenResponse(response, (options.now ?? Date.now)(), options.requestedScopes);
}

export async function refreshTokens(fetcher: Fetcher, set: TokenSet, now: () => number = Date.now, signal?: AbortSignal): Promise<TokenGrant> {
  const response = await postForm(fetcher, set.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: set.refreshToken, client_id: set.clientId, resource: set.resource }, signal);
  return parseTokenResponse(response, now(), set.scopes);
}

/** Best effort (RFC 7009): ends the whole grant at the server. Returns whether the server answered 200. */
export async function revokeToken(fetcher: Fetcher, set: TokenSet, signal?: AbortSignal): Promise<boolean> {
  const endpoint = set.revocationEndpoint ?? new URL('/oauth/revoke', set.issuer).toString();
  try {
    const response = await postForm(fetcher, endpoint, { token: set.refreshToken, token_type_hint: 'refresh_token', client_id: set.clientId }, signal);
    return response.ok;
  } catch { return false; }
}

export const expiresSoon = (set: Pick<TokenSet, 'expiresAt'>, now: number) => set.expiresAt - now <= REFRESH_MARGIN_MS;
