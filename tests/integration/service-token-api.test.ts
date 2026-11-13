import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture, type AppFixture } from '../helpers/office-fixture.js';
import { SERVICE_RATE_LIMIT } from '../../src/server/auth/service-token-service.js';
import type { Task } from '../../src/shared/contracts.js';

const REQ = 'Goal, inputs, expected output and acceptance criteria.';
type Page = { tasks: Array<Task & { activeMs: number; runs: number }>; total: number; snapshotAt: number; nextCursor: string | null; changedSinceSnapshot: number };
const issue = async (fixture: AppFixture, body: Record<string, unknown>): Promise<string> => {
  const response = await fixture.manager('/v1/service-tokens', { body });
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json() as { token: string }).token;
};

test('service token pages more than 500 tasks over a stable snapshot without silent truncation', async () => {
  const fixture = createAppFixture(); const { tasks } = fixture.office;
  for (let index = 0; index < 520; index++) tasks.create({ kind: 'manager' }, { title: `Task ${index}`, body: REQ, assigneeSeatId: index % 2 ? 'dev-be' : 'ba-docs' });
  const token = await issue(fixture, { label: 'schedule adapter' });
  assert.match(token, /^aos_/);
  const listed = await (await fixture.manager('/v1/service-tokens')).json() as { serviceTokens: Array<Record<string, unknown>> };
  assert.equal(listed.serviceTokens.length, 1); assert.ok(!JSON.stringify(listed).includes(token), 'never listed again'); assert.ok(!('tokenHash' in listed.serviceTokens[0]!));
  const seen = new Set<string>(); let cursor: string | null = null; let snapshot = 0; let pages = 0;
  do {
    const page = await (await fixture.agent(token, `/v1/tasks?limit=200${cursor ? `&cursor=${cursor}` : ''}`)).json() as Page;
    if (pages === 0) {
      snapshot = page.snapshotAt;
      tasks.create({ kind: 'manager' }, { title: 'Created mid-way', body: REQ, assigneeSeatId: 'dev-be' });
      tasks.update({ kind: 'manager' }, 't-dev-1', { estimateMinutes: 30 });
    }
    assert.equal(page.total, 520, 'total is fixed by the snapshot'); assert.equal(page.snapshotAt, snapshot);
    for (const task of page.tasks) { assert.ok(!seen.has(task.id), 'no task twice'); seen.add(task.id); assert.equal(typeof task.activeMs, 'number'); }
    if (pages > 0) assert.ok(page.changedSinceSnapshot >= 1, 'a task changed after the snapshot is counted');
    cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.equal(seen.size, 520); assert.equal(pages, 3);
  assert.equal((await fixture.agent(token, '/v1/tasks?cursor=garbage')).status, 400);
  fixture.close();
});

test('service token is read-only: writes, chat, machines and admin routes are refused', async () => {
  const fixture = createAppFixture();
  const task = fixture.office.tasks.create({ kind: 'manager' }, { title: 'T', body: REQ, assigneeSeatId: 'dev-be' });
  const token = await issue(fixture, { label: 'reader' });
  for (const [method, path, body] of [['POST', '/v1/tasks', { title: 'x', body: REQ, assigneeSeatId: 'dev-be' }], ['PATCH', `/v1/tasks/${task.id}`, { status: 'done' }], ['POST', `/v1/tasks/${task.id}/start`, {}], ['POST', '/v1/channels/dev/messages', { body: 'hi' }], ['POST', '/v1/blockers', { kind: 'decision', description: 'x', taskIds: [task.id] }], ['POST', '/v1/service-tokens', { label: 'x' }]] as const) {
    const response = await fixture.agent(token, path, { method, body });
    assert.equal(response.status, 403, `${method} ${path}`); assert.equal((await response.json() as { error: string }).error, 'service_token_read_only');
  }
  for (const path of ['/v1/channels/dev/messages', '/v1/machines', '/v1/org', '/v1/agents', '/v1/permissions']) assert.equal((await fixture.agent(token, path)).status, 403, path);
  for (const path of ['/v1/tasks', `/v1/tasks/${task.id}`, '/v1/board', '/v1/blockers', '/v1/directory']) assert.equal((await fixture.agent(token, path)).status, 200, path);
  const detail = await (await fixture.agent(token, `/v1/tasks/${task.id}`)).json() as { task: { activeMs: number; runs: number }; history: unknown[]; readiness: unknown };
  assert.equal(detail.task.runs, 0); assert.ok(Array.isArray(detail.history)); assert.ok(detail.readiness);
  assert.equal(fixture.office.tasks.get(task.id).status, 'todo', 'nothing changed');
  fixture.close();
});

test('a department-scoped token sees only its departments; revoked and expired tokens stop working', async () => {
  const fixture = createAppFixture(); const { tasks } = fixture.office;
  const dev = tasks.create({ kind: 'manager' }, { title: 'Dev', body: REQ, assigneeSeatId: 'dev-be' });
  const ba = tasks.create({ kind: 'manager' }, { title: 'BA', body: REQ, assigneeSeatId: 'ba-docs' });
  const token = await issue(fixture, { label: 'ba only', departments: ['ba'] });
  const page = await (await fixture.agent(token, '/v1/tasks?limit=50')).json() as Page;
  assert.deepEqual(page.tasks.map(task => task.id), [ba.id]); assert.equal(page.total, 1);
  assert.equal((await fixture.agent(token, `/v1/tasks/${dev.id}`)).status, 404);
  assert.equal((await fixture.agent(token, '/v1/tasks?departmentId=dev')).status, 403);
  assert.equal((await fixture.agent(token, '/v1/board')).status, 200, 'one department: board defaults to it');
  const directory = await (await fixture.agent(token, '/v1/directory')).json() as { departments: Array<{ id: string }>; seats: Array<{ departmentId: string }> };
  assert.deepEqual(directory.departments.map(department => department.id), ['ba']); assert.ok(directory.seats.every(seat => seat.departmentId === 'ba'));
  const id = (fixture.office.serviceTokens.list()[0]!).id;
  assert.equal((await fixture.manager(`/v1/service-tokens/${id}/revoke`, { body: {} })).status, 200);
  assert.equal((await fixture.agent(token, '/v1/tasks')).status, 401);
  const expiring = await issue(fixture, { label: 'short', expiresInDays: 1 });
  fixture.db.raw.prepare("UPDATE service_tokens SET expires_at=? WHERE label='short'").run(Date.now() - 1);
  assert.equal((await fixture.agent(expiring, '/v1/tasks')).status, 401);
  assert.equal((await fixture.manager('/v1/service-tokens', { body: { label: 'bad', departments: ['nope'] } })).status, 404);
  fixture.close();
});

test('only the manager issues tokens; a token is rate limited', async () => {
  const fixture = createAppFixture(); const seat = fixture.seatToken('dev-lead');
  assert.equal((await fixture.agent(seat, '/v1/service-tokens', { body: { label: 'x' } })).status, 401);
  assert.equal((await fixture.agent(seat, '/v1/service-tokens')).status, 401);
  const token = await issue(fixture, { label: 'busy' });
  let last = 200;
  for (let index = 0; index <= SERVICE_RATE_LIMIT; index++) last = (await fixture.agent(token, '/v1/directory')).status;
  assert.equal(last, 429);
  fixture.close();
});
