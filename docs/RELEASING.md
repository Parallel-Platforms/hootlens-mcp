# Public release preparation

This pipeline is prepared for independent review. No new npm version or trusted-publisher configuration was created as part of this change. Version 1.0.2 is already published without npm provenance and cannot be republished. Public source hashes and GitHub validation runs do not add an attestation to that existing package.

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

## Owner configuration before publication

1. Review and merge this pipeline, then verify the Linux and Windows Node 20/22 validation jobs. A local Windows run does not establish the entire matrix.
2. Add a GitHub Actions trusted publisher to the existing `@hootlens/mcp` npm package: organization `Parallel-Platforms`, repository `hootlens-mcp`, workflow filename `release.yml`, environment `npm-release`. Explicitly allow `npm publish` if direct publication is intended; current npm configurations otherwise allow staged publication by default. Do not rename the package or point its repository metadata at the private monorepo. npm allows multiple trusted publishers, so the existing private publisher can remain until the migration succeeds.
3. Configure the GitHub `npm-release` environment and release-tag protections for the intended maintainers. The workflow declaring an environment does not itself create reviewer protection. Newly configured npm trusted publishers need their first successful publish within two days. Complete setup when the next reviewed release is ready.
4. Coordinate the monorepo's tag-triggered publisher before creating the next monorepo release tag. It currently publishes without provenance; allowing it to publish the next version first would consume that immutable version. Import and independently review the next release source, dependencies, source hashes and version changes in this public repository before tagging it here. Update the existing snapshot test expectations for the new reviewed release. Do not invent an npm integrity value before publication.
5. Create the public `mcp-vVERSION` tag on the reviewed public commit. Manually dispatch **Prepare or publish public MCP release** against that tag, with `publish: true` and the exact version. The default dispatch only prepares and packs. There is no automatic publication on push, tag creation, pull request or merge.

Publication requires a GitHub-hosted runner, the exact public repository, a matching tag/version confirmation, a clean checkout matching `GITHUB_SHA`, and a 404 from npm for that version. Existing versions, redirects, auth errors, rate limits and registry failures refuse publication. The publish job checks and rebuilds source in its own fresh public checkout rather than accepting a bundle built privately or uploaded from another job. It uses Node 22, npm >=11.5.1, `id-token: write`, and explicit `--provenance`; no npm write token is configured in this repository.

After publication, verify that npm's attestation identifies the public repository, public commit and this workflow, and run `npm audit signatures` against a separate install of the exact release. Verify the installed CLI and synchronize MCP registry metadata separately. Only after a successful migration should the old private publishing path be retired. Provenance links build/source identity; it does not prove the package is free of vulnerabilities.

Requirements: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), [immutable npm versions](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
