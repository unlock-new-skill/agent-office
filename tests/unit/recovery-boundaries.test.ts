import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';

test('committed event remains replayable when live publish fails', () => {
  const db = new Database({ filename: ':memory:' }); const store = new EventStore(db, () => { throw new Error('simulated_publish_failure'); });
  const event = store.append({ id: 'event-1', producerId: 'credential', producerIncarnation: 'inc-1', agentId: 'agent-1', project: 'probe', sessionId: 'session-1', incarnation: 'inc-1', source: 'claude', ts: new Date().toISOString(), kind: 'session.start' });
  assert.equal(store.replay(event.datasetGeneration, 0).length, 1); db.close();
});

test('purged sessions are excluded from replay', () => {
  const db = new Database({ filename: ':memory:' }); const store = new EventStore(db, () => undefined);
  const event = store.append({ id: 'event-1', producerId: 'credential', producerIncarnation: 'inc-1', agentId: 'agent-1', project: 'probe', sessionId: 'session-1', incarnation: 'inc-1', source: 'claude', ts: new Date().toISOString(), kind: 'session.start' });
  db.raw.prepare('INSERT INTO purge_suppressions(session_id,purged_at,generation) VALUES (?,?,?)').run('session-1', Date.now(), event.datasetGeneration);
  assert.equal(store.replay(event.datasetGeneration, 0).length, 0); db.close();
});
