# Installing the Hoot Lens MCP server

These steps are for an AI agent (such as Cline) setting up published Hoot Lens MCP 1.1.0 for a user. See the [versioned release record](docs/RELEASE-1.1.0.md) for source and provenance evidence.

## 1. Check requirements

- Node.js 20 or newer: run `node --version`.
- To try it without an account, skip to step 4 (demo).

## 2. Sign the user in

Run this once. It opens the browser so the user can choose which Hoot Lens projects and permissions to share:

```sh
npx -y @hootlens/mcp@1.1.0 login --scopes read,replay
```

Confirm with:

```sh
npx -y @hootlens/mcp@1.1.0 whoami
```

If the user prefers an access key instead, they create one in the Hoot Lens dashboard (Settings, AI assistant) and supply it through the client's private environment as `HOOTLENS_PAT`. Never invent a key, print it, or save it in committed source. A set `HOOTLENS_PAT` overrides the saved sign-in.

## 3. Add the server to Cline

Add this entry to `cline_mcp_settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "hootlens": {
      "command": "npx",
      "args": ["-y", "@hootlens/mcp@1.1.0", "--toolsets", "read,replay"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

With an access key instead of the browser sign-in:

```json
{
  "mcpServers": {
    "hootlens": {
      "command": "npx",
      "args": ["-y", "@hootlens/mcp@1.1.0", "--toolsets", "read,replay"],
      "env": { "HOOTLENS_PAT": "hl_pat_..." },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Optional: add `"--project", "YOUR_PROJECT_ID"` to `args` to pin one site.

## 4. Demo without an account

To try Hoot Lens on sample data from a fictional app, with no sign-in, use the hosted demo server (read and replay tools only):

```json
{
  "mcpServers": {
    "hootlens-demo": {
      "type": "streamableHttp",
      "url": "https://mcp.hootlens.com/demo",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## 5. Verify

On the hosted demo, call the `whoami` tool and confirm it identifies synthetic Fieldnote data. For the local package, run `npx -y @hootlens/mcp@1.1.0 whoami` to check the saved sign-in, then call the MCP `whoami` tool through the actual connection. Call `list_projects` and pick the site that belongs to the user's repository. Inspect `tools/list`: hosted and local releases can differ. These are configuration instructions, not a claim that every client has been tested.

## Troubleshooting

- "Sign-in has ended": run `npx -y @hootlens/mcp@1.1.0 login --scopes read,replay` again.
- No projects listed: check `whoami` for the current sign-in and shared projects. Sign in again to share an existing site, and check current membership if access changed. If the account has none, the owner can [explicitly authorize an agent to create a site](README.md#create-a-site-through-an-authenticated-agent), or create one at https://hootlens.com.
- Full docs: https://hootlens.com/docs/MCP.md
