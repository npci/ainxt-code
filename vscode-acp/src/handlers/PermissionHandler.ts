// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import { permissionBridge } from '../ui/permissionBridge';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Handles ACP permission requests from agents.
 * Shows VS Code QuickPick for user to select from agent-provided options.
 */
export class PermissionHandler {
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const config = vscode.workspace.getConfiguration('acp');
    const autoApprove = config.get<string>('autoApprovePermissions', 'none');

    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

    // Auto-approve: only pick allow_once — never silently grant allow_always
    // (a permanent grant should always require explicit user confirmation,
    // even in allowAll mode, to prevent a misbehaving agent from acquiring
    // persistent permissions without the user's awareness).
    if (autoApprove === 'allowAll') {
      const allowOnceOption = params.options.find(o => o.kind === 'allow_once');
      if (allowOnceOption) {
        sendEvent('permission/requested', { permissionType: title, autoApproved: 'true' });
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOnceOption.optionId,
          },
        };
      }
      // No allow_once option available — fall through to the normal dialog
      // so the user can consciously decide whether to grant a permanent permission.
      log(`allowAll: no allow_once option for "${title}" — showing dialog for explicit confirmation`);
    }

    // Prefer the in-chat permission card (AiNxt). Falls back to the native
    // QuickPick if the webview UI hasn't registered yet.
    if (permissionBridge.hasUi()) {
      try {
        sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });
        return await permissionBridge.request(params);
      } catch (e) {
        log(`in-chat permission failed, falling back to QuickPick: ${(e as Error).message}`);
      }
    }

    // Build QuickPick items from agent-provided options
    const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map(option => {
      const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        optionId: option.optionId,
      };
    });

    sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      log('Permission cancelled by user');
      sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
      return {
        outcome: { outcome: 'cancelled' },
      };
    }

    log(`Permission selected: ${selection.optionId}`);
    sendEvent('permission/responded', {
      permissionType: title,
      action: selection.optionId,
      outcome: 'selected',
    });
    return {
      outcome: {
        outcome: 'selected',
        optionId: selection.optionId,
      },
    };
  }
}
