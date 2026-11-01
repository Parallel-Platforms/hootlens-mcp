# MCP 1.4.0 release record

`@hootlens/mcp` 1.4.0 was published on 1 November 2026 UTC with stable customer-tool discovery, explicit per-tool OAuth policies, and npm provenance. A tool's presence in the catalog grants no permission to execute it. Publication and provenance do not establish a security certification, customer capture, or compatibility with every client.

| Evidence | Exact release |
| --- | --- |
| npm package | [`@hootlens/mcp` 1.4.0](https://www.npmjs.com/package/@hootlens/mcp/v/1.4.0) |
| Public source | [`1527928d5325be262f8f5765fa7620d5032713ea`](https://github.com/Parallel-Platforms/hootlens-mcp/commit/1527928d5325be262f8f5765fa7620d5032713ea) |
| Source review and CI | [PR 18](https://github.com/Parallel-Platforms/hootlens-mcp/pull/18), [Linux/Windows Node 20/22 validation](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/41281775812) |
| Release tag | [`mcp-v1.4.0`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/mcp-v1.4.0) |
| Publication workflow | [`release.yml`, run 41281845895, attempt 1](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/41281845895/attempts/1) |
| npm attestation | [Registry signatures and provenance](https://registry.npmjs.org/-/npm/v1/attestations/@hootlens%2fmcp@1.4.0) |
| Official MCP Registry | [`com.hootlens/mcp` 1.4.0](https://registry.modelcontextprotocol.io/v0.1/servers/com.hootlens%2Fmcp/versions/1.4.0), active |

Verification downloaded the exact npm tarball and matched its SHA-512 integrity to registry metadata. It checked five regular allowlisted files, the expected package identity, and the reviewed README, license, and changelog. The provenance subject matches that tarball and binds the public repository, commit, tag, workflow, and invocation above. An isolated install with lifecycle scripts disabled passed `npm audit signatures`, verifying one registry signature and one attestation.

The official Registry accepted publication on 1 November 2026 at 06:45:49.885419 UTC. Its exact-version and latest endpoints returned active 1.4.0 with `isLatest: true` during verification. Routine HTTP namespace authentication was renewed using the existing signing key, after its public key was matched to the unchanged hosted domain proof. The private key remains outside Git.

The installed CLI and server reported `1.4.0`. A real MCP SDK connection to the installed package discovered forty customer tools with a synthetic read/replay grant, including site creation, annotations, and configuration actions. The wire response declared `read` and `sites:create` for creation in both top-level and compatibility metadata. Staff triage was absent. A creation attempt received the fixture API's 403 refusal and created no site. These checks used only loopback fixtures, with no customer credentials, recordings, browser login, or production data mutation.

All sixteen standalone source and release tests passed locally and in each Linux/Windows Node 20/22 validation job. The standalone dependency audit reported zero vulnerabilities during verification; Zod was locked to 4.6.7. This audit covers the standalone development dependency graph, not the hosted service or the entire Hoot Lens product.

| Artifact identity | Value |
| --- | --- |
| npm `gitHead` | `1527928d5325be262f8f5765fa7620d5032713ea` |
| npm integrity | `sha512-5zPuvwZnyAxHMobbGJGk+PKhW5z8NEvTv3+c4bt8zOsRZZV75ARhLz3aCLKPbmdYqs4hbQcKFoGRer9FWtpRQw==` |
| Tarball SHA-256 | `c1e6c01ceb6f6aa8679a2a31c60a48edb955134220856941035734aa1b4154cd` |

Customer tools remain discoverable when optional scopes are missing. Execution continues to require credential scopes and current site permissions. Site creation additionally requires explicit account-wide approval, a verified owner, an available site slot, and a stable retry key. Staff-only, demo, and project-pinned restrictions remain in place. The hosted service releases separately; a successful standalone fixture does not prove a remote client's OAuth upgrade or completed first-site setup.

The imported [source inventory](SOURCE.json) identifies the separate monorepo source commit and retains its preparation-time status. Its Unreleased changelog remains an immutable build input. This record captures later publication without rewriting those hashes or the published artifact. Initial npm processing delayed exact-version availability; only read/install verification was retried, never publication. The [1.3.0 release record](RELEASE-1.3.0.md) and historical security evidence retain their own scope.
