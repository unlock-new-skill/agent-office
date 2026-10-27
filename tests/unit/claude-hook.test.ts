import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runHook } from '../../src/connector/hook-runner.js';
import { SessionStore } from '../../src/connector/session-store.js';

type Call = { url: string; method: string; body: unknown; auth: string | null };
const fakeDaemon = (routes: Record<string, (call: Call) => { status: number; body: unknown }>) => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const call: Call = { url: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const result = route(call); return new Response(JSON.stringify(result.body), { status: result.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
};
const newStore = (): SessionStore => { const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-hook-'))); store.saveConnector({ daemonUrl: 'http://127.0.0.1:8080', token: 'connector' }); return store; };
const sessionStart = { session_id: 'sess-1', cwd: '/work/game', hook_event_name: 'SessionStart', source: 'startup' };

test('SessionStart registers the session, stores its token and injects seat context', async () => {
  const store = newStore();
  const daemon = fakeDaemon({
    'POST /v1/sessions/register': () => ({ status: 201, body: { agentId: 'cc-1', token: 'agent-token' } }),
    'GET /v1/me': () => ({ status: 200, body: { agentId: 'cc-1', seat: { id: 'dev-be', title: 'Dev BE', role: 'member', description: 'Backend developer' }, department: { name: 'Dev' }, channels: [{ id: 'dev' }] } }),
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
  });
  const output = await runHook(sessionStart, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 1 }) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(store.session('sess-1')?.token, 'agent-token');
  assert.equal(daemon.calls[0]?.auth, 'Bearer connector');
  assert.deepEqual(daemon.calls[0]?.body, { sessionId: 'sess-1', project: '/work/game' });
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /dev-be/);
  assert.match(output.hookSpecificOutput.additionalContext, /Backend developer/);
  assert.ok(daemon.calls.some(call => call.url === '/v1/agents/events' && (call.body as { kind: string }).kind === 'session.start' && call.auth === 'Bearer agent-token'));
});

test('unseated session gets a not-seated notice', async () => {
  const store = newStore();
  const daemon = fakeDaemon({
    'POST /v1/sessions/register': () => ({ status: 201, body: { agentId: 'cc-1', token: 'agent-token' } }),
    'GET /v1/me': () => ({ status: 200, body: { agentId: 'cc-1', seat: null, department: null, channels: [] } }),
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
  });
  const output = await runHook(sessionStart, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 1 }) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(output.hookSpecificOutput.additionalContext, /not seated/i);
});

test('hook fails open: no connector, daemon down, or malformed input all return {}', async () => {
  const empty = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-hook-')));
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.deepEqual(await runHook(sessionStart, { store: empty, fetch: down, wakeWaitSeconds: 1 }), {});
  assert.deepEqual(await runHook({ nonsense: true }, { store: newStore(), fetch: down, wakeWaitSeconds: 1 }), {});
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  assert.deepEqual(await runHook({ session_id: 'sess-1', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_use_id: 't1', tool_name: 'Bash' }, { store, fetch: down, wakeWaitSeconds: 1 }), {});
  const spooled = readFileSync(path.join(store.spoolDir('sess-1'), 'telemetry.ndjson'), 'utf8');
  assert.match(spooled, /tool\.start/);
});

test('spooled telemetry is drained before the next event once the daemon is back', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await runHook({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }, { store, fetch: down, wakeWaitSeconds: 1 });
  const daemon = fakeDaemon({ 'POST /v1/agents/events': () => ({ status: 201, body: {} }) });
  await runHook({ session_id: 'sess-1', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_use_id: 't1', tool_name: 'Bash' }, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 1 });
  assert.deepEqual(daemon.calls.map(call => (call.body as { kind: string }).kind), ['turn.start', 'tool.start']);
});

test('Stop long-polls the daemon and blocks with the wake reason when items arrive', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  const daemon = fakeDaemon({
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
    'GET /v1/wake': () => ({ status: 200, body: { wake: true, reason: '[Agent Office] 1 new item for @dev-be' } }),
  });
  const output = await runHook({ session_id: 'sess-1', hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: true }, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 7 });
  assert.deepEqual(output, { decision: 'block', reason: '[Agent Office] 1 new item for @dev-be' });
  assert.ok(daemon.calls.some(call => call.url === '/v1/wake?wait=7'));
});

test('Stop allows stopping when nothing arrives, when unseated, or when the daemon is down', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  const stop = { session_id: 'sess-1', hook_event_name: 'Stop', prompt_id: 'p1' };
  const quiet = fakeDaemon({ 'POST /v1/agents/events': () => ({ status: 201, body: {} }), 'GET /v1/wake': () => ({ status: 200, body: { wake: false, state: 'timeout' } }) });
  assert.deepEqual(await runHook(stop, { store, fetch: quiet.fetchImpl, wakeWaitSeconds: 1 }), {});
  const unseated = fakeDaemon({ 'POST /v1/agents/events': () => ({ status: 201, body: {} }), 'GET /v1/wake': () => ({ status: 403, body: { error: 'not_seated' } }) });
  assert.deepEqual(await runHook(stop, { store, fetch: unseated.fetchImpl, wakeWaitSeconds: 1 }), {});
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.deepEqual(await runHook(stop, { store, fetch: down, wakeWaitSeconds: 1 }), {});
});

test('SessionStart with a requested seat claims it, or reports that it is occupied', async () => {
  const me = { agentId: 'cc-1', seat: { id: 'dev-be', title: 'Dev BE', role: 'member', description: 'Backend developer' }, department: { name: 'Dev' }, channels: [{ id: 'dev' }] };
  const free = fakeDaemon({
    'POST /v1/sessions/register': () => ({ status: 201, body: { agentId: 'cc-1', token: 'agent-token' } }),
    'POST /v1/seats/dev-be/claim': () => ({ status: 200, body: me.seat }),
    'GET /v1/me': () => ({ status: 200, body: me }),
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
  });
  const ok = await runHook(sessionStart, { store: newStore(), fetch: free.fetchImpl, wakeWaitSeconds: 1, requestedSeat: 'dev-be' }) as { hookSpecificOutput: { additionalContext: string } };
  assert.ok(free.calls.some(call => call.url === '/v1/seats/dev-be/claim'));
  assert.match(ok.hookSpecificOutput.additionalContext, /@dev-be/);
  const taken = fakeDaemon({
    'POST /v1/sessions/register': () => ({ status: 201, body: { agentId: 'cc-1', token: 'agent-token' } }),
    'POST /v1/seats/dev-be/claim': () => ({ status: 409, body: { error: 'seat_occupied' } }),
    'GET /v1/me': () => ({ status: 200, body: { agentId: 'cc-1', seat: null, department: null, channels: [] } }),
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
  });
  const refused = await runHook(sessionStart, { store: newStore(), fetch: taken.fetchImpl, wakeWaitSeconds: 1, requestedSeat: 'dev-be' }) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(refused.hookSpecificOutput.additionalContext, /dev-be is already taken/);
});

test('Stop retries network errors and daemon restarts within the wait window, then delivers the wake', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  let clock = 0; const sleeps: number[] = []; let wakeCalls = 0;
  const responses: Array<() => Response> = [
    () => { throw new TypeError('fetch failed'); },
    () => new Response(JSON.stringify({ wake: false, state: 'shutdown' }), { status: 200 }),
    () => new Response(JSON.stringify({ error: 'internal_error' }), { status: 503 }),
    () => new Response(JSON.stringify({ wake: true, reason: 'woken after outage' }), { status: 200 }),
  ];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/agents/events') return new Response('{}', { status: 201 });
    wakeCalls++; return responses.shift()!();
  }) as typeof fetch;
  const output = await runHook({ session_id: 'sess-1', hook_event_name: 'Stop', prompt_id: 'p1' }, { store, fetch: fetchImpl, wakeWaitSeconds: 290, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(output, { decision: 'block', reason: 'woken after outage' });
  assert.equal(wakeCalls, 4);
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps[1]! > sleeps[0]!, 'backoff grows');
});

test('Stop gives up at the wait deadline and does not retry a real idle timeout or a refusal', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  let clock = 0; let wakeCalls = 0;
  const down = (async (input: string | URL | Request) => { if (new URL(String(input)).pathname === '/v1/wake') wakeCalls++; throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.deepEqual(await runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { store, fetch: down, wakeWaitSeconds: 60, now: () => clock, sleep: async ms => { clock += ms; } }), {});
  assert.ok(clock <= 60_000, 'never sleeps past the deadline');
  assert.ok(wakeCalls >= 3);
  for (const state of ['timeout', 'paused', 'wake_limit']) {
    let calls = 0;
    const daemon = (async (input: string | URL | Request) => { if (new URL(String(input)).pathname === '/v1/wake') calls++; return new Response(JSON.stringify({ wake: false, state }), { status: 200 }); }) as typeof fetch;
    assert.deepEqual(await runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { store, fetch: daemon, wakeWaitSeconds: 60, now: () => clock, sleep: async ms => { clock += ms; } }), {});
    assert.equal(calls, 1, `${state} is not retried`);
  }
});

test('Stop re-registers once when the session token was revoked', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'stale-token', agentId: 'cc-1' });
  const daemon = fakeDaemon({
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
    'POST /v1/sessions/register': () => ({ status: 201, body: { agentId: 'cc-1', token: 'fresh-token' } }),
    'GET /v1/wake': call => call.auth === 'Bearer fresh-token' ? { status: 200, body: { wake: true, reason: 'back' } } : { status: 401, body: { error: 'unauthorized' } },
  });
  const output = await runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 60, sleep: async () => {} });
  assert.deepEqual(output, { decision: 'block', reason: 'back' });
  assert.equal(store.session('sess-1')?.token, 'fresh-token');
});

test('SessionStart injects the seat handoff brief so a new session continues the seat\'s work', async () => {
  const daemon = fakeDaemon({
    'POST /v1/sessions/register': () => ({ status: 201, body: { agentId: 'cc-2', token: 'agent-token' } }),
    'GET /v1/me': () => ({ status: 200, body: { agentId: 'cc-2', seat: { id: 'dev-be', title: 'Dev BE', role: 'member', description: '' }, department: { name: 'Dev' }, channels: [{ id: 'dev' }], handoffBrief: '[Agent Office] Handoff for @dev-be\nNote: refresh token next' } }),
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
  });
  const output = await runHook({ ...sessionStart, source: 'compact' }, { store: newStore(), fetch: daemon.fetchImpl, wakeWaitSeconds: 1 }) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(output.hookSpecificOutput.additionalContext, /refresh token next/);
});

test('PermissionRequest hands the prompt to the manager and returns Allow/Deny; anything else falls back to the terminal', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  const prompt = { session_id: 'sess-1', hook_event_name: 'PermissionRequest', prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'npm test', huge: 1 } };
  const daemonWith = (decision: { status: number; body: unknown }) => fakeDaemon({
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
    'POST /v1/permissions': () => ({ status: 201, body: { id: 'perm-1' } }),
    'GET /v1/permissions/perm-1/decision': () => decision,
  });
  const allow = daemonWith({ status: 200, body: { status: 'allowed', message: '' } });
  assert.deepEqual(await runHook(prompt, { store, fetch: allow.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 60 }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(allow.calls.find(call => call.url === '/v1/permissions')?.body, { tool: 'Bash', input: { command: 'npm test', huge: '1' } });
  assert.ok(allow.calls.some(call => call.url === '/v1/permissions/perm-1/decision?wait=60'));
  const deny = daemonWith({ status: 200, body: { status: 'denied', message: 'not now' } });
  assert.deepEqual(await runHook(prompt, { store, fetch: deny.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 60 }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not now' } } });
  const expired = daemonWith({ status: 200, body: { status: 'expired', message: '' } });
  assert.deepEqual(await runHook(prompt, { store, fetch: expired.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 60 }), {});
  const disabled = fakeDaemon({ 'POST /v1/agents/events': () => ({ status: 201, body: {} }), 'POST /v1/permissions': () => ({ status: 403, body: { error: 'remote_approval_disabled' } }) });
  assert.deepEqual(await runHook(prompt, { store, fetch: disabled.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 60 }), {});
  const off = daemonWith({ status: 200, body: { status: 'allowed', message: '' } });
  assert.deepEqual(await runHook(prompt, { store, fetch: off.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 0 }), {});
  assert.ok(!off.calls.some(call => call.url === '/v1/permissions'));
});

test('long waits are split into polls of at most 90 s so proxies with idle timeouts do not cut them', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  let clock = 0; const waits: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/agents/events') return new Response('{}', { status: 201 });
    if (url.pathname === '/v1/permissions') return new Response(JSON.stringify({ id: 'perm-1' }), { status: 201 });
    waits.push(url.search); const seconds = Number(url.searchParams.get('wait')); clock += seconds * 1000;
    if (url.pathname === '/v1/wake') return new Response(JSON.stringify(waits.length === 3 ? { wake: true, reason: 'third poll' } : { wake: false, state: 'timeout' }), { status: 200 });
    return new Response(JSON.stringify({ status: url.searchParams.get('final') === 'false' ? 'pending' : 'expired', message: '' }), { status: 200 });
  }) as typeof fetch;
  const stop = await runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { store, fetch: fetchImpl, wakeWaitSeconds: 290, now: () => clock, sleep: async () => {} });
  assert.deepEqual(stop, { decision: 'block', reason: 'third poll' });
  assert.deepEqual(waits, ['?wait=90', '?wait=90', '?wait=90']);
  waits.length = 0; clock = 0;
  const prompt = await runHook({ session_id: 'sess-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, { store, fetch: fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 120, now: () => clock });
  assert.deepEqual(prompt, {});
  assert.deepEqual(waits, ['?wait=90&final=false', '?wait=30']);
});

test('a join link to this daemon in the prompt seats the session without the model calling a tool', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'https://office.example.com', token: 'agent-token', agentId: 'cc-1' });
  const daemon = fakeDaemon({
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
    'POST /v1/seats/design-atom/claim': () => ({ status: 200, body: {} }),
    'GET /v1/me': () => ({ status: 200, body: { agentId: 'cc-1', seat: { id: 'design-atom', title: 'Atom Asset Designer', role: 'member', description: 'icons' }, department: { name: 'Design' }, channels: [{ id: 'design' }] } }),
  });
  const prompt = (text: string) => ({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: text });
  const output = await runHook(prompt('Join Agent Office: https://office.example.com/join/design-atom please'), { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 1 }) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /joined seat @design-atom/);
  assert.match(output.hookSpecificOutput.additionalContext, /Atom Asset Designer/);
  assert.ok(daemon.calls.some(call => call.url === '/v1/seats/design-atom/claim' && call.auth === 'Bearer agent-token'));
  const other = fakeDaemon({ 'POST /v1/agents/events': () => ({ status: 201, body: {} }) });
  assert.deepEqual(await runHook(prompt('see https://evil.example/join/design-atom'), { store, fetch: other.fetchImpl, wakeWaitSeconds: 1 }), {});
  assert.ok(!other.calls.some(call => call.url.includes('/claim')), 'links to other hosts are ignored');
  const missing = fakeDaemon({ 'POST /v1/agents/events': () => ({ status: 201, body: {} }), 'POST /v1/seats/nope/claim': () => ({ status: 404, body: { error: 'seat_not_found' } }), 'GET /v1/me': () => ({ status: 200, body: { agentId: 'cc-1', seat: null, department: null, channels: [] } }) });
  const refused = await runHook(prompt('https://office.example.com/join/nope'), { store, fetch: missing.fetchImpl, wakeWaitSeconds: 1 }) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(refused.hookSpecificOutput.additionalContext, /no seat @nope/);
});

test('questions for the user stay in the terminal; non-string tool inputs still reach the manager', async () => {
  const store = newStore(); store.saveSession('sess-1', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  const daemon = fakeDaemon({
    'POST /v1/agents/events': () => ({ status: 201, body: {} }),
    'POST /v1/permissions': () => ({ status: 201, body: { id: 'perm-1' } }),
    'GET /v1/permissions/perm-1/decision': () => ({ status: 200, body: { status: 'expired', message: '' } }),
  });
  const ask = { session_id: 'sess-1', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which DB?' }] } };
  assert.deepEqual(await runHook(ask, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 60 }), {});
  assert.ok(!daemon.calls.some(call => call.url === '/v1/permissions'), 'not sent to the manager');
  const mcp = { session_id: 'sess-1', hook_event_name: 'PermissionRequest', tool_name: 'mcp__db__query', tool_input: { sql: 'select 1', options: { limit: 5 } } };
  await runHook(mcp, { store, fetch: daemon.fetchImpl, wakeWaitSeconds: 1, permissionWaitSeconds: 1 });
  assert.deepEqual(daemon.calls.find(call => call.url === '/v1/permissions')?.body, { tool: 'mcp__db__query', input: { sql: 'select 1', options: '{"limit":5}' } });
});
