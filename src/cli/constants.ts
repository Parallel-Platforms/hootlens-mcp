/*
 * Fixed facts about the login client. The Client ID Metadata Document at apps/web/public/oauth/mcp-cli.json must list
 * exactly the redirect URIs built here (a test checks), because the Hoot Lens authorization server matches redirect URIs
 * exactly: it has no rule that ignores the port of a loopback address (RFC 8252, section 7.3). So the CLI cannot use a
 * random port or path. It tries these ports in order and uses the first that is free.
 */
export const CLI_CLIENT_ID = 'https://hootlens.com/oauth/mcp-cli.json';
export const CLI_CALLBACK_PATH = '/callback';
export const CLI_CALLBACK_PORTS = [28731, 28732, 28733, 28734, 28735] as const;
export const cliRedirectUri = (port: number) => `http://127.0.0.1:${port}${CLI_CALLBACK_PATH}`;
export const DEFAULT_LOGIN_SCOPES = ['read', 'replay', 'annotate'] as const;
/** The whole login must finish within this time. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** The service name in the OS keychain and the folder name in the user config directory. */
export const STORE_NAME = 'hootlens-mcp';
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000;
export const RELOGIN_COMMAND = 'npx -y @hootlens/mcp login';
