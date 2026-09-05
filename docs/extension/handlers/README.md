# Handlers Module

The **Handlers** module implements the host-side adapters for the Agent Client Protocol (ACP) in the VS Code extension. Each handler translates an ACP request into the corresponding VS Code API call, captures the result, and returns an ACP response. The module is intentionally thin: it contains no business logic about sessions, agents, or authentication; it only bridges ACP messages to VS Code capabilities.

## Purpose

- Provide concrete implementations for ACP tool requests that agents can invoke.
- Keep VS Code API interactions isolated so the rest of the extension can remain platform-agnostic.
- Surface agent actions to the user through native VS Code UX (editors, terminals, QuickPick, webview cards).

## Scope

This module covers four ACP request categories:

| Category | Handler | ACP Operations |
|---|---|---|
| File system | `FileSystemHandler` | `readTextFile`, `writeTextFile` |
| Permissions | `PermissionHandler` | `requestPermission` |
| Session updates | `SessionUpdateHandler` | `session/update` notifications |
| Terminals | `TerminalHandler` | `createTerminal`, `terminalOutput`, `waitForTerminalExit`, `killTerminal`, `releaseTerminal` |

## Architecture

```mermaid
flowchart TB
    subgraph ACP["ACP Agent / SDK"]
        REQ["Tool Requests"]
        NOTIF["Session Notifications"]
    end

    subgraph HANDLERS["Handlers Module"]
        FS["FileSystemHandler"]
        PERM["PermissionHandler"]
        SU["SessionUpdateHandler"]
        TERM["TerminalHandler"]
    end

    subgraph VSCODE["VS Code APIs"]
        WORKSPACE["workspace.fs / TextDocument"]
        WINDOW["window.showQuickPick / Terminal"]
    end

    subgraph UI["Extension UI"]
        BRIDGE["permissionBridge"]
        CHAT["ChatWebviewProvider"]
    end

    REQ --> FS
    REQ --> PERM
    REQ --> TERM
    NOTIF --> SU

    FS --> WORKSPACE
    PERM --> BRIDGE
    PERM --> WINDOW
    SU --> CHAT
    TERM --> WINDOW
```

### Component Relationships

- `AcpClientImpl` (in [agent_management](../agent-management/README.md)) receives ACP requests from the agent process and dispatches them to the appropriate handler.
- `SessionManager` (in [session_management](../session-management/README.md)) wires `SessionUpdateHandler` listeners so that session notifications reach the UI.
- `FileSystemHandler` uses VS Code's `workspace.fs` and open text documents to read and write files, including unsaved editor buffers.
- `PermissionHandler` prefers the in-chat permission card via [permissionBridge](../ui.md) and falls back to a native VS Code QuickPick.
- `TerminalHandler` spawns real child processes, captures output, and mirrors the output to a VS Code pseudoterminal for visibility.

## Sub-modules

The handlers module is divided into four focused sub-modules, one per ACP request category:

- [handlers_file_system](file-system.md) â€” reading and writing workspace text files.
- [handlers_permission](permission.md) â€” requesting and recording user permissions.
- [handlers_session_update](session-update.md) â€” routing session update notifications to UI listeners.
- [handlers_terminal](terminal.md) â€” creating, monitoring, and releasing terminals for agents.

Each sub-module above links to its generated documentation file (`handlers_file_system.md`, `handlers_permission.md`, `handlers_session_update.md`, and `handlers_terminal.md`) for implementation details, API references, and sequence diagrams.

## Data Flow

### File Read / Write

```mermaid
sequenceDiagram
    participant Agent as ACP Agent
    participant Client as AcpClientImpl
    participant FS as FileSystemHandler
    participant VS as VS Code workspace

    Agent->>Client: readTextFile / writeTextFile
    Client->>FS: invoke handler
    alt read
        FS->>VS: open text document or fs.readFile
        VS-->>FS: content
        FS-->>Client: ReadTextFileResponse
    else write
        FS->>VS: checkpoints.snapshot + fs.writeFile
        FS->>VS: openTextDocument + showTextDocument
        VS-->>FS: ok
        FS-->>Client: WriteTextFileResponse
    end
```

### Permission Request

```mermaid
sequenceDiagram
    participant Agent as ACP Agent
    participant Client as AcpClientImpl
    participant PH as PermissionHandler
    participant Bridge as permissionBridge
    participant QP as VS Code QuickPick

    Agent->>Client: requestPermission
    Client->>PH: invoke handler
    alt autoApprove = allowAll
        PH-->>Client: first allow option
    else permissionBridge has UI
        PH->>Bridge: request(params)
        Bridge-->>PH: user selection
        PH-->>Client: response
    else fallback
        PH->>QP: showQuickPick
        QP-->>PH: selection / cancel
        PH-->>Client: response
    end
```

### Session Update

```mermaid
sequenceDiagram
    participant Agent as ACP Agent
    participant Client as AcpClientImpl
    participant SU as SessionUpdateHandler
    participant Chat as ChatWebviewProvider

    Agent->>Client: session/update notification
    Client->>SU: handleUpdate
    loop registered listeners
        SU->>Chat: listener(update)
    end
```

### Terminal Lifecycle

```mermaid
sequenceDiagram
    participant Agent as ACP Agent
    participant Client as AcpClientImpl
    participant TH as TerminalHandler
    participant Proc as Child Process
    participant VST as VS Code Terminal

    Agent->>Client: createTerminal
    Client->>TH: createTerminal
    TH->>Proc: spawn(command, args)
    TH->>VST: createTerminal(pty)
    Proc-->>TH: stdout/stderr
    TH->>VST: writeEmitter.fire

    Agent->>Client: terminalOutput / waitForTerminalExit
    Client->>TH: invoke handler
    TH-->>Client: output / exit status

    Agent->>Client: releaseTerminal / killTerminal
    Client->>TH: invoke handler
    TH->>Proc: SIGTERM / SIGKILL
```

## Dependencies

| Dependency | Module | Purpose |
|---|---|---|
 `@agentclientprotocol/sdk` | External | ACP request/response types. |
| `Logger` | [utils](../utils/README.md) | Structured logging and error reporting. |
| `checkpoints` | [agent_management](../agent-management/README.md) | Snapshot file content before writes for revert support. |
| `permissionBridge` | [extension_ui](../ui.md) | In-chat permission card UI. |
| `ChatWebviewProvider` | [extension_ui](../ui.md) | Receives session update notifications. |
| `AcpClientImpl` | [agent_management](../agent-management/README.md) | Dispatches ACP requests to handlers. |
| `SessionManager` | [session_management](../session-management/README.md) | Registers session update listeners. |

## Error Handling

All handlers catch errors at the operation boundary, log them through `Logger`, and re-throw so that `AcpClientImpl` can return an ACP error to the agent. `SessionUpdateHandler` additionally isolates listener errors so that one faulty listener does not break others.

## Lifecycle

- Handlers are instantiated once during extension activation and reused across sessions.
- `TerminalHandler.dispose()` and `SessionUpdateHandler.dispose()` clean up resources when the extension deactivates.
- `releaseTerminal` keeps the VS Code terminal visible per ACP spec but removes the handler's internal reference.
