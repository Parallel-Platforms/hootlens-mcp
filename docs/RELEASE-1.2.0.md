# MCP 1.2.0 release record

`@hootlens/mcp` 1.2.0 is published with the doctor command and npm provenance. The official MCP Registry accepted `com.hootlens/mcp` 1.2.0 with active status. Publication and provenance do not establish a security certification or compatibility with every client.

| Evidence | Exact release |
| --- | --- |
| npm package | [`@hootlens/mcp` 1.2.0](https://www.npmjs.com/package/@hootlens/mcp/v/1.2.0) |
| Public source | [`c1f4684c1199490b17e789d3767fc5162810e3ca`](https://github.com/Parallel-Platforms/hootlens-mcp/commit/c1f4684c1199490b17e789d3767fc5162810e3ca) |
| Release tag | [`mcp-v1.2.0`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/mcp-v1.2.0) |
| Publication workflow | [`release.yml`, run 38661405752, attempt 1](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/38661405752/attempts/1) |
| npm attestation | [Registry signatures and provenance](https://registry.npmjs.org/-/npm/v1/attestations/@hootlens%2fmcp@1.2.0) |
| MCP Registry | [`com.hootlens/mcp` 1.2.0](https://registry.modelcontextprotocol.io/v0.1/servers/com.hootlens%2Fmcp/versions/1.2.0) |

Verification checked the exact tarball's integrity and five regular allowlisted files. Its provenance binds the public repository, commit, tag and workflow run above. An isolated install with lifecycle scripts disabled passed `npm audit signatures`, verifying one registry signature and one attestation. The installed CLI reported `1.2.0`. Its doctor checked production public readiness and OAuth identity, then returned the expected signed-out recovery without writing credentials or reading customer data.

| Artifact identity | Value |
| --- | --- |
| npm `gitHead` | `c1f4684c1199490b17e789d3767fc5162810e3ca` |
| npm integrity | `sha512-aZHeaudJqEgxWXy9qCb5vJbSkRqdG7oQZEi6tT9MD2Rdm0j4sP3Iyy2tQo1Mt76r+Ks3rk+ClzHF7fv+/g55Xg==` |
| Tarball SHA-256 | `1907734e5d3f9a66d42b25dfd6825b541c708ad3a8ae7b6eb160ec2b1a19cfac` |

Check configuration, or explicitly include an existing sign-in's access metadata:

```sh
npx -y @hootlens/mcp@1.2.0 doctor --toolsets read,replay
npx -y @hootlens/mcp@1.2.0 doctor --authenticated --toolsets read,replay --json
```

Doctor does not refresh credentials, change grants, read recordings or call MCP tools. A configuration or access check does not prove a completed investigation. See the [connection instructions](../README.md#connect-your-own-site) and [client verification record](CLIENTS.md).

The hosted service releases separately and was verified at 1.1.0 during this release. The [1.1.0 security packet](security/release-1.1.0/README.md) remains specific to 1.1.0. The imported source inventory and its preparation-time changelog are frozen build inputs; this record captures subsequent publication without rewriting those hashes or either published artifact. The initial npm metadata processing delay was observed before final verification; publication was not retried.
