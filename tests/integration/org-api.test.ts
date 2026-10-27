import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';
import type { ChatMessage, OrgView } from '../../src/shared/contracts.js';

test('manager reads org and manages departments and seats over HTTP', async () => {
  const fixture = createAppFixture();
  const org = await (await fixture.manager('/v1/org')).json() as OrgView;
  assert.equal(org.seats.length, 14);
  const created = await fixture.manager('/v1/departments', { body: { name: 'QA', color: '#112233' } });
  assert.equal(created.status, 201);
  assert.equal((await fixture.manager('/v1/departments/qa/seats', { body: { title: 'QA Lead', role: 'leader', description: 'tests things' } })).status, 201);
  assert.equal((await fixture.manager('/v1/departments/qa/seats', { body: { title: 'QA Two', role: 'leader' } })).status, 409);
  assert.equal((await fixture.manager('/v1/seats/qa-lead', { method: 'PATCH', body: { description: 'owns e2e' } })).status, 200);
  assert.equal((await fixture.manager('/v1/departments/qa', { method: 'PATCH', body: { paused: true } })).status, 200);
  assert.equal((await fixture.manager('/v1/seats/qa-lead', { method: 'DELETE' })).status, 200);
  assert.equal((await fixture.manager('/v1/departments/qa', { method: 'DELETE' })).status, 200);
  assert.equal((await fixture.manager('/v1/departments/missing', { method: 'DELETE' })).status, 404);
  fixture.close();
});

test('mutations require CSRF token and manager session', async () => {
  const fixture = createAppFixture();
  const noCsrf = await fixture.app.request(`http://${HOST}/v1/departments`, { method: 'POST', headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) });
  assert.equal(noCsrf.status, 401);
  assert.equal((await fixture.app.request(`http://${HOST}/v1/org`, { headers: { host: HOST } })).status, 401);
  fixture.close();
});

test('seated agents post and read under routing rules; unseated agents are refused', async () => {
  const fixture = createAppFixture();
  const devBe = fixture.seatToken('dev-be'); const devLead = fixture.seatToken('dev-lead');
  assert.equal((await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'hi @dev-lead' } })).status, 201);
  assert.equal((await fixture.agent(devBe, '/v1/channels/ba/messages', { body: { body: 'nope' } })).status, 403);
  assert.equal((await fixture.agent(devBe, '/v1/channels/leaders/messages', { body: { body: 'nope' } })).status, 403);
  assert.equal((await fixture.agent(devLead, '/v1/channels/leaders/messages', { body: { body: 'ok' } })).status, 201);
  const page = await (await fixture.agent(devLead, '/v1/channels/dev/messages')).json() as { messages: ChatMessage[] };
  assert.deepEqual(page.messages[0]?.mentions, ['dev-lead']);
  assert.equal((await fixture.agent(devLead, '/v1/channels/dev/read', { body: { seq: 1 } })).status, 200);
  const unseated = fixture.auth.registerSession({ sessionId: 'loose', project: 'probe' });
  const refused = await fixture.agent(unseated.token, '/v1/channels/dev/messages', { body: { body: 'x' } });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: string }).error, 'not_seated');
  fixture.close();
});

test('manager posts to any channel and pages history', async () => {
  const fixture = createAppFixture();
  for (let i = 0; i < 3; i++) assert.equal((await fixture.manager('/v1/channels/leaders/messages', { body: { body: `m${i}` } })).status, 201);
  const page = await (await fixture.manager('/v1/channels/leaders/messages?after=1')).json() as { messages: ChatMessage[] };
  assert.deepEqual(page.messages.map(message => message.body), ['m1', 'm2']);
  assert.equal((await fixture.manager('/v1/channels/leaders/messages', { body: { body: '' } })).status, 400);
  fixture.close();
});

test('message edit/delete over HTTP and the agent guide', async () => {
  const fixture = createAppFixture(); const devBe = fixture.seatToken('dev-be');
  await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'typo @dev-fe' } });
  const edited = await fixture.agent(devBe, '/v1/channels/dev/messages/1', { method: 'PATCH', body: { body: 'fixed @dev-lead' } });
  assert.equal(edited.status, 200); assert.deepEqual((await edited.json() as ChatMessage).mentions, ['dev-lead']);
  const devFe = fixture.seatToken('dev-fe');
  assert.equal((await fixture.agent(devFe, '/v1/channels/dev/messages/1', { method: 'DELETE' })).status, 403);
  assert.equal((await fixture.agent(devBe, '/v1/channels/dev/messages/1', { method: 'DELETE' })).status, 200);
  assert.equal((await fixture.manager('/v1/channels/dev/messages/9', { method: 'DELETE' })).status, 404);
  assert.equal((await fixture.app.request(`http://${HOST}/agent-guide`, { headers: { host: HOST } })).status, 401);
  const guide = await fixture.agent(devBe, '/agent-guide');
  assert.equal(guide.status, 200);
  const text = await guide.text();
  for (const needle of ['agent_office_send_message', 'agent_office_edit_message', 'agent_office_delete_message', '@seat-id', '#leaders', 'agent_office_update_task']) assert.ok(text.includes(needle), needle);
  fixture.close();
});
