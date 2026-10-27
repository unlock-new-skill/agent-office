import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';
import type { CollabEvent, PermissionRequest } from '../../src/shared/contracts.js';
import { summarizeToolInput } from '../../src/server/collaboration/permission-service.js';

test('manager allows a remote permission prompt; the agent long-poll resolves with the decision', async () => {
  const fixture = createAppFixture({ remoteApproval: true }); const devBe = fixture.seatToken('dev-be');
  const created = await fixture.agent(devBe, '/v1/permissions', { body: { tool: 'Bash', input: { command: 'npm test', description: 'Run tests' } } });
  assert.equal(created.status, 201);
  const request = await created.json() as PermissionRequest;
  assert.equal(request.seatId, 'dev-be'); assert.equal(request.summary, 'Bash: npm test\n— Run tests');
  assert.ok(fixture.emitted.some((event: CollabEvent) => event.kind === 'permission' && event.pending.length === 1));
  const waiting = fixture.agent(devBe, `/v1/permissions/${request.id}/decision?wait=30`);
  const listed = await (await fixture.manager('/v1/permissions')).json() as { enabled: boolean; pending: PermissionRequest[] };
  assert.equal(listed.enabled, true); assert.equal(listed.pending[0]?.id, request.id);
  assert.equal((await fixture.manager(`/v1/permissions/${request.id}/decision`, { body: { behavior: 'allow' } })).status, 200);
  const decided = await (await waiting).json() as PermissionRequest;
  assert.equal(decided.status, 'allowed'); assert.equal(decided.decidedBy, 'manager');
  assert.equal((await fixture.manager(`/v1/permissions/${request.id}/decision`, { body: { behavior: 'deny' } })).status, 409);
  fixture.close();
});

test('unanswered prompts expire; denial carries a message; agents cannot decide or read others\' prompts', async () => {
  const fixture = createAppFixture({ remoteApproval: true }); const devBe = fixture.seatToken('dev-be'); const devFe = fixture.seatToken('dev-fe');
  const first = await (await fixture.agent(devBe, '/v1/permissions', { body: { tool: 'Write', input: { file_path: '/repo/a.ts' } } })).json() as PermissionRequest;
  const expired = await (await fixture.agent(devBe, `/v1/permissions/${first.id}/decision?wait=0`)).json() as PermissionRequest;
  assert.equal(expired.status, 'expired');
  const second = await (await fixture.agent(devBe, '/v1/permissions', { body: { tool: 'Bash', input: { command: 'rm -rf build' } } })).json() as PermissionRequest;
  assert.equal((await fixture.agent(devFe, `/v1/permissions/${second.id}/decision?wait=0`)).status, 403);
  assert.equal((await fixture.agent(devBe, `/v1/permissions/${second.id}/decision`, { body: { behavior: 'allow' } })).status, 401);
  await fixture.manager(`/v1/permissions/${second.id}/decision`, { body: { behavior: 'deny', message: 'not on main' } });
  const denied = await (await fixture.agent(devBe, `/v1/permissions/${second.id}/decision?wait=5`)).json() as PermissionRequest;
  assert.equal(denied.status, 'denied'); assert.equal(denied.message, 'not on main');
  fixture.close();
});

test('remote approval is off by default; ending the session settles its pending prompts', async () => {
  const off = createAppFixture(); const token = off.seatToken('dev-be');
  const refused = await off.agent(token, '/v1/permissions', { body: { tool: 'Bash', input: {} } });
  assert.equal(refused.status, 403); assert.equal((await refused.json() as { error: string }).error, 'remote_approval_disabled');
  off.close();
  const fixture = createAppFixture({ remoteApproval: true }); const devBe = fixture.seatToken('dev-be');
  const request = await (await fixture.agent(devBe, '/v1/permissions', { body: { tool: 'Bash', input: { command: 'ls' } } })).json() as PermissionRequest;
  fixture.office.permissions.settleForAgent(request.agentId);
  assert.equal(fixture.office.permissions.get(request.id).status, 'expired');
  assert.equal(fixture.office.permissions.pending().length, 0);
  fixture.close();
});

test('summaries name what will run without dumping file contents', () => {
  assert.equal(summarizeToolInput('Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }), 'Edit: /r/a.ts (edit)');
  assert.equal(summarizeToolInput('WebFetch', { url: 'https://example.com' }), 'WebFetch: https://example.com');
  assert.ok(summarizeToolInput('Bash', { command: 'x'.repeat(5000) }).length <= 2000);
});

test('intermediate polls (final=false) keep the prompt pending for the next poll', async () => {
  const fixture = createAppFixture({ remoteApproval: true }); const devBe = fixture.seatToken('dev-be');
  const request = await (await fixture.agent(devBe, '/v1/permissions', { body: { tool: 'Bash', input: { command: 'ls' } } })).json() as PermissionRequest;
  const held = await (await fixture.agent(devBe, `/v1/permissions/${request.id}/decision?wait=0&final=false`)).json() as PermissionRequest;
  assert.equal(held.status, 'pending');
  await fixture.manager(`/v1/permissions/${request.id}/decision`, { body: { behavior: 'allow' } });
  assert.equal((await (await fixture.agent(devBe, `/v1/permissions/${request.id}/decision?wait=0`)).json() as PermissionRequest).status, 'allowed');
  fixture.close();
});
