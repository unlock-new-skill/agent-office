import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const seatAll = (fixture: Fixture, seatIds: string[]): void => { for (const seatId of seatIds) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`)); };

test('wake rules: only a mention wakes; chatter, unmentioned leader/manager messages and own messages do not', () => {
  const fixture = createSeededOffice(); const { messages, wake } = fixture.office;
  seatAll(fixture, ['dev-lead', 'dev-be', 'dev-fe']);
  messages.post(seat('dev-fe'), 'dev', 'just thinking out loud');
  assert.equal(wake.check('dev-be').wake, false, 'member chatter must not wake other members');
  assert.equal(wake.check('dev-lead').wake, false, 'member chatter must not wake the leader');
  assert.equal(wake.check('dev-fe').wake, false, 'own message never wakes');
  messages.post(seat('dev-fe'), 'dev', '@dev-lead can you review?');
  const leader = wake.check('dev-lead');
  assert.equal(leader.wake, true); assert.match(leader.wake ? leader.reason : '', /can you review/);
  messages.post(seat('dev-lead'), 'dev', 'Team: please pull main');
  assert.equal(wake.check('dev-be').wake, false, 'an unmentioned leader message does not wake members');
  messages.post(manager, 'dev', 'Manager here');
  assert.equal(wake.check('dev-fe').wake, false, 'an unmentioned manager message does not wake');
  messages.post(manager, 'dev', '@dev-fe take the login screen');
  const member = wake.check('dev-fe');
  assert.equal(member.wake, true); assert.equal(member.wake ? member.items.length : 0, 1, 'only the mention is handed over');
  assert.equal(wake.check('dev-be').wake, false, 'a mention of one member does not wake the others');
  fixture.close();
});

test('delivered items are not delivered twice and are marked read', () => {
  const fixture = createSeededOffice(); const { messages, wake } = fixture.office; seatAll(fixture, ['dev-be']);
  messages.post(manager, 'dev', '@dev-be first'); messages.post(manager, 'dev', '@dev-be second');
  const result = wake.check('dev-be');
  assert.equal(result.wake, true); assert.equal(result.wake ? result.items.length : 0, 2);
  assert.equal(wake.check('dev-be').wake, false);
  assert.equal(messages.channelsForSeat('dev-be').find(channel => channel.id === 'dev')?.unread, 0);
  fixture.close();
});

test('an ended session is never handed mentions, so the next session on the seat gets them', () => {
  const fixture = createSeededOffice(); const { messages, wake } = fixture.office; seatAll(fixture, ['dev-be']);
  const agentId = fixture.office.org.seat('dev-be').agentId!;
  fixture.db.raw.prepare("UPDATE agents SET ended_at='2026-10-28T00:00:00Z' WHERE id=?").run(agentId);
  messages.post(manager, 'dev', '@dev-be ping');
  assert.deepEqual(wake.check('dev-be'), { wake: false, state: 'ended' });
  fixture.db.raw.prepare('UPDATE agents SET ended_at=NULL WHERE id=?').run(agentId);
  assert.equal(wake.check('dev-be').wake, true);
  fixture.close();
});

test('paused department and unseated seats never wake', () => {
  const fixture = createSeededOffice(); const { org, messages, wake } = fixture.office; seatAll(fixture, ['dev-be']);
  org.updateDepartment('dev', { paused: true });
  messages.post(manager, 'dev', '@dev-be ping');
  assert.deepEqual(wake.check('dev-be'), { wake: false, state: 'paused' });
  assert.deepEqual(wake.check('dev-fe'), { wake: false, state: 'unseated' });
  org.updateDepartment('dev', { paused: false });
  assert.equal(wake.check('dev-be').wake, true, 'pending items survive the pause');
  fixture.close();
});

test('waiter resolves promptly on a relevant post and clears listening state', async () => {
  const fixture = createSeededOffice(); const { org, messages, wake } = fixture.office; seatAll(fixture, ['dev-be']);
  const started = Date.now(); const pending = wake.wait('dev-be', 5000);
  assert.equal(org.seat('dev-be').wakeState, 'listening');
  setTimeout(() => messages.post(manager, 'dev', '@dev-be deploy please'), 20);
  const result = await pending;
  assert.equal(result.wake, true); assert.ok(Date.now() - started < 1000);
  assert.equal(org.seat('dev-be').wakeState, 'idle');
  fixture.close();
});

test('waiter times out and abort removes it', async () => {
  const fixture = createSeededOffice(); const { org, wake } = fixture.office; seatAll(fixture, ['dev-be', 'dev-fe']);
  assert.deepEqual(await wake.wait('dev-be', 30), { wake: false, state: 'timeout' });
  const controller = new AbortController(); const pending = wake.wait('dev-fe', 5000, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { wake: false, state: 'aborted' });
  assert.equal(org.seat('dev-fe').wakeState, 'idle'); assert.equal(wake.waiterCount(), 0);
  fixture.close();
});

test('loop guard stops ping-pong at the limit; human prompt or manager message resets it', () => {
  const fixture = createSeededOffice({ maxAutoWakes: 3 }); const { org, messages, wake } = fixture.office; seatAll(fixture, ['dev-lead', 'dev-be']);
  for (let round = 0; round < 3; round++) {
    messages.post(seat('dev-be'), 'dev', `@dev-lead round ${round}`);
    assert.equal(wake.check('dev-lead').wake, true);
  }
  messages.post(seat('dev-be'), 'dev', '@dev-lead round 4');
  assert.deepEqual(wake.check('dev-lead'), { wake: false, state: 'wake_limit' });
  assert.equal(org.seat('dev-lead').wakeState, 'wake_limited');
  wake.resetGuardForAgent('agent-dev-lead');
  assert.equal(wake.check('dev-lead').wake, true);
  for (let round = 0; round < 3; round++) { messages.post(seat('dev-be'), 'dev', `@dev-lead again ${round}`); wake.check('dev-lead'); }
  assert.equal(org.seat('dev-lead').wakeState, 'wake_limited');
  messages.post(manager, 'dev', 'Manager: carry on');
  assert.equal(wake.check('dev-lead').wake, true);
  fixture.close();
});

test('wake reason is bounded and names the seat', () => {
  const fixture = createSeededOffice(); const { messages, wake } = fixture.office; seatAll(fixture, ['dev-be']);
  for (let i = 0; i < 20; i++) messages.post(manager, 'dev', `@dev-be ${'x'.repeat(1000)}`);
  const result = wake.check('dev-be');
  assert.ok(result.wake && result.reason.length <= 4000);
  assert.match(result.wake ? result.reason : '', /@dev-be/);
  fixture.close();
});

test('deleted or edited-away mentions do not wake; delivered messages do not wake again after an edit', () => {
  const fixture = createSeededOffice(); const { messages, wake } = fixture.office; seatAll(fixture, ['dev-be', 'dev-fe']);
  const wrong = messages.post(seat('dev-be'), 'dev', '@dev-fe hi');
  messages.remove(seat('dev-be'), 'dev', wrong.seq);
  assert.equal(wake.check('dev-fe').wake, false, 'deleted mention does not wake');
  const retarget = messages.post(seat('dev-be'), 'dev', '@dev-fe please review');
  messages.edit(seat('dev-be'), 'dev', retarget.seq, 'never mind, I will do it');
  assert.equal(wake.check('dev-fe').wake, false, 'mention edited away before delivery does not wake');
  const real = messages.post(seat('dev-be'), 'dev', '@dev-fe real request');
  assert.equal(wake.check('dev-fe').wake, true);
  messages.edit(seat('dev-be'), 'dev', real.seq, '@dev-fe real request (typo fixed)');
  assert.equal(wake.check('dev-fe').wake, false, 'already delivered: edit does not wake again');
  fixture.close();
});
