# Source provenance

This snapshot follows the published `@hootlens/mcp` 1.0.2 release, not the monorepo's later development branch. The npm package reports `gitHead` as `3431912d0c5c39f6eaa6f0f314627a9957a34c13`, the commit tagged `mcp-v1.0.2`. [SOURCE.json](SOURCE.json) records that identity, the npm tarball integrity and SHA-256 hashes of the server source, required shared source, registry manifest, license and changelog. Hashes normalize CRLF to LF so a Windows checkout and a Linux checkout verify the same text.

The server files in `src` and shared files in `packages/core` come from that release without logic edits. The local build script comes from the release's two-bundle builder with paths changed for this repository. The root manifest adds the shared workspace and verification dependencies, changes build commands and sets `private: true`. Generated bundles can differ from npm's bytes with different build dependencies; source hashes are not npm provenance or a binary reproducibility claim.

The earlier public snapshot included viewer and configuration development files not shipped in the local npm release. Those are removed here so the source, version and installation instructions agree. Hosted server capabilities can still be newer than this local package.

## Synchronize a future release

1. Fetch the exact release tag from the owner's monorepo. Compare its commit with `npm view @hootlens/mcp@VERSION gitHead dist.integrity --json`. Do not export a development branch under a published version.
2. Copy `services/mcp/src`, the shared `packages/core` source required by it, `server.json`, `LICENSE` and `CHANGELOG.md`. Review the complete file set for secrets and customer data. Preserve the source mirror's build, test and CI files.
3. Update the root manifest and dependency lock from that release, keeping this mirror private. Adapt build paths and include any new shared runtime dependencies. Regenerate the normalized hashes and release identity in `SOURCE.json` from the tagged source, rather than hashing an unverified working tree.
4. Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, and check the built executable's version. Review the actual public CI matrix, the installed npm artifact and the hosted endpoint separately.
5. Open a public repository PR. Merge after independent review and passing required checks. Synchronize official registry metadata with the already published npm version, using the owner's existing domain proof. Do not republish npm from this repository.

Neither a local fixture test nor a matching version proves production authorization, customer capture, signed-in client compatibility or directory acceptance. Keep those checks in their own evidence records.
