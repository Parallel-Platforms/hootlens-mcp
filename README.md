# @hootlens/mcp

The Hoot Lens MCP server. It lets an AI assistant (Claude, Cursor, VS Code, Codex and other MCP clients) read what Hoot Lens recorded on your websites: visits, replays, heatmaps, funnels, traffic, findings and changes. The assistant sees only what your own Hoot Lens account can see, and only the sites (projects) and scopes you allow.

You can run it two ways:

- **Locally over stdio** with `npx -y @hootlens/mcp` (this package), for clients that can launch a stdio server.
- **Hosted** at `https://mcp.hootlens.com/mcp`, for clients that support remote MCP servers. Nothing to install; you sign in with Hoot Lens in your browser.

The tool catalog depends on the release and selected toolsets. Source 1.4.0 keeps customer tools discoverable before their optional permissions are granted. Discovering a tool grants no access: the API checks the credential, current site permissions, and requested action every time. Earlier releases may hide tools whose scopes are missing. Check the installed version and inspect `tools/list` on your actual connection. `whoami` is available as a CLI command and an MCP connection-check tool; `doctor` requires 1.2.0 or later.

The read toolset includes `explain_snags`. When the site has AI explanations enabled, a request can send aggregated counts to the explanation provider and use the site owner's monthly account AI allowance. Inspect its tool description before requesting explanations. Doctor reports this caveat without calling the tool.

## Requirements

- Node.js 20 or newer (local server only).
- A Hoot Lens account. Reading recordings needs a reachable site. A new owner can add their first website during connection, then approve access to that site. Letting an assistant create additional sites requires separate, explicit OAuth `sites:create` permission and a release containing `create_site`.

## Sign in

Pick one.

**Browser sign-in (recommended).** Run this once:

```sh
npx -y @hootlens/mcp login
```

Your browser opens Hoot Lens. Choose the projects and permissions to share, and approve. The sign-in is saved in the macOS Keychain, the Linux Secret Service (libsecret), or, where those are not available, a file (`~/.config/hootlens-mcp/credentials.json`, or `%APPDATA%\hootlens-mcp\credentials.json` on Windows). On POSIX systems the fallback uses owner-only mode flags. On Windows it relies on inherited profile ACLs; the package does not enforce an owner-only Windows ACL. Tokens are never printed.

If you have no site yet, enter your website in the connection screen. Creating that website and approving the assistant's access are separate decisions. You can share only the new site with read/replay access; account-wide permission to create future sites is optional. After returning to the assistant, ask it to retrieve the installation instructions for your platform. A connected account and a created site do not establish that the tracking tag is installed or receiving data.

```sh
npx -y @hootlens/mcp whoami   # who is signed in, scopes, projects, token expiry
npx -y @hootlens/mcp logout   # delete the saved sign-in and end it at the server
```

`login --scopes read,replay` asks for fewer permissions (default: `read replay annotate`). On a remote machine without a browser, `login` prints the link; open it on a machine that can reach the CLI on `127.0.0.1` (for example through an SSH port forward of the port it names).

How long it lasts: access tokens last 1 hour and are renewed automatically. The renewal token lasts 30 days from its last use, so if you do not use the server for 30 days you must run `login` again. Disconnecting the app under Connected apps in the Hoot Lens dashboard ends the sign-in immediately. When a sign-in has ended, the server tells you to run `npx -y @hootlens/mcp login`.

**Access key.** In the dashboard, open Settings, AI assistant, and create a key for one project. Set it as `HOOTLENS_PAT` in the client's environment. When `HOOTLENS_PAT` is set it is used instead of the saved sign-in. A key belongs to one project and you can revoke it in the dashboard at any time. Prefer the browser sign-in on a personal machine and keys for CI or shared setups.

## Check local setup

With version 1.2.0 or later, run:

```sh
npx -y @hootlens/mcp doctor --toolsets read,replay
npx -y @hootlens/mcp doctor --authenticated --toolsets read,replay --project YOUR_PROJECT_ID --json
```

The default checks public readiness and OAuth metadata plus local configuration. The second command explicitly sends the existing credential to `/v1/access` to check the selected site and grants. Neither command refreshes tokens, changes sign-in, reads recordings or calls MCP tools. A configured PAT overrides saved browser sign-in. For a custom HTTPS API, inspect the reported origin and explicitly add `--trust-api https://YOUR_EXPECTED_API` before the authenticated check.

Exit codes: `0` means the selected checks passed, `1` means a service or access check failed, and `2` means the options or configuration are invalid. JSON includes `schemaVersion`, `authenticatedMetadataVerified`, check codes and recovery steps. `investigationVerified` stays false: ask your client for a finding and a timed narrative to prove an investigation. Doctor has a ten-second deadline and bounded response bodies; its scope is the local stdio configuration, not a remote client's saved sign-in or support for interactive views.

## Create a site as an authenticated agent

With version 1.1.0 or later, opt in with `login --scopes read,replay,annotate,sites:create`. The verified account owner must explicitly approve site creation for all sites in the browser. The permission is never included in default login scopes. Personal access tokens, anonymous demo connections, and project-pinned connections cannot create sites. Source 1.4.0 advertises `create_site` on normal unpinned connections before permission is granted, so assistants can discover the action. Hosted clients that support tool-level OAuth can request that permission when the tool is called. Otherwise, reconnect and approve the requested scope explicitly. Inspect `tools/list` on your actual connection.

Call `create_site` with `name`, exact HTTPS `origins`, and one stable `idempotencyKey` (8 to 128 printable ASCII characters, such as a UUID). Use the same key and site arguments after a timeout or network failure within 24 hours. Idempotency protection expires after 24 hours; inspect `list_projects` for the intended site before creating again. The API enforces the plan's available site slots atomically. New sites use balanced privacy by default (strict is optional) and require consent. The result gives a project ID and platform-specific installation instructions. Install on public pages, arrange consent, then call `check_install`; creation alone does not prove recording works. If the install instructions are unavailable, use `get_install_snippet` for the returned project ID instead of creating another site.

`start_setup` and `check_setup` provide an email-confirmed alternative when the user explicitly requests it. The hosted MCP connector requires sign-in before either tool can be called. The public REST onboarding endpoints allow an owner to begin email confirmation without an existing account, but that is a separate entry path. The local stdio launcher also needs its configured sign-in or access key. Do not use email setup to bypass the connector's authorization, and never open the owner's confirmation link on their behalf.

## Install in your client

The commands below use the local server. Replace `YOUR_PROJECT_ID` if you want to pin one project (optional; see Project pinning). If you did not run `login`, add your `HOOTLENS_PAT` as shown in each example.

### Claude Code

Local:

```sh
claude mcp add --transport stdio hootlens -- npx -y @hootlens/mcp
# with an access key instead of the saved sign-in, and a pinned project:
claude mcp add --transport stdio --env HOOTLENS_PAT=hl_pat_... hootlens -- npx -y @hootlens/mcp --project YOUR_PROJECT_ID
```

Hosted (then run `/mcp` inside Claude Code to sign in):

```sh
claude mcp add --transport http hootlens "https://mcp.hootlens.com/mcp"
```

Add `--scope project` to share the entry with your team through `.mcp.json`, or `--scope user` for all your projects.

### Cursor

Add to `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects.

Local:

```json
{
  "mcpServers": {
    "hootlens": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hootlens/mcp"],
      "env": { "HOOTLENS_PAT": "${env:HOOTLENS_PAT}" }
    }
  }
}
```

Leave out `env` to use the saved sign-in from `login`.

Hosted:

```json
{
  "mcpServers": {
    "hootlens": { "url": "https://mcp.hootlens.com/mcp" }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` (the top-level key is `servers`, not `mcpServers`).

Local:

```json
{
  "inputs": [
    { "type": "promptString", "id": "hootlens-pat", "description": "Hoot Lens access key", "password": true }
  ],
  "servers": {
    "hootlens": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hootlens/mcp"],
      "env": { "HOOTLENS_PAT": "${input:hootlens-pat}" }
    }
  }
}
```

Leave out `inputs` and `env` to use the saved sign-in from `login`.

Hosted:

```json
{
  "servers": {
    "hootlens": { "type": "http", "url": "https://mcp.hootlens.com/mcp" }
  }
}
```

### Claude Desktop

Local. Open Settings, Developer, Edit Config, and add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then quit and reopen Claude Desktop:

```json
{
  "mcpServers": {
    "hootlens": {
      "command": "npx",
      "args": ["-y", "@hootlens/mcp"]
    }
  }
}
```

This uses the saved sign-in from `login`. To use an access key, add `"env": { "HOOTLENS_PAT": "hl_pat_..." }`.

Hosted. Remote servers are not added in the JSON file. In Claude Desktop add a custom connector (Customize, Connectors, Add custom connector) with the URL `https://mcp.hootlens.com/mcp`, then sign in with Hoot Lens when asked. Custom connectors depend on your Claude plan.

### Codex

Local:

```sh
codex mcp add hootlens -- npx -y @hootlens/mcp
# with an access key:
codex mcp add hootlens --env HOOTLENS_PAT=hl_pat_... -- npx -y @hootlens/mcp
```

The same in `~/.codex/config.toml`:

```toml
[mcp_servers.hootlens]
command = "npx"
args = ["-y", "@hootlens/mcp"]
# env_vars = ["HOOTLENS_PAT"]   # forward the key from your shell instead of saving it here
```

Hosted:

```toml
[mcp_servers.hootlens]
url = "https://mcp.hootlens.com/mcp"
```

then run `codex mcp login hootlens`.

### Other clients

Any client that can start a stdio server: command `npx`, arguments `-y @hootlens/mcp`, optional environment `HOOTLENS_PAT`. Any client that supports remote servers over Streamable HTTP with OAuth: the URL `https://mcp.hootlens.com/mcp`. The hosted endpoint advertises its sign-in through standard OAuth discovery (RFC 9728 and RFC 8414) and accepts Client ID Metadata Documents and dynamic client registration.

## Hosted URL options

Two optional query parameters narrow the hosted tool catalog or pin a site. They never widen what you approved.

| Parameter | Example | Effect |
| --- | --- | --- |
| `project` | `https://mcp.hootlens.com/mcp?project=YOUR_PROJECT_ID` | Tools default to this project. |
| `toolsets` | `https://mcp.hootlens.com/mcp?toolsets=read,replay` | Offer only these toolsets. |

Combine them with `&`: `https://mcp.hootlens.com/mcp?project=YOUR_PROJECT_ID&toolsets=read`. Put the URL in quotes in a shell.

## Toolsets

Toolsets group tools so an assistant is offered only what it needs. Set them with `--toolsets read,replay` or `HOOTLENS_TOOLSETS=read,replay`.

| Toolset | What it offers |
| --- | --- |
| `read` | Sites (projects), visits, recording lists, narratives, heatmaps, findings, traffic, goals, funnels, changes, weekly summary. |
| `replay` | Raw replay events and clicks of one recording, and the events the interactive replay view loads. Needs the `replay` scope. |
| `annotate` | Add notes to recordings and log changes. Needs the `annotate` scope. |
| `configure` | Preview and apply site setup changes. Needs the optional `configure` scope. |
| `install` | Install tags per platform and the install checker. |
| `sites` | Create a site in your own account. Needs explicitly approved OAuth `sites:create` for all sites and an unpinned connection. |
| `feedback` | Report bugs and ideas to the Hoot Lens team and follow your reports. |
| `issues` | Hoot Lens staff triage tools. Needs the `triage` scope. |
| `default` | The customer catalog: `read`, `replay`, `annotate`, `configure`, `install`, `sites`, and `feedback`. |
| `all` | Every customer toolset, plus staff triage when authorized. |

These defaults describe source 1.4.0. With no explicit selection, authorized staff also receive the `issues` toolset. Normal customer tools remain discoverable when their execution scopes are missing. Each descriptor declares its required OAuth scopes. Calling a hosted tool without a required scope returns a permission challenge before the action runs. A site-role refusal remains a refusal even if OAuth approval already includes that scope. Staff triage stays hidden without `triage`, and pinned or demo connections do not offer site creation. Explicit toolset selection still narrows the catalog.

For an investigation-only catalog, select `--toolsets read,replay` and sign in with `login --scopes read,replay`. Selecting toolsets and granting scopes are separate controls: the first controls what the assistant sees, and the second controls what the credential can execute.

## Interactive views

In a client that renders MCP Apps (such as Claude), a visit narrative shows as a replay you can play and step through, a heatmap shows click density over the page, and the findings show as cards. Other clients get the same text and data as always. The views make no request of their own and load nothing from third parties; the replay view reads the recording through your connection and needs the `replay` scope. See the [MCP documentation](https://hootlens.com/docs/MCP.md#mcp-apps).

## Project pinning

By default tools take a `projectId`. To work in one project, pin it. The first of these that is set wins:

1. `--project YOUR_PROJECT_ID`
2. `HOOTLENS_PROJECT=YOUR_PROJECT_ID`
3. A `.hootlens.json` file in the working directory or any parent: `{"projectId": "YOUR_PROJECT_ID"}`. Project IDs are public, so the file is safe to commit.

Pinning sets a default. The API still checks every call against what your credential may reach.

## Configuration

| Variable | Purpose |
| --- | --- |
| `HOOTLENS_PAT` | Access key. Overrides the saved sign-in. |
| `HOOTLENS_API_URL` | API origin (default: the Hoot Lens production API). Used by `login`, `whoami` and the server. |
| `HOOTLENS_PROJECT` | Pinned project. |
| `HOOTLENS_TOOLSETS` | Comma separated toolsets. |

The server writes messages to stderr only. Standard output carries the MCP protocol.

## Troubleshooting

- **"No credential"**: run `npx -y @hootlens/mcp login`, or set `HOOTLENS_PAT`.
- **"The sign-in has ended"**: it was unused for 30 days or was disconnected in the dashboard. Run `login` again.
- **A tool says a scope is missing**: the credential lacks that permission. Run `login --scopes read,replay,annotate`, or add the scope to your access key in the dashboard.
- **A project is not found**: you did not share it when signing in, or you are not a member. Run `whoami` to list what the credential can reach.
- **`npx` is not found by Claude Desktop or an editor**: those apps start with a short `PATH`. Use the absolute path to `npx` (`which npx`) as the command, or install Node from nodejs.org.
- **No keychain on Linux (headless server, container)**: the sign-in falls back to the private file. Install `libsecret-tools` and run a Secret Service to use the keychain.
- **`login` says all ports are in use**: login listens on 127.0.0.1 ports 28731 to 28735. Close what is using them and run `login` again.
- **Behind a proxy or offline**: the server needs HTTPS access to the API (or `HOOTLENS_API_URL`).
- **Show the version**: `npx -y @hootlens/mcp --version`.

## Versions

The package follows Semantic Versioning. Tool names and arguments do not change within a major version; new tools and optional arguments can appear in a minor version. See `CHANGELOG.md`. `npx -y @hootlens/mcp` always runs the latest 1.x; pin with `npx -y @hootlens/mcp@1.0.1` if you need a fixed version. The server supports MCP protocol versions 2026-07-28 and 2025.

## Privacy

The server only forwards your requests to the Hoot Lens API with your own credential. It stores nothing except the sign-in described above. Hoot Lens never captures password, payment or one-time-code values, and replays mask other form values unless a site allowlists them.

## License

See `LICENSE`.

## Verification notes

The client instructions above were checked against each tool's documentation on 2026-10-07.

Confirmed from official documentation:

- Claude Code: `claude mcp add --transport stdio ... -- <command>`, `--env`, `--transport http`, `--scope`, and signing in with `/mcp` (https://code.claude.com/docs/en/mcp).
- Cursor: `.cursor/mcp.json` and `~/.cursor/mcp.json`, `mcpServers` with `command`/`args`/`env` (with `type: "stdio"`) and `url` (https://cursor.com/docs/context/mcp).
- VS Code: `.vscode/mcp.json` with `servers`, `type` `stdio` and `http`, and `inputs` with `${input:id}` (https://code.visualstudio.com/docs/copilot/customization/mcp-servers).
- Claude Desktop: `claude_desktop_config.json` locations and `mcpServers` for local servers (https://modelcontextprotocol.io/docs/develop/connect-local-servers); remote servers are added as custom connectors, not in the file (https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- Codex: `codex mcp add <name> --env K=V -- <command>`, `[mcp_servers.<name>]` with `command`, `args`, `env_vars`, `url`, and `codex mcp login <name>` (https://developers.openai.com/codex/mcp).

Not confirmed, so treat as likely but check if it fails:

- Cursor and VS Code starting a browser sign-in themselves for a remote server without extra configuration. Their documentation describes OAuth settings only for pre-registered clients, so if the sign-in does not start, use the local server.
- Codex adding a remote server with `codex mcp add hootlens --url ...`. The `config.toml` form above is the documented one.
- The `env = { HOOTLENS_PAT = "..." }` inline table in Codex `config.toml`; the documented key is `env_vars`.
- Claude Desktop extension (`.mcpb`) packaging. This package does not provide one.
- Plans that include Claude Desktop custom connectors.
