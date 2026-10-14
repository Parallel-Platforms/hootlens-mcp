# MCP 1.1.0 release record

`@hootlens/mcp` 1.1.0 was published on 14 October 2026 from this public repository with npm provenance. The official MCP Registry subsequently accepted `com.hootlens/mcp` 1.1.0 with active status. These are publication facts for this exact version, not a security certification or a claim that every MCP client has been tested.

## Inspect the release

| Evidence | Exact release |
| --- | --- |
| npm package | [`@hootlens/mcp` 1.1.0](https://www.npmjs.com/package/@hootlens/mcp/v/1.1.0) |
| Public source | [`f06d28882ce38f9bce4d4b55d31c61189cc92415`](https://github.com/Parallel-Platforms/hootlens-mcp/commit/f06d28882ce38f9bce4d4b55d31c61189cc92415) |
| Release tag | [`mcp-v1.1.0`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/mcp-v1.1.0) |
| Build and publication | [`release.yml`, run 38638121401, attempt 1](https://github.com/Parallel-Platforms/hootlens-mcp/actions/runs/38638121401/attempts/1) |
| npm attestation | [Registry signature and provenance bundle](https://registry.npmjs.org/-/npm/v1/attestations/@hootlens%2fmcp@1.1.0) |
| MCP Registry | [`com.hootlens/mcp`, version 1.1.0](https://registry.modelcontextprotocol.io/v0.1/servers/com.hootlens%2Fmcp/versions/1.1.0) |

The release verification downloaded the exact npm artifact, checked its integrity, ran `npm audit signatures` successfully, and verified the installed CLI reported `1.1.0`. The attestation identifies this public repository, source commit, tag and workflow run. The five-file npm payload contains the CLI bundle, package manifest, README, license and changelog, with no lifecycle scripts or runtime dependencies.

| Artifact identity | Value |
| --- | --- |
| npm `gitHead` | `f06d28882ce38f9bce4d4b55d31c61189cc92415` |
| npm integrity | `sha512-qzaQZ7am4Ib5IjTR+8YgDL5CMsAaB4YhoAwcPOfJSxb7aa9mm0BDni8TyL18KYjSbEVcBmu4zNsIiUlfPe3sKA==` |
| Tarball SHA-256 | `3e1dcb8ff564df456f5394267d4c802890182f4127c409e1191205a20fc08cc7` |

To inspect version metadata without connecting to a site:

```sh
npm view @hootlens/mcp@1.1.0 version gitHead dist.integrity dist.attestations --json
```

Follow the [scoped connection instructions](../README.md#connect-your-own-site), or try the [synthetic demo without an account](../README.md#try-a-first-investigation-without-an-account). The hosted service can release separately; use `whoami` and `tools/list` on your actual connection.

## Keep evidence specific

- The [source inventory](SOURCE.json) and [imported changelog](../CHANGELOG.md) are frozen build inputs. Their preparation-time pending fields describe the source import. This record captures the subsequent publication without rewriting those hashes or the already published artifact.
- [Historical scanner results](SECURITY-EVIDENCE.md) cover 1.0.1 and 1.0.2. Their scores and 1.0.2 runtime enumeration do not transfer to 1.1.0.
- Local synthetic fixture tests, the installed CLI check and provenance do not establish production authorization, customer capture safety, every tool's effects or compatibility with every client. See [client verification notes](CLIENTS.md#verification-notes).
- Provenance identifies where and how the package was built. It does not establish that the package is free of vulnerabilities. Report concerns through the [security policy](../SECURITY.md).
