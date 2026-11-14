import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ClaudeEvent } from '../../src/connector/runner/claude-process.js';
import { Runner } from '../../src/connector/runner/runner.js';
import { SessionStore } from '../../src/connector/session-store.js';
import { promptBinding } from '../../src/connector/runner/seat-worker.js';
import type { AgentPrompt } from '../../src/shared/contracts.js';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ seatId, state: 'running', sessionId: 's-1', restarts: 0, permissionMode: 'bypassPermissions', detail: '' });
const INPUT = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] };

test('prompt API: the runner files, the leader answers over MCP routes, the runner gets the decision once', async () => {
  const fixture = createAppFixture();
  const { token } = fixture.auth.createConnectorCredential(); const other = fixture.auth.createConnectorCredential().token;
  const runner = (target: string, init?: { method?: string; body?: unknown }) => fixture.agent(token, target, init);
  assert.equal((await runner('/v1/runners/register', { body: { machine: 'win', seats: [seat('dev-be')] } })).status, 200);
  // A prompt binds to the task the seat has in progress.
  const work = fixture.office.tasks.create({ kind: 'manager' }, { title: 'API', body: 'Goal, inputs, expected output and acceptance criteria.', assigneeSeatId: 'dev-be', estimateMinutes: 30 });
  fixture.office.tasks.update({ kind: 'manager' }, work.id, { status: 'doing' });
  assert.equal((await fixture.agent(token, '/v1/runners/me/prompts', { body: { seatId: 'dev-be', sessionId: 's-1', requestId: 'req-0', tool: 'Bash', input: { command: 'ls' }, binding: 'd'.repeat(64) } })).status, 400, 'the binding must be the hash of the input sent');
  const binding = promptBinding('AskUserQuestion', INPUT);
  const body = { seatId: 'dev-be', sessionId: 's-1', requestId: 'req-1', toolUseId: 'toolu_1', tool: 'AskUserQuestion', input: INPUT, binding };
  assert.equal((await fixture.agent('nope', '/v1/runners/me/prompts', { body })).status, 401);
  const filed = await runner('/v1/runners/me/prompts', { body }); assert.equal(filed.status, 201);
  const prompt = await filed.json() as AgentPrompt;
  assert.equal((await (await runner('/v1/runners/me/prompts', { body })).json() as AgentPrompt).id, prompt.id, 'a retried filing is the same prompt');
  assert.equal((await runner('/v1/runners/me/prompts', { body: { ...body, sessionId: 's-2' } })).status, 409, 'a reused request id with other content is refused');
  assert.equal((await fixture.agent(other, `/v1/runners/me/prompts/${prompt.id}`)).status, 403, 'another runner cannot read the decision');

  const lead = fixture.seatToken('dev-lead'); const peer = fixture.seatToken('dev-fe'); const asker = fixture.seatToken('dev-be');
  const listed = await (await fixture.agent(lead, '/v1/prompts')).json() as { prompts: AgentPrompt[] };
  assert.deepEqual(listed.prompts.map(item => item.id), [prompt.id]);
  assert.equal((await fixture.agent(peer, `/v1/prompts/${prompt.id}`)).status, 403);
  const answer = { binding, behavior: 'allow', answers: { 'Which color?': 'Blue' } };
  assert.equal((await fixture.agent(asker, `/v1/prompts/${prompt.id}/answer`, { body: answer })).status, 403, 'the asker cannot answer itself');
  assert.equal((await fixture.agent(peer, `/v1/prompts/${prompt.id}/answer`, { body: answer })).status, 403);
  assert.equal((await fixture.agent(lead, `/v1/prompts/${prompt.id}/answer`, { body: { ...answer, binding: 'c'.repeat(64) } })).status, 409);
  assert.equal((await fixture.agent(lead, `/v1/prompts/${prompt.id}/answer`, { body: answer })).status, 200);
  assert.equal((await fixture.manager(`/v1/prompts/${prompt.id}/answer`, { body: { binding, behavior: 'deny' } })).status, 409, 'answered already');

  const decision = await (await runner(`/v1/runners/me/prompts/${prompt.id}?wait=1`)).json() as { status: string; answers: Record<string, string> };
  assert.equal(decision.status, 'answered'); assert.deepEqual(decision.answers, { 'Which color?': 'Blue' });
  assert.equal((await (await runner(`/v1/runners/me/prompts/${prompt.id}/delivered`, { body: {} })).json() as AgentPrompt).status, 'delivered');

  const second = await (await runner('/v1/runners/me/prompts', { body: { ...body, requestId: 'req-2' } })).json() as AgentPrompt;
  assert.equal((await fixture.manager(`/v1/prompts/${second.id}/answer`, { body: { binding, behavior: 'deny', message: 'not now' } })).status, 200, 'the manager answers any prompt from the web');
  assert.equal(((await (await runner(`/v1/runners/me/prompts/${second.id}`)).json()) as { status: string }).status, 'denied');
  const third = await (await runner('/v1/runners/me/prompts', { body: { ...body, requestId: 'req-3' } })).json() as AgentPrompt;
  assert.deepEqual(await (await runner('/v1/runners/me/prompts/cancel', { body: { seatId: 'dev-be', reason: 'the session stopped or restarted' } })).json(), { cancelled: 1 }, 'a seat-wide cancel takes only the pending prompt, not the decided one');
  assert.equal(((await (await runner(`/v1/runners/me/prompts/${third.id}`)).json()) as { status: string }).status, 'cancelled');
  fixture.close();
});

test('the runner files a prompt from its seat\'s session, waits, and writes the leader\'s answer back to that request', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-runner-prompt-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential().token });
  const work = fixture.office.tasks.create({ kind: 'manager' }, { title: 'API', body: 'Goal, inputs, expected output and acceptance criteria.', assigneeSeatId: 'dev-be', estimateMinutes: 30 });
  fixture.office.tasks.update({ kind: 'manager' }, work.id, { status: 'doing' });
  const responses: unknown[] = []; let emit: (event: ClaudeEvent) => void = () => undefined;
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, machine: 'test-box', sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    config: { seats: [{ seatId: 'dev-be', cwd: mkdtempSync(path.join(tmpdir(), 'ao-repo-')), permissionMode: 'bypassPermissions', autoStart: false, showWindow: false }] },
    spawn: (_seat, _resume, onEvent) => { emit = onEvent; return { send: () => undefined, interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => onEvent({ kind: 'exit', code: null, stderr: '' }), respond: (requestId, response) => responses.push({ requestId, response }) }; },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 600 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  await until(() => fixture.office.runners.views().some(view => view.online));
  fixture.office.runners.enqueue('dev-be', 'start', null, 'manager');
  await until(() => fixture.office.runners.commands('dev-be').some(command => command.status === 'done'));
  emit({ kind: 'init', sessionId: 's-1' });
  emit({ kind: 'prompt', requestId: 'req-1', toolUseId: 'toolu_1', tool: 'AskUserQuestion', input: INPUT });
  await until(() => fixture.office.prompts.list({ kind: 'manager' }).some(item => item.status === 'pending'));
  const [prompt] = fixture.office.prompts.list({ kind: 'manager' });
  assert.equal(prompt!.taskId, work.id);
  fixture.office.prompts.answer({ kind: 'seat', seatId: 'dev-lead' }, prompt!.id, { binding: prompt!.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } });
  await until(() => responses.length === 1);
  assert.deepEqual(responses[0], { requestId: 'req-1', response: { behavior: 'allow', updatedInput: { ...INPUT, answers: { 'Which color?': 'Red' } } } });
  await until(() => fixture.office.prompts.get(prompt!.id).status === 'delivered');
  await runner.close(); fixture.office.runners.close(); await running;
  fixture.close();
});
