import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ClaudeEvent } from '../../src/connector/runner/claude-process.js';
import { Runner } from '../../src/connector/runner/runner.js';
import { SessionStore } from '../../src/connector/session-store.js';
import type { RunnerCommand, RunnerView } from '../../src/shared/contracts.js';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ seatId, state: 'idle', sessionId: null, restarts: 0, permissionMode: 'acceptEdits', detail: '' });

test('runner API: register (unknown seats refused), manager command round trip, audit, auth', async () => {
  const fixture = createAppFixture(); const { token } = fixture.auth.createConnectorCredential();
  const runner = (target: string, init?: { method?: string; body?: unknown }) => fixture.agent(token, target, init);
  assert.equal((await fixture.agent('nope', '/v1/runners/register', { body: { machine: 'mac', seats: [] } })).status, 401);
  const registered = await (await runner('/v1/runners/register', { body: { machine: 'mac-mini', seats: [seat('dev-be'), seat('ghost')] } })).json() as { refused: string[] };
  assert.deepEqual(registered.refused, ['ghost']);
  const views = await (await fixture.manager('/v1/runners')).json() as { runners: RunnerView[] };
  assert.deepEqual(views.runners.map(view => [view.machine, view.online, view.seats.map(item => item.seatId)]), [['mac-mini', true, ['dev-be']]]);

  assert.equal((await fixture.manager('/v1/seats/dev-fe/runner-commands', { body: { kind: 'start' } })).status, 409, 'no runner offers dev-fe');
  assert.equal((await fixture.manager('/v1/seats/dev-be/runner-commands', { body: { kind: 'prompt' } })).status, 400);
  assert.equal((await runner('/v1/seats/dev-be/runner-commands', { body: { kind: 'start' } })).status, 401, 'runners cannot queue commands');
  const queued = await (await fixture.manager('/v1/seats/dev-be/runner-commands', { body: { kind: 'prompt', text: 'run the tests' } })).json() as RunnerCommand;
  assert.equal(queued.status, 'queued');
  const polled = await (await runner('/v1/runners/me/commands?wait=1')).json() as { commands: RunnerCommand[] };
  assert.deepEqual(polled.commands.map(command => [command.id, command.kind, command.text, command.status]), [[queued.id, 'prompt', 'run the tests', 'sent']]);
  const done = await (await runner(`/v1/runners/me/commands/${queued.id}/result`, { body: { ok: true, message: 'sent' } })).json() as RunnerCommand;
  assert.equal(done.status, 'done');
  const audit = await (await fixture.manager('/v1/seats/dev-be/runner-commands')).json() as { commands: RunnerCommand[] };
  assert.deepEqual(audit.commands.map(command => [command.kind, command.status, command.requestedBy]), [['prompt', 'done', 'manager']]);

  // Status and log only for offered seats.
  await runner('/v1/runners/me/status', { body: { seats: [{ ...seat('dev-be'), state: 'running' }, seat('dev-fe')] } });
  assert.deepEqual(fixture.office.runners.views()[0]!.seats.map(item => [item.seatId, item.state]), [['dev-be', 'running']]);
  await runner('/v1/runners/me/log', { body: { entries: [{ seatId: 'dev-be', ts: 1, kind: 'text', summary: 'hello' }, { seatId: 'dev-fe', ts: 1, kind: 'text', summary: 'x' }] } });
  assert.deepEqual((await (await fixture.manager('/v1/seats/dev-be/runner-log')).json() as { entries: unknown[] }).entries.length, 1);
  assert.deepEqual(fixture.office.runners.log('dev-fe'), []);

  // Stale commands expire instead of firing late.
  const late = fixture.office.runners.enqueue('dev-be', 'restart', null, 'manager');
  fixture.db.raw.prepare('UPDATE runner_commands SET created_at=? WHERE id=?').run(Date.now() - 5 * 60_000, late.id);
  fixture.office.runners.sweep();
  assert.equal((await (await runner('/v1/runners/me/commands?wait=0')).json() as { commands: unknown[] }).commands.length, 0);
  assert.equal(fixture.office.runners.commands('dev-be').find(command => command.id === late.id)?.status, 'expired');
  fixture.close();
});

test('the runner executes a web command on its headless seat and reports back', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-runner-e2e-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential().token });
  const sent: string[] = []; let emit: (event: ClaudeEvent) => void = () => undefined;
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, machine: 'test-box', sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    config: { seats: [{ seatId: 'dev-be', cwd: '/repo', permissionMode: 'acceptEdits', autoStart: false }] },
    spawn: (_seat, _resume, onEvent) => { emit = onEvent; return { send: text => sent.push(text), interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => undefined }; },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  await until(() => fixture.office.runners.views().some(view => view.online));
  const start = fixture.office.runners.enqueue('dev-be', 'start', null, 'manager');
  await until(() => sent.length === 1);
  emit({ kind: 'init', sessionId: 'sess-1' }); emit({ kind: 'text', text: 'checking channels' });
  await until(() => fixture.office.runners.commands('dev-be').find(command => command.id === start.id)?.status === 'done');
  await until(() => fixture.office.runners.log('dev-be').some(entry => entry.summary === 'checking channels'));
  await until(() => fixture.office.runners.views()[0]!.seats[0]!.state === 'running');
  // Release the runner's parked command poll so its loop can see it was closed.
  await runner.close(); fixture.office.runners.close(); await running;
  fixture.close();
});
