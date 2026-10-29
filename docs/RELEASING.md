# Public MCP releases

Version 1.3.0 is published with conversion outcome reports, replay preservation coverage, and npm provenance. Its [versioned release record](RELEASE-1.3.0.md) binds the exact public source, workflow, attestation, and isolated-install checks. Official MCP Registry publication is pending renewal of the existing Registry sign-in.

Version 1.2.0 is published with the doctor command, npm provenance and an active official MCP Registry entry. Its [versioned release record](RELEASE-1.2.0.md) binds the exact public source, workflow, attestation and verified artifact. The hosted service releases separately.

Version 1.1.0 was published on 14 October 2026 through this public repository's GitHub Actions trusted publisher, with npm provenance. The [versioned release record](RELEASE-1.1.0.md) links the attestation, exact tag, successful workflow and official Registry entry. The old private-repository npm trusted publisher was retired after the successful release. Version 1.0.2 remains published without provenance and cannot be republished; public source hashes and validation runs do not add an attestation to it.

The development root remains `private: true`. `npm run release:prepare` verifies the imported source snapshot, complete source inventory, package lock, registry identity and compiled version. It builds from this public checkout and stages only `dist/cli.mjs`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md` under `.release/package`. An explicit manifest allowlist excludes development dependencies, workspaces and lifecycle scripts. The staged manifest retains `@hootlens/mcp`, `com.hootlens/mcp`, the public repository URL, the executable name and Node 20 requirement, and requires public access and provenance.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run release:prepare
npm run release:pack
```

Packing checks the stage again and independently reads the gzip/tar contents. Wrong names, versions, extra or missing files, duplicate entries, symlinks, traversal paths, corrupted headers and changed file bytes fail validation. The receipt records the checked-out public commit and whether the checkout is clean, separately from the imported monorepo source commit. Local previews may include uncommitted pipeline or documentation edits; publication requires a clean checkout. The receipt is a local validation record, not a signed npm attestation or proof that these bytes reproduce a historical npm tarball.

Preparation refuses an existing `.release/package` to prevent stale files being reused. Run it in a fresh checkout for each release. `.release` is ignored and never part of the npm payload.

## Prepare the next release

1. Import and independently review the next release source, dependencies, source hashes and version changes in this public repository. Update snapshot expectations for that reviewed release. Merge through a PR and verify the Linux and Windows Node 20/22 validation jobs. A local Windows run does not establish the entire matrix.
2. Verify the existing GitHub Actions trusted publisher for `@hootlens/mcp`: organization `Parallel-Platforms`, repository `hootlens-mcp`, workflow filename `release.yml`, environment `npm-release`, with `npm publish` enabled. Do not rename the package or point its repository metadata at the private monorepo. Creating another trusted publisher is not a routine release step.
3. Review the GitHub `npm-release` environment and release-tag protections before authorizing the next exact version. The 1.1.0 release used an environment limited to `mcp-v1.1.0` and protected tag creation, updates and deletion. A later version needs its own reviewed authorization. A workflow declaring an environment does not itself create protection.
4. Coordinate any other publishing path before reserving the next immutable version. The old private npm trusted publisher is retired, but historical workflow source is not proof that another path is disabled for every future version. Do not invent npm integrity or publication evidence before publication.
5. Create the public `mcp-vVERSION` tag on the reviewed public commit. Manually dispatch **Prepare or publish public MCP release** against that tag, with `publish: true` and the exact version. The default dispatch only prepares and packs. There is no automatic publication on push, tag creation, pull request or merge.

Publication requires a GitHub-hosted runner, the exact public repository, a matching tag/version confirmation, a clean checkout matching `GITHUB_SHA`, and a 404 from npm for that version. Existing versions, redirects, auth errors, rate limits and registry failures refuse publication. The publish job checks and rebuilds source in its own fresh public checkout rather than accepting a bundle built privately or uploaded from another job. It uses Node 22, npm >=11.5.1, `id-token: write`, and explicit `--provenance`; no npm write token is configured in this repository.

After publication, verify that npm's attestation identifies the public repository, public commit and this workflow, and run `npm audit signatures` against a separate install of the exact release. Verify the installed CLI and synchronize MCP registry metadata separately. Record the artifact integrity and publication evidence in a new versioned release record, preserving the imported source inventory. Provenance links build/source identity; it does not prove the package is free of vulnerabilities.

Requirements: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), [immutable npm versions](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
