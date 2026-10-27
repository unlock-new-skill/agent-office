import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from '../../src/server/auth/auth-service.js';
import { createOffice } from '../../src/server/collaboration/office.js';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';

test('manager login throttles repeated failures and rejects wrong Host/Origin', async () => {
  const db = new Database({ filename: ':memory:' });
  const auth = new AuthService(db, 3600);
  auth.setupPassword('correct horse battery staple');
  const config = { ...loadConfig({ AGENT_OFFICE_HOST: '127.0.0.1', AGENT_OFFICE_PORT: '8080' }), dataDir: '/tmp' };
  const app = createApp({ config, db, auth, events: new EventStore(db, () => undefined), office: createOffice(db, { maxAutoWakes: 15, emit: () => undefined }) });
  for (let i = 0; i < 5; i++) {
    const response = await app.request('http://127.0.0.1:8080/v1/auth/login', { method: 'POST', headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong password' }) });
    assert.equal(response.status, 401);
  }
  const throttled = await app.request('http://127.0.0.1:8080/v1/auth/login', { method: 'POST', headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong password' }) });
  assert.equal(throttled.status, 429);
  const badHost = await app.request('http://evil.example/v1/auth/login', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  assert.equal(badHost.status, 403);
  db.close();
});

test('manager enrollment creates one-time registration credential', async () => {
  const db = new Database({ filename: ':memory:' });
  const auth = new AuthService(db, 3600);
  auth.setupPassword('correct horse battery staple');
  const login = auth.login('correct horse battery staple');
  const app = createApp({ config: { ...loadConfig({ AGENT_OFFICE_HOST: '127.0.0.1', AGENT_OFFICE_PORT: '8080' }), dataDir: '/tmp' }, db, auth, events: new EventStore(db, () => undefined), office: createOffice(db, { maxAutoWakes: 15, emit: () => undefined }) });
  const cookie = `agent_office_session=${login.token}`;
  const enrollmentResponse = await app.request('http://127.0.0.1:8080/v1/agents/enrollment', { method: 'POST', headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', cookie, 'x-csrf-token': login.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-1', project: 'probe', sessionId: 'session-1', incarnation: 'inc-1' }) });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json() as { token: string; nonce: string };
  const registration = await app.request('http://127.0.0.1:8080/v1/agents/register', { method: 'POST', headers: { host: '127.0.0.1:8080', authorization: `Bearer ${enrollment.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ nonce: enrollment.nonce }) });
  assert.equal(registration.status, 201);
  const reused = await app.request('http://127.0.0.1:8080/v1/agents/register', { method: 'POST', headers: { host: '127.0.0.1:8080', authorization: `Bearer ${enrollment.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-2', sessionId: 'session-2', incarnation: 'inc-2' }) });
  assert.equal(reused.status, 401);
  db.close();
});

test('public origin behind a proxy: accepted host/origin, Secure cookie, security headers; others still rejected', async () => {
  const db = new Database({ filename: ':memory:' });
  const auth = new AuthService(db, 3600, 16);
  assert.throws(() => auth.setupPassword('short-password'), /weak_password/);
  auth.setupPassword('correct horse battery staple');
  const config = { ...loadConfig({ AGENT_OFFICE_HOST: '0.0.0.0', AGENT_OFFICE_PORT: '8080', AGENT_OFFICE_CONTAINER_MODE: 'true', AGENT_OFFICE_PUBLIC_ORIGIN: 'https://office.example.com' }), dataDir: '/tmp' };
  const app = createApp({ config, db, auth, events: new EventStore(db, () => undefined), office: createOffice(db, { maxAutoWakes: 15, emit: () => undefined }) });
  const login = (host: string, origin: string): Promise<Response> => Promise.resolve(app.request(`http://${host}/v1/auth/login`, { method: 'POST', headers: { host, origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) }));
  const ok = await login('office.example.com', 'https://office.example.com');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', /; Secure/);
  assert.equal(ok.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(ok.headers.get('x-frame-options'), 'DENY');
  assert.match(ok.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await login('office.example.com', 'https://evil.example')).status, 403);
  assert.equal((await login('evil.example', 'https://office.example.com')).status, 403);
  assert.equal((await app.request('http://office.example.com/healthz', { headers: { host: 'evil.example' } })).headers.get('x-content-type-options'), 'nosniff');
  db.close();
});

test('join pages and agent guide require a manager or agent session; links use the public origin', async () => {
  const db = new Database({ filename: ':memory:' });
  const auth = new AuthService(db, 3600); auth.setupPassword('correct horse battery staple'); const session = auth.login('correct horse battery staple');
  const office = createOffice(db, { maxAutoWakes: 15, emit: () => undefined });
  office.org.seed({ departments: [{ id: 'dev', name: 'Dev', color: '#22c55e', seats: [{ id: 'dev-be', title: 'Dev BE', role: 'member', description: '' }] }] });
  const config = { ...loadConfig({ AGENT_OFFICE_HOST: '0.0.0.0', AGENT_OFFICE_PORT: '8080', AGENT_OFFICE_CONTAINER_MODE: 'true', AGENT_OFFICE_PUBLIC_ORIGIN: 'https://office.example.com' }), dataDir: '/tmp' };
  const app = createApp({ config, db, auth, events: new EventStore(db, () => undefined), office });
  const host = 'office.example.com';
  assert.equal((await app.request(`http://${host}/join/dev-be`, { headers: { host } })).status, 401);
  assert.equal((await app.request(`http://${host}/agent-guide`, { headers: { host } })).status, 401);
  const asManager = await app.request(`http://${host}/join/dev-be`, { headers: { host, cookie: `agent_office_session=${session.token}` } });
  assert.equal(asManager.status, 200);
  assert.match(await asManager.text(), /https:\/\/office\.example\.com\/join\/dev-be/);
  const agent = auth.registerSession({ sessionId: 'sess-guide', project: 'probe' });
  const guide = await app.request(`http://${host}/agent-guide`, { headers: { host, authorization: `Bearer ${agent.token}` } });
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /https:\/\/office\.example\.com/);
  office.close(); db.close();
});
