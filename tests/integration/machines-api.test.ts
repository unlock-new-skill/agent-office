import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Runner } from '../../src/connector/runner/runner.js';
import { RunnerState } from '../../src/connector/runner/runner-config.js';
import { SessionStore } from '../../src/connector/session-store.js';
import type { MachineConfig, MachineSession, RunnerView } from '../../src/shared/contracts.js';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';

test('machines: install code binds the connector, config is validated and versioned, sessions listed, delete revokes', async () => {
  const fixture = createAppFixture();
  const machine = await (await fixture.manager('/v1/machines', { body: { label: 'Mac mini' } })).json() as RunnerView;
  assert.match(machine.id, /^m-/); assert.equal(machine.label, 'Mac mini');
  const install = await (await fixture.manager(`/v1/machines/${machine.id}/install-code`, { body: {} })).json() as { code: string; commands: { unix: string } };
  assert.match(install.commands.unix, /install\.sh \| sh -s -- /);
  const redeemed = await (await fixture.app.request(`http://${HOST}/v1/install/redeem`, { method: 'POST', headers: { host: HOST, authorization: `Bearer ${install.code}`, 'content-type': 'application/json' }, body: '{}' })).json() as { token: string; machineId: string };
  assert.equal(redeemed.machineId, machine.id);
  const runner = (target: string, init?: { method?: string; body?: unknown }) => fixture.agent(redeemed.token, target, init);

  // Sessions registered through this connector belong to the machine.
  await runner('/v1/sessions/register', { body: { sessionId: 'sess-abc', project: '/Users/me/game' } });
  const sessions = await (await fixture.manager(`/v1/machines/${machine.id}/sessions`)).json() as { sessions: MachineSession[] };
  assert.deepEqual(sessions.sessions.map(session => [session.sessionId, session.project, session.ended]), [['sess-abc', '/Users/me/game', false]]);

  const seat = { seatId: 'dev-be', cwd: '/Users/me/game', permissionMode: 'acceptEdits', sessionId: 'sess-abc', autoStart: true };
  assert.equal((await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [{ ...seat, seatId: 'ghost' }] } })).status, 404);
  assert.equal((await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [seat, seat] } })).status, 400);
  assert.equal((await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [{ ...seat, cwd: 'relative/path' }] } })).status, 400);
  assert.equal((await runner(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [seat] } })).status, 401, 'runners cannot edit config');
  const saved = await (await fixture.manager(`/v1/machines/${machine.id}/config`, { method: 'PUT', body: { seats: [seat] } })).json() as MachineConfig;
  assert.equal(saved.version, 1);

  const other = await (await fixture.manager('/v1/machines', { body: { label: 'Windows box' } })).json() as RunnerView;
  assert.equal((await fixture.manager(`/v1/machines/${other.id}/config`, { method: 'PUT', body: { seats: [seat] } })).status, 409, 'a seat runs on one machine');

  const registered = await (await runner('/v1/runners/register', { body: { machine: 'mac-mini.local', seats: [] } })).json() as { config: MachineConfig };
  assert.deepEqual(registered.config, { version: 1, seats: [seat] });
  const view = (await (await fixture.manager('/v1/runners')).json() as { runners: RunnerView[] }).runners.find(item => item.id === machine.id)!;
  assert.deepEqual([view.label, view.machine, view.online], ['Mac mini', 'mac-mini.local', true]);
  // A poll that already knows the version parks; an outdated one returns at once with the new version.
  assert.equal((await (await runner('/v1/runners/me/commands?wait=0&version=0')).json() as { configVersion: number }).configVersion, 1);
  assert.deepEqual(await (await runner('/v1/runners/me/config')).json(), { version: 1, seats: [seat] });

  assert.equal((await fixture.manager(`/v1/machines/${machine.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await runner('/v1/runners/me/config')).status, 401, 'the machine connector is revoked');
  fixture.close();
});

test('runner applies the web config live: add, restart on change, refuse folders outside allowed roots, remove', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const machine = fixture.office.runners.createMachine('Test box');
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-machine-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential(machine.id).token });
  const spawned: Array<{ seatId: string; cwd: string; resume: string | null; closed: boolean }> = [];
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, config: { seats: [] }, sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    checkCwd: cwd => cwd.startsWith('/allowed/') ? null : `outside the folders this machine allows (/allowed)`,
    spawn: (seat, resume, onEvent) => {
      const record = { seatId: seat.seatId, cwd: seat.cwd, resume, closed: false }; spawned.push(record);
      return { send: () => undefined, interrupt: () => undefined, close: () => { record.closed = true; onEvent({ kind: 'exit', code: 0, stderr: '' }); }, kill: () => undefined };
    },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  const seats = () => fixture.office.runners.views().find(view => view.id === machine.id)!.seats;
  await until(() => fixture.office.runners.views().some(view => view.id === machine.id && view.online));

  fixture.office.runners.setConfig(machine.id, [
    { seatId: 'dev-be', cwd: '/allowed/game', permissionMode: 'acceptEdits', sessionId: 'sess-from-terminal', autoStart: true },
    { seatId: 'dev-fe', cwd: '/etc', permissionMode: 'acceptEdits', sessionId: null, autoStart: true },
  ]);
  await until(() => spawned.some(record => record.seatId === 'dev-be'));
  assert.deepEqual(spawned.map(record => [record.seatId, record.cwd, record.resume]), [['dev-be', '/allowed/game', 'sess-from-terminal']]);
  assert.equal(new RunnerState(store).sessionId('dev-be'), 'sess-from-terminal');
  await until(() => seats().find(seat => seat.seatId === 'dev-fe')?.state === 'failed');
  assert.match(seats().find(seat => seat.seatId === 'dev-fe')!.detail, /outside the folders/);

  fixture.office.runners.setConfig(machine.id, [{ seatId: 'dev-be', cwd: '/allowed/game-v2', permissionMode: 'acceptEdits', sessionId: 'sess-from-terminal', autoStart: true }]);
  await until(() => spawned.length === 2);
  assert.equal(spawned[0]!.closed, true, 'the old process was stopped');
  assert.equal(spawned[1]!.cwd, '/allowed/game-v2');
  await until(() => !seats().some(seat => seat.seatId === 'dev-fe'));

  fixture.office.runners.setConfig(machine.id, []);
  await until(() => spawned[1]!.closed && seats().length === 0);
  await runner.close(); fixture.office.runners.close(); await running;
  fixture.close();
});
