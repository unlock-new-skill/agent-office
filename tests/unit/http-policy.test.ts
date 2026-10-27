import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/server/config.js';
import { allowedHostsAndOrigins, clientPeer } from '../../src/server/http-policy.js';

test('X-Forwarded-For is only honoured behind a trusted proxy, using the hop the proxy appended', () => {
  assert.equal(clientPeer('6.6.6.6, 203.0.113.9', '172.18.0.3', true), '203.0.113.9');
  assert.equal(clientPeer('6.6.6.6', '172.18.0.3', false), '172.18.0.3');
  assert.equal(clientPeer(undefined, '172.18.0.3', true), '172.18.0.3');
});

test('public origin is normalized and added to the allowlists; bad values fail fast', () => {
  const config = loadConfig({ AGENT_OFFICE_HOST: '0.0.0.0', AGENT_OFFICE_PORT: '8080', AGENT_OFFICE_PUBLIC_ORIGIN: 'https://office.example.com/' });
  assert.equal(config.publicOrigin, 'https://office.example.com');
  const { hosts, origins } = allowedHostsAndOrigins(config);
  assert.ok(hosts.has('office.example.com') && origins.has('https://office.example.com') && hosts.has('0.0.0.0:8080'));
  assert.throws(() => loadConfig({ AGENT_OFFICE_PUBLIC_ORIGIN: 'https://office.example.com/app' }), /invalid_public_origin/);
  assert.throws(() => loadConfig({ AGENT_OFFICE_PUBLIC_ORIGIN: 'ftp://office.example.com' }), /invalid_public_origin/);
  assert.equal(loadConfig({ AGENT_OFFICE_MIN_PASSWORD_LENGTH: '4' }).minPasswordLength, 8);
});
