#!/usr/bin/env bash
set -euo pipefail

REPO="Gentleman-Programming/pr-hero"
INSTALL_DIR="${HOME}/.prhero/bin"
BIN_PATH="${INSTALL_DIR}/pr-hero"

echo "=== Installing pr-hero ==="

# 1. Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${OS}" in
  darwin)
    case "${ARCH}" in
      arm64|aarch64) TARGET="darwin-arm64" ;;
      x86_64) TARGET="darwin-x64" ;;
      *) echo "Unsupported architecture: ${ARCH} on macOS" >&2; exit 1 ;;
    esac
    ;;
  linux)
    case "${ARCH}" in
      x86_64) TARGET="linux-x64" ;;
      aarch64|arm64) TARGET="linux-arm64" ;;
      *) echo "Unsupported architecture: ${ARCH} on Linux" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported operating system: ${OS}" >&2
    exit 1
    ;;
esac

echo "Detected platform: ${TARGET}"

# 2. Determine latest version if not set
if [ -z "${PRHERO_VERSION:-}" ]; then
  echo "Resolving latest release..."
  VERSION="$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/' || true)"
  if [ -z "${VERSION}" ]; then
    VERSION="0.1.0"
  fi
else
  VERSION="${PRHERO_VERSION#v}"
fi

echo "Target version: v${VERSION}"

# 3. Create target directory
mkdir -p "${INSTALL_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

BINARY_URL="https://github.com/${REPO}/releases/download/v${VERSION}/pr-hero-${TARGET}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/v${VERSION}/SHA256SUMS"

echo "Downloading pr-hero binary from ${BINARY_URL}..."
if curl -sSL --fail "${BINARY_URL}" -o "${TMP_DIR}/pr-hero"; then
  # Download and verify checksum if available
  if curl -sSL --fail "${CHECKSUMS_URL}" -o "${TMP_DIR}/SHA256SUMS"; then
    echo "Verifying SHA256 checksum..."
    cd "${TMP_DIR}"
    if command -v sha256sum >/dev/null 2>&1; then
      grep "pr-hero-${TARGET}" SHA256SUMS | sed "s/pr-hero-${TARGET}/pr-hero/" | sha256sum -c -
    elif command -v shasum >/dev/null 2>&1; then
      grep "pr-hero-${TARGET}" SHA256SUMS | sed "s/pr-hero-${TARGET}/pr-hero/" | shasum -a 256 -c -
    fi
    cd - >/dev/null
  fi

  chmod +x "${TMP_DIR}/pr-hero"
  mv "${TMP_DIR}/pr-hero" "${BIN_PATH}"
else
  echo "Release binary not yet available; checking for local / dev installation fallback..." >&2
  # Fallback for local testing or dev
  if [ -f "./src/cli.ts" ] && command -v bun >/dev/null 2>&1; then
    echo "Building local binary via bun..."
    bun build --compile src/cli.ts --outfile "${BIN_PATH}"
    chmod +x "${BIN_PATH}"
  else
    echo "Failed to download pr-hero binary." >&2
    exit 1
  fi
fi

echo "Installed pr-hero to ${BIN_PATH}"

# 4. PATH Configuration (Idempotent)
setup_shell_path() {
  local rc_file="$1"
  local line='export PATH="${HOME}/.prhero/bin:${PATH}"'
  if [ -f "${rc_file}" ]; then
    if ! grep -q ".prhero/bin" "${rc_file}"; then
      echo "" >> "${rc_file}"
      echo "# pr-hero binary path" >> "${rc_file}"
      echo "${line}" >> "${rc_file}"
      echo "Added ${INSTALL_DIR} to ${rc_file}"
    fi
  fi
}

setup_shell_path "${HOME}/.zshrc"
setup_shell_path "${HOME}/.bashrc"
setup_shell_path "${HOME}/.bash_profile"

if [ -f "${HOME}/.config/fish/config.fish" ]; then
  if ! grep -q ".prhero/bin" "${HOME}/.config/fish/config.fish"; then
    echo 'set -gx PATH $HOME/.prhero/bin $PATH' >> "${HOME}/.config/fish/config.fish"
    echo "Added ${INSTALL_DIR} to fish config"
  fi
fi

echo ""
echo "=== pr-hero installation complete! ==="
echo "Run 'pr-hero' or 'pr-hero setup' to get started."
