# @hootlens/mcp

The Hoot Lens MCP server. It lets an AI assistant (Claude, Cursor, VS Code, Codex and other MCP clients) read what Hoot Lens recorded on your websites: visits, replays, heatmaps, funnels, traffic, findings and changes. The assistant sees only what your own Hoot Lens account can see, and only the sites (projects) and scopes you allow.

You can run it two ways:

- **Locally over stdio** with `npx -y @hootlens/mcp` (this package). For clients that can launch a stdio server.
- **Hosted** at `https://mcp.hootlens.com/mcp`, for clients that support remote MCP servers. Nothing to install; you sign in with Hoot Lens in your browser.

This is the client guide from release 1.0.2. The hosted server can offer newer tools than this local package. Inspect tools/list on your actual connection; see the repository README for the current release boundary.

## Requirements

- Node.js 20 or newer (local server only).
- A Hoot Lens account with at least one project.

## Sign in

Pick one.

**Browser sign-in (recommended).** Run this once:

```sh
npx -y @hootlens/mcp login
```

Your browser opens Hoot Lens. Choose the projects and permissions to share, and approve. The sign-in is saved in the macOS Keychain, the Linux Secret Service (libsecret), or, where those are not available, a file (`~/.config/hootlens-mcp/credentials.json`, or `%APPDATA%\hootlens-mcp\credentials.json` on Windows). On POSIX systems the fallback uses owner-only mode flags. On Windows it relies on inherited profile ACLs; the package does not enforce an owner-only Windows ACL. Tokens are never printed.

```sh
npx -y @hootlens/mcp whoami   # who is signed in, scopes, projects, token expiry
npx -y @hootlens/mcp logout   # delete the saved sign-in and end it at the server
```

`login --scopes read,replay` asks for fewer permissions (default: `read replay annotate`). On a remote machine without a browser, `login` prints the link; open it on a machine that can reach the CLI on `127.0.0.1` (for example through an SSH port forward of the port it names).

How long it lasts: access tokens last 1 hour and are renewed automatically. The renewal token lasts 30 days from its last use, so if you do not use the server for 30 days you must run `login` again. Disconnecting the app under Connected apps in the Hoot Lens dashboard ends the sign-in immediately. When a sign-in has ended, the server tells you to run `npx -y @hootlens/mcp login`.

**Access key.** In the dashboard, open Settings, AI assistant, and create a key for one project. Set it as `HOOTLENS_PAT` in the client's environment. When `HOOTLENS_PAT` is set it is used instead of the saved sign-in. A key belongs to one project and you can revoke it in the dashboard at any time. Prefer the browser sign-in on a personal machine and keys for CI or shared setups.

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

Two optional query parameters narrow what a hosted connection offers. They never widen what you approved.

| Parameter | Example | Effect |
| --- | --- | --- |
| `project` | `https://mcp.hootlens.com/mcp?project=YOUR_PROJECT_ID` | Tools default to this project. |
| `toolsets` | `https://mcp.hootlens.com/mcp?toolsets=read,replay` | Offer only these toolsets. |

Combine them with `&`: `https://mcp.hootlens.com/mcp?project=YOUR_PROJECT_ID&toolsets=read`. Put the URL in quotes in a shell.

For an investigation connection, select `--toolsets read,replay`. Read scopes alone still offer default install and feedback tools, which can submit setup requests or issues.

## Toolsets

Toolsets group tools so an assistant is offered only what it needs. Set them with `--toolsets read,replay` or `HOOTLENS_TOOLSETS=read,replay`.

| Toolset | What it offers |
| --- | --- |
| `read` | Sites (projects), visits, recording lists, narratives, heatmaps, findings, traffic, goals, funnels, changes, weekly summary. |
| `replay` | Raw replay events and clicks of one recording. Needs the `replay` scope. |
| `annotate` | Add notes to recordings and log changes. Needs the `annotate` scope. |
| `install` | Install tags per platform and the install checker. |
| `feedback` | Report bugs and ideas to the Hoot Lens team and follow your reports. |
| `issues` | Hoot Lens staff triage tools. Needs the `triage` scope. |
| `default` | `read`, `replay`, `install`, `feedback`, plus `annotate` when your credential holds that scope. |
| `all` | Every toolset your credential can use. |

A toolset your credential cannot use is not offered, and the server says so on stderr.

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

The package follows Semantic Versioning. Tool names and arguments do not change within a major version; new tools and optional arguments can appear in a minor version. See `CHANGELOG.md`. `npx -y @hootlens/mcp` resolves the latest npm dist-tag, which can change major version; pin with `npx -y @hootlens/mcp@1.0.2` if you need a fixed version. The server supports MCP protocol versions 2026-07-28 and 2025.

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
