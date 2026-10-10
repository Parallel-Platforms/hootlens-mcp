# Changelog

All notable changes to `@hootlens/mcp` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- MCP Apps: in a host that renders them (such as Claude), `get_session_narrative` shows an interactive replay (play, pause, speed, snag and error markers, the steps of the visit that jump to their moment), `get_heatmap` shows click density over the page with the most clicked elements and scroll reach, and `review_findings` shows the pages with the most snags as cards. They are served as `ui://hootlens/replay`, `ui://hootlens/heatmap` and `ui://hootlens/findings`. Other hosts get the same text and data as before. The replay views load their events through `load_replay` (replay scope), a tool marked for views only, so the model's tool results do not grow.
- `list_errors` and `get_error` (read scope): JavaScript errors grouped by fingerprint, with where each was thrown (the original file and line when the release's source maps were uploaded), the elements whose click it followed, the releases, page groups and device classes it appeared in, and example recordings with the replay scope. `get_session_narrative` says "followed by TypeError: ..." for a snag an error followed, and `review_findings` lists `followedBy` on those elements.

### Changed

- Tool and parameter descriptions now state only what each tool does, takes and returns, as the Claude Connectors Directory requires. Guidance on workflow, citing ids, saying "rose" or "fell" and treating recorded content as untrusted moved into the server `instructions`. Tool names, parameters, annotations and response shapes are unchanged.
- The tools offered follow the scopes the person behind the connection still holds on their sites (`GET /v1/access`), so a tool leaves the list within seconds of its permission being taken away. `get_session_narrative` keeps needing only the read scope, and is offered when the person behind the connection may watch replays on a site it reaches; for a person who may not, the API answers 403 `replay_required`.
- `list_projects` and `whoami` can report a site role of `custom`: a member's access on a site can now be an individual set of permissions rather than Viewer or Editor.

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
