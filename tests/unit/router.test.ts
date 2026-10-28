import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoute, routePath } from '../../src/client/router.js';

test('paths map to views; unknown paths fall back to chat', () => {
  assert.deepEqual(parseRoute('/map'), { view: 'map', channelId: null });
  assert.deepEqual(parseRoute('/org/'), { view: 'org', channelId: null });
  assert.deepEqual(parseRoute('/requests'), { view: 'requests', channelId: null });
  assert.deepEqual(parseRoute('/chat/dev'), { view: 'chat', channelId: 'dev' });
  assert.deepEqual(parseRoute('/'), { view: 'chat', channelId: null });
  assert.deepEqual(parseRoute('/nope/x'), { view: 'chat', channelId: null });
  assert.deepEqual(parseRoute('/chat/..%2Fevil'), { view: 'chat', channelId: null }, 'channel ids are validated');
  assert.deepEqual(parseRoute('/map/extra'), { view: 'map', channelId: null }, 'only chat takes a channel');
});

test('routes round-trip to canonical paths', () => {
  for (const path of ['/chat', '/chat/leaders', '/map', '/org', '/requests', '/setup']) assert.equal(routePath(parseRoute(path)), path);
  assert.equal(routePath({ view: 'chat', channelId: null }), '/chat');
});
