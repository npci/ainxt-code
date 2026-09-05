// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 AiNxt
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A deployment profile loaded from a `*.ainxtprofile.json` file.
 *
 * Profile files live in `<repo-root>/config/` and are shipped with the extension.
 * They are NOT secrets — they contain only gateway URLs, model IDs, and flags.
 * The API key is never stored in a profile file; it is always stored in SecretStorage.
 *
 * Two profiles ship by default: `standalone.ainxtprofile.json` (no gateway —
 * the CLI talks directly to a model you configure) and `oss.ainxtprofile.json`
 * (a self-hosted AiNxt Platform gateway, for teams that run one). Add your own
 * by dropping another `*.ainxtprofile.json` beside them -- the UI is built from
 * whatever is present, so no code change is needed and no organisation is named
 * in this file.
 */
export interface AinxtProfile {
  profile: string;
  displayName: string;
  description: string;
  gatewayUrl: string;
  model: string;
  allowInsecure: boolean;
  binaryPath: string;
  notes: string[];
}

/**
 * Resolve the directory that contains the `*.ainxtprofile.json` files.
 *
 * In a packaged extension the files are bundled under `<extensionPath>/config/`.
 * During development they live at `<repo-root>/config/` (two levels up from `src/config/`).
 */
function profileDir(context: vscode.ExtensionContext): string {
  // Packaged: extensionPath/config/
  const packed = path.join(context.extensionPath, 'config');
  if (fs.existsSync(packed)) { return packed; }
  // Development fallback: repo-root/config/ (src/config → ../../config)
  const dev = path.join(context.extensionPath, '..', 'config');
  return dev;
}

/**
 * Read all `*.ainxtprofile.json` files from the config directory.
 * Returns an empty array if the directory does not exist or contains no profiles.
 */
export function listProfiles(context: vscode.ExtensionContext): AinxtProfile[] {
  const dir = profileDir(context);
  if (!fs.existsSync(dir)) { return []; }

  const profiles = fs.readdirSync(dir)
    .filter(f => f.endsWith('.ainxtprofile.json'))
    .map(f => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        return JSON.parse(raw) as AinxtProfile;
      } catch {
        return null;
      }
    })
    .filter((p): p is AinxtProfile => p !== null);

  // Gateway-free (standalone) profiles first — that is the recommended default
  // for anyone not running the AiNxt Platform, and should be the first thing
  // offered rather than buried alphabetically behind a gateway-based one.
  return profiles.sort((a, b) => (a.gatewayUrl ? 1 : 0) - (b.gatewayUrl ? 1 : 0));
}

/**
 * Apply a profile to VS Code settings (user scope).
 *
 * Writes:
 *   ainxt.gatewayUrl    ← profile.gatewayUrl
 *   ainxt.model         ← profile.model
 *   ainxt.allowInsecure ← profile.allowInsecure
 *   ainxt.binaryPath    ← profile.binaryPath  (only when non-empty)
 *
 * Does NOT touch the API key — that is always set via SecretStorage / `ainxt login`.
 * Does NOT override values already set by environment variables at runtime.
 */
export async function applyProfile(profile: AinxtProfile): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ainxt');
  const target = vscode.ConfigurationTarget.Global;

  await cfg.update('gatewayUrl',    profile.gatewayUrl,    target);
  await cfg.update('model',         profile.model,         target);
  await cfg.update('allowInsecure', profile.allowInsecure, target);

  if (profile.binaryPath) {
    await cfg.update('binaryPath', profile.binaryPath, target);
  }
}

/**
 * Show a QuickPick of available profiles and apply the selected one.
 * Called by the `ainxt.loadProfile` command.
 *
 * Returns the applied profile, or undefined if the user cancelled.
 */
export async function showProfilePicker(
  context: vscode.ExtensionContext
): Promise<AinxtProfile | undefined> {
  const profiles = listProfiles(context);

  if (profiles.length === 0) {
    vscode.window.showWarningMessage(
      'No AiNxt profile files found. Expected *.ainxtprofile.json files in the config/ directory.'
    );
    return undefined;
  }

  const items: (vscode.QuickPickItem & { profile: AinxtProfile })[] = profiles.map(p => ({
    label:       `$(server) ${p.displayName}`,
    description: p.gatewayUrl,
    detail:      p.description,
    profile:     p,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:             'Load AiNxt Configuration Profile',
    placeHolder:       'Select a deployment profile to pre-fill your settings',
    matchOnDescription: true,
    matchOnDetail:      true,
  });

  if (!picked) { return undefined; }

  await applyProfile(picked.profile);

  const msg = `✅ Profile "${picked.profile.displayName}" loaded.\n${picked.profile.gatewayUrl ? `Gateway: ${picked.profile.gatewayUrl}` : 'No gateway — standalone mode.'}${picked.profile.model ? `\nModel: ${picked.profile.model}` : ''}`;

  const action = await vscode.window.showInformationMessage(
    msg,
    { modal: false },
    'Open Settings',
    'Connect Now'
  );

  if (action === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'ainxt');
  } else if (action === 'Connect Now') {
    vscode.commands.executeCommand('acp.connectAgent');
  }

  return picked.profile;
}

/**
 * Show the first-run profile prompt when nothing has been configured yet.
 *
 * Triggered on extension activation when:
 *   - ainxt.gatewayUrl is unset (or still the legacy http://localhost:8000
 *     default from an older version), AND
 *   - No API key is stored in SecretStorage
 *
 * This gives new users a guided path to the right profile without forcing them
 * to know what to configure manually. It is purely a convenience: the CLI is
 * fully usable without picking anything here, as long as it already has a
 * model configured (~/.ainxt/config.toml, AINXT_API_KEY, or `ainxt login`).
 */
export async function showFirstRunPromptIfNeeded(
  context: vscode.ExtensionContext
): Promise<void> {
  // Only show once per install — track via globalState
  const shown = context.globalState.get<boolean>('ainxt.firstRunProfileShown', false);
  if (shown) { return; }

  const cfg = vscode.workspace.getConfiguration('ainxt');
  const gatewayUrl = cfg.get<string>('gatewayUrl', '').trim();
  const apiKey = await context.secrets.get('ainxt.apiKey');

  // Only prompt if nothing has been configured yet (no gateway — including the
  // legacy pre-existing default some settings.json files still carry — and no key)
  const isDefault = !gatewayUrl || gatewayUrl === 'http://localhost:8000';
  if (!isDefault || apiKey) {
    await context.globalState.update('ainxt.firstRunProfileShown', true);
    return;
  }

  const profiles = listProfiles(context);
  if (profiles.length === 0) { return; }

  // Buttons are derived from the profiles actually present, not hardcoded.
  // Previously the two buttons were hardcoded to specific deployments and the
  // answer was mapped back with a ternary, so one organisation was named in a
  // public extension and every button except the first silently loaded the same
  // fallback profile. Anyone adding a profile now gets a button for it with no
  // code change.
  const CONFIGURE_MANUALLY = 'Configure Manually';
  const labelFor = (p: AinxtProfile) => `Load ${p.displayName || p.profile} Profile`;
  const buttons = profiles.map(labelFor);
  const action = await vscode.window.showInformationMessage(
    'Welcome to AiNxt! No gateway is required — pick "Standalone" to use the CLI ' +
      'directly with your own model, or dismiss this and just start typing if ' +
      '`ainxt` already has one configured.',
    ...buttons,
    CONFIGURE_MANUALLY
  );

  await context.globalState.update('ainxt.firstRunProfileShown', true);

  if (action === CONFIGURE_MANUALLY) {
    vscode.commands.executeCommand('workbench.action.openSettings', 'ainxt');
    return;
  }

  if (action) {
    const profile = profiles.find(p => labelFor(p) === action);
    if (profile) {
      await applyProfile(profile);
      vscode.window.showInformationMessage(
        `✅ "${profile.displayName}" profile loaded. ${profile.gatewayUrl ? `Gateway: ${profile.gatewayUrl}` : 'No gateway — standalone mode.'}`
      );
    }
  }
}
