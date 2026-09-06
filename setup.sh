#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 AiNxt
#
# One-command setup for the AiNxt VS Code extension, as promised by README.md.
#
#   ./setup.sh            verify prerequisites, install dependencies, build a .vsix
#   ./setup.sh --check    verify prerequisites only; changes nothing
#   ./setup.sh --install  ...and install the built .vsix into VS Code
#
# Safe to re-run. Does not touch the IntelliJ host (see hosts/intellij/README.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$REPO_ROOT/vscode-acp"
REQUIRED_NODE_MAJOR=22

MODE=build
for arg in "$@"; do
  case "$arg" in
    --check)   MODE=check ;;
    --install) MODE=install ;;
    -h|--help)
      sed -n '4,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "setup.sh: unknown option '$arg' (try --help)" >&2
      exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; Z=''
fi
ok()   { printf '%s  ok %s %s\n'   "$G" "$Z" "$1"; }
warn() { printf '%s warn %s %s\n'  "$Y" "$Z" "$1"; }
bad()  { printf '%s FAIL %s %s\n'  "$R" "$Z" "$1"; }
step() { printf '\n%s==>%s %s\n' "$B" "$Z" "$1"; }
info() { printf '       %s\n' "$1"; }

# ─── Prerequisites ────────────────────────────────────────────────────────────

FAILED=0

step "Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  bad "node not found. Install Node.js >= $REQUIRED_NODE_MAJOR from https://nodejs.org/"
  FAILED=1
else
  NODE_V="$(node -v)"                       # e.g. v20.11.1
  NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
    bad "node $NODE_V is too old; this repo requires >= $REQUIRED_NODE_MAJOR (see .nvmrc)"
    FAILED=1
  else
    ok "node $NODE_V (>= $REQUIRED_NODE_MAJOR)"
    if [ -f "$REPO_ROOT/.nvmrc" ]; then
      PINNED="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
      [ "$NODE_MAJOR" = "$PINNED" ] || warn "node $NODE_V differs from the pinned .nvmrc ($PINNED); \
supported, but CI builds on $PINNED"
    fi
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  bad "npm not found (it ships with Node.js)"
  FAILED=1
else
  ok "npm $(npm -v)"
fi

# VS Code's `code` CLI is optional for building and only needed by --install.
# On macOS the CLI is not on PATH by default, so fall back to the app bundle.
CODE_BIN=""
if command -v code >/dev/null 2>&1; then
  CODE_BIN="$(command -v code)"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
elif [ -x "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE_BIN="$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi
if [ -n "$CODE_BIN" ]; then
  ok "VS Code CLI: $CODE_BIN"
else
  warn "VS Code 'code' CLI not found. Building still works; to install the .vsix either run
       VS Code's  Command Palette -> 'Shell Command: Install code command in PATH',
       or use  Extensions panel -> ... -> 'Install from VSIX...'"
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\n%sPrerequisites missing — nothing was changed.%s\n' "$R" "$Z"
  exit 1
fi

if [ "$MODE" = check ]; then
  printf '\n%sPrerequisites satisfied.%s Run ./setup.sh to install dependencies and build.\n' "$G" "$Z"
  exit 0
fi

# ─── Install & build ──────────────────────────────────────────────────────────

step "Installing extension dependencies (npm ci in $(basename "$EXT_DIR"))"
# vscode-acp/ is the extension itself -- ~7,000 lines of TypeScript and React that
# webpack and Vite compile into the shipped bundle. It is not fetched from anywhere, so
# say that plainly rather than failing with a bare `cd: no such file or directory`.
if [ ! -f "$EXT_DIR/package.json" ]; then
  bad "$EXT_DIR is missing, so there is nothing to build."
  info "vscode-acp/ is the VS Code extension source, not a downloaded dependency:"
  info "  vscode-acp/src/              the extension host"
  info "  vscode-acp/webview-ui/src/   the React chat UI"
  info "Nothing restores it. Re-clone, or check out the file if it was deleted:"
  info "  git checkout HEAD -- vscode-acp"
  exit 1
fi
cd "$EXT_DIR"
# `npm ci` is exact and reproducible; fall back to `npm install` if the lockfile
# is out of step with package.json (e.g. a contributor mid-change).
if [ -f "$REPO_ROOT/package-lock.json" ] && npm ci --no-fund --no-audit; then
  ok "dependencies installed from package-lock.json"
else
  warn "npm ci unavailable or lockfile out of date — falling back to npm install"
  npm install --no-fund --no-audit
fi

step "Building the React webview and packaging the extension"
# `package:vsix` runs copy:profiles, copy:legal, the webview build, the webpack
# production build, and finally `vsce package`.
npm run package:vsix

VSIX="$(ls -t "$EXT_DIR"/ainxt-vscode-*.vsix 2>/dev/null | head -1 || true)"
if [ -z "$VSIX" ]; then
  bad "packaging finished but no ainxt-vscode-*.vsix was produced"
  exit 1
fi
ok "built $(basename "$VSIX") ($(du -h "$VSIX" | cut -f1))"

# ─── Install (optional) ───────────────────────────────────────────────────────

if [ "$MODE" = install ]; then
  step "Installing into VS Code"
  if [ -z "$CODE_BIN" ]; then
    bad "cannot install: no VS Code CLI found. Use Extensions panel -> ... -> 'Install from VSIX...'"
    exit 1
  fi
  "$CODE_BIN" --install-extension "$VSIX" --force
  ok "installed. Reload VS Code, then open the AiNxt panel from the Activity Bar."
fi

# ─── What to do next ──────────────────────────────────────────────────────────

REL_VSIX="${VSIX#"$REPO_ROOT"/}"
cat <<NEXT

$B==> Done. What to run next$Z

  1. Install the extension (skip if you passed --install):
NEXT
if [ -n "$CODE_BIN" ]; then
  echo "       \"$CODE_BIN\" --install-extension $REL_VSIX"
else
  echo "       VS Code -> Extensions panel -> ... -> 'Install from VSIX...' -> $REL_VSIX"
fi
cat <<NEXT

  2. This plugin is a thin client — it does not contain an agent. You also need:

       the 'ainxt' CLI on your PATH, with a model configured
          -> the ainxt-cli repository:
             cargo build --profile release-dist -p ainxt-pager-bin --bin ainxt
             ainxt login   (or set AINXT_API_KEY, or add a [model.*] entry
                            to ~/.ainxt/config.toml for a direct provider)

     No gateway is required. Only if your team runs the shared AiNxt Platform
     (a separate, optional service — the ainxt-enterprise repository) do you
     need that running too, with its URL set via the panel's Connect button.

  3. Open the AiNxt panel (Activity Bar, or ${B}Cmd/Ctrl+Shift+A${Z}) and type.

  Configuration reference: README.md and vscode-acp/README.md
NEXT
