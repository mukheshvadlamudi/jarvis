#!/bin/sh
# Start Jarvis on Linux: ./start-jarvis.sh  (add --demo to try it without your plans)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Jarvis needs Node.js 24 or newer: https://nodejs.org"
  exit 1
fi
exec node scripts/jarvis.mjs "$@"
