import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { DataLock } from '../src/server/data-lock.js';
import { assertSupportedRuntime } from '../src/server/runtime.js';

// Deletes the local database so a new schema can be created; there is no in-place migration between schema versions.
assertSupportedRuntime();
if (!process.argv.includes('--yes')) { process.stderr.write('This deletes all local Agent Office data (password, sessions, messages, tasks). Re-run with: npm run wipe -- --yes\n'); process.exit(1); }
const config = loadConfig(); const lock = new DataLock(config.dataDir); lock.acquire();
try {
  const database = path.join(config.dataDir, 'agent-office.sqlite');
  for (const file of [database, `${database}-wal`, `${database}-shm`]) if (existsSync(file)) rmSync(file);
  process.stdout.write(`Wiped ${database}. Run npm run setup to create a new manager password.\n`);
} finally { lock.release(); }
