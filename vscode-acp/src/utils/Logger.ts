// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('AiNxt');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic');
    // Prominent warning shown once when the channel is first created
    _trafficChannel.appendLine(
      '⚠️  ACP TRAFFIC LOGGING IS ENABLED (acp.logTraffic = true)\n' +
      '   This log records all ACP messages between the extension and the ainxt agent.\n' +
      '   It may contain: user prompts, file contents, API key exchanges, and agent responses.\n' +
      '   Message params are REDACTED below — only message type and ID are shown.\n' +
      '   Disable acp.logTraffic when done debugging. Do NOT share this log externally.\n' +
      '─'.repeat(80)
    );
  }
  return _trafficChannel;
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', false)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type and build a safe envelope summary.
  // IMPORTANT: params/result/error bodies are REDACTED to prevent prompt text,
  // file contents, and API key values from appearing in the log channel.
  const msg = data as Record<string, unknown> | null;
  let label = '';
  let paramsInfo = '';
  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      label = ` [REQUEST] ${msg.method}`;
      paramsInfo = `  params: <redacted — disable acp.logTraffic to suppress this log entirely>`;
    } else if ('method' in msg && !('id' in msg)) {
      label = ` [NOTIFICATION] ${msg.method}`;
      paramsInfo = `  params: <redacted>`;
    } else if ('result' in msg || 'error' in msg) {
      label = ` [RESPONSE] id=${msg.id}`;
      paramsInfo = 'error' in msg
        ? `  error.code: ${(msg.error as Record<string, unknown>)?.code ?? '?'}`
        : `  result: <redacted>`;
    }
  }

  getTrafficChannel().appendLine(
    `[${timestamp}] ${arrow}${label}\n${paramsInfo}\n`
  );
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
