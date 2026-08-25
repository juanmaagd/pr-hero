# Release Runbook

This document is the operational runbook for releasing new versions of `pr-hero`. It covers the repository branching model, versioning rules, step-by-step release instructions, CI/CD pipeline automation, post-release verification, and rollback procedures.

---

## 1. Branching Model & Commit Standards

`pr-hero` uses **Trunk-Based Development** centered on the `main` branch:

- **Primary Branch (`main`)**: The stable source of truth. All releases are tagged directly from `main`.
- **Feature & Fix Branches**: Work happens in short-lived branches branched off `main` (e.g. `feat/new-hunter`, `fix/tui-wrap`, `chore/bump-deps`).
- **Pull Request Gating**: Branches merge into `main` via pull requests only after passing automated CI checks (`.github/workflows/ci.yml`: test suite, type checking, linter check, and binary compilation).
- **Conventional Commits**: Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
  - `feat:` New user-facing features or capabilities
  - `fix:` Bug fixes and defect corrections
  - `chore:` Toolchain updates, dependency bumps, maintenance
  - `chore(release):` Release commits bumping versions and changelog
  - `docs:` Documentation improvements
  - `test:` Test additions or test framework refactoring
  - `refactor:` Code restructuring without behavior changes
  - `perf:` Performance optimizations

---

## 2. Versioning Scheme

`pr-hero` adheres to **[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)** (`MAJOR.MINOR.PATCH`):

- **`MAJOR`**: Breaking changes to CLI behavior, configuration schema, public API exports, or GitHub Actions contracts.
- **`MINOR`**: Backwards-compatible new features, new agent classes, or enhanced tooling.
- **`PATCH`**: Backwards-compatible bug fixes, performance improvements, or documentation updates.

### Version Synchronization Invariant

The project version is maintained in exactly two locations and must always remain identical:

1. `package.json`: `"version": "X.Y.Z"`
2. `src/index.ts`: `export const ENGINE_VERSION = "X.Y.Z";`

### Git Tagging Strategy

Two distinct tag types are used:

1. **Immutable Release Tags (`vX.Y.Z`)**:
   - Annotated Git tags representing specific point-in-time releases (e.g. `v1.0.0`, `v1.1.0`).
   - Once pushed to GitHub, immutable release tags must **never** be moved or re-pointed.
2. **Floating Major Tags (`v1`, `v2`, etc.)**:
   - Floating tags pointing to the latest release within a major version line.
   - Consumed by GitHub Actions users referencing the composite action (e.g., `uses: juanmaagd/pr-hero@v1`).
   - Moved/force-updated on every release within that major version line.

---

## 3. Step-by-Step Release Process

Follow these steps sequentially to execute a release.

### Step 1: Pre-Release Verification

Ensure your local repository is up-to-date with `main` and all verification suites pass:

```bash
# 1. Switch to clean main branch
git checkout main
git pull origin main

# 2. Install dependencies with frozen lockfile
bun install --frozen-lockfile

# 3. Execute test suite, type check, linter, and build bundle
bun test
bun run typecheck
bun run check
bun run build

# 4. (Optional) Run domain-specific probes
bun run fixture-eval
bun run refuter-probe
```

All commands must exit cleanly with code `0`.

### Step 2: Update Changelog

Open `CHANGELOG.md` and prepare the release section:

1. Change `## [Unreleased]` into the new release header: `## [X.Y.Z] - YYYY-MM-DD` (e.g., `## [1.0.0] - 2026-08-25`).
2. Add a fresh, empty `## [Unreleased]` section above it.
3. Update the link references at the bottom of `CHANGELOG.md`:
   ```markdown
   [Unreleased]: https://github.com/juanmaagd/pr-hero/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/juanmaagd/pr-hero/releases/tag/vX.Y.Z
   ```

### Step 3: Bump Version Numbers

Update the version string in both synchronization targets:

- In `package.json`:
  ```json
  "version": "X.Y.Z",
  ```
- In `src/index.ts`:
  ```typescript
  export const ENGINE_VERSION = "X.Y.Z";
  ```

### Step 4: Commit and Tag Release

Create the release commit and annotate the Git tags:

```bash
# 1. Stage modified files
git add package.json src/index.ts CHANGELOG.md

# 2. Create conventional release commit
git commit -m "chore(release): vX.Y.Z"

# 3. Create immutable annotated tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# 4. Update the floating major tag (e.g. v1 for 1.x.y)
git tag -fa v1 -m "Release v1 (points to vX.Y.Z)"
```

### Step 5: Push to Remote

Push the release commit, immutable tag, and updated floating tag to GitHub:

```bash
# 1. Push main branch
git push origin main

# 2. Push the immutable release tag
git push origin vX.Y.Z

# 3. Force-push the floating major tag
git push origin v1 --force
```

---

## 4. Automated CI/CD Release Pipeline

Pushing a `v*` tag automatically triggers the GitHub Actions Release Workflow (`.github/workflows/release.yml`):

```mermaid
flowchart TD
    A["Push git tag vX.Y.Z"] --> B["Job: build-binaries (Matrix)"]
    B --> B1["darwin-arm64 (macOS Apple Silicon)"]
    B --> B2["darwin-x64 (macOS Intel)"]
    B --> B3["linux-x64 (Ubuntu x64)"]
    B --> B4["linux-arm64 (Ubuntu ARM64)"]
    B1 & B2 & B3 & B4 --> C["Upload Binary Artifacts"]
    C --> D["Job: publish-release (Ubuntu)"]
    D --> E["Generate SHA256SUMS"]
    D --> F["Create GitHub Release with Binaries"]
    D --> G["Build npm Bundle (bun run build)"]
    D --> H["Publish to NPM (npm publish --provenance)"]
```

### Pipeline Workflow Stages

1. **`build-binaries`**:
   - Executes across a matrix of 4 runner environments (`macos-latest`, `macos-13`, `ubuntu-latest`, `ubuntu-24.04-arm`).
   - Runs full test suite and typechecks on each OS.
   - Compiles standalone executables using `bun build --compile --minify` with embedded version definitions.
   - Uploads binary artifacts (`pr-hero-darwin-arm64`, `pr-hero-darwin-x64`, `pr-hero-linux-x64`, `pr-hero-linux-arm64`).
2. **`publish-release`**:
   - Gathers all compiled binaries and computes cryptographic `SHA256SUMS`.
   - Creates a GitHub Release via `softprops/action-gh-release@v2` containing all binaries and checksums.
   - Generates release notes automatically from commit history and pull requests.
   - Builds the npm distribution bundle and publishes to npm registry with cryptographic provenance using `NODE_AUTH_TOKEN`.

---

## 5. Post-Release Verification

Perform these sanity checks immediately following a release:

1. **GitHub Release Verification**:
   - Visit `https://github.com/juanmaagd/pr-hero/releases/tag/vX.Y.Z`.
   - Confirm all 4 platform binaries and `SHA256SUMS` are attached as release assets.
2. **NPM Registry Verification**:
   ```bash
   # Check published package version
   npm view pr-hero version
   npm view pr-hero dist-tags
   ```
3. **Installer Script Test**:
   - Test standalone installer download in a temporary environment:
     ```bash
     PRHERO_VERSION="vX.Y.Z" curl -fsSL https://raw.githubusercontent.com/juanmaagd/pr-hero/main/install.sh | bash
     ~/.prhero/bin/pr-hero --version
     ```
4. **GitHub Action Reference**:
   - Confirm workflows referencing `juanmaagd/pr-hero@v1` or `juanmaagd/pr-hero@vX.Y.Z` resolve the new release.
5. **Doctor Diagnostic**:
   - Run `pr-hero doctor` locally to verify runtime integrity and toolchain health.

---

## 6. Rollback & Hotfix Procedures

### Scenario A: Urgent Bug Discovered in Released Version

**Rule: Never mutate existing immutable tags or rewrite release history.**

1. Create a hotfix branch from `main`:
   ```bash
   git checkout -b fix/hotfix-issue-name main
   ```
2. Apply the fix and add regression tests.
3. Update `CHANGELOG.md` with patch notes and increment the patch version (`vX.Y.Z+1`) in `package.json` and `src/index.ts`.
4. Merge into `main` and execute the release process for `vX.Y.Z+1`.
5. The floating `v1` tag will automatically update to point to the new patch release, instantly protecting Action users.

### Scenario B: Compromised or Broken NPM Package

If a critical flaw requires immediately warning package consumers:

1. **Deprecate the flawed version on npm**:
   ```bash
   npm deprecate pr-hero@X.Y.Z "Critical issue in X.Y.Z; please upgrade to X.Y.Z+1 immediately."
   ```
2. **Unpublishing (Emergency only)**:
   - NPM allows unpublishing only within 72 hours of initial release if no dependents exist (`npm unpublish pr-hero@X.Y.Z --force`).
   - Prefer deprecation + immediate patch release (`vX.Y.Z+1`) to avoid breaking downstream builds.

### Scenario C: Mispointed Floating Tag

If the floating tag `v1` was pushed to an incorrect commit SHA:

```bash
# Re-align floating tag locally to the correct release commit
git tag -fa v1 <target-commit-sha> -m "Re-align floating v1 tag"

# Force push updated floating tag
git push origin v1 --force
```
