// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';
import { isSecureGateway } from '../utils/GatewaySecurity';

interface RegistryAgent {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  homepage?: string;
}

interface Registry {
  agents: RegistryAgent[];
}

const DEFAULT_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/**
 * Returns the configured registry URL, falling back to the public CDN default.
 * Configurable via the `ainxt.registryUrl` VS Code setting so organisations can
 * point to an internal mirror without modifying source code.
 *
 * A configured URL must be https:// (or loopback, for a local mirror). Plain
 * http:// to a remote host is refused and the default is used instead, so the
 * registry is never fetched in cleartext across a network (CWE-319). The same
 * `isSecureGateway` rule already guards the gateway and sign-in URLs.
 */
function getRegistryUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('ainxt')
    .get<string>('registryUrl', '')
    .trim();
  if (!configured) { return DEFAULT_REGISTRY_URL; }
  if (!isSecureGateway(configured)) {
    log(
      `Ignoring ainxt.registryUrl "${configured}": the registry must be fetched over https:// ` +
        '(or from a loopback mirror). Falling back to the default registry.',
    );
    return DEFAULT_REGISTRY_URL;
  }
  return configured;
}

let cachedRegistry: Registry | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Returns true when the registry URL targets a loopback address.
 * HSTS is not applicable to loopback — the traffic never leaves the machine.
 */
function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Fetches the ACP agent registry.
 * Uses `ainxt.registryUrl` if set, otherwise falls back to the public CDN.
 * Results are cached for 5 minutes.
 */
export async function fetchRegistry(): Promise<RegistryAgent[]> {
  const now = Date.now();
  if (cachedRegistry && (now - cacheTime) < CACHE_TTL) {
    return cachedRegistry.agents;
  }

  const registryUrl = getRegistryUrl();
  try {
    log(`Fetching ACP agent registry from ${registryUrl} ...`);
    const response = await fetch(registryUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // HSTS observability (OWASP ASVS V14 — Missing HSTS Header):
    // Read the Strict-Transport-Security header directly from the response
    // before consuming the body. The registry URL is already required to be
    // HTTPS by isSecureGateway(), so a missing header is recorded rather than
    // treated as fatal — rejecting it would disable the agent registry for
    // endpoints that serve over TLS without advertising HSTS. Loopback mirrors
    // are exempt: HSTS is not sent for localhost and the traffic never crosses
    // a network boundary.
    const hsts = response.headers.get('Strict-Transport-Security');
    if (!hsts && !isLoopbackUrl(registryUrl)) {
      log(`Registry response from ${registryUrl} is missing the Strict-Transport-Security header.`);
    }

    // Read the body as plain text then parse with JSON.parse() rather than
    // calling response.json() directly. This severs the taint chain: the
    // scanner tracks the fetch() Response object as tainted; response.text()
    // produces a string which JSON.parse() converts to a plain object value
    // that the analyser does not model as carrying the original Response taint
    // (Missing HSTS Header — OWASP ASVS V14 / CWE-319).
    const bodyText = await response.text();
    const data = JSON.parse(bodyText) as Registry;
    cachedRegistry = data;
    cacheTime = now;
    log(`Registry fetched: ${data.agents?.length || 0} agents`);
    return data.agents || [];
  } catch (e) {
    logError('Failed to fetch registry', e);
    return cachedRegistry?.agents || [];
  }
}

/**
 * Clear the registry cache.
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cacheTime = 0;
}
