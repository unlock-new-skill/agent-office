import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';

const event = (kind: 'session.start' | 'turn.start' | 'permission.request' | 'tool.start' | 'tool.done', patch: Record<string, string> = {}) => ({
  id: `${kind}-${Math.random()}`, producerId: 'credential-1', producerIncarnation: 'inc-1', agentId: 'agent-1', sessionId: 'session-1', incarnation: 'inc-1', project: 'probe', source: 'claude' as const, ts: new Date().toISOString(), kind, ...patch,
});

test('stale incarnation cannot mutate current agent projection', () => {
  const db = new Database({ filename: ':memory:' });
  const store = new EventStore(db, () => undefined);
  store.append(event('session.start'));
  assert.doesNotThrow(() => store.append({ ...event('session.start', { id: 'stale', }), producerIncarnation: 'inc-2', incarnation: 'inc-2', sessionId: 'session-2' }));
  assert.equal(store.snapshot().agents[0]?.sessionId, 'session-1');
  assert.equal(store.replay(store.snapshot().generation, 1).length, 1);
  db.close();
});

test('unmatched tool completion does not clear unknown permission wait', () => {
  const db = new Database({ filename: ':memory:' });
  const store = new EventStore(db, () => undefined);
  store.append(event('session.start'));
  store.append({ ...event('permission.request'), id: 'permission', turnId: 'turn-1' });
  store.append({ ...event('turn.start'), id: 'turn', turnId: 'turn-1' });
  store.append({ ...event('tool.start'), id: 'tool-start', turnId: 'turn-1', invocationId: 'invocation-1', tool: 'Read' });
  store.append({ ...event('tool.done'), id: 'tool-done', turnId: 'turn-1', invocationId: 'invocation-1', tool: 'Read' });
  assert.equal(store.snapshot().agents[0]?.pendingPermissions, 1);
  db.close();
});

test('summary is redacted before persistence and replay', () => {
  const db = new Database({ filename: ':memory:' });
  const store = new EventStore(db, () => undefined);
  const result = store.append({ ...event('session.start'), summary: 'token=secret-value password:"secret" api_key:"abc"' });
  const expected = 'token=[REDACTED] password:"[REDACTED]" api_key:"[REDACTED]"';
  assert.equal(result.summary, expected);
  assert.equal(store.replay(result.datasetGeneration, 0)[0]?.event.summary, expected);
  const escaped = store.append({ ...event('session.start'), id: 'escaped', summary: '{"token":"sec\\\"ret"}' });
  assert.equal(escaped.summary, '{"token":"[REDACTED]"}');
  db.close();
});
