// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../utils/Logger';
import { isCleartextOverNetwork } from '../utils/GatewaySecurity';

/**
 * API key injected into the AiNxt agent's spawn environment as `AINXT_API_KEY`.
 * Held in memory (sourced from VS Code SecretStorage at activation / on connect)
 * because `getAgentConfigs` is synchronous and SecretStorage is async. The binary
 * has no runtime set-key ext-method, so the key must be present at spawn time.
 */
let injectedApiKey: string | undefined;
export function setInjectedApiKey(key: string | undefined): void {
  injectedApiKey = key && key.trim() ? key.trim() : undefined;
}

/**
 * Retry budget handed to the agent when the user has not set one.
 *
 * The agent's own default is 15, which it burns silently — roughly 340 seconds of
 * no output at all. In an editor panel that is indistinguishable from a hang, so
 * interactive sessions get a budget short enough that a misconfigured gateway
 * surfaces as an error while a genuinely slow first token still succeeds.
 */
const INTERACTIVE_MAX_RETRIES = '3';

/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** Command to run (e.g., "ainxt") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

/**
 * Read agent configurations from VS Code settings.
 *
 * Single-codebase strategy (internal + OSS):
 *   All configuration is driven by VS Code settings or environment variables.
 *   No values are hardcoded. Priority order (highest first):
 *     1. Environment variable (AINXT_GATEWAY_URL, AINXT_API_KEY, AINXT_HOME, …)
 *     2. VS Code setting (ainxt.gatewayUrl, ainxt.model, ainxt.homeDir, …)
 *     3. acp.agents JSON (raw agent config)
 *     4. Package default (safe OSS default)
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('acp');
  const agents = JSON.parse(JSON.stringify(config.get<Record<string, AgentConfigEntry>>('agents', {})));

  // First-class AiNxt settings override the raw agent JSON so IT can set
  // office-network endpoints without editing acp.agents directly.
  const ai = vscode.workspace.getConfiguration('ainxt');
  const entry = agents['AiNxt'] as AgentConfigEntry | undefined;
  if (entry) {
    const binaryPath = ai.get<string>('binaryPath', '').trim();
    const gatewayUrl = ai.get<string>('gatewayUrl', '').trim();
    const model = ai.get<string>('model', '').trim();
    const homeDir = ai.get<string>('homeDir', '').trim();

    // Binary path: setting → AINXT_BINARY_PATH env var → keep default ('ainxt')
    if (binaryPath) {
      entry.command = binaryPath;
    } else if (process.env.AINXT_BINARY_PATH) {
      entry.command = process.env.AINXT_BINARY_PATH;
    }

    const env: Record<string, string> = { ...(entry.env ?? {}) };

    // Gateway URL: setting → AINXT_GATEWAY_URL env var (agent reads it natively)
    if (gatewayUrl) { env.AINXT_GATEWAY_URL = gatewayUrl; }

    // Allow insecure: only when explicitly opted in — never automatic.
    //
    // The flag legitimately covers self-signed / internally-issued HTTPS
    // certificates on an office network, and those stay supported. What it must
    // not do is silently authorise plaintext http:// to a remote host, which
    // would put the bearer token and every prompt on the wire in cleartext
    // (CWE-319). Loopback http:// is still fine — that traffic never leaves the
    // machine — so only non-loopback cleartext is refused here.
    if (gatewayUrl && ai.get<boolean>('allowInsecure') === true) {
      if (isCleartextOverNetwork(gatewayUrl)) {
        log(
          `Ignoring ainxt.allowInsecure for "${gatewayUrl}": refusing to enable plaintext HTTP to a ` +
            'non-loopback host. Use https:// (a self-signed certificate is accepted) or a localhost gateway.',
        );
      } else {
        env.AINXT_ALLOW_INSECURE = '1';
      }
    }

    // Home directory: setting → AINXT_HOME env var → default (~/.ainxt)
    // Pass it explicitly so the agent and the extension read from the same place.
    const resolvedHome = homeDir || process.env.AINXT_HOME || path.join(os.homedir(), '.ainxt');
    env.AINXT_HOME = resolvedHome;

    // API key: from SecretStorage (injected at activation / on connect)
    if (injectedApiKey) { env.AINXT_API_KEY = injectedApiKey; }

    // Retry budget. The agent defaults to 15 retries against a failing gateway and
    // prints nothing on stdout or stderr for the whole budget — measured at ~340 s
    // in the CLI's own INSTALL.md. That is defensible for a batch job and wrong for
    // a chat panel: the user sees an idle spinner for five and a half minutes with
    // no way to tell a slow model from a wrong gateway URL. Cap it for interactive
    // use, but never override a value the user or their CI has already set.
    if (!process.env.AINXT_MAX_RETRIES) {
      env.AINXT_MAX_RETRIES = INTERACTIVE_MAX_RETRIES;
    }

    entry.env = env;

    // Model: inject as -m <model> arg only when non-empty
    if (model) { entry.args = withModelArg(entry.args ?? [], model); }
  }
  return agents;
}

/**
 * Resolve the AINXT_HOME path for reading credentials.json.
 * Uses the same priority as getAgentConfigs() so the extension and agent
 * always read from the same location.
 */
export function resolveAinxtHome(): string {
  const ai = vscode.workspace.getConfiguration('ainxt');
  const homeDir = ai.get<string>('homeDir', '').trim();
  return homeDir || process.env.AINXT_HOME || path.join(os.homedir(), '.ainxt');
}

/** Ensure `-m <model>` is present in the agent args (replace if already set). */
function withModelArg(args: string[], model: string): string[] {
  const out = [...args];
  const i = out.indexOf('-m');
  if (i >= 0 && i + 1 < out.length) {
    out[i + 1] = model;
  } else {
    // Insert before the `stdio` subcommand if present, else append
    const s = out.indexOf('stdio');
    const at = s >= 0 ? s : out.length;
    out.splice(at, 0, '-m', model);
  }
  return out;
}

/** Get the list of agent names available. */
export function getAgentNames(): string[] {
  return Object.keys(getAgentConfigs());
}

/** Get a specific agent config by name. */
export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return getAgentConfigs()[name];
}
