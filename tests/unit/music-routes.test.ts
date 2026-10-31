import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { Database } from '../../src/server/db/database.js';
import { parseYouTube, registerMusicRoutes } from '../../src/server/music-routes.js';
import type { MusicTrack } from '../../src/shared/contracts.js';

test('YouTube links: watch, youtu.be, shorts and embed give one video and its start time', () => {
  assert.deepEqual(parseYouTube('https://www.youtube.com/watch?v=ph10624hS7E&t=253s'), { videoId: 'ph10624hS7E', startSeconds: 253 });
  assert.deepEqual(parseYouTube('https://youtu.be/ph10624hS7E?t=4m13s'), { videoId: 'ph10624hS7E', startSeconds: 253 });
  assert.deepEqual(parseYouTube('https://m.youtube.com/shorts/ph10624hS7E'), { videoId: 'ph10624hS7E', startSeconds: 0 });
  assert.deepEqual(parseYouTube('https://www.youtube-nocookie.com/embed/ph10624hS7E?start=30'), { videoId: 'ph10624hS7E', startSeconds: 30 });
  assert.equal(parseYouTube('https://www.youtube.com/playlist?list=PLx'), null);
  assert.equal(parseYouTube('https://evil.example/watch?v=ph10624hS7E'), null);
  assert.equal(parseYouTube('not a link'), null);
});

test('tracks: everyone lists, the manager adds (title from YouTube) and removes', async () => {
  const db = new Database({ filename: ':memory:' }); const app = new Hono(); let manager = true;
  const fakeFetch = (async () => Response.json({ title: 'Lo-fi beats' })) as unknown as typeof fetch;
  registerMusicRoutes(app, { db, manager: () => manager, fetch: fakeFetch });
  const list = async (): Promise<MusicTrack[]> => ((await (await app.request('/v1/public/music')).json()) as { tracks: MusicTrack[] }).tracks;
  assert.deepEqual((await list()).map(track => track.videoId), ['CXJJDxg7Mos'], 'the office song is there from the start');
  const post = (url: string) => app.request('/v1/music', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  const added = await post('https://www.youtube.com/watch?v=ph10624hS7E&t=253s');
  assert.equal(added.status, 201);
  assert.deepEqual(((await added.json()) as MusicTrack), { ...(await list())[1]!, title: 'Lo-fi beats', startSeconds: 253 });
  assert.equal((await post('https://youtu.be/ph10624hS7E')).status, 200, 'the same video is not added twice');
  assert.equal((await post('https://example.com')).status, 400);
  assert.equal((await app.request('/v1/music/ph10624hS7E', { method: 'DELETE' })).status, 200);
  assert.equal((await list()).length, 1);
  manager = false;
  assert.equal((await post('https://youtu.be/ph10624hS7E')).status, 401);
  db.close();
});
