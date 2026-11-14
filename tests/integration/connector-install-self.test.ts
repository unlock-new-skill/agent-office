import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'vite';

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

test('install-self installs exactly the checked bytes, keeps a backup and a checkpoint, and refuses any other hash', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ao-install-self-'));
  try {
    // The real single-file bundle, as served at /connector/agent-office.mjs (same settings as scripts/build-connector.ts).
    const outDir = path.join(root, 'download');
    await build({ configFile: false, logLevel: 'silent', build: { ssr: 'src/connector/cli.ts', outDir, emptyOutDir: true, target: 'node20', minify: false, rollupOptions: { output: { format: 'es', entryFileNames: 'agent-office.mjs' } } }, ssr: { noExternal: true, target: 'node' } });
    const cli = path.join(outDir, 'agent-office.mjs');
    const home = path.join(root, 'ao'); const claudeDir = path.join(root, 'claude');
    mkdirSync(path.join(home, 'bin'), { recursive: true }); mkdirSync(claudeDir, { recursive: true });
    const target = path.join(home, 'bin', 'agent-office.mjs');
    writeFileSync(target, '// old connector agent-office.mjs\n'); const before = sha(target);
    writeFileSync(path.join(claudeDir, 'settings.json'), '{}\n');
    const env = { ...process.env, HOME: root, USERPROFILE: root, AGENT_OFFICE_HOME: home, CLAUDE_CONFIG_DIR: claudeDir };
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });

    const wrong = run('install-self', '--sha256', '0'.repeat(64));
    assert.equal(wrong.status, 1); assert.match(wrong.stderr, /nothing was changed/);
    assert.equal(sha(target), before, 'a wrong hash changes nothing');
    assert.deepEqual(readdirSync(home).filter(name => name.startsWith('rollout-')), []);

    const ok = run('install-self', '--sha256', sha(cli));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(sha(target), sha(cli), 'the installed connector is the checked file, byte for byte');
    const checkpointName = readdirSync(home).find(name => name.startsWith('rollout-'))!;
    const checkpoint = JSON.parse(readFileSync(path.join(home, checkpointName), 'utf8')) as { from: string; to: string; connectorBackup: string; settingsBackup: string | null; step: string };
    assert.equal(checkpoint.from, before); assert.equal(checkpoint.to, sha(cli));
    assert.equal(sha(checkpoint.connectorBackup), before, 'the backup holds the previous connector');
    assert.ok(checkpoint.settingsBackup && existsSync(checkpoint.settingsBackup), 'the settings backup written by sync-hooks is recorded');
    assert.equal(checkpoint.step, 'installed-no-service');
    assert.match(readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'), /agent-office\.mjs/, 'hooks point at the installed file');

    assert.equal(run('install-self').status, 1, 'the hash is required');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
