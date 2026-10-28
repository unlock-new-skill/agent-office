import assert from 'node:assert/strict';
import test from 'node:test';
import { CELL_H, CELL_W, hitTest, layoutOffice } from '../../src/client/map/office-map-layout.js';
import type { Department, Seat } from '../../src/shared/contracts.js';

const department = (id: string): Department => ({ id, name: id, color: '#22c55e', sort: 0, paused: false, deputySeatId: null });
const seat = (id: string, departmentId: string, role: 'leader' | 'member' = 'member', sort = 0): Seat => ({ id, departmentId, title: id, description: '', role, sort, agentId: null, consecutiveWakes: 0, wakeState: 'idle' });

test('rooms wrap to the available width, leader desk first, desks inside their room', () => {
  const seats = [seat('dev-be', 'dev', 'member', 1), seat('dev-lead', 'dev', 'leader'), seat('dev-fe', 'dev', 'member', 2), seat('dev-x', 'dev', 'member', 3), seat('ba-lead', 'ba', 'leader')];
  const wide = layoutOffice([department('dev'), department('ba')], seats, [], 2000);
  assert.equal(wide.rooms[0]!.y, wide.rooms[1]!.y, 'side by side when wide');
  const narrow = layoutOffice([department('dev'), department('ba')], seats, [], 200);
  assert.ok(narrow.rooms[1]!.y > narrow.rooms[0]!.y, 'stacked when narrow');
  const dev = narrow.rooms[0]!;
  assert.deepEqual(dev.desks.map(desk => desk.seatId), ['dev-lead', 'dev-be', 'dev-fe', 'dev-x']);
  assert.ok(dev.desks[0]!.leader);
  for (const desk of dev.desks) assert.ok(desk.x >= dev.x && desk.x + CELL_W <= dev.x + dev.w && desk.y + CELL_H <= dev.y + dev.h);
  for (const room of narrow.rooms) assert.ok(room.x + room.w <= narrow.width, "room inside layout width");
});

test('lobby holds unseated sessions and hit testing finds desks and lobby agents', () => {
  const layout = layoutOffice([department('dev')], [seat('dev-lead', 'dev', 'leader')], ['cc-1', 'cc-2'], 800);
  assert.equal(layout.lobby?.spots.length, 2);
  const desk = layout.rooms[0]!.desks[0]!;
  assert.deepEqual(hitTest(layout, desk.x + 5, desk.y + 5), { seatId: 'dev-lead' });
  const spot = layout.lobby!.spots[1]!;
  assert.deepEqual(hitTest(layout, spot.x + 5, spot.y + 5), { agentId: 'cc-2' });
  assert.equal(hitTest(layout, 0, 0), null);
  assert.equal(layoutOffice([], [], [], 800).lobby, null);
});

test('seat hashes are unsigned so palette lookups never go negative', async () => {
  const { seatHash } = await import('../../src/client/map/office-map-layout.js');
  for (const id of ['dev-lead', 'design-atom', 'cc-620a95bf022a', 'x', 'Character & Monster Designer']) {
    const hash = seatHash(id);
    assert.ok(hash >= 0 && (hash >>> 6) % 8 >= 0 && (hash >>> 3) % 6 >= 0);
  }
});

test('narrow viewports get two desks per row so rooms fit', () => {
  const seats = ['a', 'b', 'c'].map((id, index) => seat(id, 'dev', index === 0 ? 'leader' : 'member', index));
  const phone = layoutOffice([department('dev')], seats, [], 179);
  assert.ok(phone.width <= 179, `width ${phone.width}`);
  assert.equal(phone.rooms[0]!.desks[2]!.y > phone.rooms[0]!.desks[0]!.y, true, 'third desk wraps');
});

test('a larger gap spreads rooms apart', () => {
  const seats = [seat('a', 'x', 'leader'), seat('b', 'y', 'leader')];
  const tight = layoutOffice([department('x'), department('y')], seats, [], 2000);
  const wide = layoutOffice([department('x'), department('y')], seats, [], 2000, 48);
  const spacing = (layout: ReturnType<typeof layoutOffice>): number => layout.rooms[1]!.x - (layout.rooms[0]!.x + layout.rooms[0]!.w);
  assert.equal(spacing(tight), 16);
  assert.equal(spacing(wide), 48);
});
