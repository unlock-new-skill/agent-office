import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';
import type { ChatMessage, Task } from '../../src/shared/contracts.js';

type Wake = { wake: boolean; reason?: string; state?: string };
type Me = { handoffBrief: string | null };

test('a request accepted with requestedBy reports back to the asking leader on blocked and done', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const designLead = fixture.seatToken('design-lead'); const atom = fixture.seatToken('design-atom');
  assert.equal((await fixture.agent(designLead, '/v1/tasks', { body: { title: 'x', assigneeSeatId: 'design-atom', requestedBy: 'design-atom' } })).status, 400, 'requester must be a leader');
  assert.equal((await fixture.agent(designLead, '/v1/tasks', { body: { title: 'x', assigneeSeatId: 'design-atom', requestedBy: 'design-lead' } })).status, 400, 'requester must be another department');
  const created = await fixture.agent(designLead, '/v1/tasks', { body: { title: 'Login icons', body: 'spec: docs/login.md', assigneeSeatId: 'design-atom', requestedBy: '@dev-lead' } });
  assert.equal(created.status, 201);
  const task = await created.json() as Task;
  assert.equal(task.requesterSeatId, 'dev-lead');
  const accepted = await (await fixture.agent(devLead, '/v1/wake?wait=0')).json() as Wake;
  assert.ok(accepted.wake && /accepted as task/.test(accepted.reason ?? ''), 'asking leader hears the acceptance');
  await fixture.agent(atom, `/v1/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done', note: 'assets/ui/login/' } });
  const done = await (await fixture.agent(devLead, '/v1/wake?wait=0')).json() as Wake;
  assert.ok(done.wake);
  assert.match(done.reason ?? '', /your request .* is done: assets\/ui\/login\//);
  const leaders = await (await fixture.manager('/v1/channels/leaders/messages')).json() as { messages: ChatMessage[] };
  assert.equal(leaders.messages.filter(message => message.senderKind === 'system').length, 2);
  fixture.close();
});

test('handoff brief of a leader lists requests served and requests still open elsewhere', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const designLead = fixture.seatToken('design-lead');
  await fixture.agent(designLead, '/v1/tasks', { body: { title: 'Login icons', assigneeSeatId: 'design-atom', requestedBy: 'dev-lead' } });
  const design = await (await fixture.agent(designLead, '/v1/me')).json() as Me;
  assert.match(design.handoffBrief ?? '', /serving:\n- t-design-1 \[todo\] Login icons ← @dev-lead/);
  const dev = await (await fixture.agent(devLead, '/v1/me')).json() as Me;
  assert.match(dev.handoffBrief ?? '', /still open in other departments:\n- t-design-1 \[todo\] Login icons → design/);
  fixture.close();
});

test('deputy joins #leaders, can create tasks, and is woken for the leader only while the leader is unavailable', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const atom = fixture.seatToken('design-atom');
  assert.equal((await fixture.manager('/v1/departments/design', { method: 'PATCH', body: { deputySeatId: 'design-lead' } })).status, 400, 'leader cannot be deputy');
  assert.equal((await fixture.manager('/v1/departments/design', { method: 'PATCH', body: { deputySeatId: 'dev-be' } })).status, 400, 'other department');
  assert.equal((await fixture.manager('/v1/departments/design', { method: 'PATCH', body: { deputySeatId: 'design-atom' } })).status, 200);
  assert.equal((await fixture.agent(atom, '/v1/channels/leaders/messages', { body: { body: 'deputy here' } })).status, 201, 'deputy may post in #leaders');
  assert.equal((await fixture.agent(atom, '/v1/tasks', { body: { title: 'Map pass', assigneeSeatId: 'design-map' } })).status, 201, 'deputy may create tasks');
  // Leader seat is vacant → unavailable → deputy is woken by a mention of the leader.
  await fixture.agent(devLead, '/v1/channels/leaders/messages', { body: { body: '@design-lead need icons' } });
  const stoodIn = await (await fixture.agent(atom, '/v1/wake?wait=0')).json() as Wake;
  assert.ok(stoodIn.wake);
  assert.match(stoodIn.reason ?? '', /deputy and @design-lead .* is unavailable/);
  // Leader present and listening → deputy is not woken for the leader's mentions.
  const designLead = fixture.seatToken('design-lead');
  const parked = fixture.agent(designLead, '/v1/wake?wait=5');
  await new Promise(resolve => setTimeout(resolve, 50));
  await fixture.agent(devLead, '/v1/channels/leaders/messages', { body: { body: '@design-lead and one more' } });
  assert.equal(((await (await parked).json()) as Wake).wake, true, 'leader gets it');
  assert.equal(((await (await fixture.agent(atom, '/v1/wake?wait=0')).json()) as Wake).wake, false, 'deputy stays asleep');
  fixture.close();
});

test('a leader idle for over 10 minutes (not parked) counts as unavailable; ended sessions too', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const atom = fixture.seatToken('design-atom'); fixture.seatToken('design-lead');
  await fixture.manager('/v1/departments/design', { method: 'PATCH', body: { deputySeatId: 'design-atom' } });
  const leaderAgent = fixture.office.org.seat('design-lead').agentId!;
  fixture.db.raw.prepare('UPDATE agents SET last_event_at=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), leaderAgent);
  assert.equal(fixture.office.wake.standingInFor('design-atom'), null, 'recently active leader');
  fixture.db.raw.prepare('UPDATE agents SET last_event_at=? WHERE id=?').run(new Date(Date.now() - 11 * 60_000).toISOString(), leaderAgent);
  assert.equal(fixture.office.wake.standingInFor('design-atom'), 'design-lead', 'idle leader');
  fixture.db.raw.prepare('UPDATE agents SET last_event_at=?,ended_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), leaderAgent);
  assert.equal(fixture.office.wake.standingInFor('design-atom'), 'design-lead', 'ended session');
  assert.equal(fixture.office.wake.standingInFor('design-map'), null, 'non-deputy never stands in');
  void devLead; void atom;
  fixture.close();
});
