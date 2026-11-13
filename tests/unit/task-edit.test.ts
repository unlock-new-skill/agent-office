import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const seatAll = (fixture: Fixture, seatIds: string[]): void => { for (const seatId of seatIds) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`)); };
/** A PM seat flagged coordinator by the manager (not through the env). */
const withPm = (fixture: Fixture): void => {
  fixture.office.org.createDepartment({ id: 'pmo', name: 'PMO', color: '#64748b' });
  fixture.office.org.createSeat('pmo', { id: 'pm-live', title: 'PM', description: '', role: 'leader', coordinator: true });
};
const lastLine = (fixture: Fixture, channelId: string) => fixture.office.messages.list(manager, channelId).at(-1)!;

test('a coordinator flagged on the seat reads every department; others get forbidden_task_read, not a change error', () => {
  const fixture = createSeededOffice(); withPm(fixture); const { tasks, org } = fixture.office;
  tasks.create(seat('dev-lead'), { title: 'Login', body: REQ, assigneeSeatId: 'dev-be' });
  assert.equal(org.seat('pm-live').coordinator, true);
  assert.equal(tasks.list(seat('pm-live'), { departmentId: 'dev' }).length, 1);
  assert.equal(tasks.read(seat('pm-live'), 't-dev-1').task.id, 't-dev-1');
  assert.throws(() => tasks.list(seat('ba-docs'), { departmentId: 'dev' }), /forbidden_task_read/);
  assert.throws(() => tasks.read(seat('ba-docs'), 't-dev-1'), /forbidden_task_read/);
  assert.throws(() => tasks.update(seat('ba-docs'), 't-dev-1', { status: 'doing' }), /forbidden_task_change/);
  org.updateSeat('pm-live', { coordinator: false });
  assert.throws(() => tasks.list(seat('pm-live'), { departmentId: 'dev' }), /forbidden_task_read/);
  fixture.close();
});

test('the env coordinator keeps its rights and joins #leaders', () => {
  const fixture = createSeededOffice({ coordinatorSeatId: 'ba-docs' }); const { tasks, org } = fixture.office;
  tasks.create(seat('dev-lead'), { title: 'Login', body: REQ, assigneeSeatId: 'dev-be' });
  assert.equal(org.seat('ba-docs').coordinator, true);
  assert.equal(tasks.list(seat('ba-docs'), { departmentId: 'dev' }).length, 1);
  assert.ok(org.isMember('leaders', 'ba-docs'));
  fixture.close();
});

test('the PM assigns an unassigned task in place: same id, audit with source, the new owner told once', () => {
  const fixture = createSeededOffice(); withPm(fixture); seatAll(fixture, ['dev-lead', 'dev-be', 'pm-live']); const { tasks, wake } = fixture.office;
  const task = tasks.create(seat('dev-lead'), { title: 'Probe', body: REQ, assigneeSeatId: 'dev-fe' });
  const unassigned = tasks.update(seat('dev-lead'), task.id, { assigneeSeatId: null, expectedRevision: task.revision }, 'mcp');
  assert.equal(unassigned.assigneeSeatId, null); assert.equal(unassigned.revision, 1);
  wake.check('dev-be'); // nothing for dev-be yet
  const assigned = tasks.update(seat('pm-live'), task.id, { assigneeSeatId: 'dev-be', expectedRevision: 1, reason: 'owner missing' }, 'mcp');
  assert.equal(assigned.id, task.id); assert.equal(assigned.assigneeSeatId, 'dev-be'); assert.equal(tasks.list(manager, {}).length, 1, 'no copy created');
  const line = lastLine(fixture, 'dev');
  assert.deepEqual(line.mentions, ['dev-be']); assert.match(line.body, /Reassigned to @dev-be/); assert.match(line.body, /Reason: owner missing/);
  const changes = tasks.changes(task.id);
  assert.deepEqual(changes.map(change => [change.field, change.before, change.after, change.source, change.actorId]), [['assigneeSeatId', 'dev-fe', null, 'mcp', 'dev-lead'], ['assigneeSeatId', null, 'dev-be', 'mcp', 'pm-live']]);
  assert.equal(changes[1]!.reason, 'owner missing');
  fixture.close();
});

test('a stale revision conflicts with the current task and loses nothing', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  const dep = tasks.create(seat('dev-lead'), { title: 'Schema', body: REQ, assigneeSeatId: 'dev-be' });
  const task = tasks.create(seat('dev-lead'), { title: 'API', body: REQ, assigneeSeatId: 'dev-fe' });
  tasks.update(seat('dev-lead'), task.id, { dependsOn: [dep.id], expectedRevision: 0 });
  assert.throws(() => tasks.update(manager, task.id, { assigneeSeatId: 'dev-unity', expectedRevision: 0 }, 'ui'), (error: Error & { details?: { task?: { revision: number } } }) => error.message === 'stale_revision' && error.details?.task?.revision === 1);
  const current = tasks.get(task.id);
  assert.deepEqual(current.dependsOn, [dep.id]); assert.equal(current.assigneeSeatId, 'dev-fe');
  fixture.close();
});

test('invalid edits are refused whole: cycle, missing task, assignee outside, member editing leader fields', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  const a = tasks.create(seat('dev-lead'), { title: 'A', body: REQ, assigneeSeatId: 'dev-be' });
  const b = tasks.create(seat('dev-lead'), { title: 'B', body: REQ, assigneeSeatId: 'dev-be', dependsOn: [a.id] });
  assert.throws(() => tasks.update(seat('dev-lead'), a.id, { title: 'A2', dependsOn: [b.id] }), /dependency_cycle/);
  assert.throws(() => tasks.update(seat('dev-lead'), a.id, { title: 'A2', dependsOn: ['t-dev-99'] }), /task_not_found/);
  assert.throws(() => tasks.update(seat('dev-lead'), a.id, { title: 'A2', assigneeSeatId: 'ba-docs' }), /assignee_outside_department/);
  assert.throws(() => tasks.update(seat('dev-lead'), a.id, { title: 'A2', assigneeSeatId: 'ghost' }), /seat_not_found/);
  assert.throws(() => tasks.update(seat('dev-be'), a.id, { title: 'mine now' }), /leader_only/);
  const after = tasks.get(a.id);
  assert.equal(after.title, 'A'); assert.equal(after.revision, 0); assert.equal(tasks.changes(a.id).length, 0);
  fixture.close();
});

test('fields left out keep their value; dependsOn [] clears only when sent', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  const a = tasks.create(seat('dev-lead'), { title: 'A', body: REQ, assigneeSeatId: 'dev-be' });
  const b = tasks.create(seat('dev-lead'), { title: 'B', body: REQ, assigneeSeatId: 'dev-be', dependsOn: [a.id], estimateMinutes: 90 });
  const renamed = tasks.update(seat('dev-lead'), b.id, { title: 'B renamed' });
  assert.deepEqual(renamed.dependsOn, [a.id]); assert.equal(renamed.estimateMinutes, 90); assert.equal(renamed.assigneeSeatId, 'dev-be'); assert.equal(renamed.body, REQ);
  assert.deepEqual(tasks.update(seat('dev-lead'), b.id, { dependsOn: [] }).dependsOn, []);
  fixture.close();
});

test('execution starts only with an estimate up to 4h; tracking keeps a big estimate untouched', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  const big = tasks.create(seat('dev-lead'), { title: 'Big', body: REQ, assigneeSeatId: 'dev-be', kind: 'execution', estimateMinutes: 300 });
  assert.throws(() => tasks.update(seat('dev-be'), big.id, { status: 'doing' }), /execution_estimate_required/);
  const none = tasks.create(seat('dev-lead'), { title: 'None', body: REQ, assigneeSeatId: 'dev-be', kind: 'execution' });
  assert.throws(() => tasks.update(seat('dev-be'), none.id, { status: 'doing' }), /execution_estimate_required/);
  assert.equal(tasks.update(seat('dev-be'), none.id, { estimateMinutes: 240 }).estimateMinutes, 240);
  assert.equal(tasks.update(seat('dev-be'), none.id, { status: 'doing' }).status, 'doing');
  const umbrella = tasks.create(seat('dev-lead'), { title: 'HUD', body: REQ, assigneeSeatId: 'dev-lead', kind: 'tracking', estimateMinutes: 4800 });
  assert.equal(umbrella.kind, 'tracking'); assert.equal(umbrella.estimateMinutes, 4800);
  const legacy = tasks.create(seat('dev-lead'), { title: 'Legacy', body: REQ, assigneeSeatId: 'dev-fe', estimateMinutes: 600 });
  assert.equal(legacy.kind, null, 'unclassified stays unclassified');
  fixture.close();
});

test('a task in progress changes hands only with a handoff note and goes back to todo for the new owner', () => {
  const fixture = createSeededOffice(); seatAll(fixture, ['dev-lead', 'dev-be', 'dev-fe']); const { tasks } = fixture.office;
  const task = tasks.create(seat('dev-lead'), { title: 'Live', body: REQ, assigneeSeatId: 'dev-be', estimateMinutes: 60 });
  tasks.update(seat('dev-be'), task.id, { status: 'doing' });
  assert.throws(() => tasks.update(seat('dev-lead'), task.id, { assigneeSeatId: 'dev-fe' }), /reassign_doing_requires_handoff/);
  assert.equal(tasks.get(task.id).assigneeSeatId, 'dev-be');
  const moved = tasks.update(seat('dev-lead'), task.id, { assigneeSeatId: 'dev-fe', handoffNote: 'API done, tests left, branch feat/live' });
  assert.equal(moved.assigneeSeatId, 'dev-fe'); assert.equal(moved.status, 'todo');
  const line = lastLine(fixture, 'dev');
  assert.deepEqual([...line.mentions].sort(), ['dev-be', 'dev-fe']); assert.match(line.body, /Handoff: API done/);
  fixture.close();
});
