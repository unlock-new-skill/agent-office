import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture } from '../helpers/office-fixture.js';

type Wake = { wake: boolean; reason?: string; state?: string };

test('wake endpoint returns pending items immediately and long-polls otherwise', async () => {
  const fixture = createAppFixture(); const devBe = fixture.seatToken('dev-be');
  await fixture.manager('/v1/channels/dev/messages', { body: { body: '@dev-be please fix login' } });
  const immediate = await (await fixture.agent(devBe, '/v1/wake?wait=5')).json() as Wake;
  assert.equal(immediate.wake, true); assert.match(immediate.reason ?? '', /fix login/);
  const started = Date.now(); const polling = fixture.agent(devBe, '/v1/wake?wait=5');
  setTimeout(() => void fixture.manager('/v1/channels/dev/messages', { body: { body: '@dev-be one more' } }), 30);
  const late = await (await polling).json() as Wake;
  assert.equal(late.wake, true); assert.ok(Date.now() - started < 2000);
  assert.deepEqual(await (await fixture.agent(devBe, '/v1/wake?wait=0')).json(), { wake: false, state: 'timeout' });
  fixture.close();
});

test('wake endpoint rejects unseated sessions and bad waits', async () => {
  const fixture = createAppFixture(); const loose = fixture.auth.registerSession({ sessionId: 'loose', project: 'p' });
  assert.equal((await fixture.agent(loose.token, '/v1/wake?wait=0')).status, 403);
  assert.equal((await fixture.agent(fixture.seatToken('dev-be'), '/v1/wake?wait=-1')).status, 400);
  fixture.close();
});

test('UserPromptSubmit telemetry (turn.start) resets the loop guard', async () => {
  const fixture = createAppFixture({ maxAutoWakes: 1 }); const devLead = fixture.seatToken('dev-lead'); const devBe = fixture.seatToken('dev-be');
  await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: '@dev-lead one' } });
  assert.equal((await (await fixture.agent(devLead, '/v1/wake?wait=0')).json() as Wake).wake, true);
  await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: '@dev-lead two' } });
  assert.equal((await (await fixture.agent(devLead, '/v1/wake?wait=0')).json() as Wake).state, 'wake_limit');
  const event = await fixture.agent(devLead, '/v1/agents/events', { body: { id: 'evt-1', ts: new Date().toISOString(), kind: 'turn.start', turnId: 'prompt-1' } });
  assert.equal(event.status, 201);
  assert.equal((await (await fixture.agent(devLead, '/v1/wake?wait=0')).json() as Wake).wake, true);
  fixture.close();
});

test('the manager resets a wake-limited seat remotely and its waiting mention is delivered', async () => {
  const fixture = createAppFixture({ maxAutoWakes: 1 });
  const devBe = fixture.seatToken('dev-be');
  await fixture.manager('/v1/channels/dev/messages', { body: { body: '@dev-be first' } });
  assert.equal(((await (await fixture.agent(devBe, '/v1/wake?wait=0')).json()) as { wake: boolean }).wake, true);
  await fixture.agent(fixture.seatToken('dev-fe'), '/v1/channels/dev/messages', { body: { body: '@dev-be second' } });
  assert.equal(((await (await fixture.agent(devBe, '/v1/wake?wait=0')).json()) as { state: string }).state, 'wake_limit');
  assert.equal(fixture.office.org.seat('dev-be').wakeState, 'wake_limited');
  assert.equal((await fixture.agent(devBe, '/v1/seats/dev-be/reset-wakes', { body: {} })).status, 401, 'agents cannot reset');
  assert.equal((await fixture.manager('/v1/seats/dev-be/reset-wakes', { body: {} })).status, 200);
  const woke = await (await fixture.agent(devBe, '/v1/wake?wait=0')).json() as { wake: boolean; reason: string };
  assert.equal(woke.wake, true); assert.match(woke.reason, /second/);
  fixture.close();
});
