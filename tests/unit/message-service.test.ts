import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const manager = { kind: 'manager' as const };

test('routing: members post only to own department; leaders also to leaders; manager anywhere', () => {
  const { office, close } = createSeededOffice();
  assert.ok(office.messages.post(seat('dev-be'), 'dev', 'hello team'));
  assert.throws(() => office.messages.post(seat('dev-be'), 'ba', 'hi BA'), /forbidden_channel/);
  assert.throws(() => office.messages.post(seat('dev-be'), 'leaders', 'hi leaders'), /forbidden_channel/);
  assert.ok(office.messages.post(seat('dev-lead'), 'dev', 'team update'));
  assert.ok(office.messages.post(seat('dev-lead'), 'leaders', 'need BA spec'));
  assert.throws(() => office.messages.post(seat('dev-lead'), 'ba', 'direct to BA'), /forbidden_channel/);
  for (const channel of ['dev', 'ba', 'design', 'devops', 'leaders']) assert.ok(office.messages.post(manager, channel, 'manager note'));
  assert.throws(() => office.messages.post(manager, 'nope', 'x'), /channel_not_found/);
  close();
});

test('reading follows the same membership rules', () => {
  const { office, close } = createSeededOffice();
  office.messages.post(manager, 'leaders', 'leaders only');
  assert.equal(office.messages.list(seat('ba-lead'), 'leaders').length, 1);
  assert.throws(() => office.messages.list(seat('ba-docs'), 'leaders'), /forbidden_channel/);
  close();
});

test('per-channel seq is monotonic, bodies are bounded, mentions resolve to real seats', () => {
  const { office, close } = createSeededOffice();
  const first = office.messages.post(manager, 'dev', 'ping @dev-be and @dev-fe and @ghost');
  const second = office.messages.post(manager, 'dev', 'again');
  const other = office.messages.post(manager, 'ba', 'ba channel');
  assert.deepEqual([first.seq, second.seq, other.seq], [1, 2, 1]);
  assert.deepEqual(first.mentions, ['dev-be', 'dev-fe']);
  assert.throws(() => office.messages.post(manager, 'dev', ''), /invalid_message_body/);
  assert.throws(() => office.messages.post(manager, 'dev', 'x'.repeat(16_385)), /invalid_message_body/);
  close();
});

test('paging returns messages after/before a seq in ascending order', () => {
  const { office, close } = createSeededOffice();
  for (let i = 1; i <= 5; i++) office.messages.post(manager, 'dev', `m${i}`);
  assert.deepEqual(office.messages.list(manager, 'dev', { after: 3 }).map(message => message.body), ['m4', 'm5']);
  assert.deepEqual(office.messages.list(manager, 'dev', { before: 4, limit: 2 }).map(message => message.body), ['m2', 'm3']);
  assert.deepEqual(office.messages.list(manager, 'dev', { limit: 2 }).map(message => message.body), ['m4', 'm5']);
  close();
});

test('posting emits message events and advances the sender read cursor', () => {
  const { office, emitted, close } = createSeededOffice(); emitted.length = 0;
  const message = office.messages.post(seat('dev-be'), 'dev', 'done');
  assert.deepEqual(emitted.at(-1), { type: 'collab', kind: 'message', message });
  assert.equal(office.messages.channelsForSeat('dev-be').find(channel => channel.id === 'dev')?.unread, 0);
  assert.equal(office.messages.channelsForSeat('dev-fe').find(channel => channel.id === 'dev')?.unread, 1);
  office.messages.markRead('dev-fe', 'dev', message.seq);
  assert.equal(office.messages.channelsForSeat('dev-fe').find(channel => channel.id === 'dev')?.unread, 0);
  close();
});

test('edit: only the sender edits; mentions are re-parsed; system lines are immutable', () => {
  const { office, emitted, close } = createSeededOffice();
  const original = office.messages.post(seat('dev-be'), 'dev', 'ping @dev-fe');
  const edited = office.messages.edit(seat('dev-be'), 'dev', original.seq, 'ping @dev-lead instead');
  assert.equal(edited.body, 'ping @dev-lead instead'); assert.deepEqual(edited.mentions, ['dev-lead']); assert.ok(edited.editedAt);
  assert.deepEqual(emitted.at(-1), { type: 'collab', kind: 'message', message: edited });
  assert.throws(() => office.messages.edit(seat('dev-fe'), 'dev', original.seq, 'hijack'), /not_message_author/);
  assert.throws(() => office.messages.edit(manager, 'dev', original.seq, 'manager rewrite'), /not_message_author/);
  assert.throws(() => office.messages.edit(seat('dev-be'), 'dev', 99, 'x'), /message_not_found/);
  const system = office.messages.postSystem('dev', 'Task created', []);
  assert.throws(() => office.messages.edit(manager, 'dev', system.seq, 'x'), /not_message_author/);
  close();
});

test('delete: sender or manager soft-deletes; body and mentions are cleared; deleted cannot be edited', () => {
  const { office, close } = createSeededOffice();
  const mine = office.messages.post(seat('dev-be'), 'dev', 'oops @dev-fe');
  const other = office.messages.post(seat('dev-fe'), 'dev', 'keep me');
  assert.throws(() => office.messages.remove(seat('dev-be'), 'dev', other.seq), /not_message_author/);
  const deleted = office.messages.remove(seat('dev-be'), 'dev', mine.seq);
  assert.equal(deleted.body, ''); assert.deepEqual(deleted.mentions, []); assert.ok(deleted.deletedAt);
  assert.throws(() => office.messages.edit(seat('dev-be'), 'dev', mine.seq, 'again'), /message_deleted/);
  assert.ok(office.messages.remove(manager, 'dev', other.seq).deletedAt, 'manager moderates any message');
  assert.deepEqual(office.messages.list(manager, 'dev').map(message => message.seq), [1, 2], 'seq stays stable');
  close();
});
