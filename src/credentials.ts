/*
 * Where the local server gets its credential. HOOTLENS_PAT (an access key) always wins. Otherwise the sign-in made by
 * `hootlens-mcp login` is used. A credential can offer a refresh, which the transport tries once after a 401.
 */

/** The production API. HOOTLENS_API_URL overrides it (local development, staging). */
export const DEFAULT_API_URL = 'https://mcp.hootlens.com';
/** The default origin before 1.0.1. Sign-ins saved under it are still found and moved to DEFAULT_API_URL. */
export const LEGACY_API_URL = 'https://hootlens-api-368877148687.us-east1.run.app';

export interface Credential {
  /** Where it came from, for messages: HOOTLENS_PAT or the stored sign-in. */
  source: 'HOOTLENS_PAT' | 'stored sign-in';
  /** The bearer token to send now. */
  token(): Promise<string>;
  /** Gets a new token after the current one was refused. Returns false when the credential cannot be renewed. */
  refresh?(): Promise<boolean>;
}

export const patCredential = (token: string): Credential => ({ source: 'HOOTLENS_PAT', token: async () => token });
