#!/bin/sh
set -eu
mkdir -p /app/data
chmod 700 /app/data
# The password is only needed to create the manager on an empty volume; afterwards it never has to be kept around.
if [ ! -f "${AGENT_OFFICE_DATA_DIR:-/app/data}/agent-office.sqlite" ]; then
  if [ -z "${AGENT_OFFICE_PASSWORD:-}" ]; then
    echo "agent-office: no manager yet. Run deploy/setup-manager.sh (or set AGENT_OFFICE_PASSWORD for the first start)." >&2
    exit 1
  fi
  printf '%s\n' "$AGENT_OFFICE_PASSWORD" | node dist/scripts/setup-local.js
fi
exec node dist/src/server/index.js
