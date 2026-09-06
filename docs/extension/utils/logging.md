# utils_logging Module

## Brief Introduction

The `utils_logging` module provides centralized logging infrastructure for the VS Code ACP extension. It manages VS Code output channels, writes timestamped diagnostic messages, and optionally logs ACP protocol traffic between the extension and running agents. The module is intentionally lightweight and stateful, lazily creating output channels on first use and exposing simple functions that can be called from anywhere in the extension.

---

## Core Responsibilities

| Responsibility | Description |
| -------------- | ----------- |
| Output channel management | Lazily creates and disposes VS Code `OutputChannel` instances for general logs and ACP traffic. |
| General logging | Writes timestamped messages and serialized arguments to the **AiNxt** output channel. |
| Error logging | Writes error messages with stack traces to the **AiNxt** output channel. |
| Traffic logging | Writes classified ACP request/notification/response messages to the **ACP Traffic** output channel, gated by the `acp.logTraffic` setting. |
| Resource cleanup | Disposes both output channels during extension deactivation. |

---

## Architecture

The module is implemented as a small set of module-level functions in `vscode-acp/src/utils/Logger.ts`. Two private module variables cache the VS Code output channels so that repeated calls reuse the same channel instances.

```mermaid
flowchart TB
    subgraph VSCodeAPI["VS Code Extension API"]
        OC[vscode.OutputChannel]
        CFG[vscode.workspace.getConfiguration]
        WIN[vscode.window.createOutputChannel]
    end

    subgraph utils_logging["utils_logging module"]
        _outputChannel[( _outputChannel )]
        _trafficChannel[( _trafficChannel )]
        getOutputChannel["getOutputChannel()"]
        getTrafficChannel["getTrafficChannel()"]
        log["log(message, ...args)"]
        logError["logError(message, error?)"]
        logTraffic["logTraffic(direction, data)"]
        disposeChannels["disposeChannels()"]
    end

    subgraph consumers["Typical Consumers"]
        core["core modules"]
        handlers["handlers modules"]
        ui["extension_ui modules"]
        webview["webview_ui modules"]
    end

    WIN --> getOutputChannel
    WIN --> getTrafficChannel
    getOutputChannel --> _outputChannel
    getTrafficChannel --> _trafficChannel
    log --> getOutputChannel
    logError --> getOutputChannel
    logTraffic --> CFG
    logTraffic --> getTrafficChannel
    disposeChannels --> _outputChannel
    disposeChannels --> _trafficChannel
    consumers --> log
    consumers --> logError
    consumers --> logTraffic
```

### Component Overview

| Component | Type | Purpose |
| --------- | ---- | ------- |
| `getOutputChannel` | Function | Returns the shared **AiNxt** output channel, creating it on first call. |
| `getTrafficChannel` | Function | Returns the shared **ACP Traffic** output channel, creating it on first call. |
| `log` | Function | Appends a timestamped message with optional serialized arguments. |
| `logError` | Function | Appends a timestamped error message and optional stack trace. |
| `logTraffic` | Function | Appends classified ACP traffic when `acp.logTraffic` is enabled. |
| `disposeChannels` | Function | Disposes both cached channels and resets the module state. |

---

## Data Flow

### General Log Flow

```mermaid
sequenceDiagram
    participant Caller as Any Extension Component
    participant log as log() / logError()
    participant getOutputChannel as getOutputChannel()
    participant Channel as AiNxt OutputChannel

    Caller->>log: message (+ optional args/error)
    log->>getOutputChannel: request channel
    alt channel not created
        getOutputChannel->>Channel: vscode.window.createOutputChannel('AiNxt')
        Channel-->>getOutputChannel: channel instance
    end
    getOutputChannel-->>log: cached channel
    log->>log: build ISO timestamp + serialized args
    log->>Channel: appendLine(formatted)
    opt error with stack
        log->>Channel: appendLine(error.stack)
    end
```

### ACP Traffic Log Flow

```mermaid
sequenceDiagram
    participant Caller as ACP Client / Session Manager
    participant logTraffic as logTraffic(direction, data)
    participant Config as vscode workspace config
    participant getTrafficChannel as getTrafficChannel()
    participant Channel as ACP Traffic OutputChannel

    Caller->>logTraffic: direction + JSON-RPC-like message
    logTraffic->>Config: acp.logTraffic (default true)
    alt logging disabled
        Config-->>logTraffic: false
        logTraffic-->>Caller: return early
    else logging enabled
        Config-->>logTraffic: true
        logTraffic->>logTraffic: classify message type<br/>(REQUEST / NOTIFICATION / RESPONSE)
        logTraffic->>getTrafficChannel: request channel
        getTrafficChannel->>Channel: createOutputChannel('ACP Traffic') if needed
        Channel-->>getTrafficChannel: channel instance
        getTrafficChannel-->>logTraffic: cached channel
        logTraffic->>Channel: appendLine(timestamp + arrow + label + JSON payload)
    end
```

---

## Component Interactions

`utils_logging` is a leaf utility module with no internal dependencies on other application modules. It depends only on the VS Code extension API and is consumed by many other modules.

```mermaid
flowchart LR
    subgraph utils_logging["utils_logging"]
        Logger[Logger.ts]
    end

    subgraph utils_siblings["Sibling utils modules"]
        Streaming[utils_streaming<br/>StreamAdapter.ts]
        Telemetry[utils_telemetry<br/>TelemetryManager.ts]
    end

    subgraph core["Core modules"]
        AcpClient[agent_management<br/>AcpClientImpl.ts]
        AgentManager[agent_management<br/>AgentManager.ts]
        SessionManager[session_management<br/>SessionManager.ts]
        ConnectionManager[session_management<br/>ConnectionManager.ts]
    end

    subgraph handlers["Handler modules"]
        FileSystem[handlers<br/>FileSystemHandler.ts]
        Permission[handlers<br/>PermissionHandler.ts]
        SessionUpdate[handlers<br/>SessionUpdateHandler.ts]
        Terminal[handlers<br/>TerminalHandler.ts]
    end

    subgraph ui["UI modules"]
        ChatWebview[extension_ui<br/>ChatWebviewProvider.ts]
        SessionTree[extension_ui<br/>SessionTreeProvider.ts]
        StatusBar[extension_ui<br/>StatusBarManager.ts]
    end

    AcpClient -.->|uses| Logger
    AgentManager -.->|uses| Logger
    SessionManager -.->|uses| Logger
    ConnectionManager -.->|uses| Logger
    FileSystem -.->|uses| Logger
    Permission -.->|uses| Logger
    SessionUpdate -.->|uses| Logger
    Terminal -.->|uses| Logger
    ChatWebview -.->|uses| Logger
    SessionTree -.->|uses| Logger
    StatusBar -.->|uses| Logger
    Streaming -.->|may use| Logger
    Telemetry -.->|may use| Logger
```

> **Note:** The diagram above illustrates typical consumers. For details on how those modules operate, refer to their respective documentation pages: [agent_management](../agent-management/README.md), [session_management](../session-management/README.md), [handlers](../handlers/README.md), [extension_ui](../ui.md), [utils_streaming](streaming.md), and [utils_telemetry](telemetry.md).

---

## Process Flows

### Extension Activation

During `extension.ts` activation, output channels are not created immediately. They are created lazily the first time a log function is called.

```mermaid
sequenceDiagram
    participant ext as extension.ts activate()
    participant Logger as utils_logging
    participant VSCode as VS Code API

    ext->>ext: register providers / commands
    Note over ext,Logger: No output channel created yet
    ext->>Logger: log('AiNxt extension activated')
    Logger->>VSCode: createOutputChannel('AiNxt')
    VSCode-->>Logger: OutputChannel instance
    Logger->>VSCode: appendLine(...)
```

### Extension Deactivation

`disposeChannels()` should be invoked from the extension's `deactivate()` lifecycle hook to release output channel resources.

```mermaid
sequenceDiagram
    participant ext as extension.ts deactivate()
    participant Logger as utils_logging
    participant VSCode as VS Code API

    ext->>Logger: disposeChannels()
    Logger->>VSCode: _outputChannel.dispose()
    Logger->>VSCode: _trafficChannel.dispose()
    Logger->>Logger: reset cached references
```

---

## Configuration

Traffic logging is controlled by the VS Code setting `acp.logTraffic`.

| Setting | Type | Default | Description |
| ------- | ---- | ------- | ----------- |
| `acp.logTraffic` | `boolean` | `true` | Enables or disables logging of ACP request/notification/response traffic. |

When disabled, `logTraffic()` returns immediately without writing to the **ACP Traffic** channel.

---

## Message Classification

`logTraffic` inspects the shape of the payload and labels it accordingly:

| Shape | Label | Example |
| ----- | ----- | ------- |
| Has `method` and `id` | `[REQUEST] <method>` | JSON-RPC request |
| Has `method` but no `id` | `[NOTIFICATION] <method>` | JSON-RPC notification |
| Has `result` or `error` | `[RESPONSE] id=<id>` | JSON-RPC response |
| Other | *(no label)* | Raw traffic data |

The direction is rendered as:

- `send` → `>>> CLIENT → AGENT`
- `recv` → `<<< AGENT → CLIENT`

---

## API Reference

### `getOutputChannel(): vscode.OutputChannel`

Returns the shared **AiNxt** output channel, creating it if necessary.

### `getTrafficChannel(): vscode.OutputChannel`

Returns the shared **ACP Traffic** output channel, creating it if necessary.

### `log(message: string, ...args: unknown[]): void`

Appends a timestamped line to the **AiNxt** channel. Additional arguments are serialized with `JSON.stringify` and appended to the message.

### `logError(message: string, error?: unknown): void`

Appends a timestamped error line to the **AiNxt** channel. If `error` is an `Error` instance, its message and stack trace are also appended.

### `logTraffic(direction: 'send' | 'recv', data: unknown): void`

Appends classified ACP traffic to the **ACP Traffic** channel when `acp.logTraffic` is enabled. The payload is pretty-printed with `JSON.stringify(data, null, 2)`.

### `disposeChannels(): void`

Disposes both cached output channels and resets the internal references so that subsequent calls recreate them.

---

## Design Notes

- **Lazy initialization:** Output channels are created only when first requested, keeping activation overhead minimal.
- **Module-level state:** The cached channel references are private to the module. This avoids passing a logger instance through every constructor while still ensuring a single channel per log type.
- **No log levels:** The module does not implement traditional log levels (debug, info, warn, error). Callers use `log` for general diagnostics and `logError` for errors.
- **Traffic opt-out:** Traffic logging can be noisy, so it is gated by a user-configurable setting.
- **JSON serialization:** Arguments and traffic payloads are serialized to JSON for consistent, inspectable output in the VS Code output panel.

---

## Related Modules

- [utils_streaming](streaming.md) — Adapts child process streams to web streams for ACP communication.
- [utils_telemetry](telemetry.md) — Sends telemetry events; may use logging for local diagnostics.
- [agent_management](../agent-management/README.md) — Spawns and communicates with agents; produces traffic logs.
- [session_management](../session-management/README.md) — Manages sessions and connections; produces traffic logs.
- [handlers](../handlers/README.md) — Implements ACP handlers; consumes logging for file, terminal, and permission operations.
- [extension_ui](../ui.md) — Provides chat webview, session tree, and status bar UI; uses logging for diagnostics.
