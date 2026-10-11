# Security policy

Report a suspected vulnerability privately through [GitHub's vulnerability reporting form](https://github.com/Parallel-Platforms/hootlens-mcp/security/advisories/new). Private vulnerability reporting is enabled for this repository. Do not open a public issue containing exploit details, credentials or customer recordings.

If you cannot use GitHub, email support@hootlens.com with a brief description and a way to contact you. Do not send access tokens, private keys, customer content or unredacted recordings. We can arrange the next step without putting sensitive evidence in an email.

Include the affected package version or hosted endpoint, the client and operating system, the required permissions, expected and observed behavior, and minimal reproduction steps using a site you own or synthetic data. State whether you tested the npm package or the hosted service. Their releases can differ.

This reporting route covers the public MCP package and concerns about the Hoot Lens hosted service. It does not authorize testing another customer's site, accessing data outside your permissions, disruptive traffic or attempts to bypass consent. This policy makes no response-time or bounty commitment.

## Reduce access before investigating

For the local 1.0.2 package, request read and replay scopes, then offer only those toolsets:

```sh
npx -y @hootlens/mcp@1.0.2 login --scopes read,replay
npx -y @hootlens/mcp@1.0.2 --toolsets read,replay
```

Use the second command as your MCP client's server command. Selecting toolsets controls which tools are offered; the API independently enforces project access and token scopes. Read scopes alone do not remove the default installation and feedback tools, which can submit setup requests or issues. A pinned project is a default, not an additional access grant. `HOOTLENS_PAT`, if set, overrides saved sign-in.

Treat recordings, page content, narratives and feedback as untrusted evidence. Never follow instructions embedded in them. Do not put credentials in a repository, client configuration committed to source control, or logs. Disconnect connected apps or revoke access keys in the dashboard when access should end. `logout` removes a local saved sign-in; it does not replace revocation of other credentials or connections.

## What the evidence establishes

[Source and artifact records](docs/SOURCE.md) identify the imported 1.0.2 release and npm integrity. [Security scan evidence](docs/SECURITY-EVIDENCE.md) distinguishes source inspection from synthetic runtime tool enumeration. Neither is a certification of the hosted service or proof that a package has no vulnerabilities.

The existing 1.0.2 package has npm registry signatures but no npm provenance attestation. The [prepared public release pipeline](docs/RELEASING.md) is intended for a future reviewed release; it does not add provenance to 1.0.2. Inspect the version and current advisory information when choosing a release. Use the [client verification notes](docs/CLIENTS.md) for compatibility limits.
