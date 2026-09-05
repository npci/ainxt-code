// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Decouples the permission producer (PermissionHandler, deep in the connection
 * layer) from the permission UI (ChatWebviewProvider). The webview registers a
 * handler; PermissionHandler routes requests to it, falling back to the native
 * QuickPick when no webview UI is available (e.g. before the panel loads).
 */
export type PermissionUi = (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

let uiHandler: PermissionUi | undefined;

export const permissionBridge = {
  setUi(handler: PermissionUi | undefined): void {
    uiHandler = handler;
  },
  hasUi(): boolean {
    return !!uiHandler;
  },
  async request(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!uiHandler) { throw new Error('no permission UI registered'); }
    return uiHandler(params);
  },
};
