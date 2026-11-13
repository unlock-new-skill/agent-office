import assert from 'node:assert/strict';
import test from 'node:test';
import { createOffice } from '../../src/server/collaboration/office.js';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const seatAll = (fixture: Fixture, seatIds: string[]): void => { for (const seatId of seatIds) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`)); };
const exec = (fixture: Fixture, title: string, assigneeSeatId: string, extra: { dependsOn?: string[]; passRequired?: string[]; estimateMinutes?: number } = {}) =>
  fixture.office.tasks.create(seat('dev-lead'), { title, body: REQ, assigneeSeatId, kind: 'execution', estimateMinutes: 60, ...extra });
const readyLines = (fixture: Fixture, taskId: string): number => fixture.office.messages.list(manager, 'dev', { limit: 200 }).filter(message => message.body.includes(`ready to start: ${taskId} `)).length;
const finish = (fixture: Fixture, taskId: string, result?: 'pass' | 'fail' | 'inconclusive'): void => {
  const { tasks } = fixture.office; const owner = tasks.get(taskId).assigneeSeatId!;
  tasks.update(seat(owner), taskId, { status: 'doing' });
  // The assignee reports; a PASS is recorded by the lead (it opens the steps that need it).
  tasks.update(seat(owner), taskId, { status: 'done', note: 'delivered', ...(result && result !== 'pass' ? { result } : {}) });
  if (result === 'pass') tasks.update(seat('dev-lead'), taskId, { result: 'pass', reason: 'reviewed the run' });
};
const dispatched = (): Fixture => { const fixture = createSeededOffice(); seatAll(fixture, ['dev-lead', 'dev-be', 'dev-fe', 'dev-unity']); fixture.office.dispatch.setMode('on'); return fixture; };

test('DONE is not PASS: a test task done with FAIL does not open the step that needs PASS', () => {
  const fixture = dispatched(); const { dispatch } = fixture.office;
  const probe = exec(fixture, 'Probe 503', 'dev-be');
  const gate = exec(fixture, 'Gate 487', 'dev-fe', { dependsOn: [probe.id], passRequired: [probe.id] });
  finish(fixture, probe.id, 'fail');
  const readiness = dispatch.readiness(gate.id);
  assert.equal(readiness.state, 'waiting'); assert.match(readiness.reasons[0]!.text, /result fail; this task needs pass/);
  assert.equal(readyLines(fixture, gate.id), 0);
  assert.throws(() => dispatch.start(seat('dev-fe'), gate.id, {}, 'mcp'), /not_ready/);
  const unknown = exec(fixture, 'Gate unknown', 'dev-unity', { dependsOn: [probe.id], passRequired: [probe.id] });
  fixture.office.tasks.update(seat('dev-lead'), probe.id, { result: 'unknown' });
  assert.equal(dispatch.readiness(unknown.id).state, 'needs-action', 'a missing result needs confirmation, not a guess');
  assert.throws(() => fixture.office.tasks.update(seat('dev-be'), probe.id, { result: 'pass' }), /pass_needs_review/);
  fixture.office.tasks.update(seat('dev-lead'), probe.id, { result: 'pass', reason: 'rerun green' });
  assert.equal(dispatch.readiness(gate.id).state, 'ready');
  fixture.close();
});

test('a dependency that only needs completed is met by DONE whatever the result', () => {
  const fixture = dispatched(); const { dispatch } = fixture.office;
  const a = exec(fixture, 'A', 'dev-be'); const b = exec(fixture, 'B', 'dev-fe', { dependsOn: [a.id] });
  finish(fixture, a.id, 'fail');
  assert.equal(dispatch.readiness(b.id).state, 'ready');
  assert.equal(readyLines(fixture, b.id), 1);
  fixture.close();
});

test('dependencies met but an open permission, input or window blocker: not ready, START refused; resolving it offers once', () => {
  const fixture = dispatched(); const { dispatch, blockers, tasks } = fixture.office;
  const task = exec(fixture, 'Deploy check', 'dev-be');
  assert.equal(readyLines(fixture, task.id), 1);
  const blocker = blockers.open(seat('dev-lead'), { kind: 'permission', description: 'Staging write access not granted', taskIds: [task.id], resolverSeatId: 'ops-lead', nextStep: 'ops-lead grants staging write, link the decision' });
  assert.equal(dispatch.readiness(task.id).state, 'needs-action');
  assert.throws(() => dispatch.start(seat('dev-be'), task.id, { generation: 1 }, 'mcp'), /readiness_changed|not_ready/);
  assert.throws(() => tasks.update(seat('dev-be'), task.id, { status: 'doing' }), /not_ready/);
  blockers.resolve(manager, blocker.id, 'grant #pm204 for staging until Friday');
  const readiness = dispatch.readiness(task.id);
  assert.equal(readiness.state, 'ready'); assert.equal(readiness.generation, 2);
  assert.equal(readyLines(fixture, task.id), 2, 'one offer per generation');
  fixture.close();
});

test('ready and owner free: exactly one notice, the task stays todo until START; START claims once', () => {
  const fixture = dispatched(); const { dispatch, tasks, wake } = fixture.office;
  const task = exec(fixture, 'Login API', 'dev-be');
  assert.equal(readyLines(fixture, task.id), 1); assert.equal(tasks.get(task.id).status, 'todo');
  assert.equal(wake.check('dev-be').wake, true);
  dispatch.refresh(); dispatch.refresh();
  assert.equal(readyLines(fixture, task.id), 1);
  const started = dispatch.start(seat('dev-be'), task.id, { generation: 1 }, 'mcp');
  assert.equal(started.status, 'doing'); assert.ok(started.actualStart);
  assert.throws(() => dispatch.start(seat('dev-be'), task.id, { generation: 1 }, 'mcp'), /already_started/);
  assert.throws(() => dispatch.start(seat('dev-fe'), task.id, {}, 'mcp'), /start_by_assignee_only|already_started/);
  fixture.close();
});

test('a busy owner gets the next ready task queued, offered when free; never two executions at once', () => {
  const fixture = dispatched(); const { dispatch, tasks } = fixture.office;
  const first = exec(fixture, 'First', 'dev-be'); dispatch.start(seat('dev-be'), first.id, {}, 'mcp');
  const second = exec(fixture, 'Second', 'dev-be'); const third = exec(fixture, 'Third', 'dev-be');
  assert.equal(dispatch.readiness(second.id).queued, true);
  assert.equal(readyLines(fixture, second.id), 0);
  assert.throws(() => dispatch.start(seat('dev-be'), second.id, {}, 'mcp'), /owner_busy/);
  tasks.update(seat('dev-be'), first.id, { status: 'done', note: 'shipped' });
  assert.equal(readyLines(fixture, second.id), 1, 'oldest ready offered first'); assert.equal(readyLines(fixture, third.id), 0);
  assert.equal(dispatch.readiness(third.id).queued, true);
  dispatch.start(seat('dev-be'), second.id, {}, 'mcp');
  assert.equal(tasks.list(manager, { status: 'doing', assignee: 'dev-be' }).length, 1);
  fixture.close();
});

test('restart and replay: readiness is reconciled from the database without duplicate notices or lost offers', () => {
  const fixture = dispatched();
  const task = exec(fixture, 'Survives restart', 'dev-be');
  const before = fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
  const restarted = createOffice(fixture.db, { maxAutoWakes: 15, emit: () => undefined, afterTask: 'off' });
  restarted.dispatch.refresh();
  assert.equal((fixture.db.raw.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, before.count);
  assert.equal(readyLines(fixture, task.id), 1);
  // An offer missed while dispatch was off is sent once on reconcile.
  restarted.dispatch.setMode('off');
  const missed = restarted.tasks.create(seat('dev-lead'), { title: 'While off', body: REQ, assigneeSeatId: 'dev-fe', kind: 'execution', estimateMinutes: 30 });
  assert.equal(readyLines(fixture, missed.id), 0);
  restarted.dispatch.setMode('on'); restarted.dispatch.refresh();
  assert.equal(readyLines(fixture, missed.id), 1);
  restarted.close(); fixture.close();
});

test('a dependency reopened or a grant revoked before START cancels readiness; the old offer is refused with the reason', () => {
  const fixture = dispatched(); const { dispatch, tasks, blockers } = fixture.office;
  const a = exec(fixture, 'A', 'dev-unity'); finish(fixture, a.id);
  const b = exec(fixture, 'B', 'dev-be', { dependsOn: [a.id] });
  const offered = dispatch.readiness(b.id).generation;
  tasks.update(seat('dev-lead'), a.id, { status: 'todo', note: 'reopened: regression' });
  assert.equal(dispatch.readiness(b.id).state, 'waiting');
  assert.throws(() => dispatch.start(seat('dev-be'), b.id, { generation: offered }, 'mcp'), /readiness_changed/);
  const grant = blockers.open(manager, { kind: 'environment', description: 'Test window closed', taskIds: [b.id], resolverRole: 'manager', nextStep: 'open the window' });
  blockers.resolve(manager, grant.id, 'window open 14:00-16:00');
  finish(fixture, a.id);
  const regained = dispatch.readiness(b.id);
  assert.equal(regained.state, 'ready'); assert.ok(regained.generation > offered, 'ready again is a new generation');
  blockers.reopen(manager, grant.id, 'window revoked early');
  assert.throws(() => dispatch.start(seat('dev-be'), b.id, { generation: regained.generation }, 'mcp'), /readiness_changed/);
  fixture.close();
});

test('a task in progress whose grant is revoked only warns its owner and leader; nothing is changed', () => {
  const fixture = dispatched(); const { dispatch, tasks, blockers, messages } = fixture.office;
  const task = exec(fixture, 'Running', 'dev-be');
  const grant = blockers.open(manager, { kind: 'permission', description: 'Prod read grant', taskIds: [task.id], resolverRole: 'manager', nextStep: 'grant' });
  blockers.resolve(manager, grant.id, 'standing grant G-7');
  dispatch.start(seat('dev-be'), task.id, {}, 'mcp');
  blockers.reopen(manager, grant.id, 'grant G-7 revoked');
  dispatch.refresh();
  const warnings = messages.list(manager, 'dev', { limit: 200 }).filter(message => message.body.startsWith(`⚠ ${task.id}`));
  assert.equal(warnings.length, 1); assert.deepEqual([...warnings[0]!.mentions].sort(), ['dev-be', 'dev-lead']);
  assert.equal(tasks.get(task.id).status, 'doing');
  fixture.close();
});

test('board: 3 tasks sharing 2 blockers count 3 tasks and 2 blockers; waiting is apart from needs-action; tracking apart', () => {
  const fixture = dispatched(); const { dispatch, blockers, tasks } = fixture.office;
  const [x, y, z] = [exec(fixture, 'X', 'dev-be'), exec(fixture, 'Y', 'dev-fe'), exec(fixture, 'Z', 'dev-unity')];
  const hud = blockers.open(seat('dev-lead'), { kind: 'defect', description: 'HUD crashes on load', taskIds: [x.id, y.id, z.id], resolverSeatId: 'dev-unity', nextStep: 'fix crash, attach repro run' });
  blockers.open(seat('dev-lead'), { kind: 'missing-input', description: 'Map tiles not delivered', taskIds: [y.id, z.id], resolverSeatId: 'design-map', nextStep: 'deliver tiles to assets/map' });
  const dep = exec(fixture, 'Upstream', 'dev-lead'); const waiter = exec(fixture, 'Waiter', 'dev-be', { dependsOn: [dep.id] });
  tasks.create(seat('dev-lead'), { title: 'HUD umbrella', body: REQ, assigneeSeatId: 'dev-lead', kind: 'tracking', estimateMinutes: 4800 });
  const board = dispatch.board(manager, { departmentId: 'dev' });
  assert.equal(board.totals.needsActionTasks, 3); assert.equal(board.totals.blockers, 2);
  assert.deepEqual(board.needsAction.find(group => group.id === hud.id)!.taskIds.sort(), [x.id, y.id, z.id].sort());
  assert.equal(board.needsAction.find(group => group.id === hud.id)!.resolver, '@dev-unity');
  assert.deepEqual(board.waiting.map(group => group.id), [`dep:${dep.id}`]); assert.deepEqual(board.waiting[0]!.taskIds, [waiter.id]);
  assert.equal(board.tracking.length, 1); assert.ok(!board.ready.includes(board.tracking[0]!));
  assert.equal(board.tasks[board.tracking[0]!]!.estimateMinutes, 4800);
  assert.deepEqual(dispatch.board(manager, { resolver: 'design-map' }).needsAction.map(group => group.title), ['Map tiles not delivered']);
  assert.throws(() => dispatch.board(seat('ba-docs'), { departmentId: 'dev' }), /forbidden_task_read/);
  fixture.close();
});

test('legacy BLOCKED tasks without metadata show as unresolved and are never auto-run or closed', () => {
  const fixture = dispatched(); const { dispatch, tasks } = fixture.office;
  const legacy = tasks.create(seat('dev-lead'), { title: 'Old blocked', body: REQ, assigneeSeatId: 'dev-be' });
  tasks.update(seat('dev-be'), legacy.id, { status: 'blocked', note: 'waiting on someone' });
  const board = dispatch.board(manager, { departmentId: 'dev' });
  const groups = board.needsAction.filter(group => group.taskIds.includes(legacy.id)).map(group => group.id).sort();
  assert.deepEqual(groups, ['blocked-without-record', 'estimate', 'unclassified']);
  assert.equal(readyLines(fixture, legacy.id), 0); assert.equal(tasks.get(legacy.id).status, 'blocked');
  assert.throws(() => dispatch.start(seat('dev-be'), legacy.id, {}, 'mcp'), /start_needs_execution_task/);
  fixture.close();
});

test('blockers: only people who may change the tasks open them; resolving needs evidence; members cannot resolve others', () => {
  const fixture = dispatched(); const { blockers } = fixture.office;
  const task = exec(fixture, 'T', 'dev-be');
  assert.throws(() => blockers.open(seat('ba-docs'), { kind: 'decision', description: 'Pick a stack', taskIds: [task.id] }), /forbidden_task_change/);
  const blocker = blockers.open(seat('dev-be'), { kind: 'decision', description: 'Pick a stack', taskIds: [task.id], resolverSeatId: 'ba-lead', nextStep: 'ba-lead decides' });
  assert.throws(() => blockers.resolve(seat('dev-be'), blocker.id, 'decided myself'), /forbidden_blocker/);
  assert.throws(() => blockers.resolve(seat('ba-lead'), blocker.id, 'ok'), /resolution_required/);
  assert.equal(blockers.resolve(seat('ba-lead'), blocker.id, 'decision in #leaders 4225: use Hono').status, 'resolved');
  assert.equal(blockers.get(blocker.id).resolvedBy, 'ba-lead');
  fixture.close();
});

test('an assignee cannot unlink a blocker from its own task; a leader can, and the task is told', () => {
  const fixture = dispatched(); const { blockers, messages } = fixture.office;
  const [a, b] = [exec(fixture, 'A', 'dev-be'), exec(fixture, 'B', 'dev-fe')];
  const blocker = blockers.open(seat('dev-lead'), { kind: 'permission', description: 'No staging grant', taskIds: [a.id, b.id], resolverRole: 'manager', nextStep: 'grant' });
  assert.throws(() => blockers.unlink(seat('dev-be'), blocker.id, a.id), /forbidden_blocker/);
  assert.deepEqual(blockers.unlink(seat('dev-lead'), blocker.id, a.id).taskIds, [b.id]);
  assert.ok(messages.list(manager, 'dev', { limit: 200 }).some(message => message.body.includes(`unlinked from this task`)));
  fixture.close();
});

test('reopening a done task clears its result, so a stale pass opens nothing', () => {
  const fixture = dispatched(); const { tasks, dispatch } = fixture.office;
  const a = exec(fixture, 'A', 'dev-be'); finish(fixture, a.id, 'pass');
  const b = exec(fixture, 'B', 'dev-fe', { dependsOn: [a.id], passRequired: [a.id] });
  assert.equal(dispatch.readiness(b.id).state, 'ready');
  assert.equal(tasks.update(seat('dev-lead'), a.id, { status: 'todo', note: 'regression' }).result, 'unknown');
  tasks.update(seat('dev-be'), a.id, { status: 'doing' }); tasks.update(seat('dev-be'), a.id, { status: 'done', note: 'closed again' });
  assert.equal(dispatch.readiness(b.id).state, 'needs-action', 'no new verification recorded');
  fixture.close();
});

test('handing a running task to someone already doing an execution task is refused', () => {
  const fixture = dispatched(); const { tasks, dispatch } = fixture.office;
  const busy = exec(fixture, 'Busy', 'dev-fe'); dispatch.start(seat('dev-fe'), busy.id, {}, 'mcp');
  const live = exec(fixture, 'Live', 'dev-be'); dispatch.start(seat('dev-be'), live.id, {}, 'mcp');
  assert.throws(() => tasks.update(seat('dev-lead'), live.id, { assigneeSeatId: 'dev-fe', status: 'doing', handoffNote: 'take over the API work' }), /owner_busy/);
  assert.equal(tasks.get(live.id).assigneeSeatId, 'dev-be');
  fixture.close();
});

test('a failed nested step rolls back alone and the database keeps working', () => {
  const fixture = dispatched(); const { db } = fixture;
  db.transaction(() => {
    db.raw.prepare("INSERT INTO app_settings(key,value) VALUES ('outer','1')").run();
    assert.throws(() => db.transaction(() => { db.raw.prepare("INSERT INTO app_settings(key,value) VALUES ('inner','1')").run(); throw new Error('boom'); }), /boom/);
  });
  assert.ok(db.raw.prepare("SELECT 1 FROM app_settings WHERE key='outer'").get());
  assert.equal(db.raw.prepare("SELECT 1 FROM app_settings WHERE key='inner'").get(), undefined);
  assert.throws(() => db.transaction(() => { throw new Error('outer boom'); }), /outer boom/);
  assert.equal(db.transaction(() => 42), 42, 'depth back to zero: a new top-level transaction starts');
  fixture.close();
});

test('PASS is recorded by the lead or the PM; the assignee alone only when no lead or PM oversees the task', () => {
  const fixture = dispatched(); const { tasks, org } = fixture.office;
  const task = exec(fixture, 'Probe', 'dev-be'); finish(fixture, task.id);
  assert.throws(() => tasks.update(seat('dev-be'), task.id, { result: 'pass' }), /pass_needs_review/);
  assert.equal(tasks.update(seat('dev-be'), task.id, { result: 'fail' }).result, 'fail', 'bad news is never blocked');
  org.createDepartment({ id: 'pmo', name: 'PMO', color: '#64748b' });
  org.createSeat('pmo', { id: 'pm-live', title: 'PM', description: '', role: 'leader', coordinator: true });
  assert.equal(tasks.update(seat('pm-live'), task.id, { result: 'pass' }).result, 'pass');
  // A department with no lead, no deputy, no parent task and an office without a PM: nobody to review, so self-pass.
  org.updateSeat('pm-live', { coordinator: false });
  const solo = org.createDepartment({ id: 'solo', name: 'Solo', color: '#64748b' });
  org.createSeat(solo.id, { id: 'solo-dev', title: 'Solo', description: '', role: 'member' });
  const own = tasks.create(manager, { title: 'Own check', body: REQ, assigneeSeatId: 'solo-dev', kind: 'execution', estimateMinutes: 30 });
  assert.equal(tasks.update(seat('solo-dev'), own.id, { status: 'done', note: 'ok', result: 'pass' }).result, 'pass');
  fixture.close();
});

test('the PM, like the manager, may start a task that is not ready; the override is written in the thread', () => {
  const fixture = dispatched(); const { tasks, org, messages } = fixture.office;
  org.createDepartment({ id: 'pmo', name: 'PMO', color: '#64748b' });
  org.createSeat('pmo', { id: 'pm-live', title: 'PM', description: '', role: 'leader', coordinator: true });
  const upstream = exec(fixture, 'Upstream', 'dev-fe'); const task = exec(fixture, 'Urgent', 'dev-be', { dependsOn: [upstream.id] });
  assert.throws(() => tasks.update(seat('dev-lead'), task.id, { status: 'doing' }), /waiting_for_dependencies/);
  assert.equal(tasks.update(seat('pm-live'), task.id, { status: 'doing', reason: 'hotfix, upstream reviewed by hand' }).status, 'doing');
  assert.ok(messages.list(manager, 'dev', { limit: 200 }).some(message => message.body.includes('Started by override of @pm-live without the readiness check')));
  fixture.close();
});

test('exception digest: new alerts once in #leaders with owner and next step; quiet while unchanged; again when they return', () => {
  const fixture = dispatched(); const { tasks, dispatch, alerts, blockers, org, messages } = fixture.office;
  org.createDepartment({ id: 'pmo', name: 'PMO', color: '#64748b' });
  org.createSeat('pmo', { id: 'pm-live', title: 'PM', description: '', role: 'leader', coordinator: true });
  const orphan = exec(fixture, 'Orphan', 'dev-be'); tasks.update(seat('dev-lead'), orphan.id, { assigneeSeatId: null });
  const slow = exec(fixture, 'Slow', 'dev-fe', { estimateMinutes: 60 }); dispatch.start(seat('dev-fe'), slow.id, {}, 'mcp');
  const stuck = exec(fixture, 'Stuck', 'dev-unity');
  blockers.open(seat('dev-lead'), { kind: 'decision', description: 'Pick the HUD font', taskIds: [stuck.id], dueAt: Date.now() + 60_000, resolverSeatId: 'design-lead', nextStep: 'design-lead picks one of the two fonts' });
  const later = Date.now() + 2 * 3_600_000;
  const reported = alerts.run(later);
  assert.deepEqual(reported.map(alert => alert.kind).sort(), ['blocker-overdue', 'overdue', 'owner-missing']);
  const digest = messages.list(manager, 'leaders', { limit: 200 }).filter(message => message.body.includes('Exceptions —'));
  assert.equal(digest.length, 1); assert.ok(digest[0]!.mentions.includes('pm-live'));
  assert.match(digest[0]!.body, /\[blocker-overdue\].*owner @design-lead — next: design-lead picks one/);
  assert.deepEqual(alerts.run(later + 60_000), [], 'nothing new: no second digest');
  tasks.update(seat('dev-lead'), orphan.id, { assigneeSeatId: 'dev-mobile' });
  assert.deepEqual(alerts.run(later + 120_000), []);
  tasks.update(seat('dev-lead'), orphan.id, { assigneeSeatId: null });
  assert.deepEqual(alerts.run(later + 180_000).map(alert => alert.key), [`owner:${orphan.id}`], 'came back: reported again');
  dispatch.setMode('off');
  assert.deepEqual(alerts.run(later + 240_000), [], 'off: no alerts');
  fixture.close();
});

test('a granted window that ends opens its blocker again: not started → not ready; running → warned only', () => {
  const fixture = dispatched(); const { blockers, dispatch, tasks, messages } = fixture.office;
  const waiting = exec(fixture, 'Waiting', 'dev-be'); const running = exec(fixture, 'Running', 'dev-fe');
  const window = blockers.open(manager, { kind: 'environment', description: 'Test window', taskIds: [waiting.id, running.id], resolverRole: 'manager', nextStep: 'open a window' });
  assert.throws(() => blockers.resolve(manager, window.id, 'window open', Date.now() - 1), /valid_until_must_be_in_the_future/);
  const until = Date.now() + 60_000;
  blockers.resolve(manager, window.id, 'window 14:00-15:00 granted', until);
  dispatch.start(seat('dev-fe'), running.id, {}, 'mcp');
  assert.equal(dispatch.readiness(waiting.id).state, 'ready');
  assert.equal(blockers.expireDue(until - 1), 0);
  assert.equal(blockers.expireDue(until + 1), 1);
  assert.equal(blockers.get(window.id).status, 'open');
  assert.equal(dispatch.readiness(waiting.id).state, 'needs-action');
  assert.throws(() => dispatch.start(seat('dev-be'), waiting.id, {}, 'mcp'), /not_ready/);
  assert.equal(tasks.get(running.id).status, 'doing');
  assert.ok(messages.list(manager, 'dev', { limit: 200 }).some(message => message.body.startsWith(`⚠ ${running.id}`)));
  assert.equal(blockers.expireDue(until + 2), 0, 'expires once');
  fixture.close();
});
