import assert from 'node:assert/strict';
import test from 'node:test';
import { keptEnv, servicePlan } from '../../src/connector/runner/runner-service-install.js';

const env = { PATH: '/usr/local/bin:/usr/bin', HTTPS_PROXY: 'http://proxy:3128' };

test('only an allowlist of environment variables is kept; API tokens never reach service files', () => {
  assert.deepEqual(keptEnv({ PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', HTTPS_PROXY: 'http://p' }), { PATH: '/bin', HTTPS_PROXY: 'http://p' });
});

test('macOS: launchd agent that runs the runner at login and keeps it alive', () => {
  const plan = servicePlan('darwin', '/opt/node/bin/node', '/Users/me/.agent-office/bin/agent-office.mjs', '/Users/me/.agent-office', env, 501);
  assert.match(plan.file, /Library\/LaunchAgents\/dev\.agent-office\.runner\.plist$/);
  assert.match(plan.content, /<string>\/opt\/node\/bin\/node<\/string><string>\/Users\/me\/\.agent-office\/bin\/agent-office\.mjs<\/string><string>runner<\/string>/);
  assert.match(plan.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plan.content, /<key>HTTPS_PROXY<\/key><string>http:\/\/proxy:3128<\/string>/);
  assert.deepEqual(plan.activate.at(-1), ['launchctl', 'bootstrap', 'gui/501', plan.file]);
  assert.deepEqual(plan.restart, [['launchctl', 'kickstart', '-k', 'gui/501/dev.agent-office.runner']]);
});

test('Linux: systemd user unit with automatic restart', () => {
  const plan = servicePlan('linux', '/usr/bin/node', '/home/me/.agent-office/bin/agent-office.mjs', '/home/me/.agent-office', env);
  assert.match(plan.file, /systemd\/user\/agent-office-runner\.service$/);
  assert.match(plan.content, /ExecStart="\/usr\/bin\/node" "\/home\/me\/\.agent-office\/bin\/agent-office\.mjs" runner/);
  assert.match(plan.content, /Restart=always/);
  assert.match(plan.content, /Environment="PATH=\/usr\/local\/bin:\/usr\/bin"/);
  assert.deepEqual(plan.activate.at(-1), ['systemctl', '--user', 'enable', '--now', 'agent-office-runner.service']);
});

test('Windows: hidden logon task running a launcher that appends to the runner log', () => {
  const plan = servicePlan('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.agent-office\\bin\\agent-office.mjs', 'C:\\Users\\me\\.agent-office', { PATH: 'C:\\Windows' });
  assert.match(plan.content, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\me\\\.agent-office\\bin\\agent-office\.mjs" runner >> ".*runner\.log" 2>&1/);
  assert.match(plan.content, /set "PATH=C:\\Windows"/);
  assert.match(plan.extraFiles![0]!.content, /Wscript\.Shell"\)\.Run """.*runner\.cmd""", 0, False/);
  assert.equal(plan.activate[0]![0], 'schtasks'); assert.ok(plan.activate[0]!.includes('ONLOGON'));
});

test('web-managed folders must exist and lie inside the allowed roots', async () => {
  const { cwdProblem } = await import('../../src/connector/runner/runner-config.js');
  const { mkdtempSync, mkdirSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'ao-roots-')); mkdirSync(path.join(root, 'game'));
  assert.equal(cwdProblem(path.join(root, 'game'), [root]), null);
  assert.equal(cwdProblem(root, [root]), null);
  assert.match(cwdProblem(path.join(root, 'missing'), [root])!, /folder not found/);
  assert.match(cwdProblem(tmpdir(), [path.join(root, 'game')])!, /outside the folders/);
  assert.match(cwdProblem(path.join(root, 'game', '..', '..'), [root])!, /outside the folders/);
});
