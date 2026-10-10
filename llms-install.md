# Installing the Hoot Lens MCP server

These steps are for an AI agent (such as Cline) setting up Hoot Lens for a user.

## 1. Check requirements

- Node.js 20 or newer: run `node --version`.
- To try it without an account, skip to step 4 (demo).

## 2. Sign the user in

Run this once. It opens the browser so the user can choose which Hoot Lens projects and permissions to share:

```sh
npx -y @hootlens/mcp login
```

Confirm with:

```sh
npx -y @hootlens/mcp whoami
```

If the user prefers an access key instead, they create one in the Hoot Lens dashboard (Settings, AI assistant). Ask them for it; never guess or invent one. It goes in `HOOTLENS_PAT` below.

## 3. Add the server to Cline

Add this entry to `cline_mcp_settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "hootlens": {
      "command": "npx",
      "args": ["-y", "@hootlens/mcp"],
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
      "args": ["-y", "@hootlens/mcp"],
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

Call the `whoami` tool. It returns the signed-in user, scopes and projects. Then call `list_projects` and pick the site that belongs to the user's repository.

## Troubleshooting

- "Sign-in has ended": run `npx -y @hootlens/mcp login` again.
- No projects listed: the account has no Hoot Lens site yet. Create one at https://hootlens.com.
- Full docs: https://hootlens.com/docs/MCP.md
