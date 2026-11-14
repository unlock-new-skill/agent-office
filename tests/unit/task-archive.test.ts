import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskArchivePlan } from '../../src/shared/contracts.js';
import { createAppFixture, createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const ASK = { action: 'SYNTHETIC: archive check', scope: 'test fixture only', reason: 'SYNTHETIC test request' };
const exec = (fixture: Fixture, title: string, assigneeSeatId = 'dev-be', extra: { dependsOn?: string[]; parentId?: string } = {}) =>
  fixture.office.tasks.create(seat('dev-lead'), { title, body: REQ, assigneeSeatId, kind: 'execution', estimateMinutes: 60, ...extra });
const revisions = (plan: TaskArchivePlan): Record<string, number> => Object.fromEntries(plan.eligible.map(entry => [entry.id, entry.revision]));
const archiveAll = (fixture: Fixture, actor: Parameters<Fixture['office']['tasks']['archive']>[0], ids: string[]): TaskArchivePlan => {
  const plan = fixture.office.tasks.archive(actor, 'archive', { taskIds: ids });
  return fixture.office.tasks.archive(actor, 'archive', { taskIds: ids, confirm: true, expectedRevisions: revisions(plan), reason: 'board reset' });
};
const setup = (): Fixture => { const fixture = createSeededOffice({ coordinatorSeatId: 'ba-docs' }); fixture.office.org.assignAgent('dev-be', insertAgent(fixture.db, 'agent-dev-be')); return fixture; };

test('a dry run writes nothing; confirm archives exactly the previewed tasks and keeps status, result, deps, history and audit', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const first = exec(fixture, 'First'); const second = exec(fixture, 'Second', 'dev-fe', { dependsOn: [first.id] });
  tasks.update(seat('dev-be'), first.id, { status: 'doing' }); tasks.update(seat('dev-be'), first.id, { status: 'done', note: 'delivered' });
  tasks.update(seat('dev-lead'), first.id, { result: 'fail', reason: 'probe failed' });
  const before = tasks.get(first.id); const historyBefore = tasks.history(first.id).length; const changesBefore = tasks.changes(first.id).length;
  const plan = tasks.archive(manager, 'archive', { taskIds: [first.id, second.id] });
  assert.equal(plan.applied, false); assert.deepEqual(plan.eligible.map(entry => entry.id), [first.id, second.id]); assert.deepEqual(plan.refused, []);
  assert.equal(tasks.get(first.id).archivedAt, null, 'a dry run changes nothing');
  assert.throws(() => tasks.archive(manager, 'archive', { taskIds: [first.id, second.id], confirm: true, expectedRevisions: revisions(plan) }), /reason_required/);
  const done = tasks.archive(manager, 'archive', { taskIds: [first.id, second.id], confirm: true, expectedRevisions: revisions(plan), reason: 'board reset' });
  assert.equal(done.applied, true);
  const after = tasks.get(first.id);
  assert.ok(after.archivedAt); assert.equal(after.archivedBy, 'manager'); assert.equal(after.revision, before.revision + 1);
  for (const field of ['id', 'number', 'status', 'result', 'dependsOn', 'parentId', 'title', 'body', 'assigneeSeatId', 'updatedAt', 'actualStart'] as const) assert.deepEqual(after[field], before[field], field);
  assert.equal(tasks.history(first.id).length, historyBefore, 'no status event is invented');
  const audit = tasks.changes(first.id).slice(changesBefore);
  assert.deepEqual(audit.map(change => [change.field, change.before, change.after, change.reason, change.actorId]), [['archived', false, true, 'board reset', 'manager']]);
  assert.deepEqual(tasks.get(second.id).dependsOn, [first.id]);
  fixture.close();
});

test('archived tasks leave the default list, page, board, dispatch and handoff but stay readable by id and with includeArchived', () => {
  const fixture = setup(); const { tasks, dispatch } = fixture.office; dispatch.setMode('on');
  const old = exec(fixture, 'Old blocked work'); tasks.update(seat('dev-be'), old.id, { status: 'blocked', note: 'stuck' });
  const live = exec(fixture, 'Live work', 'dev-fe');
  archiveAll(fixture, manager, [old.id]);
  assert.deepEqual(tasks.list(manager, {}).map(task => task.id), [live.id]);
  assert.deepEqual(tasks.list(manager, { includeArchived: true }).map(task => task.id).sort(), [live.id, old.id].sort());
  assert.deepEqual(tasks.list(seat('dev-be'), {}).map(task => task.id), [live.id], 'a member never sees archived tasks by default');
  assert.equal(tasks.page({ departments: null }).total, 1); assert.equal(tasks.page({ departments: null, includeArchived: true }).total, 2);
  assert.equal(tasks.read(manager, old.id).task.archivedAt !== null, true, 'direct id still reads the task with its history');
  const board = dispatch.board(manager, {});
  assert.equal(board.tasks[old.id], undefined); assert.ok(board.tasks[live.id]);
  assert.match(fixture.office.handoffs.brief('dev-be'), /Open tasks assigned to you: none\./, 'not listed as open work in the seat brief');
  assert.equal(fixture.office.progress.activity().find(row => row.seatId === 'dev-be')?.also.some(entry => entry.taskId === old.id), false);
  fixture.close();
});

test('an archived task is read-only until restored; restore brings back exactly the same task', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const task = exec(fixture, 'Paused work'); tasks.update(seat('dev-be'), task.id, { status: 'blocked', note: 'waiting' });
  const before = tasks.get(task.id);
  archiveAll(fixture, manager, [task.id]);
  assert.throws(() => tasks.update(seat('dev-lead'), task.id, { status: 'done' }), /task_archived/);
  assert.throws(() => fixture.office.dispatch.start(seat('dev-be'), task.id, {}, 'mcp'), /task_archived|not_ready/);
  assert.throws(() => fixture.office.progress.setParticipant(seat('dev-lead'), task.id, { seatId: 'dev-be', role: 'executor', state: 'active' }, 'mcp'), /task_archived/);
  assert.throws(() => tasks.create(seat('dev-lead'), { title: 'Step', body: REQ, assigneeSeatId: 'dev-fe', parentId: task.id }), /task_archived/);
  const plan = tasks.archive(manager, 'restore', { taskIds: [task.id] });
  assert.deepEqual(plan.refused, []);
  tasks.archive(manager, 'restore', { taskIds: [task.id], confirm: true, expectedRevisions: revisions(plan), reason: 'back on the board' });
  const restored = tasks.get(task.id);
  assert.equal(restored.archivedAt, null); assert.equal(restored.archivedBy, null);
  for (const field of ['status', 'result', 'dependsOn', 'actualStart', 'updatedAt', 'assigneeSeatId'] as const) assert.deepEqual(restored[field], before[field], field);
  assert.equal(restored.revision, before.revision + 2);
  assert.deepEqual(tasks.changes(task.id).filter(change => change.field === 'archived').map(change => change.after), [true, false]);
  tasks.update(seat('dev-be'), task.id, { status: 'todo', note: 'unblocked' });
  fixture.close();
});

test('rights: members never archive; a leader only in its department; the PM and the manager anywhere', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const dev = exec(fixture, 'Dev task');
  const design = tasks.create(seat('design-lead'), { title: 'Design task', body: REQ, assigneeSeatId: 'design-map' });
  assert.throws(() => tasks.archive(seat('dev-be'), 'archive', { taskIds: [dev.id] }), /archive_requires_leader/);
  const crossed = tasks.archive(seat('dev-lead'), 'archive', { taskIds: [dev.id, design.id] });
  assert.deepEqual(crossed.eligible.map(entry => entry.id), [dev.id]); assert.match(crossed.refused[0]!.reason, /forbidden/);
  assert.throws(() => tasks.archive(seat('dev-lead'), 'archive', { taskIds: [dev.id, design.id], confirm: true, expectedRevisions: revisions(crossed), reason: 'x' }), /archive_refused/);
  assert.equal(tasks.get(dev.id).archivedAt, null, 'a refused id fails the whole batch');
  assert.equal(archiveAll(fixture, seat('ba-docs'), [dev.id, design.id]).eligible.length, 2, 'the coordinator (PM) archives in any department');
  fixture.close();
});

test('fail closed: doing tasks, changed revisions, live dependents and live steps are refused, never forced', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const running = exec(fixture, 'Running'); tasks.update(seat('dev-be'), running.id, { status: 'doing' });
  assert.match(tasks.archive(manager, 'archive', { taskIds: [running.id] }).refused[0]!.reason, /^doing/);
  const input = exec(fixture, 'Open input', 'dev-fe'); const consumer = exec(fixture, 'Consumer', 'dev-unity', { dependsOn: [input.id] });
  assert.match(tasks.archive(manager, 'archive', { taskIds: [input.id] }).refused[0]!.reason, new RegExp(`needed_by_active: ${consumer.id}`));
  assert.deepEqual(tasks.archive(manager, 'archive', { taskIds: [input.id, consumer.id] }).refused, [], 'archiving both together strands nothing');
  const changing = exec(fixture, 'Changes after preview', 'dev-mobile');
  const plan = tasks.archive(manager, 'archive', { taskIds: [changing.id] });
  tasks.update(seat('dev-lead'), changing.id, { title: 'Renamed meanwhile' });
  assert.throws(() => tasks.archive(manager, 'archive', { taskIds: [changing.id], confirm: true, expectedRevisions: revisions(plan), reason: 'reset' }), /archive_stale/);
  assert.equal(tasks.get(changing.id).archivedAt, null);
  const parent = tasks.create(seat('dev-lead'), { title: 'Parent', body: REQ, assigneeSeatId: 'dev-lead', kind: 'tracking' });
  const step = tasks.create(seat('dev-lead'), { title: 'Step one', body: REQ, assigneeSeatId: 'dev-fe', parentId: parent.id });
  assert.match(tasks.archive(manager, 'archive', { taskIds: [parent.id] }).refused[0]!.reason, new RegExp(`active_steps: ${step.id}`));
  assert.match(tasks.archive(manager, 'archive', { taskIds: [step.id] }).refused[0]!.reason, new RegExp(`parent_active: ${parent.id}`));
  archiveAll(fixture, manager, [parent.id, step.id]);
  assert.equal(tasks.get(step.id).parentId, parent.id, 'no cascade: the step keeps its parent');
  assert.deepEqual(tasks.archive(manager, 'archive', { taskIds: [parent.id, 'nope'] }).refused.map(entry => entry.reason), ['already_archived', 'not_found']);
  assert.throws(() => tasks.archive(manager, 'archive', { taskIds: [running.id, running.id] }), /invalid_task_ids/);
  fixture.close();
});

test('archiving a done dependency keeps the dependent ready; an archived open dependency never makes work ready', () => {
  const fixture = setup(); const { tasks, dispatch } = fixture.office;
  const doneInput = exec(fixture, 'Done input'); tasks.update(seat('dev-be'), doneInput.id, { status: 'doing' }); tasks.update(seat('dev-be'), doneInput.id, { status: 'done', note: 'ok' });
  const next = exec(fixture, 'Next', 'dev-fe', { dependsOn: [doneInput.id] });
  archiveAll(fixture, manager, [doneInput.id]);
  assert.equal(dispatch.readiness(next.id).state, 'ready', 'a done dependency is still done when archived');
  const openInput = exec(fixture, 'Open input', 'dev-unity'); const waiting = exec(fixture, 'Waiting', 'dev-mobile', { dependsOn: [openInput.id] });
  archiveAll(fixture, manager, [openInput.id, waiting.id]);
  assert.equal(dispatch.readiness(waiting.id).state, 'waiting', 'its input is still open, archived or not');
  assert.match(tasks.archive(manager, 'restore', { taskIds: [waiting.id] }).refused[0]!.reason, /^dependency_archived/);
  fixture.close();
});

test('approval links and messages survive archive: the approval still names its task', () => {
  const fixture = setup();
  const task = exec(fixture, 'Release');
  const { approval } = fixture.office.approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  const messages = (fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count;
  archiveAll(fixture, manager, [task.id]);
  assert.equal(fixture.office.approvals.get(manager, approval.id).approval.taskId, task.id);
  assert.equal((fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, messages, 'a bulk archive posts no chat lines');
  assert.equal((fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 1, 'nothing is deleted');
  fixture.close();
});

test('HTTP: archive and restore endpoints, includeArchived on the list, old clients see live tasks only', async () => {
  const fixture = createAppFixture();
  const created = await (await fixture.manager('/v1/tasks', { body: { title: 'Old', body: REQ, assigneeSeatId: 'dev-be' } })).json() as { id: string };
  const preview = await (await fixture.manager('/v1/tasks/archive', { body: { taskIds: [created.id] } })).json() as TaskArchivePlan;
  assert.equal(preview.applied, false);
  const refused = await fixture.manager('/v1/tasks/archive', { body: { taskIds: [created.id], confirm: true, expectedRevisions: { [created.id]: preview.eligible[0]!.revision + 5 }, reason: 'reset' } });
  assert.equal(refused.status, 409); assert.equal((await refused.json() as { error: string }).error, 'archive_stale');
  const applied = await fixture.manager('/v1/tasks/archive', { body: { taskIds: [created.id], confirm: true, expectedRevisions: revisions(preview), reason: 'reset' } });
  assert.equal(applied.status, 200);
  const list = await (await fixture.manager('/v1/tasks')).json() as { tasks: Array<{ id: string }> };
  assert.equal(list.tasks.some(task => task.id === created.id), false);
  const paged = await (await fixture.manager('/v1/tasks?limit=50&includeArchived=true')).json() as { tasks: Array<{ id: string; archivedAt: number | null }> };
  assert.ok(paged.tasks.find(task => task.id === created.id)?.archivedAt);
  assert.equal((await fixture.manager(`/v1/tasks/${created.id}`)).status, 200);
  const member = fixture.seatToken('dev-fe');
  assert.equal((await fixture.agent(member, '/v1/tasks/restore', { body: { taskIds: [created.id] } })).status, 403);
  const patch = await fixture.manager(`/v1/tasks/${created.id}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(patch.status, 409);
  fixture.close();
});

test('a refused id never shields another: the preview is exactly what the confirm accepts', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const input = exec(fixture, 'Open input', 'dev-fe'); const running = exec(fixture, 'Running consumer', 'dev-unity', { dependsOn: [input.id] });
  tasks.update(manager, running.id, { status: 'doing' });
  const free = exec(fixture, 'Unrelated');
  const plan = tasks.archive(manager, 'archive', { taskIds: [input.id, running.id, free.id] });
  assert.deepEqual(plan.eligible.map(entry => entry.id), [free.id]);
  assert.deepEqual(plan.refused.map(entry => [entry.id, entry.reason.split(':')[0]]), [[input.id, 'needed_by_active'], [running.id, 'doing']]);
  const done = tasks.archive(manager, 'archive', { taskIds: plan.eligible.map(entry => entry.id), confirm: true, expectedRevisions: revisions(plan), reason: 'reset' });
  assert.equal(done.eligible.length, 1);
  fixture.close();
});

test('restore never brings back work whose open dependency, parent or open steps stay archived; new work cannot wait on an archived open task', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const input = exec(fixture, 'Open input', 'dev-fe'); const consumer = exec(fixture, 'Consumer', 'dev-unity', { dependsOn: [input.id] });
  const parent = tasks.create(seat('dev-lead'), { title: 'Parent', body: REQ, assigneeSeatId: 'dev-lead', kind: 'tracking' });
  const step = tasks.create(seat('dev-lead'), { title: 'Step', body: REQ, assigneeSeatId: 'dev-fe', parentId: parent.id });
  archiveAll(fixture, manager, [input.id, consumer.id, parent.id, step.id]);
  const plan = tasks.archive(manager, 'restore', { taskIds: [consumer.id, parent.id, step.id] });
  assert.deepEqual(plan.refused.map(entry => [entry.id, entry.reason.split(':')[0]]), [[consumer.id, 'dependency_archived']]);
  assert.deepEqual(tasks.archive(manager, 'restore', { taskIds: [step.id] }).refused.map(entry => entry.reason.split(':')[0]), ['parent_archived']);
  assert.deepEqual(tasks.archive(manager, 'restore', { taskIds: [parent.id] }).refused.map(entry => entry.reason.split(':')[0]), ['archived_steps']);
  assert.deepEqual(tasks.archive(manager, 'restore', { taskIds: [input.id, consumer.id] }).refused, []);
  assert.throws(() => exec(fixture, 'New waiter', 'dev-mobile', { dependsOn: [input.id] }), /dependency_archived/);
  fixture.close();
});

test('a page counts tasks archived after its snapshot as changed', () => {
  const fixture = setup(); const { tasks } = fixture.office;
  const task = exec(fixture, 'Paged'); const first = tasks.page({ departments: null }, 100, undefined, Date.now());
  const later = Date.now() + 3; while (Date.now() < later) { /* the archive must land after the snapshot millisecond */ }
  archiveAll(fixture, manager, [task.id]);
  assert.equal(tasks.page({ departments: null }, 100, undefined, first.snapshotAt).changedSinceSnapshot, 1);
  fixture.close();
});
