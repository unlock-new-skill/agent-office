#!/bin/sh
# Nightly online backup of the Agent Office database (safe while the daemon runs: VACUUM INTO takes a consistent copy).
# Cron on the VPS, e.g.:  15 3 * * * /opt/my-studio/deploy/backup.sh >> /var/log/agent-office-backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
stamp=$(date +%Y%m%d-%H%M%S)
keep_days=${KEEP_DAYS:-14}
dest=${BACKUP_DIR:-/var/backups/agent-office}
mkdir -p "$dest" && chmod 700 "$dest"
docker compose -f docker-compose.prod.yml exec -T agent-office node -e "
  const { DatabaseSync } = require('node:sqlite');
  require('node:fs').mkdirSync('/app/data/backups', { recursive: true, mode: 0o700 });
  new DatabaseSync('/app/data/agent-office.sqlite').exec(\"VACUUM INTO '/app/data/backups/agent-office-$stamp.sqlite'\");
"
container=$(docker compose -f docker-compose.prod.yml ps -q agent-office)
docker cp "$container:/app/data/backups/agent-office-$stamp.sqlite" "$dest/"
docker compose -f docker-compose.prod.yml exec -T agent-office rm -f "/app/data/backups/agent-office-$stamp.sqlite"
chmod 600 "$dest/agent-office-$stamp.sqlite"
find "$dest" -name 'agent-office-*.sqlite' -mtime +"$keep_days" -delete
echo "backup ok: $dest/agent-office-$stamp.sqlite"
