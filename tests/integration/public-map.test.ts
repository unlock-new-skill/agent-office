import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSnapshot, MachineConfig, OrgView, RunnerView } from '../../src/shared/contracts.js';
import { isLobbySession } from '../../src/shared/lobby.js';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';

test('the office map is public and carries no session ids, paths, descriptions or channels', async () => {
  const fixture = createAppFixture();
  const seated = fixture.auth.registerSession({ sessionId: 'secret-session-1', project: '/Users/me/secret-repo' });
  fixture.office.org.assignAgent('dev-be', seated.agentId);
  fixture.auth.registerSession({ sessionId: 'secret-session-2', project: '/Users/me/other' });
  const response = await fixture.app.request(`http://${HOST}/v1/public/map`, { headers: { host: HOST } });
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const secret of ['secret-session', 'secret-repo', '/Users/me', seated.agentId]) assert.ok(!text.includes(secret), `leaks ${secret}`);
  const body = JSON.parse(text) as { org: OrgView; agents: AgentSnapshot[] };
  assert.deepEqual(body.org.channels, []);
  assert.ok(body.org.seats.every(seat => seat.description === ''));
  const seat = body.org.seats.find(item => item.id === 'dev-be')!;
  assert.ok(seat.agentId && body.agents.some(agent => agent.id === seat.agentId), 'the seated agent is linked by alias');
  assert.equal(body.agents.length, 2, 'seated agent and one live lobby session');
  assert.equal((await fixture.app.request(`http://${HOST}/v1/agents`, { headers: { host: HOST } })).status, 401, 'the full agent list stays private');
  fixture.close();
});

test('lobby: quiet and dismissed sessions are hidden; a dismissed session reappears when it starts again', async () => {
  const fixture = createAppFixture();
  const session = fixture.auth.registerSession({ sessionId: 'sess-lobby', project: '/p' });
  const agents = async (): Promise<AgentSnapshot[]> => ((await (await fixture.manager('/v1/agents')).json()) as { agents: AgentSnapshot[] }).agents;
  assert.ok(isLobbySession((await agents()).find(agent => agent.id === session.agentId)!));
  assert.equal((await fixture.agent(session.token, `/v1/agents/${session.agentId}/dismiss`, { body: {} })).status, 401, 'agents cannot dismiss');
  assert.equal((await fixture.manager(`/v1/agents/${session.agentId}/dismiss`, { body: {} })).status, 200);
  assert.equal(isLobbySession((await agents()).find(agent => agent.id === session.agentId)!), false);
  fixture.auth.registerSession({ sessionId: 'sess-lobby', project: '/p' });
  assert.ok(isLobbySession((await agents()).find(agent => agent.id === session.agentId)!), 'a new start shows it again');
  fixture.db.raw.prepare('UPDATE agents SET last_contact_at=? WHERE id=?').run(Date.now() - 6 * 60_000, session.agentId);
  assert.equal(isLobbySession((await agents()).find(agent => agent.id === session.agentId)!), false, 'quiet for 5 minutes');
  assert.equal((await fixture.manager('/v1/agents/nope/dismiss', { body: {} })).status, 404);
  fixture.close();
});

test('machine seats carry a model for claude --model; shell characters are refused', async () => {
  const fixture = createAppFixture();
  const machine = await (await fixture.manager('/v1/machines', { body: { label: 'Box' } })).json() as RunnerView;
  const seat = { seatId: 'dev-be', cwd: '/Users/me/game' };
  const saved = await (await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [{ ...seat, model: 'gpt-6-astra' }] } })).json() as MachineConfig;
  assert.equal(saved.seats[0]!.model, 'gpt-6-astra');
  assert.equal(saved.seats[0]!.permissionMode, 'bypassPermissions');
  const blank = await (await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [{ ...seat, model: '' }] } })).json() as MachineConfig;
  assert.equal(blank.seats[0]!.model, null, 'empty means the machine default');
  assert.equal((await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [{ ...seat, model: 'opus" & calc' }] } })).status, 400);
  fixture.close();
});
