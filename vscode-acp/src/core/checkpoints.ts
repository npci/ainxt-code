// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';

/**
 * Per-turn file checkpoints. Before the agent writes a file we snapshot its
 * prior content (or mark it as newly-created); "restore" reverts every write
 * from the last turn — an undo for agent edits. Only paths we actually
 * snapshotted are touched, so restore is bounded and safe.
 */
type Snap = { existed: boolean; content: Uint8Array };
let current = new Map<string, Snap>();

export const checkpoints = {
  /** Start a fresh checkpoint (call at the beginning of a turn). */
  begin(): void {
    current = new Map();
  },

  /** Snapshot a file's current content before it's overwritten (idempotent). */
  async snapshot(fsPath: string): Promise<void> {
    if (current.has(fsPath)) { return; }
    const uri = vscode.Uri.file(fsPath);
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      current.set(fsPath, { existed: true, content });
    } catch {
      current.set(fsPath, { existed: false, content: new Uint8Array() });
    }
  },

  count(): number {
    return current.size;
  },

  /** Revert all snapshotted files to their pre-turn state. Returns #reverted. */
  async restore(): Promise<number> {
    let n = 0;
    for (const [fsPath, snap] of current) {
      const uri = vscode.Uri.file(fsPath);
      try {
        if (snap.existed) { await vscode.workspace.fs.writeFile(uri, snap.content); }
        else { await vscode.workspace.fs.delete(uri, { useTrash: true }); }
        n++;
      } catch { /* skip unrevertable */ }
    }
    current = new Map();
    return n;
  },
};
