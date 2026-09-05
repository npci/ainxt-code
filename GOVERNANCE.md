# Governance

## Project roles

### Maintainers
Maintainers have write access to the repository and are responsible for:
- Reviewing and merging pull requests
- Triaging issues
- Cutting releases
- Enforcing the [Code of Conduct](CODE_OF_CONDUCT.md)

Current maintainers are listed in [CODEOWNERS](CODEOWNERS).

### Contributors
Anyone who submits a pull request, opens an issue, or participates in discussions
is a contributor. Contributions are governed by the [DCO](https://developercertificate.org/)
sign-off requirement documented in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Decision making

Routine decisions (bug fixes, minor features, dependency updates) are made by any
maintainer via pull request review and merge.

Significant decisions (breaking changes, new major features, license changes,
governance changes) require:
1. A GitHub Issue or Discussion opened for community input (minimum 7 days open).
2. Consensus among active maintainers.
3. A pull request with the change documented in `CHANGELOG.md`.

---

## Release process

1. All changes are merged to `develop` via pull request.
2. A release PR is opened from `develop` → `main` with:
   - `CHANGELOG.md` updated (move `[Unreleased]` to a versioned section).
   - `vscode-acp/package.json` version bumped.
   - `vscode-acp/CHANGELOG.md` updated.
3. On merge to `main`, CI automatically:
   - Runs lint, tests, and `npm audit`.
   - Packages the `.vsix`.
   - Uploads the artifact.
4. A maintainer publishes to the VS Code Marketplace manually using `vsce publish`.
5. A GitHub Release is created with the `.vsix` attached and changelog notes.

---

## Code of Conduct enforcement

Enforcement is handled by the maintainer team. Reports are sent to the contact
address in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). All reports are treated
confidentially. See the Code of Conduct for the full enforcement process.

---

## Changes to this document

Changes to this governance document follow the same significant-decision process
described above.
