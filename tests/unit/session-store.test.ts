import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../../src/connector/session-store.js';

test('session store writes private files and reads them back by session id', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'ao-store-')); const store = new SessionStore(home);
  assert.equal(store.connector(), null);
  store.saveConnector({ daemonUrl: 'http://127.0.0.1:8080', token: 'connector-token' });
  store.saveSession('abc-123', { daemonUrl: 'http://127.0.0.1:8080', token: 'agent-token', agentId: 'cc-1' });
  assert.equal(store.connector()?.token, 'connector-token');
  assert.equal(store.session('abc-123')?.agentId, 'cc-1');
  assert.equal(store.session('missing'), null);
  assert.equal(statSync(path.join(home, 'connector.json')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(home, 'sessions', 'abc-123.json')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(home, 'sessions')).mode & 0o777, 0o700);
});

test('session store rejects path traversal session ids', () => {
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-store-')));
  assert.throws(() => store.saveSession('../evil', { daemonUrl: 'x', token: 't', agentId: 'a' }), /invalid_session_id/);
  assert.throws(() => store.session('a/b'), /invalid_session_id/);
});
