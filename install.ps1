# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 AiNxt
#
# AiNxt Code - one-command installer for Windows.
#
#   irm https://raw.githubusercontent.com/npci/ainxt-code/main/install.ps1 | iex
#
# With options, download first (a piped script cannot take arguments):
#
#   irm https://raw.githubusercontent.com/npci/ainxt-code/main/install.ps1 -OutFile install.ps1
#   .\install.ps1 -Gateway https://gw.example.com:8000
#
# macOS / Linux: use install.sh instead. There is no single command that covers all
# three platforms - `curl | sh` needs a POSIX shell, which Windows does not provide.
#
# What it does: detect the IDE -> obtain the extension (published release if one
# exists, else build from source) -> install it -> install the ainxt CLI agent ->
# (only if -Gateway was given) configure and verify the AiNxt Platform gateway ->
# print what to do next.
#
# The AiNxt Platform gateway is optional. Without -Gateway, the CLI runs
# standalone against a directly-configured model (~\.ainxt\config.toml,
# AINXT_API_KEY, or `ainxt login` against your own provider) - this installer
# never assumes a gateway is required.
#
# Requires PowerShell 5.1+ (ships with Windows 10/11).

[CmdletBinding()]
param(
  [string]$Gateway   = $env:AINXT_GATEWAY_URL,
  [string]$ApiKey    = $env:AINXT_API_KEY,
  [string]$Version   = $env:AINXT_VERSION,
  [string]$Ide       = $env:AINXT_IDE,
  [string]$SourceDir = $env:AINXT_SOURCE_DIR,
  [string]$CliDir    = $env:AINXT_CLI_DIR,
  [string]$CliVersion= $env:AINXT_CLI_VERSION,
  [switch]$SkipCli,
  [switch]$NoRust,
  [string]$RepoSlug  = $env:AINXT_REPO_SLUG,
  [switch]$FromSource,
  [switch]$Verify,
  [switch]$Uninstall,
  [switch]$NoVerify,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# No default gateway: the ainxt CLI runs standalone against a directly-configured
# model unless you explicitly opt into the AiNxt Platform with -Gateway /
# AINXT_GATEWAY_URL.
$script:GatewayExplicit = [bool]$Gateway
if (-not $Version)  { $Version  = 'latest' }
if (-not $Ide)      { $Ide      = 'auto' }
if (-not $RepoSlug) { $RepoSlug = 'npci/ainxt-code' }
if (-not $CliVersion) { $CliVersion = 'latest' }
$CliRepoSlug = if ($env:AINXT_CLI_REPO_SLUG) { $env:AINXT_CLI_REPO_SLUG } else { 'npci/ainxt-cli' }
$CliRepoUrl  = if ($env:AINXT_CLI_REPO_URL) { $env:AINXT_CLI_REPO_URL } else { "https://github.com/$CliRepoSlug.git" }
$Gateway = if ($Gateway) { $Gateway.TrimEnd('/') } else { '' }
$MinNodeMajor = 22

# TLS 1.2 is not the default on stock PowerShell 5.1, and github.com refuses less.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Write-Step($m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  ok   $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  warn $m" -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host "  FAIL $m" -ForegroundColor Red }
function Write-Info($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Die($m) { Write-Host ''; Write-Host "error: $m" -ForegroundColor Red; exit 1 }

if ($Help) {
  Write-Host @"
AiNxt Code installer (Windows)

  irm https://raw.githubusercontent.com/$RepoSlug/main/install.ps1 | iex

Parameters
  -Gateway <url>     AiNxt Platform gateway URL - optional; only needed for a
                     shared/governed deployment. Omit it to run the CLI
                     standalone against a directly-configured model.
                     (default: none)
  -ApiKey <key>      API key; else 'ainxt login' supplies credentials
  -Ide <which>       auto | vscode | jetbrains | none   (default auto)
  -Version <v>       Release to install, or 'latest'
  -FromSource        Build from source even if a release exists
  -SourceDir <dir>   Use an existing checkout instead of cloning
  -CliDir <dir>      Build the 'ainxt' agent from this ainxt-cli checkout
  -CliVersion <v>    Agent release to install, or 'latest'
  -SkipCli           Do not touch the 'ainxt' agent
  -NoRust            Never install the Rust toolchain automatically
  -Verify            Only check gateway connectivity; install nothing
  -Uninstall         Remove the VS Code extension
  -NoVerify          Skip the endpoint check

Environment
  AINXT_GATEWAY_URL  AINXT_API_KEY  AINXT_VERSION  AINXT_IDE
  AINXT_SOURCE_DIR   AINXT_REPO_SLUG
  AINXT_CLI_DIR      AINXT_CLI_VERSION  AINXT_CLI_REPO_SLUG  AINXT_CLI_REPO_URL
  AINXT_CLI_SRC      Where the agent source is cached (default ~\.ainxt\src\ainxt-cli)
  AINXT_BASE_URL     Enterprise artifact host, passed through to the agent installer
  AINXT_BINARY_PATH  Use an 'ainxt' binary already on disk
"@
  exit 0
}

# --- Discovery ---------------------------------------------------------------

function Find-VSCode {
  foreach ($c in @('code','code-insiders','codium','cursor')) {
    $cmd = Get-Command "$c.cmd" -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command $c -ErrorAction SilentlyContinue }
    if ($cmd) { return @{ Bin = $cmd.Source; Name = $c } }
  }
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
    "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd",
    "$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd",
    "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return @{ Bin = $p; Name = [IO.Path]::GetFileNameWithoutExtension($p) } }
  }
  return $null
}

function Test-Node {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $false }
  try {
    $v = (& node -v) -replace '^v',''
    return ([int]($v.Split('.')[0]) -ge $MinNodeMajor)
  } catch { return $false }
}

function Get-UserHome {
  foreach ($c in @($env:USERPROFILE, $env:HOME)) { if ($c) { return $c } }
  return [Environment]::GetFolderPath('UserProfile')
}

function Get-VSCodeSettingsPath {
  # APPDATA is the correct location on Windows; the fallback keeps the script from
  # aborting on a profile where it is unset rather than silently writing nowhere.
  $base = if ($env:APPDATA) { Join-Path $env:APPDATA 'Code\User' }
          else { Join-Path (Get-UserHome) '.config/Code/User' }
  return (Join-Path $base 'settings.json')
}

# --- Gateway verification ----------------------------------------------------

function Get-HttpCode {
  param([string]$Url, [hashtable]$Headers)
  try {
    $p = @{ Uri = $Url; Method = 'GET'; TimeoutSec = 15; UseBasicParsing = $true }
    if ($Headers -and $Headers.Count -gt 0) { $p.Headers = $Headers }
    $r = Invoke-WebRequest @p
    return [int]$r.StatusCode
  } catch {
    # A 4xx/5xx is an exception here, so recover the real status before giving up.
    $resp = $null
    try { $resp = $_.Exception.Response } catch {}
    if ($resp) {
      try { return [int]$resp.StatusCode } catch {}
      try { return [int]$resp.StatusCode.value__ } catch {}
    }
    return 0
  }
}

function Test-Gateway {
  $script:GatewayOk = $false
  $script:ExtInstalled = $false

  if (-not $script:GatewayExplicit) {
    Write-Step 'Gateway'
    Write-Info 'no -Gateway given - running standalone. The ainxt CLI talks directly to'
    Write-Info 'whatever model you configure (~\.ainxt\config.toml, AINXT_API_KEY, or'
    Write-Info "'ainxt login' against your own provider). Pass -Gateway <url> only if"
    Write-Info 'your team runs the AiNxt Platform (a separate, optional service).'
    return
  }

  Write-Step "Verifying the gateway at $Gateway"

  $headers = @{}
  if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }

  $root = Get-HttpCode -Url "$Gateway/"
  if ($root -eq 0) {
    Write-Bad "cannot reach $Gateway - nothing is listening, or DNS/firewall is blocking"
    Write-Info "The AiNxt Platform binds 0.0.0.0:8000 by default. Start it first (see the"
    Write-Info "ainxt-enterprise repository), or pass -Gateway with the correct URL."
    Write-Info "Note: the Platform's .env.example says 9001, but gunicorn.conf.py never"
    Write-Info "reads .env, so 8000 is what you actually get unless you export BIND."
    return
  }
  Write-Ok "gateway responds (HTTP $root at /)"

  # /complete is expected to be absent on a stock Platform: it backs only the
  # opt-in autocomplete, so a 404 there is informational, not a failure.
  $probes = @(
    @{ Path = '/ainxt/v1/api/auth/me';   Label = 'GET  /ainxt/v1/api/auth/me  '; MayBeMissing = $false },
    @{ Path = '/ainxt/v1/api/budget/me'; Label = 'GET  /ainxt/v1/api/budget/me'; MayBeMissing = $false },
    @{ Path = '/ainxt/v1/api/complete';  Label = 'POST /ainxt/v1/api/complete '; MayBeMissing = $true  }
  )
  foreach ($p in $probes) {
    $code = Get-HttpCode -Url ($Gateway + $p.Path) -Headers $headers
    switch ($code) {
      200 { Write-Ok "$($p.Label) -> 200" }
      0   { Write-Bad "$($p.Label) -> no response" }
      default {
        if ($code -eq 401 -or $code -eq 403) {
          if ($ApiKey) { Write-Bad "$($p.Label) -> $code (the API key was rejected)" }
          elseif ($script:CredsOk) {
            # The extension authenticates with the token `ainxt login` wrote. This
            # check deliberately does not read that file, so an unauthenticated probe
            # returning 401 is the correct result, not a problem.
            Write-Info "$($p.Label) -> $code (expected: this check is unauthenticated; the extension uses your ainxt login token)"
          }
          else { Write-Warn2 "$($p.Label) -> $code (needs credentials: run 'ainxt login', or pass -ApiKey)" }
        } elseif ($code -eq 404) {
          if ($p.MayBeMissing) { Write-Info "$($p.Label) -> 404 (expected; only the opt-in autocomplete uses it)" }
          else { Write-Bad "$($p.Label) -> 404 (route absent - is this really an AiNxt Platform?)" }
        } else { Write-Warn2 "$($p.Label) -> $code" }
      }
    }
  }
  $script:GatewayOk = $true
}

# --- Acquire the extension ---------------------------------------------------

function Get-ReleaseUrl {
  if ($Version -eq 'latest') { return "https://github.com/$RepoSlug/releases/latest/download/ainxt-vscode.vsix" }
  $v = $Version -replace '^v',''
  return "https://github.com/$RepoSlug/releases/download/$Version/ainxt-vscode-$v.vsix"
}

function Try-DownloadVsix {
  $url = Get-ReleaseUrl
  Write-Info "trying $url"
  $out = Join-Path $script:WorkDir 'ainxt-vscode.vsix'
  try {
    Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 180 -UseBasicParsing
    if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0)) { return $out }
  } catch {}
  return $null
}

function Build-Vsix {
  if (-not (Test-Node)) {
    Die "building from source needs Node >= $MinNodeMajor. Install it from https://nodejs.org/ and re-run.
Node is not needed if you install a published release instead of building."
  }
  if ($SourceDir) {
    if (-not (Test-Path (Join-Path $SourceDir 'vscode-acp\package.json'))) { Die "-SourceDir '$SourceDir' is not an ainxt-code checkout" }
    $src = $SourceDir
  } elseif (Test-Path (Join-Path $script:ScriptDir 'vscode-acp\package.json')) {
    $src = $script:ScriptDir
    Write-Info "building from the checkout this script lives in: $src"
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "no checkout found and git is not installed, so there is nothing to build from" }
    $src = Join-Path $script:WorkDir 'src'
    Write-Info "cloning https://github.com/$RepoSlug"
    & git clone --depth 1 "https://github.com/$RepoSlug.git" $src 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Die "could not clone https://github.com/$RepoSlug.git

No published release and no reachable source. If the repository is not public yet,
clone it however you normally do and re-run against it:

    .\install.ps1 -SourceDir C:\path\to\ainxt-code"
    }
  }

  # setup.sh is POSIX; on Windows drive the documented npm steps directly.
  Push-Location (Join-Path $src 'vscode-acp')
  try {
    & npm ci --no-fund --no-audit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { & npm install --no-fund --no-audit 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) { Die "npm install failed in $src\vscode-acp" }
    & npm run package:vsix 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "npm run package:vsix failed in $src\vscode-acp" }
  } finally { Pop-Location }

  $vsix = Get-ChildItem (Join-Path $src 'vscode-acp') -Filter 'ainxt-vscode-*.vsix' |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $vsix) { Die "build reported success but produced no .vsix" }
  return $vsix.FullName
}

# Merge one key into the user's settings.json. That file belongs to them: merge,
# never overwrite, and if it will not parse (VS Code tolerates comments there;
# ConvertFrom-Json does not) leave it strictly alone and report it.
function Set-VSCodeSetting {
  param([string]$Key, [string]$Value)
  $path = Get-VSCodeSettingsPath
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  if (-not (Test-Path $path)) { '{}' | Set-Content -Path $path -Encoding UTF8 }
  try {
    $raw = (Get-Content $path -Raw).Trim()
    if (-not $raw) { $raw = '{}' }
    $cfg = $raw | ConvertFrom-Json -ErrorAction Stop
    $obj = @{}
    foreach ($p in $cfg.PSObject.Properties) { $obj[$p.Name] = $p.Value }
    $obj[$Key] = $Value
    ($obj | ConvertTo-Json -Depth 64) | Set-Content -Path $path -Encoding UTF8
    return $true
  } catch {
    Write-Warn2 "could not parse $path, so it was left untouched"
    Write-Info  "Add this yourself, or use the Connect button in the AiNxt panel:"
    Write-Info  "  `"$Key`": `"$Value`""
    return $false
  }
}

function Set-GatewaySetting {
  if ($ApiKey) {
    # Deliberately not written to disk: settings.json is plaintext and often synced.
    Write-Warn2 'API key not written to disk on purpose (settings.json is plaintext and often synced)'
    Write-Info  'Either set it for your user:  setx AINXT_API_KEY <key>'
    Write-Info  'or paste it into the Connect form in the AiNxt panel (uses the OS credential store).'
  }
  if (-not $script:GatewayExplicit) {
    Write-Info 'no -Gateway given, so ainxt.gatewayUrl was left unset - the panel will'
    Write-Info 'run the CLI standalone against whatever model you have configured'
    return
  }
  if (Set-VSCodeSetting -Key 'ainxt.gatewayUrl' -Value $Gateway) {
    Write-Ok "set ainxt.gatewayUrl = $Gateway in settings.json"
  }
}

# --- The agent (ainxt CLI) ---------------------------------------------------
#
# ainxt-code contains NO agent. The chat panel spawns the `ainxt` binary and speaks
# ACP to it over stdio, so installing only the extension yields a panel that cannot
# start a conversation. The agent has its own repository with its own installer,
# checksum handling and enterprise artifact-host support; delegate to it rather than
# reimplementing any of that here.

function Find-Cli {
  if ($env:AINXT_BINARY_PATH -and (Test-Path $env:AINXT_BINARY_PATH)) {
    return @{ Bin = $env:AINXT_BINARY_PATH; OnPath = $false }
  }
  $c = Get-Command ainxt -ErrorAction SilentlyContinue
  if ($c) { return @{ Bin = $c.Source; OnPath = $true } }
  $candidates = @(
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'ainxt\bin\ainxt.exe' }),
    (Join-Path (Get-UserHome) '.local/bin/ainxt.exe'),
    (Join-Path (Get-UserHome) '.local/bin/ainxt'),
    (Join-Path (Get-UserHome) '.ainxt/bin/ainxt.exe'),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'ainxt\ainxt.exe' })
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return @{ Bin = $p; OnPath = $false } } }
  return $null
}

function Install-CliFromRelease {
  $u = "https://raw.githubusercontent.com/$CliRepoSlug/main/crates/codegen/ainxt-pager/scripts/install.ps1"
  Write-Info "delegating to the agent's own installer: $u"
  $dst = Join-Path $script:WorkDir 'cli-install.ps1'
  try { Invoke-WebRequest -Uri $u -OutFile $dst -TimeoutSec 60 -UseBasicParsing }
  catch { Write-Info 'agent installer not reachable (the repository may not be public yet)'; return $null }
  # Pass through only the knobs that installer documents.
  if ($CliVersion -ne 'latest') { $env:AINXT_VERSION = $CliVersion }
  try { & pwsh -NoLogo -File $dst 2>&1 | Out-Null } catch {
    try { & powershell -NoLogo -File $dst 2>&1 | Out-Null } catch { return $null }
  }
  return (Find-Cli)
}

# A working cargo answers --version. Being on PATH is not the same thing: a rustup
# shim with no toolchain installed is present and unusable.
function Test-CargoWorks {
  try {
    $v = & cargo --version 2>$null
    if ("$v" -match '^cargo\s') { $script:CargoVersion = "$v".Trim(); return $true }
  } catch {}
  return $false
}

# Make cargo available, installing rustup if we have to. Kept user-local: it goes to
# %USERPROFILE%\.cargo, needs no admin, and --no-modify-path means the user's PATH is
# not edited behind their back. cargo is needed for this one build only.
function Initialize-Cargo {
  if ((Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-CargoWorks)) {
    Write-Ok $script:CargoVersion; return $true
  }
  if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Warn2 'cargo is on PATH but does not run - treating the toolchain as missing'
  }
  $cargoBin = Join-Path (Get-UserHome) '.cargo\bin'
  if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
    $env:PATH = "$cargoBin;$env:PATH"
    if (Test-CargoWorks) { Write-Ok "using the Rust toolchain at ~\.cargo - $($script:CargoVersion)"; return $true }
  }
  if ($NoRust) {
    Write-Bad 'the Rust toolchain is needed to build the agent, and -NoRust was given'
    Write-Info 'Install it yourself from https://rustup.rs/ and re-run.'
    return $false
  }
  Write-Warn2 'the agent is written in Rust and no toolchain was found - installing rustup'
  Write-Info  'into %USERPROFILE%\.cargo (user-local, no admin, your PATH is left untouched)'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { 'aarch64' } else { 'x86_64' }
  $init = Join-Path $script:WorkDir 'rustup-init.exe'
  try {
    Invoke-WebRequest -Uri "https://win.rustup.rs/$arch" -OutFile $init -TimeoutSec 300 -UseBasicParsing
  } catch {
    Write-Bad "could not download rustup-init: $($_.Exception.Message)"
    Write-Info 'Install it manually from https://rustup.rs/ and re-run.'
    return $false
  }
  # Start-Process, not `& $init | Out-Null`: piping a downloaded executable is not
  # a valid pipeline element, and this also gives a real exit code to check.
  try {
    $proc = Start-Process -FilePath $init -ArgumentList '-y','--no-modify-path','--profile','minimal' `
              -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) { Write-Bad "rustup-init exited $($proc.ExitCode)"; return $false }
  } catch {
    Write-Bad "could not run rustup-init: $($_.Exception.Message)"
    Write-Info 'Install the Rust toolchain manually from https://rustup.rs/ and re-run.'
    return $false
  }
  $env:PATH = "$cargoBin;$env:PATH"
  if (-not (Test-CargoWorks)) { Write-Bad 'rustup finished but cargo still does not run'; return $false }
  Write-Ok "installed $($script:CargoVersion)"
  Write-Info 'cargo lives at %USERPROFILE%\.cargo\bin - add it to your PATH for new shells'
  return $true
}

function Install-CliFromSource {
  # No checkout given? Fetch one. Requiring the user to already have the agent's
  # source is the homework this installer exists to remove.
  $dir = $CliDir
  if (-not $dir) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      Write-Bad 'git is needed to fetch the agent source, and it is not installed'
      return $null
    }
    $cache = if ($env:AINXT_CLI_SRC) { $env:AINXT_CLI_SRC } else { Join-Path (Get-UserHome) '.ainxt\src\ainxt-cli' }
    if (Test-Path (Join-Path $cache '.git')) {
      Write-Info "reusing the agent source already at $cache"
      Push-Location $cache
      try { & git fetch --depth 1 origin 2>&1 | Out-Null; & git reset --hard origin/HEAD 2>&1 | Out-Null }
      catch { Write-Info 'could not update it; building what is already there' }
      finally { Pop-Location }
    } else {
      Write-Info "fetching the agent source into $cache"
      New-Item -ItemType Directory -Force -Path (Split-Path $cache) | Out-Null
      if (Test-Path $cache) { Remove-Item -Recurse -Force $cache -ErrorAction SilentlyContinue }
      & git clone --depth 1 $CliRepoUrl $cache 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Info "could not clone $CliRepoUrl"; return $null }
    }
    $dir = $cache
  }
  if (-not (Test-Path (Join-Path $dir 'Cargo.toml'))) { Die "'$dir' is not an ainxt-cli checkout (no Cargo.toml)" }

  if (-not (Initialize-Cargo)) { return $null }

  # A 10 GB surprise is worse than a slow install, so state the cost up front.
  Write-Warn2 "building the agent from source: roughly 80 crates, ~10 GB in $dir\target\,"
  Write-Warn2 'and typically 10-30 minutes on a cold build. This happens once.'
  try {
    $drive = (Get-Item $dir).PSDrive
    if ($drive -and $drive.Free) {
      $freeGb = [math]::Floor($drive.Free / 1GB)
      if ($freeGb -lt 3) {
        Write-Bad "only $freeGb GB free on that drive - the build cannot succeed"
        Write-Info 'Free some space, or move the build with AINXT_CLI_SRC=D:\path\with\room'
        return $null
      } elseif ($freeGb -lt 12) {
        Write-Warn2 "only $freeGb GB free; a cold build wants ~10 GB. Continuing - it may still fit."
      } else { Write-Info "disk: $freeGb GB free" }
    }
  } catch {}

  Push-Location $dir
  try {
    & cargo build --profile release-dist -p ainxt-pager-bin --bin ainxt
    if ($LASTEXITCODE -ne 0) { Die "cargo build failed in $dir" }
  } finally { Pop-Location }

  $built = Join-Path $dir 'target\release-dist\ainxt.exe'
  if (-not (Test-Path $built)) { $built = Join-Path $dir 'target\release-dist\ainxt' }
  if (-not (Test-Path $built)) { Die "the agent build reported success but no binary is under $dir\target\release-dist\" }

  # Guard before joining: Join-Path throws on a null path, so the fallback has to be
  # chosen first rather than assigned afterwards.
  $destDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'ainxt\bin' }
             else { Join-Path (Get-UserHome) '.local/bin' }
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $dest = Join-Path $destDir ([IO.Path]::GetFileName($built))
  Copy-Item $built $dest -Force
  Write-Ok "installed the agent to $dest"
  Write-Info "Add $destDir to your PATH to run 'ainxt' from a terminal."
  return @{ Bin = $dest; OnPath = $false }
}

# "Installed" is not "working". Complete a real ACP initialize over stdio - the
# same handshake the extension performs - so a binary that is present but cannot
# speak the protocol is caught here, not by a silent, empty chat panel.
function Test-Cli {
  param([string]$Bin)
  $script:CliOk = $false

  # No separate --version probe. It added nothing the handshake does not report, and
  # bounding it portably meant Start-Process output redirection, which captured
  # nothing at all under Linux pwsh (even for `echo`) and could not be verified on
  # Windows from this host. The handshake below enforces its own 20s deadline inside
  # Node and is the authoritative check, so it is the only one made.
  if (-not (Test-Node)) {
    Write-Warn2 "skipping the ACP handshake check (needs Node >= $MinNodeMajor)"
    return
  }

  $js = Join-Path $script:WorkDir 'acp-check.mjs'
  @'
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const bin = process.argv[2];
const child = spawn(bin, ['agent', '--no-leader', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AINXT_HOME: join(tmpdir(), 'ainxt-install-check-home'), AINXT_MAX_RETRIES: '1' },
});
let done = false;
const finish = (code, msg) => {
  if (done) return; done = true;
  if (msg) console.log(msg);
  try { child.stdin.end(); } catch {}
  try { child.kill(); } catch {}
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
const req = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'ainxt-vscode', version: 'installer' } } };
child.stdin.write(JSON.stringify(req) + String.fromCharCode(10));
setTimeout(() => {
  const tail = stderr.trim() ? ' - agent stderr: ' + stderr.trim().split(String.fromCharCode(10)).slice(-2).join(' | ') : '';
  finish(2, 'no initialize response within 20s' + tail);
}, 20000);
'@ | Set-Content -Path $js -Encoding UTF8

  # Run node directly. acp-check.mjs enforces its own 20s deadline and calls
  # process.exit, so there is no hang to guard against. Start-Job would place it in
  # a runspace that cannot resolve `node`, and Start-Process redirection dropped the
  # output entirely — both were tried and both failed.
  $out = ''
  try {
    $raw = & node $js $Bin 2>&1
    $out = (@($raw) | Where-Object { "$_".Trim() } | ForEach-Object { "$_".Trim() }) -join ' '
  } catch { $out = '' }

  if ($out -match 'protocolVersion=1') {
    Write-Ok "ACP handshake succeeded - $out"
    Write-Ok 'the extension can talk to this agent'
    $script:CliOk = $true
  } else {
    if (-not $out) { $out = 'no response' }
    Write-Bad "ACP handshake failed: $out"
    Write-Info 'The binary exists but did not complete the handshake the extension needs.'
    Write-Info "Try it by hand:  $Bin agent --no-leader stdio"
  }
}

function Test-Credentials {
  param([string]$Bin)
  $home2 = if ($env:AINXT_HOME) { $env:AINXT_HOME } else { Join-Path (Get-UserHome) '.ainxt' }
  if (Test-Path (Join-Path $home2 'credentials.json')) {
    Write-Ok "credentials present at $home2\credentials.json"
    $script:CredsOk = $true
  } else {
    Write-Warn2 "not signed in - no $home2\credentials.json"
    Write-Info  "Run:  $Bin login"
    Write-Info  'Using a purely local model with no accounts? The agent still requires a'
    Write-Info  'credential to be set; AINXT_API_KEY=local is the documented placeholder.'
    $script:CredsOk = $false
  }
}

function Initialize-Cli {
  Write-Step "Setting up the agent (the 'ainxt' CLI)"
  $script:CliOk = $false; $script:CredsOk = $false

  $cli = Find-Cli
  if ($cli) { Write-Ok "found the agent: $($cli.Bin)" }
  else {
    Write-Warn2 "no 'ainxt' binary found - the chat panel cannot start a conversation without it"
    $cli = Install-CliFromRelease
    if ($cli) { Write-Ok "installed the agent from a release: $($cli.Bin)" }
    else {
      $cli = Install-CliFromSource
      if (-not $cli) {
        Write-Bad 'could not install the agent automatically'
        Write-Host @"

  The agent lives in its own repository, and no release of it is published yet,
  so it has to be built once. Two options:

    a) Point this installer at a checkout and let it do the build:
         .\install.ps1 -CliDir C:\path	oinxt-cli
       Needs the Rust toolchain (https://rustup.rs/) and ~10 GB for target\.

    b) Build it there yourself, then re-run this installer:
         cd C:\path	oinxt-cli
         cargo build --profile release-dist -p ainxt-pager-bin --bin ainxt

  Already have the binary somewhere unusual? Skip the search entirely:
         `$env:AINXT_BINARY_PATH="C:\path	oinxt.exe"; .\install.ps1
"@
        $script:CliBin = $null
        return
      }
    }
  }

  $script:CliBin = $cli.Bin
  Test-Cli -Bin $cli.Bin
  Test-Credentials -Bin $cli.Bin

  if (-not $cli.OnPath) {
    if (Set-VSCodeSetting -Key 'ainxt.binaryPath' -Value $cli.Bin) {
      Write-Ok "set ainxt.binaryPath = $($cli.Bin) (the agent is not on your PATH)"
    }
  }
}

# --- Main --------------------------------------------------------------------

$script:ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$script:WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("ainxt-" + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null
$script:GatewayOk = $false

try {
  Write-Host "AiNxt Code - installer  (windows/$env:PROCESSOR_ARCHITECTURE)" -ForegroundColor White

  $vs = Find-VSCode

  if ($Uninstall) {
    Write-Step 'Uninstalling'
    if (-not $vs) { Die 'no VS Code installation found' }
    & $vs.Bin --uninstall-extension ainxt.ainxt-vscode 2>&1 | Select-Object -Last 3
    Write-Ok "removed ainxt.ainxt-vscode from $($vs.Name)"
    Write-Info "Settings in $(Get-VSCodeSettingsPath) were left in place."
    exit 0
  }

  if ($Verify) {
    # Check both halves: a reachable gateway with no working agent is still unusable.
    $script:CliBin = $null
    if (-not $SkipCli) {
      Write-Step "Checking the agent (the 'ainxt' CLI)"
      $c = Find-Cli
      if ($c) {
        Write-Ok "found the agent: $($c.Bin)"
        $script:CliBin = $c.Bin
        Test-Cli -Bin $c.Bin
        Test-Credentials -Bin $c.Bin
      } else {
        Write-Bad "no 'ainxt' binary found - the chat panel cannot start a conversation"
        Write-Info 'Install it with:  .\install.ps1 -CliDir C:\path\to\ainxt-cli'
      }
    }
    Test-Gateway
    Write-Host ''
    # -Verify checks the environment, not the install, so the extension is out of scope.
    # The gateway is only required when explicitly configured; standalone use only
    # needs a working agent with credentials for its own configured model.
    $gatewayRequirementMet = (-not $script:GatewayExplicit) -or $script:GatewayOk
    if ($script:CliBin -and $script:CliOk -and $gatewayRequirementMet -and $script:CredsOk) {
      Write-Host '  Agent is ready.' -ForegroundColor Green; exit 0
    }
    Write-Host '  Not ready. See the lines above.' -ForegroundColor Yellow; exit 1
  }

  Write-Step 'Checking what is available'
  if ($vs) { Write-Ok "VS Code CLI: $($vs.Bin)" } else { Write-Warn2 'no VS Code installation found' }
  if (Test-Node) { Write-Ok "node $(& node -v)" } else { Write-Info "node missing or < $MinNodeMajor (only needed to build from source)" }

  if ($Ide -eq 'none') {
    Write-Step 'Skipping IDE installation (-Ide none)'
  } else {
    Write-Step 'Obtaining the extension'
    $vsix = $null
    if ($FromSource) {
      Write-Info '-FromSource given; skipping the release check'
      $vsix = Build-Vsix
    } else {
      $vsix = Try-DownloadVsix
      if ($vsix) { Write-Ok 'downloaded a published release' }
      else {
        Write-Warn2 "no published release found for '$Version' - falling back to a source build"
        $vsix = Build-Vsix
      }
    }
    $sizeKb = [math]::Round((Get-Item $vsix).Length / 1KB)
    Write-Ok "extension package: $([IO.Path]::GetFileName($vsix)) ($sizeKb KB)"

    if ($vs) {
      Write-Step 'Installing the VS Code extension'
      & $vs.Bin --install-extension $vsix --force 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Die "$($vs.Name) --install-extension failed" }
      $script:ExtInstalled = $true
      Write-Ok "installed into $($vs.Name)"
      Write-Step 'Configuring'
      Set-GatewaySetting
    } else {
      Write-Warn2 "built the extension but cannot install it without VS Code"
      Write-Info  "Install VS Code from https://code.visualstudio.com/ then re-run, or use"
      Write-Info  "Extensions panel -> ... -> 'Install from VSIX...' -> $vsix"
    }
  }

  if ($SkipCli) {
    Write-Step 'Skipping the agent (-SkipCli)'
    $script:CliBin = $null
  } else {
    Initialize-Cli
  }

  if (-not $NoVerify) { Test-Gateway }

  Write-Step 'Where you stand'

  $pad = { param($k,$v) Write-Host ("  {0,-34} {1}" -f $k, $v) }

  if ($vsix -and $vs) { & $pad 'Extension' 'installed' }
  elseif ($vsix)      { & $pad 'Extension' 'built but not installed (no VS Code found)' }
  else                { & $pad 'Extension' 'skipped' }

  if ($SkipCli)              { & $pad 'Agent (ainxt CLI)' 'skipped (-SkipCli)' }
  elseif (-not $script:CliBin) { & $pad 'Agent (ainxt CLI)' 'MISSING - nothing will answer you' }
  elseif ($script:CliOk)     { & $pad 'Agent (ainxt CLI)' 'working - ACP handshake verified' }
  else                       { & $pad 'Agent (ainxt CLI)' 'present but the ACP handshake failed' }

  if ($script:CredsOk)         { & $pad 'Sign-in' 'credentials present' }
  elseif ($script:CliBin)      { & $pad 'Sign-in' "not signed in - run: $($script:CliBin) login" }
  else                         { & $pad 'Sign-in' 'unknown (no agent)' }

  if (-not $script:GatewayExplicit) { & $pad 'Gateway' 'not configured - running standalone (this is fine)' }
  elseif ($script:GatewayOk)        { & $pad 'Gateway' "reachable at $Gateway" }
  else                              { & $pad 'Gateway' "NOT reachable at $Gateway" }

  # The gateway only gates readiness when it was explicitly requested; standalone
  # use only needs a working, credentialed agent.
  $gatewayRequirementMet = (-not $script:GatewayExplicit) -or $script:GatewayOk

  Write-Host ''
  if ($script:ExtInstalled -and $script:CliBin -and $script:CliOk -and $gatewayRequirementMet -and $script:CredsOk) {
    Write-Host '  Ready. Open the AiNxt panel in VS Code (Activity Bar, or Ctrl+Shift+A) and type.' -ForegroundColor Green
  } else {
    Write-Host '  Not ready yet. Outstanding:' -ForegroundColor Yellow
    if (-not $script:ExtInstalled -and $Ide -ne 'none') {
      if ($vsix) {
        Write-Info '- The extension was built but not installed. Install VS Code, then re-run;'
        Write-Info "  or use Extensions panel -> ... -> 'Install from VSIX...' -> $vsix"
      } else {
        Write-Info '- The extension was not installed (-Ide none, or no build was attempted)'
      }
    }
    if (-not $script:CliBin -and -not $SkipCli) {
      Write-Info '- The agent could not be fetched. If ainxt-cli is not public yet, use'
      Write-Info '  .\install.ps1 -CliDir C:\path\to\ainxt-cli  or set AINXT_BINARY_PATH'
    }
    if ($script:CliBin -and -not $script:CliOk) { Write-Info "- The agent does not complete an ACP handshake; try: $($script:CliBin) agent --no-leader stdio" }
    if ($script:CliBin -and -not $script:CredsOk) {
      Write-Info "- No credential yet: run '$($script:CliBin) login', set AINXT_API_KEY, or add a"
      Write-Info '  [model.*] entry with its own api_key/env_key to ~\.ainxt\config.toml'
    }
    if (-not $gatewayRequirementMet) { Write-Info "- Start the AiNxt Platform (the gateway), then: .\install.ps1 -Verify -Gateway $Gateway" }
    Write-Host ''
    if (-not $script:GatewayExplicit) {
      Write-Info 'No gateway is configured, which is the standalone default - the CLI'
      Write-Info 'answers directly from whatever model you set up, no AiNxt Platform needed.'
    } else {
      Write-Info 'The Platform is a separate, optional repository (ainxt-enterprise). It needs'
      Write-Info 'PostgreSQL, Redis and one model provider; nothing in this suite bundles a model.'
    }
  }

  Write-Host @"

  A note on waiting. The agent retries a failing gateway up to 15 times by default
  and prints nothing while it does - around 340 seconds of apparent hang. The
  extension sets a smaller budget for interactive use; if you drive the agent from a
  terminal or CI, set AINXT_MAX_RETRIES=2 yourself and add a timeout.

  JetBrains (installed from disk, by design - see hosts\intellij\README.md):
    cd vscode-acp\webview-ui; npm ci; npm run build
    cd ..\..\hosts\intellij; .\gradlew.bat buildPlugin
    Settings -> Plugins -> gear -> Install Plugin from Disk...
      hosts\intellij\build\distributions\ainxt-intellij-*.zip

  Re-check everything:   .\install.ps1 -Verify
  Remove the extension:  .\install.ps1 -Uninstall
"@
}
finally {
  if ($script:WorkDir -and (Test-Path $script:WorkDir)) {
    Remove-Item -Recurse -Force $script:WorkDir -ErrorAction SilentlyContinue
  }
}
