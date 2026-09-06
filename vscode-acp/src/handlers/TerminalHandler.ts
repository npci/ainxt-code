// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';
import { confirmSensitiveOperation } from '../utils/WorkspaceGuard';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

import { spawn, ChildProcess } from 'node:child_process';

interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
  vsTerminal?: vscode.Terminal;
}

/**
 * Manages terminals that ACP agents request (terminal/create, terminal/output, etc.).
 * Uses real child processes for capturing output, with VS Code terminals for display.
 */
export class TerminalHandler {
  private terminals: Map<string, ManagedTerminal> = new Map();
  private nextId = 1;

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1MB default

    log(`createTerminal: ${params.command} ${(params.args || []).join(' ')} (id=${terminalId})`);

    // The command is executed by the system shell (`shell: true` below), and
    // this path is not routed through PermissionHandler the way interactive
    // tool calls are. Require explicit approval so a compromised agent cannot
    // obtain arbitrary command execution silently (CWE-77).
    const commandLine = [params.command, ...(params.args || [])].join(' ');
    const approved = await confirmSensitiveOperation(
      'Allow the agent to run a shell command?',
      `The agent wants to run:\n${commandLine}\n\nWorking directory: ${params.cwd || process.cwd()}`,
    );
    if (!approved) {
      log(`⛔ createTerminal denied by user — "${commandLine}"`);
      throw new Error('Command denied: not approved by the user.');
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (params.env) {
      for (const v of params.env) {
        env[v.name] = v.value;
      }
    }

    const child = spawn(params.command, params.args || [], {
      cwd: params.cwd || undefined,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // appendOutput writes directly to the managed struct (populated below).
    // This avoids the need for a polling setInterval to sync local vars into
    // the struct — the timer was the source of a resource leak when
    // releaseTerminal() fired before the process exited (CQ-3 / A10-1).
    // Truncation uses a single Buffer.byteLength check + slice instead of the
    // previous O(n) character-by-character loop (A7-1).
    const appendOutput = (data: Buffer, m: ManagedTerminal) => {
      m.output += data.toString();
      if (Buffer.byteLength(m.output, 'utf-8') > m.outputByteLimit) {
        // Slice from the end to keep the most recent output within the limit.
        // Buffer.from().slice() operates on bytes; String.prototype.slice()
        // operates on UTF-16 code units — use the Buffer round-trip to stay
        // byte-accurate without a per-character loop.
        m.output = Buffer.from(m.output, 'utf-8')
          .slice(-m.outputByteLimit)
          .toString('utf-8');
        m.truncated = true;
      }
    };

    // Wire appendOutput after managed is created (see below) so it can
    // reference the struct directly. Listeners are attached post-construction.

    const exitPromise = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        const managed = this.terminals.get(terminalId);
        if (managed) {
          managed.exitCode = code;
          managed.exitSignal = signal;
          managed.exited = true;
        }
        resolve();
      });
      child.on('error', () => {
        resolve();
      });
    });

    // Also create a VS Code terminal for visual output
    const writeEmitter = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open() {
        writeEmitter.fire(`$ ${params.command} ${(params.args || []).join(' ')}\r\n`);
      },
      close() { /* no-op */ },
    };
    const vsTerminal = vscode.window.createTerminal({
      name: `AiNxt: ${params.command}`,
      pty,
    });

    // Stream output to VS Code terminal
    child.stdout?.on('data', (data: Buffer) => {
      writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
    });
    child.stderr?.on('data', (data: Buffer) => {
      writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
    });

    const managed: ManagedTerminal = {
      id: terminalId,
      process: child,
      output: '',
      truncated: false,
      outputByteLimit,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise,
      vsTerminal,
    };

    // Attach output listeners now that managed exists — appendOutput writes
    // directly into the struct, so no polling timer is needed.
    child.stdout?.on('data', (data: Buffer) => appendOutput(data, managed));
    child.stderr?.on('data', (data: Buffer) => appendOutput(data, managed));

    this.terminals.set(terminalId, managed);

    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const response: TerminalOutputResponse = {
      output: managed.output,
      truncated: managed.truncated,
    };

    if (managed.exited) {
      response.exitStatus = {
        exitCode: managed.exitCode,
        signal: managed.exitSignal,
      };
    }

    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await managed.exitPromise;

    return {
      exitCode: managed.exitCode,
      signal: managed.exitSignal,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    try {
      managed.process.kill('SIGTERM');
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }

    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    log(`releaseTerminal: ${params.terminalId}`);

    // Kill if still running
    if (!managed.exited) {
      try {
        managed.process.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    // Don't dispose VS Code terminal — keep output visible per ACP spec
    this.terminals.delete(params.terminalId);

    return {};
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      try {
        if (!managed.exited) {
          managed.process.kill('SIGKILL');
        }
        managed.vsTerminal?.dispose();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}
