# Changelog

All notable changes to `@hootlens/mcp` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-10-10

### Changed

- The npm page no longer links to the private GitHub repository, which returned a 404. `repository` and `bugs` point at the public [Parallel-Platforms/hootlens-mcp](https://github.com/Parallel-Platforms/hootlens-mcp) repository and support@hootlens.com, and `homepage` at the docs on hootlens.com. Released from 1.0.1 with only these package links changed.

## [1.0.1] - 2026-10-07

### Changed

- The default API origin is now `https://mcp.hootlens.com` (it was the Cloud Run host). `HOOTLENS_API_URL` still overrides it.
- A sign-in saved by `hootlens-mcp login` under the old default origin is found automatically and moved to the new one the next time it is read, so you do not need to sign in again. `hootlens-mcp logout` clears both. Sign-ins for a custom `HOOTLENS_API_URL` are not touched.
- Tool, prompt and toolset descriptions say "visit" where they said "session". Tool names and arguments are unchanged.

## [1.0.0] - 2026-10-07

First release on npm. The same server was available before as a single-file download from hootlens.com.

### Added

- MCP protocol versions 2026-07-28 and 2025 (older clients keep working).
- Toolsets: `read`, `replay`, `annotate`, `install`, `feedback`, `issues`, plus `default` and `all`. Choose them with `--toolsets` or `HOOTLENS_TOOLSETS`. Toolsets the credential cannot use are not offered.
- Project pinning: `--project`, `HOOTLENS_PROJECT`, or a `.hootlens.json` file with `{"projectId": "..."}`, so tools default to one project.
- Prompts for common jobs and resources for the Hoot Lens documentation.
- Structured output for tool results, alongside the text content.
- `hootlens-mcp login`, `logout` and `whoami`: sign in with your browser (OAuth with PKCE) instead of creating an access key. The sign-in is stored in the macOS Keychain, the Linux Secret Service, or a private file, and renews itself.
- Packaging as an npm package with a `hootlens-mcp` command, no runtime dependencies, and npm provenance.

### Changed

- The local server uses the sign-in from `login` when `HOOTLENS_PAT` is not set. `HOOTLENS_PAT` still takes priority.
