import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketHub } from '../../src/server/websocket/hub.js';
import type { Snapshot } from '../../src/shared/contracts.js';

const event = { id: 'event-1', ts: new Date().toISOString(), kind: 'session.start' as const, v: 1 as const, seq: 1, datasetGeneration: 'g1', source: 'claude' as const, producerId: 'agent-token', producerIncarnation: 'inc-1', agentId: 'agent-1', sessionId: 'session-1', incarnation: 'inc-1', sessionIncarnation: 'inc-1', project: 'probe' };
const snapshot: Snapshot = { generation: 'g1', seq: 0, agents: [] };

test('WebSocketHub buffers events during snapshot handoff and deduplicates watermark', () => {
  const messages: unknown[] = []; const socket = { readyState: 1, bufferedAmount: 0, send: (value: string) => messages.push(JSON.parse(value)), close: () => undefined, once: () => undefined } as never;
  const hub = new WebSocketHub(); hub.subscribe(socket, 'manager-session', snapshot); hub.publish({ type: 'delta', generation: 'g1', seq: 1, event }); hub.activate(socket, [{ type: 'delta', generation: 'g1', seq: 1, event }]);
  assert.deepEqual(messages.map(message => (message as { type: string }).type), ['snapshot', 'delta']);
});

test('WebSocketHub repair delivers missed committed events and advances watermark', () => {
  const messages: unknown[] = []; const socket = { readyState: 1, bufferedAmount: 0, send: (value: string) => messages.push(JSON.parse(value)), close: () => undefined, once: () => undefined } as never;
  const hub = new WebSocketHub(); hub.subscribe(socket, 'manager-session', snapshot); hub.activate(socket, []);
  hub.repair(() => ({ deltas: [{ type: 'delta', generation: 'g1', seq: 1, event }], nextAfter: null, highWater: 1 }), () => snapshot);
  assert.deepEqual(messages.map(message => (message as { type: string }).type), ['snapshot', 'delta']);
});

test('WebSocketHub closes revoked session subscribers', () => {
  let closeReason = ''; const socket = { readyState: 1, bufferedAmount: 0, send: () => undefined, close: (_code: number, reason: string) => { closeReason = reason; }, once: () => undefined } as never;
  const hub = new WebSocketHub(); hub.subscribe(socket, 'revoked-session', snapshot); hub.revokeSession('revoked-session'); assert.equal(closeReason, 'session_revoked');
});

test('WebSocketHub does not underflow aggregate buffer accounting on backpressure handoff', () => {
  let bufferedAmount = 0; const socket = { readyState: 1, get bufferedAmount() { return bufferedAmount; }, send: () => undefined, close: () => undefined, once: () => undefined } as never;
  const hub = new WebSocketHub(); hub.subscribe(socket, 'session', snapshot); hub.publish({ type: 'delta', generation: 'g1', seq: 1, event }); bufferedAmount = 2 * 1024 * 1024; hub.activate(socket, [{ type: 'delta', generation: 'g1', seq: 1, event }]);
  const state = hub as unknown as { bufferedBytes: number; bufferedDeltas: number }; assert.ok(state.bufferedBytes >= 0); assert.ok(state.bufferedDeltas >= 0);
});
