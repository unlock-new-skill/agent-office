import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectDetail, ProjectSummary } from '../../src/shared/contracts.js';
import { createAppFixture, createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const pm = seat('ba-docs');
const REQ = 'SYNTHETIC test: goal, inputs, expected output and acceptance criteria.';
const setup = (): Fixture => {
  const fixture = createSeededOffice({ coordinatorSeatId: 'ba-docs' });
  for (const seatId of ['dev-lead', 'dev-be', 'dev-fe', 'design-lead', 'design-map']) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`));
  return fixture;
};
const lines = (fixture: Fixture, channel: string, needle: string) => fixture.office.messages.list(manager, channel, { limit: 500 }).filter(message => message.body.includes(needle));

test('the manager files an order in one line; the PM is told once; sending it again does not copy it', () => {
  const fixture = setup(); const { projects } = fixture.office;
  const order = projects.create(manager, { title: 'SYNTHETIC Lobby v2', spec: 'Lobby with friends list', priority: 'high' });
  assert.equal(order.id, 'p-1'); assert.equal(order.status, 'open'); assert.equal(order.goal, '', 'only the title is required');
  const told = lines(fixture, 'ba', 'New order p-1');
  assert.equal(told.length, 1); assert.deepEqual(told[0]!.mentions, ['ba-docs']);
  assert.equal(projects.create(manager, { title: ' synthetic lobby v2 ', spec: 'Lobby with friends list', priority: 'high' }).id, 'p-1', 'a resent order is the same order');
  assert.equal(lines(fixture, 'ba', 'New order').length, 1, 'and is not announced twice');
  assert.throws(() => projects.create(manager, { title: 'SYNTHETIC Lobby v2', spec: 'Something else' }), /project_exists/);
  assert.throws(() => projects.create(seat('dev-lead'), { title: 'Not mine to file' }), /project_editor_only/);
  assert.throws(() => projects.create(manager, { title: '  ' }), /invalid_project/);
  fixture.close();
});

test('the PM splits the order into tasks; a resent split reuses them; states keep a missing input on its own task', () => {
  const fixture = setup(); const { projects, tasks, blockers } = fixture.office;
  const order = projects.create(manager, { title: 'SYNTHETIC Schedule page', requirements: 'API + page' });
  const api = tasks.create(pm, { title: 'Schedule API', body: REQ, assigneeSeatId: 'dev-be', kind: 'execution', estimateMinutes: 60, projectId: order.id });
  const page = tasks.create(pm, { title: 'Schedule page', body: REQ, assigneeSeatId: 'dev-fe', kind: 'execution', estimateMinutes: 60, dependsOn: [api.id], projectId: order.id });
  const art = tasks.create(pm, { title: 'Schedule icons', body: REQ, assigneeSeatId: 'design-map', kind: 'execution', estimateMinutes: 30, projectId: order.id });
  assert.equal(tasks.create(pm, { title: 'schedule  API', body: REQ, assigneeSeatId: 'dev-be', kind: 'execution', projectId: order.id }).id, api.id, 'resending the split does not double the work');
  assert.equal(tasks.ofProject(order.id).length, 3);
  blockers.open(seat('design-lead'), { kind: 'environment', description: 'No icon source file', taskIds: [art.id], resolverSeatId: 'design-lead', nextStep: 'share the source' });
  const states = (detail: ProjectDetail): Record<string, string> => Object.fromEntries(detail.tasks.map(entry => [entry.task.id, entry.state]));
  assert.deepEqual(states(projects.detail(manager, order.id)), { [api.id]: 'todo', [page.id]: 'waiting', [art.id]: 'blocked' }, 'waiting on an input is not a failure of the order');
  fixture.office.dispatch.start(seat('dev-be'), api.id, {}, 'mcp');
  assert.equal(states(projects.detail(manager, order.id))[api.id], 'doing');
  // The owner finishes alone with the output; the lead is told once; nothing turns into a pass.
  tasks.update(seat('dev-be'), api.id, { status: 'done', note: 'SYNTHETIC: API on branch feat/schedule-api, tests green' });
  const detail = projects.detail(manager, order.id);
  const done = detail.tasks.find(entry => entry.task.id === api.id)!;
  assert.equal(done.state, 'done'); assert.match(done.output ?? '', /feat\/schedule-api/); assert.equal(done.task.result, 'unknown');
  assert.equal(states(detail)[page.id], 'todo', 'the next task is free once its input is done');
  const handover = fixture.office.messages.list(manager, 'dev', { limit: 500 }).filter(message => message.body.includes(`${api.id}`) && message.body.includes('doing → done'));
  assert.equal(handover.length, 1); assert.ok(handover[0]!.mentions.includes('dev-lead'), 'the lead receives the handover exactly once');
  assert.deepEqual(detail.counts, { done: 1, doing: 0, waiting: 0, blocked: 1, todo: 1 });
  fixture.close();
});

test('linking existing work, visibility per department, and editing the order keeps its tasks untouched', () => {
  const fixture = setup(); const { projects, tasks } = fixture.office;
  const order = projects.create(manager, { title: 'SYNTHETIC Map polish' });
  const existing = tasks.create(seat('dev-lead'), { title: 'Fix map seams', body: REQ, assigneeSeatId: 'dev-fe', kind: 'execution', estimateMinutes: 30 });
  assert.throws(() => tasks.update(seat('dev-fe'), existing.id, { projectId: order.id }), /leader_only/);
  tasks.update(pm, existing.id, { projectId: order.id, reason: 'part of p-1' });
  assert.equal(tasks.get(existing.id).projectId, order.id);
  assert.deepEqual(tasks.changes(existing.id).map(change => [change.field, change.before, change.after]), [['projectId', null, order.id]]);
  const art = tasks.create(pm, { title: 'Map textures', body: REQ, assigneeSeatId: 'design-map', kind: 'execution', projectId: order.id });
  assert.deepEqual(projects.detail(seat('dev-be'), order.id).tasks.map(entry => entry.task.id), [existing.id], 'a member sees its own department\'s part');
  assert.equal(projects.detail(manager, order.id).tasks.length, 2);
  const before = tasks.get(art.id);
  const edited = projects.update(manager, order.id, { spec: 'Seams and textures', expectedRevision: order.revision });
  assert.equal(edited.revision, 1);
  assert.deepEqual(projects.changes(order.id).map(change => [change.field, change.before, change.after]), [['spec', '', 'Seams and textures']]);
  assert.equal(lines(fixture, 'ba', `Order ${order.id}`).length, 1, 'the PM is told about the change');
  assert.deepEqual(tasks.get(art.id), before, 'a spec change never edits or reruns tasks');
  assert.throws(() => projects.update(manager, order.id, { spec: 'x', expectedRevision: 0 }), /stale_revision/);
  projects.update(manager, order.id, { status: 'closed' });
  assert.throws(() => tasks.create(pm, { title: 'Late work', body: REQ, assigneeSeatId: 'dev-fe', projectId: order.id }), /project_closed/);
  assert.throws(() => tasks.create(pm, { title: 'Nowhere', body: REQ, assigneeSeatId: 'dev-fe', projectId: 'p-99' }), /not_found|project/);
  fixture.close();
});

test('HTTP: order, split, finish and reload show the same spec, tasks and output; seats read but cannot file', async () => {
  const fixture = createAppFixture();
  const created = await fixture.manager('/v1/projects', { body: { title: 'SYNTHETIC HTTP order', goal: 'Check the flow', spec: 'Spec text', links: ['https://example.invalid/doc'] } });
  assert.equal(created.status, 201);
  const order = await created.json() as { id: string };
  const task = await (await fixture.manager('/v1/tasks', { body: { title: 'Build it', body: REQ, assigneeSeatId: 'dev-be', projectId: order.id } })).json() as { id: string; projectId: string };
  assert.equal(task.projectId, order.id);
  await fixture.manager(`/v1/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done', note: 'SYNTHETIC output: https://example.invalid/build' } });
  const detail = await (await fixture.manager(`/v1/projects/${order.id}`)).json() as ProjectDetail;
  assert.equal(detail.project.spec, 'Spec text'); assert.deepEqual(detail.project.links, ['https://example.invalid/doc']);
  assert.deepEqual(detail.tasks.map(entry => [entry.task.id, entry.state, entry.output]), [[task.id, 'done', 'SYNTHETIC output: https://example.invalid/build']]);
  const list = await (await fixture.manager('/v1/projects')).json() as { projects: ProjectSummary[] };
  assert.deepEqual(list.projects.map(project => [project.id, project.counts.done]), [[order.id, 1]]);
  const member = fixture.seatToken('dev-fe');
  assert.equal((await fixture.agent(member, `/v1/projects/${order.id}`)).status, 200);
  assert.equal((await fixture.agent(member, '/v1/projects', { body: { title: 'Mine' } })).status, 403);
  assert.equal((await fixture.manager(`/v1/projects/${order.id}`, { method: 'PATCH', body: { priority: 'urgent' } })).status, 200);
  fixture.close();
});

test('review cases: a task blocked only on an input stays waiting; steps follow their parent; retries of steps reuse them; members cannot file', () => {
  const fixture = setup(); const { projects, tasks, blockers } = fixture.office;
  const order = projects.create(manager, { title: 'SYNTHETIC Review cases' });
  const other = projects.create(manager, { title: 'SYNTHETIC Other order' });
  const input = tasks.create(pm, { title: 'Input', body: REQ, assigneeSeatId: 'dev-be', kind: 'execution', estimateMinutes: 30, projectId: order.id });
  const waiting = tasks.create(pm, { title: 'Needs input', body: REQ, assigneeSeatId: 'dev-fe', kind: 'execution', estimateMinutes: 30, projectId: order.id });
  blockers.open(seat('dev-lead'), { kind: 'dependency', description: `waits for ${input.id}`, taskIds: [waiting.id], resolverSeatId: 'dev-be', nextStep: 'finish the input' });
  tasks.update(seat('dev-fe'), waiting.id, { status: 'blocked', note: 'waiting for the input' });
  assert.equal(projects.detail(manager, order.id).tasks.find(entry => entry.task.id === waiting.id)!.state, 'waiting', 'declared blocked on a dependency only is still waiting');
  const parent = tasks.create(pm, { title: 'Parent', body: REQ, assigneeSeatId: 'dev-lead', kind: 'tracking', projectId: order.id });
  const step = tasks.create(seat('dev-lead'), { title: 'Step one', body: REQ, assigneeSeatId: 'dev-fe', parentId: parent.id });
  assert.equal(step.projectId, order.id, 'a step joins its parent project');
  assert.equal(tasks.create(seat('dev-lead'), { title: 'step  one', body: REQ, assigneeSeatId: 'dev-fe', parentId: parent.id }).id, step.id, 'a resent step is the same step');
  assert.throws(() => tasks.update(pm, step.id, { projectId: other.id }), /step_follows_parent_project/);
  tasks.update(pm, parent.id, { projectId: other.id });
  assert.equal(tasks.get(step.id).projectId, other.id, 'steps move with their parent');
  assert.throws(() => tasks.create(seat('dev-fe'), { title: 'Input', body: REQ, assigneeSeatId: 'dev-be', projectId: order.id }), /leader_only/);
  assert.throws(() => projects.update(manager, other.id, { title: 'synthetic review cases' }), /project_exists/);
  fixture.close();
});
