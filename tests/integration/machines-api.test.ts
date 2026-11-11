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

  const seat = { seatId: 'dev-be', cwd: '/Users/me/game', permissionMode: 'acceptEdits', sessionId: 'sess-abc', autoStart: true, showWindow: false, model: null };
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
  const spawned: Array<{ seatId: string; cwd: string; resume: string | null; model: string | undefined; closed: boolean }> = [];
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, config: { seats: [] }, sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    checkCwd: cwd => cwd.startsWith('/allowed/') ? null : `outside the folders this machine allows (/allowed)`,
    spawn: (seat, resume, onEvent) => {
      const record = { seatId: seat.seatId, cwd: seat.cwd, resume, model: seat.model, closed: false }; spawned.push(record);
      return { send: () => undefined, interrupt: () => undefined, close: () => { record.closed = true; onEvent({ kind: 'exit', code: 0, stderr: '' }); }, kill: () => undefined };
    },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  const seats = () => fixture.office.runners.views().find(view => view.id === machine.id)!.seats;
  await until(() => fixture.office.runners.views().some(view => view.id === machine.id && view.online));

  fixture.office.runners.setConfig(machine.id, [
    { seatId: 'dev-be', cwd: '/allowed/game', permissionMode: 'acceptEdits', sessionId: 'sess-from-terminal', autoStart: true, showWindow: false },
    { seatId: 'dev-fe', cwd: '/etc', permissionMode: 'acceptEdits', sessionId: null, autoStart: true, showWindow: false },
  ]);
  await until(() => spawned.some(record => record.seatId === 'dev-be'));
  assert.deepEqual(spawned.map(record => [record.seatId, record.cwd, record.resume]), [['dev-be', '/allowed/game', 'sess-from-terminal']]);
  assert.equal(new RunnerState(store).sessionId('dev-be'), 'sess-from-terminal');
  await until(() => seats().find(seat => seat.seatId === 'dev-fe')?.state === 'failed');
  assert.match(seats().find(seat => seat.seatId === 'dev-fe')!.detail, /outside the folders/);

  fixture.office.runners.setConfig(machine.id, [{ seatId: 'dev-be', cwd: '/allowed/game-v2', permissionMode: 'acceptEdits', sessionId: 'sess-from-terminal', autoStart: true, showWindow: false }]);
  await until(() => spawned.length === 2);
  assert.equal(spawned[0]!.closed, true, 'the old process was stopped');
  assert.equal(spawned[1]!.cwd, '/allowed/game-v2');
  await until(() => !seats().some(seat => seat.seatId === 'dev-fe'));

  // A new model restarts the seat on the same session with --model.
  fixture.office.runners.setConfig(machine.id, [{ seatId: 'dev-be', cwd: '/allowed/game-v2', permissionMode: 'acceptEdits', sessionId: 'sess-from-terminal', autoStart: true, showWindow: false, model: 'gemini-3.8-flash-high' }]);
  await until(() => spawned.length === 3);
  assert.equal(spawned[1]!.closed, true);
  assert.deepEqual([spawned[2]!.model, spawned[2]!.resume], ['gemini-3.8-flash-high', 'sess-from-terminal']);

  fixture.office.runners.setConfig(machine.id, []);
  await until(() => spawned[2]!.closed && seats().length === 0);
  await runner.close(); fixture.office.runners.close(); await running;
  fixture.close();
});

test('a seat whose folder was missing (unmounted volume) comes back once the folder reappears', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const machine = fixture.office.runners.createMachine('NAS box');
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-nas-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential(machine.id).token });
  let mounted = false;
  const spawned: Array<{ seatId: string; resume: string | null }> = [];
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, config: { seats: [] }, sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    checkCwd: cwd => mounted ? null : `folder not found on this machine: ${cwd}`,
    spawn: (seat, resume, onEvent) => {
      spawned.push({ seatId: seat.seatId, resume });
      return { send: () => undefined, interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => undefined };
    },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  const seat = () => fixture.office.runners.views().find(view => view.id === machine.id)!.seats.find(item => item.seatId === 'dev-be');
  try {
  await until(() => fixture.office.runners.views().some(view => view.id === machine.id && view.online));

  fixture.office.runners.setConfig(machine.id, [{ seatId: 'dev-be', cwd: '/Volumes/nas/project', permissionMode: 'bypassPermissions', sessionId: 'sess-devbe', autoStart: false, showWindow: false }]);
  await until(() => seat()?.state === 'failed');
  assert.match(seat()!.detail, /folder not found/);
  assert.equal((await runner.execute({ seatId: 'dev-be', kind: 'restart', text: null })).ok, false, 'still unmounted: restart reports the problem');

  mounted = true;
  assert.equal((await runner.execute({ seatId: 'dev-be', kind: 'restart', text: null })).ok, true, 'remounted: restart works without a config change');
  await until(() => spawned.length === 1);
  assert.deepEqual(spawned[0], { seatId: 'dev-be', resume: 'sess-devbe' }, 'the seat resumes the session picked on the web');
  } finally {
    await runner.close(); fixture.office.runners.close(); await running;
    fixture.close();
  }
});

test('a local seat with a missing folder is reported as failed instead of stopping the runner', () => {
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-badlocal-')));
  const runner = new Runner({ store, fetch, out: () => undefined, config: { seats: [{ seatId: 'dev-be', cwd: '/Users/me/projects/game-server', permissionMode: 'acceptEdits', autoStart: true, showWindow: false }] } });
  const status = (runner as unknown as { statuses: Map<string, { state: string; detail: string }> }).statuses.get('dev-be')!;
  assert.equal(status.state, 'failed'); assert.match(status.detail, /folder not found/);
});

test('the runner opens the desktop live view when a seat starts and follows the web switch', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const machine = fixture.office.runners.createMachine('Desk');
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-window-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential(machine.id).token });
  const windows: string[] = [];
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, config: { seats: [] }, sleep: () => new Promise(resolve => setTimeout(resolve, 5)), checkCwd: () => null,
    openWatch: seatId => { windows.push(`open ${seatId}`); return null; }, closeWatch: seatId => { windows.push(`close ${seatId}`); },
    spawn: (_seat, _resume, onEvent) => ({ send: () => undefined, interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => undefined }),
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), JSON.stringify(windows)); };
  try {
    await until(() => fixture.office.runners.views().some(view => view.id === machine.id && view.online));
    const seat = { seatId: 'dev-be', cwd: '/allowed/game', permissionMode: 'bypassPermissions' as const, sessionId: null, autoStart: true, showWindow: true };
    fixture.office.runners.setConfig(machine.id, [seat]);
    await until(() => windows.includes('open dev-be'));
    fixture.office.runners.setConfig(machine.id, [{ ...seat, showWindow: false }]);
    await until(() => windows.includes('close dev-be'));
    fixture.office.runners.setConfig(machine.id, [{ ...seat, showWindow: true }]);
    await until(() => windows.filter(entry => entry === 'open dev-be').length === 2);
  } finally {
    await runner.close(); fixture.office.runners.close(); await running; fixture.close();
  }
});

test('takeover: a session still open in a terminal is told to close, then the runner resumes it; a seat held by another session waits', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const machine = fixture.office.runners.createMachine('Desk');
  const connectorToken = fixture.auth.createConnectorCredential(machine.id).token;
  // An interactive session on this machine that currently holds @dev-be.
  const terminal = fixture.auth.registerSession({ sessionId: 'sess-terminal', project: '/allowed/game' }, machine.id);
  fixture.office.org.assignAgent('dev-be', terminal.agentId);
  // Another live session holding @dev-fe.
  const other = fixture.auth.registerSession({ sessionId: 'sess-other', project: '/allowed/web' }, machine.id);
  fixture.office.org.assignAgent('dev-fe', other.agentId);

  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-takeover-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: connectorToken });
  const spawned: Array<{ seatId: string; resume: string | null }> = []; const lines: string[] = [];
  const runner = new Runner({
    store, fetch: appFetch, out: line => lines.push(line), config: { seats: [] }, checkCwd: () => null, sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    spawn: (seat, resume, onEvent) => { spawned.push({ seatId: seat.seatId, resume }); return { send: () => undefined, interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => undefined }; },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 600 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), lines.join('\n')); };
  try {
    await until(() => fixture.office.runners.views().some(view => view.id === machine.id && view.online));
    fixture.office.runners.setConfig(machine.id, [
      { seatId: 'dev-be', cwd: '/allowed/game', permissionMode: 'bypassPermissions', sessionId: 'sess-terminal', autoStart: true, showWindow: false },
      { seatId: 'dev-fe', cwd: '/allowed/web', permissionMode: 'bypassPermissions', sessionId: null, autoStart: true, showWindow: false },
    ]);
    await until(() => lines.some(line => line.includes('[dev-be] waiting: closing the terminal')) && lines.some(line => line.includes('[dev-fe] waiting: seat held by live session sess-oth')));
    assert.equal(spawned.length, 0, 'nothing starts while the seats are taken');

    // The terminal session's Stop-hook listener asks for work and is told to close.
    const wake = await (await fixture.agent(terminal.token, '/v1/wake?wait=0&takeover=1')).json() as { state: string };
    assert.equal(wake.state, 'taken_over');
    const older = await (await fixture.agent(terminal.token, '/v1/wake?wait=0')).json() as { wake: boolean; reason: string };
    assert.equal(older.wake, true, 'an older listener gets one short turn so the current hook takes over');
    assert.match(older.reason, /taking over this session/);
    await fixture.agent(terminal.token, '/v1/agents/events', { body: { id: 'e-end', ts: new Date().toISOString(), kind: 'session.end' } });
    await until(() => spawned.some(record => record.seatId === 'dev-be'));
    assert.deepEqual(spawned.find(record => record.seatId === 'dev-be'), { seatId: 'dev-be', resume: 'sess-terminal' });
    assert.equal(fixture.office.runners.isTakenOver(terminal.agentId), false, 'the takeover flag is cleared once the terminal session ended');
    assert.ok(!spawned.some(record => record.seatId === 'dev-fe'), 'dev-fe still waits for its holder');
  } finally {
    await runner.close(); fixture.office.runners.close(); await running; fixture.close();
  }
});

test('web seats may use folders listed in allowedRoots of the local runner.json, not only the home directory', async () => {
  const fixture = createAppFixture();
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const machine = fixture.office.runners.createMachine('NAS box');
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-roots-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential(machine.id).token });
  const nas = mkdtempSync(path.join(tmpdir(), 'ao-nas-')); const repo = path.join(nas, 'game');
  (await import('node:fs')).mkdirSync(repo);
  const spawned: string[] = [];
  const runner = new Runner({
    store, fetch: appFetch, out: () => undefined, config: { seats: [], allowedRoots: [nas] }, sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    spawn: (seat, _resume, onEvent) => { spawned.push(seat.cwd); return { send: () => undefined, interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => undefined }; },
  });
  const running = runner.run();
  const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  try {
    await until(() => fixture.office.runners.views().some(view => view.id === machine.id && view.online));
    fixture.office.runners.setConfig(machine.id, [{ seatId: 'dev-be', cwd: repo, permissionMode: 'bypassPermissions', sessionId: null, autoStart: true, showWindow: false, model: null }]);
    await until(() => spawned.includes(repo));
  } finally {
    await runner.close(); fixture.office.runners.close(); await running; fixture.close();
  }
});
