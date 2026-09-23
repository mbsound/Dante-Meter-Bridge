#!/bin/bash
# Dante Audio Meter Bridge — everyday launcher for macOS.
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "========================================================"
  echo "  [ERROR] Node.js is not installed on this Mac."
  echo "========================================================"
  echo ""
  echo "Please double-click 'First Time Running - Click Here - Mac.command' first."
  echo ""
  read -r -p "Press Enter to close this window..."
  exit 1
fi

exec node server.js --open
