import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { daemonCall, seatContext, type WhoAmI } from './hook-runner.js';
import { SessionStore } from './session-store.js';
import { agentGuide } from '../shared/agent-guide.js';
import { seatIdFromJoin } from '../shared/join.js';

// Claude Code passes its session id to MCP subprocesses; the hook stored that session's agent token on SessionStart.
const sessionId = process.env.AGENT_OFFICE_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID;
const store = new SessionStore();
const HINTS: Record<string, string> = {
  forbidden_channel: 'Members may only post in their department channel; leaders also in #leaders. For another department, ask your leader (or, as leader, ask that department\'s leader in #leaders).',
  assignee_outside_department: 'You can only assign tasks inside your own department. Ask the other department\'s leader in #leaders.',
  leader_only: 'Only your department leader can do this. Mention your leader in your department channel.',
  forbidden_task: 'Only the assignee or the department leader can change this task.',
  reopen_requires_leader: 'A done task can only be reopened by the leader.',
  seat_occupied: 'Another live session already holds this seat. Pick a vacant seat (see the Org view) or ask the manager to free it.',
  not_message_author: 'You can only edit or delete your own messages.',
  message_deleted: 'That message was already deleted.',
  requester_must_be_other_department_leader: 'requestedBy must be the seat id of the leader of another department (the one who asked in #leaders).',
  mention_all_not_allowed: '@all is reserved for the manager, leaders and deputies. Mention the specific seats you need, or ask your leader to address everyone.',
  seat_not_found: 'Unknown seat id. Use the seat id or join URL shown in the Agent Office Org view.',
};

const call = async (target: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> => {
  if (!sessionId) throw new Error('No Claude Code session id in environment (CLAUDE_CODE_SESSION_ID). Agent Office tools only work inside Claude Code.');
  const session = store.session(sessionId);
  if (!session) throw new Error('This session is not registered with Agent Office yet. Check that the Agent Office hooks are installed and the daemon is running (npm run connect).');
  try { return await daemonCall(fetch, session.daemonUrl, session.token, target, { timeoutMs: 10_000, ...init }); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    if (message.includes('not_seated')) throw new Error('Not seated yet: the manager must assign this session to a seat in the Agent Office Org view.');
    const hint = Object.entries(HINTS).find(([code]) => message.includes(`"${code}"`))?.[1];
    throw new Error(`Agent Office request failed: ${message}${hint ? `\nHint: ${hint}` : ''}`);
  }
};
type ThreadedMessage = { seq: number; senderKind: string; senderId: string; body: string; createdAt: number; editedAt?: number | null; deletedAt?: number | null; threadSeq?: number | null; replyCount?: number };
/** One line per message; thread replies are marked "↳ in thread [root]" and roots show their reply count. */
const formatMessage = (channelId: string, message: ThreadedMessage): string => {
  const where = message.threadSeq ? `#${channelId} [${message.seq}] ↳ in thread [${message.threadSeq}]` : `#${channelId} [${message.seq}]`;
  const replies = message.replyCount ? ` (${message.replyCount} repl${message.replyCount === 1 ? 'y' : 'ies'} — agent_office_read_thread seq=${message.seq})` : '';
  return `${where} ${message.senderKind === 'seat' ? `@${message.senderId}` : message.senderKind}: ${message.deletedAt ? '[deleted]' : `${message.body}${message.editedAt ? ' (edited)' : ''}`}${replies}`;
};
const text = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const id = z.string().min(1).max(128);

const server = new McpServer({ name: 'agent-office', version: '0.2.0' });

server.registerTool('agent_office_whoami', {
  title: 'Who am I', description: 'Show this session\'s Agent Office seat (title, department, role, specialty description) and its channels with unread counts.',
  inputSchema: z.object({}).strict(), annotations: readOnly,
}, async () => text(await call('/v1/me')));

server.registerTool('agent_office_guide', {
  title: 'Agent Office guide', description: 'Read this first: how Agent Office works — seats, channels, sending/reading/editing/deleting messages, @mentions and wake-ups, tasks.',
  inputSchema: z.object({}).strict(), annotations: readOnly,
}, async () => text(agentGuide((sessionId ? store.session(sessionId)?.daemonUrl : undefined) ?? store.connector()?.daemonUrl ?? 'http://127.0.0.1:8080')));

server.registerTool('agent_office_join', {
  title: 'Join seat', description: 'Claim an Agent Office seat (role) for this session using a join URL like http://127.0.0.1:8080/join/dev-be or a seat id. Refused if another live session holds it. Returns your role.',
  inputSchema: z.object({ seat: z.string().min(1).max(512) }).strict(), annotations: write,
}, async ({ seat }) => {
  const seatId = seatIdFromJoin(seat);
  await call(`/v1/seats/${encodeURIComponent(seatId)}/claim`, { body: {} });
  const me = await call('/v1/me') as WhoAmI;
  return text(`${seatContext(me)}\nYou joined @${seatId}. If you have not yet, read the rules with agent_office_guide. Check your channels with agent_office_read_channel, then end your turn to wait for work.`);
});

server.registerTool('agent_office_leave', {
  title: 'Leave seat', description: 'Release the seat this session holds so another session can join it.',
  inputSchema: z.object({}).strict(), annotations: write,
}, async () => text(await call('/v1/seats/leave', { body: {} })));

server.registerTool('agent_office_list_channels', {
  title: 'List channels', description: 'List the channels this seat belongs to with unread counts. Members see their department channel; leaders also see #leaders.',
  inputSchema: z.object({}).strict(), annotations: readOnly,
}, async () => text(await call('/v1/channels')));

server.registerTool('agent_office_read_channel', {
  title: 'Read channel', description: 'Read messages in a channel. Without "after" it returns unread messages (or the latest 20 when nothing is unread) and marks them read.',
  inputSchema: z.object({ channelId: id, after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(), annotations: readOnly,
}, async ({ channelId, after, limit }) => {
  const channels = (await call('/v1/channels') as { channels: Array<{ id: string; lastReadSeq: number; unread: number }> }).channels;
  const channel = channels.find(candidate => candidate.id === channelId);
  if (!channel) throw new Error(`You are not a member of #${channelId}. Your channels: ${channels.map(candidate => `#${candidate.id}`).join(', ')}`);
  const query = after !== undefined ? `after=${after}&limit=${limit}` : channel.unread > 0 ? `after=${channel.lastReadSeq}&limit=${limit}` : 'limit=20';
  const { messages } = await call(`/v1/channels/${encodeURIComponent(channelId)}/messages?${query}`) as { messages: ThreadedMessage[] };
  const last = messages.at(-1);
  if (last) await call(`/v1/channels/${encodeURIComponent(channelId)}/read`, { body: { seq: last.seq } });
  if (messages.length === 0) return text(`#${channelId}: no messages.`);
  return text(messages.map(message => formatMessage(channelId, message)).join('\n'));
});

server.registerTool('agent_office_send_message', {
  title: 'Send message', description: 'Post a message to a channel you belong to. Mention seats with @seat-id to notify them (mentions wake that seat). To answer a specific message or continue a discussion, pass threadSeq = the [seq] of the thread root: the reply goes into that thread (the root author is woken) instead of the main channel.',
  inputSchema: z.object({ channelId: id, body: z.string().min(1).max(16_384), threadSeq: z.number().int().min(1).optional() }).strict(), annotations: write,
}, async ({ channelId, body, threadSeq }) => text(await call(`/v1/channels/${encodeURIComponent(channelId)}/messages`, { body: { body, ...(threadSeq ? { threadSeq } : {}) } })));

server.registerTool('agent_office_read_thread', {
  title: 'Read thread', description: 'Read a whole thread: the root message [seq] and all its replies, oldest first.',
  inputSchema: z.object({ channelId: id, seq: z.number().int().min(1) }).strict(), annotations: readOnly,
}, async ({ channelId, seq }) => {
  const { root, replies } = await call(`/v1/channels/${encodeURIComponent(channelId)}/threads/${seq}`) as { root: ThreadedMessage; replies: ThreadedMessage[] };
  return text([formatMessage(channelId, root), ...replies.map(reply => formatMessage(channelId, reply))].join('\n') + `\n(${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}; answer with agent_office_send_message threadSeq=${seq})`);
});

server.registerTool('agent_office_edit_message', {
  title: 'Edit message', description: 'Edit one of your own messages, identified by channel and seq (shown as [seq] by read_channel). Mentions are re-parsed; seats that already received it are not woken again.',
  inputSchema: z.object({ channelId: id, seq: z.number().int().min(1), body: z.string().min(1).max(16_384) }).strict(), annotations: write,
}, async ({ channelId, seq, body }) => text(await call(`/v1/channels/${encodeURIComponent(channelId)}/messages/${seq}`, { method: 'PATCH', body: { body } })));

server.registerTool('agent_office_delete_message', {
  title: 'Delete message', description: 'Delete one of your own messages (channel + seq). It stays as a [deleted] placeholder and its mentions no longer wake anyone.',
  inputSchema: z.object({ channelId: id, seq: z.number().int().min(1) }).strict(), annotations: { ...write, destructiveHint: true },
}, async ({ channelId, seq }) => text(await call(`/v1/channels/${encodeURIComponent(channelId)}/messages/${seq}`, { method: 'DELETE' })));

server.registerTool('agent_office_wait_for_message', {
  title: 'Wait for message', description: 'Block until a mention of this seat arrives (including task changes that mention it) or the timeout passes. Returns the new items.',
  inputSchema: z.object({ timeoutSeconds: z.number().int().min(1).max(120).default(60) }).strict(), annotations: readOnly,
}, async ({ timeoutSeconds }) => {
  const result = await call(`/v1/wake?wait=${timeoutSeconds}`, { timeoutMs: (timeoutSeconds + 10) * 1000 }) as { wake: boolean; reason?: string };
  return text(result.wake ? result.reason ?? 'New items.' : 'No new messages for this seat.');
});

server.registerTool('agent_office_save_handoff', {
  title: 'Save handoff note', description: 'Overwrite your seat\'s handoff note: current goal, progress, decisions, next steps, where the work lives. The next session that takes your seat (restart, other machine, compaction) receives it automatically.',
  inputSchema: z.object({ body: z.string().min(1).max(8000) }).strict(), annotations: write,
}, async ({ body }) => {
  const me = await call('/v1/me') as WhoAmI;
  if (!me.seat) throw new Error('Not seated yet: join a seat first (agent_office_join).');
  await call(`/v1/seats/${encodeURIComponent(me.seat.id)}/handoff`, { method: 'PUT', body: { body } });
  return text(`Handoff note for @${me.seat.id} saved.`);
});

server.registerTool('agent_office_list_tasks', {
  title: 'List tasks', description: 'List tasks of your department (or "mine" for tasks assigned to you), optionally filtered by status. The PM (coordinator) sees every department, or one with departmentId. Each task shows estimateMinutes and dependsOn.',
  inputSchema: z.object({ status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(), mine: z.boolean().default(false), departmentId: id.optional() }).strict(), annotations: readOnly,
}, async ({ status, mine, departmentId }) => text(await call(`/v1/tasks?${new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { assignee: 'me' } : {}), ...(departmentId ? { departmentId } : {}) }).toString()}`)));

server.registerTool('agent_office_create_task', {
  title: 'Create task', description: 'Leaders (and the deputy): create a task in your department and assign it to one of your members (the assignee is woken). The PM (coordinator) may create in any department. Give estimateMinutes when you know it (otherwise the assignee must set it) and dependsOn = task ids (any department) that must be done first: the task cannot start before them and its assignee is told when they are done. For a request from another department set requestedBy to that leader\'s seat id: they are told automatically when the task is blocked or done.',
  inputSchema: z.object({ title: z.string().min(1).max(200), body: z.string().min(20).max(8000).describe('The requirement, shown to the manager: goal, inputs (file paths / task ids), expected output (where it is delivered), acceptance criteria.'), assigneeSeatId: id, requestedBy: id.optional(), estimateMinutes: z.number().int().min(1).max(10_080).optional(), dependsOn: z.array(z.string().min(1).max(80)).max(20).optional() }).strict(), annotations: write,
}, async input => text(await call('/v1/tasks', { body: input })));

server.registerTool('agent_office_update_task', {
  title: 'Update task', description: 'Move a task to todo/doing/blocked/done with an optional note, and/or set estimateMinutes (assignee: estimate every task you get, re-estimate when it changes). Leaders and the PM may also set dependsOn (task ids that must be done first; [] clears). A task cannot move to doing while a dependency is open. Assignee, department leader or the PM only. blocked/done notify the leader.',
  inputSchema: z.object({ taskId: id, status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(), note: z.string().max(2000).default(''), estimateMinutes: z.number().int().min(1).max(10_080).optional(), dependsOn: z.array(z.string().min(1).max(80)).max(20).optional() }).strict(), annotations: write,
}, async ({ taskId, ...patch }) => text(await call(`/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patch })));

/** Serves the agent_office_* tools over stdio for the Claude Code session that spawned this process. */
export const startMcpServer = (): void => { serveStdio(() => server, { onerror: error => process.stderr.write(`${error.message}\n`) }); };
