#!/usr/bin/env node
// Probe: initialize, print advertised authMethods, then call the ext-methods the
// connection form uses (setApiKey / getApiKey) and print the raw responses so we
// can see whether the binary returns a result or -32601 Method not found.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] || "ainxt";
const args = ["agent", "--no-leader", "stdio"];
const child = spawn(bin, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, AINXT_HOME: join(tmpdir(), "ainxt-acp-probe-home"), AINXT_CLIENT_VERSION: "acp-probe/0.0.0" },
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

const send = (m) => { child.stdin.write(JSON.stringify(m) + "\n"); console.log(`\n→ ${JSON.stringify(m)}`); };
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { console.log(`[non-json] ${t}`); return; }
  if (msg.id === 1) {
    console.log("\n=== initialize authMethods ===");
    console.log(JSON.stringify(msg.result?.authMethods ?? msg.error ?? "(none)", null, 2));
    send({ jsonrpc: "2.0", id: 2, method: "ainxt.dev/setApiKey", params: { key: "probe-test-key" } });
  } else if (msg.id === 2) {
    console.log("\n=== setApiKey response ===");
    console.log(JSON.stringify(msg.result ?? msg.error, null, 2));
    send({ jsonrpc: "2.0", id: 3, method: "ainxt.dev/getApiKey", params: {} });
  } else if (msg.id === 3) {
    console.log("\n=== getApiKey response ===");
    console.log(JSON.stringify(msg.result ?? msg.error, null, 2));
    setTimeout(() => { try { child.kill("SIGTERM"); } catch {} process.exit(0); }, 200);
  }
});
child.on("exit", (c, s) => console.log(`\n[exit code=${c} signal=${s}]`));

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, _meta: { clientIdentifier: "ainxt-vscode" } } });
setTimeout(() => { console.error("[probe] timeout"); try { child.kill("SIGTERM"); } catch {} process.exit(2); }, 15000);
