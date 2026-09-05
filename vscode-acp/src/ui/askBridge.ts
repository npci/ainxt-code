// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
/**
 * Bridges the agent's `ainxt.dev/ask_user_question` reverse request (received in
 * AcpClientImpl.extMethod, deep in the connection layer) to the in-chat "ask"
 * card in ChatWebviewProvider — the same decoupling pattern as permissionBridge.
 */
export interface AskParams {
  sessionId?: string;
  toolCallId?: string;
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string; preview?: string; id?: string }>;
    multi_select?: boolean;
    id?: string;
  }>;
  mode?: string;
}

/** One of the outcome shapes the agent accepts (accepted / cancelled). */
export type AskResult = Record<string, unknown>;

export type AskUi = (params: AskParams) => Promise<AskResult>;

let uiHandler: AskUi | undefined;

export const askBridge = {
  setUi(handler: AskUi | undefined): void {
    uiHandler = handler;
  },
  hasUi(): boolean {
    return !!uiHandler;
  },
  async request(params: AskParams): Promise<AskResult> {
    if (!uiHandler) { return { outcome: 'cancelled' }; }
    return uiHandler(params);
  },
};
