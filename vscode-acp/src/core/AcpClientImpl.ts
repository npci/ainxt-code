// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import type {
  Client,
  Agent,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
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

import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { askBridge, type AskParams } from '../ui/askBridge';
import { planBridge, type PlanParams } from '../ui/planBridge';
import { log } from '../utils/Logger';

/**
 * ACP Client implementation for VS Code.
 * Delegates to individual handlers for each capability.
 *
 * Passed as a factory to ClientSideConnection:
 *   new ClientSideConnection((agent) => new AcpClientImpl(...), stream)
 */
export class AcpClientImpl implements Client {
  private agent: Agent | null = null;

  constructor(
    private readonly fsHandler: FileSystemHandler,
    private readonly terminalHandler: TerminalHandler,
    private readonly permissionHandler: PermissionHandler,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {}

  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  getAgent(): Agent | null {
    return this.agent;
  }

  // --- Required methods ---

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

  // --- File system methods ---

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    log(`Client.writeTextFile: ${params.path}`);
    return this.fsHandler.writeTextFile(params);
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    log(`Client.readTextFile: ${params.path}`);
    return this.fsHandler.readTextFile(params);
  }

  // --- Terminal methods ---

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }

  // --- Extension methods ---

  /**
   * Handles agent→client extension requests. Currently the interactive
   * `ainxt.dev/ask_user_question` tool: routes it to the in-chat "ask" card and
   * returns the user's answers. Without this, the agent's clarifying-question
   * tool fails with -32601 (the "Ask: … failed" card).
   */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // In leader mode the request may arrive prefixed with `_` and with the real
    // call nested one level down; normalize both.
    const m = method.replace(/^_/, '');
    if (m === 'ainxt.dev/ask_user_question') {
      const p = (params && Array.isArray((params as { questions?: unknown }).questions))
        ? params
        : ((params as { params?: Record<string, unknown>; request?: Record<string, unknown> }).params
          ?? (params as { request?: Record<string, unknown> }).request
          ?? params);
      return askBridge.request(p as unknown as AskParams);
    }
    if (m === 'ainxt.dev/exit_plan_mode') {
      const p = (params && ('planContent' in params || 'toolCallId' in params))
        ? params
        : ((params as { params?: Record<string, unknown>; request?: Record<string, unknown> }).params
          ?? (params as { request?: Record<string, unknown> }).request
          ?? params);
      return planBridge.request(p as unknown as PlanParams);
    }
    throw new Error(`unsupported ext method: ${method}`);
  }

  /**
   * Handles agent→client extension NOTIFICATIONS. The important one is
   * `ainxt.dev/session_notification` — the fine-grained live-progress rail
   * (subagent_spawned/progress/finished, tool_call_delta_chunk, pending_interaction,
   * goal_updated, …). Its payload is `{ sessionId, update }`, identical to a
   * standard `session/update`, so we route it through the same handler; the
   * webview then drives the live activity indicator from these events. Without
   * this the UI is blind during long subagent runs.
   */
  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const m = method.replace(/^_/, '');
    if (m === 'ainxt.dev/session_notification') {
      if (params && (params as { update?: unknown }).update) {
        this.sessionUpdateHandler.handleUpdate(params as unknown as SessionNotification);
      }
    }
    // Other ext notifications (mcp/queue/sessions changed) are ignored.
  }
}
