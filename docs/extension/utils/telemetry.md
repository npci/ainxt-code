# utils_telemetry Module

## Brief Introduction

The `utils_telemetry` module provides a thin, centralized wrapper around the Visual Studio Code extension telemetry SDK (`@vscode/extension-telemetry`). It is responsible for initializing a single shared `TelemetryReporter`, attaching common IDE context properties to every event, and exposing helper functions used by the rest of the VS Code ACP extension to send usage events, error events, and caught exceptions.

This module is intentionally small and stateless: it owns the telemetry reporter singleton, ensures it is initialized exactly once during extension activation, and guarantees that every emitted event carries consistent environment metadata (IDE name, URI scheme, and app host).

---

## Core Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **Reporter lifecycle** | Create and cache a single `TelemetryReporter` instance; expose it for disposal via `context.subscriptions`. |
| **Common context** | Attach IDE environment properties to every telemetry payload. |
| **Event emission** | Provide typed helpers for normal events, error events, and exception reporting. |
| **Privacy-safe abstraction** | Keep the instrumentation key and telemetry SDK details encapsulated so callers only supply event names and properties. |

---

## Architecture

```mermaid
flowchart TB
    subgraph utils_telemetry["utils_telemetry (TelemetryManager.ts)"]
        init["initTelemetry()"]
        common["getCommonProperties()"]
        send["sendEvent()"]
        sendErr["sendError()"]
        sendEx["sendException()"]
        reporter[("TelemetryReporter singleton")]
    end

    subgraph vscode_api["VS Code API"]
        vscode_env["vscode.env<br/>appName / uriScheme / appHost"]
    end

    subgraph telemetry_sdk["@vscode/extension-telemetry"]
        sdk_reporter["TelemetryReporter"]
    end

    subgraph consumers["Telemetry Consumers"]
        ext["extension_activation"]
        session["session_management"]
        agent["agent_management"]
        ui["extension_ui / chat_webview"]
    end

    init -->|creates| reporter
    reporter -->|wraps| sdk_reporter
    sdk_reporter -->|sends to| azure["Azure Application Insights"]

    common -->|reads| vscode_env
    send -->|merges common + custom| reporter
    sendErr -->|merges common + custom| reporter
    sendEx -->|merges common + error| reporter

    ext -->|calls initTelemetry| init
    session -->|calls sendEvent / sendError| send
    agent -->|calls sendEvent / sendError| send
    ui -->|calls sendEvent| send
```

### Component Overview

| Component | Type | Purpose |
|-----------|------|---------|
| `initTelemetry` | Exported function | Initializes the singleton `TelemetryReporter` and returns it so the caller can register it for disposal. |
| `getCommonProperties` | Internal function | Builds a record of IDE environment metadata attached to every event. |
| `sendEvent` | Exported function | Sends a named telemetry event with optional string properties and numeric measurements. |
| `sendError` | Exported function | Sends a non-exception error event through the normal telemetry pipeline. |
| `sendException` | Exported function | Reports a caught `Error` object as an error event, including the error name and message. |
| `reporter` | Module-level variable | Cached `TelemetryReporter` instance; initialized lazily by `initTelemetry`. |

---

## Data Flow

### Initializing Telemetry

```mermaid
sequenceDiagram
    participant Ext as extension_activation
    participant TM as TelemetryManager
    participant SDK as @vscode/extension-telemetry
    participant AI as Application Insights

    Ext->>TM: initTelemetry()
    TM->>TM: reporter already set?
    alt reporter is undefined
        TM->>SDK: new TelemetryReporter(CONNECTION_STRING)
        SDK-->>TM: TelemetryReporter instance
        TM->>TM: cache reporter
    end
    TM-->>Ext: return reporter
    Ext->>Ext: context.subscriptions.push(reporter)
    Note over Ext,AI: Reporter flushes queued events on disposal
```

### Sending a Telemetry Event

```mermaid
sequenceDiagram
    participant Consumer as Any Consumer
    participant TM as TelemetryManager
    participant VS as vscode.env
    participant SDK as TelemetryReporter

    Consumer->>TM: sendEvent(name, properties, measurements)
    TM->>VS: read appName, uriScheme, appHost
    VS-->>TM: common properties
    TM->>TM: merge common + custom properties
    TM->>SDK: sendTelemetryEvent(name, mergedProps, measurements)
```

### Reporting an Exception

```mermaid
sequenceDiagram
    participant Consumer as Any Consumer
    participant TM as TelemetryManager
    participant SDK as TelemetryReporter

    Consumer->>TM: sendException(error, properties)
    TM->>TM: getCommonProperties()
    TM->>TM: add errorName & errorMessage
    TM->>SDK: sendTelemetryErrorEvent('unhandledException', mergedProps)
```

---

## Component Details

### `initTelemetry()`

```typescript
export function initTelemetry(): TelemetryReporter
```

- Creates the module-level `TelemetryReporter` if it does not already exist.
- Returns the existing reporter on subsequent calls to avoid duplicate initialization.
- The returned reporter should be pushed into the extension's `context.subscriptions` so that it is automatically disposed when the extension deactivates.

### `getCommonProperties()`

```typescript
function getCommonProperties(): Record<string, string>
```

- Returns an object containing:
  - `ideName`: `vscode.env.appName`
  - `ideUriScheme`: `vscode.env.uriScheme`
  - `ideAppHost`: `vscode.env.appHost`
- These properties are merged into every event payload automatically.

### `sendEvent()`

```typescript
export function sendEvent(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void
```

- Sends a standard telemetry event.
- Merges caller-supplied `properties` with the common IDE properties.
- Optional `measurements` can be used for numeric metrics (e.g., latency, counts).

### `sendError()`

```typescript
export function sendError(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void
```

- Sends an error event that is **not** derived from a thrown exception.
- Useful for reporting business-logic failures or handled error states.

### `sendException()`

```typescript
export function sendException(error: Error, properties?: Record<string, string>): void
```

- Sends a telemetry error event for a caught `Error`.
- Always uses the event name `unhandledException`.
- Adds `errorName` and `errorMessage` to the property payload.

---

## Module Relationships

```mermaid
flowchart LR
    utils_telemetry["utils_telemetry<br/>TelemetryManager"]
    utils_logging["utils_logging<br/>Logger"]
    extension_activation["extension_activation<br/>extension.ts"]
    session_management["session_management<br/>SessionManager"]
    agent_management["agent_management<br/>AgentManager / AcpClientImpl"]
    chat_webview["chat_webview<br/>ChatWebviewProvider"]

    extension_activation -->|initializes & disposes| utils_telemetry
    session_management -->|emits events| utils_telemetry
    agent_management -->|emits events| utils_telemetry
    chat_webview -->|emits events| utils_telemetry
    utils_telemetry -.->|complements| utils_logging
```

### Upstream Dependencies

- **`@vscode/extension-telemetry`** — Provides the `TelemetryReporter` class that handles batching, flushing, and transmission to Azure Application Insights.
- **`vscode`** — Used to read environment metadata (`vscode.env`) for common properties.

### Downstream Consumers

- **[extension_activation](../activation.md)** — Calls `initTelemetry()` during `activate()` and registers the returned reporter in `context.subscriptions`.
- **[session_management](../session-management/README.md)** — May emit telemetry for session lifecycle actions, auth flows, and connection outcomes.
- **[agent_management](../agent-management/README.md)** — May emit telemetry for agent spawn/kill events and tool invocations.
- **[chat_webview](../chat-webview/README.md)** — May emit telemetry for UI interactions such as prompt submission, mode changes, and attachment usage.

> **Note:** The telemetry module does **not** depend on `utils_logging`, but the two utilities are typically used together: `Logger` writes human-readable diagnostics to the Output channel, while `TelemetryManager` sends anonymized, aggregated events to the telemetry backend. See [utils_logging](logging.md) for details.

---

## Privacy & Configuration Considerations

- The instrumentation key is hard-coded in `TelemetryManager.ts` and is not user-configurable.
- The module only collects VS Code environment metadata that is already exposed by the `vscode.env` API.
- Callers are responsible for ensuring that no personally identifiable information (PII), file contents, or secrets are included in telemetry `properties`.
- The `TelemetryReporter` from `@vscode/extension-telemetry` respects VS Code's global telemetry setting; events are not sent when telemetry is disabled by the user.

---

## Process Flow: Extension Activation

```mermaid
flowchart TB
    Start([Extension activated]) --> Activate["extension.ts activate()"]
    Activate --> InitTelemetry["utils_telemetry.initTelemetry()"]
    InitTelemetry --> Register[Register reporter in context.subscriptions]
    Register --> Run[Extension runs]
    Run --> Emit["Consumers call sendEvent / sendError / sendException"]
    Emit --> Merge["TelemetryManager merges common properties"]
    Merge --> Send["TelemetryReporter sends to backend"]
    Deactivate([Extension deactivated]) --> Dispose[Dispose reporter]
    Dispose --> Flush[Flush remaining queued events]
```

---

## References

- [extension_activation](../activation.md) — Where the telemetry reporter is initialized and disposed.
- [utils_logging](logging.md) — Complementary local diagnostic logging utility.
- [session_management](../session-management/README.md) — Consumer of telemetry for session lifecycle events.
- [agent_management](../agent-management/README.md) — Consumer of telemetry for agent operations.
- [chat_webview](../chat-webview/README.md) — Consumer of telemetry for UI interaction events.
