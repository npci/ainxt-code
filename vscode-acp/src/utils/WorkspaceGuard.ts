// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { log } from './Logger';

/**
 * Resolve a path to its canonical form so `..` segments, symlinks and relative
 * paths cannot disguise a location outside the workspace. Falls back to the
 * absolute path when the target does not exist yet (the write case).
 *
 * Async so it never blocks the VS Code extension host event loop (P1-3 / CWE-400).
 * The previous `fs.realpathSync.native` call was synchronous disk I/O on the
 * main thread; `fs.promises.realpath` is the non-blocking equivalent.
 */
async function canonical(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fs.promises.realpath(absolute);
  } catch {
    // Target does not exist yet (write case) — return the absolute path.
    return absolute;
  }
}

/**
 * True when `target` resolves to a location inside one of the open workspace
 * folders.
 *
 * Uses `path.relative` on canonical paths rather than a string prefix test, so
 * a sibling directory sharing a name prefix (`/work/project-secrets` against
 * the root `/work/project`) is correctly treated as outside (CWE-23).
 *
 * With no workspace open there is no boundary to enforce, so every path counts
 * as outside and the caller prompts.
 *
 * Now async (P1-3): callers must await this function. All callers in
 * FileSystemHandler are already async, so no call-site signature changes.
 */
export async function isInsideWorkspace(target: string): Promise<boolean> {
  if (!target || !target.trim()) { return false; }
  const roots = vscode.workspace.workspaceFolders;
  if (!roots || roots.length === 0) { return false; }

  const resolved = await canonical(target);
  const results = await Promise.all(
    roots.map(async (folder) => {
      const root = await canonical(folder.uri.fsPath);
      const rel = path.relative(root, resolved);
      // Inside when the relative path stays below the root: not empty-with-escape,
      // never starting with '..', and not switching drive (rel stays relative).
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }),
  );
  return results.some(Boolean);
}

/**
 * Ask the user to approve an operation the agent requested that falls outside
 * the normal, already-permissioned flow (shell execution, or file access
 * outside the workspace).
 *
 * Returns true only on an explicit "Allow" — a dismissed dialog, an Escape, or
 * any failure denies, so a prompt that cannot be shown never silently
 * authorises the operation.
 */
export async function confirmSensitiveOperation(
  title: string,
  detail: string,
): Promise<boolean> {
  try {
    const choice = await vscode.window.showWarningMessage(
      title,
      { modal: true, detail },
      'Allow',
    );
    return choice === 'Allow';
  } catch (e) {
    log(`Operation approval prompt failed; denying. ${(e as Error)?.message ?? e}`);
    return false;
  }
}
