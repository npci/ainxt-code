// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as assert from 'assert';
import * as vscode from 'vscode';
import { SessionHistoryStore } from '../core/SessionHistoryStore';
import { PermissionHandler } from '../handlers/PermissionHandler';

// ─── Extension activation ────────────────────────────────────────────────────

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('ainxt.ainxt-vscode'));
  });

  test('Should activate extension', async () => {
    const ext = vscode.extensions.getExtension('ainxt.ainxt-vscode');
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('Should register ACP and AiNxt commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('acp.newConversation'), 'newConversation should be registered');
    assert.ok(commands.includes('acp.openChat'), 'openChat should be registered');
    assert.ok(commands.includes('acp.cancelTurn'), 'cancelTurn should be registered');
    assert.ok(commands.includes('ainxt.signIn'), 'signIn should be registered');
    assert.ok(commands.includes('ainxt.signOut'), 'signOut should be registered');
    assert.ok(commands.includes('ainxt.loadProfile'), 'loadProfile should be registered');
  });
});

// ─── TelemetryManager — no-op when key absent ────────────────────────────────

suite('TelemetryManager', () => {
  test('initTelemetry returns a no-op disposable when AINXT_TELEMETRY_CONNECTION_STRING is absent', async () => {
    const { initTelemetry, sendEvent, sendError } = await import('../utils/TelemetryManager');
    const disposable = initTelemetry();
    assert.ok(disposable, 'initTelemetry should return a disposable');
    assert.ok(typeof disposable.dispose === 'function', 'disposable should have dispose()');
    assert.doesNotThrow(() => disposable.dispose(), 'dispose() should not throw');
    assert.doesNotThrow(() => sendEvent('test/event', { key: 'value' }), 'sendEvent should not throw when disabled');
    assert.doesNotThrow(() => sendError('test/error', { key: 'value' }), 'sendError should not throw when disabled');
  });
});

// ─── AgentConfig — settings defaults ─────────────────────────────────────────

suite('AgentConfig — settings defaults', () => {
  test('Default AiNxt agent args include --no-leader and stdio, no hardcoded model', () => {
    const cfg = vscode.workspace.getConfiguration('acp');
    const agents = cfg.get<Record<string, { command: string; args?: string[] }>>('agents', {});
    const ainxt = agents['AiNxt'];
    assert.ok(ainxt, 'AiNxt agent should be configured by default');
    assert.ok(Array.isArray(ainxt.args), 'AiNxt agent should have args');
    assert.ok(ainxt.args!.includes('--no-leader'), 'args must include --no-leader');
    assert.ok(ainxt.args!.includes('stdio'), 'args must include stdio');
    assert.ok(!ainxt.args!.includes('claude-sonnet-4-6'), 'args must not hardcode a model');
    assert.ok(!ainxt.args!.includes('-m'), 'args must not hardcode -m flag');
  });

  test('Default model setting is empty string (not hardcoded)', () => {
    const model = vscode.workspace.getConfiguration('ainxt').get<string>('model');
    assert.strictEqual(model, '', 'Default model must be empty — user configures their own');
  });

  test('Default logTraffic is false (privacy default)', () => {
    const logTraffic = vscode.workspace.getConfiguration('acp').get<boolean>('logTraffic');
    assert.strictEqual(logTraffic, false, 'logTraffic must default to false');
  });

  test('Default autoApprovePermissions is ask (safe default)', () => {
    const autoApprove = vscode.workspace.getConfiguration('acp').get<string>('autoApprovePermissions');
    assert.strictEqual(autoApprove, 'ask', 'autoApprovePermissions must default to ask');
  });

  test('Default allowInsecure is false (security default)', () => {
    const allowInsecure = vscode.workspace.getConfiguration('ainxt').get<boolean>('allowInsecure');
    assert.strictEqual(allowInsecure, false, 'allowInsecure must default to false');
  });

  test('Default autocomplete is false (opt-in feature)', () => {
    const autocomplete = vscode.workspace.getConfiguration('ainxt').get<boolean>('autocomplete');
    assert.strictEqual(autocomplete, false, 'autocomplete must default to false');
  });

  test('ainxt.homeDir setting exists and defaults to empty string', () => {
    const homeDir = vscode.workspace.getConfiguration('ainxt').get<string>('homeDir');
    assert.strictEqual(homeDir, '', 'homeDir must default to empty — uses ~/.ainxt by default');
  });
});

// ─── Setting scopes — workspace must not control execution or credentials ─────
//
// A repository can ship .vscode/settings.json. Any setting left at the default
// `window` scope is therefore attacker-controlled for anyone who opens that repo
// and grants Workspace Trust. `acp.agents` carries the command, args and env of
// the process the extension spawns, so an unscoped value is arbitrary command
// execution with no prompt. These assertions pin the scopes that must stay
// machine-only; the extension writes all of them with ConfigurationTarget.Global,
// so machine scope costs no functionality.

suite('Setting scopes', () => {
  const MUST_BE_MACHINE = [
    'acp.agents',                 // command / args / env of the spawned agent
    'acp.autoApprovePermissions', // whether approval prompts run at all
    'ainxt.binaryPath',           // which binary is spawned
    'ainxt.gatewayUrl',           // where credentials and file contents are sent
    'ainxt.allowInsecure',        // relaxes transport security
    'ainxt.homeDir',              // where credentials are read from
    'ainxt.registryUrl',          // outbound fetch target
  ];

  test('execution- and credential-bearing settings are machine-scoped', () => {
    const ext = vscode.extensions.getExtension('ainxt.ainxt-vscode');
    assert.ok(ext, 'extension must be present');
    const contributes = ext.packageJSON.contributes;
    const conf = Array.isArray(contributes.configuration)
      ? contributes.configuration[0]
      : contributes.configuration;
    for (const key of MUST_BE_MACHINE) {
      const prop = conf.properties[key];
      assert.ok(prop, `${key} should be a contributed setting`);
      assert.strictEqual(
        prop.scope, 'machine',
        `${key} must be machine-scoped: a workspace could otherwise set it from .vscode/settings.json`,
      );
    }
  });

  test('the extension declares that it is unsupported in untrusted workspaces', () => {
    const ext = vscode.extensions.getExtension('ainxt.ainxt-vscode');
    assert.ok(ext);
    const caps = ext.packageJSON.capabilities;
    assert.ok(caps, 'capabilities must be declared rather than left to the default');
    assert.strictEqual(
      caps.untrustedWorkspaces?.supported, false,
      'the agent spawns processes and writes files, so untrusted workspaces must be unsupported',
    );
  });
});

// ─── SessionHistoryStore ──────────────────────────────────────────────────────

suite('SessionHistoryStore', () => {
  const AGENT = 'TestAgent';
  const CWD = '/tmp/test-workspace';
  const SESSION_A = 'session-aaa-111';
  const SESSION_B = 'session-bbb-222';

  function makeStore() {
    const mem = new Map<string, unknown>();
    const state: vscode.Memento = {
      keys: () => [...mem.keys()],
      get: <T>(key: string, def?: T) => (mem.has(key) ? mem.get(key) as T : def as T),
      update: (key: string, value: unknown) => { mem.set(key, value); return Promise.resolve(); },
    };
    return new SessionHistoryStore(state);
  }

  test('upsertNew adds a session and list returns it', () => {
    const store = makeStore();
    store.upsertNew(AGENT, CWD, SESSION_A);
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, SESSION_A);
  });

  test('list returns sessions most-recent first', () => {
    const store = makeStore();
    store.upsertNew(AGENT, CWD, SESSION_A);
    store.upsertNew(AGENT, CWD, SESSION_B);
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list[0].sessionId, SESSION_B, 'Most recent session should be first');
  });

  test('forget removes a session from the list', () => {
    const store = makeStore();
    store.upsertNew(AGENT, CWD, SESSION_A);
    store.upsertNew(AGENT, CWD, SESSION_B);
    store.forget(AGENT, SESSION_A);
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, SESSION_B);
  });

  test('setTitle updates the title of an existing session', () => {
    const store = makeStore();
    store.upsertNew(AGENT, CWD, SESSION_A);
    store.setTitle(AGENT, SESSION_A, 'My conversation');
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list[0].title, 'My conversation');
  });

  test('setFirstPromptIfMissing sets prompt only once (idempotent)', () => {
    const store = makeStore();
    store.upsertNew(AGENT, CWD, SESSION_A);
    store.setFirstPromptIfMissing(AGENT, SESSION_A, 'First prompt');
    store.setFirstPromptIfMissing(AGENT, SESSION_A, 'Second prompt — should be ignored');
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list[0].firstPrompt, 'First prompt');
  });

  test('reconcileFromAgent removes sessions not in the agent set', () => {
    const store = makeStore();
    store.upsertNew(AGENT, CWD, SESSION_A);
    store.upsertNew(AGENT, CWD, SESSION_B);
    store.reconcileFromAgent(AGENT, new Set([SESSION_B]));
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, SESSION_B);
  });

  test('dispose does not throw', () => {
    const store = makeStore();
    assert.doesNotThrow(() => store.dispose());
  });

  // ─── Regression: SETUP-050 ────────────────────────────────────────────────
  // `lastActiveAt` is an ISO string with millisecond resolution. Sessions
  // created inside the same millisecond used to tie, and because sort is
  // stable they came back oldest-first — the opposite of list()'s contract.
  test('list is most-recent-first even when timestamps tie to the millisecond', () => {
    const store = makeStore();
    const stamp = new Date('2026-01-01T00:00:00.000Z').toISOString();
    // Force an exact tie, which is what a same-millisecond insert produces.
    store.upsertNew(AGENT, CWD, SESSION_A);
    store.upsertNew(AGENT, CWD, SESSION_B);
    for (const e of store.list(AGENT, CWD)) {
      e.lastActiveAt = stamp;
      e.createdAt = stamp;
    }
    const list = store.list(AGENT, CWD);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(
      list[0].sessionId,
      SESSION_B,
      'the later-inserted session must sort first when lastActiveAt/createdAt tie',
    );
  });

  // The consequence that made SETUP-050 more than cosmetic: enforceCap evicts
  // list().slice(capPerAgent), so a mis-sorted tie drops the newest session.
  test('cap eviction on tied timestamps drops the stalest session, not the newest', () => {
    const mem = new Map<string, unknown>();
    const state: vscode.Memento = {
      keys: () => [...mem.keys()],
      get: <T>(key: string, def?: T) => (mem.has(key) ? mem.get(key) as T : def as T),
      update: (key: string, value: unknown) => { mem.set(key, value); return Promise.resolve(); },
    };
    const store = new SessionHistoryStore(state, 2);
    const stamp = new Date('2026-01-01T00:00:00.000Z').toISOString();

    store.upsertNew(AGENT, CWD, 'oldest');
    store.upsertNew(AGENT, CWD, 'middle');
    for (const e of store.list(AGENT, CWD)) { e.lastActiveAt = stamp; e.createdAt = stamp; }
    // Third insert exceeds the cap of 2 and triggers eviction against a tie.
    store.upsertNew(AGENT, CWD, 'newest');

    const ids = store.list(AGENT, CWD).map(e => e.sessionId);
    assert.strictEqual(ids.length, 2, 'cap of 2 must be enforced');
    assert.ok(ids.includes('newest'), 'the newest session must never be the one evicted');
    assert.ok(!ids.includes('oldest'), 'the stalest session is the one that should go');
  });
});

// ─── PermissionHandler — auto-approve logic ───────────────────────────────────

suite('PermissionHandler', () => {
  test('allowAll mode selects the first allow_once option without prompting', async () => {
    const cfg = vscode.workspace.getConfiguration('acp');
    await cfg.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);

    const handler = new PermissionHandler();

    const result = await handler.requestPermission({
      options: [
        { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-deny', name: 'Deny', kind: 'deny' },
      ],
      toolCall: { title: 'Write file', description: 'Write to src/index.ts' },
    } as any);

    assert.strictEqual(result.outcome.outcome, 'selected');
    assert.strictEqual((result.outcome as any).optionId, 'opt-allow');

    await cfg.update('autoApprovePermissions', 'ask', vscode.ConfigurationTarget.Global);
  });
});
