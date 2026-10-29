import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAppFixture } from '../helpers/office-fixture.js';
import { Database, SCHEMA_VERSION } from '../../src/server/db/database.js';
import type { SeatHandoff } from '../../src/shared/contracts.js';

type Me = { seat: { id: string } | null; handoff: SeatHandoff | null; handoffBrief: string | null };

test('handoff survives a seat changing sessions: next session gets note, open tasks and unread in /v1/me', async () => {
  const fixture = createAppFixture();
  const devLead = fixture.seatToken('dev-lead'); const first = fixture.seatToken('dev-be');
  assert.equal((await fixture.agent(devLead, '/v1/tasks', { body: { title: 'Login API', assigneeSeatId: 'dev-be' } })).status, 201);
  assert.equal((await fixture.agent(first, '/v1/seats/dev-be/handoff', { method: 'PUT', body: { body: 'JWT done; refresh token next. Branch feat/login.' } })).status, 200);
  fixture.office.org.assignAgent('dev-be', null);
  const second = fixture.auth.registerSession({ sessionId: 'session-dev-be-2', project: 'other-machine' });
  fixture.office.org.assignAgent('dev-be', second.agentId);
  const me = await (await fixture.agent(second.token, '/v1/me')).json() as Me;
  assert.equal(me.handoff?.body, 'JWT done; refresh token next. Branch feat/login.');
  assert.match(me.handoffBrief ?? '', /refresh token next/);
  assert.match(me.handoffBrief ?? '', /\[todo\] Login API/);
  assert.match(me.handoffBrief ?? '', /Unread: #dev \d+/);
  fixture.close();
});

test('handoff access: agent only its own seat, manager any seat, body bounded', async () => {
  const fixture = createAppFixture(); const devBe = fixture.seatToken('dev-be');
  assert.equal((await fixture.agent(devBe, '/v1/seats/dev-fe/handoff', { method: 'PUT', body: { body: 'x' } })).status, 403);
  assert.equal((await fixture.agent(devBe, '/v1/seats/dev-fe/handoff')).status, 403);
  assert.equal((await fixture.manager('/v1/seats/dev-fe/handoff', { method: 'PUT', body: { body: 'manager note' } })).status, 200);
  const read = await (await fixture.manager('/v1/seats/dev-fe/handoff')).json() as { handoff: SeatHandoff };
  assert.equal(read.handoff.updatedBy, 'manager');
  assert.equal((await fixture.manager('/v1/seats/dev-fe/handoff', { method: 'PUT', body: { body: 'x'.repeat(8001) } })).status, 400);
  assert.equal((await fixture.manager('/v1/seats/nope/handoff')).status, 404);
  const empty = await (await fixture.agent(devBe, '/v1/me')).json() as Me;
  assert.equal(empty.handoff, null);
  assert.match(empty.handoffBrief ?? '', /Note: none yet/);
  fixture.close();
});

test('a v3 database upgrades in place to the current schema with seat_handoffs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-mig-')); const filename = path.join(dir, 'office.db');
  new Database({ filename }).close();
  const raw = new DatabaseSync(filename); raw.exec('DROP TABLE seat_handoffs; DROP TABLE permission_requests; DROP TABLE install_codes; DROP TABLE seat_compactions; DROP TABLE runner_commands; DROP TABLE runners; DROP TABLE app_settings; ALTER TABLE agents DROP COLUMN machine_id; ALTER TABLE agents DROP COLUMN dismissed_at; ALTER TABLE agents DROP COLUMN model; ALTER TABLE seats DROP COLUMN work_ms; ALTER TABLE seats DROP COLUMN last_wake_at; ALTER TABLE departments DROP COLUMN deputy_seat_id; ALTER TABLE tasks DROP COLUMN requester_seat_id; DROP INDEX messages_thread; ALTER TABLE messages DROP COLUMN thread_seq; PRAGMA user_version=3;'); raw.close();
  const db = new Database({ filename });
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='seat_handoffs'").get());
  assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='install_codes'").get());
  db.close();
});

test('brief carries recent conversation and the last compaction summary to the next session, not to the compacted one', async () => {
  const fixture = createAppFixture(); const devLead = fixture.seatToken('dev-lead'); const devBe = fixture.seatToken('dev-be');
  const root = await (await fixture.agent(devBe, '/v1/channels/dev/messages', { body: { body: 'blocked on schema' } })).json() as { seq: number };
  await fixture.agent(devLead, '/v1/channels/dev/messages', { body: { body: 'use v2', threadSeq: root.seq } });
  await fixture.agent(devLead, '/v1/channels/dev/messages', { body: { body: 'unrelated chatter' } });
  assert.equal((await fixture.agent(devBe, '/v1/seats/me/compaction', { body: { summary: 'Was migrating auth to v2 schema; next: tests.' } })).status, 200);
  const fresh = await (await fixture.agent(devBe, '/v1/me')).json() as { handoffBrief: string };
  assert.match(fresh.handoffBrief, /Auto summary from the previous session's last context compaction/);
  assert.match(fresh.handoffBrief, /Was migrating auth to v2 schema/);
  assert.match(fresh.handoffBrief, new RegExp(`#dev \\[${root.seq}\\] you: blocked on schema`));
  assert.match(fresh.handoffBrief, new RegExp(`#dev thread \\[${root.seq}\\] @dev-lead: use v2`));
  assert.doesNotMatch(fresh.handoffBrief, /unrelated chatter/);
  const compacted = await (await fixture.agent(devBe, '/v1/me?source=compact')).json() as { handoffBrief: string };
  assert.doesNotMatch(compacted.handoffBrief, /Auto summary/);
  assert.match(compacted.handoffBrief, /Recent conversation/);
  // A newer hand-written note takes precedence over an older automatic summary.
  await fixture.agent(devBe, '/v1/seats/dev-be/handoff', { method: 'PUT', body: { body: 'manual note' } });
  assert.doesNotMatch((await (await fixture.agent(devBe, '/v1/me')).json() as { handoffBrief: string }).handoffBrief, /Auto summary/);
  fixture.close();
});
