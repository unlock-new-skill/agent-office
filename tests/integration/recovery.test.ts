import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, SCHEMA_VERSION } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';

test('manual backup and restore preserve manifest, generation and reset live state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-office-recovery-')); const data = path.join(root, 'data'); const backup = path.join(root, 'backup');
  const env = { ...process.env, AGENT_OFFICE_DATA_DIR: data };
  const run = (script: string, argument: string, directoryEnv = env): void => { execFileSync(process.execPath, ['--import', 'tsx', script, argument], { cwd: process.cwd(), env: directoryEnv, stdio: 'pipe' }); };
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/setup-local.ts'], { cwd: process.cwd(), env, input: 'correct horse battery staple\n', stdio: 'pipe' });
    const db = new Database({ filename: path.join(data, 'agent-office.sqlite') }); const store = new EventStore(db, () => undefined);
    store.append({ id: 'event-1', producerId: 'credential', producerIncarnation: 'inc-1', agentId: 'agent-1', project: 'probe', sessionId: 'session-1', incarnation: 'inc-1', source: 'claude', ts: new Date().toISOString(), kind: 'session.start' }); db.close();
    run('scripts/backup-local.ts', backup);
    const manifest = JSON.parse(readFileSync(path.join(backup, 'manifest.json'), 'utf8')) as { schema: number; sha256: string }; assert.equal(manifest.schema, SCHEMA_VERSION); assert.equal(manifest.sha256.length, 64);
    const restoredData = path.join(root, 'restored'); run('scripts/restore-local.ts', backup, { ...env, AGENT_OFFICE_DATA_DIR: restoredData });
    const restored = new Database({ filename: path.join(restoredData, 'agent-office.sqlite') }); const generation = (restored.raw.prepare("SELECT value FROM meta WHERE key='dataset_generation'").get() as { value: string }).value; const row = restored.raw.prepare('SELECT payload_json FROM events LIMIT 1').get() as { payload_json: string }; const payload = JSON.parse(row.payload_json) as { datasetGeneration: string };
    assert.equal(payload.datasetGeneration, generation); assert.equal((restored.raw.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }).count, 0); restored.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
