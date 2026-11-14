import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const setup = (): Fixture => {
  const fixture = createSeededOffice();
  for (const seatId of ['dev-lead', 'dev-be', 'dev-fe', 'dev-unity']) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`));
  fixture.office.org.createDepartment({ id: 'pmo', name: 'PMO', color: '#64748b' });
  fixture.office.org.createSeat('pmo', { id: 'pm-live', title: 'PM', description: '', role: 'leader', coordinator: true });
  fixture.office.org.assignAgent('pm-live', insertAgent(fixture.db, 'agent-pm'));
  fixture.office.dispatch.setMode('on');
  return fixture;
};
const exec = (fixture: Fixture, title: string, assigneeSeatId: string, extra: { dependsOn?: string[]; estimateMinutes?: number } = {}) =>
  fixture.office.tasks.create(seat('dev-lead'), { title, body: REQ, assigneeSeatId, kind: 'execution', ...extra });
const lines = (fixture: Fixture, channel: string, needle: string) => fixture.office.messages.list(manager, channel, { limit: 500 }).filter(message => message.body.includes(needle));
const threadLines = (fixture: Fixture, taskId: string, needle: string) => (fixture.db.raw.prepare("SELECT body,mentions_json AS mentions FROM messages WHERE sender_kind='system' AND body LIKE ?").all(`%${needle}%`) as Array<{ body: string; mentions: string }>).filter(row => row.body.includes(taskId));

test('assigned → the owner takes it, estimates and starts in one call, no ACK or PM step', () => {
  const fixture = setup(); const { tasks, dispatch } = fixture.office;
  const task = exec(fixture, 'HUD toast', 'dev-unity');
  assert.equal(dispatch.readiness(task.id).state, 'needs-action', 'no estimate yet');
  const started = dispatch.start(seat('dev-unity'), task.id, { estimateMinutes: 90 }, 'mcp');
  assert.equal(started.status, 'doing'); assert.equal(started.estimateMinutes, 90);
  assert.deepEqual(tasks.history(task.id).map(event => event.toStatus), ['todo', 'doing']);
  assert.deepEqual(tasks.changes(task.id).map(change => change.field).sort(), ['estimateMinutes', 'status']);
  assert.throws(() => dispatch.start(seat('dev-fe'), exec(fixture, 'Too big', 'dev-fe').id, { estimateMinutes: 300 }, 'mcp'), /not_ready|estimate/);
  tasks.update(seat('dev-unity'), task.id, { status: 'done', note: 'toast on feat/hud, tests green' });
  assert.equal(tasks.get(task.id).result, 'unknown', 'done is not pass: nothing is faked');
  fixture.close();
});

test('a real input dependency still stops START, estimate or not (the 513 case)', () => {
  const fixture = setup(); const { dispatch } = fixture.office;
  const adapter = exec(fixture, 'BE adapter', 'dev-be', { estimateMinutes: 60 });
  const table = exec(fixture, 'FE schedule table', 'dev-fe', { dependsOn: [adapter.id] });
  assert.throws(() => dispatch.start(seat('dev-fe'), table.id, { estimateMinutes: 60 }, 'mcp'), /not_ready: waits for/);
  fixture.close();
});

test('a blocker on one step lets the owner start and continue; a task blocker still stops it (the 479 case)', () => {
  const fixture = setup(); const { tasks, dispatch, blockers, alerts } = fixture.office;
  const task = exec(fixture, 'HUD M3 integration', 'dev-unity', { estimateMinutes: 150 });
  const step = blockers.open(seat('dev-lead'), { kind: 'permission', description: 'Runner build capability missing for the QA build step', taskIds: [task.id], resolverSeatId: 'dev-lead', nextStep: 'grant the runner capability', scope: 'step' });
  assert.equal(step.scope, 'step');
  assert.equal(dispatch.readiness(task.id).state, 'ready', 'the independent work can start');
  dispatch.start(seat('dev-unity'), task.id, {}, 'mcp');
  assert.equal(alerts.current().filter(alert => alert.kind === 'gate-broken').length, 0);
  assert.equal(threadLines(fixture, task.id, '⚠').length, 0, 'no in-progress warning for a step blocker');
  assert.equal(dispatch.board(manager, {}).doing.includes(task.id), true);
  const other = exec(fixture, 'Needs the whole runner', 'dev-be', { estimateMinutes: 60 });
  blockers.open(seat('dev-lead'), { kind: 'environment', description: 'No runner at all', taskIds: [other.id], resolverSeatId: 'dev-lead', nextStep: 'register a runner' });
  assert.throws(() => dispatch.start(seat('dev-be'), other.id, {}, 'mcp'), /not_ready/);
  // A task blocker that appears under running work warns once; narrowing it to the step clears the alert.
  const wide = blockers.open(seat('dev-lead'), { kind: 'decision', description: 'Pick the HUD layout', taskIds: [task.id], resolverSeatId: 'dev-lead', nextStep: 'decide' });
  assert.equal(threadLines(fixture, task.id, '⚠').length, 1);
  assert.equal(alerts.current().filter(alert => alert.kind === 'gate-broken').length, 1);
  blockers.update(seat('dev-lead'), wide.id, { scope: 'step' });
  assert.equal(alerts.current().filter(alert => alert.kind === 'gate-broken').length, 0);
  assert.equal(tasks.get(task.id).status, 'doing', 'status never changed by blockers');
  assert.equal(blockers.get(wide.id).status, 'open', 'the blocker is not resolved for anyone');
  fixture.close();
});

test('a task over its estimate is told once to its owner in the task thread; the PM is not woken', () => {
  const fixture = setup(); const { dispatch, alerts } = fixture.office;
  const task = exec(fixture, 'Slow', 'dev-fe', { estimateMinutes: 60 });
  dispatch.start(seat('dev-fe'), task.id, {}, 'mcp');
  const later = Date.now() + 3 * 3_600_000;
  assert.deepEqual(alerts.run(later).map(alert => alert.kind), ['overdue']);
  const told = threadLines(fixture, task.id, 'in doing');
  assert.equal(told.length, 1); assert.deepEqual(JSON.parse(told[0]!.mentions), ['dev-fe']);
  assert.equal(lines(fixture, 'leaders', 'Exceptions —').length, 0, 'no digest and no PM ping for work in progress');
  assert.deepEqual(alerts.run(later + 60_000), [], 'reported once');
  fixture.close();
});

test('a second cause under running work is warned once; a task declared blocked with only a step blocker is not offered', () => {
  const fixture = setup(); const { dispatch, blockers, tasks } = fixture.office;
  const task = exec(fixture, 'Running', 'dev-unity', { estimateMinutes: 60 });
  dispatch.start(seat('dev-unity'), task.id, {}, 'mcp');
  blockers.open(seat('dev-lead'), { kind: 'decision', description: 'Pick the layout', taskIds: [task.id], resolverSeatId: 'dev-lead', nextStep: 'decide' });
  blockers.open(seat('dev-lead'), { kind: 'environment', description: 'Device missing', taskIds: [task.id], resolverSeatId: 'dev-lead', nextStep: 'get a device' });
  assert.equal(threadLines(fixture, task.id, '⚠').length, 2, 'the new cause is told, once');
  dispatch.refresh();
  assert.equal(threadLines(fixture, task.id, '⚠').length, 2, 'never repeated');
  const parked = exec(fixture, 'Parked', 'dev-be', { estimateMinutes: 30 });
  blockers.open(seat('dev-lead'), { kind: 'permission', description: 'Store upload step', taskIds: [parked.id], resolverSeatId: 'dev-lead', nextStep: 'grant', scope: 'step' });
  tasks.update(seat('dev-be'), parked.id, { status: 'blocked', note: 'cannot move' });
  assert.equal(dispatch.readiness(parked.id).state, 'needs-action');
  assert.equal(dispatch.readiness(parked.id).reasons[0]!.code, 'blocked_step_only');
  assert.equal(dispatch.start(seat('dev-be'), parked.id, {}, 'mcp').status, 'doing', 'the owner can still pick it up');
  fixture.close();
});
