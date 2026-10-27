import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClaudeHook } from '../../src/adapters/claude/normalize-event.js';

test('Claude hooks normalize lifecycle and preserve stable ids', () => {
  const binding = { producerId: 'credential', agentId: 'agent', project: 'probe', sessionId: 'session', incarnation: 'inc' };
  const payload = { session_id: 'session', prompt_id: 'turn', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'tool-1' };
  const first = normalizeClaudeHook(payload, binding); const second = normalizeClaudeHook(payload, binding);
  assert.equal(first?.kind, 'tool.start'); assert.equal(first?.turnId, 'turn'); assert.equal(first?.invocationId, 'tool-1'); assert.equal(first?.id, second?.id);
});

test('unknown Claude hook events are ignored', () => {
  const event = normalizeClaudeHook({ session_id: 's', hook_event_name: 'FutureEvent' }, { producerId: 'c', agentId: 'a', project: 'p', sessionId: 's', incarnation: 'i' });
  assert.equal(event, null);
});
