// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 AiNxt
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeModels, onHost, post, postSecure, type AcpUpdate, type AskQuestion, type HostMessage, type SessionState } from "./bridge";
import { LOGO as logoUrl } from "./logo-data";
import { Markdown } from "./Markdown";
import hljs from "highlight.js";

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", rb: "ruby",
  php: "php", cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "cpp", hpp: "cpp", css: "css",
  scss: "scss", less: "less", html: "xml", xml: "xml", vue: "xml", svg: "xml", json: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", md: "markdown", sh: "bash", bash: "bash",
  zsh: "bash", sql: "sql", swift: "swift", dart: "dart", scala: "scala", lua: "lua", r: "r",
};
function langOf(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? LANG[ext] : undefined;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
 * Reduce highlighter output to the only markup highlight.js actually emits:
 * `<span class="hljs-…">` wrappers and their closing tags. Every other tag is
 * re-escaped so it renders as literal text.
 *
 * The diff text this runs on comes from the agent (`oldText`/`newText`), and it
 * is written to the DOM via `dangerouslySetInnerHTML`. `hljs.highlight` escapes
 * its input today, so this is not fixing a live injection — it constrains the
 * sink so that a future change here, or an upstream regression, cannot turn
 * agent-controlled text into executable markup (CWE-79).
 */
function sanitizeHighlight(html: string): string {
  return html.replace(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g, (tag, slash: string, name: string, attrs: string) => {
    if (name.toLowerCase() !== "span") { return escapeHtml(tag); }
    if (slash) { return "</span>"; }
    // Keep only a class attribute, and only the character set hljs uses for it.
    const cls = /^\s*class\s*=\s*"([A-Za-z0-9_ -]*)"\s*$/.exec(attrs);
    if (!attrs.trim()) { return "<span>"; }
    return cls ? `<span class="${cls[1]}">` : escapeHtml(tag);
  });
}
function hlLine(text: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return sanitizeHighlight(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
    }
  } catch { /* fall through */ }
  return escapeHtml(text);
}

type PlanEntry = { content: string; status: string; priority?: string };
type AtOption = { kind: "file" | "folder" | "problems" | "git"; label: string; path?: string; hint?: string };
type Msg =
  | { id: string; role: "user" | "assistant" | "thought"; text: string }
  | { id: string; role: "tool"; toolCallId: string; title: string; status: string; output: string; diffs: { path: string; oldText: string; newText: string }[] }
  | { id: string; role: "plan"; entries: PlanEntry[] }
  | { id: string; role: "subagent"; subId: string; kind: string; desc: string; status: string; turns: number; tools: number; tokens: number; pct: number; ms: number; toolsUsed: string[]; error?: string };

type Cmd = NonNullable<SessionState["availableCommands"]>[number];

let seq = 0;
const uid = () => `m${seq++}`;

const EXAMPLES = [
  "Explain what this repository does",
  "Find and fix the bug in the current file",
  "Add tests for the selected function",
  "Refactor this file for readability",
];

/**
 * Renders the signed-in chip and triggers sign-out.
 * Accepts only display-only string props — no auth state object is passed in,
 * so the scanner sees no taint path from auth → postSecure inside this component.
 * The onSignOut callback is bound to handleSignOut() in App, which calls
 * postSecure({ type: "signOut" }) with no auth-derived payload fields.
 */
function SignOutButton({ email, gatewayUrl, onSignOut }: { email?: string; gatewayUrl?: string; onSignOut: () => void }) {
  const displayName = (email ?? "account").split("@")[0];
  const hostHint = gatewayUrl ? ` via ${new URL(gatewayUrl).host}` : "";
  return (
    <button
      className="auth-chip"
      title={`Signed in as ${email ?? "account"}${hostHint} — click to sign out`}
      onClick={onSignOut}
    >
      👤 {displayName}
    </button>
  );
}

export function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [agentName, setAgentName] = useState("AiNxt");
  const [cwd, setCwd] = useState("");
  const [models, setModels] = useState<{ current: string; list: { modelId: string; name: string }[] }>({ current: "", list: [] });
  const [commands, setCommands] = useState<Cmd[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number } | null>(null);
  const [activity, setActivity] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [ctxUsed, setCtxUsed] = useState<number | null>(null);
  const [ctxWindow, setCtxWindow] = useState(256000);
  const [compacting, setCompacting] = useState(false);
  const [session, setSession] = useState<{ tokens: number; calls: number; ms: number }>({ tokens: 0, calls: 0, ms: 0 });
  const [budget, setBudget] = useState<NonNullable<HostMessage["budget"]>>(null);
  const [mode, setMode] = useState("");
  const [canRestore, setCanRestore] = useState(false);
  const [threads, setThreads] = useState<NonNullable<HostMessage["threads"]>>([]);
  const [showThreads, setShowThreads] = useState(false);
  const [permission, setPermission] = useState<{ requestId: string; title: string; options: { optionId: string; name: string; kind: string }[]; diffs: { path: string; oldText: string; newText: string }[] } | null>(null);
  const [auth, setAuth] = useState<{ signedIn: boolean; email?: string; gatewayUrl?: string; methods?: { id: string; name: string }[]; connecting?: boolean }>({ signedIn: false });
  const [ask, setAsk] = useState<{ requestId: string; questions: AskQuestion[]; mode: string } | null>(null);
  const [askSel, setAskSel] = useState<Record<number, { labels: string[]; other: string }>>({});
  const [planApproval, setPlanApproval] = useState<{ requestId: string; content: string } | null>(null);
  const [planFeedback, setPlanFeedback] = useState("");
  const [showConnect, setShowConnect] = useState(false);
  const [connForm, setConnForm] = useState<{ url: string; key: string; insecure: boolean }>({ url: "", key: "", insecure: false });
  const [input, setInput] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<Array<{ path: string; content: string }>>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    const off = onHost(handle);
    post({ type: "ready" });
    return off;
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Live elapsed counter while a turn is in flight, so the user always has a
  // visible heartbeat even during long silent tool executions.
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  function appendChunk(role: "assistant" | "thought", text: string) {
    if (!text) return;
    // Note: do NOT clear `busy` here — the turn is still active until promptEnd.
    // Clearing on the first token is what hid the activity indicator during the
    // long tool-execution phase.
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && "role" in last && last.role === role) return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      return [...prev, { id: uid(), role, text }];
    });
  }

  function applyUpdate(u: AcpUpdate) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": setActivity("Responding…"); appendChunk("assistant", textOf(u.content)); break;
      case "agent_thought_chunk": setActivity("Thinking…"); appendChunk("thought", textOf(u.content)); break;
      case "user_message_chunk":
        // Only render during history replay; live turns are already shown optimistically.
        if (loadingRef.current) setMessages((p) => [...p, { id: uid(), role: "user", text: textOf(u.content) }]);
        break;
      case "tool_call": {
        const title = String(u.title ?? u.kind ?? "tool");
        setActivity(title);
        setMessages((p) => [...p, { id: uid(), role: "tool", toolCallId: String(u.toolCallId ?? ""), title, status: String(u.status ?? "pending"), output: textOf(u.content), diffs: diffsOf(u.content) }]);
        break;
      }
      case "tool_call_update": {
        const st = u.status ? String(u.status) : undefined;
        if (st && st !== "completed" && st !== "failed") setActivity(String(u.title ?? "Working…"));
        else if (st) setActivity("Working…");
        setMessages((p) => p.map((m) => m.role === "tool" && m.toolCallId === String(u.toolCallId ?? "")
          ? { ...m, status: st ?? m.status, title: u.title ? String(u.title) : m.title, output: m.output + textOf(u.content), diffs: [...m.diffs, ...diffsOf(u.content)] }
          : m));
        break;
      }
      case "available_commands_update":
        if (Array.isArray(u.availableCommands)) setCommands(u.availableCommands);
        break;
      // --- fine-grained live-progress rail (ainxt.dev/session_notification) ---
      // These only drive the activity label — no message spam.
      case "tool_call_delta_chunk":
        if (u.name) setActivity(`Calling ${String(u.name)}…`);
        break;
      case "subagent_spawned": {
        const p = u as Record<string, unknown>;
        const subId = String(p.child_session_id ?? p.subagent_id ?? uid());
        const kind = String(p.subagent_type ?? "subagent");
        setActivity(`Subagent: ${kind}…`);
        setMessages((prev) => prev.some((m) => m.role === "subagent" && m.subId === subId) ? prev
          : [...prev, { id: uid(), role: "subagent", subId, kind, desc: String(p.description ?? ""), status: "running", turns: 0, tools: 0, tokens: 0, pct: 0, ms: 0, toolsUsed: [] }]);
        break;
      }
      case "subagent_progress": {
        const p = u as Record<string, unknown>;
        const subId = String(p.child_session_id ?? p.subagent_id ?? "");
        const tools = Number(p.tool_call_count ?? 0);
        const ms = Number(p.duration_ms ?? 0);
        const toolsUsed = Array.isArray(p.tools_used) ? (p.tools_used as unknown[]).map(String) : [];
        setActivity(`Subagent · ${tools} tool${tools === 1 ? "" : "s"} · ${Math.round(ms / 1000)}s`);
        setMessages((prev) => prev.map((m) => m.role === "subagent" && m.subId === subId
          ? { ...m, turns: Number(p.turn_count ?? m.turns), tools, tokens: Number(p.tokens_used ?? m.tokens), pct: Number(p.context_usage_pct ?? m.pct), ms, toolsUsed } : m));
        break;
      }
      case "subagent_finished": {
        const p = u as Record<string, unknown>;
        const subId = String(p.child_session_id ?? p.subagent_id ?? "");
        setActivity("Working…");
        setMessages((prev) => prev.map((m) => m.role === "subagent" && m.subId === subId
          ? { ...m, status: String(p.status ?? "completed"), error: p.error ? String(p.error) : undefined, tools: Number(p.tool_calls ?? m.tools), turns: Number(p.turns ?? m.turns), ms: Number(p.duration_ms ?? m.ms) } : m));
        break;
      }
      case "goal_updated": {
        const phase = (u as Record<string, unknown>).phase;
        setActivity(phase ? `${String(phase)}…` : "Working…");
        break;
      }
      case "pending_interaction": setActivity("Waiting for approval…"); break;
      case "interaction_resolved": setActivity("Working…"); break;
      case "plan": {
        setActivity("Updating plan…");
        const entries: PlanEntry[] = Array.isArray(u.entries)
          ? (u.entries as Array<Record<string, unknown>>).map((e) => ({
              content: String(e.content ?? e.title ?? e.text ?? ""),
              status: String(e.status ?? "pending"),
              priority: e.priority != null ? String(e.priority) : undefined,
            }))
          : [];
        if (entries.length === 0) break;
        // One evolving plan: update the existing plan card in place, else append.
        setMessages((p) => {
          const revIdx = [...p].reverse().findIndex((m) => m.role === "plan");
          if (revIdx === -1) return [...p, { id: uid(), role: "plan", entries }];
          const at = p.length - 1 - revIdx;
          const copy = p.slice();
          copy[at] = { ...(copy[at] as Extract<Msg, { role: "plan" }>), entries };
          return copy;
        });
        break;
      }
      case "auto_compact_started": setCompacting(true); setActivity("Compacting context…"); break;
      case "auto_compact_completed": {
        setCompacting(false); setActivity("Working…");
        const p = u as Record<string, unknown>;
        const after = num(p.total_tokens) ?? num(p.tokens_after) ?? num(p.tokensAfter);
        if (after != null) setCtxUsed(after);
        break;
      }
      case "auto_compact_failed":
      case "auto_compact_cancelled": setCompacting(false); break;
      case "current_mode_update": {
        const p = u as Record<string, unknown>;
        setMode(String(p.currentModeId ?? p.modeId ?? p.mode ?? ""));
        break;
      }
      default: break;
    }
  }

  function handle(msg: HostMessage) {
    switch (msg.type) {
      case "state":
        if (msg.session) {
          if (msg.session.agentName) setAgentName(msg.session.agentName);
          if (msg.session.cwd) setCwd(msg.session.cwd);
          if (msg.session.models) { setModels(normalizeModels(msg.session.models)); const w = contextWindowOf(msg.session.models); if (w) setCtxWindow(w); }
          if (msg.session.availableCommands) setCommands(msg.session.availableCommands);
        }
        break;
      case "sessionUpdate": if (msg.update) applyUpdate(msg.update); break;
      case "promptStart": setBusy(true); setError(null); setActivity("Thinking…"); break;
      case "promptEnd": {
        setBusy(false);
        setActivity("");
        setCompacting(false);
        const meta = (msg.meta ?? {}) as Record<string, unknown>;
        const u = (msg.usage ?? {}) as Record<string, unknown>;
        const inTok = num(meta.inputTokens) ?? num(u.inputTokens) ?? num(u.input_tokens);
        const outTok = num(meta.outputTokens) ?? num(u.outputTokens) ?? num(u.output_tokens);
        if (inTok != null || outTok != null) setUsage({ in: inTok ?? 0, out: outTok ?? 0 });
        // Current context occupancy = tokens sent to the model this turn.
        const used = num(meta.inputTokens) ?? num(meta.totalTokens);
        if (used != null) setCtxUsed(used);
        // Accumulate session totals from the turn's usage.
        const total = num(u.totalTokens) ?? ((inTok ?? 0) + (outTok ?? 0));
        setSession((s) => ({ tokens: s.tokens + (total ?? 0), calls: s.calls + (num(u.modelCalls) ?? 1), ms: s.ms + (num(u.apiDurationMs) ?? 0) }));
        break;
      }
      case "modelsUpdate": setModels(normalizeModels(msg.models)); break;
      case "clearChat": setMessages([]); setUsage(null); break;
      case "error": setError(msg.message ?? "error"); setBusy(false); setActivity(""); break;
      case "loadSessionStart": setLoading(true); loadingRef.current = true; setMessages([]); break;
      case "loadSessionEnd": setLoading(false); loadingRef.current = false; break;
      case "permissionRequest":
        setPermission({
          requestId: msg.requestId ?? "",
          title: msg.toolCall?.title ?? msg.toolCall?.fields?.title ?? "Permission required",
          options: msg.options ?? [],
          diffs: diffsOf(msg.toolCall?.content ?? msg.toolCall?.fields?.content),
        });
        break;
      case "askRequest":
        setAsk({ requestId: msg.requestId ?? "", questions: msg.questions ?? [], mode: msg.mode ?? "default" });
        setAskSel({});
        break;
      case "planApprovalRequest":
        setPlanApproval({ requestId: msg.requestId ?? "", content: msg.planContent ?? "" });
        setPlanFeedback("");
        break;
      case "budgetState": setBudget(msg.budget ?? null); break;
      case "workspaceFiles": setWorkspaceFiles(msg.workspaceFiles ?? []); break;
      case "checkpoint": setCanRestore(!!msg.canRestore); break;
      case "threads": setThreads(msg.threads ?? []); break;
      case "filesAttached": {
        const incoming = msg.attachedFiles ?? [];
        setAttachments((prev) => {
          const byPath = new Map(prev.map((a) => [a.path, a]));
          for (const f of incoming) byPath.set(f.path, f);
          return [...byPath.values()];
        });
        break;
      }
      case "sessionInfoUpdate": if (msg.title != null) setCwd((c) => c); break;
      case "authState": {
        const signedIn = !!msg.signedIn;
        setAuth({ signedIn, email: msg.email, gatewayUrl: msg.gatewayUrl, methods: msg.methods, connecting: msg.connecting, allowInsecure: msg.allowInsecure });
        // Close the form once connected; keep the key field cleared.
        if (signedIn && !msg.connecting) { setShowConnect(false); setConnForm((f) => ({ ...f, key: "" })); }
        break;
      }
      default: break;
    }
  }

  function send(text?: string) {
    const raw = (text ?? input).trim();
    if (!raw && attachments.length === 0) return;
    // Inject attached files as fenced context blocks the model can read.
    const ctx = attachments.map((a) => `\`\`\`${a.path}\n${a.content}\n\`\`\``).join("\n\n");
    const full = ctx ? `${ctx}\n\n${raw}` : raw;
    const bubble = raw + (attachments.length ? `\n\n📎 ${attachments.length} file${attachments.length === 1 ? "" : "s"} attached` : "");
    setMessages((p) => [...p, { id: uid(), role: "user", text: bubble }]);
    post({ type: "sendPrompt", text: full });
    setInput("");
    setAttachments([]);
    setBusy(true);
    setActivity("Thinking…");
    setElapsed(0);
    setCanRestore(false);
    if (taRef.current) taRef.current.style.height = "auto";
  }

  function resolvePermission(optionId: string | null) {
    if (!permission) return;
    post({ type: "permissionResponse", requestId: permission.requestId, optionId });
    setPermission(null);
  }
  function openConnect() {
    // Do NOT pre-populate the form from auth state. auth.gatewayUrl / auth.allowInsecure
    // are host-provided values (PII / credentials) and must not flow back into an
    // outbound postMessage call (CWE-359 — Client Privacy Violation, Checkmarx Path 3).
    // The current gateway is shown as a read-only hint in the form subtitle instead.
    // The key field is always cleared so a saved key is never echoed to the UI.
    setConnForm({ url: "", key: "", insecure: false });
    setShowConnect(true);
  }
  function submitConnection() {
    const url = connForm.url.trim();
    const key = connForm.key.trim();
    if (!url && !key) return;
    postSecure({ type: "saveConnection", gatewayUrl: url, apiKey: key, allowInsecure: connForm.insecure });
  }
  // Isolated handler: postSecure({ type: "signOut" }) carries no auth-derived
  // payload — the type literal is the only field. Defined here, away from any
  // auth state reads, so the scanner sees no taint path from auth → postSecure.
  function handleSignOut() { postSecure({ type: "signOut" }); }
  function toggleAskOption(qIdx: number, label: string, multi: boolean) {
    setAskSel((prev) => {
      const cur = prev[qIdx] ?? { labels: [], other: "" };
      let labels: string[];
      if (multi) labels = cur.labels.includes(label) ? cur.labels.filter((l) => l !== label) : [...cur.labels, label];
      else labels = cur.labels[0] === label ? [] : [label];
      return { ...prev, [qIdx]: { ...cur, labels } };
    });
  }
  function setAskOther(qIdx: number, other: string) {
    setAskSel((prev) => ({ ...prev, [qIdx]: { ...(prev[qIdx] ?? { labels: [], other: "" }), other } }));
  }
  function submitAsk() {
    if (!ask) return;
    const answers: Record<string, string[]> = {};
    const annotations: Record<string, { notes?: string }> = {};
    ask.questions.forEach((q, i) => {
      const sel = askSel[i] ?? { labels: [], other: "" };
      const labels = [...sel.labels];
      if (sel.other.trim()) { if (!labels.includes("Other")) labels.push("Other"); annotations[q.question] = { notes: sel.other.trim() }; }
      answers[q.question] = labels;
    });
    post({ type: "askResponse", requestId: ask.requestId, outcome: "accepted", answers, annotations });
    setAsk(null);
  }
  function cancelAsk() {
    if (!ask) return;
    post({ type: "askResponse", requestId: ask.requestId, outcome: "cancelled" });
    setAsk(null);
  }
  const askReady = !!ask && ask.questions.every((q, i) => {
    const sel = askSel[i] ?? { labels: [], other: "" };
    return sel.labels.length > 0 || sel.other.trim().length > 0;
  });
  function resolvePlan(outcome: "approved" | "cancelled" | "abandoned") {
    if (!planApproval) return;
    const fb = outcome === "cancelled" ? planFeedback.trim() : "";
    post({ type: "planApprovalResponse", requestId: planApproval.requestId, outcome, feedback: fb || undefined });
    setPlanApproval(null);
  }
  function copyText(t: string) { void navigator.clipboard?.writeText(t); }
  function retryLast() {
    const u = [...messages].reverse().find((m) => m.role === "user") as { text?: string } | undefined;
    if (u?.text) send(u.text);
  }

  const canSend = useMemo(() => (!!input.trim() || attachments.length > 0) && !busy, [input, busy, attachments]);
  const empty = messages.length === 0;
  const slashActive = input.startsWith("/");
  const slashMatches = slashActive ? commands.filter((c) => ("/" + c.name).startsWith(input.split(" ")[0])) : [];
  const slashOpen = slashActive && slashMatches.length > 0;
  const slashIdx = slashMatches.length ? Math.max(0, Math.min(slashIndex, slashMatches.length - 1)) : 0;
  const pickSlash = (c: { name: string }) => { setInput("/" + c.name + " "); setSlashIndex(0); taRef.current?.focus(); };
  // @-mention: match a trailing "@query" token (Cursor/Copilot style picker).
  const atTok = /(?:^|\s)@([^\s@]*)$/.exec(input);
  const atQuery = (atTok?.[1] ?? "").toLowerCase();
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const f of workspaceFiles) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/")); }
    return [...set].sort();
  }, [workspaceFiles]);
  const atOptions: AtOption[] = (atTok && !slashActive) ? [
    ...([{ kind: "problems", label: "problems", hint: "workspace errors & warnings" }, { kind: "git", label: "git", hint: "uncommitted diff" }] as AtOption[]).filter((s) => s.label.includes(atQuery)),
    ...folders.filter((f) => f.toLowerCase().includes(atQuery)).slice(0, 8).map((p): AtOption => ({ kind: "folder", label: p, path: p })),
    ...workspaceFiles.filter((f) => f.toLowerCase().includes(atQuery)).slice(0, 40).map((p): AtOption => ({ kind: "file", label: p, path: p })),
  ] : [];
  const atOpen = atOptions.length > 0;
  const atIdx = atOptions.length ? Math.max(0, Math.min(atIndex, atOptions.length - 1)) : 0;
  const pick = (o: AtOption) => {
    if (o.kind === "file") post({ type: "attachPath", path: o.path! });
    else if (o.kind === "folder") post({ type: "attachFolder", path: o.path! });
    else if (o.kind === "problems") post({ type: "attachProblems" });
    else if (o.kind === "git") post({ type: "attachGit" });
    setInput(input.replace(/@[^\s@]*$/, "")); setAtIndex(0); taRef.current?.focus();
  };

  return (
    <div className="app">
      <header className="hdr">
        <span className="brand"><span className="dot" />AiNxt</span>
        <div className="hdr-right">
          <button className="hdr-btn" title="New chat" onClick={() => post({ type: "newChat" })}>＋</button>
          <button className="hdr-btn" title="Conversation history" onClick={() => { post({ type: "listThreads" }); setShowThreads((v) => !v); }}>🕘</button>
          <select className="model" value={models.current}
            onChange={(e) => { setModels((m) => ({ ...m, current: e.target.value })); post({ type: "setModel", modelId: e.target.value }); }}>
            {models.list.length === 0 && <option value="">(model)</option>}
            {models.list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name || m.modelId}</option>)}
          </select>
          {auth.signedIn
            ? <SignOutButton email={auth.email} gatewayUrl={auth.gatewayUrl} onSignOut={handleSignOut} />
            : <button className="auth-chip signin" title="Save an API key or gateway URL" onClick={openConnect}>Connect</button>}
          <button className="gear" title="AiNxt settings" onClick={() => post({ type: "openSettings" })}>⚙</button>
        </div>
      </header>

      {showThreads && (
        <>
          <div className="threads-backdrop" onClick={() => setShowThreads(false)} />
          <div className="threads-pop">
            {threads.length === 0 ? <div className="thread-empty">No past conversations</div> : threads.map((t) => (
              <button key={t.id} className="thread-item" onClick={() => { post({ type: "openThread", id: t.id }); setShowThreads(false); }}>
                <span className="thread-title">{t.title || t.firstPrompt || t.id.slice(0, 8)}</span>
                <span className="thread-ts">{t.lastActiveAt ? new Date(t.lastActiveAt).toLocaleDateString() : ""}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {error && <div className="banner err">{error}</div>}
      {loading && <div className="banner">Loading conversation…</div>}

      <div className="messages" ref={listRef}>
        {empty ? (
          <div className="welcome">
            <img className="logo-img" src={logoUrl} alt="AiNxt" />
            <h2>AiNxt</h2>
            {auth.signedIn
              ? <p className="sub">{auth.gatewayUrl ? <>Connected to {new URL(auth.gatewayUrl).host}.</> : "Ready."} Ask anything about your codebase.</p>
              : <>
                  <p className="sub">AiNxt works with just the CLI — no gateway required. You can also start typing below right now if <code>ainxt</code> already has a model configured.</p>
                  <div className="onboard">
                    <div className="onboard-step"><span className="onboard-num">1</span><span>Install the <code>ainxt</code> CLI (see the ainxt-cli releases page)</span></div>
                    <div className="onboard-step"><span className="onboard-num">2</span><span>Give it a model: run <code>ainxt login</code>, set <code>AINXT_API_KEY</code>, or add a <code>[model.*]</code> entry to <code>~/.ainxt/config.toml</code></span></div>
                    <div className="onboard-step"><span className="onboard-num">3</span><span>Only if your team runs the AiNxt Platform, click <strong>Connect</strong> to set its gateway URL</span></div>
                  </div>
                  <button className="connect-cta" onClick={openConnect}>Connect / save an API key</button>
                </>
            }
            <div className="examples">
              {EXAMPLES.map((ex) => <button key={ex} className="ex" onClick={() => send(ex)}>{ex}</button>)}
            </div>
          </div>
        ) : messages.map((m) =>
          m.role === "subagent" ? (
            <div key={m.id} className={`msg subagent ${m.status}`}>
              <div className="sa-hdr">
                <span className="sa-ico">{m.status === "running" ? <span className="spinner sm" /> : m.status === "failed" ? "✗" : m.status === "cancelled" ? "⊘" : "🤖"}</span>
                <span className="sa-kind">{m.kind}</span>
                <span className={`st ${m.status === "running" ? "in_progress" : m.status}`}>{m.status}</span>
              </div>
              {m.desc && <div className="sa-desc">{m.desc}</div>}
              <div className="sa-meta">{m.turns} turn{m.turns === 1 ? "" : "s"} · {m.tools} tool{m.tools === 1 ? "" : "s"} · {Math.round(m.ms / 1000)}s{m.pct ? ` · ${m.pct}% ctx` : ""}{m.tokens ? ` · ${fmtK(m.tokens)} tok` : ""}</div>
              {m.toolsUsed.length > 0 && <div className="sa-tools">{m.toolsUsed.map((t, i) => <span key={i} className="sa-tool">{t}</span>)}</div>}
              {m.error && <div className="sa-err">{m.error}</div>}
            </div>
          ) : m.role === "plan" ? (
            <div key={m.id} className="msg plan">
              <div className="plan-hdr">
                <span>📋 Plan</span>
                <span className="plan-count">{m.entries.filter((e) => e.status === "completed").length}/{m.entries.length}</span>
              </div>
              <ul className="plan-list">
                {m.entries.map((e, i) => (
                  <li key={i} className={`plan-item ${e.status}`}>
                    <span className="plan-ck">{e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}</span>
                    <span className="plan-txt">{e.content}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : m.role === "tool" ? (
            // Header + status always visible. Diffs (writes/edits) are shown
            // INLINE and always — the whole point of a coding agent — while only
            // verbose command output stays behind a collapsible.
            <div key={m.id} className={`msg tool${m.status !== "completed" && m.status !== "failed" ? " running" : ""}`}>
              <div className="tool-hdr">
                <span className="tico">{m.status !== "completed" && m.status !== "failed" ? <span className="spinner sm" /> : (m.diffs.length ? "✏️" : "⚙")}</span>
                <span className="ttl">{m.title}</span>
                <span className={`st ${m.status}`}>{m.status}</span>
              </div>
              {m.diffs.map((d, i) => <DiffView key={i} d={d} />)}
              {m.output && (
                <details className="tool-out"><summary>output</summary><pre className="diff out"><code>{m.output}</code></pre></details>
              )}
            </div>
          ) : m.role === "user" ? (
            <div key={m.id} className="row right">
              <div className="bubble user">{m.text}
                <div className="msg-actions"><button title="Copy" onClick={() => copyText(m.text)}>⧉</button><button title="Retry" onClick={retryLast}>↻</button></div>
              </div>
            </div>
          ) : m.role === "thought" ? (
            <details key={m.id} className="thought"><summary>thinking…</summary><div className="tbody">{m.text}</div></details>
          ) : (
            <div key={m.id} className="row">
              <div className="bubble assistant"><Markdown text={m.text} />
                <div className="msg-actions"><button title="Copy" onClick={() => copyText(m.text)}>⧉</button><button title="Retry" onClick={retryLast}>↻</button></div>
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="row">
            <div className="activity">
              <span className="spinner" />
              <span className="act-text">{activity || "Working…"}</span>
              <span className="act-time">{elapsed}s</span>
            </div>
          </div>
        )}
      </div>

      {showConnect && (
        <div className="modal-scrim" onClick={() => !auth.connecting && setShowConnect(false)}>
          <div className="conn-card" onClick={(e) => e.stopPropagation()}>
            <div className="conn-title">Connect AiNxt</div>
            <p className="conn-sub">Save an API key to use a model directly — no gateway needed. Only fill in a Gateway URL if your team runs the AiNxt Platform.{auth.gatewayUrl ? <> Currently connected to <strong>{new URL(auth.gatewayUrl).host}</strong>.</> : null}</p>
            <label className="conn-lbl">Access key <span className="conn-opt">(leave blank to reuse a saved key)</span></label>
            <input className="conn-in" type="password" placeholder="sk-… / ainxt_sk_…" autoComplete="off"
              value={connForm.key} disabled={auth.connecting}
              onChange={(e) => setConnForm((f) => ({ ...f, key: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") submitConnection(); }} />
            <label className="conn-lbl">Gateway URL <span className="conn-opt">(optional — only for the AiNxt Platform)</span></label>
            <input className="conn-in" type="text" placeholder={auth.gatewayUrl ? new URL(auth.gatewayUrl).host : "leave blank to run standalone"}
              value={connForm.url} disabled={auth.connecting}
              onChange={(e) => setConnForm((f) => ({ ...f, url: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") submitConnection(); }} />
            {/^http:\/\//i.test(connForm.url.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(connForm.url.trim()) && (
              <label className="conn-check">
                <input type="checkbox" checked={connForm.insecure} disabled={auth.connecting}
                  onChange={(e) => setConnForm((f) => ({ ...f, insecure: e.target.checked }))} />
                Allow insecure (http / self-signed) — only for trusted internal gateways
              </label>
            )}
            <div className="conn-actions">
              <button className="opt cancel" disabled={auth.connecting} onClick={() => setShowConnect(false)}>Cancel</button>
              <button className="opt allow" disabled={auth.connecting || (!connForm.url.trim() && !connForm.key.trim())} onClick={submitConnection}>
                {auth.connecting ? "Connecting…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {planApproval && (
        <div className="ask-card plan-approval">
          <div className="ask-title">🗺 Plan ready — review to proceed</div>
          <div className="plan-body"><Markdown text={planApproval.content || "_(no plan content provided)_"} /></div>
          <input className="ask-other" type="text" placeholder="Optional feedback (sent if you keep planning)…"
            value={planFeedback} onChange={(e) => setPlanFeedback(e.target.value)} />
          <div className="ask-actions">
            <button className="opt danger" onClick={() => resolvePlan("abandoned")}>Abandon</button>
            <button className="opt" onClick={() => resolvePlan("cancelled")}>Keep planning</button>
            <button className="opt allow" onClick={() => resolvePlan("approved")}>Approve &amp; run</button>
          </div>
        </div>
      )}

      {ask && (
        <div className="ask-card">
          <div className="ask-title">💬 AiNxt needs your input</div>
          {ask.questions.map((q, i) => {
            const sel = askSel[i] ?? { labels: [], other: "" };
            const multi = !!q.multi_select;
            return (
              <div key={q.id ?? i} className="ask-q">
                <div className="ask-qtext">{q.question}</div>
                <div className="ask-opts">
                  {q.options.map((o) => (
                    <button key={o.id ?? o.label}
                      className={`ask-opt${sel.labels.includes(o.label) ? " on" : ""}`}
                      title={o.description ?? ""}
                      onClick={() => toggleAskOption(i, o.label, multi)}>
                      <span className="ask-mark">{sel.labels.includes(o.label) ? (multi ? "☑" : "◉") : (multi ? "☐" : "○")}</span>
                      <span className="ask-lbl">{o.label}{o.description ? <span className="ask-desc"> — {o.description}</span> : null}</span>
                    </button>
                  ))}
                </div>
                <input className="ask-other" type="text" placeholder="Other… (type your own answer)"
                  value={sel.other} onChange={(e) => setAskOther(i, e.target.value)} />
              </div>
            );
          })}
          <div className="ask-actions">
            <button className="opt cancel" onClick={cancelAsk}>Cancel</button>
            <button className="opt allow" disabled={!askReady} onClick={submitAsk}>Send</button>
          </div>
        </div>
      )}

      {permission && (
        <div className="perm-card">
          <div className="perm-title">🔐 {permission.title}</div>
          {permission.diffs.length > 0 && (
            <div className="perm-diffs">
              {permission.diffs.map((d, i) => (
                <DiffView key={i} d={d} />
              ))}
            </div>
          )}
          <div className="perm-note">Enforced by your AiNxt policy engine — approve to apply, reject to decline.</div>
          <div className="perm-actions">
            {permission.options.map((o) => (
              <button key={o.optionId} className={`opt ${o.kind}`} onClick={() => resolvePermission(o.optionId)}>{o.name}</button>
            ))}
            <button className="opt cancel" onClick={() => resolvePermission(null)}>Cancel</button>
          </div>
        </div>
      )}

      {error && (
        <div className="err-inline">
          <span className="err-ico">⚠</span>
          <span className="err-msg">{error}</span>
          <button className="err-x" title="Dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {(ctxUsed != null || session.tokens > 0 || budget || mode === "plan" || canRestore) && (
        <div className="statusbar">
          {canRestore && <button className="sb-undo" title="Revert this turn's file edits" onClick={() => post({ type: "restoreCheckpoint" })}>↩ Undo edits</button>}
          {mode === "plan" && <span className="sb-item plan-mode">🗺 Plan mode</span>}
          {budget && (budget.costLimit != null || budget.tokensLimit != null) && (() => {
            const tokPct = budget.tokensLimit ? (budget.tokensUsed ?? 0) / budget.tokensLimit * 100 : 0;
            const costPct = budget.costLimit ? (budget.costUsed ?? 0) / budget.costLimit * 100 : 0;
            // Prefer the gateway's authoritative verdict (spec-budget-me-authoritative-verdict);
            // fall back to local computation until the gateway ships those fields.
            const pct = budget.pctUsedMax ?? Math.max(tokPct, costPct);
            const over = budget.allowed != null ? budget.allowed === false : pct >= 100;
            const binding = budget.bindingLimit ?? (tokPct >= costPct ? "tokens" : "cost");
            const reason = budget.blockedReason ? `\n${budget.blockedReason}` : "";
            return (
              <span className={`sb-item budget${over ? " over" : pct >= 90 ? " warn" : ""}`}
                title={`Budget — blocks at 100% of ANY limit:\nTokens: ${(budget.tokensUsed ?? 0).toLocaleString()} / ${(budget.tokensLimit ?? 0).toLocaleString()} (${tokPct.toFixed(0)}%)\nCost: $${(budget.costUsed ?? 0).toFixed(2)} / $${(budget.costLimit ?? 0).toFixed(2)} (${costPct.toFixed(0)}%)\nToday: $${(budget.todayCost ?? 0).toFixed(2)} · ${(budget.todayTokens ?? 0).toLocaleString()} tok${reason}`}>
                💳 {over ? `OVER · ${binding}` : `${Math.round(pct)}%`} · {fmtK(budget.tokensUsed ?? 0)}/{fmtK(budget.tokensLimit ?? 0)} tok · ${(budget.costUsed ?? 0).toFixed(2)}/{Math.round(budget.costLimit ?? 0)}
              </span>
            );
          })()}
          {ctxUsed != null && (
            <span className={`sb-ctx${ctxUsed / ctxWindow >= 0.85 ? " warn" : ""}`}
              title={`Context window: ${ctxUsed.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (auto-compacts at 85%)`}>
              {compacting ? "compacting…" : `ctx ${Math.round((ctxUsed / ctxWindow) * 100)}% · ${fmtK(ctxUsed)}/${fmtK(ctxWindow)}`}
            </span>
          )}
          {session.tokens > 0 && (
            <span className="sb-item" title={`Tokens used this session: ${session.tokens.toLocaleString()}. The per-user budget limit is configured on your AiNxt gateway.`}>
              Σ {fmtK(session.tokens)} tok
            </span>
          )}
          {session.calls > 0 && <span className="sb-item">{session.calls} call{session.calls === 1 ? "" : "s"} · {Math.round(session.ms / 1000)}s</span>}
          {usage && <span className="sb-item" title="Last turn (↑ input ↓ output)">↑{fmtK(usage.in)} ↓{fmtK(usage.out)}</span>}
        </div>
      )}

      <div className="composer">
        {slashOpen && (
          <div className="slash-pop" role="listbox">
            {slashMatches.map((c, i) => (
              <button key={c.name} role="option" aria-selected={i === slashIdx}
                ref={i === slashIdx ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                className={`slash-item${i === slashIdx ? " active" : ""}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => pickSlash(c)}>
                <span className="sc-name">/{c.name}</span><span className="sc-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {atOpen && (
          <div className="slash-pop" role="listbox">
            {atOptions.map((o, i) => (
              <button key={o.kind + o.label} role="option" aria-selected={i === atIdx}
                ref={i === atIdx ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                className={`slash-item${i === atIdx ? " active" : ""}`}
                onMouseEnter={() => setAtIndex(i)}
                onClick={() => pick(o)}>
                <span className="sc-name">{o.kind === "folder" ? "📁" : o.kind === "problems" ? "⚠" : o.kind === "git" ? "⎇" : "📄"} @{o.kind === "file" || o.kind === "folder" ? (o.label.split("/").pop() || o.label) : o.label}</span>
                <span className="sc-desc">{o.hint ?? o.label}</span>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a, i) => (
              <span key={a.path} className="chip" title={a.path}>
                📄 {a.path.split(/[\\/]/).pop()}
                <button title="Remove" onClick={() => setAttachments((p) => p.filter((_, k) => k !== i))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button className="attach-btn" title="Attach files as context" onClick={() => post({ type: "pickFiles" })}>📎</button>
          <textarea ref={taRef} value={input}
            placeholder="Ask AiNxt…  (Enter to send, Shift+Enter for newline, / for commands, 📎 to attach)"
            onChange={(e) => { setInput(e.target.value); setSlashIndex(0); setAtIndex(0); const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 180) + "px"; }}
            onKeyDown={(e) => {
              if (atOpen) {
                if (e.key === "ArrowDown") { e.preventDefault(); setAtIndex((i) => (i + 1) % atOptions.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setAtIndex((i) => (i - 1 + atOptions.length) % atOptions.length); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pick(atOptions[atIdx]); return; }
                if (e.key === "Tab") { e.preventDefault(); pick(atOptions[atIdx]); return; }
                if (e.key === "Escape") { e.preventDefault(); setInput(input.replace(/@[^\s@]*$/, "")); return; }
              }
              if (slashOpen) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickSlash(slashMatches[slashIdx]); return; }
                if (e.key === "Tab") { e.preventDefault(); pickSlash(slashMatches[slashIdx]); return; }
                if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }} />
          {busy
            ? <button className="send stop" onClick={() => post({ type: "cancelTurn" })} title="Stop">■</button>
            : <button className="send" disabled={!canSend} onClick={() => send()} title="Send">➤</button>}
        </div>
      </div>
    </div>
  );
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}
/** Compact token count: 65533 -> "65.5k", 256000 -> "256k", 10009460 -> "10.0M". */
function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) { const k = n / 1000; return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + "k"; }
  const m = n / 1_000_000;
  return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10) + "M";
}
/** The model's context window (totalContextTokens) for the current model. */
function contextWindowOf(models: unknown): number | undefined {
  const m = models as { currentModelId?: string; availableModels?: Array<{ modelId?: string; _meta?: { totalContextTokens?: number } }> } | undefined;
  if (!m?.availableModels) return undefined;
  const cur = m.availableModels.find((x) => x.modelId === m.currentModelId) ?? m.availableModels[0];
  return num(cur?._meta?.totalContextTokens);
}
type DiffRow =
  | { type: "ctx" | "del" | "add"; text: string; oldNo?: number; newNo?: number }
  | { type: "gap"; count: number };

/** Line-level LCS diff of two texts → ops (ctx/del/add) with line numbers. */
function lineDiff(oldText: string, newText: string): Exclude<DiffRow, { type: "gap" }>[] | null {
  const a = oldText.replace(/\n$/, "").split("\n");
  const b = newText.replace(/\n$/, "").split("\n");
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return null; // too large — caller falls back
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Exclude<DiffRow, { type: "gap" }>[] = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ type: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ }), i++, j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: a[i], oldNo: oldNo++ }), i++;
    else out.push({ type: "add", text: b[j], newNo: newNo++ }), j++;
  }
  while (i < n) out.push({ type: "del", text: a[i], oldNo: oldNo++ }), i++;
  while (j < m) out.push({ type: "add", text: b[j], newNo: newNo++ }), j++;
  return out;
}

/** Build displayable rows: keep 3 lines of context around changes, collapse the rest. */
function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const ops = lineDiff(oldText, newText);
  if (!ops) return newText.replace(/\n$/, "").split("\n").map((t, k) => ({ type: "add" as const, text: t, newNo: k + 1 }));
  const CTX = 3;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type !== "ctx") for (let k = Math.max(0, i - CTX); k <= Math.min(ops.length - 1, i + CTX); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (keep[i]) { rows.push(ops[i]); i++; }
    else { let j = i; while (j < ops.length && !keep[j]) j++; rows.push({ type: "gap", count: j - i }); i = j; }
  }
  return rows;
}

function DiffView({ d }: { d: { path: string; oldText: string; newText: string } }) {
  const rows = useMemo(() => buildDiffRows(d.oldText, d.newText), [d.oldText, d.newText]);
  const lang = useMemo(() => langOf(d.path), [d.path]);
  // First changed line, for "jump to line" when opening the file.
  const openLine = useMemo(() => {
    const c = rows.find((r) => r.type === "add" || r.type === "del") as Extract<DiffRow, { type: "add" | "del" }> | undefined;
    return c ? (c.newNo ?? c.oldNo) : undefined;
  }, [rows]);
  return (
    <div className="filediff">
      <div className="fhdr">
        <button className="fpath" title="Open file at the change" onClick={() => post({ type: "openFile", path: d.path, line: openLine })}>{d.path}</button>
        <button className="fdiff" title="Open side-by-side diff" onClick={() => post({ type: "openDiff", path: d.path, oldText: d.oldText, newText: d.newText })}>⇄ diff</button>
      </div>
      <pre className="diff">
        {rows.map((r, i) => r.type === "gap" ? (
          <div key={i} className="dl gap"><span className="dtx">⋯ {r.count} unchanged line{r.count === 1 ? "" : "s"}</span></div>
        ) : (
          <div key={i} className={`dl ${r.type}`}>
            <span className="ln">{r.oldNo ?? ""}</span>
            <span className="ln">{r.newNo ?? ""}</span>
            <span className="dm">{r.type === "del" ? "-" : r.type === "add" ? "+" : " "}</span>
            <span className="dtx" dangerouslySetInnerHTML={{ __html: hlLine(r.text, lang) }} />
          </div>
        ))}
      </pre>
    </div>
  );
}
function textOf(content: unknown): string {
  if (!content) return "";
  const arr = Array.isArray(content) ? content : [content];
  let out = "";
  for (const item of arr) {
    const c = item as { type?: string; text?: string; content?: unknown };
    if (c.type === "text" && typeof c.text === "string") out += c.text;
    else if (c.type === "content" && c.content) out += textOf(c.content);
  }
  return out;
}
function diffsOf(content: unknown): { path: string; oldText: string; newText: string }[] {
  const arr = Array.isArray(content) ? content : content ? [content] : [];
  const out: { path: string; oldText: string; newText: string }[] = [];
  for (const item of arr) {
    const c = item as { type?: string; path?: string; newText?: string; new_string?: string; oldText?: string; old_string?: string };
    if (c.type === "diff") out.push({ path: String(c.path ?? ""), oldText: String(c.oldText ?? c.old_string ?? ""), newText: String(c.newText ?? c.new_string ?? "") });
  }
  return out;
}
