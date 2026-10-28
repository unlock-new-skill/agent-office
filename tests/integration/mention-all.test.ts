import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';
import type { ChatMessage } from '../../src/shared/contracts.js';

type Wake = { wake: boolean; reason?: string };

test('@all from a leader mentions every seat of the channel except the sender and wakes them', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const designLead = fixture.seatToken('design-lead'); const baLead = fixture.seatToken('ba-lead');
  const posted = await (await fixture.agent(devLead, '/v1/channels/leaders/messages', { body: { body: '@all standup in 5' } })).json() as ChatMessage;
  assert.deepEqual([...posted.mentions].sort(), ['ba-lead', 'design-lead', 'ops-lead']);
  for (const token of [designLead, baLead]) assert.equal(((await (await fixture.agent(token, '/v1/wake?wait=0')).json()) as Wake).wake, true);
  assert.equal(((await (await fixture.agent(devLead, '/v1/wake?wait=0')).json()) as Wake).wake, false, 'sender not woken');
  fixture.close();
});

test('members may not use @all; the manager may (and includes everyone); edits re-expand', async () => {
  const fixture = createAppFixture(); const devBe = fixture.seatToken('dev-be'); fixture.seatToken('dev-lead');
  const refused = await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: '@everyone help' } });
  assert.equal(refused.status, 403); assert.equal((await refused.json() as { error: string }).error, 'mention_all_not_allowed');
  const manager = await (await fixture.manager('/v1/channels/dev/messages', { body: { body: 'hello @all' } })).json() as ChatMessage;
  assert.equal(manager.mentions.length, 6, 'all six Dev seats');
  const edited = await (await fixture.manager(`/v1/channels/dev/messages/${manager.seq}`, { method: 'PATCH', body: { body: 'hello @dev-be' } })).json() as ChatMessage;
  assert.deepEqual(edited.mentions, ['dev-be']);
  assert.equal((await fixture.manager('/v1/departments/dev', { method: 'PATCH', body: { deputySeatId: 'dev-be' } })).status, 200);
  assert.equal((await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: '@all deputy here' } })).status, 201, 'deputy may');
  fixture.close();
});

test('mentions only count channel members: @seat from another department is plain text', async () => {
  const fixture = createAppFixture(); fixture.seatToken('design-lead');
  const posted = await (await fixture.manager('/v1/channels/design/messages', { body: { body: 'hi @dev-lead @ba-lead and @all' } })).json() as ChatMessage;
  assert.ok(!posted.mentions.includes('dev-lead') && !posted.mentions.includes('ba-lead'));
  assert.ok(posted.mentions.every(seatId => seatId.startsWith('design-')), posted.mentions.join(','));
  const leaders = await (await fixture.manager('/v1/channels/leaders/messages', { body: { body: '@dev-lead and @design-atom' } })).json() as ChatMessage;
  assert.deepEqual(leaders.mentions, ['dev-lead'], 'members of #leaders only');
  fixture.close();
});
