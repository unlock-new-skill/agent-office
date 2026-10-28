import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent } from '../helpers/office-fixture.js';

test('seed builds departments, seats with descriptions, department channels and leaders channel', () => {
  const { office, close } = createSeededOffice(); const org = office.org.view();
  assert.deepEqual(org.departments.map(department => department.id), ['devops', 'dev', 'ba', 'design']);
  const count = (departmentId: string): number => org.seats.filter(seat => seat.departmentId === departmentId).length;
  assert.deepEqual([count('devops'), count('dev'), count('ba'), count('design')], [1, 6, 2, 5]);
  assert.match(org.seats.find(seat => seat.id === 'dev-docs')!.description, /trace/);
  const leaders = org.channels.find(channel => channel.kind === 'leaders')!;
  assert.deepEqual([...leaders.memberSeatIds].sort(), ['ba-lead', 'design-lead', 'dev-lead', 'ops-lead']);
  assert.equal(org.channels.find(channel => channel.id === 'dev')!.memberSeatIds.length, 6);
  close();
});

test('seed is a no-op when departments already exist', () => {
  const { office, close } = createSeededOffice();
  office.org.createDepartment({ name: 'QA', color: '#123456' });
  assert.equal(office.org.seedIfEmpty({ departments: [{ id: 'x', name: 'X', color: '#000000', seats: [] }] }), false);
  assert.equal(office.org.view().departments.length, 5);
  close();
});

test('department creation creates its channel; second leader is rejected', () => {
  const { office, close } = createSeededOffice();
  const qa = office.org.createDepartment({ name: 'QA Team', color: '#123456' });
  assert.equal(qa.id, 'qa-team');
  assert.ok(office.org.view().channels.some(channel => channel.id === 'qa-team' && channel.kind === 'department'));
  office.org.createSeat(qa.id, { title: 'QA Lead', role: 'leader', description: '' });
  assert.throws(() => office.org.createSeat(qa.id, { title: 'Another Lead', role: 'leader', description: '' }), /department_has_leader/);
  assert.ok(office.org.view().channels.find(channel => channel.id === 'leaders')!.memberSeatIds.includes('qa-lead'));
  close();
});

test('role change and seat deletion keep leaders channel membership in sync', () => {
  const { office, close } = createSeededOffice();
  const leaders = (): string[] => office.org.view().channels.find(channel => channel.id === 'leaders')!.memberSeatIds;
  office.org.updateSeat('ba-lead', { role: 'member' });
  assert.ok(!leaders().includes('ba-lead'));
  office.org.updateSeat('ba-docs', { role: 'leader' });
  assert.ok(leaders().includes('ba-docs'));
  office.org.deleteSeat('ba-docs');
  assert.ok(!leaders().includes('ba-docs'));
  assert.ok(!office.org.view().channels.find(channel => channel.id === 'ba')!.memberSeatIds.includes('ba-docs'));
  close();
});

test('agent assignment is unique per seat and blocks department deletion', () => {
  const { db, office, close } = createSeededOffice();
  const agentId = insertAgent(db, 'agent-1');
  office.org.assignAgent('dev-be', agentId);
  assert.equal(office.org.seatForAgent(agentId)?.id, 'dev-be');
  assert.throws(() => office.org.assignAgent('dev-fe', agentId), /agent_already_seated/);
  assert.throws(() => office.org.assignAgent('dev-fe', 'missing-agent'), /agent_not_found/);
  assert.throws(() => office.org.deleteDepartment('dev'), /department_has_seated_agents/);
  office.org.assignAgent('dev-be', null);
  assert.equal(office.org.seatForAgent(agentId), null);
  office.org.deleteDepartment('dev');
  assert.ok(!office.org.view().channels.some(channel => channel.id === 'dev'));
  close();
});

test('org mutations emit org collab events', () => {
  const { office, emitted, close } = createSeededOffice(); emitted.length = 0;
  office.org.updateDepartment('dev', { paused: true });
  assert.equal(emitted.at(-1)?.kind, 'org');
  assert.equal(office.org.view().departments.find(department => department.id === 'dev')!.paused, true);
  close();
});

test('claimSeat: vacant seat is claimed, live occupant rejects, ended occupant can be replaced, claiming moves seats', () => {
  const { db, office, close } = createSeededOffice();
  const first = insertAgent(db, 'agent-a'); const second = insertAgent(db, 'agent-b');
  assert.equal(office.org.claimSeat('dev-be', first).agentId, first);
  assert.equal(office.org.claimSeat('dev-be', first).agentId, first, 're-claim by the holder is idempotent');
  assert.throws(() => office.org.claimSeat('dev-be', second), /seat_occupied/);
  assert.throws(() => office.org.claimSeat('ghost', second), /seat_not_found/);
  office.org.claimSeat('dev-fe', first);
  assert.equal(office.org.seat('dev-be').agentId, null, 'claiming another seat releases the previous one');
  assert.equal(office.org.claimSeat('dev-be', second).agentId, second);
  db.raw.prepare("UPDATE agents SET ended_at='2026-01-01T00:00:00Z' WHERE id=?").run(second);
  const third = insertAgent(db, 'agent-c');
  assert.equal(office.org.claimSeat('dev-be', third).agentId, third, 'seat held by an exited session can be taken');
  const fourth = insertAgent(db, 'agent-d');
  assert.throws(() => office.org.claimSeat('dev-be', fourth), /seat_occupied/, 'a session that keeps in touch holds its seat');
  db.raw.prepare('UPDATE agents SET last_contact_at=? WHERE id=?').run(Date.now() - 6 * 60_000, third);
  assert.equal(office.org.claimSeat('dev-be', fourth).agentId, fourth, 'a session quiet for over 5 minutes (abandoned terminal) no longer holds its seat');
  office.org.releaseAgent(fourth);
  assert.equal(office.org.seat('dev-be').agentId, null);
  close();
});
