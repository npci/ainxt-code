# Chat Webview Bridges

The **chat_webview_bridges** module provides lightweight, stateless bridges that decouple agent-initiated interactive requests from the VS Code chat webview UI. It enables the connection and handler layers deep in the extension core to request in-chat user interactions—permissions, clarifying questions, and plan approvals—without taking a direct dependency on the webview implementation.

---

## Overview

Agent sessions frequently need to pause and ask the user a question, request permission for a tool call, or present a plan for approval before continuing. These interactions originate in the ACP connection layer (as reverse requests or notifications) but must be rendered inside the chat webview so the user can respond without leaving the conversation context.

The bridges solve two problems:

1. **Decoupling** – The connection layer (`AcpClientImpl`) and handlers (`PermissionHandler`) do not know about `ChatWebviewProvider` or VS Code webview APIs.
2. **Lifecycle safety** – The webview may not exist when a request arrives (e.g., during startup or after the panel is closed). Each bridge detects this and returns a safe fallback outcome.

The module contains three tiny, identical-pattern bridge objects:

| Bridge | Source request | UI rendered | Fallback when no UI |
|--------|----------------|-------------|---------------------|
| `askBridge` | `ainxt.dev/ask_user_question` (via `AcpClientImpl.extMethod`) | In-chat "ask" card | `{ outcome: 'cancelled' }` |
| `permissionBridge` | ACP `requestPermission` (via `PermissionHandler`) | In-chat permission card | Throws `Error('no permission UI registered')` |
| `planBridge` | `ainxt.dev/exit_plan_mode` (via `AcpClientImpl.extMethod`) | In-chat plan-approval card | `{ outcome: 'cancelled' }` |

For the webview implementation that consumes these bridges, see [chat_webview_provider.md](provider.md). For the connection layer that originates the requests, see [agent_management.md](../agent-management/README.md) and [session_management.md](../session-management/README.md).

---

## Architecture

The bridges sit between the **core connection/handlers** and the **chat webview UI**. They expose a minimal registration API: the webview provider registers an async handler when the webview becomes available, and the core layers call `bridge.request(...)` whenever the agent needs user input.

```mermaid
flowchart TB
    subgraph Core["Core / Connection Layer"]
        ACP[AcpClientImpl]
        PH[PermissionHandler]
    end

    subgraph Bridges["chat_webview_bridges"]
        AB[askBridge]
        PB[permissionBridge]
        PLB[planBridge]
    end

    subgraph UI["Chat Webview UI"]
        CWP[ChatWebviewProvider]
        WV[Webview Panel]
    end

    ACP -->|ainxt.dev/ask_user_question| AB
    ACP -->|ainxt.dev/exit_plan_mode| PLB
    PH -->|requestPermission| PB

    AB -->|"setUi(handler)"| CWP
    PB -->|"setUi(handler)"| CWP
    PLB -->|"setUi(handler)"| CWP

    CWP -->|posts permission/ask/plan card| WV
    WV -->|user response| CWP
    CWP -->|resolves promise| AB
    CWP -->|resolves promise| PB
    CWP -->|resolves promise| PLB
```

### Component relationships

```mermaid
classDiagram
    class askBridge {
        +setUi(handler: AskUi)
        +hasUi(): boolean
        +request(params: AskParams): Promise~AskResult~
    }

    class permissionBridge {
        +setUi(handler: PermissionUi)
        +hasUi(): boolean
        +request(params: RequestPermissionRequest): Promise~RequestPermissionResponse~
    }

    class planBridge {
        +setUi(handler: PlanUi)
        +hasUi(): boolean
        +request(params: PlanParams): Promise~PlanResult~
    }

    class AcpClientImpl {
        +extMethod(method, params): Promise~Record~string, unknown~~
    }

    class PermissionHandler {
        +requestPermission(params): Promise~RequestPermissionResponse~
    }

    class ChatWebviewProvider {
        +requestAskInWebview(params): Promise~AskResult~
        +requestPermissionInWebview(params): Promise~RequestPermissionResponse~
        +requestPlanApprovalInWebview(params): Promise~PlanResult~
    }

    AcpClientImpl ..> askBridge : calls for ask_user_question
    AcpClientImpl ..> planBridge : calls for exit_plan_mode
    PermissionHandler ..> permissionBridge : calls for permission UI
    ChatWebviewProvider ..> askBridge : registers AskUi
    ChatWebviewProvider ..> permissionBridge : registers PermissionUi
    ChatWebviewProvider ..> planBridge : registers PlanUi
```

---

## Core Components

### `askBridge`

Bridges the agent's `ainxt.dev/ask_user_question` extension method to the in-chat ask card.

- **`setUi(handler)`** – Registers (or unregisters) the UI callback.
- **`hasUi()`** – Returns `true` when a handler is registered.
- **`request(params)`** – Forwards `AskParams` to the UI. If no UI is registered, returns `{ outcome: 'cancelled' }` so the agent can continue gracefully.

`AskParams` carries a list of questions, each with options, optional multi-select support, and an optional mode. `AskResult` is a generic record accepted by the agent.

### `permissionBridge`

Decouples `PermissionHandler` from the permission UI.

- **`setUi(handler)`** – Registers the UI callback.
- **`hasUi()`** – Returns `true` when a handler is registered.
- **`request(params)`** – Forwards the ACP `RequestPermissionRequest` to the UI. If no UI is registered, it throws an error so `PermissionHandler` can fall back to the native VS Code `QuickPick`.

This is the only bridge whose fallback is an error rather than a cancellation outcome, because `PermissionHandler` already owns a native QuickPick fallback path.

### `planBridge`

Bridges the agent's `ainxt.dev/exit_plan_mode` reverse request to the in-chat plan-approval card.

- **`setUi(handler)`** – Registers the UI callback.
- **`hasUi()`** – Returns `true` when a handler is registered.
- **`request(params)`** – Forwards `PlanParams` to the UI. If no UI is registered, returns `{ outcome: 'cancelled' }`, which tells the agent to remain in plan mode.

---

## Data Flow

### Permission request flow

```mermaid
sequenceDiagram
    participant Agent as Agent (ACP server)
    participant ACP as AcpClientImpl
    participant PH as PermissionHandler
    participant PB as permissionBridge
    participant CWP as ChatWebviewProvider
    participant WV as Webview

    Agent->>ACP: requestPermission
    ACP->>PH: requestPermission(params)
    PH->>PB: hasUi()
    PB-->>PH: true
    PH->>PB: request(params)
    PB->>CWP: PermissionUi(params)
    CWP->>WV: postMessage(permissionRequest)
    WV-->>CWP: onDidReceiveMessage(permissionResponse)
    CWP-->>PB: resolve(response)
    PB-->>PH: RequestPermissionResponse
    PH-->>ACP: response
    ACP-->>Agent: outcome
```

### Ask-user question flow

```mermaid
sequenceDiagram
    participant Agent as Agent (ACP server)
    participant ACP as AcpClientImpl
    participant AB as askBridge
    participant CWP as ChatWebviewProvider
    participant WV as Webview

    Agent->>ACP: extMethod(ainxt.dev/ask_user_question)
    ACP->>AB: request(params)
    AB->>CWP: AskUi(params)
    CWP->>WV: postMessage(askRequest)
    WV-->>CWP: onDidReceiveMessage(askResponse)
    CWP-->>AB: resolve(answers)
    AB-->>ACP: AskResult
    ACP-->>Agent: outcome
```

### Plan approval flow

```mermaid
sequenceDiagram
    participant Agent as Agent (ACP server)
    participant ACP as AcpClientImpl
    participant PLB as planBridge
    participant CWP as ChatWebviewProvider
    participant WV as Webview

    Agent->>ACP: extMethod(ainxt.dev/exit_plan_mode)
    ACP->>PLB: request(params)
    PLB->>CWP: PlanUi(params)
    CWP->>WV: postMessage(planApprovalRequest)
    WV-->>CWP: onDidReceiveMessage(planApprovalResponse)
    CWP-->>PLB: resolve(feedback/outcome)
    PLB-->>ACP: PlanResult
    ACP-->>Agent: outcome
```

---

## Lifecycle and Registration

`ChatWebviewProvider` registers the three bridges when the webview view is resolved, and clears them when the view is disposed. This ensures that:

- Requests arriving before the webview loads use the bridge fallback (`PermissionHandler` falls back to QuickPick; ask/plan return cancelled).
- Requests arriving after the webview closes are cancelled cleanly, and any pending resolvers are resolved with a cancellation outcome.

```mermaid
sequenceDiagram
    participant VS as VS Code
    participant CWP as ChatWebviewProvider
    participant AB as askBridge
    participant PB as permissionBridge
    participant PLB as planBridge

    VS->>CWP: resolveWebviewView(webviewView)
    CWP->>PB: setUi(requestPermissionInWebview)
    CWP->>AB: setUi(requestAskInWebview)
    CWP->>PLB: setUi(requestPlanApprovalInWebview)

    Note over CWP,PLB: Webview is now active and handles interactive requests

    VS->>CWP: onDidDispose()
    CWP->>PB: setUi(undefined)
    CWP->>AB: setUi(undefined)
    CWP->>PLB: setUi(undefined)
    CWP->>CWP: cancel pending resolvers
```

---

## How It Fits into the System

The bridges are a thin glue layer inside the VS Code host's chat webview subsystem. They connect:

- **Agent management / ACP client** – `AcpClientImpl.extMethod` dispatches `ainxt.dev/ask_user_question` and `ainxt.dev/exit_plan_mode` through `askBridge` and `planBridge`. See [agent_management.md](../agent-management/README.md).
- **Permission handling** – `PermissionHandler` prefers `permissionBridge` and falls back to a native QuickPick. See [handlers.md](../handlers/README.md).
- **Chat webview provider** – `ChatWebviewProvider` registers the UI callbacks and renders the interactive cards. See [chat_webview_provider.md](provider.md).
- **Session management** – Session updates and agent capabilities flow through separate channels (`SessionUpdateHandler`), but the interactive requests handled by the bridges are scoped to the active session managed by `SessionManager`. See [session_management.md](../session-management/README.md).

Because the bridges are pure TypeScript modules with no VS Code API dependencies, they are easy to unit test and could be reused by other host implementations (for example, a future JetBrains bridge) as long as the same registration/request contract is honored.

---

## Design Notes

- **No state** – The bridges do not queue requests or maintain history. If no UI is registered, the request is resolved immediately with the fallback outcome.
- **Single handler** – Only one UI handler can be registered at a time. In practice this is the active `ChatWebviewProvider` instance.
- **Type safety** – Each bridge exports its parameter and result types (`AskParams`, `AskResult`, `PlanParams`, `PlanResult`, `PermissionUi`, etc.) so consumers can type-check the contract.
- **Consistent pattern** – All three bridges share the same `setUi` / `hasUi` / `request` shape, making the module predictable to extend.
