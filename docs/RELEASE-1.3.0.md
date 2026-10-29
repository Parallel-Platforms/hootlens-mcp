# MCP 1.3.0 release record

`@hootlens/mcp` 1.3.0 is published with read-only conversion outcome reports, replay preservation coverage, and npm provenance. Publication and provenance do not establish a security certification, customer capture, or compatibility with every client.

| Evidence | Exact release |
| --- | --- |
| npm package | [`@hootlens/mcp` 1.3.0](https://www.npmjs.com/package/@hootlens/mcp/v/1.3.0) |
| Public source | [`67438a2e00c3125b8659008b13182c95a45a089c`](https://github.com/Parallel-Platforms/hootlens-mcp/commit/67438a2e00c3125b8659008b13182c95a45a089c) |
| Source review and CI | [PR 16](https://github.com/Parallel-Platforms/hootlens-mcp/pull/16), [Linux/Windows Node 20/22 validation](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/40892684261) |
| Release tag | [`mcp-v1.3.0`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/mcp-v1.3.0) |
| Publication workflow | [`release.yml`, run 40896800542, attempt 1](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/40896800542/attempts/1) |
| npm attestation | [Registry signatures and provenance](https://registry.npmjs.org/-/npm/v1/attestations/@hootlens%2fmcp@1.3.0) |
| Official MCP Registry | Publication pending. The existing Registry sign-in must be renewed. |

Verification downloaded the exact npm tarball, checked its SHA-512 integrity against npm metadata, and confirmed five regular allowlisted files with the expected public package identity. The provenance subject matches that tarball and binds the public repository, commit, tag, and workflow run above. An isolated install of `@hootlens/mcp@1.3.0` with lifecycle scripts disabled passed `npm audit signatures`, verifying one registry signature and one attestation.

The installed CLI and stdio server reported `1.3.0`. A real MCP SDK client discovered `get_conversion_report` as a read-only tool and called it against a loopback API with synthetic data. The check verified project pinning, separate EUR, JPY, KWD, and USD minor-unit values, and GET-only requests. It did not use customer credentials or recordings, or exercise a signed-in client UI.

| Artifact identity | Value |
| --- | --- |
| npm `gitHead` | `67438a2e00c3125b8659008b13182c95a45a089c` |
| npm integrity | `sha512-Zmp9Cr0jVQY0sC130NM91PTVzVehBki3YnXIf3UyxmDy6ttR3OdBumJisTmfJMBN6wj4QBpd1q+y0ISrtzrqnQ==` |
| Tarball SHA-256 | `022e5d95ccb02e27a5a1167e8a8580b0c48805ac3e8d9b2475d4a03243cfbd44` |

`get_conversion_report` reads original visit attribution, converting visits, distinct outcome occurrences, browser/server provenance, and separate currency totals. Its measurement checkpoint and coverage disclose unavailable history. MCP does not submit conversions. Replay metadata and inline viewers distinguish preserved, pending, partial, late, legacy, disabled, and missing preservation coverage.

The hosted service releases separately. The [client verification record](CLIENTS.md) retains its own versioned scope. The imported [source inventory](SOURCE.json) and preparation-time changelog remain frozen build inputs; this record captures later publication without rewriting their hashes or published artifacts. npm metadata propagation initially delayed the exact-version install and attestation endpoint. Only read/install verification was retried, never publication.
