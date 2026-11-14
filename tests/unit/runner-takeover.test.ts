import assert from 'node:assert/strict';
import test from 'node:test';
import { endOlderRunners, olderRunners } from '../../src/connector/runner/runner-takeover.js';

const script = 'C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs';
const processes = [
  { pid: 10, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" runner' },
  { pid: 11, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" runner watch dev-fe' },
  { pid: 12, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" mcp' },
  { pid: 13, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" update' },
  { pid: 14, commandLine: 'node C:\\game\\server.js runner' },
  { pid: 15, commandLine: 'node C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs runner ' },
];

test('only plain `runner` processes of this connector count as older runners, never this one or its helpers', () => {
  assert.deepEqual(olderRunners(processes, script, 99), [10, 15]);
  assert.deepEqual(olderRunners(processes, script, 10), [15], 'the runner itself is never ended');
});

test('a starting runner on Windows ends older runners with their seats; it refuses to start when one survives', () => {
  const killed: number[] = []; const lines: string[] = [];
  assert.deepEqual(endOlderRunners(script, line => lines.push(line), { platform: 'win32', list: () => processes, kill: pid => { killed.push(pid); } }), [10, 15]);
  assert.deepEqual(killed, [10, 15]); assert.equal(lines.length, 2);
  assert.throws(() => endOlderRunners(script, () => undefined, { platform: 'win32', list: () => processes, kill: () => { throw new Error('access denied'); } }), /Not starting a second runner/);
  assert.deepEqual(endOlderRunners(script, () => undefined, { platform: 'darwin', list: () => processes, kill: () => assert.fail('never on macOS') }), []);
  const logged: string[] = [];
  assert.deepEqual(endOlderRunners(script, line => logged.push(line), { platform: 'win32', list: () => { throw new Error('no powershell'); } }), []);
  assert.match(logged[0] ?? '', /starting anyway/);
});
