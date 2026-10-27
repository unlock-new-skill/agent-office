import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOfficeHooks, hookCommand, mergeAgentOfficeHooks, removeAgentOfficeHooks, type ClaudeSettings } from '../../src/connector/installer.js';

const command = hookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a\\.agent-office\\bin\\agent-office.mjs');

test('hook command uses forward slashes and quotes paths with spaces', () => {
  assert.equal(command, '"C:/Program Files/nodejs/node.exe" "C:/Users/a/.agent-office/bin/agent-office.mjs" hook');
});

test('merge keeps other tools\' hooks and settings, replaces an older Agent Office install', () => {
  const existing: ClaudeSettings = {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/claude-hook.js', timeout: 600 }, { type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    },
  };
  const merged = mergeAgentOfficeHooks(existing, agentOfficeHooks(command, 120));
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.hooks?.Stop?.map(entry => entry.hooks.map(hook => hook.command)), [['say done'], [command]]);
  assert.equal(merged.hooks?.PreToolUse?.length, 2);
  assert.equal(merged.hooks?.PermissionRequest?.[0]?.hooks[0]?.timeout, 135);
  assert.deepEqual(mergeAgentOfficeHooks(merged, agentOfficeHooks(command, 120)), merged, 'idempotent');
});

test('remove drops only our hooks and empty events', () => {
  const merged = mergeAgentOfficeHooks({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'guard.sh' }] }] } }, agentOfficeHooks(command, 0));
  assert.deepEqual(removeAgentOfficeHooks(merged), { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'guard.sh' }] }] } });
  assert.deepEqual(removeAgentOfficeHooks(mergeAgentOfficeHooks({}, agentOfficeHooks(command, 0))), {});
});
