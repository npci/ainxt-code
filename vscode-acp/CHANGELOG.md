# Changelog — AiNxt VS Code Extension

All notable changes are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] — Licence change to MIT (2026-09-01)

### Changed
- **The project licence is now MIT, replacing Apache-2.0.** `LICENSE` carries the MIT
  text with the existing copyright holder unchanged (National Payments Corporation of
  India); `package.json` `license` is now `"MIT"`; the 52 first-party source files
  carry `SPDX-License-Identifier: MIT`. This supersedes the `license` entry recorded
  under *OSS Readiness (2026-08-12)* below, which is left in place as the historical
  record of what happened at that point.
- `NOTICE`: the trademark section no longer reasons from Apache-2.0 §6. It states the
  position under MIT, which is silent on trademarks rather than carving them out. All
  attributions are unchanged.

### Unchanged — deliberately
- **Third-party licences.** The Apache-2.0 components in `NOTICE` and
  `THIRD-PARTY-NOTICES` — `@agentclientprotocol/sdk`, TypeScript, the IntelliJ
  Platform SDK, Gson, the Kotlin standard library — remain under their own licences.
- **The Gradle wrapper scripts** (`hosts/intellij/gradlew`, `gradlew.bat`) keep their
  Apache-2.0 headers. They are Gradle Inc.'s code, not this project's.

### Note for adopters
Apache-2.0 §3 granted an express patent licence. **MIT contains no patent grant.**
Rights in the copyrighted work are unchanged, and MIT is otherwise the more permissive
licence, but downstream recipients no longer receive that express patent grant.

---

## [Unreleased] — Newcomer setup audit (2026-08-29)

Findings carry `SETUP-0xx` identifiers from the release-readiness audit ledger, which
is maintained **outside this repository** and is not published with it. The identifiers
are kept here so a future reader can correlate a change with its finding.

### Added
- `install.sh` / `install.ps1` — one-command install for macOS/Linux and Windows:
  detects the IDE, obtains the extension (published release, else source build),
  installs it, sets `ainxt.gatewayUrl`, then **probes the gateway** and reports
  `auth/me`, `budget/me` and `complete` individually. `--verify` re-checks
  connectivity; `--uninstall` removes the extension.
- `setup.sh` — the one-command source build the README had documented, including its
  `--check` and `--install` flags, but which was never committed (SETUP-039).
- `vscode-acp/.vscodeignore` — the `.vsix` was 30 MB / 7009 files, 6921 of them
  `webview-ui/node_modules`; it is now 708 KB / 17 files (SETUP-043).
- `scripts/check-release-invariants.sh` — 10 checks for properties a fresh clone
  depends on, each tied to a finding and negative-tested.
- `.github/workflows/ci.yml` — the repo had no CI, while CONTRIBUTING required
  `npm test`, which could not run (SETUP-042, SETUP-052).
- `src/test/acpRoundTrip.test.ts` + `src/test/fixtures/stub-acp-agent.js` — no test
  had ever exercised a subprocess or the JSON-RPC wire. Now covers spawn →
  `initialize` → `session/new` → `session/prompt` → streamed `session/update`, with
  no gateway, model or credentials (SETUP-052).
- Two regression tests for session ordering and cap eviction under tied timestamps.

### Fixed
- **`SessionHistoryStore.list()` returned sessions oldest-first on a timestamp tie.**
  `lastActiveAt` has millisecond resolution and `Array.sort` is stable, so
  same-millisecond entries kept insertion order — inverting the documented contract.
  `enforceCap()` evicts from that same ordering, so it could delete the *newest*
  session and keep a stale one. Tie-break added on `createdAt` then insertion index.
  Found only because the test suite became runnable for the first time (SETUP-050).
- **`npm test` could not start**: `@vscode/test-electron ^2.4.1` resolved to 2.5.2,
  which looks for `Contents/MacOS/Electron` — a path VS Code ≥1.110 no longer uses.
  Bumped to `^3.1.0` (SETUP-042).
- **The Gradle wrapper JAR was excluded by a blanket `*.jar` ignore**, so `./gradlew`
  could not bootstrap and the IntelliJ plugin was unbuildable from a clone
  (SETUP-040).
- **No lockfile was published** (`package-lock.json` was gitignored by name), so no
  external install was reproducible — the direct cause of SETUP-042 (SETUP-041).
- `ainxt.autocomplete` posts to `/ainxt/v1/api/complete`, which the AiNxt Platform
  does not implement; the failure was silent. A `404`/`501` now logs one explanatory
  line per gateway URL, and the limitation is documented (SETUP-056).
- Untracked `hosts/intellij/.intellijPlatform/self-update.lock`; added
  `.intellijPlatform/` and `.kotlin/` to `.gitignore` (SETUP-049).

### Changed
- Build Node floor raised 20 → 22 in `.nvmrc`, `engines.node` and `setup.sh`: the
  toolchain (`@vscode/vsce`, `@vscode/test-electron`) declares `node >=22`, and Node 20
  produced `EBADENGINE` for eleven packages. Build-time only — `engines.vscode` stays
  `^1.85.0` (SETUP-055).

### Documentation
- `hosts/intellij/README.md` stated the plugin "does not build as cloned" and that no
  Gradle build script or wrapper was committed, calling it a release blocker. Both are
  committed; `./gradlew buildPlugin` succeeds. Rewritten against a verified build
  (SETUP-044).
- `vscode-acp/README.md` told newcomers to `cd ainxt-ide-plugin/vscode-acp`, a
  directory that does not exist (SETUP-045).
- Documented `acp.agents` and `ainxt.registryUrl` — 9 of 11 settings had been listed,
  and the missing one governs outbound egress to a public CDN (SETUP-051).
- `SECURITY.md` gained an explicit inventory of the three requests the plugin makes on
  its own account, and how to keep the registry lookup inside a perimeter.
- Fixed dead links to `GOVERNANCE.md` and a root `CHANGELOG.md`; corrected the
  repository layout, which listed an `archive/` and a root `config/` that do not exist;
  surfaced the 39-page `docs/` tree, previously referenced by nothing (SETUP-046).
- `docs/overview.md` still called the repo `ainxt-ide-plugin-develop`;
  `docs/session_management_history.md` described the old eviction order;
  `docs/extension_activation.md` claimed a gateway→Ollama path a stock Platform lacks.
- Noted that `code` is not on `PATH` by default on macOS, with both workarounds
  (SETUP-048).
- Single Node floor, asserted by CI rather than restated in three places (SETUP-047).

---

## [Unreleased] — OSS Readiness (2026-08-12)

### Security
- Removed hardcoded Azure Application Insights key. Telemetry disabled by default; set `AINXT_TELEMETRY_CONNECTION_STRING` at build time to enable.

### Changed
- `package.json`: `bugs`, `homepage`, `repository` updated to `npci/ainxt-code` placeholders.
- `package.json`: `license` corrected to `"Apache-2.0"`.
- `package.json`: Default model changed from `claude-sonnet-4-6` to `""` (empty).
- `package.json`: Default agent args: `["agent", "--no-leader", "stdio"]` (no hardcoded model).
- `package.json`: `acp.logTraffic` default changed from `true` to `false`.
- `package.json`: `vscode:prepublish` now builds the React webview before packaging.
- `package.json`: Tree-specific commands suppressed from command palette.
- `package.json`: Added `ainxt.homeDir` setting for custom `AINXT_HOME` path.
- `src/utils/Logger.ts`: `logTraffic` fallback changed to `false`.
- `src/core/SessionManager.ts`: `acp.defaultWorkingDirectory` setting now read and used.
- `src/config/AgentConfig.ts`: Added `ainxt.homeDir` support; `AINXT_HOME` passed to agent spawn env; added `resolveAinxtHome()` helper.
- `src/core/ConnectionManager.ts`: ACP client identifier read from `package.json` `name` field.
- `src/extension.ts`: Removed `localhost:8000` fallback; improved error messages; corrected `sendEvent` extension ID; all credential reads use `resolveAinxtHome()`.
- `src/ui/ChatWebviewProvider.ts`: Removed `localhost:8000` fallback.
- `webview-ui/src/App.tsx`: Removed NPCI hostname from Connect form placeholder; removed "NPCI budget" from tooltip; dynamic welcome subtitle with 3-step onboarding; gateway hostname in identity chip tooltip.
- `webview-ui/package.json`: Removed `version` field.
- `src/test/extension.test.ts`: Extension ID corrected to `ainxt.ainxt-vscode`; expanded to 5 suites / 15 tests.

---

## [0.2.0] — Initial tracked release

### Added
- ACP connection over stdio — spawns `ainxt agent stdio` and speaks JSON-RPC 2.0.
- Session lifecycle — new, load (history replay), resume, cancel.
- Session history — persisted in `workspaceState`; survives reloads.
- `connectOrResume` — resumes the most recent session on activation.
- Chat webview — React + Vite UI with streaming markdown, syntax highlighting, thought blocks.
- File system handler — reads unsaved buffers; writes open the file in the editor.
- Terminal handler — executes commands in the VS Code integrated terminal.
- Permission handler — in-chat approval cards with QuickPick fallback.
- Checkpoint / undo — per-turn file snapshots with one-click revert.
- Plan mode and ask-user-question support.
- Inline autocomplete (`ainxt.autocomplete`, off by default).
- Budget status bar.
- `@`-mention file picker (files, folders, git diff, diagnostics).
- `.ainxtrules` / `.ainxt/rules.md` project rules injection.
- Auth flow — OIDC, API key (SecretStorage), device code, cached token.

---

[Unreleased]: https://github.com/npci/ainxt-code/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/npci/ainxt-code/releases/tag/v0.2.0
