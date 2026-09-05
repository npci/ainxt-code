// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';

/**
 * Telemetry connection string.
 *
 * Single-codebase strategy (internal + OSS):
 *   - OSS builds: AINXT_TELEMETRY_CONNECTION_STRING is not set → telemetry is
 *     completely disabled. No data leaves the user's machine.
 *   - Internal builds: inject the Azure Application Insights connection string
 *     via the CI/CD pipeline env var. Never hardcode it here.
 *
 * The extension also respects VS Code's global telemetry level setting
 * (telemetry.telemetryLevel) via @vscode/extension-telemetry automatically.
 */
const CONNECTION_STRING = process.env.AINXT_TELEMETRY_CONNECTION_STRING ?? '';

let reporter: TelemetryReporter | undefined;

/** Common properties attached to every telemetry event. */
function getCommonProperties(): Record<string, string> {
  return {
    ideName: vscode.env.appName,
    ideUriScheme: vscode.env.uriScheme,
    ideAppHost: vscode.env.appHost,
  };
}

/**
 * Initialise the telemetry reporter. Must be called once during `activate()`.
 * Returns a disposable so it can be pushed into `context.subscriptions`.
 *
 * When AINXT_TELEMETRY_CONNECTION_STRING is not set (OSS default), returns a
 * no-op disposable — no TelemetryReporter is created and no data is sent.
 */
export function initTelemetry(): { dispose(): void } {
  if (!CONNECTION_STRING) {
    // OSS build or telemetry not configured — all sendEvent/sendError calls
    // below are no-ops because `reporter` stays undefined.
    return { dispose: () => {} };
  }
  if (reporter) {
    return reporter;
  }
  reporter = new TelemetryReporter(CONNECTION_STRING);
  return reporter;
}

/**
 * Send a named telemetry event. No-op when telemetry is disabled.
 */
export function sendEvent(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryEvent(eventName, { ...getCommonProperties(), ...properties }, measurements);
}

/**
 * Send an error event (non-exception). No-op when telemetry is disabled.
 */
export function sendError(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryErrorEvent(eventName, { ...getCommonProperties(), ...properties }, measurements);
}

/**
 * Report an exception / caught error. No-op when telemetry is disabled.
 */
export function sendException(error: Error, properties?: Record<string, string>): void {
  reporter?.sendTelemetryErrorEvent('unhandledException', {
    ...getCommonProperties(),
    ...properties,
    errorName: error.name,
    errorMessage: error.message,
  });
}
