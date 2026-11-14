import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installConnector, sha256, type InstallCheckpoint, type InstallDeps } from '../../src/connector/connector-install.js';

const OLD = Buffer.from('// old agent-office.mjs\n'); const NEW = Buffer.from('// new agent-office.mjs\n');
const setup = () => {
  const home = mkdtempSync(path.join(tmpdir(), 'ao-install-')); mkdirSync(path.join(home, 'bin'));
  const target = path.join(home, 'bin', 'agent-office.mjs'); writeFileSync(target, OLD);
  let clock = Date.parse('2026-11-14T10:00:00Z');
  const calls: string[] = [];
  const deps = (over: Partial<InstallDeps> = {}): InstallDeps => ({
    source: NEW, home, pinned: sha256(NEW), now: () => new Date(clock),
    syncHooks: () => { calls.push('sync'); return path.join(home, 'settings.bak'); },
    restart: () => { calls.push('restart'); return true; },
    sleep: async ms => { clock += ms; }, ...over,
  });
  const checkpoint = (): InstallCheckpoint => JSON.parse(readFileSync(path.join(home, readdirSync(home).find(name => name.startsWith('rollout-') && name.endsWith('.json'))!), 'utf8')) as InstallCheckpoint;
  return { home, target, deps, calls, checkpoint, close: () => rmSync(home, { recursive: true, force: true }) };
};

test('a hash mismatch changes nothing at all: no checkpoint, no backup, no hooks, no restart', async () => {
  const t = setup();
  await assert.rejects(installConnector(t.deps({ pinned: sha256(OLD) })), /nothing was changed/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.deepEqual(readdirSync(t.home).sort(), ['bin']); assert.deepEqual(readdirSync(path.join(t.home, 'bin')), ['agent-office.mjs']); assert.deepEqual(t.calls, []);
  t.close();
});

test('happy path: checkpoint first, exclusive backup of the old bytes, exactly the checked bytes installed, then hooks and restart', async () => {
  const t = setup();
  const record = await installConnector(t.deps());
  assert.deepEqual(readFileSync(t.target), NEW);
  assert.equal(record.step, 'restarted'); assert.equal(record.from, sha256(OLD)); assert.equal(record.to, sha256(NEW));
  assert.deepEqual(readFileSync(record.connectorBackup!), OLD); assert.equal(record.settingsBackup, path.join(t.home, 'settings.bak'));
  assert.deepEqual(t.checkpoint(), record, 'the file on disk holds the same record');
  assert.deepEqual(t.calls, ['sync', 'restart']);
  t.close();
});

test('an existing backup name is never overwritten: it stops before touching anything', async () => {
  const t = setup();
  writeFileSync(`${t.target}.bak-20261114T100000`, 'someone else\'s backup');
  await assert.rejects(installConnector(t.deps()), /already exists; nothing was changed/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.equal(readFileSync(`${t.target}.bak-20261114T100000`, 'utf8'), 'someone else\'s backup'); assert.deepEqual(t.calls, []);
  t.close();
});

test('a failure while syncing hooks or restarting stops there, is recorded, and is not retried', async () => {
  const t = setup();
  await assert.rejects(installConnector(t.deps({ syncHooks: () => { t.calls.push('sync'); throw new Error('settings locked'); } })), /settings locked/);
  assert.equal(t.checkpoint().step, 'failed'); assert.match(t.checkpoint().detail, /settings locked/);
  assert.deepEqual(readFileSync(t.target), NEW, 'the checked connector stays installed; the backup is recorded for a rollback');
  assert.deepEqual(t.calls, ['sync'], 'no restart and no second attempt');
  t.close();
  const u = setup();
  await assert.rejects(installConnector(u.deps({ restart: () => { u.calls.push('restart'); throw new Error('schtasks missing'); } })), /schtasks missing/);
  assert.equal(u.checkpoint().step, 'failed'); assert.deepEqual(u.calls, ['sync', 'restart']);
  u.close();
});

test('if the executor is cut off during the restart, the checkpoint already says restarting with the old runner pids', async () => {
  const t = setup();
  let seen: InstallCheckpoint | null = null; let phase = 'before';
  const runners = () => new Map(phase === 'before' ? [[41, '41@a'], [42, '42@b']] : [[77, '77@c']]);
  await installConnector(t.deps({ runners, restart: () => { seen = t.checkpoint(); phase = 'after'; return true; } }));
  assert.equal(seen!.step, 'restarting'); assert.match(seen!.detail, /41,42/); assert.ok(seen!.connectorBackup && existsSync(seen!.connectorBackup));
  assert.equal(t.checkpoint().step, 'taken-over', 'old runners gone and a new one running'); assert.match(t.checkpoint().detail, /77/);
  t.close();
});

test('listing the runners fails before anything changes: nothing is installed', async () => {
  const t = setup();
  await assert.rejects(installConnector(t.deps({ runners: () => { throw new Error('powershell failed'); } })), /powershell failed/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.deepEqual(readdirSync(t.home).sort(), ['bin']); assert.deepEqual(t.calls, []);
  t.close();
});

test('Windows: old runner still there after the wait: a late new runner is ended first, then connector and settings are put back', async () => {
  const t = setup(); const restored: string[] = []; const ended: number[] = []; let phase = 'before';
  const runners = () => new Map<number, string>(phase === 'before' ? [[41, '41@a']] : ended.includes(77) ? [[41, '41@a']] : [[41, '41@a'], [77, '77@c']]);
  const record = await installConnector(t.deps({ runners, endRunner: pid => ended.push(pid), restart: () => { t.calls.push('restart'); phase = 'after'; return true; }, restoreSettings: backup => restored.push(backup), takeoverWaitMs: 10_000 }));
  assert.equal(record.step, 'rolled-back'); assert.deepEqual(ended, [77], 'the new runner cannot take over late');
  assert.deepEqual(readFileSync(t.target), OLD); assert.deepEqual(restored, [path.join(t.home, 'settings.bak')]);
  assert.deepEqual(t.calls, ['sync', 'restart'], 'the old runner keeps running; nothing restarted again');
  t.close();
});

test('Windows: old runner gone but no new runner (it failed after ending the old one): previous version restored and started once', async () => {
  const t = setup(); let phase = 'before';
  const runners = () => new Map<number, string>(phase === 'before' ? [[41, '41@a']] : []);
  const record = await installConnector(t.deps({ runners, endRunner: () => assert.fail('nothing to end'), restart: () => { t.calls.push('restart'); phase = 'after'; return true; }, takeoverWaitMs: 4000 }));
  assert.equal(record.step, 'rolled-back'); assert.match(record.detail, /started the previous version once/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.deepEqual(t.calls, ['sync', 'restart', 'restart'], 'exactly one start of the previous version, no loop');
  t.close();
});

test('no runner service: installed and said so, nothing restarted', async () => {
  const t = setup();
  const record = await installConnector(t.deps({ restart: () => false }));
  assert.equal(record.step, 'installed-no-service'); assert.deepEqual(readFileSync(t.target), NEW);
  t.close();
});

test('Windows rollback: a new runner that only appears while the files are put back is ended too, and recorded', async () => {
  const t = setup(); const ended: number[] = []; let phase = 'before'; let restoring = false;
  const runners = () => new Map<number, string>(phase === 'before' || !restoring || ended.includes(88) ? [[41, '41@a']] : [[41, '41@a'], [88, '88@d']]);
  const record = await installConnector(t.deps({ runners, endRunner: pid => ended.push(pid), restart: () => { t.calls.push('restart'); phase = 'after'; return true; }, restoreSettings: () => { restoring = true; }, takeoverWaitMs: 4000 }));
  assert.equal(record.step, 'rolled-back'); assert.deepEqual(ended, [88]); assert.match(record.detail, /ended new runner 88/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.deepEqual(t.calls, ['sync', 'restart']);
  t.close();
});

test('Windows rollback: runners that cannot be listed while waiting still get the previous connector and settings back, without a blind restart', async () => {
  const t = setup(); let phase = 'before'; const restored: string[] = [];
  const runners = () => { if (phase === 'before') return new Map([[41, '41@a']]); throw new Error('powershell gone'); };
  const record = await installConnector(t.deps({ runners, endRunner: () => assert.fail('nothing listed, nothing ended'), restart: () => { t.calls.push('restart'); phase = 'after'; return true; }, restoreSettings: backup => restored.push(backup), takeoverWaitMs: 4000 }));
  assert.equal(record.step, 'rolled-back'); assert.match(record.detail, /the runners could not be listed.*could not list the runners/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.equal(restored.length, 1);
  assert.deepEqual(t.calls, ['sync', 'restart'], 'not knowing what runs is not a reason to start another runner');
  t.close();
});

test('Windows rollback: a new runner that cannot be ended does not stop the restore; it is recorded and nothing is started', async () => {
  const t = setup(); let phase = 'before';
  const runners = () => new Map<number, string>(phase === 'before' ? [[41, '41@a']] : [[41, '41@a'], [77, '77@c']]);
  const record = await installConnector(t.deps({ runners, endRunner: () => { throw new Error('process not found'); }, restart: () => { t.calls.push('restart'); phase = 'after'; return true; }, restoreSettings: () => undefined, takeoverWaitMs: 4000 }));
  assert.equal(record.step, 'rolled-back'); assert.match(record.detail, /ended new runner none.*could not end new runner 77/);
  assert.deepEqual(readFileSync(t.target), OLD); assert.deepEqual(t.calls, ['sync', 'restart']);
  t.close();
});

test('Windows rollback with no previous connector says so instead of claiming a restore', async () => {
  const t = setup(); rmSync(t.target);
  const record = await installConnector(t.deps({ runners: () => new Map(), endRunner: () => assert.fail('nothing to end'), restoreSettings: () => undefined, takeoverWaitMs: 4000 }));
  assert.equal(record.step, 'rolled-back'); assert.match(record.detail, /no previous connector to restore; the new one stays, previous settings restored/);
  assert.deepEqual(readFileSync(t.target), NEW); assert.deepEqual(t.calls, ['sync', 'restart']);
  t.close();
});
