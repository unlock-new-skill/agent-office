import assert from 'node:assert/strict';
import test from 'node:test';
import { initialOfficeState, officeReducer, seatStatus, unreadFor } from '../../src/client/state/office-store.js';
import { splitMentions } from '../../src/client/state/mentions.js';
import { joinPrompt, joinUrl, seatIdFromJoin } from '../../src/shared/join.js';
import type { AgentSnapshot, ChatMessage, OrgView, Task } from '../../src/shared/contracts.js';

const org: OrgView = {
  departments: [{ id: 'dev', name: 'Dev', color: '#22c55e', sort: 0, paused: false, deputySeatId: null }],
  seats: [
    { id: 'dev-lead', departmentId: 'dev', title: 'Dev Lead', description: '', role: 'leader', sort: 0, agentId: 'cc-1', consecutiveWakes: 0, wakeState: 'listening', workMs: 0 },
    { id: 'dev-be', departmentId: 'dev', title: 'Dev BE', description: '', role: 'member', sort: 1, agentId: null, consecutiveWakes: 0, wakeState: 'idle', workMs: 0 },
  ],
  channels: [{ id: 'dev', name: 'dev', kind: 'department', departmentId: 'dev', memberSeatIds: ['dev-lead', 'dev-be'], lastSeq: 2 }],
};
const message = (seq: number, body = `m${seq}`): ChatMessage => ({ id: `id-${seq}`, channelId: 'dev', seq, senderKind: 'manager', senderId: 'manager', body, mentions: [], createdAt: seq });

test('history loads, live messages append in seq order and duplicates are ignored', () => {
  let state = officeReducer(initialOfficeState, { type: 'org', org });
  state = officeReducer(state, { type: 'history', channelId: 'dev', messages: [message(1), message(2)], mode: 'replace' });
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'message', message: message(4) } });
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'message', message: message(3) } });
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'message', message: message(3) } });
  assert.deepEqual(state.messages.dev?.map(item => item.seq), [1, 2, 3, 4]);
  assert.equal(state.org?.channels[0]?.lastSeq, 4, 'channel high-water follows live messages');
  state = officeReducer(state, { type: 'history', channelId: 'dev', messages: [message(0, 'older')], mode: 'prepend' });
  assert.equal(state.messages.dev?.[0]?.body, 'older');
});

test('org events replace org; snapshot loads org and agents; reset clears history', () => {
  const agents: AgentSnapshot[] = [{ id: 'cc-1', project: 'p', source: 'claude', sessionId: 's', sessionIncarnation: 's', state: 'working', contactState: 'connected', lastEventAt: null, currentTool: 'Bash', pendingInvocations: 1, pendingPermissions: 0 }];
  let state = officeReducer(initialOfficeState, { type: 'snapshot', snapshot: { generation: 'g', seq: 1, agents, org } });
  assert.equal(state.agents.length, 1); assert.equal(state.org?.seats.length, 2);
  state = officeReducer(state, { type: 'history', channelId: 'dev', messages: [message(1)], mode: 'replace' });
  const paused = { ...org, departments: [{ ...org.departments[0]!, paused: true }] };
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'org', org: paused } });
  assert.equal(state.org?.departments[0]?.paused, true);
  state = officeReducer(state, { type: 'reset' });
  assert.deepEqual(state.messages, {});
});

test('task events upsert tasks by id', () => {
  const task: Task = { id: 't-dev-1', departmentId: 'dev', number: 1, assigneeSeatId: 'dev-be', requesterSeatId: null, createdByKind: 'manager', createdById: 'manager', title: 'A', body: '', status: 'todo', createdAt: 1, updatedAt: 1, estimateMinutes: null, dependsOn: [] };
  let state = officeReducer(initialOfficeState, { type: 'tasks', tasks: [task] });
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'task', task: { ...task, status: 'done' } } });
  assert.equal(Object.keys(state.tasks).length, 1); assert.equal(state.tasks['t-dev-1']?.status, 'done');
});

test('unread counts use the client read cursor', () => {
  let state = officeReducer(initialOfficeState, { type: 'org', org });
  assert.equal(unreadFor(state, 'dev'), 2);
  state = officeReducer(state, { type: 'read', channelId: 'dev', seq: 2 });
  assert.equal(unreadFor(state, 'dev'), 0);
});

test('seat status combines binding, telemetry and wake state', () => {
  const agent = (overrides: Partial<AgentSnapshot>): AgentSnapshot => ({ id: 'cc-1', project: 'p', source: 'claude', sessionId: 's', sessionIncarnation: 's', state: 'idle', contactState: 'connected', lastEventAt: null, currentTool: null, pendingInvocations: 0, pendingPermissions: 0, ...overrides });
  const lead = org.seats[0]!;
  assert.equal(seatStatus(org.seats[1]!, []), 'vacant');
  assert.equal(seatStatus(lead, [agent({ contactState: 'exited' })]), 'offline');
  assert.equal(seatStatus(lead, [agent({ state: 'working' })]), 'working');
  assert.equal(seatStatus(lead, [agent({ state: 'blocked' })]), 'blocked');
  assert.equal(seatStatus(lead, [agent({ state: 'idle' })]), 'listening');
  assert.equal(seatStatus({ ...lead, wakeState: 'wake_limited' }, [agent({ state: 'idle' })]), 'wake_limited');
  assert.equal(seatStatus({ ...lead, wakeState: 'idle' }, [agent({ state: 'idle' })]), 'idle');
});

test('mentions split into text and mention segments for known seats only', () => {
  assert.deepEqual(splitMentions('hi @dev-be and @ghost, email a@b.c', ['dev-be']), [
    { text: 'hi ' }, { text: '@dev-be', mention: 'dev-be' }, { text: ' and @ghost, email a@b.c' },
  ]);
});

test('join links and prompts point at the seat', () => {
  assert.equal(joinUrl('http://127.0.0.1:8080', 'dev-be'), 'http://127.0.0.1:8080/join/dev-be');
  assert.match(joinPrompt('http://127.0.0.1:8080', { id: 'dev-be', title: 'Dev BE' }), /agent_office_join.*\/join\/dev-be/);
  assert.equal(seatIdFromJoin('http://127.0.0.1:8080/join/dev-be'), 'dev-be');
  assert.equal(seatIdFromJoin('dev-be'), 'dev-be');
  assert.equal(seatIdFromJoin('  @dev-be '), 'dev-be');
});

test('thread replies update only their open thread; root updates refresh the timeline and the thread', async () => {
  const { officeReducer, initialOfficeState, threadKey } = await import('../../src/client/state/office-store.js');
  const message = (seq: number, extra: Partial<import('../../src/shared/contracts.js').ChatMessage> = {}) => ({ id: `m${seq}`, channelId: 'dev', seq, senderKind: 'manager' as const, senderId: 'manager', body: `b${seq}`, mentions: [], createdAt: seq, ...extra });
  let state = officeReducer(initialOfficeState, { type: 'history', channelId: 'dev', messages: [message(1)], mode: 'replace' });
  state = officeReducer(state, { type: 'thread', channelId: 'dev', root: message(1), replies: [] });
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'message', message: message(2, { threadSeq: 1 }) } });
  state = officeReducer(state, { type: 'collab', event: { type: 'collab', kind: 'message', message: message(1, { replyCount: 1 }) } });
  assert.deepEqual(state.messages.dev?.map(item => item.seq), [1], 'reply stays out of the timeline');
  assert.equal(state.messages.dev?.[0]?.replyCount, 1);
  assert.deepEqual(state.threads[threadKey('dev', 1)]?.replies.map(item => item.seq), [2]);
  assert.equal(state.threads[threadKey('dev', 1)]?.root.replyCount, 1);
});

test('@all and @everyone are highlighted as mentions', async () => {
  const { splitMentions } = await import('../../src/client/state/mentions.js');
  assert.deepEqual(splitMentions('hi @all and @everyone', []).filter(segment => segment.mention).map(segment => segment.mention), ['all', 'everyone']);
});
