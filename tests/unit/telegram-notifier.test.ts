import assert from 'node:assert/strict';
import test from 'node:test';
import { describeProxy, proxyDispatcher, TelegramClient } from '../../src/server/notify/telegram-client.js';
import { createOffice } from '../../src/server/collaboration/office.js';
import { TelegramNotifier } from '../../src/server/notify/telegram-notifier.js';
import type { CollabEvent } from '../../src/shared/contracts.js';
import { createSeededOffice, insertAgent } from '../helpers/office-fixture.js';

/** Fake Bot API: records calls, serves queued getUpdates batches, then parks the poll. */
const fakeTelegram = () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []; const updates: unknown[][] = []; let messageId = 100;
  const client = {
    call: async (method: string, body: Record<string, unknown> = {}) => {
      calls.push({ method, body });
      if (method === 'getMe') return { username: 'office_bot' };
      if (method === 'getUpdates') { const batch = updates.shift(); if (batch) return batch; await new Promise(resolve => setTimeout(resolve, 5)); return []; }
      if (method === 'sendMessage') return { message_id: ++messageId };
      return true;
    },
  } as unknown as TelegramClient;
  return { client, calls, updates };
};
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30));

test('pairing, permission prompt with buttons, approve from Telegram, message edited with the outcome', async () => {
  let notifier: TelegramNotifier | null = null;
  const fixture = createSeededOffice();
  // An office on the seeded database whose events reach the notifier, wired the way index.ts does it.
  const office = createOffice(fixture.db, { maxAutoWakes: 15, remoteApproval: true, emit: (event: CollabEvent) => notifier?.onEvent(event) });
  const { client, calls, updates } = fakeTelegram();
  notifier = new TelegramNotifier({ client, db: fixture.db, office, publicOrigin: 'https://office.example.com', log: () => undefined, sleep: async () => {} });
  notifier.start(); await settle();
  assert.equal(notifier.status().botUsername, 'office_bot');
  const { code, link } = notifier.startPairing();
  assert.equal(link, `https://t.me/office_bot?start=${code}`);

  updates.push([{ update_id: 1, message: { chat: { id: 999 }, text: '/start deadbeef' } }, { update_id: 2, message: { chat: { id: 42 }, text: `/start ${code}` } }]);
  await settle();
  assert.equal(notifier.status().paired, true);
  assert.ok(!calls.some(call => call.method === 'sendMessage' && call.body.chat_id === '999'), 'strangers get no answer');

  insertAgent(fixture.db, 'cc-1'); office.org.assignAgent('dev-be', 'cc-1');
  const request = office.permissions.create('cc-1', 'Bash', { command: 'npm install lodash' });
  await settle();
  const prompt = calls.find(call => call.method === 'sendMessage' && String(call.body.text).includes('@dev-be needs permission'))!;
  assert.match(String(prompt.body.text), /Bash: npm install lodash/);
  const keyboard = (prompt.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>> }).inline_keyboard;
  assert.deepEqual(keyboard[0]!.map(button => button.callback_data), [`p:a:${request.id}`, `p:d:${request.id}`]);
  assert.equal(keyboard[1]![0]!.url, 'https://office.example.com');

  updates.push([{ update_id: 3, callback_query: { id: 'q-stranger', data: `p:a:${request.id}`, message: { chat: { id: 999 }, message_id: 5 } } }]);
  await settle();
  assert.equal(office.permissions.get(request.id).status, 'pending', 'other chats cannot decide');
  updates.push([{ update_id: 4, callback_query: { id: 'q-1', data: `p:a:${request.id}`, message: { chat: { id: 42 }, message_id: 101 } } }]);
  await settle();
  const decided = office.permissions.get(request.id);
  assert.equal(decided.status, 'allowed'); assert.equal(decided.decidedBy, 'telegram');
  assert.ok(calls.some(call => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'q-1' && call.body.text === 'Allowed'));
  const edit = calls.find(call => call.method === 'editMessageText')!;
  assert.match(String(edit.body.text), /→ ✅ Allowed \(Telegram\)/);

  notifier.onEvent({ type: 'collab', kind: 'runners', runners: [{ id: 'r1', label: null, config: { version: 0, seats: [] }, machine: 'mac', online: true, lastSeenAt: 0, seats: [{ seatId: 'dev-be', state: 'idle', sessionId: null, restarts: 0, permissionMode: 'acceptEdits', detail: '' }] }] });
  notifier.onEvent({ type: 'collab', kind: 'runners', runners: [{ id: 'r1', label: null, config: { version: 0, seats: [] }, machine: 'mac', online: true, lastSeenAt: 0, seats: [{ seatId: 'dev-be', state: 'failed', sessionId: null, restarts: 5, permissionMode: 'acceptEdits', detail: 'crashed 5×' }] }] });
  await settle();
  assert.ok(calls.some(call => call.method === 'sendMessage' && /Runner seat @dev-be on mac failed: crashed 5×/.test(String(call.body.text))));
  // Wake limit: the first org view only seeds state; a seat that then hits the limit is reported with a Reset button.
  notifier.onEvent({ type: 'collab', kind: 'org', org: office.org.view() });
  insertAgent(fixture.db, 'cc-2'); office.org.assignAgent('dev-fe', 'cc-2');
  fixture.db.raw.prepare('UPDATE seats SET consecutive_wakes=99 WHERE id=?').run('dev-fe');
  notifier.onEvent({ type: 'collab', kind: 'org', org: office.org.view() });
  await settle();
  const alert = calls.find(call => call.method === 'sendMessage' && String(call.body.text).includes('@dev-fe'))!;
  assert.match(String(alert.body.text), /auto-wake limit/);
  updates.push([{ update_id: 9, callback_query: { id: 'q-reset', data: 'w:dev-fe', message: { chat: { id: 42 }, message_id: 200 } } }]);
  await settle();
  assert.equal(office.org.seat('dev-fe').consecutiveWakes, 0);
  notifier.stop(); office.close(); fixture.close();
});

test('proxy settings: http and socks5 URLs are accepted, others rejected, credentials masked in logs', () => {
  assert.equal(proxyDispatcher(null), undefined);
  assert.ok(proxyDispatcher('http://user:pass@10.0.0.1:3128'));
  assert.ok(proxyDispatcher('socks5://user:pass@10.0.0.1:1080'));
  assert.throws(() => proxyDispatcher('ftp://10.0.0.1:21'), /must start with/);
  assert.equal(describeProxy('http://user:secret@10.0.0.1:3128'), 'http://***@10.0.0.1:3128');
});

test('Bot API errors never echo the token', async () => {
  const client = new TelegramClient('123:SECRET', null, async () => { throw new Error('connect ETIMEDOUT for https://api.telegram.org/bot123:SECRET/getMe'); });
  await assert.rejects(client.call('getMe'), (error: Error) => !error.message.includes('SECRET') && error.message.includes('***'));
});
