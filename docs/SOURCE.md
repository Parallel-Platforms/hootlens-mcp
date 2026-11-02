# Source identity and synchronization

This checkout prepares @hootlens/mcp 1.5.0 from immutable monorepo commit `402bf27fb94890819711656cd78866fbc76a0eae`. [SOURCE.json](SOURCE.json) records SHA-256 hashes for all 88 MCP and pure-core source, registry, license, and changelog files. Every inventory file comes from that one commit. Hashes normalize CRLF to LF. The public checkout builds without the private repository or credentials.

The prepared release adds a bounded improvement feed and durable finding work: assignments, snoozes, dismissals, GitHub references, and atomic deployed-change records. Exact error and funnel inspection preserves source context and evidence windows; funnel definitions are checked before a report is returned. Read and annotation permissions remain separate, and a reported deployment does not establish measured improvement. No API implementation, environment file, credential, or customer recording is exported.

The development manifest and lock stay private and versioned 1.5.0. Release preparation verifies the complete inventory, package identity, and compiled version before staging the five-file npm payload. The prepared snapshot and Unreleased changelog describe build inputs, rather than npm publication, hosted deployment, client compatibility, or security certification. Later publication evidence belongs in a separate versioned release record. [Version 1.4.1](RELEASE-1.4.1.md) retains its own published source and verification evidence.

Published 1.1.0 remains identified by public commit [`f06d28882ce38f9bce4d4b55d31c61189cc92415`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/f06d28882ce38f9bce4d4b55d31c61189cc92415). Its unchanged [import inventory](https://github.com/Parallel-Platforms/hootlens-mcp/blob/mcp-v1.1.0/docs/SOURCE.json) preserves the original per-file update history. The [1.1.0 release record](RELEASE-1.1.0.md) records its later artifact integrity, attestation and publication. Historical evidence does not transfer to a new release.

Publish a new version only through the reviewed public [release procedure](RELEASING.md), after its own CI, independent review and exact-tag authorization. Record its signed publication evidence separately without rewriting the historical tag or inventory.

## Synchronize an already published source snapshot

These steps describe historical exports of versions published from the monorepo. New releases through public CI use [RELEASING.md](RELEASING.md) instead. Their npm `gitHead` and attestation identify the public build commit; the imported monorepo commit remains a separate source reference. Do not claim the two commit identities or independently built bundle bytes are identical.

1. Fetch the exact release tag from the owner's monorepo. Compare its commit with `npm view @hootlens/mcp@VERSION gitHead dist.integrity --json`. Do not export a development branch under a published version.
2. Copy `services/mcp/src`, the shared `packages/core` source required by it, `server.json`, `LICENSE` and `CHANGELOG.md`. Review the complete file set for secrets and customer data. Preserve the source mirror's build, test and CI files.
3. Update the root manifest and dependency lock from that release, keeping this mirror private. Adapt build paths and include any new shared runtime dependencies. Regenerate the normalized hashes and release identity in `SOURCE.json` from the tagged source, rather than hashing an unverified working tree.
4. Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, and check the built executable's version. Review the actual public CI matrix, the installed npm artifact and the hosted endpoint separately.
5. Open a public repository PR. Merge after independent review and passing required checks. Synchronize official registry metadata with the already published npm version, using the owner's existing domain proof. Historical exports do not authorize republishing an existing npm version. For future public releases, follow the separate [release procedure](RELEASING.md).

Neither a local fixture test nor a matching version proves production authorization, customer capture, signed-in client compatibility or directory acceptance. Keep those checks in their own evidence records.
