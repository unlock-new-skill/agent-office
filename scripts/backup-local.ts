import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from '../src/server/db/database.js';
import { DataLock } from '../src/server/data-lock.js';
import { loadConfig } from '../src/server/config.js';
import { assertSupportedRuntime } from '../src/server/runtime.js';
import { sha256File } from './file-hash.js';

assertSupportedRuntime();
const target = process.argv[2]; if (!target) throw new Error('usage: npm run backup -- <backup-directory>');
const config = loadConfig(); const source = path.join(config.dataDir, 'agent-office.sqlite'); if (!existsSync(source)) throw new Error(`database missing: ${source}`);
const lock = new DataLock(config.dataDir); lock.acquire();
try {
  const output = path.resolve(target); if (existsSync(output)) throw new Error('backup_output_exists');
  const parent = path.dirname(output); mkdirSync(parent, { recursive: true, mode: 0o700 }); const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 || (process.getuid && parentStat.uid !== process.getuid())) throw new Error('backup_parent_must_be_private');
  const temporaryOutput = `${output}.tmp-${process.pid}`; mkdirSync(temporaryOutput, { recursive: true, mode: 0o700 });
  try {
    const db = new Database({ filename: source }); let manifest: Record<string, unknown>;
    try {
      const generation = (db.raw.prepare("SELECT value FROM meta WHERE key='dataset_generation'").get() as { value: string }).value;
      const schema = (db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const integrity = (db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      if (integrity !== 'ok') throw new Error('database_integrity_failed');
      const purgeCount = (db.raw.prepare('SELECT COUNT(*) AS count FROM purge_suppressions').get() as { count: number }).count;
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); manifest = { schema, generation, purgeCount, createdAt: new Date().toISOString(), source: 'agent-office.sqlite' };
    } finally { db.close(); }
    const destination = path.join(temporaryOutput, 'agent-office.sqlite'); copyFileSync(source, destination); chmodSync(destination, 0o600);
    const sha256 = await sha256File(destination); writeFileSync(path.join(temporaryOutput, 'manifest.json'), JSON.stringify({ ...manifest!, sha256 }, null, 2), { mode: 0o600 });
    renameSync(temporaryOutput, output);
  } catch (error) { rmSync(temporaryOutput, { recursive: true, force: true }); throw error; }
  process.stdout.write(`Backup created at ${output}. Keep daemon stopped during restore.\n`);
} finally { lock.release(); }
