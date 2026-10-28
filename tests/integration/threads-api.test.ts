import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';
import type { ChatMessage, CollabEvent } from '../../src/shared/contracts.js';

type Wake = { wake: boolean; reason?: string };

test('replies go into the thread: timeline shows roots with counts, thread shows replies, agents still read everything', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const devBe = fixture.seatToken('dev-be');
  const root = await (await fixture.agent(devLead, '/v1/channels/dev/messages', { body: { body: 'Login API plan?' } })).json() as ChatMessage;
  assert.equal((await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'JWT + refresh', threadSeq: root.seq } })).status, 201);
  await fixture.manager('/v1/channels/dev/messages', { body: { body: 'ok go', threadSeq: root.seq } });
  await fixture.manager('/v1/channels/dev/messages', { body: { body: 'new topic' } });
  const timeline = await (await fixture.manager('/v1/channels/dev/messages?view=timeline')).json() as { messages: ChatMessage[] };
  assert.deepEqual(timeline.messages.map(message => message.body), ['Login API plan?', 'new topic']);
  assert.equal(timeline.messages[0]!.replyCount, 2);
  assert.ok(timeline.messages[0]!.lastReplyAt);
  const thread = await (await fixture.manager(`/v1/channels/dev/threads/${root.seq}`)).json() as { root: ChatMessage; replies: ChatMessage[] };
  assert.deepEqual(thread.replies.map(reply => reply.body), ['JWT + refresh', 'ok go']);
  assert.ok(thread.replies.every(reply => reply.threadSeq === root.seq));
  const all = await (await fixture.agent(devBe, '/v1/channels/dev/messages?after=0')).json() as { messages: ChatMessage[] };
  assert.equal(all.messages.length, 4, 'linear read for agents includes replies');
  assert.ok(fixture.emitted.some((event: CollabEvent) => event.kind === 'message' && event.message.seq === root.seq && event.message.replyCount === 2), 'root update pushed live');
  fixture.close();
});

test('a thread reply wakes only the seats it mentions; nesting and foreign channels are refused', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const devBe = fixture.seatToken('dev-be'); const designLead = fixture.seatToken('design-lead');
  const root = await (await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'blocked on schema' } })).json() as ChatMessage;
  await fixture.agent(devBe, '/v1/wake?wait=0');
  await fixture.agent(devLead, '/v1/channels/dev/messages', { body: { body: 'looking into it', threadSeq: root.seq } });
  assert.equal(((await (await fixture.agent(devBe, '/v1/wake?wait=0')).json()) as Wake).wake, false, 'an unmentioned reply wakes nobody');
  const reply = await (await fixture.agent(devLead, '/v1/channels/dev/messages', { body: { body: '@dev-be use v2 schema', threadSeq: root.seq } })).json() as ChatMessage;
  const woke = await (await fixture.agent(devBe, '/v1/wake?wait=0')).json() as Wake;
  assert.ok(woke.wake);
  assert.match(woke.reason ?? '', new RegExp(`#dev thread \\[${root.seq}\\] @dev-lead: @dev-be use v2 schema`));
  assert.equal((await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'nested', threadSeq: reply.seq } })).status, 400);
  assert.equal((await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'x', threadSeq: 999 } })).status, 404);
  assert.equal((await fixture.agent(designLead, `/v1/channels/dev/threads/${root.seq}`)).status, 403);
  fixture.close();
});
