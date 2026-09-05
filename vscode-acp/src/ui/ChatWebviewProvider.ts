// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import type { SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { logError } from '../utils/Logger';
import { isSecureGateway, isLoopbackEndpoint } from '../utils/GatewaySecurity';
import { readAccessToken } from '../utils/TokenStore';
import { sendEvent } from '../utils/TelemetryManager';
import { permissionBridge } from './permissionBridge';
import { askBridge, type AskParams, type AskResult } from './askBridge';
import { planBridge, type PlanParams, type PlanResult } from './planBridge';
import { checkpoints } from '../core/checkpoints';

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acp-chat';

  private view?: vscode.WebviewView;
  private updateListener: SessionUpdateListener;
  private _hasChatContent = false;
  private permResolvers = new Map<string, (r: RequestPermissionResponse) => void>();
  private permSeq = 0;
  private askResolvers = new Map<string, (r: AskResult) => void>();
  private askSeq = 0;
  private planResolvers = new Map<string, (r: PlanResult) => void>();
  private planSeq = 0;
  private budgetUserId?: string;
  private projectRules?: string;
  private rulesInjected = false;
  private diffStore = new Map<string, string>();
  private diffSeq = 0;
  private diffProviderRegistered = false;

  /** Register the virtual-doc provider that backs the native "⇄ diff" editor (once). */
  private ensureDiffProvider(): void {
    if (this.diffProviderRegistered) { return; }
    this.diffProviderRegistered = true;
    const store = this.diffStore;
    vscode.workspace.registerTextDocumentContentProvider('ainxt-diff', {
      provideTextDocumentContent(uri: vscode.Uri): string {
        return store.get(uri.toString()) ?? '';
      },
    });
  }

  /**
   * Fetch the user's budget from the gateway (`GET /ainxt/v1/api/budget/me`) and
   * push it to the webview status bar. Read-only telemetry — cost/token/request
   * usage vs the per-user limit. Best-effort; failures are silent.
   */
  private async refreshBudget(): Promise<void> {
    try {
      const base = (vscode.workspace.getConfiguration('ainxt').get<string>('gatewayUrl') || '').replace(/\/+$/, '');
      if (!base) { return; }

      // Guard: do not send bearer tokens over a non-loopback plain-HTTP connection.
      // This protects against credential exposure when allowInsecure is enabled
      // for a non-localhost gateway. Chat/agent functionality is unaffected.
      if (!isSecureGateway(base)) {
        this.postMessage({ type: 'budgetError', reason: 'Budget unavailable: gateway must use HTTPS for non-localhost connections.' });
        return;
      }

      const home = process.env.AINXT_HOME || path.join(os.homedir(), '.ainxt');
      const token = await readAccessToken(home);
      if (!token) { return; }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (!this.budgetUserId) {
        const me = await fetch(`${base}/ainxt/v1/api/auth/me`, { headers });
        if (!me.ok) { return; }
        // HSTS observability (OWASP ASVS V14): inspect Strict-Transport-Security
        // before the body is read. Transport security is already enforced by the
        // isSecureGateway() check above, so a missing header is logged rather
        // than treated as fatal — self-hosted HTTPS gateways do not always emit
        // HSTS. Loopback is exempt; HSTS is never issued for localhost.
        if (!me.headers.get('Strict-Transport-Security') && !isLoopbackEndpoint(base)) {
          logError('Gateway response is missing the Strict-Transport-Security header', base);
        }
        const meBody = await me.text();
        this.budgetUserId = (JSON.parse(meBody) as { id?: string }).id;
        if (!this.budgetUserId) { return; }
      }
      const r = await fetch(`${base}/ainxt/v1/api/budget/me`, { headers: { ...headers, 'X-User-Id': this.budgetUserId } });
      if (!r.ok) { return; }
      if (!r.headers.get('Strict-Transport-Security') && !isLoopbackEndpoint(base)) {
        logError('Gateway response is missing the Strict-Transport-Security header', base);
      }
      const budgetBody = await r.text();
      const b = JSON.parse(budgetBody) as {
        budget?: { max_cost_usd_total?: number; max_tokens_total?: number };
        usage_total?: { cost_usd_spent?: number; tokens_used?: number };
        usage_today?: { cost_usd_spent?: number; tokens_used?: number };
        remaining_usd?: number; pct_used?: number;
        // Present once the gateway ships the authoritative-verdict enhancement.
        allowed?: boolean; blocked_reason?: string | null; binding_limit?: string | null; pct_used_max?: number;
      };
      this.postMessage({
        type: 'budgetState',
        budget: {
          costUsed: b.usage_total?.cost_usd_spent,
          costLimit: b.budget?.max_cost_usd_total,
          pctUsed: b.pct_used,
          remainingUsd: b.remaining_usd,
          tokensUsed: b.usage_total?.tokens_used,
          tokensLimit: b.budget?.max_tokens_total,
          todayCost: b.usage_today?.cost_usd_spent,
          todayTokens: b.usage_today?.tokens_used,
          // Authoritative fields (undefined until the gateway adds them → UI falls back).
          allowed: b.allowed,
          blockedReason: b.blocked_reason,
          bindingLimit: b.binding_limit,
          pctUsedMax: b.pct_used_max,
        },
      });
    } catch {
      /* budget is best-effort; ignore */
    }
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    // Register as a session update listener
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(message.text);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'setMode':
          await this.handleSetMode(message.modeId);
          break;
        case 'setModel':
          await this.handleSetModel(message.modelId);
          break;
        case 'setConfigOption':
          await this.handleSetConfigOption(message.configId, message.value);
          break;
        case 'executeCommand':
          if (message.command) {
            await vscode.commands.executeCommand(message.command, ...(message.args !== undefined ? [message.args] : []));
          }
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'AiNxt');
          break;
        case 'openFile':
          if (message.path) {
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
              const opts: vscode.TextDocumentShowOptions = { preview: false };
              if (typeof message.line === 'number' && message.line > 0) {
                const pos = new vscode.Position(message.line - 1, 0);
                opts.selection = new vscode.Range(pos, pos);
              }
              await vscode.window.showTextDocument(doc, opts);
            } catch {
              void vscode.window.showWarningMessage(`AiNxt: could not open ${message.path}`);
            }
          }
          break;
        case 'pickFiles': {
          const picks = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, openLabel: 'Attach to AiNxt' });
          if (picks && picks.length) {
            const files: Array<{ path: string; content: string }> = [];
            for (const uri of picks) {
              try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                if (bytes.byteLength > 200_000) { void vscode.window.showWarningMessage(`AiNxt: ${uri.fsPath} is too large to attach (>200 KB).`); continue; }
                files.push({ path: uri.fsPath, content: Buffer.from(bytes).toString('utf8') });
              } catch { /* skip unreadable */ }
            }
            if (files.length) { this.postMessage({ type: 'filesAttached', attachedFiles: files }); }
          }
          break;
        }
        case 'openDiff': {
          this.ensureDiffProvider();
          const base = (message.path || 'file').split(/[\\/]/).pop() || 'file';
          const n = this.diffSeq++;
          const oldUri = vscode.Uri.parse(`ainxt-diff:/old/${n}/${encodeURIComponent(base)}`);
          const newUri = vscode.Uri.parse(`ainxt-diff:/new/${n}/${encodeURIComponent(base)}`);
          this.diffStore.set(oldUri.toString(), message.oldText ?? '');
          this.diffStore.set(newUri.toString(), message.newText ?? '');
          await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `${base} — AiNxt change`);
          break;
        }
        case 'saveConnection':
          await vscode.commands.executeCommand('ainxt.applyConnection', {
            gatewayUrl: message.gatewayUrl,
            apiKey: message.apiKey,
            allowInsecure: message.allowInsecure,
          });
          break;
        case 'signOut':
          await vscode.commands.executeCommand('ainxt.signOut');
          break;
        case 'permissionResponse': {
          const resolve = this.permResolvers.get(message.requestId);
          if (resolve) {
            this.permResolvers.delete(message.requestId);
            resolve(
              message.optionId
                ? { outcome: { outcome: 'selected', optionId: message.optionId } }
                : { outcome: { outcome: 'cancelled' } },
            );
          }
          break;
        }
        case 'askResponse': {
          const resolve = this.askResolvers.get(message.requestId);
          if (resolve) {
            this.askResolvers.delete(message.requestId);
            if (message.outcome === 'accepted') {
              resolve({ outcome: 'accepted', answers: message.answers ?? {}, annotations: message.annotations ?? {} });
            } else {
              resolve({ outcome: 'cancelled' });
            }
          }
          break;
        }
        case 'planApprovalResponse': {
          const resolve = this.planResolvers.get(message.requestId);
          if (resolve) {
            this.planResolvers.delete(message.requestId);
            const outcome = ['approved', 'abandoned', 'cancelled'].includes(message.outcome) ? message.outcome : 'cancelled';
            resolve(message.feedback ? { outcome, feedback: message.feedback } : { outcome });
          }
          break;
        }
        case 'ready':
          // Webview loaded — send current session state + budget + file list
          this.sendCurrentState();
          void this.refreshBudget();
          void this.sendWorkspaceFiles();
          this.loadProjectRules();
          break;
        case 'listFiles':
          void this.sendWorkspaceFiles();
          break;
        case 'attachPath':
          if (message.path) { void this.attachByPath(message.path); }
          break;
        case 'attachFolder':
          if (message.path) { void this.attachFolder(message.path); }
          break;
        case 'attachProblems':
          void this.attachProblems();
          break;
        case 'attachGit':
          void this.attachGit();
          break;
        case 'restoreCheckpoint': {
          if (checkpoints.count() === 0) { break; }
          const ok = await vscode.window.showWarningMessage(
            `Revert AiNxt's last ${checkpoints.count()} file change(s)? Newly-created files are moved to Trash.`,
            { modal: true }, 'Revert',
          );
          if (ok === 'Revert') {
            const n = await checkpoints.restore();
            void vscode.window.showInformationMessage(`AiNxt: reverted ${n} file(s).`);
            this.postMessage({ type: 'checkpoint', canRestore: false });
          }
          break;
        }
        case 'newChat':
          this.rulesInjected = false;
          await vscode.commands.executeCommand('acp.newConversation');
          this.postMessage({ type: 'checkpoint', canRestore: false });
          break;
        case 'listThreads': {
          const threads = this.sessionManager.listLocalSessions('AiNxt')
            .map((s) => ({ id: s.sessionId, title: s.title, firstPrompt: s.firstPrompt, lastActiveAt: s.lastActiveAt }));
          this.postMessage({ type: 'threads', threads });
          break;
        }
        case 'openThread':
          if (message.id) {
            this.rulesInjected = false;
            try { await this.sessionManager.loadSession('AiNxt', message.id); }
            catch (e) { this.postError(`Could not open conversation: ${(e as Error)?.message ?? e}`); }
          }
          break;
      }
    });

    // Route agent permission + ask-user-question requests to the in-chat cards.
    permissionBridge.setUi((params) => this.requestPermissionInWebview(params));
    askBridge.setUi((params) => this.requestAskInWebview(params));
    planBridge.setUi((params) => this.requestPlanApprovalInWebview(params));

    webviewView.onDidDispose(() => {
      this.view = undefined;
      permissionBridge.setUi(undefined);
      this.permResolvers.forEach((resolve) => resolve({ outcome: { outcome: 'cancelled' } }));
      this.permResolvers.clear();
      askBridge.setUi(undefined);
      this.askResolvers.forEach((resolve) => resolve({ outcome: 'cancelled' }));
      this.askResolvers.clear();
      planBridge.setUi(undefined);
      this.planResolvers.forEach((resolve) => resolve({ outcome: 'cancelled' }));
      this.planResolvers.clear();
    });
  }

  /** Post a plan-approval request to the webview and await the decision. */
  private requestPlanApprovalInWebview(params: PlanParams): Promise<PlanResult> {
    const requestId = `pl${this.planSeq++}`;
    this.postMessage({ type: 'planApprovalRequest', requestId, planContent: params.planContent ?? '' });
    return new Promise<PlanResult>((resolve) => {
      this.planResolvers.set(requestId, resolve);
    });
  }

  /** Load project rules from `.ainxtrules` (or `.ainxt/rules.md`) in the workspace root. */
  private loadProjectRules(): void {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { return; }
      for (const rel of ['.ainxtrules', '.ainxt/rules.md']) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) {
          const txt = fs.readFileSync(p, 'utf8').trim();
          if (txt) { this.projectRules = txt.slice(0, 20_000); return; }
        }
      }
    } catch { /* no rules */ }
  }

  /** Attach every (small) file under a folder, capped, as one context bundle. */
  private async attachFolder(rel: string): Promise<void> {
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0] ?? vscode.Uri.file(rel), `${rel}/**/*`),
        '**/{node_modules,.git,dist,build,target,out}/**',
        40,
      );
      const files: Array<{ path: string; content: string }> = [];
      let total = 0;
      for (const u of uris) {
        try {
          const bytes = await vscode.workspace.fs.readFile(u);
          if (bytes.byteLength > 100_000) { continue; }
          total += bytes.byteLength;
          if (total > 400_000) { break; }
          files.push({ path: vscode.workspace.asRelativePath(u, false), content: Buffer.from(bytes).toString('utf8') });
        } catch { /* skip */ }
      }
      if (files.length) { this.postMessage({ type: 'filesAttached', attachedFiles: files }); }
      else { void vscode.window.showWarningMessage(`AiNxt: no attachable files in ${rel}`); }
    } catch { void vscode.window.showWarningMessage(`AiNxt: could not read folder ${rel}`); }
  }

  /** Attach the workspace diagnostics (errors/warnings) as context. */
  private async attachProblems(): Promise<void> {
    const sev = ['Error', 'Warning', 'Info', 'Hint'];
    const lines: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        const rel = vscode.workspace.asRelativePath(uri, false);
        lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}: [${sev[d.severity] ?? '?'}] ${d.message}`);
      }
    }
    const content = lines.length ? lines.join('\n') : 'No problems reported.';
    this.postMessage({ type: 'filesAttached', attachedFiles: [{ path: 'diagnostics', content }] });
  }

  /** Attach the current git diff (unstaged + staged) as context. */
  private async attachGit(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { void vscode.window.showWarningMessage('AiNxt: no workspace folder for git.'); return; }
    const run = (args: string): Promise<string> => new Promise((resolve) => {
      cp.execFile('git', args.split(' '), { cwd, maxBuffer: 2_000_000 }, (_err, stdout) => resolve(stdout ?? ''));
    });
    try {
      const [unstaged, staged] = await Promise.all([run('diff'), run('diff --staged')]);
      const content = [staged && `# staged\n${staged}`, unstaged && `# unstaged\n${unstaged}`].filter(Boolean).join('\n\n') || 'No uncommitted changes.';
      this.postMessage({ type: 'filesAttached', attachedFiles: [{ path: 'git diff', content: content.slice(0, 200_000) }] });
    } catch { void vscode.window.showWarningMessage('AiNxt: git diff failed.'); }
  }

  /** Send the workspace file list (repo-relative) for the @-mention picker. */
  private async sendWorkspaceFiles(): Promise<void> {
    try {
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,build,target,out,.next,.venv,venv,__pycache__}/**',
        4000,
      );
      const files = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
      this.postMessage({ type: 'workspaceFiles', workspaceFiles: files });
    } catch { /* best-effort */ }
  }

  /**
   * Returns true if the resolved URI falls within one of the open workspace folders.
   * This prevents the @-mention file picker from reading arbitrary files outside
   * the workspace (e.g. ~/.ssh/id_rsa, /etc/passwd) via absolute path injection.
   */
  private isWithinWorkspace(uri: vscode.Uri): boolean {
    const roots = vscode.workspace.workspaceFolders;
    if (!roots || roots.length === 0) { return true; } // no workspace open — allow (single-file mode)
    const filePath = uri.fsPath.toLowerCase();
    return roots.some(folder => filePath.startsWith(folder.uri.fsPath.toLowerCase()));
  }

  /** Read a file by repo-relative (or absolute) path and attach it to the composer. */
  private async attachByPath(rel: string): Promise<void> {
    try {
      const roots = vscode.workspace.workspaceFolders;
      const uri = rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)
        ? vscode.Uri.file(rel)
        : vscode.Uri.joinPath(roots?.[0]?.uri ?? vscode.Uri.file(rel), rel);

      // Security: reject paths that resolve outside the workspace to prevent
      // accidental or malicious reads of sensitive files (e.g. ~/.ssh/id_rsa).
      if (!this.isWithinWorkspace(uri)) {
        void vscode.window.showWarningMessage(
          `AiNxt: "${rel}" is outside the workspace and cannot be attached. ` +
          `Open the file in VS Code first, or move it into your workspace folder.`
        );
        return;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 200_000) { void vscode.window.showWarningMessage(`AiNxt: ${rel} is too large to attach (>200 KB).`); return; }
      this.postMessage({ type: 'filesAttached', attachedFiles: [{ path: rel, content: Buffer.from(bytes).toString('utf8') }] });
    } catch { void vscode.window.showWarningMessage(`AiNxt: could not read ${rel}`); }
  }

  /** Post an ask-user-question request to the webview and await the answers. */
  private requestAskInWebview(params: AskParams): Promise<AskResult> {
    const requestId = `a${this.askSeq++}`;
    this.postMessage({
      type: 'askRequest',
      requestId,
      questions: params.questions,
      mode: params.mode ?? 'default',
    });
    return new Promise<AskResult>((resolve) => {
      this.askResolvers.set(requestId, resolve);
    });
  }

  /** Post a permission request to the webview and await the user's choice. */
  private requestPermissionInWebview(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `p${this.permSeq++}`;
    this.postMessage({
      type: 'permissionRequest',
      requestId,
      options: params.options,
      toolCall: params.toolCall,
    });
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.permResolvers.set(requestId, resolve);
    });
  }

  /**
   * Forward session update to webview.
   */
  private handleSessionUpdate(update: SessionNotification): void {
    const updateData = update.update as any;

    // Persist session state BEFORE the active-session check. During session
    // creation the agent can dispatch notifications (e.g.
    // `available_commands_update`) before connectToAgent finishes setting
    // `activeSessionId`. Without this, those updates would be dropped and
    // the slash-command popup would never have commands to show.
    if (updateData?.sessionUpdate === 'available_commands_update') {
      this.sessionManager.applyAvailableCommands(
        update.sessionId,
        updateData.availableCommands || [],
      );
    }
    if (updateData?.sessionUpdate === 'config_option_update') {
      this.sessionManager.applyConfigOptions(
        update.sessionId,
        updateData.configOptions || [],
      );
    }
    if (updateData?.sessionUpdate === 'session_info_update') {
      this.sessionManager.applySessionInfoUpdate(update.sessionId, {
        title: updateData.title,
        updatedAt: updateData.updatedAt,
      });
    }

    // Only forward to the webview if this is the active session — the
    // webview only ever shows one session at a time.
    const activeId = this.sessionManager.getActiveSessionId();
    if (update.sessionId !== activeId) { return; }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  /**
   * Handle a prompt sent from the webview.
   */
  private async handleSendPrompt(text: string): Promise<void> {
    let activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      // Not connected yet (first-load race, or the auto-connect didn't finish/failed).
      // Self-heal: connect (or resume) now, then send — instead of dead-ending.
      try {
        await this.sessionManager.connectOrResume('AiNxt');
        activeId = this.sessionManager.getActiveSessionId();
      } catch (e: any) {
        this.postMessage({ type: 'error', message: `AiNxt isn't connected: ${e?.message ?? e}. Use Connect to set your gateway, or check that the ainxt CLI is installed.` });
        return;
      }
      if (!activeId) {
        this.postMessage({ type: 'error', message: "AiNxt isn't connected. Use the Connect button, or ensure the ainxt CLI is installed and the gateway is reachable." });
        return;
      }
    }

    sendEvent('chat/messageSent', {
      agentName: this.sessionManager.getActiveAgentName() ?? '',
    }, {
      messageLength: text.length,
    });

    // Record the first prompt for the history store (used as a label
    // fallback when no title is supplied by the agent). Uses the raw text.
    this.sessionManager.recordFirstPrompt(activeId, text);

    // Inject project rules (.ainxtrules) once per session, and start a fresh
    // checkpoint so this turn's file edits can be reverted.
    let promptText = text;
    if (this.projectRules && !this.rulesInjected) {
      promptText = `<project_rules>\n${this.projectRules}\n</project_rules>\n\n${text}`;
      this.rulesInjected = true;
    }
    checkpoints.begin();

    // Tell webview we're processing
    this.postMessage({ type: 'promptStart' });

    try {
      const response = await this.sessionManager.sendPrompt(activeId, promptText);
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
      this.postMessage({
        type: 'promptEnd',
        stopReason: response.stopReason,
        usage: (response as any).usage,
        meta: (response as any)._meta,
      });
      this.sessionManager.touchHistory(activeId);
      // Refresh budget after the turn is billed on the gateway.
      void this.refreshBudget();
      // Offer an undo if the turn edited files.
      this.postMessage({ type: 'checkpoint', canRestore: checkpoints.count() > 0 });
    } catch (e: any) {
      logError('Prompt failed', e);
      this.postMessage({
        type: 'error',
        message: e.message || 'Prompt failed',
      });
      this.postMessage({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  }

  /**
   * Handle mode change from webview picker.
   */
  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) { return; }
    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.postMessage({ type: 'error', message: `Failed to set mode: ${e.message}` });
    }
  }

  /**
   * Handle model change from webview picker.
   */
  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) { return; }
    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  /**
   * Handle generic config-option change from webview picker
   * (ACP "Session Config Options"). The agent returns the full
   * configOptions state which we re-broadcast so any cascading
   * changes are reflected in the UI.
   */
  private async handleSetConfigOption(configId: string, value: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !configId) { return; }
    try {
      const options = await this.sessionManager.setConfigOption(activeId, configId, value);
      this.postMessage({ type: 'configOptionsUpdate', configOptions: options });
    } catch (e: any) {
      logError('Failed to set config option', e);
      this.postMessage({ type: 'error', message: `Failed to set ${configId}: ${e.message}` });
      // Roll back optimistic update on the webview by replaying current state
      const session = this.sessionManager.getSession(activeId);
      this.postMessage({
        type: 'configOptionsUpdate',
        configOptions: session?.configOptions ?? null,
      });
    }
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    this.postMessage({
      type: 'state',
      activeSessionId: activeId,
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        title: session.title,
        cwd: session.cwd,
        modes: session.modes,
        models: session.models,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
      } : null,
    });
  }

  /**
   * Post a message to the webview if it exists.
   */
  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Notify webview of a new active session.
   */
  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
  }

  /**
   * Notify webview of mode state changes.
   */
  notifyModesUpdate(modes: any): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   */
  notifyModelsUpdate(models: any): void {
    this.postMessage({ type: 'modelsUpdate', models });
  }

  /** Notify webview of sign-in state (identity chip + connection form state). */
  notifyAuthState(state: { signedIn: boolean; email?: string; methods: { id: string; name: string }[]; connecting?: boolean }): void {
    const cfg = vscode.workspace.getConfiguration('ainxt');
    const gatewayUrl = cfg.get<string>('gatewayUrl') || undefined;
    const allowInsecure = cfg.get<boolean>('allowInsecure') === true;
    this.postMessage({ type: 'authState', signedIn: state.signedIn, email: state.email, methods: state.methods, gatewayUrl, allowInsecure, connecting: !!state.connecting });
  }

  /** Post an error banner to the webview (used by the connection command). */
  postError(message: string): void {
    this.postMessage({ type: 'error', message });
  }

  /**
   * Notify webview of session config-option state changes.
   */
  notifyConfigOptionsUpdate(configOptions: any): void {
    this.postMessage({ type: 'configOptionsUpdate', configOptions });
  }

  /**
   * Notify webview that a `session/load` replay is starting. The webview
   * wipes any previously-displayed history, disables input, and shows a
   * loading overlay until {@link notifyLoadSessionEnd} fires.
   */
  notifyLoadSessionStart(): void {
    this.postMessage({ type: 'loadSessionStart' });
  }

  /** Notify webview that the active replay finished (success or failure). */
  notifyLoadSessionEnd(ok: boolean): void {
    this.postMessage({ type: 'loadSessionEnd', ok });
  }

  /** Notify webview that session title / metadata changed. */
  notifySessionInfoUpdate(title: string | undefined | null): void {
    this.postMessage({ type: 'sessionInfoUpdate', title: title ?? null });
  }

  /**
   * Clear the chat history and reset to welcome state.
   * Called when starting a new conversation.
   */
  clearChat(): void {
    this._hasChatContent = false;
    this.postMessage({ type: 'clearChat' });
  }

  /**
   * Whether the chat has any messages.
   */
  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  /**
   * Generate the HTML content for the webview.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    // AiNxt: serve the React (Vite) webview bundle.
    const rnonce = getNonce();
    const jsPath = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.js');
    const cssPath = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'assets', 'index.css');
    const jsUri = webview.asWebviewUri(jsPath);
    const cssUri = webview.asWebviewUri(cssPath);
    // Cache-bust by the bundle's mtime so a reinstalled build never serves a
    // stale cached webview (the "broken again after reinstall" class of bug).
    let v = '';
    try { v = `?v=${Math.round(fs.statSync(jsPath.fsPath).mtimeMs)}`; } catch { /* ignore */ }
    return /*html*/ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${rnonce}';">
<link rel="stylesheet" href="${cssUri}${v}"><title>AiNxt</title></head>
<body><div id="root"></div><script type="module" nonce="${rnonce}" src="${jsUri}${v}"></script></body></html>`;
  }

  /**
   * Attach a file URI — notify the webview to include it in the next prompt.
   */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show?.(true);
    }
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.updateListener);
  }
}

function getNonce(): string {
  // Use a cryptographically secure RNG: Math.random() is predictable and must
  // not be used to generate CSP nonces (CWE-330).
  return crypto.randomBytes(24).toString('base64url');
}
