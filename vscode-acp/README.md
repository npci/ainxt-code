# AiNxt — VS Code Extension

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../LICENSE)

AiNxt is a governed AI coding agent for VS Code. It connects your editor to the
`AiNxt` CLI over the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/),
giving you an in-editor chat panel with file read/write, terminal execution, and
permission-approval capabilities — while all policy enforcement, egress controls,
and audit logging are handled by the CLI (and, optionally, a gateway behind it).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **`AiNxt` CLI** | The agent itself — this extension contains none. Must be on `PATH`, or set `ainxt.binaryPath`. The repository's `./install.sh` / `install.ps1` set it up and verify it with a real ACP handshake. |
| **A model, configured on the CLI** | `ainxt login`, `AINXT_API_KEY`, or a `[model.*]` entry in `~/.ainxt/config.toml`. No gateway is required for this. |
| **AiNxt gateway** *(optional)* | Only if your team runs the AiNxt Platform for shared auth/budgets/policy/audit. Not needed otherwise. |
| **VS Code** ≥ 1.85 | |
| **Node 22+ / npm** | Only to build from source; see `.nvmrc`. The build toolchain (`@vscode/vsce`, `@vscode/test-electron`) declares `node >=22`; on Node 20 it still builds but npm reports `EBADENGINE` for 11 packages. Not needed to install a prebuilt `.vsix`. |

---

## Installation

### From the VS Code Marketplace

**Not yet published** — there is no marketplace listing at the time of writing.
Build a `.vsix` as below. Once published, this becomes: search for **AiNxt** in
the Extensions panel (`Ctrl+Shift+X`) and click **Install**.

### One command (recommended)

From the repository root — installs the extension **and the `ainxt` agent**, then
verifies the ACP handshake. By default it configures no gateway (standalone mode);
pass `--gateway` only if you use the AiNxt Platform:

```bash
./install.sh                                    # macOS / Linux — standalone
./install.sh --gateway https://gw.example:8000   # opt into an AiNxt Platform gateway
```

```powershell
.\install.ps1                                   # Windows
```

Or straight from the network, without cloning:

```bash
curl -fsSL https://raw.githubusercontent.com/npci/ainxt-code/main/install.sh | sh
```

See the [root README](../README.md#quick-start) for all flags.

### From a `.vsix` file

```bash
code --install-extension ainxt-vscode-<version>.vsix
```

`code: command not found` means VS Code's CLI is not on your `PATH`, which is the
default on macOS. Run **Command Palette → "Shell Command: Install 'code' command in
PATH"**, or install through the UI: **Extensions panel → … → "Install from VSIX…"**.

---

## Configuration

All settings are configurable — no hardcoded values. Priority order (highest first):

| Priority | Method | Example |
|----------|--------|---------|
| 1 | Environment variable | `AINXT_GATEWAY_URL=http://gateway:8000` |
| 2 | VS Code Settings | **Settings → Extensions → AiNxt** |
| 3 | In-panel Connect form | Click **Connect** in the chat panel |
| 4 | Setting default | *(empty — standalone, no gateway)* |

### VS Code Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ainxt.gatewayUrl` | *(empty)* | Optional AiNxt Platform gateway URL. Leave empty to run standalone against a directly-configured model. |
| `ainxt.binaryPath` | *(empty = PATH)* | Full path to `ainxt` CLI |
| `ainxt.homeDir` | *(empty = `~/.ainxt`)* | Home dir for credentials |
| `ainxt.model` | *(empty = agent default)* | LLM model (e.g. `local:llama3.1:8b`) |
| `ainxt.allowInsecure` | `false` | Allow `http://` gateways |
| `ainxt.autocomplete` | `false` | Ghost-text inline completion. **Requires a gateway that serves `POST /ainxt/v1/api/complete`; the AiNxt Platform does not, so this has no effect against a stock deployment** — see [Known limitations](#known-limitations). |
| `acp.autoApprovePermissions` | `ask` | Permission approval mode |
| `acp.defaultWorkingDirectory` | *(empty = workspace)* | Agent working directory |
| `acp.logTraffic` | `false` | Debug ACP protocol log |
| `acp.agents` | *(AiNxt: `ainxt agent --no-leader stdio`)* | ACP agent launch table — command, args and env per agent |
| `ainxt.registryUrl` | *(empty = public CDN)* | ACP agent registry. Empty means `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` is fetched over the network; point this at an internal mirror to keep the lookup inside your perimeter. Must be `https://` or loopback — plain `http://` to a remote host is refused. |

### Environment variables

| Variable | Purpose |
|----------|---------|
| `AINXT_GATEWAY_URL` | Gateway endpoint (overrides `ainxt.gatewayUrl`) |
| `AINXT_API_KEY` | Auth credential (overrides stored key) |
| `AINXT_BINARY_PATH` | Path to `ainxt` CLI (overrides `ainxt.binaryPath`) |
| `AINXT_HOME` | Home dir for credentials (overrides `ainxt.homeDir`) |
| `AINXT_ALLOW_INSECURE` | Allow `http://` (overrides `ainxt.allowInsecure`) |
| `AINXT_TELEMETRY_CONNECTION_STRING` | Telemetry endpoint (build-time; unset = no telemetry) |

### First-time setup

1. **Install the `ainxt` CLI.** It is built by [`ainxt-cli`](https://github.com/npci/ainxt-cli)
   (`cargo build --profile release-dist -p ainxt-pager-bin --bin ainxt`), not by
   `ainxt-enterprise`, which is the Python platform and ships no CLI binary.
2. **Give it a model**: run `ainxt login` (writes `~/.ainxt/credentials.json`, which the
   extension reads automatically), set `AINXT_API_KEY`, or add a `[model.*]` entry to
   `~/.ainxt/config.toml` for a direct provider. No gateway is required for any of these.
3. **Open VS Code** and open the **AiNxt** panel from the Activity Bar — it works now.
4. Only if your team runs the AiNxt Platform, click **Connect** and enter its gateway URL.

---

## Features

| Feature | Description |
|---------|-------------|
| **Chat panel** | Streaming AI chat with markdown rendering and syntax-highlighted code blocks |
| **File read/write** | Agent reads unsaved editor buffers; writes open the file in the editor |
| **Terminal execution** | Agent runs shell commands in the VS Code integrated terminal |
| **Permission approvals** | Every file write and tool call requires explicit approval (or configure auto-approve) |
| **Checkpoint / undo** | Each agent turn snapshots modified files; one click reverts all changes |
| **Session history** | Previous conversations listed and resumable with full history replay |
| **Inline autocomplete** | Optional ghost-text completion backed by the gateway (`ainxt.autocomplete`). Needs a completion endpoint the stock Platform does not provide — see [Known limitations](#known-limitations). |
| **@-mention files** | Type `@` in the chat input to attach workspace files as context |
| **Git diff / diagnostics** | Attach the current git diff or VS Code Problems panel as context |
| **Plan mode** | Agent presents a plan for approval before executing multi-step changes |

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` / `Cmd+Shift+A` | Open AiNxt chat panel |
| `Escape` | Cancel the current agent turn (while in progress) |

---

## Building from source

From the repository root, `./setup.sh` does all of the below in one step (and
`./setup.sh --check` just verifies prerequisites). The manual sequence:

```bash
git clone https://github.com/npci/ainxt-code.git
cd ainxt-code/vscode-acp

# Install dependencies (exact, from the committed lockfile)
npm ci

# Build the React webview UI (required before packaging)
cd webview-ui && npm install && npm run build && cd ..

# Compile the extension TypeScript
npm run compile

# Package to a .vsix (builds webview automatically)
npm run package
# → produces ainxt-vscode-<version>.vsix

# Launch a development host (press F5 in VS Code)
```

### Running tests

```bash
cd vscode-acp
npm test
```

---

## Known limitations

**`ainxt.autocomplete` does nothing against a stock AiNxt Platform.** The feature
posts to `/ainxt/v1/api/complete`, a fill-in-the-middle completion endpoint that is
separate from the chat/agent path. The Platform (`ainxt-enterprise`) serves
`/ainxt/v1/api/auth/me` and `/ainxt/v1/api/budget/me`, which this extension also
uses, but it does **not** implement `/complete` — that route was built against a
deployment fronting a local completion service. Enabling the setting against a
stock gateway produces no suggestions; the extension logs one explanatory line to
the **AiNxt** output channel and then stays silent so typing is never disturbed.
Chat, file operations, terminal execution and permissions are unaffected.

**The JetBrains tool window is not verified headlessly.** `./gradlew buildPlugin`
is verified; driving the JCEF panel is a manual step. See
[`../hosts/intellij/README.md`](../hosts/intellij/README.md).

## Acknowledgements

This project was originally derived from
[formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp)
(MIT License, Copyright (c) 2026 Jun Han). It has been substantially modified
and extended by the AiNxt team. See [NOTICE](../NOTICE) for full attribution.

---

## License

Apache-2.0 — see [LICENSE](../LICENSE) for details.
