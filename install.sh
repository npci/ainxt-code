#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 AiNxt
#
# AiNxt Code — one-command installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/npci/ainxt-code/main/install.sh | sh
#
# With options, give sh the arguments explicitly:
#
#   curl -fsSL .../install.sh | sh -s -- --gateway https://gw.example.com:8000
#
# Windows: use install.ps1 instead (see README). `curl | sh` needs a POSIX shell,
# which Windows does not provide; curl.exe alone is not enough.
#
# What it does, in order: detect platform -> find VS Code / JetBrains -> obtain the
# extension (published release if there is one, else build from source) -> install
# it -> install the ainxt CLI agent -> (only if --gateway was given) configure and
# verify the AiNxt Platform gateway -> print what to do next.
#
# The AiNxt Platform gateway is optional. Without --gateway, the CLI runs
# standalone against a directly-configured model (~/.ainxt/config.toml,
# AINXT_API_KEY, or `ainxt login` against your own provider) — this installer
# never assumes a gateway is required.
#
# Everything is overridable by environment variable or flag; nothing is compiled in.
# POSIX sh on purpose: no bash, no arrays, no [[ ]].

set -eu

# ─── Defaults (every one overridable) ─────────────────────────────────────────

REPO_SLUG="${AINXT_REPO_SLUG:-npci/ainxt-code}"
# No default gateway: the ainxt CLI runs standalone against a directly-configured
# model (config.toml, AINXT_API_KEY, or `ainxt login` against your own provider)
# unless you explicitly opt into the AiNxt Platform with --gateway / AINXT_GATEWAY_URL.
GATEWAY_URL="${AINXT_GATEWAY_URL:-}"
GATEWAY_EXPLICIT=0
[ -n "$GATEWAY_URL" ] && GATEWAY_EXPLICIT=1
API_KEY="${AINXT_API_KEY:-}"
VERSION="${AINXT_VERSION:-latest}"
SOURCE_DIR="${AINXT_SOURCE_DIR:-}"
CLI_DIR="${AINXT_CLI_DIR:-}"
CLI_REPO_SLUG="${AINXT_CLI_REPO_SLUG:-npci/ainxt-cli}"
# Full clone URL override, for a mirror or an internal Git host. Defaults to
# GitHub from the slug above.
CLI_REPO_URL="${AINXT_CLI_REPO_URL:-https://github.com/$CLI_REPO_SLUG.git}"
CLI_VERSION="${AINXT_CLI_VERSION:-latest}"
SKIP_CLI=0
NO_RUST=0
CLI_SRC_CACHE="${AINXT_CLI_SRC:-$HOME/.ainxt/src/ainxt-cli}"
TARGET_IDE="${AINXT_IDE:-auto}"       # auto | vscode | jetbrains | both | none
MIN_NODE_MAJOR=22

MODE=install                          # install | verify | uninstall
FROM_SOURCE=0
ASSUME_YES=0
NO_VERIFY=0

# ─── Output ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
  R=$(printf '\033[31m'); D=$(printf '\033[2m');  Z=$(printf '\033[0m')
else
  B=''; G=''; Y=''; R=''; D=''; Z=''
fi
ok()   { printf '  %sok%s   %s\n'   "$G" "$Z" "$1"; }
warn() { printf '  %swarn%s %s\n'   "$Y" "$Z" "$1"; }
bad()  { printf '  %sFAIL%s %s\n'   "$R" "$Z" "$1"; }
info() { printf '  %s%s%s\n'        "$D" "$1" "$Z"; }
step() { printf '\n%s==>%s %s\n'    "$B" "$Z" "$1"; }
die()  { printf '\n%serror:%s %s\n' "$R" "$Z" "$1" >&2; exit 1; }

usage() {
  cat <<USAGE
${B}AiNxt Code installer${Z}

  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | sh

${B}Options${Z} (pass with: | sh -s -- <options>)
  --gateway <url>     AiNxt Platform gateway URL — optional; only needed for a
                      shared/governed deployment. Omit it to run the CLI
                      standalone against a directly-configured model.
                      (default: none)
  --api-key <key>     API key; else 'ainxt login' supplies credentials
  --ide <which>       auto | vscode | jetbrains | both | none   (default auto)
  --version <v>       Release to install, or 'latest'
  --from-source       Build from source even if a release exists
  --source-dir <dir>  Use an existing checkout instead of cloning
  --cli-dir <dir>     Build the 'ainxt' agent from this ainxt-cli checkout
  --cli-version <v>   Agent release to install, or 'latest'
  --skip-cli          Do not touch the 'ainxt' agent
  --no-rust           Never install the Rust toolchain automatically
  --verify            Only check gateway connectivity; install nothing
  --uninstall         Remove the VS Code extension
  --yes               Do not prompt
  --no-verify         Skip the endpoint check
  -h, --help          This text

${B}Environment${Z}
  AINXT_GATEWAY_URL  AINXT_API_KEY  AINXT_VERSION  AINXT_IDE
  AINXT_SOURCE_DIR   AINXT_REPO_SLUG
  AINXT_CLI_DIR      AINXT_CLI_VERSION  AINXT_CLI_REPO_SLUG  AINXT_CLI_REPO_URL
  AINXT_CLI_SRC      Where the agent source is cached (default ~/.ainxt/src/ainxt-cli)
  AINXT_BASE_URL     Enterprise artifact host, passed through to the agent installer
  AINXT_BINARY_PATH  Use an 'ainxt' binary already on disk
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --gateway)    GATEWAY_URL="${2:?--gateway needs a URL}"; GATEWAY_EXPLICIT=1; shift 2 ;;
    --api-key)    API_KEY="${2:?--api-key needs a value}"; shift 2 ;;
    --ide)        TARGET_IDE="${2:?--ide needs a value}"; shift 2 ;;
    --version)    VERSION="${2:?--version needs a value}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?--source-dir needs a path}"; FROM_SOURCE=1; shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --cli-dir)    CLI_DIR="${2:?--cli-dir needs a path}"; shift 2 ;;
    --cli-version) CLI_VERSION="${2:?--cli-version needs a value}"; shift 2 ;;
    --skip-cli)   SKIP_CLI=1; shift ;;
    --no-rust)    NO_RUST=1; shift ;;
    --verify)     MODE=verify; shift ;;
    --uninstall)  MODE=uninstall; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --no-verify)  NO_VERIFY=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) printf 'install.sh: unknown option %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

GATEWAY_URL=$(printf '%s' "$GATEWAY_URL" | sed 's:/*$::')

# ─── Platform ─────────────────────────────────────────────────────────────────

detect_platform() {
  OS=$(uname -s)
  case "$OS" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows detected. Use the PowerShell installer instead:
    irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1 | iex" ;;
    *) die "unsupported OS: $OS" ;;
  esac
  case $(uname -m) in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) ARCH=$(uname -m) ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# Run a command with a wall-clock limit. `timeout` does not exist on macOS, and
# this matters more than it looks: an `ainxt --version` against a binary that does
# not implement --version sits reading stdin forever, and a command substitution
# waits for it, so the installer hangs with no output. Every probe of a
# third-party binary goes through here, with stdin closed.
run_bounded() {
  _secs="$1"; shift
  if have perl; then
    # The subshell keeps the shell's own "Alarm clock" job notice off the terminal
    # when SIGALRM kills the child.
    ( perl -e 'my $t=shift; eval { local $SIG{ALRM}=sub{die}; alarm $t; exec @ARGV; }; exit 124' \
        "$_secs" "$@" </dev/null 2>/dev/null ) 2>/dev/null
  elif have timeout; then
    timeout "$_secs" "$@" </dev/null 2>/dev/null
  else
    # Last resort: run in the background and reap it.
    "$@" </dev/null 2>/dev/null &
    _p=$!
    ( sleep "$_secs"; kill -TERM "$_p" 2>/dev/null ) 2>/dev/null &
    _w=$!
    wait "$_p" 2>/dev/null
    kill "$_w" 2>/dev/null
  fi
}

# VS Code's CLI is not on PATH by default on macOS, so look in the bundles too.
find_vscode() {
  for c in code code-insiders codium cursor windsurf; do
    if have "$c"; then VSCODE_BIN=$(command -v "$c"); VSCODE_NAME="$c"; return 0; fi
  done
  for p in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/VSCodium.app/Contents/Resources/app/bin/codium" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/usr/share/code/bin/code" \
    "/snap/bin/code" \
    "/var/lib/flatpak/exports/bin/com.visualstudio.code" \
    "$HOME/.local/share/flatpak/exports/bin/com.visualstudio.code" ; do
    if [ -x "$p" ]; then VSCODE_BIN="$p"; VSCODE_NAME=$(basename "$p"); return 0; fi
  done
  VSCODE_BIN=""; return 1
}

find_jetbrains() {
  JB_DIRS=""
  if [ "$PLATFORM" = macos ]; then
    JB_ROOT="$HOME/Library/Application Support/JetBrains"
  else
    JB_ROOT="$HOME/.local/share/JetBrains"
  fi
  [ -d "$JB_ROOT" ] || { return 1; }
  # Any product config dir means an IDE of that family has been run at least once.
  JB_DIRS=$(find "$JB_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -8)
  [ -n "$JB_DIRS" ]
}

vscode_settings_path() {
  case "$PLATFORM" in
    macos) printf '%s/Library/Application Support/Code/User/settings.json' "$HOME" ;;
    linux) printf '%s/Code/User/settings.json' "${XDG_CONFIG_HOME:-$HOME/.config}" ;;
  esac
}

# ─── Gateway verification — the part that answers "is it actually connected" ───
#
# Probes the three routes the extension itself calls. /complete is expected to be
# absent on a stock Platform (it backs the opt-in autocomplete only), so a 404
# there is reported as informational, not as a failure.
# Return a 3-digit HTTP status, or 000 if the host could not be reached.
# `curl -w '%{http_code}'` prints 000 *and* exits non-zero on a connection
# failure, so the `|| true` must live inside the substitution — otherwise an
# outer `|| printf 000` fires as well and the codes concatenate to "000000",
# which then silently fails every string comparison against "000".
http_code() {
  _url="$1"; _hdr="${2:-}"
  if [ -n "$_hdr" ]; then
    curl -s -o /dev/null -w '%{http_code}' -m 15 -H "$_hdr" "$_url" 2>/dev/null || true
  else
    curl -s -o /dev/null -w '%{http_code}' -m 15 "$_url" 2>/dev/null || true
  fi
}

# Probes the three routes the extension itself calls. `/complete` is expected to
# be absent on a stock Platform (it backs only the opt-in autocomplete), so a 404
# there is informational, not a failure.
#
# No-op (and not a failure) when no gateway was requested: the ainxt CLI does not
# need one, so there is nothing to verify unless --gateway / AINXT_GATEWAY_URL
# was explicitly given.
verify_gateway() {
  if [ "$GATEWAY_EXPLICIT" != 1 ]; then
    step "Gateway"
    info "no --gateway given — running standalone. The ainxt CLI talks directly to"
    info "whatever model you configure (~/.ainxt/config.toml, AINXT_API_KEY, or"
    info "'ainxt login' against your own provider). Pass --gateway <url> only if"
    info "your team runs the AiNxt Platform (a separate, optional service)."
    return 0
  fi
  step "Verifying the gateway at $GATEWAY_URL"
  GATEWAY_OK=0
  if ! have curl; then warn "curl not found; skipping endpoint checks"; return 0; fi

  AUTH_HDR=""
  [ -n "$API_KEY" ] && AUTH_HDR="Authorization: Bearer $API_KEY"

  ROOT=$(http_code "$GATEWAY_URL/")
  if [ "$ROOT" = "000" ] || [ -z "$ROOT" ]; then
    bad "cannot reach $GATEWAY_URL — nothing is listening, or DNS/firewall is blocking"
    info "The AiNxt Platform binds 0.0.0.0:8000 by default. Start it first (see the"
    info "ainxt-enterprise repository), or pass --gateway with the correct URL."
    info "Note: the Platform's .env.example says 9001, but gunicorn.conf.py never"
    info "reads .env, so 8000 is what you actually get unless you export BIND."
    return 0
  fi
  ok "gateway responds (HTTP $ROOT at /)"

  probe() {
    _path="$1"; _label="$2"; _expect_missing="${3:-0}"
    _code=$(http_code "$GATEWAY_URL$_path" "$AUTH_HDR")
    [ -n "$_code" ] || _code=000
    case "$_code" in
      200) ok "$_label -> 200" ;;
      401|403)
        if [ -n "$API_KEY" ]; then
          bad "$_label -> $_code (the API key was rejected)"
        elif [ "${CREDS_OK:-0}" = 1 ]; then
          # The extension authenticates with the token `ainxt login` wrote. This
          # check deliberately does not read that file — a verifier should not be
          # parsing and transmitting the user's credentials — so an unauthenticated
          # probe returning 401 is the correct result, not a problem.
          info "$_label -> $_code (expected: this check is unauthenticated; the extension uses your ainxt login token)"
        else
          warn "$_label -> $_code (needs credentials: run 'ainxt login', or pass --api-key)"
        fi ;;
      404)
        if [ "$_expect_missing" = 1 ]; then
          info "$_label -> 404 (expected; only the opt-in autocomplete uses it)"
        else
          bad "$_label -> 404 (route absent — is this really an AiNxt Platform?)"
        fi ;;
      000) bad "$_label -> no response" ;;
      *)   warn "$_label -> $_code" ;;
    esac
  }

  probe "/ainxt/v1/api/auth/me"   "GET  /ainxt/v1/api/auth/me  "
  probe "/ainxt/v1/api/budget/me" "GET  /ainxt/v1/api/budget/me"
  probe "/ainxt/v1/api/complete"  "POST /ainxt/v1/api/complete " 1
  GATEWAY_OK=1
}

# ─── Acquire the extension ────────────────────────────────────────────────────

release_asset_url() {
  if [ "$VERSION" = latest ]; then
    printf 'https://github.com/%s/releases/latest/download/ainxt-vscode.vsix' "$REPO_SLUG"
  else
    printf 'https://github.com/%s/releases/download/%s/ainxt-vscode-%s.vsix' \
      "$REPO_SLUG" "$VERSION" "$(printf '%s' "$VERSION" | sed 's/^v//')"
  fi
}

try_download_vsix() {
  have curl || return 1
  _url=$(release_asset_url)
  info "trying $_url"
  if curl -fsSL -o "$WORKDIR/ainxt-vscode.vsix" -m 180 "$_url" 2>/dev/null; then
    VSIX="$WORKDIR/ainxt-vscode.vsix"; return 0
  fi
  return 1
}

check_node() {
  have node || return 1
  _v=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  [ -n "$_v" ] && [ "$_v" -ge "$MIN_NODE_MAJOR" ]
}

build_vsix() {
  check_node || die "building from source needs Node >= $MIN_NODE_MAJOR (found: $(node -v 2>/dev/null || echo none)).
Install it from https://nodejs.org/ and re-run. Node is not needed if you install
a published release instead of building."

  if [ -n "$SOURCE_DIR" ]; then
    [ -f "$SOURCE_DIR/vscode-acp/package.json" ] || die "--source-dir '$SOURCE_DIR' is not an ainxt-code checkout"
    SRC="$SOURCE_DIR"
    info "building from $SRC"
  elif [ -f "$SCRIPT_DIR/vscode-acp/package.json" ]; then
    SRC="$SCRIPT_DIR"
    info "building from the checkout this script lives in: $SRC"
  elif [ -d "$SCRIPT_DIR/.git" ] || [ -f "$SCRIPT_DIR/setup.sh" ]; then
    # We are inside the repository but vscode-acp/ is gone. It is the extension source,
    # not a fetched dependency, so no amount of downloading will replace it.
    die "vscode-acp/ is missing from $SCRIPT_DIR.
That directory is the VS Code extension itself -- the TypeScript and React that get
compiled into the shipped bundle -- not a dependency that can be downloaded. Restore it
with:  git checkout HEAD -- vscode-acp"
  else
    have git || die "no checkout found and git is not installed, so there is nothing to build from"
    info "cloning https://github.com/$REPO_SLUG"
    if ! git clone --depth 1 "https://github.com/$REPO_SLUG.git" "$WORKDIR/src" >/dev/null 2>&1; then
      die "could not clone https://github.com/$REPO_SLUG.git

No published release and no reachable source. If the repository is not public yet,
clone it however you normally do and re-run against it:

    ./install.sh --source-dir /path/to/ainxt-code"
    fi
    SRC="$WORKDIR/src"
  fi

  ( cd "$SRC" && [ -x ./setup.sh ] && ./setup.sh >"$WORKDIR/build.log" 2>&1 ) || {
    tail -25 "$WORKDIR/build.log" 2>/dev/null >&2
    die "build failed; full log at $WORKDIR/build.log"
  }
  VSIX=$(ls -t "$SRC"/vscode-acp/ainxt-vscode-*.vsix 2>/dev/null | head -1)
  [ -n "$VSIX" ] || die "build reported success but produced no .vsix"
}

install_vscode_ext() {
  step "Installing the VS Code extension"
  "$VSCODE_BIN" --install-extension "$VSIX" --force >"$WORKDIR/install.log" 2>&1 || {
    tail -15 "$WORKDIR/install.log" >&2; die "$VSCODE_NAME --install-extension failed"
  }
  EXT_INSTALLED=1
  ok "installed into $VSCODE_NAME ($(basename "$VSIX"))"
}

# Merge one key into the user's VS Code settings.json. That file belongs to them:
# merge, never overwrite, and if it will not parse (VS Code tolerates comments and
# trailing commas there; JSON.parse does not) leave it strictly alone and say so.
set_vscode_setting() {
  _key="$1"; _val="$2"
  SET_PATH=$(vscode_settings_path)
  [ -n "$SET_PATH" ] || return 1
  check_node || return 1
  mkdir -p "$(dirname "$SET_PATH")"
  [ -f "$SET_PATH" ] || printf '{}\n' > "$SET_PATH"
  cat > "$WORKDIR/merge-settings.js" <<'NODE'
const fs = require('fs');
const [file, key, value] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8').trim() || '{}';
let cfg;
try { cfg = JSON.parse(raw); } catch { process.exit(1); }
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { process.exit(1); }
cfg[key] = value;
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
NODE
  node "$WORKDIR/merge-settings.js" "$SET_PATH" "$_key" "$_val" 2>/dev/null
}

configure_vscode() {
  SET_PATH=$(vscode_settings_path)
  [ -n "$SET_PATH" ] || return 0

  if [ -n "$API_KEY" ]; then
    # Deliberately NOT written to disk: settings.json is plaintext and often
    # synced or committed. The extension reads AINXT_API_KEY from the environment
    # at highest priority, and keys entered via Connect go to the OS keychain.
    warn "API key not written to disk on purpose (settings.json is plaintext and often synced)"
    info "Either export it in your shell profile:  export AINXT_API_KEY=<key>"
    info "or paste it into the Connect form in the AiNxt panel (uses the OS keychain)."
  fi

  if [ "$GATEWAY_EXPLICIT" != 1 ]; then
    info "no --gateway given, so ainxt.gatewayUrl was left unset — the panel will"
    info "run the CLI standalone against whatever model you have configured"
    return 0
  fi

  if ! check_node; then
    warn "Node not available, so ainxt.gatewayUrl was not written automatically"
    info "Set it from the AiNxt panel's Connect button, or export"
    info "  AINXT_GATEWAY_URL=$GATEWAY_URL"
    return 0
  fi

  if set_vscode_setting 'ainxt.gatewayUrl' "$GATEWAY_URL"; then
    ok "set ainxt.gatewayUrl = $GATEWAY_URL in $(basename "$SET_PATH")"
  else
    warn "could not parse $SET_PATH, so it was left untouched"
    info "Add this line yourself, or use the Connect button in the AiNxt panel:"
    info "  \"ainxt.gatewayUrl\": \"$GATEWAY_URL\""
  fi
}

uninstall_vscode_ext() {
  step "Uninstalling"
  find_vscode || die "no VS Code installation found"
  "$VSCODE_BIN" --uninstall-extension ainxt.ainxt-vscode 2>&1 | tail -3 || true
  ok "removed ainxt.ainxt-vscode from $VSCODE_NAME"
  info "Settings in $(vscode_settings_path) were left in place."
}

# ─── The agent (ainxt CLI) ────────────────────────────────────────────────────
#
# This is the part that matters most, and the part a plugin installer is most
# tempted to skip. ainxt-code contains NO agent: the chat panel spawns the `ainxt`
# binary and speaks ACP to it over stdio. Install the extension and nothing else
# and you get a panel that cannot start a conversation.
#
# The agent has its own repository with its own installer, checksum handling and
# enterprise artifact-host support (AINXT_BASE_URL). We delegate to it rather than
# reimplementing any of that here — two installers disagreeing about where the
# binary goes is a worse failure than one extra network hop.

find_cli() {
  if [ -n "${AINXT_BINARY_PATH:-}" ] && [ -x "${AINXT_BINARY_PATH}" ]; then
    CLI_BIN="$AINXT_BINARY_PATH"; CLI_ON_PATH=0; return 0
  fi
  if have ainxt; then CLI_BIN=$(command -v ainxt); CLI_ON_PATH=1; return 0; fi
  for p in "$HOME/.local/bin/ainxt" "/usr/local/bin/ainxt" "$HOME/.ainxt/bin/ainxt" "$HOME/bin/ainxt"; do
    if [ -x "$p" ]; then CLI_BIN="$p"; CLI_ON_PATH=0; return 0; fi
  done
  CLI_BIN=""; CLI_ON_PATH=0; return 1
}

# Delegate to the agent repository's own one-line installer.
install_cli_from_release() {
  have curl || return 1
  _u="https://raw.githubusercontent.com/$CLI_REPO_SLUG/main/crates/codegen/ainxt-pager/scripts/install.sh"
  info "delegating to the agent's own installer: $_u"
  if ! curl -fsSL -m 60 -o "$WORKDIR/cli-install.sh" "$_u" 2>/dev/null; then
    info "agent installer not reachable (the repository may not be public yet)"
    return 1
  fi
  # Pass through the knobs that installer documents; do not invent new ones.
  _env=""
  [ "$CLI_VERSION" != latest ] && _env="AINXT_VERSION=$CLI_VERSION"
  [ -n "${AINXT_BASE_URL:-}" ] && _env="$_env AINXT_BASE_URL=$AINXT_BASE_URL"
  if [ -n "$_env" ]; then
    # shellcheck disable=SC2086
    env $_env sh "$WORKDIR/cli-install.sh" >"$WORKDIR/cli-install.log" 2>&1 || return 1
  else
    sh "$WORKDIR/cli-install.sh" >"$WORKDIR/cli-install.log" 2>&1 || return 1
  fi
  find_cli
}

# Make cargo available, installing rustup if we have to. Kept user-local: rustup
# goes to ~/.cargo, needs no sudo, and --no-modify-path means we do not edit the
# user's shell profile behind their back — cargo is only needed for this one build,
# so it is put on PATH for this run and mentioned rather than persisted.
# A working cargo answers --version. Being on PATH is not the same thing: a rustup
# shim with no toolchain installed, or a broken RUSTUP_HOME, is present and unusable.
cargo_works() {
  _cv=$(run_bounded 30 cargo --version | head -1 || true)
  case "$_cv" in cargo\ *) CARGO_VERSION="$_cv"; return 0 ;; *) return 1 ;; esac
}

ensure_cargo() {
  if have cargo && cargo_works; then ok "$CARGO_VERSION"; return 0; fi
  if have cargo; then
    warn "cargo is on PATH but does not run — treating the toolchain as missing"
  fi
  if [ -x "$HOME/.cargo/bin/cargo" ]; then
    PATH="$HOME/.cargo/bin:$PATH"; export PATH
    if cargo_works; then ok "using the Rust toolchain at ~/.cargo — $CARGO_VERSION"; return 0; fi
  fi
  if [ "$NO_RUST" = 1 ]; then
    bad "the Rust toolchain is needed to build the agent, and --no-rust was given"
    info "Install it yourself from https://rustup.rs/ and re-run."
    return 1
  fi
  have curl || { bad "cannot install the Rust toolchain: curl is not available"; return 1; }
  warn "the agent is written in Rust and no toolchain was found — installing rustup"
  info "into ~/.cargo (user-local, no sudo, your shell profile is left untouched)"
  if ! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
       | sh -s -- -y --no-modify-path --profile minimal >"$WORKDIR/rustup.log" 2>&1; then
    bad "rustup installation failed; see $WORKDIR/rustup.log"
    info "Install it manually from https://rustup.rs/ and re-run."
    return 1
  fi
  PATH="$HOME/.cargo/bin:$PATH"; export PATH
  cargo_works || { bad "rustup finished but cargo still does not run"; return 1; }
  ok "installed $CARGO_VERSION"
  info "cargo lives at ~/.cargo/bin — add it to your PATH if you want it in new shells"
  return 0
}

# Free space in GB for a given directory's filesystem.
free_gb() {
  df -Pk "$1" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}'
}

install_cli_from_source() {
  # No checkout given? Fetch one. Requiring the user to already have the agent's
  # source is the homework this installer exists to remove.
  if [ -z "$CLI_DIR" ]; then
    have git || { bad "git is needed to fetch the agent source, and it is not installed"; return 1; }
    if [ -d "$CLI_SRC_CACHE/.git" ]; then
      info "reusing the agent source already at $CLI_SRC_CACHE"
      ( cd "$CLI_SRC_CACHE" && git fetch --depth 1 origin >/dev/null 2>&1 \
        && git reset --hard origin/HEAD >/dev/null 2>&1 ) || \
        info "could not update it; building what is already there"
    else
      info "fetching the agent source into $CLI_SRC_CACHE"
      mkdir -p "$(dirname "$CLI_SRC_CACHE")"
      rm -rf "$CLI_SRC_CACHE"
      if ! git clone --depth 1 "$CLI_REPO_URL" "$CLI_SRC_CACHE" \
           >"$WORKDIR/cli-clone.log" 2>&1; then
        info "could not clone $CLI_REPO_URL"
        return 1
      fi
    fi
    CLI_DIR="$CLI_SRC_CACHE"
  fi
  [ -f "$CLI_DIR/Cargo.toml" ] || die "'$CLI_DIR' is not an ainxt-cli checkout (no Cargo.toml)"

  ensure_cargo || return 1

  # A 10 GB surprise is worse than a slow install, so say the cost up front.
  _free=$(free_gb "$CLI_DIR")
  warn "building the agent from source: roughly 80 crates, ~10 GB in $CLI_DIR/target/,"
  warn "and typically 10-30 minutes on a cold build. This happens once."
  if [ -n "$_free" ]; then
    if [ "$_free" -lt 3 ] 2>/dev/null; then
      bad "only ${_free} GB free on that filesystem — the build cannot succeed"
      info "Free some space, or move the build with AINXT_CLI_SRC=/path/with/room"
      return 1
    elif [ "$_free" -lt 12 ] 2>/dev/null; then
      warn "only ${_free} GB free; a cold build of the real agent wants ~10 GB."
      warn "Continuing — it may still fit. Move it with AINXT_CLI_SRC if it does not."
    else
      info "disk: ${_free} GB free"
    fi
  fi
  # The agent repo owns its build; use its own setup.sh so profiles stay in step.
  if [ -x "$CLI_DIR/setup.sh" ]; then
    ( cd "$CLI_DIR" && ./setup.sh --release ) || die "the agent's ./setup.sh failed"
    _built="$CLI_DIR/target/release-dist/ainxt"
  else
    ( cd "$CLI_DIR" && cargo build --profile release-dist -p ainxt-pager-bin --bin ainxt ) \
      || die "cargo build failed in $CLI_DIR"
    _built="$CLI_DIR/target/release-dist/ainxt"
  fi
  [ -x "$_built" ] || die "the agent build reported success but $_built is missing"

  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$_built" "$HOME/.local/bin/ainxt" 2>/dev/null \
    || { cp "$_built" "$HOME/.local/bin/ainxt" && chmod 0755 "$HOME/.local/bin/ainxt"; }
  ok "installed the agent to $HOME/.local/bin/ainxt"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "$HOME/.local/bin is not on your PATH; add it to your shell profile" ;;
  esac
  find_cli
}

# "Installed" is not "working". Complete a real ACP initialize over stdio — the
# exact handshake the extension performs — so a binary that is present but cannot
# speak the protocol is caught here rather than by a silent, empty chat panel.
verify_cli() {
  [ -n "$CLI_BIN" ] || return 1
  # install.ps1 deliberately omits this probe: bounding it portably there required
  # Start-Process output redirection, which captured nothing under pwsh on Linux and
  # could not be verified on Windows. Here `run_bounded` is verified, so the extra
  # information is worth keeping. Both scripts treat the handshake below as the
  # authoritative check, so the two agree on the verdict either way.
  _ver=$(run_bounded 15 "$CLI_BIN" --version | head -1 || true)
  if [ -n "$_ver" ]; then
    ok "agent responds to --version: $_ver"
  else
    warn "agent did not answer --version within 15s (not fatal; the handshake below is what counts)"
  fi

  if ! check_node; then
    warn "skipping the ACP handshake check (needs Node >= $MIN_NODE_MAJOR)"
    return 0
  fi

  cat > "$WORKDIR/acp-check.mjs" <<'ACPJS'
// Minimal ACP initialize, matching what ConnectionManager sends.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const bin = process.argv[2];
const child = spawn(bin, ['agent', '--no-leader', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env,
    AINXT_HOME: join(tmpdir(), 'ainxt-install-check-home'),
    AINXT_MAX_RETRIES: '1' },
});
let done = false;
const finish = (code, msg) => {
  if (done) return; done = true;
  if (msg) console.log(msg);
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(code), 200);
};
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', d => { stderr += d; });
child.on('error', () => finish(4, 'spawn failed'));
createInterface({ input: child.stdout }).on('line', line => {
  const t = line.trim(); if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  if (m.id !== 1) return;
  if (m.error) return finish(3, 'initialize returned an error: ' + JSON.stringify(m.error));
  const pv = m.result && m.result.protocolVersion;
  const name = (m.result && m.result._meta && m.result._meta.agentName) || 'agent';
  finish(0, 'protocolVersion=' + pv + ' agent=' + name);
});
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'ainxt-vscode', version: 'installer' } },
}) + '\n');
setTimeout(() => finish(2, 'no initialize response within 20s' +
  (stderr ? ' — agent stderr: ' + stderr.trim().split('\n').slice(-2).join(' | ') : '')), 20000);
ACPJS

  # acp-check.mjs self-limits to 20s; bound it again in case the agent wedges the
  # pipe in a way the internal timer cannot observe.
  _out=$(run_bounded 30 node "$WORKDIR/acp-check.mjs" "$CLI_BIN" || true)
  if printf '%s' "$_out" | grep -q 'protocolVersion=1'; then
    ok "ACP handshake succeeded — $_out"
    ok "the extension can talk to this agent"
    CLI_OK=1
  else
    bad "ACP handshake failed: ${_out:-no response}"
    info "The binary exists but did not complete the handshake the extension needs."
    info "Try it by hand:  $CLI_BIN agent --no-leader stdio"
    CLI_OK=0
  fi
}

check_credentials() {
  _home="${AINXT_HOME:-$HOME/.ainxt}"
  if [ -f "$_home/credentials.json" ]; then
    ok "credentials present at $_home/credentials.json"
    CREDS_OK=1
  else
    warn "not signed in — no $_home/credentials.json"
    info "Run:  $CLI_BIN login"
    info "Using a purely local model with no accounts? The agent still requires a"
    info "credential to be set; AINXT_API_KEY=local is the documented placeholder."
    CREDS_OK=0
  fi
}

ensure_cli() {
  step "Setting up the agent (the 'ainxt' CLI)"
  CLI_OK=0; CREDS_OK=0

  if find_cli; then
    ok "found the agent: $CLI_BIN"
  else
    warn "no 'ainxt' binary found — the chat panel cannot start a conversation without it"
    if install_cli_from_release; then
      ok "installed the agent from a release: $CLI_BIN"
    elif install_cli_from_source; then
      : # message already printed
    else
      bad "could not install the agent automatically"
      cat <<CLIHELP

  No published release was available to download, and the source route did not
  complete either (see the lines above for which step stopped it — fetching from
  $CLI_REPO_URL, the Rust toolchain, disk space, or the build itself).

  If you already have the source or the binary, this needs no network:

    ./install.sh --cli-dir /path/to/ainxt-cli    # build it here, automatically
    AINXT_BINARY_PATH=/path/to/ainxt ./install.sh  # use a binary you already built

  Behind a private artifact host? The agent's own installer honours AINXT_BASE_URL:

    AINXT_BASE_URL=https://artifacts.example.com ./install.sh
CLIHELP
      return 0
    fi
  fi

  verify_cli
  check_credentials

  # If the agent is not on PATH, the extension needs to be told where it is.
  if [ -n "$CLI_BIN" ] && [ "$CLI_ON_PATH" = 0 ]; then
    set_vscode_setting 'ainxt.binaryPath' "$CLI_BIN" \
      && ok "set ainxt.binaryPath = $CLI_BIN (the agent is not on your PATH)"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd || printf '.')
WORKDIR=$(mktemp -d 2>/dev/null || mktemp -d -t ainxt)
cleanup() { [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT INT TERM

detect_platform
GATEWAY_OK=0

printf '%sAiNxt Code%s — installer  (%s/%s)\n' "$B" "$Z" "$PLATFORM" "$ARCH"

if [ "$MODE" = uninstall ]; then uninstall_vscode_ext; exit 0; fi
if [ "$MODE" = verify ]; then
  # Check both halves: a reachable gateway with no working agent is still unusable.
  CLI_OK=0; CREDS_OK=0
  if [ "$SKIP_CLI" != 1 ]; then
    step "Checking the agent (the 'ainxt' CLI)"
    if find_cli; then
      ok "found the agent: $CLI_BIN"
      verify_cli
      check_credentials
    else
      bad "no 'ainxt' binary found — the chat panel cannot start a conversation"
      info "Install it with:  ./install.sh --cli-dir /path/to/ainxt-cli"
    fi
  fi
  verify_gateway
  printf '\n'
  # --verify checks the environment, not the install, so the extension is out of scope.
  # The gateway is only required when explicitly configured; standalone use only
  # needs a working agent with credentials for its own configured model.
  if [ -n "${CLI_BIN:-}" ] && [ "${CLI_OK:-0}" = 1 ] && [ "${CREDS_OK:-0}" = 1 ] \
     && { [ "$GATEWAY_EXPLICIT" != 1 ] || [ "${GATEWAY_OK:-0}" = 1 ]; }; then
    printf '  %sAgent is ready.%s\n' "$G" "$Z"; exit 0
  fi
  printf '  %sNot ready.%s See the lines above.\n' "$Y" "$Z"; exit 1
fi

step "Checking what is available"
if find_vscode; then ok "VS Code CLI: $VSCODE_BIN"; else warn "no VS Code installation found"; fi
if find_jetbrains; then ok "JetBrains config present (plugin install is manual — see below)"; else info "no JetBrains IDE detected"; fi
check_node && ok "node $(node -v)" || info "node missing or < $MIN_NODE_MAJOR (only needed to build from source)"
have curl && ok "curl $(curl --version 2>/dev/null | head -1 | cut -d' ' -f2)" || warn "curl not found"

if [ "$TARGET_IDE" = none ]; then
  step "Skipping IDE installation (--ide none)"
else
  if [ -z "$VSCODE_BIN" ] && [ "$TARGET_IDE" != jetbrains ]; then
    warn "VS Code not found — will build the .vsix but cannot install it."
    info "Install VS Code from https://code.visualstudio.com/ then re-run,"
    info "or install the built file via Extensions panel -> ... -> 'Install from VSIX...'."
  fi

  step "Obtaining the extension"
  if [ "$FROM_SOURCE" = 1 ]; then
    info "--from-source given; skipping the release check"
    build_vsix
  elif try_download_vsix; then
    ok "downloaded a published release"
  else
    warn "no published release found for '$VERSION' — falling back to a source build"
    build_vsix
  fi
  ok "extension package: $(basename "$VSIX") ($(du -h "$VSIX" 2>/dev/null | cut -f1))"

  if [ -n "$VSCODE_BIN" ] && [ "$TARGET_IDE" != jetbrains ]; then
    install_vscode_ext
    step "Configuring"
    configure_vscode
  fi
fi

if [ "$SKIP_CLI" = 1 ]; then
  step "Skipping the agent (--skip-cli)"
  CLI_BIN=""; CLI_OK=0; CREDS_OK=0
else
  ensure_cli
fi

[ "$NO_VERIFY" = 1 ] || verify_gateway

# ─── Summary ──────────────────────────────────────────────────────────────────
#
# Report state, not generic advice. The user should be able to read three lines
# and know whether they can start typing.

step "Where you stand"

_pad() { printf '  %-34s %s\n' "$1" "$2"; }

if [ -n "${VSIX:-}" ] && [ -n "$VSCODE_BIN" ]; then
  _pad "Extension" "installed"
elif [ -n "${VSIX:-}" ]; then
  _pad "Extension" "built but not installed (no VS Code found)"
else
  _pad "Extension" "skipped"
fi

if [ "$SKIP_CLI" = 1 ]; then
  _pad "Agent (ainxt CLI)" "skipped (--skip-cli)"
elif [ -z "${CLI_BIN:-}" ]; then
  _pad "Agent (ainxt CLI)" "MISSING — nothing will answer you"
elif [ "${CLI_OK:-0}" = 1 ]; then
  _pad "Agent (ainxt CLI)" "working — ACP handshake verified"
else
  _pad "Agent (ainxt CLI)" "present but the ACP handshake failed"
fi

if [ "${CREDS_OK:-0}" = 1 ]; then
  _pad "Sign-in" "credentials present"
elif [ -n "${CLI_BIN:-}" ]; then
  _pad "Sign-in" "not signed in — run: $CLI_BIN login"
else
  _pad "Sign-in" "unknown (no agent)"
fi

if [ "$GATEWAY_EXPLICIT" != 1 ]; then
  _pad "Gateway" "not configured — running standalone (this is fine)"
elif [ "${GATEWAY_OK:-0}" = 1 ]; then
  _pad "Gateway" "reachable at $GATEWAY_URL"
else
  _pad "Gateway" "NOT reachable at $GATEWAY_URL"
fi

# The gateway only gates readiness when it was explicitly requested; standalone
# use only needs a working, signed-in (or otherwise credentialed) agent.
GATEWAY_REQUIREMENT_MET=1
[ "$GATEWAY_EXPLICIT" = 1 ] && [ "${GATEWAY_OK:-0}" != 1 ] && GATEWAY_REQUIREMENT_MET=0

printf '\n'
if [ "${EXT_INSTALLED:-0}" = 1 ] && [ -n "${CLI_BIN:-}" ] && [ "${CLI_OK:-0}" = 1 ] \
   && [ "$GATEWAY_REQUIREMENT_MET" = 1 ] && [ "${CREDS_OK:-0}" = 1 ]; then
  printf '  %sReady.%s Open the AiNxt panel in VS Code (Activity Bar, or %sCmd/Ctrl+Shift+A%s) and type.\n' "$G" "$Z" "$B" "$Z"
else
  printf '  %sNot ready yet.%s Outstanding:\n' "$Y" "$Z"
  if [ "${EXT_INSTALLED:-0}" != 1 ] && [ "$TARGET_IDE" != none ]; then
    if [ -n "${VSIX:-}" ]; then
      info "- The extension was built but not installed. Install VS Code, then re-run;"
      info "  or use Extensions panel -> ... -> 'Install from VSIX...' -> $VSIX"
    else
      info "- The extension was not installed (--ide none, or no build was attempted)"
    fi
  fi
  [ -z "${CLI_BIN:-}" ] && [ "$SKIP_CLI" != 1 ] && \
    info "- The agent could not be fetched. If ainxt-cli is not public yet, use"
    info "  ./install.sh --cli-dir /path/to/ainxt-cli  or  AINXT_BINARY_PATH=/path/to/ainxt"
  [ -n "${CLI_BIN:-}" ] && [ "${CLI_OK:-0}" != 1 ] && \
    info "- The agent does not complete an ACP handshake; try: $CLI_BIN agent --no-leader stdio"
  [ "${CREDS_OK:-0}" != 1 ] && [ -n "${CLI_BIN:-}" ] && \
    info "- No credential yet: run '$CLI_BIN login', set AINXT_API_KEY, or add a"
    info "  [model.*] entry with its own api_key/env_key to ~/.ainxt/config.toml"
  [ "$GATEWAY_REQUIREMENT_MET" != 1 ] && \
    info "- Start the AiNxt Platform (the gateway), then: ./install.sh --verify --gateway $GATEWAY_URL"
  printf '\n'
  if [ "$GATEWAY_EXPLICIT" != 1 ]; then
    info "No gateway is configured, which is the standalone default — the CLI"
    info "answers directly from whatever model you set up, no AiNxt Platform needed."
  else
    info "The Platform is a separate, optional repository (ainxt-enterprise). It needs"
    info "PostgreSQL, Redis and one model provider; nothing in this suite bundles a model."
  fi
fi

cat <<NEXT

  ${B}A note on waiting.${Z} The agent retries a failing gateway up to 15 times by
  default and prints nothing while it does — around 340 seconds of apparent hang.
  This installer sets a smaller budget for interactive use; if you drive the agent
  from a terminal or CI, set ${B}AINXT_MAX_RETRIES=2${Z} yourself and add a timeout.

  JetBrains (installed from disk, by design — see hosts/intellij/README.md):
    (cd vscode-acp/webview-ui && npm ci && npm run build)
    (cd hosts/intellij && ./gradlew buildPlugin)
    Settings -> Plugins -> gear -> Install Plugin from Disk...
      hosts/intellij/build/distributions/ainxt-intellij-*.zip

  Re-check everything:   ./install.sh --verify
  Remove the extension:  ./install.sh --uninstall
NEXT
