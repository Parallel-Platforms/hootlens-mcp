# Hoot Lens in the Claude directory

Hoot Lens already has a [published Community connector](https://claude.ai/directory/hoot-lens). The signed-in developer portal and public listing were observed on 14 October 2026. Preserve this entry rather than submitting another connector.

| Item | Observed state |
| --- | --- |
| Publisher | Parallel Platforms, LLC |
| Developer listing | `https://claude.ai/directory/manage/hoot-lens` |
| Public listing | `https://claude.ai/directory/hoot-lens` |
| Publication | Published, Community |
| Configured MCP endpoint | `https://mcp.hootlens.com/mcp` |
| Authentication | OAuth |
| Listed tool names | 43 in the portal snapshot, not a fresh protocol enumeration |
| Provider health | Healthy in the portal, not a Hoot Lens client test |
| Package/runtime version | Not exposed by this listing; do not infer npm `1.1.0` from publication |

Community is Anthropic's listing category following automated reviews. It is not Anthropic verification or a security guarantee. Provider usage counts are separate from Hoot Lens's authenticated investigation metrics and do not establish unique people, activation or successful fixes.

## Maintain the existing listing

`listing-copy.json` contains copy for the existing entry: a shorter one-liner, a synthetic first task, evidence limits, precise form masking and the connection guide. This preparation packet alone does not establish submission or publication. Check the existing developer portal and public listing for their current states. The configured endpoint, tool names, permissions, categories, supported product labels and authentication settings are outside this copy update.

After independent review, use the existing portal's Edit page to submit only the reviewed copy changes. The portal says edits are reviewed before replacing the live listing. Record submission, approval and public publication as separate states. Do not create another entry or claim a submitted update is already live.

## Reviewer walkthrough

Anonymous synthetic endpoint:

```text
https://mcp.hootlens.com/demo
```

No password, bearer token, customer login or private recording is needed. Use the [Fieldnote walkthrough](https://hootlens.com/guides/trace-a-website-snag-with-your-agent/), start with `whoami`, then follow a finding to its exact cohort and one recording with a timed source moment. Say the data is synthetic and separate observed behavior from hypotheses. Client execution evidence belongs in the coordinator's named-client verification record.

The existing listing uses the authenticated `/mcp` endpoint. For a manually configured investigation connection, the narrower `https://mcp.hootlens.com/mcp?toolsets=read,replay` selects read and replay tools. A toolset choice never expands an OAuth grant. Adding the optional site-creation permission is a separate owner-approved workflow.

## Source and review links

- [Claude directory publishing documentation](https://claude.com/docs/directory/publish)
- [Existing connector listing](https://claude.ai/directory/hoot-lens)
- [Hoot Lens package release `1.1.0`](https://github.com/Parallel-Platforms/hootlens-mcp/blob/main/docs/RELEASE-1.1.0.md)
- [Privacy](https://hootlens.com/privacy/), [terms](https://hootlens.com/terms/), [support](mailto:support@hootlens.com)

The directory's connector and npm package have separate release schedules. Package provenance identifies source and build origin, not a security certification. Keep client tests, provider validation and directory publication evidence separate.
