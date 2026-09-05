#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright 2026 AiNxt
#
# Asserts the properties a fresh external clone depends on. Each check exists
# because it was once broken and blocked a newcomer setup; the ledger ID is
# named so a future failure is traceable. Run in CI and before tagging.
#
#   ./scripts/check-release-invariants.sh

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FAIL=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     -> %s\n' "$1" "$2"; FAIL=1; }

# A file is only shipped if git actually tracks it. `git check-ignore` is not
# enough: a negation pattern can match and still leave the file untracked.
tracked() { git ls-files --error-unmatch "$1" >/dev/null 2>&1; }

echo "Release invariants"

# ─── SETUP-039: the README quick start must exist and run ────────────────────
if [ -x setup.sh ]; then pass "setup.sh present and executable (SETUP-039)"
else fail "setup.sh present and executable (SETUP-039)" "README.md documents './setup.sh' as the quick start"; fi

# ─── SETUP-057: the one-command installers are the documented entry point ────
for I in install.sh install.ps1; do
  if tracked "$I"; then pass "$I is tracked (SETUP-057)"
  else fail "$I is tracked (SETUP-057)" "README.md documents it as the primary install path"; fi
done
if [ -x install.sh ]; then pass "install.sh is executable (SETUP-057)"
else fail "install.sh is executable (SETUP-057)" "curl | sh works regardless, but ./install.sh must too"; fi
if command -v sh >/dev/null 2>&1 && sh -n install.sh 2>/dev/null; then
  pass "install.sh parses as POSIX sh (SETUP-057)"
else
  fail "install.sh parses as POSIX sh (SETUP-057)" "it is piped into /bin/sh, which is dash on Debian/Ubuntu"
fi
# The three probed routes must stay in step with what the extension actually calls.
for R in auth/me budget/me complete; do
  if grep -q "ainxt/v1/api/$R" install.sh && grep -q "ainxt/v1/api/$R" install.ps1; then
    pass "both installers probe /ainxt/v1/api/$R (SETUP-057)"
  else
    fail "both installers probe /ainxt/v1/api/$R (SETUP-057)" "the verifier has drifted from the extension's real calls"
  fi
done

# ─── SETUP-058: the installers must set up the agent, not just the extension ─
# ainxt-code contains no agent; an installer that stops at the extension leaves the
# user with a panel that cannot start a conversation.
for TOKEN in 'agent --no-leader' 'initialize' 'credentials.json'; do
  if grep -q "$TOKEN" install.sh && grep -q "$TOKEN" install.ps1; then
    pass "both installers handle the agent ('$TOKEN') (SETUP-058)"
  else
    fail "both installers handle the agent ('$TOKEN') (SETUP-058)" \
         "the agent is the product; installing only the extension is not a working setup"
  fi
done
# The extension must not inherit the agent's ~340s silent retry budget.
if grep -q 'AINXT_MAX_RETRIES' vscode-acp/src/config/AgentConfig.ts; then
  pass "extension caps the agent retry budget for interactive use (SETUP-058)"
else
  fail "extension caps the agent retry budget for interactive use (SETUP-058)" \
       "the agent default is 15 retries with no output — ~340s of apparent hang in the panel"
fi

# ─── SETUP-059: the agent must be obtained without user homework ─────────────
# Handing the user "go build it with cargo" is the manual step the installers exist
# to remove, so assert both can fetch the source and provision a toolchain.
for TOKEN in 'git clone' 'sh.rustup.rs\|win.rustup.rs' 'AINXT_CLI_SRC'; do
  if grep -q "$TOKEN" install.sh && grep -q "$TOKEN" install.ps1; then
    pass "both installers can obtain the agent unaided ('$TOKEN') (SETUP-059)"
  else
    fail "both installers can obtain the agent unaided ('$TOKEN') (SETUP-059)" \
         "a missing agent must be fetched and built, not turned into instructions"
  fi
done

# ─── SETUP-040: ./gradlew cannot bootstrap without the wrapper JAR ───────────
WRAPPER=hosts/intellij/gradle/wrapper/gradle-wrapper.jar
if tracked "$WRAPPER"; then pass "Gradle wrapper JAR is tracked (SETUP-040)"
else fail "Gradle wrapper JAR is tracked (SETUP-040)" "a blanket '*.jar' ignore makes the IntelliJ host unbuildable from a fresh clone"; fi

# ─── SETUP-041: reproducible installs ────────────────────────────────────────
for LOCK in package-lock.json vscode-acp/webview-ui/package-lock.json; do
  if tracked "$LOCK"; then pass "$LOCK is tracked (SETUP-041)"
  else fail "$LOCK is tracked (SETUP-041)" "unpinned deps drift; this is what broke 'npm test' (SETUP-042)"; fi
done

# ─── SETUP-043: never ship the webview build toolchain to end users ──────────
if [ -f vscode-acp/.vscodeignore ]; then
  pass "vscode-acp/.vscodeignore present (SETUP-043)"
  if grep -qE '^\s*!.*\*\.d\.ts' vscode-acp/.vscodeignore; then
    fail "no global .d.ts negation in .vscodeignore (SETUP-043)" \
         ".vscodeignore negations are global, so '!**/*.d.ts' re-includes node_modules declaration files"
  else
    pass "no global .d.ts negation in .vscodeignore (SETUP-043)"
  fi
else
  fail "vscode-acp/.vscodeignore present (SETUP-043)" "without it the .vsix ships ~6900 webview-ui/node_modules files"
fi

# ─── DOC-018: brand masters must not creep back into the tree ────────────────
HEAVY=$(git ls-files 'AINxt_logo_icon' | grep -iE '\.(ai|eps|pdf)$' || true)
if [ -z "$HEAVY" ]; then pass "no Illustrator/EPS/PDF brand masters tracked (DOC-018)"
else fail "no Illustrator/EPS/PDF brand masters tracked (DOC-018)" \
       "these were 79% of the repository and nothing references them:
$(echo "$HEAVY" | head -3)"; fi
# The two files the README banner points at must exist, or the banner breaks.
for B in 'AINxt_logo_icon/AINxt_CTC-01.png' 'AINxt_logo_icon/AINxt_CTC-02.png'; do
  if tracked "$B"; then pass "$(basename "$B") tracked for the README banner (DOC-019)"
  else fail "$(basename "$B") tracked for the README banner (DOC-019)" "the <picture> banner would 404"; fi
done

# ─── FINAL-002: redistributed third-party code must be attributed ────────────
if tracked THIRD-PARTY-NOTICES; then
  pass "THIRD-PARTY-NOTICES is tracked (FINAL-002)"
  if command -v node >/dev/null 2>&1 && [ -d node_modules ] \
     && [ -d vscode-acp/webview-ui/node_modules ]; then
    if node scripts/generate-third-party-notices.mjs --check >/dev/null 2>&1; then
      pass "THIRD-PARTY-NOTICES matches the current redistributed closure (FINAL-002)"
    else
      fail "THIRD-PARTY-NOTICES matches the current redistributed closure (FINAL-002)" \
           "a runtime dependency changed; run: node scripts/generate-third-party-notices.mjs"
    fi
  else
    pass "THIRD-PARTY-NOTICES freshness skipped (no installed tree here)"
  fi
else
  fail "THIRD-PARTY-NOTICES is tracked (FINAL-002)" \
       "the .vsix redistributes 122 third-party packages whose licences require attribution"
fi
# It has to travel with the artefact, not just sit in the repo.
if grep -q "THIRD-PARTY-NOTICES" vscode-acp/package.json; then
  pass "THIRD-PARTY-NOTICES is copied into the .vsix (FINAL-002)"
else
  fail "THIRD-PARTY-NOTICES is copied into the .vsix (FINAL-002)" \
       "copy:legal must carry it, or the notice does not reach the recipient"
fi

# ─── FINAL-001: workspace must not control execution or credentials ──────────
SCOPED=$(node -e '
const c=require("./vscode-acp/package.json").contributes.configuration;
const p=(Array.isArray(c)?c[0]:c).properties;
const need=["acp.agents","acp.autoApprovePermissions","ainxt.binaryPath","ainxt.gatewayUrl",
            "ainxt.allowInsecure","ainxt.homeDir","ainxt.registryUrl"];
const bad=need.filter(k=>!p[k]||p[k].scope!=="machine");
process.stdout.write(bad.join(","));' 2>/dev/null)
if [ -z "$SCOPED" ]; then pass "execution/credential settings are machine-scoped (FINAL-001)"
else fail "execution/credential settings are machine-scoped (FINAL-001)" \
       "a repository could set these from .vscode/settings.json: $SCOPED"; fi

# ─── FINAL-003: CODEOWNERS must not name an unresolvable owner ───────────────
if grep -q 'ainxt-org' CODEOWNERS 2>/dev/null; then
  fail "CODEOWNERS names a resolvable owner (FINAL-003)" \
       "@ainxt-org does not exist; GitHub silently ignores rules naming unknown teams"
else
  pass "CODEOWNERS names no unresolvable placeholder org (FINAL-003)"
fi

# ─── DOC-021: the mermaid render check must stay present and wired to CI ─────
if tracked scripts/check-mermaid-renders.mjs; then
  pass "mermaid render check is tracked (DOC-021)"
else
  fail "mermaid render check is tracked (DOC-021)" "159 diagrams would go unverified"
fi
if grep -q 'check-mermaid-renders.mjs' .github/workflows/ci.yml; then
  pass "CI runs the mermaid render check (DOC-021)"
else
  fail "CI runs the mermaid render check (DOC-021)" "a broken diagram would reach a reader"
fi

# ─── DOC-020: docs/ must stay organised, not revert to a flat dump ───────────
# The generator emits flat underscore-named files. If a regenerated run is committed
# without remapping, docs/ silently becomes 33 loose pages again.
# git pathspec globs match across '/', so filter to genuine top-level pages here.
LOOSE=$(git ls-files 'docs/*.md' | grep -E '^docs/[^/]+\.md$' \
        | grep -vE '^docs/(README|overview)\.md$' || true)
if [ -z "$LOOSE" ]; then
  pass "docs/ pages are grouped, not loose at the top level (DOC-020)"
else
  fail "docs/ pages are grouped, not loose at the top level (DOC-020)" \
       "these belong under extension/, webview/ or intellij/:
$(echo "$LOOSE" | head -4)"
fi
# Each group's overview must be its README.md so GitHub renders it on the directory.
for G in docs/extension docs/webview docs/intellij; do
  if tracked "$G/README.md"; then pass "$G has an overview README (DOC-020)"
  else fail "$G has an overview README (DOC-020)" "browsing the directory on GitHub would show nothing"; fi
done

# ─── SETUP-046: every relative documentation link must resolve ───────────────
BROKEN=""
while IFS= read -r f; do
  d=$(dirname "$f")
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    case "$l" in http*|\#*|mailto:*|../../security/*) continue ;; esac
    t="${l%%#*}"; [ -z "$t" ] && continue
    [ -e "$d/$t" ] || BROKEN="$BROKEN\n     $f -> $l"
  done < <(grep -oE '\]\([^)]+\)' "$f" 2>/dev/null | sed 's/^](//;s/)$//')
done < <(git ls-files '*.md')
if [ -z "$BROKEN" ]; then pass "all relative documentation links resolve (SETUP-046)"
else fail "all relative documentation links resolve (SETUP-046)" "$(printf '%b' "$BROKEN")"; fi

# ─── SETUP-047: one Node floor, stated once ──────────────────────────────────
NVMRC=$(tr -d '[:space:]' < .nvmrc 2>/dev/null)
ENGINE=$(node -p "require('./package.json').engines.node.replace(/[^0-9]/g,'')" 2>/dev/null)
if [ -n "$NVMRC" ] && [ "$NVMRC" = "$ENGINE" ]; then pass "Node floor consistent: .nvmrc=$NVMRC, engines>=$ENGINE (SETUP-047)"
else fail "Node floor consistent (SETUP-047)" ".nvmrc='$NVMRC' vs package.json engines='$ENGINE'"; fi

# ─── SETUP-051: every contributed setting is documented ──────────────────────
CONTRIBUTED=$(node -e '
const p=require("./vscode-acp/package.json");
const c=p.contributes.configuration;
const props=(Array.isArray(c)?c[0]:c).properties||{};
console.log(Object.keys(props).join("\n"));' 2>/dev/null)
UNDOC=""
for k in $CONTRIBUTED; do
  grep -q -- "\`$k\`" vscode-acp/README.md || UNDOC="$UNDOC $k"
done
if [ -z "$UNDOC" ]; then pass "all $(echo "$CONTRIBUTED" | wc -l | tr -d ' ') contributed settings documented (SETUP-051)"
else fail "all contributed settings documented (SETUP-051)" "undocumented:$UNDOC"; fi

# ─── SETUP-049: no build scratch in the source tree ──────────────────────────
JUNK=$(git ls-files | grep -E '(^|/)(\.gradle|\.kotlin|\.intellijPlatform|node_modules|dist)/' || true)
if [ -z "$JUNK" ]; then pass "no build artefacts tracked (SETUP-049)"
else fail "no build artefacts tracked (SETUP-049)" "$(echo "$JUNK" | head -5)"; fi

# ─── FINAL-013: vendored third-party files must be attributed in NOTICE ──────
# THIRD-PARTY-NOTICES is generated from the npm runtime closure and cannot see a
# file checked straight into the tree, so a vendored bundle attributes nowhere
# unless NOTICE names it. Any tracked minified third-party blob counts.
VENDORED=$(git ls-files | grep -E '\.min\.(js|css)$' || true)
UNATTRIB=""
while IFS= read -r v; do
  [ -n "$v" ] || continue
  grep -qF "$v" NOTICE 2>/dev/null || UNATTRIB="$UNATTRIB $v"
done <<EOF
$VENDORED
EOF
if [ -z "$UNATTRIB" ]; then
  pass "vendored third-party files are attributed in NOTICE (FINAL-013)"
else
  fail "vendored third-party files are attributed in NOTICE (FINAL-013)" \
       "committed verbatim but named nowhere in NOTICE:$UNATTRIB"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "All release invariants hold."; else echo "Release invariants BROKEN — see above."; fi
exit "$FAIL"
