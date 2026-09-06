// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
// Bridge to the AiNxt extension host, matching vscode-acp's ChatWebviewProvider
// postMessage contract exactly (so the React UI is a drop-in view layer).

export type UiToHost =
  | { type: "ready" }
  | { type: "sendPrompt"; text: string }
  | { type: "cancelTurn" }
  | { type: "setModel"; modelId: string }
  | { type: "setMode"; modeId: string }
  | { type: "executeCommand"; command: string; args?: unknown }
  | { type: "openSettings" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string; oldText: string; newText: string }
  | { type: "pickFiles" }
  | { type: "listFiles" }
  | { type: "attachPath"; path: string }
  | { type: "attachFolder"; path: string }
  | { type: "attachProblems" }
  | { type: "attachGit" }
  | { type: "restoreCheckpoint" }
  | { type: "newChat" }
  | { type: "listThreads" }
  | { type: "openThread"; id: string }
  | { type: "saveConnection"; gatewayUrl: string; apiKey: string; allowInsecure?: boolean; methodId?: string }
  | { type: "signOut" }
  | { type: "permissionResponse"; requestId: string; optionId: string | null }
  | { type: "askResponse"; requestId: string; outcome: "accepted" | "cancelled"; answers?: Record<string, string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { type: "planApprovalResponse"; requestId: string; outcome: "approved" | "cancelled" | "abandoned"; feedback?: string };

/** A single question from the agent's `ainxt.dev/ask_user_question` tool. */
export interface AskQuestion {
  question: string;
  options: Array<{ label: string; description?: string; preview?: string; id?: string }>;
  multi_select?: boolean;
  id?: string;
}

// Host → UI messages we handle (others are ignored gracefully).
export interface HostMessage {
  type: string;
  // state
  activeSessionId?: string | null;
  session?: SessionState | null;
  // sessionUpdate
  update?: AcpUpdate;
  // promptEnd
  stopReason?: string;
  usage?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  // models / modes / config / info / error
  models?: unknown;
  modes?: unknown;
  configOptions?: unknown;
  title?: string | null;
  ok?: boolean;
  message?: string;
  items?: Array<{ index: number; html: string }>;
  // permissionRequest
  requestId?: string;
  options?: Array<{ optionId: string; name: string; kind: string }>;
  toolCall?: { title?: string; content?: unknown; fields?: { content?: unknown; title?: string } } | null;
  // authState
  signedIn?: boolean;
  email?: string;
  methods?: Array<{ id: string; name: string }>;
  gatewayUrl?: string;
  connecting?: boolean;
  allowInsecure?: boolean;
  // askRequest (ainxt.dev/ask_user_question)
  questions?: AskQuestion[];
  mode?: string;
  // planApprovalRequest (ainxt.dev/exit_plan_mode)
  planContent?: string | null;
  // filesAttached (response to pickFiles/attachPath)
  attachedFiles?: Array<{ path: string; content: string }>;
  // workspaceFiles (for the @-mention picker) — repo-relative paths
  workspaceFiles?: string[];
  // checkpoint (undo availability after a turn)
  canRestore?: boolean;
  // threads (conversation history)
  threads?: Array<{ id: string; title?: string; firstPrompt?: string; lastActiveAt?: string }>;
  // budgetState (from gateway GET /budget/me)
  budget?: {
    costUsed?: number; costLimit?: number; pctUsed?: number; remainingUsd?: number;
    tokensUsed?: number; tokensLimit?: number; todayCost?: number; todayTokens?: number;
    // Authoritative verdict — present once the gateway ships the /budget/me
    // enhancement (spec-budget-me-authoritative-verdict.md); undefined until then.
    allowed?: boolean; blockedReason?: string | null; bindingLimit?: string | null; pctUsedMax?: number;
  } | null;
}

export interface SessionState {
  sessionId?: string;
  agentName?: string;
  title?: string | null;
  cwd?: string;
  modes?: unknown;
  models?: unknown;
  configOptions?: unknown;
  availableCommands?: Array<{ name: string; description?: string; input?: { hint?: string } | null }>;
}

export interface AcpUpdate {
  sessionUpdate: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  entries?: unknown;
  availableCommands?: SessionState["availableCommands"];
  [k: string]: unknown;
}

type VsCodeApi = { postMessage: (msg: unknown) => void };
declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}
const vscode: VsCodeApi | null =
  typeof window !== "undefined" && window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

/**
 * Subset of UiToHost messages that carry credentials or PII.
 * These types are structurally restricted to `postSecure()` and must never
 * reach `window.parent.postMessage` (CWE-359 / CWE-346 — Client Privacy
 * Violation). Keeping them as a distinct TypeScript type makes the constraint
 * visible to both the compiler and static-analysis tools.
 */
type SecureMsg = Extract<UiToHost, { type: "saveConnection" | "signOut" }>;

/**
 * Send a message that carries credentials or PII (gateway URL, API key).
 *
 * This function routes **only** through the authenticated VS Code extension-host
 * channel (`acquireVsCodeApi().postMessage`) or the JetBrains JCEF bridge
 * (`window.__ainxtHostPost`). It has **no** `window.parent.postMessage`
 * fallback, so sensitive data can never leak to an unintended parent frame
 * when the webview is opened in a plain browser during development.
 *
 * Call sites: `submitConnection()` (saveConnection) and the sign-out button
 * (signOut) in App.tsx.
 */
export function postSecure(msg: SecureMsg): void {
  // JetBrains / JCEF bridge — injected by the plugin at webview load time.
  const jcef = (window as unknown as { __ainxtHostPost?: (s: string) => void }).__ainxtHostPost;
  if (jcef) { jcef(JSON.stringify(msg)); return; }
  // VS Code extension-host channel — always present inside a VS Code webview.
  if (vscode) { vscode.postMessage(msg); return; }
  // No secure channel available (plain browser / dev mode). Drop the message
  // and warn — the operation cannot be completed safely without a host.
  console.warn(
    `[ainxt] Cannot send "${msg.type}": no secure host channel (VS Code / JCEF) is available. ` +
    "Open this UI inside the extension to use this feature."
  );
}

/**
 * Send a non-sensitive UI → host message.
 *
 * Routes through VS Code / JCEF when available; falls back to
 * `window.parent.postMessage` (same-origin) for browser-dev mode.
 * Must NOT be called with messages that carry credentials or PII — use
 * `postSecure()` for those (enforced by the `SecureMsg` type exclusion).
 */
export function post(msg: Exclude<UiToHost, SecureMsg>): void {
  // IntelliJ/JCEF host: the plugin injects window.__ainxtHostPost(stringifiedMsg)
  // (a JBCefJSQuery bridge). Prefer it when present so the SAME UI bundle runs
  // in both the VS Code webview and the JetBrains tool window.
  const jcef = (window as unknown as { __ainxtHostPost?: (s: string) => void }).__ainxtHostPost;
  if (jcef) { jcef(JSON.stringify(msg)); return; }
  if (vscode) { vscode.postMessage(msg); return; }
  // Browser-dev fallback. Target this document's own origin rather than '*':
  // prompt text must never be broadcast to an arbitrary origin that happens to
  // be hosting the frame (CWE-346). Credentials/PII never reach this path
  // because they are routed exclusively through postSecure() above.
  window.parent?.postMessage(msg, window.location.origin);
}

export function onHost(handler: (msg: HostMessage) => void): () => void {
  const listener = (e: MessageEvent) => {
    const d = e.data as HostMessage;
    if (d && typeof d === "object" && typeof d.type === "string") handler(d);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** Normalize the various model-state shapes into {current, list}. */
export function normalizeModels(models: unknown): { current: string; list: { modelId: string; name: string }[] } {
  if (!models) return { current: "", list: [] };
  const m = models as { currentModelId?: string; availableModels?: unknown[] } | unknown[];
  if (Array.isArray(m)) {
    return {
      current: (m.find((x) => (x as { isCurrent?: boolean }).isCurrent) as { modelId?: string })?.modelId ?? "",
      list: m.map((x) => ({ modelId: String((x as { modelId?: string; id?: string }).modelId ?? (x as { id?: string }).id ?? ""), name: String((x as { name?: string }).name ?? "") })),
    };
  }
  return {
    current: m.currentModelId ?? "",
    list: (m.availableModels ?? []).map((x) => ({ modelId: String((x as { modelId?: string; id?: string }).modelId ?? (x as { id?: string }).id ?? ""), name: String((x as { name?: string }).name ?? "") })),
  };
}
