# MCP 1.1.0 security evidence

The exact published `@hootlens/mcp` 1.1.0 package was scanned and checked against a synthetic API on 14 October 2026. Runtime discovery exposed 44 tools, including explicitly annotated write and provider effects. Read/replay toolsets still include explanation generation, which can consume account allowance.

[Machine-readable evidence](evidence.json) records the observations and proof hashes. The [tool matrix](tools.json) lists actual annotations, groups and UI metadata. This is bounded package evidence, not a security certification of Hoot Lens or its hosted API.

The [release record](../../RELEASE-1.1.0.md) links the verified npm signature, provenance attestation, public source, and release workflow. Those publication checks are reused here. Provenance establishes build origin, not absence of vulnerabilities.

## Identify the artifact

| Field | Value |
| --- | --- |
| Package | [`@hootlens/mcp` 1.1.0](https://www.npmjs.com/package/@hootlens/mcp/v/1.1.0) |
| Source | [`f06d28882ce38f9bce4d4b55d31c61189cc92415`](https://github.com/Parallel-Platforms/hootlens-mcp/tree/f06d28882ce38f9bce4d4b55d31c61189cc92415) |
| Tarball SHA-256 | `3e1dcb8ff564df456f5394267d4c802890182f4127c409e1191205a20fc08cc7` |
| Scanner | [`mcptrustchecker` 1.17.0](https://github.com/illia-haidar/mcptrustchecker) |

Historical [1.0.x scanner results](../../SECURITY-EVIDENCE.md) retain their original scope and methodology. Their scores do not transfer to 1.1.0. This packet does not establish that any directory has refreshed its public report.

## Source findings

The offline scan read the shipped bundle and package metadata. It enumerated no tools, prompts or resources, and did not connect to the server. Its two findings concern capability rather than a threat penalty:

| Finding | Observed scope |
| --- | --- |
| `MTC-SRC-002`, high | Two process-launch calls in the bundled CLI, at lines 640 and 936. The scanner marks the executable as chosen at runtime and `toolInput: false`. |
| `MTC-SRC-001`, info | AJV validator compilation in the bundled SDK, attributed by its generated-code signature at line 29309. |

The process helpers serve browser sign-in and credential storage. The presence of those primitives is real. This scan does not establish that an MCP tool can run an arbitrary shell command, and the synthetic run does not exercise browser opening or credential storage. The scanner's source coverage does not analyze a runtime tool surface.

Because this was an offline tarball scan, the scanner did not verify npm provenance or apply its publisher-verification scoring term. The existing cryptographic release verification is separate evidence. Scanner scores are recorded with their methodology and coverage in the machine-readable packet; they should not be treated as comparable certification scores across versions or acquisition modes.

## Runtime discovery

The exact extracted CLI, an all-toolsets connection, and a fake all-scopes owner response exposed **44 tools, 6 prompts and 8 resources**. Offered counts depend on scopes, project pinning, toolsets and client filtering, so this is not a promise that every account sees 44 tools. The eight resources include four static guides, three app documents and one synthetic project. Resource templates are recorded separately.

The runtime scan found two medium capability observations, with no threat penalty under `mcptrustchecker-1.17`:

| Finding | Interpretation and limit |
| --- | --- |
| `MTC-FLOW-005` | Untrusted-input tools coexist with external-effect tools such as setup requests and explanations. Visitor and issue content must remain evidence, not instructions to execute. The scanner did not report a direct sensitive-data leak path. |
| `MTC-CAP-007` | `check_install` has a generic URL input schema. Its description restricts requests to the project's allowed sites, but the runtime metadata scan cannot inspect the API enforcement behind that promise. No arbitrary-host or production SSRF test was performed. |

Every discovered tool had explicit read-only, destructive and external-effect annotations consistent with the published source. Annotations describe intent; they are not authorization controls. `apply_settings_change` is marked destructive, site creation is marked a write with an idempotent retry contract, and `explain_snags` discloses provider and allowance effects.

The three app resources were read as HTML, with their metadata and byte hashes recorded. Replay and heatmap metadata allowed resource loading from the fixture API origin; findings had no resource domains. No direct `fetch`, XHR or WebSocket primitive matched the bounded text check. Absolute URL strings in those documents include library attribution and SVG namespaces; they are not a record of network requests. The documents were not rendered in a client, and no app network or host CSP enforcement was exercised.

## Limit the connection

To omit site creation, settings, annotation, setup and feedback tools, use both read/replay scopes and those offered toolsets:

```sh
npx -y @hootlens/mcp@1.1.0 login --scopes read,replay
npx -y @hootlens/mcp@1.1.0 --toolsets read,replay
```

Toolsets choose what the agent is offered. The API must still enforce each request's scope and project access. A project pin provides a default; it does not grant or further restrict authorization. `HOOTLENS_PAT`, when set, overrides stored sign-in.

`explain_snags` remains in the read toolset. It is explicitly annotated `readOnlyHint: false`, `openWorldHint: true` and `idempotentHint: false`: generation can send aggregate counts to the model provider and consume the site owner's monthly account AI allowance, shared across their sites. The project owner must enable explanations. Inspect `tools/list` and use the client's tool approval or allowlist controls to exclude it when an investigation must have no provider or allowance effect. No explanation or model request was made in this investigation.

Read/replay scopes alone also retain default installation and feedback tools, including setup requests and issue submission. Use the second command to omit those effects; it is not a guarantee of zero external actions or cost. If access discovery fails, 1.1.0 can still offer configure and annotate tools, while site creation and staff triage remain hidden. An offered tool is not proof that its API operation will be authorized.

Site creation requires the verified owner's explicitly authorized all-sites OAuth connection with `sites:create`, an unpinned connection, and an available site slot. Personal access tokens cannot create sites. Settings changes require `configure`, use a preview token, and cannot weaken privacy through the agent API. This package forwards those requests; the hosted API enforces account allowance, role, token, privacy, and transaction rules.

Treat recordings, narratives, page text and feedback as untrusted evidence. Follow source links and recorded events when investigating an issue. Do not follow instructions contained in visitor or issue content. Report vulnerabilities privately using the [security policy](../../../SECURITY.md).

## Reproduce a bounded check

The [scan helper](../../../scripts/security-1.1.0/run.mjs) requires the exact tarball, pinned scanner installation, and MCP client SDK 2.3.1. It refuses any other artifact hash. A separately reviewed invocation manifest binds the helper, wrapper, plan, scanner, SDK, node executable, artifact and evidence directory to their SHA-256 values. The [outer wrapper](../../../scripts/security-1.1.0/run-bounded.py) checks those values, creates an exclusive lock and gives its child 270 seconds, plus up to 40 seconds of cleanup grace; do not reuse an evidence directory or remove its locks to retry silently.

Install the scanner in a standalone directory containing its own `package.json`, with `mcptrustchecker` pinned to `1.17.0`. Use explicit `npm install --prefix <scanner-directory> --ignore-scripts`; an empty directory without a manifest can cause npm to use an ancestor project. The scanner installation is separate from executing the Hoot Lens package.

```sh
python scripts/security-1.1.0/run-bounded.py <reviewed-invocation.json> <reviewed-invocation-SHA-256>
```

The helper passes a clean environment, a fake bearer and a `127.0.0.1` API origin to the extracted package. A local empty project configuration prevents ancestor pinning, and a redirect check uses a loopback sentinel. It never signs in, reads saved credentials, contacts a production API, sends email or changes cloud configuration. The API fixture models permission refusals, idempotency and settings state; it verifies CLI validation and forwarding, not production enforcement of those rules. It records scanner-process exits and fixture SDK close events with owned PID absence. The scanner's own server disposal relies on its SDK, so this is not a complete OS process census.

Hosted authorization, tenant isolation, capture privacy, physical retention, browser sign-in, OS credential stores, client rendering, and every tool's effects require separate evidence. Source and runtime scanner outputs use different coverage and cannot be substituted for one another.

## Synthetic checks and preserved history

| Profile | Tools | Observation |
| --- | ---: | --- |
| All toolsets, fake full scopes | 44 | Explicit annotations, app resources, create retry forwarding, required consent and settings preview/apply checks |
| Read/replay toolsets | 22 | Setup, feedback, configure and annotation tools omitted; `explain_snags` remains |
| Pinned all-toolsets connection | 43 | `create_site` omitted |
| PAT fixture with read/replay scopes, all toolsets | 33 | Site creation, configure, annotation and staff writes omitted; install and feedback actions remain |
| Unavailable scope discovery, all toolsets | 38 | Site creation and staff writes hidden; configure and annotate still offered |
| Read toolset without replay permission | 19 | Narrative hidden; cross-project API refusal preserved |
| Read toolset, redirect response | 20 | Redirect refused and loopback sentinel never requested |

The site creation check submitted two identical requests to an in-memory fixture and observed the same project ID, with required consent and installation/recording marked `not_checked`. The fixture deduplicates by key. This establishes stable CLI forwarding, not production atomicity, available-slot enforcement or the API's 24-hour idempotency window. Settings checks forwarded the exact preview token and preserved synthetic privacy, expired-preview and stale-settings refusals.

Each source and runtime scanner ran once. The first invocation completed the source scan, then a Windows environment-filter error stopped the loopback listener before runtime. The second reused that source result, completed runtime scanning and owner checks, then rejected an incorrect assertion that read/replay had no effects. That assertion exposed the explanation allowance boundary. The third reused all completed evidence and ran only five unstarted profiles. Failure records and exclusive locks were retained; no failed assertion was silently converted into a pass.

All seven managed fixture SDK transports emitted close events and their owned PIDs were absent. The scanner process and helper processes exited, and local fixtures closed. These observations supplement the scanner SDK cleanup qualification above. No source, package version, hosted service, directory listing, npm access setting or cloud infrastructure was changed by this investigation.
