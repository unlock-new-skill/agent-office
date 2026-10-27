import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';

test('replay returns continuation cursor for large histories', () => {
  const db = new Database({ filename: ':memory:' }); const store = new EventStore(db, () => undefined);
  for (let i = 0; i < 501; i++) store.append({ id: `event-${i}`, producerId: 'credential', producerIncarnation: 'inc-1', agentId: 'agent', sessionId: 'session', incarnation: 'inc-1', project: 'probe', source: 'claude', ts: new Date().toISOString(), kind: 'session.start' });
  const generation = store.snapshot().generation;
  const first = store.replayPage(generation, 0, 500); const second = store.replayPage(generation, first.nextAfter!, 500);
  assert.equal(first.deltas.length, 500); assert.equal(first.hasMore, true); assert.equal(second.deltas.length, 1); assert.equal(second.hasMore, false);
  assert.throws(() => store.replayPage(generation, 9999), /cursor_future/); db.close();
});
