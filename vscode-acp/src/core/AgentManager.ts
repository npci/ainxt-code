// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { log, logError } from '../utils/Logger';
import { sendEvent, sendError } from '../utils/TelemetryManager';
import type { AgentConfigEntry } from '../config/AgentConfig';

/**
 * Environment variables from the extension host process that the agent
 * subprocess is allowed to inherit (P1-5 / CWE-526).
 *
 * Rationale for each group:
 *   PATH / PATHEXT / COMSPEC — required for the agent binary and any tools it
 *     shells out to (npm, git, etc.) to be found on all platforms.
 *   HOME / USERPROFILE / HOMEDRIVE / HOMEPATH — the agent reads ~/.ainxt for
 *     credentials and config; without HOME it falls back to / on POSIX.
 *   TEMP / TMP / TMPDIR — standard temp-directory conventions; many SDKs
 *     (Node, Python) use these for scratch files.
 *   AINXT_* — all AiNxt-specific variables (gateway URL, API key, home dir,
 *     model, allow-insecure flag) are injected explicitly by AgentConfig.ts
 *     via config.env; the wildcard here ensures any future AINXT_* variable
 *     added to config.env is not accidentally blocked.
 *   LANG / LC_ALL / LC_CTYPE — locale settings; some CLI tools emit garbled
 *     output without them.
 *   NODE_EXTRA_CA_CERTS — allows operators to trust internal CA certificates
 *     for self-signed HTTPS gateways without setting allowInsecure.
 *   SYSTEMROOT / WINDIR — Windows system directories; required by cmd.exe and
 *     many Windows-native tools.
 *
 * Variables intentionally excluded:
 *   VSCODE_* / ELECTRON_* — VS Code / Electron internals; meaningless to the
 *     agent and may leak extension host internals.
 *   AWS_* / AZURE_* / GCP_* / GOOGLE_* — cloud provider credentials; the
 *     agent has no business accessing these and their presence in the agent
 *     environment would be a credential-exposure risk.
 *   Any variable not in this list — denied by default (allowlist, not denylist).
 */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Shell / binary resolution
  'PATH', 'PATHEXT', 'COMSPEC',
  // Home directory
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  // Temp directories
  'TEMP', 'TMP', 'TMPDIR',
  // Locale
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // TLS / CA certificates
  'NODE_EXTRA_CA_CERTS',
  // Windows system directories
  'SYSTEMROOT', 'WINDIR',
  // User shell (used by resolveUnixShell to pick the login shell)
  'SHELL',
]);

/**
 * Build a filtered environment for the agent subprocess.
 *
 * Starts from the allowlist above, then overlays any AINXT_* variables from
 * the current process environment (set by the user or CI), and finally
 * overlays the explicit per-agent env from AgentConfig (highest priority).
 *
 * This is an allowlist approach: variables not in ENV_ALLOWLIST and not
 * prefixed with AINXT_ are silently dropped. The agent never sees VS Code
 * internals, cloud credentials, or other extension-host secrets.
 */
function buildAgentEnv(configEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Copy allowed variables from the extension host environment.
  for (const key of Object.keys(process.env)) {
    if (ENV_ALLOWLIST.has(key) || key.startsWith('AINXT_')) {
      const val = process.env[key];
      if (val !== undefined) { env[key] = val; }
    }
  }

  // 2. Overlay explicit per-agent config (gateway URL, API key, home dir, …).
  //    These are set by AgentConfig.ts and always take precedence.
  if (configEnv) {
    Object.assign(env, configEnv);
  }

  return env;
}

/**
 * Escape a single argument for safe inclusion in a shell command string.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellEscape(arg: string): string {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Characters that cmd.exe treats as control operators. None of these can appear
 * in a legitimate executable path or agent argument, so their presence in a
 * value that will be passed through `shell: true` indicates command injection.
 */
const WINDOWS_SHELL_METACHARACTERS = /[&|<>^\r\n]/;

/**
 * Reject a value that would be reinterpreted by cmd.exe when spawned with
 * `shell: true` (CWE-77).
 *
 * Validation is used rather than quoting because wrapping the command in quotes
 * prevents cmd.exe from resolving extensionless batch scripts (`npx` → npx.cmd)
 * via PATH, which is the reason `shell: true` is needed on Windows in the first
 * place.
 */
function assertNoShellMetacharacters(value: string, what: string): void {
  if (WINDOWS_SHELL_METACHARACTERS.test(value)) {
    throw new Error(
      `Refusing to spawn agent: ${what} contains shell metacharacters, ` +
        'which is not permitted on Windows.',
    );
  }
}

/**
 * Determine the appropriate shell and whether it supports the -l (login) flag
 * on macOS/Linux. A login shell sources the user's profile (~/.zshrc,
 * ~/.bash_profile, etc.) so that PATH includes nvm, Homebrew, and other
 * user-installed tool directories.
 *
 * Shell support:
 *   zsh, bash, ksh  →  -l supported
 *   fish, sh, dash  →  use as-is without -l (fish auto-loads config;
 *                      sh/dash don't support -l reliably)
 *   csh, tcsh, etc. →  not POSIX-compatible; fall back to bash or /bin/sh
 */
function resolveUnixShell(): { shell: string; useLoginFlag: boolean } {
  const userShell = process.env.SHELL;

  if (userShell) {
    const base = userShell.split('/').pop() || '';

    // POSIX-compatible shells that support -l (login) flag
    if (['zsh', 'bash', 'ksh'].includes(base)) {
      return { shell: userShell, useLoginFlag: true };
    }

    // fish auto-loads config without -l; sh/dash are POSIX-compatible but
    // don't support -l reliably
    if (['fish', 'sh', 'dash'].includes(base)) {
      return { shell: userShell, useLoginFlag: false };
    }

    // Non-POSIX shells (csh, tcsh, etc.) — fall back to a known POSIX shell
    log(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
  }

  // $SHELL not set or not POSIX-compatible — probe for common shells
  if (existsSync('/bin/bash')) {
    return { shell: '/bin/bash', useLoginFlag: true };
  }
  if (existsSync('/usr/bin/bash')) {
    return { shell: '/usr/bin/bash', useLoginFlag: true };
  }
  // Ultimate fallback
  return { shell: '/bin/sh', useLoginFlag: false };
}

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: AgentConfigEntry;
}

/**
 * Manages spawning and killing ACP agent child processes.
 */
export class AgentManager extends EventEmitter {
  private agents: Map<string, AgentInstance> = new Map();
  private nextId = 1;

  /**
   * Spawn an agent as a child process with stdin/stdout piped.
   */
  spawnAgent(name: string, config: AgentConfigEntry, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);

    const child = (() => {
      if (process.platform === 'win32') {
        // On Windows, commands like npx are batch scripts (.cmd) that require
        // shell resolution via cmd.exe.
        //
        // SECURITY: `shell: true` means cmd.exe parses the resulting command
        // line, so a command or argument containing shell metacharacters
        // (&, |, >, ^) would be interpreted rather than treated as literal text
        // (CWE-77). Reject such values up front instead of quoting them —
        // quoting defeats cmd.exe's PATH lookup for extensionless batch scripts,
        // and no legitimate executable path or agent argument needs these
        // characters. `ainxt.binaryPath` is additionally machine-scoped so an
        // untrusted workspace cannot set it.
        assertNoShellMetacharacters(config.command, 'agent command');
        (config.args || []).forEach((a) => assertNoShellMetacharacters(a, 'agent argument'));
        // Quote only a command containing spaces (e.g. "C:\Program Files\…"),
        // so cmd.exe treats it as one token. Bare names such as `ainxt` or `npx`
        // must stay unquoted for PATH/PATHEXT batch-script resolution to work.
        const winCommand = /\s/.test(config.command) ? `"${config.command}"` : config.command;
        return spawn(winCommand, config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildAgentEnv(config.env),
          cwd: cwd || undefined,
          shell: true,
        });
      }

      // On macOS/Linux, use the user's login shell so that PATH includes
      // nvm, Homebrew, and other user-installed tool directories.
      const { shell, useLoginFlag } = resolveUnixShell();
      const commandStr = [config.command, ...(config.args || [])].map(shellEscape).join(' ');
      const shellArgs = useLoginFlag ? ['-l', '-c', commandStr] : ['-c', commandStr];

      log(`Using shell: ${shell} ${shellArgs.join(' ')}`);
      const shellName = shell.split('/').pop() || shell;
      sendEvent('agent/spawn/shell', { shell: shellName, useLoginFlag: String(useLoginFlag) });
      return spawn(shell, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildAgentEnv(config.env),
        cwd: cwd || undefined,
      });
    })();

    const instance: AgentInstance = { id, name, process: child, config };
    this.agents.set(id, instance);

    // Forward stderr for debugging
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log(`[${name} stderr] ${line}`);
        this.emit('agent-stderr', { agentId: id, line });
      }
    });

    child.on('error', (err) => {
      logError(`Agent "${name}" process error`, err);
      sendError('agent/error', { agentName: name, errorType: err.message });
      this.emit('agent-error', { agentId: id, error: err });
    });

    child.on('close', (code, signal) => {
      log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      this.agents.delete(id);
      this.emit('agent-closed', { agentId: id, code, signal });
    });

    return instance;
  }

  /**
   * Kill an agent process.
   */
  killAgent(agentId: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      return false;
    }

    log(`Killing agent "${instance.name}" (${agentId})`);

    try {
      instance.process.kill('SIGTERM');
      // Force kill after 5s if still running
      setTimeout(() => {
        if (instance.process.exitCode === null) {
          instance.process.kill('SIGKILL');
        }
      }, 5000);
    } catch (e) {
      logError(`Failed to kill agent ${agentId}`, e);
    }

    this.agents.delete(agentId);
    return true;
  }

  /**
   * Get a running agent by ID.
   */
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all running agents.
   */
  getRunningAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Kill all running agents. Called on extension deactivate.
   */
  killAll(): void {
    for (const [id] of this.agents) {
      this.killAgent(id);
    }
  }

  dispose(): void {
    this.killAll();
    this.removeAllListeners();
  }
}
