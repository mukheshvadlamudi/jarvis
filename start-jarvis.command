#!/bin/sh
# Double-click to start Jarvis on macOS.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Jarvis needs Node.js 24 or newer: https://nodejs.org"
  open https://nodejs.org/en/download
  read -r _
  exit 1
fi
exec node scripts/jarvis.mjs "$@"
