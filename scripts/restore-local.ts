import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database, SCHEMA_VERSION } from '../src/server/db/database.js';
import { DataLock } from '../src/server/data-lock.js';
import { loadConfig } from '../src/server/config.js';
import { assertSupportedRuntime } from '../src/server/runtime.js';
import { recoverRestore, writeRestoreJournal } from '../src/server/restore-recovery.js';
import { sha256File } from './file-hash.js';

assertSupportedRuntime();
const sourceDir = process.argv[2]; if (!sourceDir) throw new Error('usage: npm run restore -- <backup-directory>');
const backupDir = path.resolve(sourceDir); const source = path.join(backupDir, 'agent-office.sqlite'); const manifestPath = path.join(backupDir, 'manifest.json');
if (!existsSync(source) || !existsSync(manifestPath)) throw new Error('backup_manifest_or_database_missing');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { schema?: number; sha256?: string };
if (manifest.schema !== SCHEMA_VERSION || !manifest.sha256 || await sha256File(source) !== manifest.sha256) throw new Error('invalid_backup_manifest_or_checksum');
const config = loadConfig(); const lock = new DataLock(config.dataDir); lock.acquire();
try {
  recoverRestore(config.dataDir);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); const dirStat = lstatSync(config.dataDir);
  if (dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0 || (process.getuid && dirStat.uid !== process.getuid())) throw new Error('data_directory_must_be_private');
  const target = path.join(config.dataDir, 'agent-office.sqlite'); const temporary = `${target}.restore-${process.pid}`; const previous = `${target}.before-restore-${Date.now()}`;
  const currentPurges: Array<{ session_id: string; purged_at: number; generation: string }> = [];
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${target}${suffix}`;
    try {
      const stat = lstatSync(sidecar);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_database_sidecar');
      chmodSync(sidecar, 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  if (existsSync(target)) { const current = new Database({ filename: target }); try { currentPurges.push(...current.raw.prepare('SELECT session_id,purged_at,generation FROM purge_suppressions').all() as typeof currentPurges); } finally { current.close(); } }
  try {
    copyFileSync(source, temporary); chmodSync(temporary, 0o600);
    const restored = new Database({ filename: temporary });
    try {
      if ((restored.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') throw new Error('restored_integrity_failed');
      const generation = randomBytes(16).toString('hex');
      restored.transaction(() => {
        restored.raw.prepare("UPDATE meta SET value=? WHERE key='dataset_generation'").run(generation);
        restored.raw.prepare("UPDATE events SET generation=?,payload_json=json_set(payload_json,'$.datasetGeneration',?)").run(generation, generation);
        restored.raw.prepare('UPDATE purge_suppressions SET generation=?').run(generation);
        restored.raw.exec('DELETE FROM auth_sessions; DELETE FROM credentials; DELETE FROM permission_waits; DELETE FROM invocations; DELETE FROM turns; DELETE FROM agents;');
        for (const purge of currentPurges) restored.raw.prepare('INSERT INTO purge_suppressions(session_id,purged_at,generation) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET purged_at=MAX(purged_at,excluded.purged_at),generation=excluded.generation').run(purge.session_id, purge.purged_at, generation);
      });
    } finally { restored.close(); }
    for (const suffix of ['-wal', '-shm']) { const sidecar = `${temporary}${suffix}`; if (existsSync(sidecar)) unlinkSync(sidecar); }
    const oldFiles = [target, `${target}-wal`, `${target}-shm`].filter(existsSync); const oldNames = oldFiles.map(file => `${previous}${file.slice(target.length)}`);
    writeRestoreJournal(config.dataDir, { target, temporary, previous, oldFiles, oldNames });
    recoverRestore(config.dataDir);
    process.stdout.write(`Restored ${source}. Previous database retained at ${previous}. Credentials and live state reset; start daemon after review.\n`);
  } catch (error) {
    // A pending journal owns the staged files; restart recovery still needs them.
    if (!existsSync(path.join(config.dataDir, 'restore-journal.json'))) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${temporary}${suffix}`)) unlinkSync(`${temporary}${suffix}`);
      }
    }
    throw error;
  }
} finally { lock.release(); }
