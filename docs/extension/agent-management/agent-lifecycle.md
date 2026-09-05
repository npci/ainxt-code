# Agent Management: Agent Lifecycle

## Introduction

The `agent_management_agent_lifecycle` module is responsible for managing the lifecycle of ACP (Agent Communication Protocol) agent child processes within the VS Code extension. It provides a centralized service for spawning, tracking, and terminating agent processes, ensuring that agents are launched with the correct shell environment, monitored for errors, and cleanly shut down when no longer needed.

This module is the execution foundation of the `agent_management` subsystem. While [agent_management_acp_client](acp-client.md) handles the protocol-level communication with a running agent, this module is concerned with the operating-system process that hosts the agent.

## Core Functionality

### Process Spawning

The `AgentManager.spawnAgent()` method launches an agent as a child process using Node.js `child_process.spawn()`. It supports platform-specific launching:

- **Windows**: Uses `shell: true` so that `.cmd` scripts (such as `npx`) are resolved correctly by `cmd.exe`.
- **macOS/Linux**: Uses the user's login shell (`$SHELL`) with the `-l` flag when supported, ensuring that user environment setup such as `nvm`, Homebrew, and other tool directories are loaded into `PATH`.

The helper `resolveUnixShell()` determines the appropriate shell and whether it supports the login flag. It falls back through `bash`, `/usr/bin/bash`, and finally `/bin/sh` if no compatible shell is detected.

### Process Tracking

Each spawned agent is wrapped in an `AgentInstance` object containing:

- `id`: A unique identifier such as `agent_1`.
- `name`: The human-readable agent name.
- `process`: The running `ChildProcess`.
- `config`: The `AgentConfigEntry` used to launch the agent.

Instances are stored in an internal `Map<string, AgentInstance>` so the manager can look up, list, and terminate running agents.

### Process Termination

`AgentManager.killAgent()` sends `SIGTERM` to a process and schedules a forced `SIGKILL` after 5 seconds if the process has not exited. `killAll()` iterates over all tracked agents and terminates them. `dispose()` performs `killAll()` and removes all event listeners, making it safe to call during extension deactivation.

### Event Forwarding

`AgentManager` extends `EventEmitter` and forwards process events:

- `agent-stderr`: Lines written to the agent's `stderr`.
- `agent-error`: Errors emitted by the `ChildProcess` itself.
- `agent-closed`: When the process exits, including exit code and signal.

These events allow upstream components such as [SessionManager](../session-management/README.md) and [ChatWebviewProvider](../chat-webview/README.md) to surface agent status to the user.

## Architecture

### Component Overview

```mermaid
graph TB
    subgraph agent_management_agent_lifecycle
        AM[AgentManager]
        AI[AgentInstance]
        SE[shellEscape]
        RUS[resolveUnixShell]
    end

    subgraph Dependencies
        AC[AgentConfigEntry<br/>config module]
        LOG[Logger<br/>utils module]
        TEL[TelemetryManager<br/>utils module]
        CP[child_process]
        FS[fs / existsSync]
    end

    subgraph Consumers
        SM[SessionManager<br/>session_management]
        ACP[AcpClientImpl<br/>agent_management_acp_client]
        EXT[extension.ts<br/>extension_activation]
    end

    AM -->|uses| SE
    AM -->|uses| RUS
    AM -->|creates| AI
    AM -->|reads| AC
    AM -->|logs via| LOG
    AM -->|telemetry via| TEL
    AM -->|spawns| CP
    RUS -->|probes| FS

    SM -->|spawn / kill| AM
    ACP -->|get running process| AM
    EXT -->|dispose| AM
```

### Class Structure

```mermaid
classDiagram
    class AgentManager {
        -Map~string,AgentInstance~ agents
        -number nextId
        +spawnAgent(name, config, cwd?) AgentInstance
        +killAgent(agentId) boolean
        +getAgent(agentId) AgentInstance|undefined
        +getRunningAgents() AgentInstance[]
        +killAll() void
        +dispose() void
    }

    class AgentInstance {
        +string id
        +string name
        +ChildProcess process
        +AgentConfigEntry config
    }

    class EventEmitter {
        <<Node.js>>
    }

    EventEmitter <|-- AgentManager
    AgentManager --> AgentInstance : manages
```

## Data Flow

### Spawning an Agent

```mermaid
sequenceDiagram
    participant SM as SessionManager
    participant AM as AgentManager
    participant RUS as resolveUnixShell
    participant CP as child_process
    participant AG as Agent process
    participant LOG as Logger
    participant TEL as TelemetryManager

    SM->>AM: spawnAgent(name, config, cwd)
    AM->>AM: generate id (agent_N)
    alt Windows
        AM->>CP: spawn(command, args, { shell: true })
    else macOS/Linux
        AM->>RUS: resolveUnixShell()
        RUS-->>AM: { shell, useLoginFlag }
        AM->>AM: shellEscape each arg
        AM->>CP: spawn(shell, [-l, -c, commandStr])
    end
    CP-->>AG: start process
    AM->>AM: store AgentInstance
    AM->>LOG: log spawn details
    AM->>TEL: sendEvent('agent/spawn/shell')
    AM-->>SM: return AgentInstance

    loop Process lifetime
        AG-->>AM: stderr data
        AM->>LOG: log stderr line
        AM-->>SM: emit 'agent-stderr'

        AG-->>AM: error
        AM->>LOG: logError
        AM->>TEL: sendError
        AM-->>SM: emit 'agent-error'

        AG-->>AM: close(code, signal)
        AM->>AM: delete from agents map
        AM-->>SM: emit 'agent-closed'
    end
```

### Terminating an Agent

```mermaid
sequenceDiagram
    participant SM as SessionManager / UI
    participant AM as AgentManager
    participant PROC as ChildProcess

    SM->>AM: killAgent(agentId)
    AM->>AM: lookup AgentInstance
    alt agent found
        AM->>PROC: kill('SIGTERM')
        AM->>AM: schedule SIGKILL in 5s
        AM->>AM: delete from agents map
        AM-->>SM: return true
        PROC-->>AM: close event
    else agent not found
        AM-->>SM: return false
    end

    Note over AM,PROC: If process still running after 5s,<br/>SIGKILL is sent to force termination.
```

## Process Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Spawning : spawnAgent()
    Spawning --> Running : process started
    Running --> StderrEvent : stderr data
    Running --> ErrorEvent : process error
    Running --> Terminating : killAgent()
    Terminating --> Exited : process exits
    ErrorEvent --> Exited : process closes
    StderrEvent --> Running : continue
    Exited --> [*] : removed from map
    Exited --> ForceKilled : SIGKILL after timeout
    ForceKilled --> [*]
```

## Cross-Platform Shell Handling

The `resolveUnixShell()` helper is critical for ensuring agents can find tools installed via package managers such as Homebrew or `nvm`. The decision logic is:

```mermaid
flowchart TD
    A[Read $SHELL] --> B{Shell base name}
    B -->|zsh / bash / ksh| C[Use $SHELL with -l]
    B -->|fish / sh / dash| D[Use $SHELL without -l]
    B -->|csh / tcsh / other| E[Log fallback]
    E --> F{$SHELL missing or incompatible}
    F -->|/bin/bash exists| G[Use /bin/bash -l]
    F -->|/usr/bin/bash exists| H[Use /usr/bin/bash -l]
    F -->|otherwise| I[Use /bin/sh without -l]
```

## Integration with the System

The `AgentManager` sits at the boundary between the VS Code extension's TypeScript code and the external ACP agent executable. Its consumers include:

- **[SessionManager](../session-management/README.md)**: Decides when to spawn or reconnect to an agent based on user session state. It calls `spawnAgent()` when a new local agent session is needed and `killAgent()` / `killAll()` during cleanup.
- **[AcpClientImpl](acp-client.md)**: After an agent is spawned, `AcpClientImpl` communicates with it over stdin/stdout. It may retrieve the `AgentInstance` from `AgentManager` to access the process streams.
- **[extension.ts](../activation.md)**: Registers the extension lifecycle and calls `AgentManager.dispose()` on deactivation to ensure no orphan processes remain.
- **[Logger](../utils/README.md)** and **[TelemetryManager](../utils/README.md)**: Used for operational logging and telemetry events.
- **[AgentConfig](../config.md)**: Supplies the `AgentConfigEntry` (command, args, environment) used to launch each agent.

## References

- [agent_management_acp_client](acp-client.md) — protocol client that communicates with spawned agents.
- [agent_management_checkpoints](checkpoints.md) — checkpointing support for agent sessions.
- [session_management](../session-management/README.md) — orchestrates sessions and drives agent spawning.
- [extension_activation](../activation.md) — extension entry point and deactivation cleanup.
- [chat_webview](../chat-webview/README.md) — UI surface that displays agent status and errors.
- [config](../config.md) — agent configuration definitions.
- [utils](../utils/README.md) — logging and telemetry utilities.
