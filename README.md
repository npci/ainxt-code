<p align="center">
  <!-- Brand-approved lockups from AINxt_logo_icon/. -01 is the transparent version for light
       backgrounds; -02 is the navy-plate version, which stays legible on GitHub's dark theme.
       PNG rather than SVG because GitHub sanitises inline SVG in Markdown. -->
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="AINxt_logo_icon/AINxt_CTC-02.png">
    <img src="assets/AINxt_CTC-01.png" alt="AiNxt" width="360">
  </picture>
</p>

# AiNxt Code

[![NPCIOSS Lifecycle](https://img.shields.io/badge/oss_lifecycle-active-green)](OSSMETADATA)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A governed AI coding agent in VS Code and JetBrains IDEs.

<table>
<tr>
<td width="50%" valign="top" align="center">
<img src="docs/images/panel-welcome.png" alt="The AiNxt panel docked in VS Code on first open, before connecting: the AiNxt logo, a three-step onboarding list, a Connect button, and four suggested prompts above the chat input." width="420">
<br><sub><b>First open, before you connect.</b> The panel tells you what it needs rather than failing quietly.</sub>
</td>
<td width="50%" valign="top" align="center">
<img src="docs/images/panel-connect.png" alt="The Connect dialog inside the AiNxt panel, with an Access key field shown as a password input and an optional Gateway URL field." width="420">
<br><sub><b>Connecting.</b> An access key for direct model use, and an optional gateway URL only if your team runs the AiNxt Platform — the key goes to the OS keychain, never to a settings file.</sub>
</td>
</tr>
</table>

<sub>Both images are the real built webview, rendered from <code>vscode-acp/webview-ui/dist</code>. No mock-ups. The panel is shown in its genuine
not-signed-in state (this screenshot predates the Connect form's field reordering — the
key field now comes first); screenshots of the agent actually answering need a configured
model, so they are not included rather than staged.</sub>

---


## Start here — in plain terms

**What you are installing.** A panel inside VS Code or a JetBrains IDE where you chat
with an AI about the code you have open, and let it read files, write files and run
commands — asking your permission before each one.

**What this repository is *not*.** It is not the AI. This repository is only the panel.
The thinking happens in the `ainxt` CLI agent, which this repository launches as a
subprocess and which you also have to have installed. Install only this and you get a
panel that opens, and then cannot answer anything.

**Two pieces have to be in place. Both are things you already need for the CLI to work
on its own** — this repository adds no dependency beyond them:

| | Piece | What it does for you | Where it comes from |
|---|---|---|---|
| 1 | **A model** | Actually writes the answers | You choose one: a cloud provider (Anthropic, OpenAI, …), [Ollama](https://ollama.com/) on your own machine, or any OpenAI-compatible endpoint. Configured once in `~/.ainxt/config.toml` or via `ainxt login` / `AINXT_API_KEY`. **Nothing in AiNxt includes a model.** |
| 2 | **`ainxt` CLI** | The "agent" — the program that actually does the work | The `ainxt-cli` repository. **The installer below fetches and builds this for you**, so this one is usually not your problem |

**No gateway is required.** A third, optional piece — the **AiNxt Platform** (the
"gateway": shared auth, budgets, policy and audit, from the separate `ainxt-enterprise`
repository) — exists for teams that want a governed, multi-user deployment. It is not
needed to use this extension at all; skip it unless your organisation already runs one.

**How long.** The panel takes about half a minute to build and install — that part is
measured. The CLI is automatic but compiles a large Rust program the first time, so
allow 10–30 minutes if no prebuilt copy is available.

**If you only want to read the code**, ignore all of the above. Clone the repository and
open it; nothing needs to run.

**Not sure what you already have?** Install this repository, then ask it:

```sh
./install.sh --verify
```

It checks each piece separately and tells you which one is missing, rather than failing
with one unhelpful message. There is a [Troubleshooting](#troubleshooting) section for
when it does report a problem.


## What this is

Two IDE plugins — a VS Code extension and an IntelliJ plugin — that put a
governed AI coding agent in your editor: a chat panel, file read and write,
terminal execution, and an approval prompt before anything happens that you
might not want.

**Neither plugin contains an agent.** They are thin clients. The agent is the
`AiNxt` CLI, which they launch as a subprocess and talk to over the
[Agent Client Protocol](https://agentclientprotocol.com/) — a JSON-RPC protocol
over stdio. Every policy decision, egress control and audit record happens in
the CLI and the Platform behind it, not here.

That matters for two reasons. The plugin cannot be the security boundary, so
compromising it does not bypass governance. And the same agent behaves
identically in your editor, your terminal and your CI, because it is the same
binary.

## Architecture

```mermaid
flowchart LR
    subgraph IDE["Your IDE"]
        direction TB
        UI["Chat panel<br/><i>React + Vite webview</i>"]
        EXT["Extension host<br/><i>TypeScript</i>"]
        UI <-->|"postMessage"| EXT
    end

    CLI["<b>AiNxt CLI</b><br/><i>the agent</i><br/>launched as a subprocess"]
    M["Model provider<br/><i>Anthropic · OpenAI · Ollama · any<br/>OpenAI-compatible endpoint</i>"]
    GW["<b>AiNxt Platform</b> (optional)<br/>AiNxt Enterprise · :8000<br/><i>auth · budgets · policy · audit</i>"]

    EXT <-->|"Agent Client Protocol<br/>JSON-RPC over stdio"| CLI
    CLI <-->|"direct, by default"| M
    CLI -.->|"HTTPS<br/>/ainxt/v1/api/* — only if configured"| GW
    GW -.-> M

    EXT -.->|"reads once"| CRED[("~/.ainxt/<br/>credentials.json")]
    CLI -.->|"written by<br/>ainxt login"| CRED

    classDef thin fill:#eef,stroke:#66a
    classDef opt stroke-dasharray: 4 3
    class UI,EXT thin
    class GW opt
```

The CLI talks directly to a model provider by default — the AiNxt Platform is an
optional hop in front of it, not a requirement. See
[How this fits with the other AiNxt repositories](#how-this-fits-with-the-other-ainxt-repositories)
for when you would actually want it.

The webview and the extension host are the only code in this repository. The
IntelliJ plugin renders the *same* webview through JCEF (the Java Chromium
Embedded Framework bundled with JetBrains IDEs), which is why both IDEs
behave identically and why a UI fix lands in both at once.

## What you get

| | |
|---|---|
| **Chat panel** | Docked in the Activity Bar (VS Code) or the right tool window (IntelliJ) |
| **File operations** | Read, write and diff, applied through the IDE so undo works normally |
| **Terminal execution** | Commands run in an IDE terminal you can watch and interrupt |
| **Permission prompts** | Anything consequential asks first; the CLI decides what counts |
| **Deployment profiles** | `*.ainxtprofile.json` presets a gateway URL (or none, for standalone) and defaults for a whole team |
| **23 commands, 11 settings** | Everything is configurable; nothing about a deployment is compiled in |

## Quick start

One command. It installs **both halves** — the extension *and* the `ainxt` agent it
drives — and then proves the chain works before telling you you're done: it completes a
real ACP handshake with the agent. By default it configures **no gateway** — the agent
runs standalone, and you point it at a model yourself (see below).

> **Before you run it:** this installs the extension and the CLI agent. It cannot choose
> a **model** for you — it will finish successfully and then tell you that is still
> missing. That is expected, not a failure. It also does not install the **AiNxt
> Platform**, which is a separate, optional service — pass `--gateway` only if you
> intend to use one.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/npci/ainxt-code/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/npci/ainxt-code/main/install.ps1 | iex
```

> There is no single command that covers all three platforms, and any project that
> claims otherwise is glossing over something: `curl … | sh` needs a POSIX shell, and
> Windows does not have one. `curl.exe` exists there, but there is nothing to pipe it
> into. rustup, Bun, Deno and uv all ship exactly these two one-liners for the same
> reason.

To opt into a shared AiNxt Platform gateway instead of standalone mode, pass `--gateway`.
A piped script cannot take arguments directly, so hand them to the shell:

```sh
curl -fsSL https://raw.githubusercontent.com/npci/ainxt-code/main/install.sh \
  | sh -s -- --gateway https://gateway.example.com:8000 --api-key "$AINXT_API_KEY"
```

```powershell
irm https://raw.githubusercontent.com/npci/ainxt-code/main/install.ps1 -OutFile install.ps1
.\install.ps1 -Gateway https://gateway.example.com:8000 -ApiKey $env:AINXT_API_KEY
```

Without `--gateway`, `--api-key` still works — it saves an API key for direct
model/provider use, no gateway involved.

Useful flags — the same names on both platforms (`--flag` / `-Flag`):

| Flag | Effect |
|---|---|
| `--gateway <url>` | AiNxt Platform gateway URL. Optional — omit it to run standalone (the default) |
| `--api-key <key>` | API key. Never written to disk — see below |
| `--ide <which>` | `auto` (default), `vscode`, `jetbrains`, `none` |
| `--verify` | Check the agent (and gateway, if configured); install nothing |
| `--from-source` | Build locally instead of downloading a release |
| `--source-dir <dir>` | Build from an existing checkout |
| `--cli-dir <dir>` | Build the `ainxt` agent from an `ainxt-cli` checkout |
| `--skip-cli` | Leave the agent alone |
| `--cli-version <v>` | Agent release to install, or `latest` |
| `--no-verify` | Skip the connectivity check |
| `--uninstall` | Remove the extension |

Re-run `--verify` any time to re-check:

```sh
./install.sh --verify
```

**What it checks, and why that matters.** It ends with a status block, not a cheerful
"done":

```
==> Where you stand
  Extension                          installed
  Agent (ainxt CLI)                  working — ACP handshake verified
  Sign-in                            credentials present
  Gateway                            not configured — running standalone (this is fine)

  Ready. Open the AiNxt panel in VS Code (Activity Bar, or Cmd/Ctrl+Shift+A) and type.
```

- **Agent** — not "is the file there". It spawns `ainxt agent --no-leader stdio` and
  completes the same ACP `initialize` the extension performs. A binary that exists and
  answers `--version` but cannot speak the protocol is reported as broken, because to
  you it *is* broken.
- **Sign-in** — a credential of some kind for the agent's model: `ainxt login`,
  `AINXT_API_KEY`, or a `[model.*]` entry in `~/.ainxt/config.toml` with its own key.
- **Gateway** — only checked, and only required for readiness, when you pass
  `--gateway`. Standalone installs show it as "not configured" and that does not block
  readiness. When a gateway *is* configured, it probes the three routes the extension
  calls: `GET /ainxt/v1/api/auth/me`, `GET /ainxt/v1/api/budget/me`,
  `POST /ainxt/v1/api/complete`. A `404` on the last is normal and labelled expected —
  it backs only the opt-in autocomplete, which the Platform does not serve (see
  [`vscode-acp/README.md`](vscode-acp/README.md#known-limitations)).

If anything is missing, it says which command fixes it. `--verify` re-runs the whole
check later without reinstalling, and exits non-zero when you are not ready — so it
works in a script.

### The agent

**The plugin contains no agent.** The chat panel spawns the `ainxt` binary and speaks
the Agent Client Protocol to it over stdio, so the extension on its own gives you a
panel that cannot start a conversation. You do not have to do anything about that — if
no agent is on your machine, the installer fetches and sets one up.

It does **not** reimplement the agent's installation. `ainxt-cli` has its own installer,
with checksum verification and `AINXT_BASE_URL` support for enterprise artifact hosts,
and the IDE installer delegates to it. Two installers disagreeing about where the binary
lives is a worse failure than one extra network hop.

What happens, in order, with no input from you:

1. **Already have a working agent?** It is used as-is — on `PATH`, at
   `AINXT_BINARY_PATH`, or in a standard location. Nothing is reinstalled over it.
2. **Otherwise, download a prebuilt binary** via the agent's own installer. This is the
   fast path: seconds, no toolchain, no compiler.
3. **If no release is published**, fetch the source and build it. The Rust toolchain is
   installed automatically if you do not have one — into `~/.cargo`, with no `sudo` and
   without editing your shell profile, since it is only needed for this one build.

Step 3 is honest about its cost before it starts: roughly 80 crates, about 10 GB in
`target/`, and typically 10–30 minutes. It happens once; the source is cached in
`~/.ainxt/src/ainxt-cli` and reused. If the disk is too small to succeed it stops and
says so rather than failing 20 minutes in.

If the agent ends up somewhere not on your `PATH`, the installer writes
`ainxt.binaryPath` into your VS Code settings so the extension finds it anyway.

Overrides, for when the defaults are wrong:

| | |
|---|---|
| `--cli-dir <dir>` | Build from a checkout you already have — no network |
| `AINXT_BINARY_PATH` | Use a binary you already built |
| `AINXT_CLI_REPO_URL` | Clone the agent from a mirror or internal Git host |
| `AINXT_CLI_SRC` | Where the source is cached, if `~` is short on space |
| `AINXT_BASE_URL` | Your own artifact host, passed through to the agent's installer |
| `--no-rust` | Never install a toolchain; fail instead |
| `--skip-cli` | Leave the agent entirely alone |

> **Right now, neither repository is public** (see the note above), so steps 2 and 3
> both fail on a bare machine and the installer tells you so instead of pretending.
> Until publication, point it at a checkout:
>
> ```sh
> ./install.sh --cli-dir /path/to/ainxt-cli
> ```
>
> That path is fully automatic too — toolchain, build, install and verification.

### What you still need

This plugin is a **client**. It contains no agent and no model. Nothing will answer you
until both of these exist:

| | What | Where |
|---|---|---|
| 1 | **`ainxt` CLI** — the agent the plugin launches as a subprocess, with a model configured (`ainxt login`, `AINXT_API_KEY`, or a `[model.*]` entry in `~/.ainxt/config.toml`) | **The installer fetches, builds and verifies this for you** — see [The agent](#the-agent) |
| 2 | **A model** — a cloud provider, Ollama, or any OpenAI-compatible endpoint | You choose one; see [Getting started (self-hosted / OSS)](#getting-started-self-hosted--oss) below |

The installer sets up (1) and tells you plainly if (2) still needs configuring. Neither
of these needs the **AiNxt Platform** — that is a separate, optional service for teams
that want shared auth, budgets, policy and audit; see
[How this fits with the other AiNxt repositories](#how-this-fits-with-the-other-ainxt-repositories).

**One thing worth knowing about waiting, if you do configure a gateway.** The agent
retries a failing gateway up to 15 times and prints nothing while it does — around 340
seconds that looks exactly like a hang. The extension caps this for interactive use so a
wrong gateway URL surfaces as an error instead of a five-minute spinner. If you drive
`ainxt` from a terminal or CI, set `AINXT_MAX_RETRIES=2` yourself and add a job timeout.

### Per-IDE detail


> **Neither plugin is published yet.** There is no VS Code Marketplace listing and
> no release archive, so **building from source is currently the only way to
> install either one**. The steps below reflect that. The marketplace and release
> routes are noted where they will apply once publishing happens.

### VS Code

1. Install the `AiNxt` CLI — build it from [`ainxt-cli`](https://github.com/npci/ainxt-cli),
   which is the repository that produces the `ainxt` binary.
2. Give it a model: run `ainxt login` (writes `~/.ainxt/credentials.json`, which the
   extension reads automatically), set `AINXT_API_KEY`, or add a `[model.*]` entry to
   `~/.ainxt/config.toml` for a direct provider (Anthropic, OpenAI, Ollama, …).
3. Install the extension — one command from the repository root:
   ```sh
   ./install.sh          # or: irm .../install.ps1 | iex   on Windows
   ```
   Or build it by hand:
   ```sh
   cd vscode-acp
   npm ci
   npm run package:vsix                       # produces ainxt-vscode-<version>.vsix
   code --install-extension ainxt-vscode-*.vsix
   ```
   *Once published, this becomes: search **AiNxt** in the Extensions panel.*
4. Open the **AiNxt** panel from the Activity Bar and start typing — no gateway needed.
5. Only if your team runs the AiNxt Platform, click **Connect** and enter its URL.

See [`vscode-acp/README.md`](vscode-acp/README.md) for full configuration.

### IntelliJ

1. Install the `ainxt` CLI — build it from [`ainxt-cli`](https://github.com/npci/ainxt-cli).
2. Give it a model: run `ainxt login`, set `AINXT_API_KEY`, or add a `[model.*]` entry
   to `~/.ainxt/config.toml` for a direct provider.
3. Build the plugin from source (see the link below), then install it via
   **Settings → Plugins → Install from Disk**. *Once published, a release `.zip`
   will be available instead.*
4. Open the **AiNxt** tool window (right dock) and start typing — no gateway needed.
5. Only if your team runs the AiNxt Platform, configure it via **Settings → Tools →
   AiNxt** or click **Connect** in the tool window.

See [`hosts/intellij/README.md`](hosts/intellij/README.md) for build-from-source instructions.

---

## How this fits with the other AiNxt repositories

AiNxt is published as four separate repositories. They are **not** a monorepo, you do
not need all of them, and — this is the part worth stating plainly — **there is no
required order that starts with the Platform.** `ainxt-code` needs exactly one other
repository, `ainxt-cli`, and that's it.

**You are here: `ainxt-code`** — the IDE plugins.

```mermaid
flowchart TB
    CODE["<b>ainxt-code</b><br/>IDE plugins<br/><i>VS Code · IntelliJ</i>"]
    CLI["<b>ainxt-cli</b><br/>terminal agent<br/><i>TUI and headless</i>"]
    M["Model provider<br/><i>Anthropic · OpenAI · Ollama · vLLM · …</i>"]

    PLAT["<b>ainxt-enterprise</b>  —  AiNxt Platform (optional)<br/>FastAPI · :8000 · React UI :5173<br/><i>/ainxt/v1/api/* · /v1/chat/completions</i>"]

    RT["<b>ainxt-os</b>  —  AiNxt Runtime<br/>ainxt-runtimed · :8080<br/><i>optional sidecar</i>"]

    DB[("PostgreSQL + Redis<br/>and one model provider<br/><i>only needed behind the Platform</i>")]

    CODE -->|"launches as a subprocess"| CLI
    CLI -->|"direct, by default"| M
    CLI -.->|"only if you configure one"| PLAT
    PLAT -.-> M
    PLAT -.-> DB
    PLAT -.->|"RUNTIME_URL"| RT

    classDef opt stroke-dasharray: 4 3
    class PLAT,RT,DB opt
```

| Repository | What it is | Port | Do you need it? |
|---|---|---|---|
| **`ainxt-cli`** — terminal agent | A TUI coding agent, also runs headless for CI. `ainxt-code` launches it as a subprocess. | — | **Yes.** The only other repository this one requires. |
| **`ainxt-enterprise`** — AiNxt Platform | The gateway. Python/FastAPI. Serves `/ainxt/v1/api/*` (auth, budgets, skills, admin) and an OpenAI-compatible `/v1/chat/completions`. Ships a React UI. | `8000` (API), `5173` (UI) | Optional. Only for a shared, governed, multi-user deployment — most individual setups don't need it. |
| **`ainxt-code`** — IDE plugins | VS Code extension and IntelliJ plugin. | — | This repository. Talks to `ainxt-cli` over ACP; talks to the Platform only if you configure a gateway URL. |
| **`ainxt-os`** — AiNxt Runtime | A Rust network service (`ainxt-runtimed`) for governed turns: compliance gates, replay, ledger, graph. | `8080` | Optional. The Platform can use it as a sidecar (`RUNTIME_URL`); irrelevant if you are not running the Platform. |

**The dependency you cannot skip:** a model, from somewhere. Nothing in this suite
bundles one. PostgreSQL and Redis are only needed if you additionally choose to run the
Platform.

**A note on ports, if you do run the Platform.** It binds **`8000`** by default and
`ainxt-runtimed` binds `8080`. If a client reports "gateway not reachable", check the
port first.

Be careful here, because the Platform repository is not self-consistent about
it: `.env.example` sets `BIND=0.0.0.0:9001` and its README says `9001`, but
`gunicorn.conf.py` never loads `.env`, so `BIND` is unset unless you export it
yourself and the server falls back to `0.0.0.0:8000` — which is also what the
`Dockerfile` exposes and health-checks. **8000 is what you actually get.** If
you want 9001, export `BIND` into the environment before starting the server,
and set `AINXT_GATEWAY_URL` on the clients to match.

---

## Fully configurable — no hardcoded values

Every setting is configurable via environment variable, IDE settings, or the
in-panel Connect form. Priority order (highest first):

```
Environment variable          ← CI/CD, Docker, scripted deployments
  ↓
IDE Settings                  ← VS Code: Settings → Extensions → AiNxt
                                 IntelliJ: Settings → Tools → AiNxt
  ↓
In-panel Connect form         ← writes to IDE Settings
  ↓
Configuration profile         ← load via command palette or first-run prompt
  ↓
Safe default                  ← no gateway (standalone), empty model
```

### Getting started (self-hosted / OSS)

**This plugin is a generic client for whatever the `ainxt` CLI is configured to talk
to.** By default there is no gateway at all: the CLI reads its model straight out of
`~/.ainxt/config.toml`, `AINXT_API_KEY`, or a signed-in session from `ainxt login`
against your own provider. Anthropic, OpenAI, Ollama, vLLM, or any OpenAI-compatible
endpoint all work this way — see the CLI's own `CONFIG.md` for the full list of
provider examples.

```bash
# Standalone — no gateway. Pick one:
ainxt login                                  # against your own OAuth/OIDC provider
export AINXT_API_KEY=sk-...                  # or a raw provider key
# or add a [model.*] entry with its own api_key/env_key to ~/.ainxt/config.toml
```

An **AiNxt Platform** gateway (`/ainxt/v1/api/*` — auth, budgets, policy, audit,
served by the separate `ainxt-enterprise` repository) is optional, only relevant if
your team wants a shared, governed, multi-user deployment. If you do run one:

```bash
export AINXT_GATEWAY_URL=http://your-gateway:8000
export AINXT_API_KEY=your_api_key   # create one in the platform: Profile → API keys
```

Either way, the **Connect** panel inside the IDE saves whichever of an API key or a
gateway URL you actually need — neither field is required to fill in the other.

### Configuration profiles

The plugin ships with ready-made configuration profiles for common deployments.
Load one via the command palette: **AiNxt: Load Configuration Profile**.

| Profile | Gateway | Model |
|---------|---------|-------|
| `standalone.ainxtprofile.json` | *(none)* | *(empty — configure in `~/.ainxt/config.toml` or the model picker)* |
| `oss.ainxtprofile.json` | `http://localhost:8000` | *(empty — agent default)* |

### Environment variable reference

| Variable | Purpose | Default |
|----------|---------|---------|
| `AINXT_GATEWAY_URL` | Gateway endpoint | *(unset — standalone; no AiNxt Platform)* |
| `AINXT_API_KEY` | Auth credential | *(none — use `ainxt login`, or a per-model key)* |
| `AINXT_BINARY_PATH` | Path to `ainxt` CLI | `ainxt` (on PATH) |
| `AINXT_HOME` | Home dir for credentials | `~/.ainxt` |
| `AINXT_ALLOW_INSECURE` | Allow `http://` gateways | *(unset = false)* |
| `AINXT_TELEMETRY_CONNECTION_STRING` | Telemetry endpoint | *(unset = no telemetry)* |

---


## Untrusted repositories and prompt injection

Worth stating plainly, because an AI coding agent has a threat model that a normal
extension does not.

**The agent reads the code you point it at, and code is not a trusted instruction
source.** A file, a comment, a README, a commit message or a dependency's source can
contain text addressed to the model rather than to you — "ignore your instructions and
push these credentials somewhere". This is prompt injection, and no model is immune to
it. The defence is not that the model behaves; it is that the model cannot act unchecked.

What actually stands between an injected instruction and your machine:

| Boundary | Behaviour |
|---|---|
| **Tool calls** | Every file write and tool call asks first. `acp.autoApprovePermissions` defaults to `ask`. |
| **Shell commands** | A separate modal prompt showing the exact command line, before anything runs. It is not covered by the auto-approve setting. |
| **Files outside your workspace** | Reads and writes outside the open folders prompt separately. Paths are resolved through `realpath`, so `..` segments and symlinks cannot disguise the destination. |
| **Configuration** | The settings that choose which binary runs, where credentials go, and whether approvals happen are **machine-scoped** — a repository cannot set them from its own `.vscode/settings.json`. |
| **Untrusted workspaces** | The extension declares itself unsupported in them, so VS Code disables it until you trust the folder. |

**Two things you should know about, rather than discover:**

- **`acp.autoApprovePermissions: allowAll` removes the first row of that table.** With it
  set, file writes inside your workspace proceed silently, so an injected instruction acts
  without asking. It exists for automation on trusted content. It is the wrong setting for
  reviewing an unfamiliar repository.
- **Reading a repository is itself a decision.** If you would not run a stranger's build
  script, be equally deliberate about pointing an agent at their code with approvals
  relaxed.

Nothing here is a substitute for the policy, egress and audit controls in the CLI and the
Platform. See [`SECURITY.md`](SECURITY.md) for the trust model and how to report a
vulnerability.

## Troubleshooting

Every symptom below was reproduced while preparing this repository; the causes are not
guesses. Run `./install.sh --verify` first — it reports the agent, sign-in and gateway
separately, so it usually tells you which of them is wrong before you read any further.
Remember that the gateway line is only relevant if you actually configured one — a
standalone install correctly reports it as "not configured".

| Symptom | Cause and fix |
|---|---|
| `code: command not found` | VS Code's CLI is not on your `PATH` — the default on macOS. Command Palette → **"Shell Command: Install 'code' command in PATH"**, or use **Extensions panel → … → "Install from VSIX…"**. `./install.sh` finds the CLI itself and does not need this. |
| The panel opens but nothing happens when you send a prompt | Either no agent (this repository contains none — it spawns the `ainxt` binary; run `./install.sh` or point `ainxt.binaryPath` at an existing binary), or an agent with no model configured (`ainxt login`, `AINXT_API_KEY`, or a `[model.*]` entry in `~/.ainxt/config.toml` — no gateway required). |
| "ACP connection closed" / agent not found, right after adding `ainxt` to `PATH` | VS Code (and any terminal open inside it) only reads `PATH` at process launch — changing it while VS Code is already running has no effect, and **Reload Window doesn't help either**, since that reloads the extension host inside the same OS process without re-reading the environment. Fully quit VS Code (check no `Code.exe` is left in Task Manager / Activity Monitor) and reopen it. |
| `ACP handshake failed` from the installer | An `ainxt` binary exists but does not speak the protocol — a partial build, or a different program named `ainxt` earlier on your `PATH`. Check with `ainxt agent --no-leader stdio`; a working agent replies with JSON. |
| "gateway not reachable" | Only relevant if you set `ainxt.gatewayUrl` / `--gateway`. If you didn't mean to use the AiNxt Platform at all, clear `ainxt.gatewayUrl` and configure a model directly instead (see [Getting started (self-hosted / OSS)](#getting-started-self-hosted--oss)). If you do run the Platform, it binds **8000** by default; its `.env.example` says `9001`, but `gunicorn.conf.py` never reads `.env`, so `BIND` is unset and you get 8000 unless you export it yourself. |
| `401` on `auth/me` / `budget/me` | These only matter if you configured a gateway. Not signed in against it: run `ainxt login`, which writes `~/.ainxt/credentials.json`. For the CLI's own model credential (used in standalone mode), see the `AINXT_API_KEY` / `config.toml` options above — no gateway login is needed for those. |
| The panel spins for minutes with no output and no error | Only happens with a gateway configured that isn't answering: the agent retries a failing gateway up to 15 times and prints nothing while it does — roughly 340 seconds, which looks exactly like a hang. The extension caps this for interactive use. If you drive `ainxt` from a terminal or CI, set `AINXT_MAX_RETRIES=2` yourself and add a timeout. |
| Autocomplete is enabled but never suggests anything | Autocomplete (`ainxt.autocomplete`) is the one feature that does need a gateway — it posts to `/ainxt/v1/api/complete`, which the AiNxt Platform does not implement even when you do run one. The **AiNxt** output channel logs one line explaining this. Chat and agent features do not use this endpoint. See [`vscode-acp/README.md`](vscode-acp/README.md#known-limitations). |
| `npm` prints `EBADENGINE` for eleven packages | You are on Node 20. The build toolchain (`@vscode/vsce`, `@vscode/test-electron`) declares `node >=22`; see `.nvmrc`. The build still completes, but use Node 22+ to avoid the warnings. |
| `npm test` fails immediately on Linux | `vscode-test` launches a real VS Code and needs a display. Run it as `xvfb-run -a npm test`. |
| Gradle fails with `Shared UI not built` | The IntelliJ plugin serves the same React bundle as VS Code and cannot start without it. Build it first: `cd vscode-acp/webview-ui && npm ci && npm run build`. |
| `./gradlew` fails to start | `JAVA_HOME` is unset or points at a JDK older than 17. The wrapper downloads Gradle itself, but it cannot supply a JVM. |
| Your network blocks `cdn.agentclientprotocol.com` | The extension fetches the ACP agent registry from there. Point `ainxt.registryUrl` at an internal mirror; it must be `https://` or loopback. Nothing else in the extension reaches the public internet. |

If none of these fit, the **AiNxt** output channel in VS Code carries the extension's own
log. Setting `acp.logTraffic` to `true` adds the full ACP protocol exchange, which is the
fastest way to see whether the agent is answering at all.

## Documentation

| Document | What it covers |
|---|---|
| [`README.md`](README.md) (this file) | One-command install, configuration precedence, quick start per IDE |
| [`vscode-acp/README.md`](vscode-acp/README.md) | The VS Code extension in detail — settings, profiles, the Connect panel |
| [`hosts/intellij/README.md`](hosts/intellij/README.md) | The IntelliJ plugin |
| [`SECURITY.md`](SECURITY.md) | Supported versions, reporting a vulnerability, the trust model, transport and credential posture, cryptographic inventory |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How the maintaining team works. **Contributions are not open yet** — the licence still grants every right it says it does |
| [`GOVERNANCE.md`](GOVERNANCE.md) · [`MAINTAINERS.md`](MAINTAINERS.md) | Project roles, how decisions are made, and who is accountable |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Expected conduct, and how to report a problem privately |
| [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) | Licences and copyright notices for the 122 third-party packages redistributed inside the `.vsix` |
| [`CHANGELOG.md`](CHANGELOG.md) | Repository-level release history |
| [`vscode-acp/CHANGELOG.md`](vscode-acp/CHANGELOG.md) | VS Code extension release history |
| [`docs/README.md`](docs/README.md) | Index of the generated per-module reference pages, and what they are good for |

**You need the `ainxt` CLI with a model configured — nothing else.** This plugin is a
client of the CLI, not of any particular backend; see
[Getting started (self-hosted / OSS)](#getting-started-self-hosted--oss) above. The
AiNxt Platform (`ainxt-enterprise`, serving `/ainxt/v1/api/*`) is a separate, optional
service for teams that want shared auth, budgets, policy and audit — start there only
if that's what you're setting up; its `docs/GETTING_STARTED.md` takes about twenty
minutes.

## Repository layout

```
install.sh           One-command install (macOS/Linux): detect -> install -> verify
install.ps1          One-command install (Windows PowerShell)
setup.sh             Build from source: prerequisites -> deps -> .vsix
vscode-acp/          VS Code extension (TypeScript + React webview)   ← active
  src/               Extension host code
  webview-ui/        React + Vite chat UI (shared with IntelliJ)
  config/
    standalone.ainxtprofile.json  No gateway — direct model config (recommended default)
    oss.ainxtprofile.json         Self-hosted AiNxt Platform gateway defaults
hosts/
  intellij/          IntelliJ plugin (Kotlin + JCEF)                  ← active
docs/                Reference pages (generated) — see docs/README.md
  overview.md        Module map: start here
  extension/         The VS Code extension host
  webview/           The shared React UI
  intellij/          The JetBrains plugin
  images/            Screenshots used by this README
  generated/         Generator state, not documentation
scripts/
  acp-probe.mjs      Dependency-free raw ACP handshake probe
  acp-probe-auth.mjs Auth-aware probe
  check-release-invariants.sh  Asserts the properties a fresh clone depends on
```

---

## Contributing

**Contributions are not open yet.** Published under Apache-2.0 as source-available;
external pull requests and issues are not currently accepted or triaged. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the posture and the team's workflow.

**Security vulnerabilities are the exception** — report those privately at any time
via [SECURITY.md](SECURITY.md).

## Acknowledgements

This project was originally derived from
[formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp)
(MIT License, Copyright (c) 2026 Jun Han). It has been substantially modified
and extended for this fork; the copyright holder is named in
[`NOTICE`](NOTICE) and [`LICENSE`](LICENSE), which is where such a claim belongs. See [NOTICE](NOTICE) for full attribution.

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

## Disclaimer

Licensed under the Apache License, Version 2.0. You may obtain a copy of the
licence at <http://www.apache.org/licenses/LICENSE-2.0> or in [`LICENSE`](LICENSE).

Unless required by applicable law or agreed to in writing, this software is
distributed on an **"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND**,
either express or implied. See the licence for the specific language governing
permissions and limitations, in particular §7 (Disclaimer of Warranty) and §8
(Limitation of Liability).

<!-- Worded from Apache-2.0's own text on purpose. The more familiar
     "free software / redistribute / no warranty" disclaimer paragraph that many
     projects use is the GPL's own "How to Apply These Terms" boilerplate. Pasting
     it into an Apache-2.0 project reads as a GPL notice and a licence scanner will
     classify it as one, so it is avoided here rather than reproduced. -->
