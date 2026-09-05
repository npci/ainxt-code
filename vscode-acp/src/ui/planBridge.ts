// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
/**
 * Bridges the agent's `ainxt.dev/exit_plan_mode` reverse request (plan-mode
 * approval) to the in-chat plan-approval card, mirroring permissionBridge/askBridge.
 */
export interface PlanParams {
  sessionId?: string;
  toolCallId?: string;
  planContent?: string | null;
}

/** { outcome: "approved" | "cancelled" | "abandoned", feedback? } */
export type PlanResult = Record<string, unknown>;

export type PlanUi = (params: PlanParams) => Promise<PlanResult>;

let uiHandler: PlanUi | undefined;

export const planBridge = {
  setUi(handler: PlanUi | undefined): void {
    uiHandler = handler;
  },
  hasUi(): boolean {
    return !!uiHandler;
  },
  async request(params: PlanParams): Promise<PlanResult> {
    // No UI → keep plan mode active (agent treats cancelled as "stay planning").
    if (!uiHandler) { return { outcome: 'cancelled' }; }
    return uiHandler(params);
  },
};
