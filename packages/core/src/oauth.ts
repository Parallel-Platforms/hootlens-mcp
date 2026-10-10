/*
 * OAuth 2.1 for the hosted MCP endpoint ("Sign in with Hoot Lens"). Shared by the API, the dashboard consent page and
 * the tests. A grant is what a person approved for one app: scopes and projects. What a grant can do on a request is
 * its scopes intersected with the person's current role on each project (effectiveTokenScopes), so removing a member
 * or revoking the grant cuts access at once. Only hashes of codes and tokens are stored.
 */
import { z } from 'zod';
import type { ProjectRole, TokenScope } from './index';

/** Scopes a client may ask for. `triage` is offered only to staff, who must tick it on the consent page. */
export const OAUTH_SCOPES = ['read', 'replay', 'annotate', 'triage'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
/** Granted when a client asks for nothing (or only scopes Hoot Lens does not know). */
export const OAUTH_DEFAULT_SCOPES: readonly OAuthScope[] = ['read', 'replay'];

export const OAUTH_ACCESS_TTL_MS = 3_600_000;
export const OAUTH_REFRESH_TTL_MS = 30 * 86_400_000;
/** A refresh token presented again within this long of its exchange is refused without revoking the grant: two refreshes sent at once by one client. */
export const OAUTH_REFRESH_GRACE_MS = 10_000;
export const OAUTH_CODE_TTL_MS = 5 * 60_000;
/** How long a person has to decide on the consent page. */
export const OAUTH_REQUEST_TTL_MS = 10 * 60_000;
/** A registered client is removed this long after it was last used (registration counts), which is longer than a refresh token lives. */
export const OAUTH_CLIENT_IDLE_MS = 90 * 86_400_000;
/** Revoked grants stay listed in the store this long, then the Firestore TTL policy removes them. */
export const OAUTH_REVOKED_KEEP_MS = 30 * 86_400_000;
export const OAUTH_MAX_GRANTS_PER_USER = 25;
export const OAUTH_MAX_REDIRECT_URIS = 5;
export const OAUTH_MAX_CLIENT_NAME = 100;
/** Projects one grant may name. A grant for all projects names none and follows the person's access. */
export const OAUTH_MAX_GRANT_PROJECTS = 50;

export const OAUTH_ACCESS_PREFIX = 'hl_oat_';
export const OAUTH_REFRESH_PREFIX = 'hl_ort_';
export const OAUTH_CODE_PREFIX = 'hl_oac_';
export const OAUTH_CLIENT_PREFIX = 'hlc_';
export const OAUTH_REQUEST_PREFIX = 'hl_oar_';
/** The longest client_id that is a URL (a Client ID Metadata Document). */
export const OAUTH_MAX_CLIENT_ID_URL = 2000;

/** What the consent page tells a person about each scope. */
export const OAUTH_SCOPE_INFO: Record<OAuthScope, { label: string; description: string; required: boolean }> = {
  read: { label: 'Read analytics', description: 'See projects, recordings, heatmaps, traffic, findings, goals and changes.', required: true },
  replay: { label: 'Open replays', description: 'Read the recorded events of a visit, such as the story of a session.', required: false },
  annotate: { label: 'Log changes and notes', description: 'Log change markers and add notes on recordings, shown as made by an agent. It cannot change settings or delete recordings.', required: false },
  triage: { label: 'Work the issues queue (staff only)', description: 'Triage feedback issues as Hoot Lens staff. Grants no access to any project.', required: false },
};

/** How an app told Hoot Lens who it is: Dynamic Client Registration (RFC 7591) or a Client ID Metadata Document (the client_id is an https URL). */
export type OAuthRegistration = 'dynamic' | 'metadata_document';
/** OpenID Connect application_type. Omitted means web, except that loopback http redirect URIs imply native. */
export type OAuthApplicationType = 'web' | 'native';

/** A client registered by Dynamic Client Registration (RFC 7591). Public clients only: PKCE is the proof, no secret exists. */
export interface OAuthClientRecord {
  id: string;
  /** Chosen by the app. Shown on the consent page with the redirect host and never trusted. */
  name: string;
  redirectUris: string[];
  /** Stored as registered, or as implied by the redirect URIs. Absent on clients registered before it existed. */
  applicationType?: OAuthApplicationType;
  createdAt: number;
  /** Set when a grant is approved. */
  lastUsedAt?: number;
}

/** What a person approved for one app. */
export interface OAuthGrantRecord {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
  /** Absent means dynamic. A metadata document client has its client_id URL as `clientId`. */
  registration?: OAuthRegistration;
  /** The host of the client_id URL, for apps identified by a metadata document. */
  clientIdHost?: string;
  scopes: OAuthScope[];
  /** `all` follows the person's access: every project they can reach, now or later. Otherwise the ids they picked. */
  projects: 'all' | string[];
  /** The MCP resource the tokens are bound to (RFC 8707). */
  resource: string;
  createdAt: number;
  /** Written at most once an hour. */
  lastUsedAt?: number;
  revokedAt?: number;
  revokedReason?: 'user' | 'reuse' | 'superseded' | 'exchange';
  /** Projects an audit event was written for at grant time, so revoking can write the same ones. */
  auditProjectIds: string[];
}

/** An authorization request waiting for a person's decision on the consent page. Keyed by the hash of its id. */
export interface OAuthRequestRecord {
  hash: string;
  /** A hlc_ id, or the https URL of the app's Client ID Metadata Document. */
  clientId: string;
  /** From the registration or the document. Unverified. */
  clientName: string;
  /** Absent means dynamic. */
  registration?: OAuthRegistration;
  redirectUri: string;
  state?: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  resource: string;
  /** The issuer the app discovered, returned as `iss` on the redirect (RFC 9207). */
  issuer: string;
  createdAt: number;
  expiresAt: number;
  /** The first person to open it. Nobody else can decide on it. */
  userId?: string;
  /** Hash of the one-time token the consent page sends back with the decision. */
  nonceHash?: string;
  decidedAt?: number;
}

export interface OAuthCodeRecord {
  hash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export interface OAuthTokenRecord {
  hash: string;
  kind: 'access' | 'refresh';
  grantId: string;
  clientId: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  /** A refresh token is single use: set when it was exchanged. Presenting it again revokes the grant. */
  usedAt?: number;
}

/** One row of Connected apps. */
export interface OAuthGrantView {
  id: string;
  clientName: string;
  redirectHost: string;
  /** Only for apps identified by a metadata document: the host of their client_id URL. */
  clientIdHost?: string;
  registration?: OAuthRegistration;
  scopes: OAuthScope[];
  projects: 'all' | { id: string; name: string }[];
  createdAt: number;
  lastUsedAt?: number;
}

/** What the consent page shows for one authorization request (GET /v1/oauth/requests/:id). */
export interface OAuthConsentView {
  /**
   * `name` is whatever the app called itself and is never verified. For `registration: 'metadata_document'` the app is
   * identified by an https client_id URL: `clientIdHost` is that URL's host, which is the thing a person can judge
   * (the name is still the app's own claim). `registration` absent means dynamic. `redirectHost` is where the answer is sent.
   */
  client: { name: string; redirectHost: string; registration?: OAuthRegistration; clientIdHost?: string };
  /** Scopes the app asked for. */
  requestedScopes: OAuthScope[];
  /** Scopes this person may grant, with what each means. `triage` appears only for staff. */
  offeredScopes: { scope: OAuthScope; label: string; description: string; required: boolean; requested: boolean }[];
  projects: { id: string; name: string; role: ProjectRole }[];
  /** The person already connected this app. */
  existing?: { scopes: OAuthScope[]; projects: 'all' | string[]; createdAt: number };
  /** Send back with the decision. Single use. */
  nonce: string;
  expiresAt: number;
}

export const oauthDecisionSchema = z.object({
  nonce: z.string().min(20).max(200),
  decision: z.enum(['approve', 'deny']),
  scopes: z.array(z.enum(OAUTH_SCOPES)).max(OAUTH_SCOPES.length).default([]),
  projects: z.union([z.literal('all'), z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).min(1).max(OAUTH_MAX_GRANT_PROJECTS)]).optional(),
});
export type OAuthDecision = z.infer<typeof oauthDecisionSchema>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * A redirect URI Hoot Lens will register: https, or http on a loopback address for apps that run on the person's own
 * computer. No wildcards, credentials or fragments (RFC 6749 3.1.2, OAuth 2.1). Returns the problem, or undefined.
 */
export function redirectUriError(value: string): string | undefined {
  if (value.length > 2000 || /[\s*\\]/.test(value)) return 'Redirect URIs must be absolute URLs without spaces or wildcards';
  let url: URL;
  try { url = new URL(value); } catch { return 'Redirect URIs must be absolute URLs'; }
  if (url.username || url.password) return 'Redirect URIs must not contain credentials';
  if (url.hash || value.includes('#')) return 'Redirect URIs must not contain a fragment';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return 'Redirect URIs must use https, or http on localhost, 127.0.0.1 or [::1]';
}

/** Dynamic Client Registration request (RFC 7591), reduced to what Hoot Lens honors. Unknown fields are ignored. */
export const oauthRegistrationSchema = z.object({
  // Longer names are shortened by cleanClientName rather than refused.
  client_name: z.string().min(1).max(OAUTH_MAX_CLIENT_NAME * 3).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(OAUTH_MAX_REDIRECT_URIS),
  grant_types: z.array(z.string().max(60)).max(5).optional(),
  response_types: z.array(z.string().max(60)).max(5).optional(),
  token_endpoint_auth_method: z.string().max(60).optional(),
  scope: z.string().max(500).optional(),
  application_type: z.enum(['web', 'native']).optional(),
}).loose();

/** The problem with the grant and response types an app declares (registration or metadata document), or undefined. Only the authorization code flow with refresh tokens exists. */
export function grantMetadataProblem(grantTypes: readonly string[] | undefined, responseTypes: readonly string[] | undefined): string | undefined {
  if (grantTypes && !grantTypes.includes('authorization_code')) return 'grant_types must include authorization_code';
  if (grantTypes?.some(type => type !== 'authorization_code' && type !== 'refresh_token')) return 'Only the authorization_code and refresh_token grant types are supported';
  if (responseTypes && !responseTypes.includes('code')) return 'response_types must include code';
  return undefined;
}

const isLoopbackHttp = (uri: string) => { try { const url = new URL(uri); return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname); } catch { return false; } };
/**
 * The application type of a client and the problem with its redirect URIs under it. Omitted means web as in OpenID
 * Connect, except that a loopback http redirect URI implies native (older clients never sent a type). A client that says
 * web explicitly may not use http redirects: those belong to native apps.
 */
export function applicationTypeOf(declared: OAuthApplicationType | undefined, redirectUris: readonly string[]): { type: OAuthApplicationType; error?: string } {
  const loopback = redirectUris.some(isLoopbackHttp);
  if (declared === 'web' && loopback) return { type: 'web', error: 'application_type web requires https redirect URIs; use native for http on localhost' };
  return { type: declared ?? (loopback ? 'native' : 'web') };
}

/** True for a client_id that names a Client ID Metadata Document: it looks like a URL rather than a hlc_ id. */
export const isClientIdUrl = (clientId: string): boolean => /^https?:\/\//i.test(clientId);

/** Control, format (zero width and bidirectional) and line separator characters are dropped from an app's name, so it cannot disguise itself on the consent page. */
export const cleanClientName = (name: string): string =>
  name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, OAUTH_MAX_CLIENT_NAME);

/** The scopes of a request: those Hoot Lens knows, in a fixed order. Nothing usable gives the defaults. */
export function parseRequestedScopes(scope: string | undefined): OAuthScope[] {
  const asked = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  const known = OAUTH_SCOPES.filter(name => asked.has(name));
  return known.length ? known : [...OAUTH_DEFAULT_SCOPES];
}

/** PKCE code verifier syntax (RFC 7636 4.1). */
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** A S256 code challenge: 43 base64url characters. */
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** The scopes of a grant as the token scopes the rest of the API understands. */
export const grantTokenScopes = (scopes: readonly OAuthScope[]): TokenScope[] => [...scopes];

/**
 * Client IDs of Hoot Lens' own apps. Their metadata documents are served from hootlens.com, so the name and the
 * redirect addresses are ours. A grant held by one of them may call the REST API directly, which is how the local
 * `@hootlens/mcp` server uses a browser sign-in. Every other client's OAuth token is for the MCP endpoint only.
 */
export const OAUTH_FIRST_PARTY_CLIENT_IDS: readonly string[] = ['https://hootlens.com/oauth/mcp-cli.json'];
