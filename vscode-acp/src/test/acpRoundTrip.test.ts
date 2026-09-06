// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
//
// End-to-end verification of the extension's ACP client path:
//
//   getAgentConfigs()  ->  AgentManager.spawnAgent()  ->  ConnectionManager.connect()
//     ->  initialize  ->  session/new  ->  session/prompt  ->  streamed session/update
//
// This is the repository's only test that exercises a real child process and a
// real JSON-RPC handshake rather than settings and pure functions. It runs
// against src/test/fixtures/stub-acp-agent.js, not the `ainxt` CLI, so it needs
// no gateway, model, credentials or network — see that fixture's header.
import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { getAgentConfigs } from '../config/AgentConfig';
import { AgentManager } from '../core/AgentManager';
import { ConnectionManager } from '../core/ConnectionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';

// __dirname is out/test at runtime; the fixture stays in the source tree.
const STUB = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'stub-acp-agent.js');

function textOf(n: SessionNotification): string {
  const u = n.update as { sessionUpdate?: string; content?: { text?: string } };
  return u?.sessionUpdate === 'agent_message_chunk' ? (u.content?.text ?? '') : '';
}

suite('ACP round trip (stub agent)', function () {
  // Spawning a process and completing a handshake is slower than the unit tests.
  this.timeout(30000);

  const ainxtCfg = vscode.workspace.getConfiguration('ainxt');
  let previousBinaryPath: string | undefined;
  let agentManager: AgentManager;

  suiteSetup(async () => {
    previousBinaryPath = ainxtCfg.get<string>('binaryPath');
    // Route the extension's own config resolution at the fixture. The shebang
    // makes it directly executable, which is how the real `ainxt` binary is run.
    await ainxtCfg.update('binaryPath', STUB, vscode.ConfigurationTarget.Global);
    agentManager = new AgentManager();
  });

  suiteTeardown(async () => {
    agentManager?.killAll();
    agentManager?.dispose();
    await ainxtCfg.update('binaryPath', previousBinaryPath, vscode.ConfigurationTarget.Global);
  });

  test('spawns the configured agent, initializes, creates a session and streams a reply', async () => {
    // 1. The extension's own settings resolution must pick up binaryPath.
    const configs = getAgentConfigs();
    const entry = configs['AiNxt'];
    assert.ok(entry, 'AiNxt agent entry must exist');
    assert.strictEqual(entry.command, STUB, 'ainxt.binaryPath must override the command');
    assert.ok(entry.args?.includes('stdio'), 'launch argv must still request stdio framing');
    assert.ok(entry.args?.includes('--no-leader'), 'launch argv must still pass --no-leader');

    // 2. Spawn it as a real child process.
    const instance = agentManager.spawnAgent('AiNxt', entry, process.cwd());
    assert.ok(instance.process.pid, 'agent process must have a pid');

    // 3. Real ACP initialize handshake over stdio.
    const updates: SessionNotification[] = [];
    const updateHandler = new SessionUpdateHandler();
    updateHandler.addListener(u => updates.push(u));
    const connectionManager = new ConnectionManager(updateHandler);
    const conn = await connectionManager.connect(instance.id, instance.process);

    assert.ok(conn.initResponse, 'initialize must resolve');
    assert.strictEqual(
      conn.initResponse.protocolVersion, 1,
      'agent must negotiate ACP protocol version 1',
    );

    // 4. session/new
    const session = await conn.connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    assert.ok(session.sessionId, 'session/new must return a sessionId');

    // 5. session/prompt, and the streamed reply must actually arrive.
    const reply = await conn.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'ping' }],
    });
    assert.strictEqual(reply.stopReason, 'end_turn', 'turn must complete normally');

    const streamed = updates.map(textOf).join('');
    assert.ok(
      streamed.includes('ping'),
      `streamed agent_message_chunk text must reach the client; got ${JSON.stringify(streamed)}`,
    );
    assert.ok(
      updates.some(u => (u.update as { sessionUpdate?: string })?.sessionUpdate === 'agent_thought_chunk'),
      'thought chunks must also be delivered, not dropped',
    );
    assert.ok(
      updates.every(u => u.sessionId === session.sessionId),
      'every update must carry the session id it belongs to',
    );

    // 6. Teardown must actually reap the process.
    assert.strictEqual(agentManager.killAgent(instance.id), true, 'killAgent must report success');
  });
});
