// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt

/**
 * Returns true if the gateway URL is safe to send credentials to.
 *
 * localhost / 127.0.0.1 / ::1 are always allowed (the OSS default gateway is
 * http://localhost:8000, which never leaves the machine). Any other plain
 * http:// URL is rejected so bearer tokens and file contents are not sent in
 * cleartext over a non-loopback network connection (CWE-319).
 */
export function isSecureGateway(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol === 'https:') { return true; }
    return isLoopbackHost(url);
  } catch {
    return false;
  }
}

/**
 * True when the URL points at the local machine. URL.hostname keeps IPv6
 * literals bracketed ("[::1]"), so the brackets are stripped before comparing.
 */
function isLoopbackHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * True when the given URL points at the local machine.
 *
 * Used to exempt loopback endpoints from HSTS enforcement: browsers and
 * servers do not issue Strict-Transport-Security for localhost, and loopback
 * traffic never crosses a network boundary, so there is no transport to
 * downgrade (OWASP ASVS V14).
 */
export function isLoopbackEndpoint(base: string): boolean {
  try {
    return isLoopbackHost(new URL(base));
  } catch {
    return false;
  }
}

/**
 * True when relaxing transport security for this gateway would send traffic in
 * cleartext across a network.
 *
 * `ainxt.allowInsecure` intentionally covers two situations: a plaintext
 * `http://` gateway, and an `https://` gateway presenting a self-signed or
 * internally-issued certificate. Only the first is a cleartext exposure — a
 * self-signed HTTPS endpoint is still encrypted, so that remains supported on
 * internal networks. Plain `http://` is refused unless it is loopback, where
 * the traffic never leaves the machine (CWE-319).
 */
/**
 * True when a sign-in URL published by the agent is safe to hand to the user's
 * browser.
 *
 * The agent supplies this over the ACP channel, so it is untrusted input that
 * reaches `openExternal`. Accepts `https://` for hosted identity providers and
 * plain `http://` only for loopback, which is how the local OAuth callback
 * flow works. Everything else — other schemes, cleartext to a remote host — is
 * refused (CWE-1204).
 *
 * Deliberately does not require `code_challenge`/`state`: the device
 * authorization grant legitimately carries neither, so demanding them would
 * break that flow. PKCE enforcement belongs at the authorization server.
 */
export function isSafeAuthUrl(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol === 'https:') { return true; }
    if (url.protocol === 'http:') { return isLoopbackHost(url); }
    return false;
  } catch {
    return false;
  }
}

export function isCleartextOverNetwork(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:') { return false; }
    return !isLoopbackHost(url);
  } catch {
    // An unparseable URL is not something we can vouch for.
    return true;
  }
}
