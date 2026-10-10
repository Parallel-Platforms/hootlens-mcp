# Security scan evidence, 10 October 2026

This is a bounded investigation of the local published package. It does not establish hosted authorization, production security, browser sign-in behavior, customer capture safety or compatibility with every client. [SECURITY-EVIDENCE.json](SECURITY-EVIDENCE.json) records selected fields from the actual scans; it is not a signed scanner certificate.

The [MCPRush listing](https://mcprush.com/hootlens/hoot-lens-mcp#security) still displayed 1.0.1, scanned 9 October, during this review. The full report toggle exposed the score vector but no finding details. Local scans with the official `mcptrustchecker` 1.14.0 reproduced the listing's 93 client score, 100 threat score and surface digest for 1.0.1, and found the same source-level results for 1.0.2:

```sh
npx -y mcptrustchecker@1.14.0 scan @hootlens/mcp@1.0.1 --online --json
npx -y mcptrustchecker@1.14.0 scan @hootlens/mcp@1.0.2 --online --json
```

Both source scans found `MTC-SRC-001`, AJV schema-validator compilation using `new Function` in the bundled SDK, and `MTC-SRC-002`, process spawning in the CLI's OS browser and credential-store helpers. Both are capability observations under the [scanner methodology](https://github.com/illia-haidar/mcptrustchecker/blob/main/docs/methodology.md), with no threat penalty. The source client score subtracts six points for high capability and one for public source without npm provenance. The listing's label "2 threat" is inconsistent with that classification. Presence of these primitives in the bundle is real; the scan does not establish that an MCP tool can execute an arbitrary command.

The source scans read implementation and package metadata but enumerated zero tools, prompts or resources and did not connect to a live transport. Their shared surface digest is not a tarball hash or proof that versions 1.0.1 and 1.0.2 have identical bytes. Version 1.0.2 registry metadata had signatures but no provenance attestation at review time.

A separate runtime scan used the exact downloaded 1.0.2 npm tarball, independently matched to its registry SHA-512 integrity before execution. Its CLI ran against a synthetic `127.0.0.1` HTTP fixture with a fake access token, no stored sign-in, and `--toolsets all`. The fixture reported read, replay, annotate and triage scopes; it exposed no real project or customer data. The scan enumerated **32 tools, 5 prompts and 4 resources**, with zero findings and no code-execution tool tag. Only GET `/v1/access` and `/v1/projects` were observed against the fixture. No browser login, keychain access or production API request was needed.

The runtime scan read live tool/prompt/resource metadata, not implementation source or npm package metadata. Its 97 client score omits the source-only primitives and publisher-verification term, so it supplements the source scan and cannot replace its 93 score. Tool enumeration is not a test of every tool's effects. Lexical classification also misses some capabilities, so neither zero findings nor the moderate runtime label proves absence of risk. The runtime digest describes that particular acquired surface and command, including temporary execution paths; it is not a portable artifact identity.

No source code, package version, npm settings or public listing was changed during the investigation. The [public release preparation](RELEASING.md) is a subsequent proposed way to establish provenance for a new reviewed version. It has not added provenance to 1.0.2 or refreshed MCPRush.
