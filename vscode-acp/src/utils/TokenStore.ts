// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './Logger';

/** SecretStorage key holding the gateway bearer token. */
const ACCESS_TOKEN_SECRET = 'ainxt.accessToken';

let secrets: vscode.SecretStorage | undefined;

/** Wire up SecretStorage once, at activation. */
export function initTokenStore(storage: vscode.SecretStorage): void {
  secrets = storage;
}

/**
 * Read the gateway bearer token, preferring the OS keychain.
 *
 * `~/.ainxt/credentials.json` is written by `ainxt login` and is the agent
 * binary's own credential store, so it cannot be deleted — doing so would break
 * CLI sign-in. What this does instead is stop the plaintext file being the
 * *primary* source for the extension: the keychain is consulted first, and a
 * token found only in the file is copied into the keychain so later reads are
 * served from protected storage (CWE-522/CWE-312).
 *
 * File permissions are checked on POSIX and a warning is logged when the file
 * is group- or world-readable, which is the condition that turns an
 * at-rest-plaintext token into an actual exposure.
 */
export async function readAccessToken(home: string): Promise<string | undefined> {
  const fromKeychain = await secrets?.get(ACCESS_TOKEN_SECRET);
  if (fromKeychain) { return fromKeychain; }

  const credentialsPath = path.join(home, 'credentials.json');
  let token: string | undefined;
  try {
    const raw = fs.readFileSync(credentialsPath, 'utf8');
    token = (JSON.parse(raw) as { accessToken?: string }).accessToken || undefined;
  } catch {
    return undefined;
  }
  if (!token) { return undefined; }

  // Best-effort permission warning — fire-and-forget, does not block the caller.
  void warnIfWorldReadable(credentialsPath);

  // Promote into the keychain so subsequent reads avoid the plaintext file.
  try {
    await secrets?.store(ACCESS_TOKEN_SECRET, token);
  } catch (e) {
    log(`Could not cache access token in SecretStorage: ${(e as Error)?.message ?? e}`);
  }
  return token;
}

/** Drop the cached token, e.g. on sign-out. */
export async function clearAccessToken(): Promise<void> {
  try {
    await secrets?.delete(ACCESS_TOKEN_SECRET);
  } catch {
    /* best-effort */
  }
}

/**
 * Log a warning when the credentials file is readable by anyone other than its
 * owner. Skipped on Windows, where POSIX mode bits are not meaningful.
 */
async function warnIfWorldReadable(credentialsPath: string): Promise<void> {
  if (process.platform === 'win32') { return; }
  try {
    const mode = fs.statSync(credentialsPath).mode & 0o077;
    if (mode !== 0) {
      log(
        `⚠ ${credentialsPath} is readable by other users (mode ${(mode | 0o600).toString(8)}). ` +
          'Run `chmod 600` on it — it holds your gateway access token in plaintext.',
      );
    }
  } catch {
    /* stat failure is not actionable here */
  }
}
