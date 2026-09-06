#!/usr/bin/env node
// Raw ACP handshake probe — no dependencies. Spawns `ainxt agent stdio` and
// sends a JSON-RPC `initialize` to confirm the launch argv, ACP protocol
// version, and wire framing before we build the real client around it.
//
// Usage: node scripts/acp-probe.mjs [path-to-ainxt]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] || "ainxt";
// `--no-leader` is an `agent`-level option, before the `stdio` subcommand.
const args = ["agent", "--no-leader", "stdio"];

const child = spawn(bin, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    // Isolate config/creds so the probe never touches real state.
    AINXT_HOME: process.env.PROBE_AINXT_HOME || join(tmpdir(), "ainxt-acp-probe-home"),
    AINXT_CLIENT_VERSION: "acp-probe/0.0.0",
  },
});

let sawResponse = false;

// Print anything the agent writes to stderr (diagnostics/log lines).
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[agent-stderr] ${d}`));

// ACP is newline-delimited JSON-RPC 2.0 over stdio.
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  console.log(`[agent→client] ${t}`);
  try {
    const msg = JSON.parse(t);
    if (msg.id === 1) {
      sawResponse = true;
      console.log("\n=== initialize RESULT ===");
      console.log(JSON.stringify(msg.result ?? msg.error, null, 2));
      shutdown(msg.error ? 3 : 0);
    }
  } catch {
    /* non-JSON line; already echoed above */
  }
});

child.on("exit", (code, sig) => {
  console.log(`\n[agent exited] code=${code} signal=${sig}`);
  process.exit(sawResponse ? 0 : 2);
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    _meta: { clientIdentifier: "ainxt-vscode", clientVersion: "acp-probe/0.0.0" },
  },
};

child.stdin.write(JSON.stringify(initialize) + "\n");
console.log(`[client→agent] ${JSON.stringify(initialize)}`);

function shutdown(code) {
  try { child.stdin.end(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(code), 300);
}

// Safety timeout: if no response in 12s, give up.
setTimeout(() => {
  if (!sawResponse) {
    console.error("\n[probe] no initialize response within 12s");
    shutdown(2);
  }
}, 12000);
