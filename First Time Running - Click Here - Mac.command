#!/bin/bash
# Dante Audio Meter Bridge — first-time setup for macOS.
# Installs the current Node.js LTS if needed (verified against nodejs.org's
# published SHA-256 checksums), then starts the bridge and opens the browser.

set -euo pipefail
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

MIN_NODE_MAJOR=18

node_ok() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$MIN_NODE_MAJOR" ]
}

fail() {
  echo ""
  echo "[ERROR] $1"
  echo "You can install Node.js manually from https://nodejs.org (choose the LTS version)."
  echo ""
  read -r -p "Press Enter to close this window..."
  exit 1
}

clear
echo "========================================================"
echo "   DANTE AUDIO METER BRIDGE - FIRST TIME SETUP (macOS)"
echo "========================================================"
echo ""

if node_ok; then
  echo "[OK] Node.js $(node -v) is installed."
else
  if command -v node >/dev/null 2>&1; then
    echo "[!] Node.js $(node -v) is too old (need v${MIN_NODE_MAJOR} or newer)."
  else
    echo "[!] Node.js was not found on this Mac."
  fi

  if command -v brew >/dev/null 2>&1; then
    echo "[*] Installing Node.js with Homebrew..."
    brew install node || brew upgrade node || true
  fi

  if ! node_ok; then
    echo "[*] Looking up the current Node.js LTS release..."
    VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | grep '"lts":"' | head -1 |
      sed -E 's/.*"version":"(v[0-9]+\.[0-9]+\.[0-9]+)".*/\1/')" || true
    [[ "${VERSION:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Could not look up the latest Node.js version. Check your internet connection."

    PKG="node-${VERSION}.pkg"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT

    echo "[*] Downloading Node.js ${VERSION}..."
    curl -fL --progress-bar "https://nodejs.org/dist/${VERSION}/${PKG}" -o "${TMP}/${PKG}" || fail "Download failed."
    curl -fsSL "https://nodejs.org/dist/${VERSION}/SHASUMS256.txt" -o "${TMP}/SHASUMS256.txt" || fail "Could not download checksums."

    echo "[*] Verifying download..."
    (cd "$TMP" && grep " ${PKG}\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || fail "Checksum mismatch — the download may be corrupted."

    echo ""
    echo "[*] Installing Node.js (enter your Mac login password if asked)..."
    if ! sudo installer -pkg "${TMP}/${PKG}" -target /; then
      echo "[*] Opening the graphical installer instead — please complete it."
      open -W "${TMP}/${PKG}"
    fi
    hash -r
  fi

  node_ok || fail "Node.js installation did not complete."
  echo ""
  echo "[SUCCESS] Node.js $(node -v) is installed."
fi

echo ""
echo "Starting Dante Meter Bridge... (close this window or press Ctrl+C to stop)"
echo ""
exec node server.js --open
