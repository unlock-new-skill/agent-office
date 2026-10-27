#!/bin/sh
# One-time: prompts for the manager password (16+ chars, not echoed, not stored in .env), creates the database in the
# data volume, then starts the daemon. Run on the VPS from an interactive terminal: sh deploy/setup-manager.sh
set -eu
cd "$(dirname "$0")/.."
compose="docker compose -f docker-compose.prod.yml"
$compose build agent-office
$compose run --rm --no-deps -it --entrypoint sh agent-office -c 'mkdir -p /app/data && chmod 700 /app/data && node dist/scripts/setup-local.js'
$compose up -d agent-office
$compose ps
