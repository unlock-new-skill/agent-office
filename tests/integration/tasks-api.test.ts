import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';
import type { Task } from '../../src/shared/contracts.js';

test('tasks over HTTP: leader creates, member updates, manager sees all', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const devBe = fixture.seatToken('dev-be');
  const created = await fixture.agent(devLead, '/v1/tasks', { body: { title: 'Login API', body: 'JWT', assigneeSeatId: 'dev-be' } });
  assert.equal(created.status, 201);
  const task = await created.json() as Task;
  assert.equal((await fixture.agent(devBe, '/v1/tasks', { body: { title: 'x', assigneeSeatId: 'dev-fe' } })).status, 403);
  assert.equal((await fixture.agent(devBe, `/v1/tasks/${task.id}`, { method: 'PATCH', body: { status: 'doing', note: 'on it' } })).status, 200);
  const mine = await (await fixture.agent(devBe, '/v1/tasks?assignee=me')).json() as { tasks: Task[] };
  assert.equal(mine.tasks[0]?.status, 'doing');
  const all = await (await fixture.manager('/v1/tasks')).json() as { tasks: Task[] };
  assert.equal(all.tasks.length, 1);
  assert.equal((await fixture.manager('/v1/tasks', { body: { title: 'Map pass', assigneeSeatId: 'design-map' } })).status, 201);
  assert.equal((await fixture.manager('/v1/tasks/t-missing-1', { method: 'PATCH', body: { status: 'done' } })).status, 404);
  assert.equal((await fixture.manager(`/v1/tasks/${task.id}`, { method: 'PATCH', body: { status: 'nope' } })).status, 400);
  fixture.close();
});
