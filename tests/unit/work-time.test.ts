import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent } from '../helpers/office-fixture.js';

const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 29, 8, 0) + minutes * 60_000).toISOString();

test('work time adds active gaps between events, caps idle gaps and skips stopped or waiting time', () => {
  const fixture = createSeededOffice(); const { org, trackWork } = fixture.office;
  org.assignAgent('dev-be', insertAgent(fixture.db, 'agent-be'));
  const minutes = (): number => org.seat('dev-be').workMs / 60_000;
  trackWork('agent-be', 'turn.start', at(0));
  trackWork('agent-be', 'tool.start', at(3));
  trackWork('agent-be', 'tool.done', at(10));
  assert.equal(minutes(), 10);
  // A turn that never sent a stop (process killed): only up to 15 min of the silence counts.
  trackWork('agent-be', 'turn.start', at(120));
  assert.equal(minutes(), 25);
  trackWork('agent-be', 'turn.stop', at(125));
  trackWork('agent-be', 'turn.start', at(300));
  assert.equal(minutes(), 30, 'time between a stop and the next turn is idle');
  trackWork('agent-be', 'permission.request', at(301));
  trackWork('agent-be', 'tool.done', at(340));
  assert.equal(minutes(), 31, 'waiting for a human decision is not work');
  trackWork('agent-be', 'tool.start', at(330));
  assert.equal(minutes(), 31, 'late, out-of-order events add nothing');
  fixture.close();
});
