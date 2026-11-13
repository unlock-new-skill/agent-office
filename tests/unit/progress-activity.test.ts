import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_STALE_MS } from '../../src/server/collaboration/progress-service.js';
import { createSeededOffice, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const make = (fixture: Fixture, title: string, assigneeSeatId: string) => fixture.office.tasks.create(manager, { title, body: REQ, assigneeSeatId, estimateMinutes: 60 });
const activityOf = (fixture: Fixture, seatId: string, now?: number) => fixture.office.progress.activity(now).find(entry => entry.seatId === seatId)!;
const age = (fixture: Fixture, ms: number): void => { fixture.db.raw.prepare('UPDATE task_participants SET updated_at=updated_at-?').run(ms); };

test('A: local output accepted while runtime acceptance stays open; nobody shown as waiting for a local review', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const task = make(fixture, 'HUD shared box (391)', 'dev-unity');
  tasks.update(seat('dev-unity'), task.id, { status: 'doing' });
  const local = progress.recordOutput(seat('dev-unity'), task.id, { name: 'Local tests 197/197 incl. shared 29/29', scope: 'local', evidence: 'receipt r4', result: 'pass', missing: 'member review' }, 'mcp');
  progress.setParticipant(manager, task.id, { seatId: 'dev-fe', role: 'reviewer', state: 'active', phase: 'review r4 results' }, 'ui');
  const accepted = progress.acceptOutput(seat('dev-fe'), task.id, local.id, { note: 'checked 197/197', missing: '', accept: true }, 'mcp');
  assert.equal(accepted.acceptedBy, 'dev-fe'); assert.equal(accepted.missing, '');
  progress.recordOutput(seat('dev-unity'), task.id, { name: 'Runtime / URP / BA / P5', scope: 'real-env', result: 'unknown', missing: 'runtime run, URP drift, BA acceptance, P5' }, 'mcp');
  progress.setParticipant(manager, task.id, { seatId: 'dev-fe', role: 'reviewer', state: 'done', phase: 'local review done' }, 'ui');
  const outputs = progress.outputs(task.id);
  assert.deepEqual(outputs.map(output => [output.scope, Boolean(output.acceptedBy), output.missing]), [['local', true, ''], ['real-env', false, 'runtime run, URP drift, BA acceptance, P5']]);
  assert.notEqual(activityOf(fixture, 'dev-fe').state, 'waiting', 'reviewer finished: not waiting for local review');
  assert.equal(tasks.get(task.id).status, 'doing', 'outputs never change the task');
  assert.equal(tasks.get(task.id).result, 'unknown');
  fixture.close();
});

test('B: contributor executing, owner not claimed active, reviewer and intake done; mesh accepted, PBR open', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const task = make(fixture, 'Bridge FBX (511)', 'design-map');
  tasks.update(manager, task.id, { status: 'doing' });
  progress.setParticipant(manager, task.id, { seatId: 'design-item', role: 'executor', state: 'active', phase: 'export FBX v02' }, 'ui');
  progress.setParticipant(manager, task.id, { seatId: 'design-atom', role: 'reviewer', state: 'done', phase: 'FBX re-import check' }, 'ui');
  progress.setParticipant(manager, task.id, { seatId: 'dev-fe', role: 'intake', state: 'done', phase: 'FBX received' }, 'ui');
  const mesh = progress.recordOutput(seat('design-item'), task.id, { name: 'Mesh + UV (intermediate)', scope: 'local', evidence: 'bridge_v02.fbx', result: 'pass', missing: 'PBR textures, engine import' }, 'mcp');
  progress.acceptOutput(seat('design-atom'), task.id, mesh.id, { note: 'signature ok', accept: true }, 'mcp');
  assert.equal(activityOf(fixture, 'design-item').state, 'executing');
  assert.equal(activityOf(fixture, 'design-item').phase, 'export FBX v02');
  assert.notEqual(activityOf(fixture, 'design-map').state, 'executing', 'owner of a task someone else executes is not active');
  progress.setParticipant(seat('design-item'), task.id, { seatId: 'design-item', role: 'executor', state: 'waiting', phase: 'wait texture 510', note: 'WAIT_INPUT texture 510' }, 'mcp');
  const waiting = activityOf(fixture, 'design-item');
  assert.equal(waiting.state, 'waiting'); assert.ok(waiting.reasons.includes('WAIT_INPUT texture 510'));
  assert.equal(activityOf(fixture, 'design-map').state, 'unknown');
  fixture.close();
});

test('C: a stopped run is not running; result and wait shown apart', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const task = make(fixture, 'Schedule package (513)', 'dev-be');
  tasks.update(seat('dev-be'), task.id, { status: 'doing' });
  progress.setParticipant(seat('dev-be'), task.id, { seatId: 'dev-be', role: 'executor', state: 'active', phase: 'local validation' }, 'mcp');
  progress.recordOutput(seat('dev-be'), task.id, { name: 'Office 18 + Schedule 14 + full packages', scope: 'local', result: 'pass', missing: 'credential, real Office, deploy' }, 'mcp');
  progress.setParticipant(seat('dev-be'), task.id, { seatId: 'dev-be', role: 'executor', state: 'stopped', phase: 'local validation finished' }, 'mcp');
  const activity = activityOf(fixture, 'dev-be');
  assert.notEqual(activity.state, 'executing'); assert.notEqual(activity.state, 'reviewing');
  assert.equal(progress.outputs(task.id)[0]!.missing, 'credential, real Office, deploy');
  fixture.close();
});

test('D: only the recorded phase is shown; nothing implies image complete', () => {
  const fixture = createSeededOffice(); const { progress } = fixture.office;
  const task = make(fixture, 'Bridge texture (510)', 'design-item');
  progress.setParticipant(manager, task.id, { seatId: 'design-item', role: 'executor', state: 'active', phase: 'raw image downloaded 22:39:11; derivatives in progress' }, 'ui');
  const activity = activityOf(fixture, 'design-item');
  assert.equal(activity.phase, 'raw image downloaded 22:39:11; derivatives in progress');
  assert.deepEqual(progress.outputs(task.id), [], 'no output until one is recorded');
  fixture.close();
});

test('E: a seat owning a blocked task but reviewing another shows the review; the blocked task is unchanged', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const parent = make(fixture, 'Parent', 'dev-fe'); tasks.update(seat('dev-fe'), parent.id, { status: 'blocked', note: 'waiting input' });
  const other = make(fixture, 'Other', 'dev-be');
  progress.setParticipant(manager, other.id, { seatId: 'dev-fe', role: 'reviewer', state: 'active', phase: 'review 514' }, 'ui');
  const activity = activityOf(fixture, 'dev-fe');
  assert.equal(activity.state, 'reviewing'); assert.equal(activity.taskId, other.id);
  assert.ok(activity.also.some(entry => entry.taskId === parent.id && entry.role === 'owner' && entry.state === 'blocked'));
  assert.equal(tasks.get(parent.id).status, 'blocked');
  fixture.close();
});

test('F: silence is unknown with the last signal time, never assumed from owning or being online', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const blocked = make(fixture, 'Blocked only', 'dev-mobile'); tasks.update(seat('dev-mobile'), blocked.id, { status: 'blocked' });
  assert.equal(activityOf(fixture, 'dev-mobile').state, 'unknown', 'owning a blocked task says nothing about the person');
  assert.equal(activityOf(fixture, 'dev-docs').source, 'no activity recorded');
  const task = make(fixture, 'Silent', 'dev-unity');
  progress.setParticipant(manager, task.id, { seatId: 'dev-unity', role: 'executor', state: 'active', phase: 'build' }, 'ui');
  age(fixture, ACTIVITY_STALE_MS + 60_000);
  const stale = activityOf(fixture, 'dev-unity');
  assert.equal(stale.state, 'unknown'); assert.equal(stale.stale, true); assert.ok(stale.since); assert.match(stale.reasons[0]!, /no update for/);
  fixture.close();
});

test('legacy fallback uses the current doing run, and a finished role is evidence of availability', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const task = make(fixture, 'Legacy doing', 'dev-be'); tasks.update(seat('dev-be'), task.id, { status: 'doing' });
  const legacy = activityOf(fixture, 'dev-be');
  assert.equal(legacy.state, 'executing'); assert.equal(legacy.role, 'owner'); assert.match(legacy.source, /no participants recorded/);
  const done = make(fixture, 'Reviewed', 'dev-fe');
  progress.setParticipant(manager, done.id, { seatId: 'dev-mobile', role: 'reviewer', state: 'done' }, 'ui');
  assert.equal(activityOf(fixture, 'dev-mobile').state, 'available');
  fixture.close();
});

test('permissions and audit: owner and leaders manage, a seat reports only its own role, acceptance by leaders or reviewers', () => {
  const fixture = createSeededOffice(); const { progress } = fixture.office;
  const task = make(fixture, 'Perms', 'dev-be');
  assert.throws(() => progress.setParticipant(seat('dev-fe'), task.id, { seatId: 'dev-fe', role: 'executor', state: 'active' }, 'mcp'), /forbidden_progress/);
  progress.setParticipant(seat('dev-be'), task.id, { seatId: 'dev-fe', role: 'executor', state: 'active', phase: 'start' }, 'mcp');
  progress.setParticipant(seat('dev-fe'), task.id, { seatId: 'dev-fe', role: 'executor', state: 'waiting', phase: 'need input' }, 'mcp');
  assert.throws(() => progress.setParticipant(seat('dev-fe'), task.id, { seatId: 'dev-unity', role: 'executor', state: 'active' }, 'mcp'), /forbidden_progress/);
  assert.throws(() => progress.recordOutput(seat('ba-docs'), task.id, { name: 'x' }, 'mcp'), /forbidden_progress/);
  const output = progress.recordOutput(seat('dev-fe'), task.id, { name: 'Draft', result: 'pass' }, 'mcp');
  assert.equal(output.acceptedBy, null, 'received is not accepted');
  assert.throws(() => progress.acceptOutput(seat('dev-fe'), task.id, output.id, { accept: true }, 'mcp'), /acceptance_by_lead_pm_or_reviewer/);
  assert.equal(progress.acceptOutput(seat('dev-lead'), task.id, output.id, { note: 'ok', accept: true }, 'mcp').acceptedBy, 'dev-lead');
  const audit = fixture.office.tasks.changes(task.id).map(change => change.field);
  assert.ok(audit.includes('participant:dev-fe:executor')); assert.ok(audit.includes(`output:${output.id}`));
  fixture.close();
});

test('no self-acceptance: only leaders name reviewers, a reviewer never accepts its own or its own task\'s output; omitting accept accepts nothing', () => {
  const fixture = createSeededOffice(); const { progress } = fixture.office;
  const task = make(fixture, 'Self review', 'dev-be');
  assert.throws(() => progress.setParticipant(seat('dev-be'), task.id, { seatId: 'dev-be', role: 'reviewer', state: 'active' }, 'mcp'), /forbidden_progress/);
  progress.setParticipant(manager, task.id, { seatId: 'dev-be', role: 'reviewer', state: 'active' }, 'ui');
  progress.setParticipant(manager, task.id, { seatId: 'dev-fe', role: 'reviewer', state: 'active' }, 'ui');
  const own = progress.recordOutput(seat('dev-be'), task.id, { name: 'Own work' }, 'mcp');
  assert.throws(() => progress.acceptOutput(seat('dev-be'), task.id, own.id, { accept: true }, 'mcp'), /acceptance_by_lead_pm_or_reviewer/, 'owner as reviewer');
  const byFe = progress.recordOutput(seat('dev-fe'), task.id, { name: 'Reviewer work' }, 'mcp');
  assert.throws(() => progress.acceptOutput(seat('dev-fe'), task.id, byFe.id, { accept: true }, 'mcp'), /acceptance_by_lead_pm_or_reviewer/, 'recorded it');
  const updated = progress.acceptOutput(seat('dev-fe'), task.id, own.id, { missing: 'engine import' }, 'mcp');
  assert.equal(updated.acceptedBy, null); assert.equal(updated.missing, 'engine import');
  assert.equal(progress.acceptOutput(seat('dev-fe'), task.id, own.id, { accept: true }, 'mcp').acceptedBy, 'dev-fe');
  assert.throws(() => progress.acceptOutput(seat('dev-fe'), task.id, own.id, { accept: false }, 'mcp'), /acceptance_by_lead_pm_or_reviewer/, 'only leaders revoke');
  assert.equal(progress.acceptOutput(seat('dev-lead'), task.id, own.id, { accept: false }, 'mcp').acceptedBy, null);
  fixture.close();
});

test('staleness is even: a stale waiting role is unknown, a leader edit does not refresh the owner\'s run, an active role on a blocked task waits', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const waitingTask = make(fixture, 'Wait', 'dev-unity');
  progress.setParticipant(manager, waitingTask.id, { seatId: 'dev-unity', role: 'executor', state: 'waiting', note: 'texture' }, 'ui');
  age(fixture, ACTIVITY_STALE_MS + 60_000);
  assert.equal(activityOf(fixture, 'dev-unity').state, 'unknown');
  const legacy = make(fixture, 'Legacy', 'dev-be'); tasks.update(seat('dev-be'), legacy.id, { status: 'doing' });
  const later = Date.now() + ACTIVITY_STALE_MS + 60_000;
  tasks.update(manager, legacy.id, { estimateMinutes: 90 });
  assert.equal(activityOf(fixture, 'dev-be', later).state, 'unknown', 'only the run start counts, not later edits');
  const blocked = make(fixture, 'Blocked with executor', 'dev-fe');
  progress.setParticipant(manager, blocked.id, { seatId: 'dev-mobile', role: 'executor', state: 'active', phase: 'build' }, 'ui');
  tasks.update(manager, blocked.id, { status: 'blocked', note: 'input missing' });
  assert.equal(activityOf(fixture, 'dev-mobile').state, 'waiting', 'active claimed before the block');
  fixture.close();
});

test('a phase reported after the task was blocked is real work: shown with the blockers, task and dependencies unchanged', () => {
  const fixture = createSeededOffice(); const { progress, tasks } = fixture.office;
  const before = make(fixture, 'Prerequisite', 'dev-be');
  const task = fixture.office.tasks.create(manager, { title: 'Blocked at runtime acceptance', body: REQ, assigneeSeatId: 'dev-fe', estimateMinutes: 60, dependsOn: [before.id] });
  tasks.update(manager, task.id, { status: 'blocked', note: 'runtime acceptance missing' });
  fixture.db.raw.prepare('UPDATE task_events SET created_at=created_at-60000 WHERE task_id=?').run(task.id);
  progress.setParticipant(manager, task.id, { seatId: 'dev-mobile', role: 'reviewer', state: 'active', phase: 'review mesh export (independent)' }, 'ui');
  const activity = activityOf(fixture, 'dev-mobile');
  assert.equal(activity.state, 'reviewing'); assert.equal(activity.phase, 'review mesh export (independent)');
  assert.ok(activity.reasons.some(reason => reason.startsWith('task blocked')), 'blocker stays visible');
  assert.equal(tasks.get(task.id).status, 'blocked'); assert.deepEqual(tasks.get(task.id).dependsOn, [before.id]);
  fixture.close();
});
