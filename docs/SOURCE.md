# Source identity and synchronization

This checkout prepares @hootlens/mcp 1.2.0 from immutable monorepo commit `b6601dabaa908de7fae5aab6a20d51d914d3a8e2`. [SOURCE.json](SOURCE.json) records SHA-256 hashes for all 80 tracked MCP/core source, registry, license and changelog files. Every inventory file comes from that one commit. Hashes normalize CRLF to LF. No private repository or credential is needed to build this checkout.

The prepared release adds the bounded doctor command, read-only diagnostic credential lookup, a provider/account-allowance disclosure and Registry repository metadata. It also imports the existing server-owned result observation hook and shared business-report schemas from that commit. The stdio launcher supplies no observer, so this package does not enable hosted usage collection. No API implementation, credentials, environment file or customer recording is exported.

The development manifest and lock stay private and versioned 1.2.0. Release preparation verifies the complete inventory, package identity and compiled version before staging a strict npm payload. The prepared snapshot and Unreleased changelog are source-state records, not a claim of npm publication, hosted deployment, client compatibility or security certification.

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
