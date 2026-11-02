# MCP 1.4.1 release record

`@hootlens/mcp` 1.4.1 was published on 2 November 2026 UTC with first-site recovery, resumable website setup links, and consent-aware installation guidance. Publication and provenance do not establish completed customer setup, compatibility with every client, or a security certification. The hosted service releases separately.

| Evidence | Exact release |
| --- | --- |
| npm package | [`@hootlens/mcp` 1.4.1](https://www.npmjs.com/package/@hootlens/mcp/v/1.4.1) |
| npm publication time | `2026-11-02T00:57:10.656Z` |
| Public source | [`0bd21ba9266da6388533463a35aefe2afff0ca65`](https://github.com/Parallel-Platforms/hootlens-mcp/commit/0bd21ba9266da6388533463a35aefe2afff0ca65) |
| Source review and CI | [PR 20](https://github.com/Parallel-Platforms/hootlens-mcp/pull/20), [Linux/Windows Node 20/22 validation of the public merge](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/41367247325) |
| Release tag | [`mcp-v1.4.1`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/mcp-v1.4.1) |
| Publication workflow | [`release.yml`, run 41369681238, attempt 1](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/41369681238/attempts/1) |
| npm attestation | [Registry signatures and provenance](https://registry.npmjs.org/-/npm/v1/attestations/@hootlens%2fmcp@1.4.1) |
| Official MCP Registry | [`com.hootlens/mcp` 1.4.1](https://registry.modelcontextprotocol.io/v0.1/servers/com.hootlens%2Fmcp/versions/1.4.1), active |

Verification downloaded the exact npm tarball and matched its SHA-512 integrity to registry metadata. It checked exactly five regular allowlisted files, the expected package identity, and the reviewed README, license, and changelog at the public release commit. The staged package contains no development dependencies, runtime dependency declarations, workspace configuration, or lifecycle scripts. The executable bundles its dependencies and their notices.

The provenance subject matches the downloaded tarball and binds the public repository, commit, release tag, workflow, and invocation above. An isolated installation with lifecycle scripts disabled passed `npm audit signatures`, verifying one registry signature and one attestation. The installed CLI and MCP server both reported `1.4.1`.

The official Registry accepted publication at `2026-11-02T01:05:34.237197Z`. Its exact-version and latest endpoints both returned active 1.4.1 with `isLatest: true`, the expected server name, and the matching npm package version. The existing HTTP domain proof was matched to the established signing key before renewing the cached Registry login. The signing key was not rotated and remains outside Git.

A real MCP SDK connection to the installed package discovered forty customer tools using a synthetic read/replay grant. Site creation was advertised with `read` and `sites:create` in both top-level and compatibility OAuth metadata; staff triage was absent. A creation attempt received the fixture API's 403 refusal and created no website. `whoami` and an empty `list_projects` response stayed connected, returned the resumable setup URL, and issued no reconnection challenge. These checks used loopback fixtures, with no customer credentials, recordings, email, browser login, or production data mutation.

All seventeen standalone source and release tests passed locally and in each Linux/Windows Node 20/22 validation job. Compiled SDK regressions also exercised later site discovery and refused unconfigured consent platform categories before fetching a snippet. The standalone dependency installation reported zero vulnerabilities during verification. This covers the standalone development dependency graph, not the hosted service or the entire Hoot Lens product.

| Artifact identity | Value |
| --- | --- |
| npm `gitHead` | `0bd21ba9266da6388533463a35aefe2afff0ca65` |
| npm integrity | `sha512-BO0U8KrNl7GsKUlsVF/ZM8AjoqbADsihUsXXqp5C3ynmfSDw4fNI8/SCt/Fsgu7shIVa7IePWIXYdWJiXzhuJw==` |
| Tarball SHA-256 | `3e8a5532ec267b5a564124b2aba547c84f20a7b8a44051227cc900a8a0366004` |

The imported [source inventory](SOURCE.json) identifies monorepo commit `f51a056add607b5bf8847dd03f510447874246f6` and all 86 normalized MCP and pure-core source files. Its preparation-time status and Unreleased changelog remain immutable build inputs. This record captures later publication without rewriting those hashes or the published artifact. npm processing briefly delayed exact-version availability after the workflow succeeded; only read and installation verification were retried, never publication. Earlier release records retain their own source identities and verification scope.
