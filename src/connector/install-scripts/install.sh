#!/bin/sh
# Agent Office connector installer for macOS / Linux.
# Usage (the manager copies this from Org → Add machine):
#   curl -fsSL __ORIGIN__/install.sh | sh -s -- <install-code>
set -eu
ORIGIN='__ORIGIN__'
CODE="${1:-${AGENT_OFFICE_CODE:-}}"
if [ -z "$CODE" ]; then
  echo "usage: curl -fsSL $ORIGIN/install.sh | sh -s -- <install-code>" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required: https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20+ is required; found $(node -v)." >&2
  exit 1
fi
DIR="${AGENT_OFFICE_HOME:-$HOME/.agent-office}/bin"
mkdir -p "$DIR"
curl -fsSL "$ORIGIN/connector/agent-office.mjs" -o "$DIR/agent-office.mjs.tmp"
mv "$DIR/agent-office.mjs.tmp" "$DIR/agent-office.mjs"
node "$DIR/agent-office.mjs" install --url "$ORIGIN" --code "$CODE"
