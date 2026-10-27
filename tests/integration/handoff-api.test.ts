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
  const raw = new DatabaseSync(filename); raw.exec('DROP TABLE seat_handoffs; DROP TABLE permission_requests; DROP TABLE install_codes; ALTER TABLE departments DROP COLUMN deputy_seat_id; ALTER TABLE tasks DROP COLUMN requester_seat_id; PRAGMA user_version=3;'); raw.close();
  const db = new Database({ filename });
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='seat_handoffs'").get());
  assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='install_codes'").get());
  db.close();
});
