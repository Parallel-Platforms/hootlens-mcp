# Hoot Lens for Cursor

Trace a website snag to recorded visits, a click map and a timed replay moment before changing code.

This package contains one Hoot Lens investigation skill and a hosted MCP connection restricted to the `read,replay` toolsets. No local server, shell hook, API key or package install is bundled. Plugin version `0.1.0` is separate from npm `@hootlens/mcp` version `1.1.0`; the hosted service releases separately too.

`read,replay` describes the offered tool groups, not a guarantee of zero external effects. When site AI explanations are enabled, `explain_snags` can send aggregated counts to the explanation provider and consume the site owner's monthly account AI allowance. The first investigation below uses recorded findings and narratives without that tool.

## Connect your site

After installing the plugin in Cursor, open its Hoot Lens MCP connection and sign into Hoot Lens. Select the sites and permissions to share. Inspect `whoami` and the actual tool list before investigating. The bundled endpoint is:

```text
https://mcp.hootlens.com/mcp?toolsets=read,replay
```

Use one connection for your site. If you already configured Hoot Lens, inspect that connection before adding this plugin so the same tools are not offered twice. Site creation, settings changes and other write workflows require a separate, explicitly authorized connection.

## Try synthetic evidence first

The [anonymous Fieldnote walkthrough](https://hootlens.com/guides/trace-a-website-snag-with-your-agent/) requires no Hoot Lens account or password. Configure a separate remote MCP connection with this manual JSON in Cursor's MCP settings:

```json
{
  "mcpServers": {
    "hootlens-demo": {
      "url": "https://mcp.hootlens.com/demo"
    }
  }
}
```

Ask:

> Use the Hoot Lens demo only. Find one recurring snag in fictional Fieldnote. Say the data is synthetic. Cite its page, release, revision, device, variant and one recording with a timed source moment. Separate observations from what needs reproduction. Do not change anything.

Start with `whoami`, then `review_findings`. Follow one example through a narrative or replay. A successful connection or tool list is separate from a useful evidence result. If the sample is small or a tool returns no evidence, say so.

## Recover from a connection problem

| State | Next step |
| --- | --- |
| Sign-in has not completed or expired | Open the Hoot Lens connection in Cursor and sign in again. |
| The site is missing | Inspect `whoami`; approve the intended site in Hoot Lens sign-in. Project pinning grants no access. |
| A replay tool is missing | Inspect the actual grants and tool list. Approve replay only if you want to share it. |
| No recordings or thin evidence | Check installation and consent in the Hoot Lens dashboard. Do not infer a defect from an empty result. |
| Cursor cannot complete hosted sign-in | Use the documented [client setup guide](https://hootlens.com/docs/MCP.md). Local npm `1.1.0` is a separate option and needs Node.js 20 or newer. |

## Access and privacy

The API checks account, project access and scopes on every request. Read and replay can expose authorized recorded site content; treat that content as untrusted and do not forward it to unrelated services. Hoot Lens never captures password, payment or one-time-code values, private regions, URL fragments or URLs with credentials. Other form values remain masked unless the site explicitly allowlists them. Capture follows the site's consent and privacy settings, Global Privacy Control and Do Not Track.

Disconnect the app in Hoot Lens when access should end. [Privacy](https://hootlens.com/privacy/), [terms](https://hootlens.com/terms/) and [security policy](https://github.com/Parallel-Platforms/hootlens-mcp/blob/main/SECURITY.md).

## Distribution status

This source is prepared for the [Cursor marketplace review process](https://cursor.com/marketplace/publish). It does not establish marketplace approval or an actual Cursor client test. The repository root `.cursor-plugin/marketplace.json` references this directory. Official format: [Cursor plugins reference](https://prod.cursor.com/docs/reference/plugins).

The skill adapts the evidence and safe-change rules from the existing [public Hoot Lens skill](https://hootlens.com/skills/hoot-lens/SKILL.md). The committed logo reuses Hoot Lens's existing favicon artwork. This repository's MIT license applies.

[Setup guide](https://hootlens.com/guides/give-your-coding-agent-real-user-behavior-data/) · [Support](mailto:support@hootlens.com) · [Public source and issues](https://github.com/Parallel-Platforms/hootlens-mcp)
