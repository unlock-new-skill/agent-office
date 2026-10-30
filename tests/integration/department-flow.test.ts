import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { daemonCall, runHook, type HookDeps } from '../../src/connector/hook-runner.js';
import { SessionStore } from '../../src/connector/session-store.js';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';
import type { Task } from '../../src/shared/contracts.js';

test('manager → Dev Lead → task for Dev BE → done → Dev Lead reports to BA Lead in #leaders', async () => {
  const fixture = createAppFixture();
  // Route the hook's HTTP calls straight into the in-memory app.
  const appFetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fixture.app.request(String(input), init))) as typeof fetch;
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-flow-')));
  store.saveConnector({ daemonUrl: `http://${HOST}`, token: fixture.auth.createConnectorCredential().token });
  const deps: HookDeps = { store, fetch: appFetch, wakeWaitSeconds: 1 };
  const hook = (sessionId: string, event: string, extra: Record<string, unknown> = {}) => runHook({ session_id: sessionId, cwd: '/work/game', hook_event_name: event, prompt_id: `${sessionId}-p`, ...extra }, deps);
  const as = <T,>(sessionId: string, target: string, init?: { method?: string; body?: unknown }) => daemonCall<T>(appFetch, `http://${HOST}`, store.session(sessionId)!.token, target, init);

  // Sessions self-register on SessionStart and appear unseated.
  for (const sessionId of ['s-dev-lead', 's-dev-be', 's-ba-lead']) {
    const start = await hook(sessionId, 'SessionStart', { source: 'startup' }) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(start.hookSpecificOutput.additionalContext, /not seated/);
  }
  // Manager seats them.
  for (const [seatId, sessionId] of [['dev-lead', 's-dev-lead'], ['dev-be', 's-dev-be'], ['ba-lead', 's-ba-lead']] as const)
    assert.equal((await fixture.manager(`/v1/seats/${seatId}/agent`, { method: 'PUT', body: { agentId: store.session(sessionId)!.agentId } })).status, 200);
  const resumed = await hook('s-dev-be', 'SessionStart', { source: 'resume' }) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(resumed.hookSpecificOutput.additionalContext, /@dev-be — Dev BE/);

  // 1. Manager asks the Dev Lead; the lead's Stop hook is blocked with the request.
  await fixture.manager('/v1/channels/dev/messages', { body: { body: '@dev-lead we need a login API this sprint' } });
  const leadWake = await hook('s-dev-lead', 'Stop') as { decision?: string; reason?: string };
  assert.equal(leadWake.decision, 'block'); assert.match(leadWake.reason ?? '', /login API this sprint/);
  const unseated = await hook('s-dev-fe-unregistered', 'Stop') as { reason?: string };
  assert.match(unseated.reason ?? '', /Still listening/, 'an unseated session only gets the keep-alive, never items');

  // 2. Lead delegates a task; Dev BE is woken with it.
  const task = await as<Task>('s-dev-lead', '/v1/tasks', { body: { title: 'Login API', body: 'JWT + refresh tokens; acceptance: login works', assigneeSeatId: 'dev-be' } });
  const memberWake = await hook('s-dev-be', 'Stop') as { decision?: string; reason?: string };
  assert.equal(memberWake.decision, 'block'); assert.match(memberWake.reason ?? '', new RegExp(task.id));

  // 3. Member finishes; the lead is woken by the done transition.
  await as('s-dev-be', `/v1/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done', note: 'merged in #42' } });
  const doneWake = await hook('s-dev-lead', 'Stop') as { decision?: string; reason?: string };
  assert.match(doneWake.reason ?? '', /merged in #42/);

  // 4. Members cannot reach other departments directly; the lead relays through #leaders and BA Lead is woken.
  await assert.rejects(as('s-dev-be', '/v1/channels/leaders/messages', { body: { body: '@ba-lead hi' } }), /forbidden_channel/);
  await as('s-dev-lead', '/v1/channels/leaders/messages', { body: { body: '@ba-lead login API is done, please update the spec' } });
  const baWake = await hook('s-ba-lead', 'Stop') as { decision?: string; reason?: string };
  assert.match(baWake.reason ?? '', /update the spec/);

  // Nothing left: the listener only re-arms itself with a keep-alive when its window ends.
  assert.match(((await hook('s-ba-lead', 'Stop')) as { reason?: string }).reason ?? '', /Still listening/);
  fixture.close();
});
