# AiNxt Code — JetBrains plugin (IntelliJ / PyCharm / GoLand / WebStorm …)

Governed AiNxt Code - coding agent for JetBrains IDEs. A JCEF tool window that spawns the
governed `ainxt` CLI over the Agent Client Protocol and renders the **same** React UI
as the AiNxt VS Code extension, so policy/egress/exec guardrails, Sovereign approvals,
and audit all apply identically.

## Architecture (shared with VS Code)

```
JetBrains IDE
  └─ AiNxt tool window (JCEF browser)
       ├─ shared React UI  ← ../../vscode-acp/webview-ui/dist  (identical bundle)
       │     talks via window.__ainxtHostPost  ⇄  JBCefJSQuery
       └─ Bridge (Kotlin)  ─ ACP JSON-RPC over stdio ─  ainxt agent
                                                              └─ AiNxt gateway
```

- **Shared UI**: `WebviewScheme` serves the built bundle over `http://ainxt/…`
  (Chromium blocks ES-module loading over `file://`).
- **Host**: `AinxtToolWindowFactory` + `Bridge` implement the same postMessage
  contract the VS Code webview uses (`ready`, `sendPrompt`, `permissionResponse`,
  `saveConnection`, `signOut`, `setModel`; host→UI `state`, `sessionUpdate`,
  `promptStart/End`, `permissionRequest`, `authState`, `clearChat`, `error`).
- **ACP**: `AcpClient` spawns `ainxt agent --no-leader -m <model> stdio` so
  conversations survive IDE reloads; `connectOrResume` resumes the last session.
  When no model is configured, spawns `ainxt agent --no-leader stdio` and lets
  the agent use its own built-in default.
- **Settings**: `AinxtSettings` (gateway URL / allowInsecure / model / binaryPath) +
  `AinxtSecrets` (API key in the IDE PasswordSafe). The in-panel **Connect** form and
  the identity chip work exactly as in VS Code.

## Configuration

All settings are configurable — no hardcoded values. Priority order (highest first):

| Priority | Method | Example |
|----------|--------|---------|
| 1 | Environment variable | `AINXT_GATEWAY_URL=http://gateway:8000` |
| 2 | IntelliJ Settings panel | **Settings → Tools → AiNxt** |
| 3 | In-panel Connect form | Click **Connect** in the tool window |
| 4 | Code default | `http://localhost:8000` |

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `AINXT_GATEWAY_URL` | Gateway endpoint | `http://localhost:8000` |
| `AINXT_API_KEY` | Auth credential | *(none — use `ainxt login`)* |
| `AINXT_BINARY_PATH` | Path to `ainxt` CLI | `ainxt` (on PATH) |
| `AINXT_HOME` | Home dir for credentials | `~/.ainxt` |
| `AINXT_ALLOW_INSECURE` | Allow http:// gateways | *(unset = false)* |

## Prerequisites

| Requirement | Notes |
|---|---|
| **JDK 17+** | The build targets 17 bytecode but does not demand a 17 *toolchain*, so a newer JDK works. `JAVA_HOME` must point at it. |
| **Node 20+** | Only to build the shared React UI (below). See the repository `.nvmrc`. |
| **Gradle** | Not installed separately — use the committed wrapper (`./gradlew`). |
| **Disk / network** | The first build downloads IntelliJ IDEA Community 2024.3 (~1 GB) unless you pass `-PlocalIde`. |

The shared UI must be built first — the tool window serves that bundle over
`http://ainxt/…` and is non-functional without it:

```bash
cd ../../vscode-acp/webview-ui && npm install && npm run build
```

The Gradle `syncWebview` task copies `dist/` into the plugin resources at build
time and fails with an explicit message if you skip this step.

## Build & run

There is no one-command install for JetBrains: plugins are installed from disk through
the IDE's own UI, so the repository's `install.sh` / `install.ps1` deliberately cover the
VS Code side only and print the JetBrains steps at the end rather than pretending to
automate them.

The wrapper and the build script are both committed, so this builds as cloned:

```bash
export JAVA_HOME=/path/to/jdk17        # if `java` is not already on PATH
./gradlew buildPlugin                  # -> build/distributions/ainxt-intellij-<version>.zip
./gradlew runIde                       # launch a sandbox IDE with the plugin
```

To compile against the IDE you will actually run the plugin in — which avoids the
~1 GB IDEA Community download and catches API drift a different edition would
hide — point the build at a local installation:

```bash
./gradlew buildPlugin -PlocalIde=/Applications/PyCharm.app
```

Install the zip in any JetBrains IDE via **Settings → Plugins → ⚙ → Install Plugin
from Disk…**, then open the **AiNxt Code** tool window on the right.

Point it at your gateway with the **Connect** button (or pre-seed
`AINXT_GATEWAY_URL` / `AINXT_BINARY_PATH` in the environment).

What the build does, for reference: applies the
[IntelliJ Platform Gradle Plugin](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html)
2.2.1 and Kotlin JVM 2.0.21, targets a JCEF-capable platform, sets Java/Kotlin
target 17, takes `src/main/kotlin` + `src/main/resources` as the source sets,
copies the shared webview bundle into plugin resources, declares `sinceBuild=233`
with no upper bound, and exposes the standard `runIde` / `buildPlugin` tasks.

## Notes / limitations

- Like the VS Code side, changing the gateway URL after the leader daemon is running
  requires a fresh connect (the Connect form respawns the agent); the very first
  connection applies cleanly.
- `./gradlew buildPlugin` is verified to produce an installable plugin zip on macOS
  arm64 with JDK 17. The tool window itself is a GUI surface and has **not** been
  exercised headlessly — launch `./gradlew runIde` and drive the panel by hand.
