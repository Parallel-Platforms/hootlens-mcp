# MCP 1.5.0 release record

`@hootlens/mcp` 1.5.0 was published on November 1, 2026 Pacific (`2026-11-02T04:35:29.424Z`) with improvement review, durable finding work, exact source-context inspection, and npm provenance. The hosted service releases separately. Package publication and provenance identify source and build; they do not establish customer outcomes, every client workflow, or a security certification.

## Source and publication

| Item | Verified identity |
| --- | --- |
| npm package | [`@hootlens/mcp` 1.5.0](https://www.npmjs.com/package/@hootlens/mcp/v/1.5.0) |
| Imported source | `402bf27fb94890819711656cd78866fbc76a0eae` |
| Reviewed public source | [`6f3130270fb89c3a421e6511b0392fdfe23be377`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/6f3130270fb89c3a421e6511b0392fdfe23be377) |
| Source validation | [Linux and Windows, Node 20 and 22](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/41388177701), all four jobs passed |
| Public source PR | [PR 22](https://github.com/Parallel-Platforms/hootlens-mcp/pull/22) |
| Public merge and npm gitHead | [`fb31894d80fd13cf71bcc5bb9870277472405ae1`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/fb31894d80fd13cf71bcc5bb9870277472405ae1) |
| Release tag | [`mcp-v1.5.0`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/mcp-v1.5.0) |
| Publication workflow | [Run 41389030970, attempt 1](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/41389030970/attempts/1) |
| npm attestation | [Registry signatures and provenance](https://registry.npmjs.org/-/npm/v1/attestations/@hootlens%2fmcp@1.5.0) |
| Official MCP Registry | [`com.hootlens/mcp` 1.5.0](https://registry.modelcontextprotocol.io/v0.1/servers/com.hootlens%2Fmcp/versions/1.5.0), active |

The reviewed source and public merge have identical trees. All 88 imported MCP and pure-core files were independently compared with the recorded immutable source commit after LF normalization. The development root stayed `private: true`. Fresh public-merge validation passed typecheck, build, all 18 tests, release preparation, and strict tarball verification. The clean-checkout receipt binds public commit `fb31894d80fd13cf71bcc5bb9870277472405ae1` separately from the imported source commit.

The release workflow rebuilt and tested inside a fresh public checkout, then published through the existing GitHub Actions trusted publisher. Only exact tag `mcp-v1.5.0` was added to the existing release environment; all five earlier tag policies and both active tag-protection rules were preserved. npm accepted publication once. Read and installation checks waited for the published version to become available; publication was not repeated.

## Published artifact verification

| Item | Value |
| --- | --- |
| Published at | `2026-11-02T04:35:29.424Z` |
| Tarball SHA-256 | `af4afb10e3cab7730e83fe03cdb83a18554f0dc4ebd02aff7b0009804dc1945b` |
| npm integrity | `sha512-Z1Rgry9QdB00VYDic9KN0Rd54TUP6ltIU5GHwnMByOphSMbiTWIEU9UWZKIJTO9cqlphJUKucfJdxIeY6KSCbw==` |
| Payload | `dist/cli.mjs`, `package.json`, `README.md`, `LICENSE`, and `CHANGELOG.md` |

The downloaded tarball matches npm’s SHA-512 integrity and the provenance subject. Its manifest names the public repository, requires Node 20 or later, and contains no lifecycle scripts, runtime dependencies, development dependencies, or workspaces. The provenance binds the exact public commit, tag, release workflow, and run attempt above.

An isolated installation with lifecycle scripts disabled reported CLI and server version 1.5.0. `npm audit signatures` verified one registry signature and one attestation. The installed package passed two SDK fixture checks:

- The default catalog exposed 45 customer tools and excluded staff triage. Discovery read connection metadata only.
- The five improvement tools advertised their actual read or read-plus-annotation policies. Workflow retries preserved identical PUT requests, and a read-only fixture request was refused without a mutation.
- Error inspection retained exact context and evidence windows. Funnel inspection retained entry context, windows, and ordered goal definitions.

These were compiled-package checks against isolated loopback fixtures. They used no customer credentials, recordings, conversations, email, or browser login, and they do not substitute for signed-in client or hosted API verification.

## Official Registry

The official Registry accepted publication at `2026-11-02T04:38:49.055976Z`. Exact-version and latest endpoints both returned active 1.5.0 with `isLatest: true`, the established server name, and matching npm package version.

The cached Registry login had expired. The existing Ed25519 identity was renewed only after its derived public key matched the hosted HTTP domain proof. The signing key remained outside Git, and neither the key nor its contents were printed or rotated.

The imported [source inventory](SOURCE.json) retains its preparation-time status and exact hashes. This record captures later publication without rewriting that inventory, the imported Unreleased changelog, or the immutable tag. Earlier release records retain their own source identities and evidence.
