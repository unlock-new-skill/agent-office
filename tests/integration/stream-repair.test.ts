import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';
import { WebSocketHub } from '../../src/server/websocket/hub.js';

test('stream repairs missed notifications without skipping committed events', (t) => {
  const db = new Database({ filename: ':memory:' });
  const hub = new WebSocketHub();
  t.after(() => { hub.close(); db.close(); });
  const frames: { type: string; seq?: number }[] = [];
  const socket = {
    readyState: 1, bufferedAmount: 0,
    send: (payload: string) => { frames.push(JSON.parse(payload) as { type: string; seq?: number }); },
    close: () => undefined, once: () => undefined,
  } as never;
  let dropNotification = true;
  const store = new EventStore(db, (delta) => {
    if (dropNotification) throw new Error('injected_notification_failure');
    hub.publish(delta);
  });
  const initial = store.snapshot();
  hub.subscribe(socket, 'manager-session', initial);
  const append = (id: string) => store.append({
    id, producerId: 'producer', producerIncarnation: 'run',
    agentId: 'agent', sessionId: 'session', incarnation: 'run', project: 'test',
    source: 'claude', kind: 'session.start', ts: '2026-10-24T00:00:00.000Z',
  });

  append('during-handoff');
  hub.activate(socket, store.replay(initial.generation, initial.seq));
  append('missed-live-event');
  dropNotification = false;
  append('later-live-event');
  hub.repair((generation, after) => store.replayPage(generation, after), () => store.snapshot());
  hub.repair((generation, after) => store.replayPage(generation, after), () => store.snapshot());

  assert.deepEqual(frames.filter(frame => frame.type === 'delta').map(frame => frame.seq), [1, 2, 3]);
});
