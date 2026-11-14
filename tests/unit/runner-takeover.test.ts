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
  const timed = () => [...processes.map(entry => ({ ...entry, created: '2026-11-14T15:00:00.0000000+07:00' })), { pid: process.pid, commandLine: processes[0]!.commandLine, created: '2026-11-14T16:00:00.0000000+07:00' }];
  assert.deepEqual(endOlderRunners(script, line => lines.push(line), { platform: 'win32', list: timed, kill: pid => { killed.push(pid); } }), [10, 15]);
  assert.deepEqual(killed, [10, 15]); assert.equal(lines.length, 2);
  assert.throws(() => endOlderRunners(script, () => undefined, { platform: 'win32', list: timed, kill: () => { throw new Error('access denied'); } }), /Not starting a second runner/);
  assert.deepEqual(endOlderRunners(script, () => undefined, { platform: 'darwin', list: () => processes, kill: () => assert.fail('never on macOS') }), []);
  assert.throws(() => endOlderRunners(script, () => undefined, { platform: 'win32', list: () => { throw new Error('no powershell'); } }), /Not starting/, 'not knowing whether another runner runs is not a reason to start a second one');
});

test('a runner only ends runners started before it, so two starting together never end each other', () => {
  const self = process.pid; const killed: number[] = [];
  const line = '"node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" runner';
  const list = () => [
    { pid: self, commandLine: line, created: '2026-11-14T16:00:10.0000000+07:00' },
    { pid: 21, commandLine: line, created: '2026-11-14T15:00:00.0000000+07:00' },
    { pid: 22, commandLine: line, created: '2026-11-14T16:00:20.0000000+07:00' },
  ];
  assert.deepEqual(endOlderRunners(script, () => undefined, { platform: 'win32', list, kill: pid => { killed.push(pid); } }), [21]);
  assert.deepEqual(killed, [21]);
});

test('a runner without a creation time cannot be ordered: refuse to start instead of ending a maybe newer runner', () => {
  const self = process.pid; const line = '"node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" runner';
  const kill = () => assert.fail('nothing may be ended');
  assert.throws(() => endOlderRunners(script, () => undefined, { platform: 'win32', kill, list: () => [{ pid: self, commandLine: line, created: '2026-11-14T16:00:10.0000000+07:00' }, { pid: 31, commandLine: line }] }), /no creation time for runner 31.*Not starting/);
  assert.throws(() => endOlderRunners(script, () => undefined, { platform: 'win32', kill, list: () => [{ pid: self, commandLine: line }, { pid: 31, commandLine: line, created: '2026-11-14T16:00:10.0000000+07:00' }] }), /no creation time for this runner/);
  assert.deepEqual(endOlderRunners(script, () => undefined, { platform: 'win32', kill, list: () => [{ pid: self, commandLine: line }] }), [], 'alone, nothing to order');
});

test('two runners created in the same millisecond: exactly one ends the other (lower pid is the older)', () => {
  const self = process.pid; const line = '"node.exe" "C:\\Users\\tr\\.agent-office\\bin\\agent-office.mjs" runner'; const at = '2026-11-14T16:00:10.1234567+07:00';
  const list = () => [{ pid: self, commandLine: line, created: at }, { pid: self - 1, commandLine: line, created: at }, { pid: self + 1, commandLine: line, created: at }];
  const killed: number[] = [];
  assert.deepEqual(endOlderRunners(script, () => undefined, { platform: 'win32', list, kill: pid => { killed.push(pid); } }), [self - 1]);
  assert.deepEqual(killed, [self - 1]);
});
