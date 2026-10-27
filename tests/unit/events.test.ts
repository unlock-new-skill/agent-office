import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';

const baseEvent = {
  id: 'event-1', producerId: 'connector-1', producerIncarnation: 'run-1',
  agentId: 'agent-1', sessionId: 'session-1', incarnation: 'run-1', project: 'probe',
  ts: new Date().toISOString(), source: 'claude' as const, kind: 'session.start' as const,
};

test('EventStore assigns sequence and deduplicates identical retries', () => {
  const db = new Database({ filename: ':memory:' });
  const deltas: unknown[] = [];
  const store = new EventStore(db, delta => deltas.push(delta));
  const first = store.append(baseEvent);
  const retry = store.append(baseEvent);
  assert.equal(first.seq, 1);
  assert.deepEqual(retry, first);
  assert.equal(deltas.length, 1);
  assert.equal(store.snapshot().agents[0]?.state, 'online');
  db.close();
});

test('EventStore rejects conflicting event reuse', () => {
  const db = new Database({ filename: ':memory:' });
  const store = new EventStore(db, () => undefined);
  store.append(baseEvent);
  assert.throws(() => store.append({ ...baseEvent, kind: 'session.end' }), /conflicting_event/);
  db.close();
});
