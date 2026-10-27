import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const seatAll = (fixture: Fixture, seatIds: string[]): void => { for (const seatId of seatIds) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`)); };

test('leader creates a task for a member of own department; the assignee is woken by the system line', () => {
  const fixture = createSeededOffice(); const { tasks, wake, messages } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  const task = tasks.create(seat('dev-lead'), { title: 'Login API', body: 'JWT + refresh', assigneeSeatId: 'dev-be' });
  assert.equal(task.id, 't-dev-1'); assert.equal(task.status, 'todo'); assert.equal(task.departmentId, 'dev');
  const line = messages.list(manager, 'dev').at(-1)!;
  assert.equal(line.senderKind, 'system'); assert.deepEqual(line.mentions, ['dev-be']); assert.match(line.body, /Login API/);
  const woken = wake.check('dev-be');
  assert.equal(woken.wake, true); assert.match(woken.wake ? woken.reason : '', /t-dev-1/);
  assert.equal(wake.check('dev-lead').wake, false, 'creator is not woken by own action');
  assert.equal(tasks.create(seat('dev-lead'), { title: 'Second', body: '', assigneeSeatId: 'dev-fe' }).id, 't-dev-2');
  fixture.close();
});

test('task permission matrix', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  assert.throws(() => tasks.create(seat('dev-be'), { title: 'x', body: '', assigneeSeatId: 'dev-fe' }), /leader_only/);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: 'x', body: '', assigneeSeatId: 'ba-docs' }), /assignee_outside_department/);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: 'x', body: '', assigneeSeatId: 'ghost' }), /seat_not_found/);
  const managerTask = tasks.create(manager, { title: 'Spec', body: '', assigneeSeatId: 'ba-docs' });
  assert.equal(managerTask.departmentId, 'ba');
  const task = tasks.create(seat('dev-lead'), { title: 'UI', body: '', assigneeSeatId: 'dev-fe' });
  assert.throws(() => tasks.update(seat('dev-be'), task.id, { status: 'doing' }), /forbidden_task/);
  assert.throws(() => tasks.update(seat('ba-lead'), task.id, { status: 'doing' }), /forbidden_task/);
  assert.equal(tasks.update(seat('dev-fe'), task.id, { status: 'doing' }).status, 'doing');
  assert.equal(tasks.update(seat('dev-fe'), task.id, { status: 'done', note: 'shipped' }).status, 'done');
  assert.throws(() => tasks.update(seat('dev-fe'), task.id, { status: 'todo' }), /reopen_requires_leader/);
  assert.equal(tasks.update(seat('dev-lead'), task.id, { status: 'todo' }).status, 'todo');
  assert.throws(() => tasks.update(seat('dev-fe'), task.id, { assigneeSeatId: 'dev-be' }), /leader_only/);
  assert.equal(tasks.update(seat('dev-lead'), task.id, { assigneeSeatId: 'dev-be' }).assigneeSeatId, 'dev-be');
  assert.throws(() => tasks.list(seat('dev-be'), { departmentId: 'ba' }), /forbidden_task/);
  fixture.close();
});

test('blocked and done notify the leader; status changes by the leader notify the assignee', () => {
  const fixture = createSeededOffice(); const { tasks, wake } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  const task = tasks.create(seat('dev-lead'), { title: 'Cache layer', body: '', assigneeSeatId: 'dev-be' }); wake.check('dev-be');
  tasks.update(seat('dev-be'), task.id, { status: 'doing' });
  assert.equal(wake.check('dev-lead').wake, false, 'doing does not wake the leader');
  tasks.update(seat('dev-be'), task.id, { status: 'blocked', note: 'need Redis creds' });
  const blocked = wake.check('dev-lead');
  assert.equal(blocked.wake, true); assert.match(blocked.wake ? blocked.reason : '', /need Redis creds/);
  tasks.update(seat('dev-lead'), task.id, { status: 'doing', note: 'creds in vault' });
  assert.equal(wake.check('dev-be').wake, true);
  tasks.update(seat('dev-be'), task.id, { status: 'done' });
  assert.equal(wake.check('dev-lead').wake, true);
  fixture.close();
});

test('list filters by status and assignee and records history', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  const a = tasks.create(seat('dev-lead'), { title: 'A', body: '', assigneeSeatId: 'dev-be' });
  tasks.create(seat('dev-lead'), { title: 'B', body: '', assigneeSeatId: 'dev-fe' });
  tasks.update(seat('dev-be'), a.id, { status: 'doing' });
  assert.deepEqual(tasks.list(seat('dev-be'), { assignee: 'me' }).map(task => task.title), ['A']);
  assert.deepEqual(tasks.list(seat('dev-lead'), { status: 'todo' }).map(task => task.title), ['B']);
  assert.equal(tasks.list(manager, {}).length, 2);
  assert.deepEqual(tasks.history(a.id).map(event => event.toStatus), ['todo', 'doing']);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: '', body: '', assigneeSeatId: 'dev-be' }), /invalid_task/);
  fixture.close();
});
