import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';

type Registered = { agentId: string; token: string };

test('connector registers sessions; resume keeps agent id and revokes the old token', async () => {
  const fixture = createAppFixture();
  const created = await fixture.manager('/v1/connectors', { body: {} });
  assert.equal(created.status, 201);
  const connector = (await created.json() as { token: string }).token;
  const first = await (await fixture.agent(connector, '/v1/sessions/register', { body: { sessionId: 'sess-1', project: '/work/game' } })).json() as Registered;
  const again = await (await fixture.agent(connector, '/v1/sessions/register', { body: { sessionId: 'sess-1', project: '/work/game' } })).json() as Registered;
  assert.equal(first.agentId, again.agentId);
  assert.equal((await fixture.agent(first.token, '/v1/me')).status, 401);
  assert.equal((await fixture.agent(again.token, '/v1/me')).status, 200);
  assert.equal((await fixture.agent(again.token, '/v1/sessions/register', { body: { sessionId: 'sess-2', project: 'x' } })).status, 401);
  assert.equal((await fixture.agent(connector, '/v1/sessions/register', { body: { sessionId: '../bad', project: 'x' } })).status, 400);
  fixture.close();
});

test('revoked connector cannot register sessions', async () => {
  const fixture = createAppFixture();
  const { token, id } = fixture.auth.createConnectorCredential();
  assert.equal((await fixture.manager(`/v1/credentials/${id}/revoke`, { body: {} })).status, 200);
  assert.equal((await fixture.agent(token, '/v1/sessions/register', { body: { sessionId: 's', project: 'p' } })).status, 401);
  fixture.close();
});

test('manager seats a registered session; whoami reflects seat, description and channels', async () => {
  const fixture = createAppFixture();
  const session = fixture.auth.registerSession({ sessionId: 'sess-lead', project: 'p' });
  const before = await (await fixture.agent(session.token, '/v1/me')).json() as { seat: null; agentId: string };
  assert.equal(before.seat, null); assert.equal(before.agentId, session.agentId);
  assert.equal((await fixture.manager('/v1/seats/dev-lead/agent', { method: 'PUT', body: { agentId: session.agentId } })).status, 200);
  assert.equal((await fixture.manager('/v1/seats/dev-be/agent', { method: 'PUT', body: { agentId: session.agentId } })).status, 409);
  const me = await (await fixture.agent(session.token, '/v1/me')).json() as { seat: { id: string; description: string }; department: { name: string }; channels: Array<{ id: string }> };
  assert.equal(me.seat.id, 'dev-lead'); assert.equal(me.department.name, 'Dev'); assert.match(me.seat.description, /Coordinates/);
  assert.deepEqual(me.channels.map(channel => channel.id).sort(), ['dev', 'leaders']);
  assert.equal((await fixture.manager('/v1/seats/dev-lead/agent', { method: 'PUT', body: { agentId: null } })).status, 200);
  assert.equal(((await (await fixture.agent(session.token, '/v1/me')).json()) as { seat: null }).seat, null);
  fixture.close();
});

test('agents claim seats by id or join url; occupied seats are refused; leave frees the seat', async () => {
  const fixture = createAppFixture();
  const one = fixture.auth.registerSession({ sessionId: 'claim-1', project: 'p' }); const two = fixture.auth.registerSession({ sessionId: 'claim-2', project: 'p' });
  const claimed = await fixture.agent(one.token, '/v1/seats/dev-be/claim', { body: {} });
  assert.equal(claimed.status, 200);
  const refused = await fixture.agent(two.token, '/v1/seats/dev-be/claim', { body: {} });
  assert.equal(refused.status, 409); assert.equal(((await refused.json()) as { error: string }).error, 'seat_occupied');
  assert.equal((await fixture.agent(two.token, '/v1/seats/ghost/claim', { body: {} })).status, 404);
  assert.equal((await fixture.agent(one.token, '/v1/seats/leave', { body: {} })).status, 200);
  assert.equal((await fixture.agent(two.token, '/v1/seats/dev-be/claim', { body: {} })).status, 200);
  assert.equal((await fixture.app.request('http://127.0.0.1:8080/join/dev-be', { headers: { host: '127.0.0.1:8080' } })).status, 401);
  const page = await fixture.manager('/join/dev-be');
  assert.equal(page.status, 200); assert.match(await page.text(), /agent_office_join/);
  assert.equal((await fixture.agent(two.token, '/join/ghost')).status, 404);
  fixture.close();
});
