import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';
import type { Task, TaskChange } from '../../src/shared/contracts.js';

const REQ = 'Goal, inputs, expected output and acceptance criteria.';

test('the web UI and an agent edit a task through the same contract; the audit records the source', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead');
  const task = await (await fixture.agent(devLead, '/v1/tasks', { body: { title: 'Probe', body: REQ, assigneeSeatId: 'dev-be' } })).json() as Task;
  const fromUi = await fixture.manager(`/v1/tasks/${task.id}`, { method: 'PATCH', body: { assigneeSeatId: null, expectedRevision: 0 } });
  assert.equal(fromUi.status, 200); assert.equal((await fromUi.json() as Task).assigneeSeatId, null);
  const fromMcp = await fixture.agent(devLead, `/v1/tasks/${task.id}`, { method: 'PATCH', body: { assigneeSeatId: 'dev-fe', title: 'Probe 304', expectedRevision: 1 } });
  assert.equal(fromMcp.status, 200);
  const read = await (await fixture.agent(devLead, `/v1/tasks/${task.id}`)).json() as { task: Task; changes: TaskChange[] };
  assert.equal(read.task.id, task.id); assert.equal(read.task.revision, 2); assert.equal(read.task.title, 'Probe 304');
  assert.deepEqual(read.changes.map(change => `${change.source}:${change.field}`), ['ui:assigneeSeatId', 'mcp:title', 'mcp:assigneeSeatId']);
  fixture.close();
});

test('a stale update answers 409 with the current task', async () => {
  const fixture = createAppFixture();
  const task = await (await fixture.manager('/v1/tasks', { body: { title: 'A', body: REQ, assigneeSeatId: 'dev-be' } })).json() as Task;
  assert.equal((await fixture.manager(`/v1/tasks/${task.id}`, { method: 'PATCH', body: { estimateMinutes: 60, expectedRevision: 0 } })).status, 200);
  const stale = await fixture.manager(`/v1/tasks/${task.id}`, { method: 'PATCH', body: { estimateMinutes: 30, expectedRevision: 0 } });
  assert.equal(stale.status, 409);
  const body = await stale.json() as { error: string; task: Task };
  assert.equal(body.error, 'stale_revision'); assert.equal(body.task.estimateMinutes, 60); assert.equal(body.task.revision, 1);
  fixture.close();
});

test('the manager flags a coordinator seat; it lists other departments and a leader joins a department channel over HTTP', async () => {
  const fixture = createAppFixture();
  await fixture.manager('/v1/tasks', { body: { title: 'A', body: REQ, assigneeSeatId: 'dev-be' } });
  const baLead = fixture.seatToken('ba-lead');
  assert.equal((await fixture.agent(baLead, '/v1/tasks?departmentId=dev')).status, 403);
  assert.equal((await fixture.manager('/v1/seats/ba-lead', { method: 'PATCH', body: { coordinator: true } })).status, 200);
  const listed = await (await fixture.agent(baLead, '/v1/tasks?departmentId=dev')).json() as { tasks: Task[] };
  assert.equal(listed.tasks.length, 1);
  assert.equal((await fixture.agent(baLead, '/v1/channels/dev/join', { body: {} })).status, 200);
  assert.equal((await fixture.agent(baLead, '/v1/channels/dev/messages', { body: { body: '@dev-be hi' } })).status, 201);
  const member = fixture.seatToken('ba-docs');
  assert.equal((await fixture.agent(member, '/v1/channels/dev/join', { body: {} })).status, 403);
  fixture.close();
});

test('blockers, board, dispatch setting and START over HTTP', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const devBe = fixture.seatToken('dev-be');
  assert.equal((await (await fixture.manager('/v1/settings/dispatch')).json() as { mode: string }).mode, 'suggest');
  assert.equal((await fixture.agent(devLead, '/v1/settings/dispatch')).status, 401, 'dispatch mode is the manager\'s switch');
  assert.equal((await fixture.manager('/v1/settings/dispatch', { method: 'PUT', body: { mode: 'on' } })).status, 200);
  const task = await (await fixture.agent(devLead, '/v1/tasks', { body: { title: 'Probe', body: REQ, assigneeSeatId: 'dev-be', kind: 'execution', estimateMinutes: 60 } })).json() as Task;
  const opened = await fixture.agent(devLead, '/v1/blockers', { body: { kind: 'environment', description: 'Test window not open', taskIds: [task.id], resolverRole: 'manager', nextStep: 'open the window' } });
  assert.equal(opened.status, 201);
  const blocker = await opened.json() as { id: string };
  const board = await (await fixture.manager('/v1/board?departmentId=dev')).json() as { needsAction: Array<{ id: string; taskIds: string[] }>; totals: { blockers: number } };
  assert.deepEqual(board.needsAction.map(group => group.id), [blocker.id]); assert.equal(board.totals.blockers, 1);
  const refused = await fixture.agent(devBe, `/v1/tasks/${task.id}/start`, { body: {} });
  assert.equal(refused.status, 400); assert.match((await refused.json() as { error: string }).error, /not_ready/);
  assert.equal((await fixture.manager(`/v1/blockers/${blocker.id}/resolve`, { body: { resolution: 'window open until 18:00' } })).status, 200);
  const read = await (await fixture.agent(devBe, `/v1/tasks/${task.id}`)).json() as { readiness: { state: string; generation: number } };
  assert.equal(read.readiness.state, 'ready');
  const started = await fixture.agent(devBe, `/v1/tasks/${task.id}/start`, { body: { generation: read.readiness.generation } });
  assert.equal(started.status, 200); assert.equal((await started.json() as Task).status, 'doing');
  assert.equal((await fixture.agent(devBe, `/v1/tasks/${task.id}/start`, { body: {} })).status, 409);
  const member = fixture.seatToken('ba-docs');
  assert.deepEqual((await (await fixture.agent(member, '/v1/blockers')).json() as { blockers: unknown[] }).blockers, [], 'blockers of other departments are not listed');
  fixture.close();
});
