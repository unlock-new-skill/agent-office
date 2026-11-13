import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededOffice, insertAgent, type Fixture } from '../helpers/office-fixture.js';

const seat = (seatId: string) => ({ kind: 'seat' as const, seatId });
const seatAll = (fixture: Fixture, seatIds: string[]): void => { for (const seatId of seatIds) fixture.office.org.assignAgent(seatId, insertAgent(fixture.db, `agent-${seatId}`)); };

test('a leader joins another department channel, talks with its members both ways, and leaves', () => {
  const fixture = createSeededOffice(); seatAll(fixture, ['ba-lead', 'dev-be', 'dev-lead']); const { org, messages, wake } = fixture.office;
  assert.throws(() => messages.post(seat('ba-lead'), 'dev', 'hi @dev-be'), /forbidden_channel/);
  org.joinChannel('ba-lead', 'dev');
  assert.ok(messages.channelsForSeat('ba-lead').some(channel => channel.id === 'dev'));
  const asked = messages.post(seat('ba-lead'), 'dev', '@dev-be what does the login API return?');
  assert.deepEqual(asked.mentions, ['dev-be']);
  assert.equal(wake.check('dev-be').wake, true);
  const answer = messages.post(seat('dev-be'), 'dev', '@ba-lead a JWT pair');
  assert.deepEqual(answer.mentions, ['ba-lead']);
  org.leaveChannel('ba-lead', 'dev');
  assert.throws(() => messages.post(seat('ba-lead'), 'dev', 'still here?'), /forbidden_channel/);
  fixture.close();
});

test('@all of a department reaches only its own seats; a visiting leader may not @all it', () => {
  const fixture = createSeededOffice(); const { org, messages } = fixture.office;
  org.joinChannel('ba-lead', 'dev');
  const all = messages.post(seat('dev-lead'), 'dev', '@all standup');
  assert.ok(!all.mentions.includes('ba-lead')); assert.ok(all.mentions.includes('dev-be'));
  assert.throws(() => messages.post(seat('ba-lead'), 'dev', '@all hello'), /mention_all_not_allowed/);
  fixture.close();
});

test('members cannot join other departments; a leader demoted to member loses the channels it joined', () => {
  const fixture = createSeededOffice(); const { org } = fixture.office;
  assert.throws(() => org.joinChannel('ba-docs', 'dev'), /join_channel_leaders_only/);
  assert.throws(() => org.joinChannel('ba-lead', 'leaders'), /only_department_channels_can_be_joined/);
  org.joinChannel('ba-lead', 'dev');
  org.updateSeat('ba-lead', { role: 'member' });
  assert.equal(org.isMember('dev', 'ba-lead'), false);
  fixture.close();
});

test('a coordinator that is not a leader may join and @all a department', () => {
  const fixture = createSeededOffice(); const { org, messages } = fixture.office;
  org.createDepartment({ id: 'pmo', name: 'PMO', color: '#64748b' });
  org.createSeat('pmo', { id: 'pm-live', title: 'PM', description: '', role: 'member', coordinator: true });
  org.joinChannel('pm-live', 'dev');
  assert.ok(messages.post(seat('pm-live'), 'dev', '@all please estimate your tasks').mentions.includes('dev-be'));
  fixture.close();
});
