# Contributing to AiNxt Code

> ## Contributions are not open yet
>
> This project is published under the MIT Licence as **source-available**: you may use,
> modify and redistribute it under the licence, and the source is here to be read
> and built. What is **not** open yet is the contribution process — external pull
> requests and issues are **not being accepted or triaged at this time**, and no
> commitment is made to review or respond to them.
>
> This is a deliberate, temporary posture while the project's governance, security
> response and review capacity are established. It is not a statement about the
> licence: the MIT Licence grants you every right it says it does, including the right to
> fork.
>
> The guidance below describes the workflow the maintaining team follows, and is the
> workflow external contributions will follow when they open. Nothing here creates an
> obligation on the project to accept a contribution.
>
> **Security vulnerabilities are the exception** — report those privately at any
> time, as described in [`SECURITY.md`](SECURITY.md).

---

Thank you for your interest in contributing! This document covers everything you need to get started.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [How to Report a Bug](#how-to-report-a-bug)
3. [How to Request a Feature](#how-to-request-a-feature)
4. [Development Setup](#development-setup)
5. [Making a Pull Request](#making-a-pull-request)
6. [Coding Standards](#coding-standards)
7. [Commit Message Convention](#commit-message-convention)
8. [DCO Sign-Off](#dco-sign-off)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms. Report unacceptable behaviour to the maintainers via the contact listed in that document.

---

## How to Report a Bug

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) issue template. Please include:

- VS Code / IntelliJ version
- `AiNxt` CLI version (`ainxt --version`)
- Operating system
- Steps to reproduce
- Expected vs actual behaviour
- Relevant output from **AiNxt: Show Log** (`Ctrl+Shift+A` → log icon)

**Security vulnerabilities** must be reported privately — see [SECURITY.md](SECURITY.md).

---

## How to Request a Feature

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) issue template. Describe the problem you are trying to solve, not just the solution you have in mind.

---

## Development Setup

### Prerequisites

- **Node.js** ≥ 18 and **npm** ≥ 9
- **VS Code** ≥ 1.85
- **ainxt CLI** installed and on `PATH` (or set `ainxt.binaryPath` in settings)
- For the IntelliJ plugin: **JDK 17** and **Gradle**

### VS Code Extension

```bash
# Clone and install
git clone <repository-url>
cd ainxt-code/vscode-acp

npm install

# Build the React webview UI
cd webview-ui && npm install && npm run build && cd ..

# Compile the extension
npm run compile

# Launch a VS Code Extension Development Host
# Press F5 in VS Code with the repo open, or:
code --extensionDevelopmentPath=$(pwd) .
```

### IntelliJ Plugin

> **The IntelliJ host currently ships as sources only — it does not build as cloned.**
> `hosts/intellij/` contains the Kotlin sources, `plugin.xml` and resources, but **no
> Gradle build script** (`build.gradle.kts` / `settings.gradle.kts`) and no Gradle
> wrapper. `./gradlew runIde` therefore cannot work yet: there is no wrapper to invoke
> and no `runIde` task to find. Supplying an IntelliJ Platform Gradle build is
> outstanding work — see [`hosts/intellij/README.md`](hosts/intellij/README.md).
>
> The VS Code extension above is complete and builds as documented.

Once a build script exists, the shared React UI must be built first — the Gradle build
copies its output into the plugin resources:

```bash
cd vscode-acp/webview-ui && npm install && npm run build
```

### Running Tests

```bash
cd vscode-acp
npm test
```

---

## Making a Pull Request

1. **Fork** the repository and create a branch from `develop`:
   ```bash
   git checkout -b feat/my-feature develop
   ```
2. Make your changes. Keep commits focused — one logical change per commit.
3. Add or update tests where relevant.
4. Run `npm run lint` and `npm test` — both must pass.
5. **Sign off** every commit (see [DCO Sign-Off](#dco-sign-off)).
6. Open a PR against the `develop` branch. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
7. A maintainer will review within 5 business days.

### Branch naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<short-description>` | `feat/session-tree-view` |
| Bug fix | `fix/<short-description>` | `fix/telemetry-key-leak` |
| Documentation | `docs/<short-description>` | `docs/contributing-guide` |
| Chore | `chore/<short-description>` | `chore/update-deps` |

---

## Coding Standards

- **TypeScript** (VS Code extension): follow the existing ESLint config (`eslint.config.mjs`). Run `npm run lint` before committing.
- **Kotlin** (IntelliJ plugin): follow standard Kotlin style. Use `ktlint` if available.
- Keep functions small and single-purpose.
- Prefer explicit types over `any`. Use `unknown` when the type is genuinely unknown.
- All user-visible strings must be in English.
- Do not introduce new hardcoded secrets, internal URLs, or organisation-specific defaults.

---

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer — DCO sign-off goes here]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`

**Examples:**
```
feat(vscode): add session tree view with pagination
fix(intellij): use VFS API for file read/write
docs: rewrite README for OSS users
chore: update @agentclientprotocol/sdk to 0.22.0
```

---

## DCO Sign-Off

All commits must include a Developer Certificate of Origin sign-off. Add it with:

```bash
git commit -s -m "feat: my change"
```

This appends `Signed-off-by: Your Name <your@email.com>` to the commit message, certifying that you have the right to submit the contribution under the project's MIT licence. See [developercertificate.org](https://developercertificate.org/) for the full text.

PRs with unsigned commits will not be merged.

## Third-party code and dependency additions

If you copy, port or adapt code from another project, three things must be true
before the PR is mergeable:

1. **The licence permits it and is compatible with MIT.** Permissive
   (MIT/BSD/Apache-2.0/ISC) is fine; copyleft (GPL/LGPL/AGPL) is not.
2. **The origin is recorded** in `NOTICE` — upstream project, source URL, licence,
   and what was changed. This extension is itself derived from `vscode-acp`, and that
   attribution is what the entry there looks like.
3. **The upstream copyright headers stay intact.**

Adding an npm package: keep the dependency count low, prefer a package that is
already a transitive dependency, and check the licence before you add it. A package
with no licence, or a copyleft one, will not be accepted.
