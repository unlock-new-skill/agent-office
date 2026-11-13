// All data here is SYNTHETIC: in-memory offices seeded from office.example.yaml and a fake Telegram Bot API.
import assert from 'node:assert/strict';
import test from 'node:test';
import { looksSecret } from '../../src/server/collaboration/approval-service.js';
import { TelegramError, type TelegramClient } from '../../src/server/notify/telegram-client.js';
import { TelegramNotifier } from '../../src/server/notify/telegram-notifier.js';
import { createAppFixture, createSeededOffice, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };
const REQ = 'Goal, inputs, expected output and acceptance criteria.';
const CHAT = '42';
const ASK = { action: 'SYNTHETIC: deploy build 1.2.3 to staging', scope: 'staging host only, this build only', reason: 'SYNTHETIC test request', consequences: 'about 5 min downtime on staging', target: 'staging v1.2.3' };

/** Fake Bot API; `sendFails` makes the next sendMessage calls throw the given errors in order. */
const fakeTelegram = () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []; const updates: unknown[][] = []; const sendFails: Error[] = []; let messageId = 100;
  const client = {
    call: async (method: string, body: Record<string, unknown> = {}) => {
      calls.push({ method, body });
      if (method === 'getMe') return { username: 'office_bot' };
      if (method === 'getUpdates') { const batch = updates.shift(); if (batch) return batch; await new Promise(resolve => setTimeout(resolve, 5)); return []; }
      if (method === 'sendMessage') { const failure = sendFails.shift(); if (failure) throw failure; return { message_id: ++messageId }; }
      return true;
    },
  } as unknown as TelegramClient;
  return { client, calls, updates, sendFails };
};
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40));
const pair = (fixture: Fixture, chat = CHAT): void => { fixture.db.raw.prepare("INSERT INTO app_settings(key,value) VALUES ('telegram.chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(chat); };
const setup = (options: { paired?: boolean } = {}) => {
  const fixture = createSeededOffice({ telegram: true }); const telegram = fakeTelegram();
  const notifier = new TelegramNotifier({ client: telegram.client, db: fixture.db, office: fixture.office, publicOrigin: null, log: () => undefined, sleep: async () => {} });
  if (options.paired ?? true) pair(fixture);
  const task = fixture.office.tasks.create(manager, { title: 'SYNTHETIC release task', body: REQ, assigneeSeatId: 'dev-be', estimateMinutes: 60 });
  return { fixture, notifier, task, ...telegram };
};
const sent = (calls: Array<{ method: string; body: Record<string, unknown> }>) => calls.filter(call => call.method === 'sendMessage');
const nonceOf = (call: { body: Record<string, unknown> }, which = 0): string => (call.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![which]!.callback_data.slice(5);
const press = (id: string, data: string, options: { chat?: number; from?: number; messageId?: number; type?: string } = {}) => ({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id, data, from: { id: options.from ?? Number(CHAT) }, message: { chat: { id: options.chat ?? Number(CHAT), type: options.type ?? 'private' }, message_id: options.messageId ?? 101 } } });
const lines = (fixture: Fixture, needle: string): Array<{ body: string; mentions: string }> => fixture.db.raw.prepare("SELECT body,mentions_json AS mentions FROM messages WHERE sender_kind='system' AND body LIKE ?").all(`%${needle}%`) as Array<{ body: string; mentions: string }>;

test('one request, one Telegram message: a retried request returns the same pending request', async () => {
  const { fixture, notifier, task, calls } = setup();
  const first = fixture.office.approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  const again = fixture.office.approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  assert.equal(first.duplicate, false); assert.equal(again.duplicate, true); assert.equal(again.approval.id, first.approval.id);
  await notifier.pumpApprovals(); await notifier.pumpApprovals();
  assert.equal(sent(calls).length, 1, 'no duplicate message');
  const message = sent(calls)[0]!;
  assert.equal(message.body.chat_id, CHAT);
  assert.match(String(message.body.text), /@dev-be asks for your decision/); assert.match(String(message.body.text), /Scope: staging host only/); assert.match(String(message.body.text), /Expires:/);
  const view = fixture.office.approvals.get(manager, first.approval.id).approval;
  assert.equal(view.status, 'pending'); assert.equal(view.delivery.status, 'sent', 'delivered is not approved');
  assert.equal(JSON.stringify(view).includes(nonceOf(message)), false, 'the nonce never leaves the server');
  fixture.close();
});

test('the manager approves from the paired private chat: audit, thread line waking requester and lead, task unchanged, replay idempotent', async () => {
  const { fixture, notifier, task, calls, updates } = setup();
  const { approval } = fixture.office.approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  notifier.start(); await settle();
  const nonce = nonceOf(sent(calls)[0]!);
  updates.push([press('q-1', `ap:a:${nonce}`)]); await settle();
  updates.push([press('q-2', `ap:a:${nonce}`)]); await settle();
  notifier.stop();
  const { approval: after, events } = fixture.office.approvals.get(manager, approval.id);
  assert.equal(after.status, 'approved'); assert.equal(after.decidedBy, 'manager'); assert.equal(after.decidedVia, 'telegram');
  assert.equal(events.filter(event => event.kind === 'approved').length, 1, 'a replayed press records nothing new');
  assert.ok(calls.some(call => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'q-2' && call.body.text === 'Already approved.'));
  const line = lines(fixture, `Approval ${approval.id}`)[0]!;
  assert.match(line.body, /APPROVED by manager \(telegram\)/); assert.match(line.body, /Valid until/); assert.match(line.body, /runs nothing/);
  assert.deepEqual(JSON.parse(line.mentions).sort(), ['dev-be', 'dev-lead']);
  const unchanged = fixture.office.tasks.get(task.id);
  assert.equal(unchanged.status, 'todo'); assert.equal(unchanged.result, 'unknown'); assert.deepEqual(unchanged.dependsOn, []);
  assert.ok(calls.some(call => call.method === 'editMessageText' && /→ ✅ APPROVED \(telegram\)/.test(String(call.body.text))));
  fixture.close();
});

test('wrong chat, wrong sender, a group chat and a button of another message are refused and recorded', async () => {
  const { fixture, notifier, task, calls, updates } = setup();
  const { approval } = fixture.office.approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  notifier.start(); await settle();
  const nonce = nonceOf(sent(calls)[0]!);
  updates.push([press('w-chat', `ap:a:${nonce}`, { chat: 999, from: 999 }), press('w-from', `ap:a:${nonce}`, { from: 7 }), press('w-group', `ap:a:${nonce}`, { type: 'group' }), press('w-msg', `ap:a:${nonce}`, { messageId: 55 })]);
  await settle(); notifier.stop();
  const { approval: after, events } = fixture.office.approvals.get(manager, approval.id);
  assert.equal(after.status, 'pending');
  assert.deepEqual(events.filter(event => event.kind === 'callback_refused').map(event => event.detail), ['wrong chat', 'wrong sender', 'not a private chat', 'button from another message']);
  assert.equal(calls.filter(call => call.method === 'answerCallbackQuery' && call.body.text === 'Not allowed.').length, 4);
  fixture.close();
});

test('an edited request is a new revision: old buttons and the old web revision no longer decide it', async () => {
  const { fixture, notifier, task, calls, updates } = setup();
  const { approval } = fixture.office.approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  notifier.start(); await settle();
  const oldNonce = nonceOf(sent(calls)[0]!);
  assert.throws(() => fixture.office.approvals.update(seat('dev-fe'), approval.id, { scope: 'x' }), /approval_changed_by_requester/);
  const edited = fixture.office.approvals.update(seat('dev-be'), approval.id, { scope: 'staging and production' });
  assert.equal(edited.revision, 2); await settle();
  updates.push([press('old', `ap:a:${oldNonce}`)]); await settle();
  assert.equal(fixture.office.approvals.get(manager, approval.id).approval.status, 'pending');
  assert.ok(calls.some(call => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'old' && /Not current/.test(String(call.body.text))));
  assert.ok(calls.some(call => call.method === 'editMessageText' && /Replaced by a newer revision/.test(String(call.body.text))));
  assert.equal(sent(calls).length, 2, 'the new revision is sent once');
  assert.throws(() => fixture.office.approvals.decide(manager, approval.id, 'approve', 1), /approval_superseded/);
  notifier.stop();
  const rejected = fixture.office.approvals.decide(manager, approval.id, 'reject', 2, 'not now');
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.decidedVia, 'web');
  assert.match(lines(fixture, `Approval ${approval.id}`)[0]!.body, /REJECTED by manager \(web\)[\s\S]*Note: not now/);
  fixture.close();
});

test('expiry is never approval; only the manager decides; requests need a readable task or a joined thread; secrets are refused', () => {
  const fixture = createSeededOffice(); const { approvals, tasks } = fixture.office;
  const task = tasks.create(manager, { title: 'SYNTHETIC', body: REQ, assigneeSeatId: 'dev-be', estimateMinutes: 60 });
  const { approval } = approvals.request(seat('dev-be'), { taskId: task.id, ...ASK, expiresInMinutes: 5 });
  assert.equal(approval.delivery.status, 'disabled', 'Telegram off: the request stays pending in the Office');
  assert.throws(() => approvals.decide(seat('dev-lead'), approval.id, 'approve', 1), /approval_decided_by_manager/);
  assert.throws(() => approvals.request(manager, { taskId: task.id, ...ASK }), /approval_requested_by_seats/);
  assert.throws(() => approvals.request(seat('ba-docs'), { taskId: task.id, ...ASK }), /forbidden_task_read/);
  assert.throws(() => approvals.request(seat('ba-docs'), { channelId: 'dev', threadSeq: 1, ...ASK }), /forbidden_channel|not_found/);
  assert.throws(() => approvals.request(seat('dev-be'), { ...ASK }), /approval_needs_task_or_thread/);
  for (const secret of ['password=hunter2hunter2', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'use token ghp_abcdefghijklmnopqrstuvwxyz0123', 'postgres://user:pa55word@db:5432/x', '123456789:AAEhBP0av28eRaVbXoCnAbCdEfGhIjKlMnO', 'key AbCdEfGh1234567890IjKlMnOp9876543210Qr', '{"api_key": "abcd1234efgh"}', 'password "hunter2!"', 'the db password is Hunter2!x']) {
    assert.throws(() => approvals.request(seat('dev-be'), { taskId: task.id, ...ASK, reason: secret }), /approval_contains_secret/, secret);
  }
  for (const fine of ['/Users/x/Desktop/my-studio/plans/reports/t-pm-1/report.md', 'commit 9641c54a9641c54a9641c54a9641c54a9641c54a', 'set AGENT_OFFICE_PUBLIC_ORIGIN in .env (value not included)']) assert.ok(!looksSecret(fine), fine);
  fixture.db.raw.prepare('UPDATE approval_requests SET expires_at=? WHERE id=?').run(Date.now() - 1, approval.id);
  approvals.expireDue();
  const expired = approvals.get(manager, approval.id).approval;
  assert.equal(expired.status, 'expired'); assert.equal(expired.decidedBy, 'office');
  assert.throws(() => approvals.decide(manager, approval.id, 'approve', 1), /approval_expired/);
  assert.match(lines(fixture, `Approval ${approval.id}`)[0]!.body, /EXPIRED — not approved/);
  assert.equal(tasks.get(task.id).status, 'todo');
  fixture.close();
});

test('delivery truth: not paired, 429, network error, timeout (no automatic resend), manager resend, failure after the attempt limit', async () => {
  const { fixture, notifier, task, calls, sendFails } = setup({ paired: false });
  const { approvals } = fixture.office;
  const { approval } = approvals.request(seat('dev-be'), { taskId: task.id, ...ASK });
  await notifier.pumpApprovals();
  assert.equal(approvals.get(manager, approval.id).approval.delivery.status, 'not_paired'); assert.equal(sent(calls).length, 0);
  pair(fixture, '-100123');
  await notifier.pumpApprovals();
  assert.equal(approvals.get(manager, approval.id).approval.delivery.status, 'failed', 'a group chat never receives approvals');
  pair(fixture); approvals.resend(manager, approval.id);
  sendFails.push(new TelegramError('telegram sendMessage: Too Many Requests: retry after 7', 'api', 429, 7));
  await notifier.pumpApprovals();
  let view = approvals.get(manager, approval.id).approval;
  assert.equal(view.delivery.status, 'retry'); assert.equal(view.status, 'pending');
  const nextAt = (fixture.db.raw.prepare('SELECT next_attempt_at AS at FROM approval_requests WHERE id=?').get(approval.id) as { at: number }).at;
  assert.ok(nextAt - Date.now() > 5000, 'waits for retry_after');
  fixture.db.raw.prepare('UPDATE approval_requests SET next_attempt_at=0 WHERE id=?').run(approval.id);
  sendFails.push(new TelegramError('connect ECONNREFUSED', 'network'));
  await notifier.pumpApprovals();
  assert.equal(approvals.get(manager, approval.id).approval.delivery.status, 'retry');
  fixture.db.raw.prepare('UPDATE approval_requests SET next_attempt_at=0 WHERE id=?').run(approval.id);
  sendFails.push(new TelegramError('This operation was aborted', 'uncertain'));
  await notifier.pumpApprovals(); await notifier.pumpApprovals();
  view = approvals.get(manager, approval.id).approval;
  assert.equal(view.delivery.status, 'uncertain'); assert.equal(view.status, 'pending');
  const attemptsAfterTimeout = sent(calls).length;
  await notifier.pumpApprovals();
  assert.equal(sent(calls).length, attemptsAfterTimeout, 'an uncertain delivery is not resent by itself');
  approvals.resend(manager, approval.id);
  await notifier.pumpApprovals();
  assert.equal(approvals.get(manager, approval.id).approval.delivery.status, 'sent');
  for (let attempt = 0; attempt < 5; attempt++) sendFails.push(new TelegramError('connect ECONNREFUSED', 'network'));
  const second = approvals.request(seat('dev-be'), { taskId: task.id, ...ASK, action: 'SYNTHETIC: second' }).approval;
  for (let round = 0; round < 10 && approvals.get(manager, second.id).approval.delivery.status !== 'failed'; round++) {
    fixture.db.raw.prepare('UPDATE approval_requests SET next_attempt_at=0 WHERE id=?').run(second.id);
    await settle(); await notifier.pumpApprovals();
  }
  const gaveUp = approvals.get(manager, second.id);
  assert.equal(gaveUp.approval.delivery.status, 'failed'); assert.equal(gaveUp.approval.delivery.attempts, 5); assert.equal(gaveUp.approval.status, 'pending');
  assert.ok(gaveUp.events.every(event => !/bot\d|token/i.test(event.detail)));
  fixture.close();
});

test('API: a seat asks, a retry returns 200 with the same id, only the manager decides, the decision is idempotent', async () => {
  const fixture = createAppFixture();
  const task = fixture.office.tasks.create(manager, { title: 'SYNTHETIC', body: REQ, assigneeSeatId: 'dev-be', estimateMinutes: 60 });
  const token = fixture.seatToken('dev-be');
  const created = await fixture.agent(token, '/v1/approvals', { body: { taskId: task.id, ...ASK } });
  assert.equal(created.status, 201);
  const { approval } = await created.json() as { approval: { id: string; revision: number } };
  const retried = await fixture.agent(token, '/v1/approvals', { body: { taskId: task.id, ...ASK } });
  assert.equal(retried.status, 200); assert.equal(((await retried.json()) as { approval: { id: string } }).approval.id, approval.id);
  assert.equal((await fixture.agent(token, `/v1/approvals/${approval.id}/decision`, { body: { decision: 'approve', revision: 1 } })).status, 401, 'a seat cannot decide');
  assert.equal((await fixture.manager(`/v1/approvals/${approval.id}/decision`, { body: { decision: 'approve', revision: 1 } })).status, 200);
  assert.equal((await fixture.manager(`/v1/approvals/${approval.id}/decision`, { body: { decision: 'approve', revision: 1 } })).status, 200, 'same decision again: no change');
  assert.equal((await fixture.manager(`/v1/approvals/${approval.id}/decision`, { body: { decision: 'reject', revision: 1 } })).status, 409);
  const status = await (await fixture.agent(token, `/v1/approvals/${approval.id}`)).json() as { approval: { status: string }; events: Array<{ kind: string }> };
  assert.equal(status.approval.status, 'approved'); assert.deepEqual(status.events.map(event => event.kind), ['requested', 'approved']);
  const other = fixture.seatToken('ba-docs');
  assert.equal((await fixture.agent(other, `/v1/approvals/${approval.id}`)).status, 403);
  assert.equal((await fixture.agent(token, '/v1/approvals', { body: { taskId: task.id, ...ASK, scope: 'api_key=abcd1234efgh' } })).status, 400);
  fixture.close();
});

test('after a saved decision nothing turns into an error: removed requester seat at expiry, self-cancel does not wake the canceller, 5xx is uncertain, a send during an edit is marked replaced', async () => {
  const { fixture, notifier, task, calls, sendFails } = setup();
  const { approvals } = fixture.office;
  const gone = approvals.request(seat('dev-mobile'), { taskId: task.id, ...ASK }).approval;
  fixture.db.raw.prepare('PRAGMA foreign_keys=OFF').run(); fixture.db.raw.prepare("DELETE FROM seats WHERE id='dev-mobile'").run(); fixture.db.raw.prepare('PRAGMA foreign_keys=ON').run();
  fixture.db.raw.prepare('UPDATE approval_requests SET expires_at=? WHERE id=?').run(Date.now() - 1, gone.id);
  assert.doesNotThrow(() => approvals.list(manager));
  assert.equal(approvals.get(manager, gone.id).approval.status, 'expired');
  const mine = approvals.request(seat('dev-be'), { taskId: task.id, ...ASK }).approval;
  approvals.cancel(seat('dev-be'), mine.id);
  const line = lines(fixture, `Approval ${mine.id}`)[0]!;
  assert.match(line.body, /CANCELLED by dev-be/); assert.ok(!JSON.parse(line.mentions).includes('dev-be'), 'the canceller is not woken');
  await notifier.pumpApprovals();
  sendFails.push(new TelegramError('telegram sendMessage: Bad Gateway', 'api', 502));
  const flaky = approvals.request(seat('dev-be'), { taskId: task.id, ...ASK, action: 'SYNTHETIC: 5xx' }).approval;
  await settle(); await notifier.pumpApprovals();
  assert.equal(approvals.get(manager, flaky.id).approval.delivery.status, 'uncertain', 'a 5xx may have been delivered: not resent by itself');
  approvals.markDelivery(flaky.id, 0, { status: 'sent', messageId: 777 });
  assert.equal((fixture.db.raw.prepare('SELECT stale_message_id AS id FROM approval_requests WHERE id=?').get(flaky.id) as { id: number }).id, 777, 'a message of an older revision is marked replaced');
  await notifier.pumpApprovals();
  assert.ok(calls.some(call => call.method === 'editMessageText' && call.body.message_id === 777 && /Replaced by a newer revision/.test(String(call.body.text))));
  fixture.close();
});
