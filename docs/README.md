# Reference documentation

Per-module reference pages for the AiNxt IDE plugins. **Start with
[`overview.md`](overview.md)** for the module map, then follow the tree below.

The layout mirrors the source tree: `extension/` documents `vscode-acp/src`, `webview/`
documents `vscode-acp/webview-ui`, and `intellij/` documents `hosts/intellij`.

## What this is, and what it is not

**These pages are generated**, from source, by an internal documentation tool that is
**not part of this repository** (see [`generated/metadata.json`](generated/metadata.json)
for the generator version and timestamp). That has two consequences worth knowing before
you rely on them:

- **They can drift.** Nothing in this repository regenerates or validates them against
  the code, and an external contributor cannot regenerate them at all. Where a page and
  the source disagree, **the source is correct**. CI link-checks these files and asserts
  that every documented setting exists, but it cannot verify prose.
- **They describe structure, not usage.** For installing, configuring and running the
  plugins, the hand-written documents are authoritative:

| For | Read |
|---|---|
| Installing, configuring, running | [`../README.md`](../README.md) |
| The VS Code extension in detail | [`../vscode-acp/README.md`](../vscode-acp/README.md) |
| The JetBrains plugin | [`../hosts/intellij/README.md`](../hosts/intellij/README.md) |
| Security model, network egress, reporting | [`../SECURITY.md`](../SECURITY.md) |
| Third-party licences in the shipped package | [`../THIRD-PARTY-NOTICES`](../THIRD-PARTY-NOTICES) |
| Contributing | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

## The tree

Each directory has a `README.md` that is the overview for that subsystem, so browsing to
the directory on GitHub shows it.

### [`extension/`](extension/README.md) — the VS Code extension host

The ACP client, session orchestration, tool handlers and IDE surfaces.

| Page | Covers |
|---|---|
| [`extension/README.md`](extension/README.md) | The host as a whole |
| [`extension/activation.md`](extension/activation.md) | Activation, commands, inline completion |
| [`extension/ui.md`](extension/ui.md) | Chat webview, session tree, status bar, bridges |
| [`extension/config.md`](extension/config.md) | Agent configuration, registry, secret injection |
| [`extension/session-tree.md`](extension/session-tree.md) | The ACP Agents sidebar view |
| [`extension/status-bar.md`](extension/status-bar.md) | Budget and status indicator |

| Subsystem | Pages |
|---|---|
| [`extension/agent-management/`](extension/agent-management/README.md) | [acp-client](extension/agent-management/acp-client.md) · [agent-lifecycle](extension/agent-management/agent-lifecycle.md) · [checkpoints](extension/agent-management/checkpoints.md) |
| [`extension/session-management/`](extension/session-management/README.md) | [connections](extension/session-management/connections.md) · [history](extension/session-management/history.md) · [orchestration](extension/session-management/orchestration.md) |
| [`extension/handlers/`](extension/handlers/README.md) | [file-system](extension/handlers/file-system.md) · [permission](extension/handlers/permission.md) · [session-update](extension/handlers/session-update.md) · [terminal](extension/handlers/terminal.md) |
| [`extension/chat-webview/`](extension/chat-webview/README.md) | [provider](extension/chat-webview/provider.md) · [bridges](extension/chat-webview/bridges.md) |
| [`extension/utils/`](extension/utils/README.md) | [logging](extension/utils/logging.md) · [streaming](extension/utils/streaming.md) · [telemetry](extension/utils/telemetry.md) |

### [`webview/`](webview/README.md) — the shared React UI

One bundle, rendered by both hosts: a `WebviewView` in VS Code, a JCEF browser in
JetBrains IDEs.

| Page | Covers |
|---|---|
| [`webview/README.md`](webview/README.md) | The UI as a whole |
| [`webview/app.md`](webview/app.md) | The React application and its state |
| [`webview/bridge.md`](webview/bridge.md) | The `postMessage` contract with the host |
| [`webview/build.md`](webview/build.md) | The Vite build and how the bundle is loaded |
| [`webview/markdown.md`](webview/markdown.md) | Markdown and syntax-highlight rendering |

### [`intellij/`](intellij/README.md) — the JetBrains plugin

| Page | Covers |
|---|---|
| [`intellij/README.md`](intellij/README.md) | The Kotlin host, JCEF tool window and ACP bridge |

## `images/`

Screenshots used by the top-level README. They are **renders of the real built webview**
(`vscode-acp/webview-ui/dist`), not mock-ups, captured headlessly so they can be
regenerated deterministically rather than depending on someone's desktop:

1. `cd vscode-acp/webview-ui && npm ci && npm run build`
2. Serve `dist/` over HTTP — Chromium refuses ES modules from `file://`, which is also
   why the IntelliJ host serves the same bundle over `http://ainxt/`.
3. Load it in a headless browser at a 460x900 viewport, `deviceScaleFactor: 2`, and
   screenshot.

With no extension host attached, the panel renders its genuine not-signed-in state,
which is what a first-time user sees. Nothing is injected. A screenshot of the agent
answering would need a live gateway and model and is deliberately absent rather than
staged.

## `generated/`

Generator state, not documentation: `module_tree.json`, `first_module_tree.json` and
`metadata.json`. `metadata.json` records the generator version, the run timestamp, and
where each page now lives — a regenerated run emits flat filenames and will need
remapping into this tree again.

## `index.html`

A single-page viewer for the pages above. It is **not** required — every page is plain
markdown and reads fine on GitHub or in an editor.

Two caveats if you do open it: it loads `mermaid` and `marked` from the jsdelivr CDN at
runtime, so it **does not work offline** and it makes an external network request. If
that matters to you, read the markdown directly.
