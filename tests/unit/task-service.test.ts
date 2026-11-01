import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const seatAll = (fixture: Fixture, seatIds: string[]): void => { for (const seatId of seatIds) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`)); };

test('leader creates a task for a member of own department; the assignee is woken by the system line', () => {
  const fixture = createSeededOffice(); const { tasks, wake, messages } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  const task = tasks.create(seat('dev-lead'), { title: 'Login API', body: 'JWT + refresh tokens; acceptance: login works', assigneeSeatId: 'dev-be' });
  assert.equal(task.id, 't-dev-1'); assert.equal(task.status, 'todo'); assert.equal(task.departmentId, 'dev');
  const line = messages.list(manager, 'dev').at(-1)!;
  assert.equal(line.senderKind, 'system'); assert.deepEqual(line.mentions, ['dev-be']); assert.match(line.body, /Login API/);
  const woken = wake.check('dev-be');
  assert.equal(woken.wake, true); assert.match(woken.wake ? woken.reason : '', /t-dev-1/);
  assert.equal(wake.check('dev-lead').wake, false, 'creator is not woken by own action');
  assert.equal(tasks.create(seat('dev-lead'), { title: 'Second', body: REQ, assigneeSeatId: 'dev-fe' }).id, 't-dev-2');
  fixture.close();
});

test('task permission matrix', () => {
  const fixture = createSeededOffice(); const { tasks } = fixture.office;
  assert.throws(() => tasks.create(seat('dev-be'), { title: 'x', body: REQ, assigneeSeatId: 'dev-fe' }), /leader_only/);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: 'x', body: REQ, assigneeSeatId: 'ba-docs' }), /assignee_outside_department/);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: 'x', body: REQ, assigneeSeatId: 'ghost' }), /seat_not_found/);
  const managerTask = tasks.create(manager, { title: 'Spec', body: REQ, assigneeSeatId: 'ba-docs' });
  assert.equal(managerTask.departmentId, 'ba');
  const task = tasks.create(seat('dev-lead'), { title: 'UI', body: REQ, assigneeSeatId: 'dev-fe' });
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
  const task = tasks.create(seat('dev-lead'), { title: 'Cache layer', body: REQ, assigneeSeatId: 'dev-be' }); wake.check('dev-be');
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
  const a = tasks.create(seat('dev-lead'), { title: 'A', body: REQ, assigneeSeatId: 'dev-be' });
  tasks.create(seat('dev-lead'), { title: 'B', body: REQ, assigneeSeatId: 'dev-fe' });
  tasks.update(seat('dev-be'), a.id, { status: 'doing' });
  assert.deepEqual(tasks.list(seat('dev-be'), { assignee: 'me' }).map(task => task.title), ['A']);
  assert.deepEqual(tasks.list(seat('dev-lead'), { status: 'todo' }).map(task => task.title), ['B']);
  assert.equal(tasks.list(manager, {}).length, 2);
  assert.deepEqual(tasks.history(a.id).map(event => event.toStatus), ['todo', 'doing']);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: '', body: REQ, assigneeSeatId: 'dev-be' }), /invalid_task/);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: 'No spec', body: 'do it', assigneeSeatId: 'dev-be' }), /requirement_required/);
  fixture.close();
});

test('estimates and dependencies: no start before dependencies are done, then the waiting assignee is told', () => {
  const fixture = createSeededOffice({ coordinatorSeatId: 'ops-lead' }); const { tasks, messages } = fixture.office; seatAll(fixture, ['dev-be', 'design-atom']);
  const last = (channelId: string) => messages.list(manager, channelId).at(-1)!;
  const art = tasks.create(seat('design-lead'), { title: 'Icons', body: REQ, assigneeSeatId: 'design-atom', estimateMinutes: 90 });
  assert.match(last('design').body, /Estimate: 1h 30m\./);
  const api = tasks.create(seat('ops-lead'), { title: 'Use icons', body: REQ, assigneeSeatId: 'dev-be', dependsOn: [art.id] });
  assert.equal(api.departmentId, 'dev', 'the coordinator creates tasks in other departments');
  assert.match(last('dev').body, /No estimate yet: @dev-be set estimateMinutes.*Waits for: t-design-1 \(open: t-design-1\)/);
  assert.throws(() => tasks.update(seat('dev-be'), api.id, { status: 'doing' }), /waiting_for_dependencies: t-design-1/);
  assert.throws(() => tasks.update(seat('dev-be'), api.id, { dependsOn: [] }), /leader_only/, 'assignees do not reorder');
  assert.equal(tasks.update(seat('dev-be'), api.id, { estimateMinutes: 45 }).estimateMinutes, 45);
  assert.throws(() => tasks.update(seat('ops-lead'), art.id, { dependsOn: [api.id] }), /dependency_cycle/);
  assert.throws(() => tasks.update(seat('dev-be'), api.id, { estimateMinutes: 0 }), /invalid_estimate/);
  tasks.update(seat('design-atom'), art.id, { status: 'done' });
  const ready = last('dev');
  assert.match(ready.body, /t-dev-1 "Use icons" is ready to start/);
  assert.deepEqual(ready.mentions, ['dev-be']);
  assert.equal(tasks.update(seat('dev-be'), api.id, { status: 'doing' }).status, 'doing');
  assert.equal(tasks.list(seat('ops-lead'), {}).length, 2, 'the coordinator lists every department');
  fixture.close();
});

test('after a member finishes its own task, its runner seat compacts when the turn ends; leaders are left alone', () => {
  const fixture = createSeededOffice({ afterTask: 'compact' }); const { tasks, runners, onTurnStop } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  const idle = (seatId: string) => ({ seatId, state: 'idle' as const, sessionId: null, restarts: 0, permissionMode: 'bypassPermissions' as const, detail: '' });
  runners.register('runner-1', 'mac', [idle('dev-be'), idle('dev-lead')]);
  const queued = () => [...runners.commands('dev-be'), ...runners.commands('dev-lead')];
  const member = tasks.create(seat('dev-lead'), { title: 'API', body: REQ, assigneeSeatId: 'dev-be' });
  const lead = tasks.create(manager, { title: 'Review', body: REQ, assigneeSeatId: 'dev-lead' });
  tasks.update(seat('dev-be'), member.id, { status: 'done' });
  assert.equal(queued().length, 0, 'nothing happens mid-turn');
  onTurnStop('agent-dev-be');
  const [compact] = runners.commands('dev-be');
  assert.equal(compact?.kind, 'prompt'); assert.match(compact?.text ?? '', /^\/compact Task t-dev-1 is done/);
  onTurnStop('agent-dev-be');
  assert.equal(runners.commands('dev-be').length, 1, 'once per finished task');
  tasks.update(seat('dev-lead'), lead.id, { status: 'done' }); onTurnStop('agent-dev-lead');
  assert.equal(runners.commands('dev-lead').length, 0, 'leaders keep their context');
  fixture.close();
});

test('what happens after a task follows the seat setting, else the office default', () => {
  const fixture = createSeededOffice({ afterTask: 'compact' }); const office = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be', 'dev-fe']);
  const idle = (seatId: string) => ({ seatId, state: 'idle' as const, sessionId: null, restarts: 0, permissionMode: 'bypassPermissions' as const, detail: '' });
  office.runners.register('runner-1', 'mac', [idle('dev-be'), idle('dev-fe')]);
  const finish = (seatId: string): void => {
    const task = office.tasks.create(seat('dev-lead'), { title: `Work ${seatId}`, body: REQ, assigneeSeatId: seatId });
    office.tasks.update(seat(seatId), task.id, { status: 'done' }); office.onTurnStop(`agent-${seatId}`);
  };
  office.org.setAfterTask('dev-be', 'off');
  assert.equal(office.setAfterTaskDefault('clear'), 'clear');
  finish('dev-be'); finish('dev-fe');
  assert.equal(office.runners.commands('dev-be').length, 0, 'seat set to off');
  assert.equal(office.runners.commands('dev-fe')[0]?.kind, 'fresh', 'office default clear');
  assert.equal(office.setAfterTaskDefault(null), 'compact', 'clearing the setting falls back to the env default');
  fixture.close();
});

test('a finished task posts its output to #outputs, which wakes nobody', () => {
  const fixture = createSeededOffice(); const { tasks, messages, wake } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  const task = tasks.create(seat('dev-lead'), { title: 'Export CSV', body: REQ, assigneeSeatId: 'dev-be' });
  wake.check('dev-lead');
  tasks.update(seat('dev-be'), task.id, { status: 'done', note: 'CSV at reports/export.csv, 169 rows, commit abc123' });
  const output = messages.list(manager, 'outputs').at(-1)!;
  assert.equal(output.senderKind, 'system'); assert.deepEqual(output.mentions, []);
  assert.match(output.body, /✅ t-dev-1 "Export CSV" · Dev · @dev-be\nOutput: CSV at reports\/export\.csv, 169 rows, commit abc123/);
  messages.post(seat('dev-be'), 'outputs', '@dev-lead extra details: charts in reports/');
  assert.equal(wake.check('dev-lead').wake, true, 'the done line in #dev wakes the leader as before');
  assert.equal(wake.check('dev-lead').wake, false, 'the #outputs message does not wake anyone');
  fixture.close();
});

test('all lines about one task share one thread in the department channel; mentions inside still wake', () => {
  const fixture = createSeededOffice(); const { tasks, messages, wake } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  const task = tasks.create(seat('dev-lead'), { title: 'Cache', body: REQ, assigneeSeatId: 'dev-be' });
  const root = messages.list(manager, 'dev').at(-1)!;
  assert.equal(root.threadSeq, null);
  wake.check('dev-be');
  tasks.update(seat('dev-be'), task.id, { status: 'doing' });
  tasks.update(seat('dev-lead'), task.id, { status: 'blocked', note: 'wait for infra' });
  const lines = messages.list(manager, 'dev');
  assert.deepEqual(lines.slice(-2).map(line => line.threadSeq), [root.seq, root.seq], 'later changes are replies to the first line');
  assert.equal(messages.list(manager, 'dev', { topLevel: true }).filter(line => line.body.includes(task.id)).length, 1, 'the channel shows one line per task');
  const woken = wake.check('dev-be');
  assert.ok(woken.wake && /thread \[\d+\]/.test(woken.reason), 'the assignee is woken by the reply and told it is in a thread');
  fixture.close();
});
