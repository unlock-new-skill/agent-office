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
  forbidden_channel: 'Members may only post in their department channel; leaders also in #leaders. Leaders and coordinators can join another department\'s channel with agent_office_join_channel; members ask their leader.',
  assignee_outside_department: 'You can only assign tasks inside your own department. Ask the other department\'s leader in #leaders.',
  leader_only: 'Only your department leader can do this. Mention your leader in your department channel.',
  forbidden_task_read: 'You cannot see this task: it belongs to another department. Ask that department\'s leader in #leaders, or ask the manager to mark your seat as coordinator.',
  forbidden_task_change: 'Only the assignee, the department leader (or deputy), the lead of the parent task or a coordinator can change this task.',
  stale_revision: 'Someone changed this task after you read it. The current task is in the error: re-read it, then retry with its revision as expectedRevision.',
  reassign_doing_requires_handoff: 'The task is in progress. Pass handoffNote (what is done, what is left, where the work is) to hand it over; it goes back to todo for the new assignee.',
  readiness_changed: 'The task is no longer ready under that offer (a dependency, result or blocker changed). Read it with agent_office_get_task: readiness lists what is missing.',
  already_started: 'Someone already started this task.',
  forbidden_blocker: 'Only the resolver, the leader of an affected task, a coordinator or the manager can change this blocker.',
  start_by_assignee_only: 'Only the task\'s assignee starts it. Leaders reassign it first if someone else should do it.',
  join_channel_leaders_only: 'Only leaders and coordinators can join another department\'s channel. Ask your leader.',
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

server.registerTool('agent_office_join_channel', {
  title: 'Join department channel', description: 'Leaders and coordinators (PM): join another department\'s channel (channelId = department id, e.g. "dev") to talk with its members directly. You can then read and post there, mention its members and be mentioned; its @all still reaches only that department\'s own seats. Leave with agent_office_leave_channel.',
  inputSchema: z.object({ channelId: id }).strict(), annotations: write,
}, async ({ channelId }) => text(await call(`/v1/channels/${encodeURIComponent(channelId)}/join`, { method: 'POST', body: {} })));

server.registerTool('agent_office_leave_channel', {
  title: 'Leave department channel', description: 'Leave a department channel you joined with agent_office_join_channel (your own department channel cannot be left).',
  inputSchema: z.object({ channelId: id }).strict(), annotations: write,
}, async ({ channelId }) => text(await call(`/v1/channels/${encodeURIComponent(channelId)}/leave`, { method: 'POST', body: {} })));

server.registerTool('agent_office_list_channels', {
  title: 'List channels', description: 'List the channels this seat belongs to with unread counts. Members see their department channel; leaders also see #leaders and the department channels they joined.',
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
  title: 'Send message', description: 'Post a message to a channel you belong to, or into a thread you were invited to. Mention seats with @seat-id to notify them (mentions wake that seat). Inside a thread you may mention any seat of the office: a seat outside the channel is invited into that thread only. To answer a specific message or continue a discussion, pass threadSeq = the [seq] of the thread root: the reply goes into that thread (the root author is woken) instead of the main channel.',
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
  title: 'List tasks', description: 'List tasks of your department (or "mine" for tasks assigned to you), optionally filtered by status. Coordinators (the PM) see every department, or one with departmentId. Each task shows estimateMinutes, dependsOn, kind and revision.',
  inputSchema: z.object({ status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(), mine: z.boolean().default(false), departmentId: id.optional() }).strict(), annotations: readOnly,
}, async ({ status, mine, departmentId }) => text(await call(`/v1/tasks?${new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { assignee: 'me' } : {}), ...(departmentId ? { departmentId } : {}) }).toString()}`)));

server.registerTool('agent_office_task_thread', {
  title: 'Task thread', description: 'Open the discussion thread of a task (created if missing): returns its channelId and seq and shows the thread. Chat about the task there with agent_office_send_message { channelId, threadSeq: seq }; mention any seat of the office to bring it into the discussion. Works for tasks of your department, tasks you lead, and the parent task of a step you were given.',
  inputSchema: z.object({ taskId: id }).strict(), annotations: write,
}, async ({ taskId }) => {
  const { channelId, seq } = await call(`/v1/tasks/${encodeURIComponent(taskId)}/thread`, { method: 'POST', body: {} }) as { channelId: string; seq: number };
  const { root, replies } = await call(`/v1/channels/${encodeURIComponent(channelId)}/threads/${seq}`) as { root: ThreadedMessage; replies: ThreadedMessage[] };
  return text([`Task ${taskId} thread: channelId=${channelId} seq=${seq}`, formatMessage(channelId, root), ...replies.map(reply => formatMessage(channelId, reply))].join('\n') + `\n(answer with agent_office_send_message channelId=${channelId} threadSeq=${seq})`);
});

server.registerTool('agent_office_create_task', {
  title: 'Create task', description: 'Leaders (and the deputy): create a task in your department and assign it to one of your members (the assignee is woken). The PM (coordinator) may create in any department. Give estimateMinutes when you know it (otherwise the assignee must set it) and dependsOn = task ids (any department) that must be done first: the task cannot start before them and its assignee is told when they are done. For a request from another department set requestedBy to that leader\'s seat id: they are told automatically when the task is blocked or done. Steps: to split a task across people (any department), pass parentId = the task you lead (you are its assignee; the PM may too) and one call per step in order — each step waits for the previous one unless parallel=true, its assignee is woken and joins the parent task\'s thread, and you are told in that thread when a step is blocked or done (then close the parent with the final output).',
  inputSchema: z.object({ title: z.string().min(1).max(200), body: z.string().min(20).max(8000).describe('The requirement, shown to the manager: goal, inputs (file paths / task ids), expected output (where it is delivered), acceptance criteria.'), assigneeSeatId: id, requestedBy: id.optional(), parentId: z.string().min(1).max(80).optional().describe('Make this a step of that task (one level). Assignee may be in any department.'), parallel: z.boolean().optional().describe('Step starts now instead of waiting for the previous step.'), estimateMinutes: z.number().int().min(1).max(10_080).optional(), dependsOn: z.array(z.string().min(1).max(80)).max(20).optional(), passRequired: z.array(z.string().min(1).max(80)).max(20).optional().describe('Dependencies that need result pass, not only done.'), kind: z.enum(['execution', 'tracking']).optional().describe('execution = one person\'s work, estimate at most 240 minutes to start; tracking = umbrella followed apart, never started as work.') }).strict(), annotations: write,
}, async input => text(await call('/v1/tasks', { body: input })));

server.registerTool('agent_office_update_task', {
  title: 'Update task', description: 'Edit an existing task in place (never create a copy to change it). Fields you leave out keep their value. Assignee: move status todo/doing/blocked/done with a note and set estimateMinutes (estimate every task you get). Leaders, the deputy, the lead of the parent task and coordinators (PM) also set assigneeSeatId (null = unassign), title, body, kind and dependsOn ([] clears). Pass expectedRevision (the task\'s revision from list/get) so a stale edit is refused instead of overwriting someone else. A task in progress changes assignee only with handoffNote. doing is refused while a dependency is open, and for kind=execution without an estimate of at most 240 minutes. blocked/done notify the leader. The done note is copied to #outputs: write the real output (deliverables, paths, links, commit), not just "done".',
  inputSchema: z.object({ taskId: id, status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(), note: z.string().max(2000).default(''), estimateMinutes: z.number().int().min(1).max(10_080).nullable().optional(), dependsOn: z.array(z.string().min(1).max(80)).max(20).optional(),
    assigneeSeatId: id.nullable().optional(), title: z.string().min(1).max(200).optional(), body: z.string().max(8000).optional(), kind: z.enum(['execution', 'tracking']).optional(),
    passRequired: z.array(z.string().min(1).max(80)).max(20).optional().describe('Dependencies (subset of dependsOn) that must be done AND have result pass; the others only need done.'),
    result: z.enum(['not-applicable', 'pass', 'fail', 'inconclusive', 'unknown']).optional().describe('Verified outcome, separate from done: a test that ran and failed is done with result fail.'),
    expectedRevision: z.number().int().min(0).optional(), reason: z.string().max(2000).optional().describe('Why the task was edited; kept in the task audit.'), handoffNote: z.string().max(2000).optional().describe('Required to reassign a task in progress: what is done, what is left, where the work is.') }).strict(), annotations: write,
}, async ({ taskId, ...patch }) => text(await call(`/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patch })));

server.registerTool('agent_office_start_task', {
  title: 'Start task', description: 'Assignee: START a ready execution task (the server re-checks owner, estimate <= 240m, dependencies with their pass/completed condition, open blockers and that you are not doing another execution task, then claims it atomically). Pass the generation from the "ready to start" notice: if readiness changed since, START is refused with the reason. Starting is not a permission to deploy, log in, restore or touch real data.',
  inputSchema: z.object({ taskId: id, generation: z.number().int().min(0).optional(), expectedRevision: z.number().int().min(0).optional() }).strict(), annotations: write,
}, async ({ taskId, ...input }) => text(await call(`/v1/tasks/${encodeURIComponent(taskId)}/start`, { method: 'POST', body: input })));

server.registerTool('agent_office_board', {
  title: 'Board by blocker', description: 'Tasks grouped by root cause: needsAction (defect, permission, input, environment, decision, missing owner/estimate/classification, a result to confirm) and waiting (dependencies only), then ready, doing, done and tracking, with resolver, next step, due date and the affected task ids per group. Totals count each task once. Coordinators see every department (filter with departmentId); others their own. Filter by assignee or resolver (seat id).',
  inputSchema: z.object({ departmentId: id.optional(), assignee: id.optional(), resolver: id.optional() }).strict(), annotations: readOnly,
}, async filter => text(await call(`/v1/board?${new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined) as Array<[string, string]>).toString()}`)));

server.registerTool('agent_office_blocker', {
  title: 'Blocker', description: 'Structured blockers shared by every task they stop (link by id, never duplicate a cause). action=open { kind, description (one sentence: what is missing), taskIds, resolverSeatId or resolverRole, nextStep (action + evidence needed to close), dueAt? (only a real commitment), originTaskId?, refs? (thread/evidence references) }; update { blockerId, fields }; link { blockerId, taskIds }; unlink { blockerId, taskId }; resolve { blockerId, text = evidence or reason }; reopen { blockerId, text = why (e.g. grant revoked) }; list { status?, taskId? }. Kinds: dependency (waiting only), missing-input, permission, environment, defect, owner-missing, decision. Never put secrets, tokens or raw logs in a blocker.',
  inputSchema: z.object({ action: z.enum(['open', 'update', 'link', 'unlink', 'resolve', 'reopen', 'list']), blockerId: z.string().min(1).max(40).optional(),
    kind: z.enum(['dependency', 'missing-input', 'permission', 'environment', 'defect', 'owner-missing', 'decision']).optional(), description: z.string().min(1).max(500).optional(),
    taskIds: z.array(z.string().min(1).max(80)).max(50).optional(), taskId: z.string().min(1).max(80).optional(), resolverSeatId: id.nullable().optional(), resolverRole: z.string().max(80).nullable().optional(),
    nextStep: z.string().max(1000).optional(), dueAt: z.number().int().positive().nullable().optional(), originTaskId: z.string().max(80).optional(), refs: z.array(z.string().min(1).max(300)).max(10).optional(),
    text: z.string().max(1000).optional(), status: z.enum(['open', 'resolved']).optional() }).strict(), annotations: write,
}, async ({ action, blockerId, text: reason, taskId, status, kind, taskIds, ...fields }) => {
  const path = (suffix = ''): string => { if (!blockerId) throw new Error('blockerId is required for this action'); return `/v1/blockers/${encodeURIComponent(blockerId)}${suffix}`; };
  const clean = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  if (action === 'list') return text(await call(`/v1/blockers?${new URLSearchParams(clean({ status, taskId }) as Record<string, string>).toString()}`));
  if (action === 'open') return text(await call('/v1/blockers', { body: clean({ kind, taskIds, ...fields }) }));
  if (action === 'update') return text(await call(path(), { method: 'PATCH', body: clean(fields) }));
  if (action === 'link') return text(await call(path('/link'), { body: { taskIds } }));
  if (action === 'unlink') return text(await call(path('/unlink'), { body: { taskId } }));
  return text(await call(path(action === 'resolve' ? '/resolve' : '/reopen'), { body: action === 'resolve' ? { resolution: reason ?? '' } : { reason: reason ?? '' } }));
});

server.registerTool('agent_office_get_task', {
  title: 'Get task', description: 'One task with its status history, field audit (who changed what, before/after, from UI or MCP), readiness (state + reasons + generation) and blockers. Use its revision as expectedRevision when you edit it.',
  inputSchema: z.object({ taskId: id }).strict(), annotations: readOnly,
}, async ({ taskId }) => text(await call(`/v1/tasks/${encodeURIComponent(taskId)}`)));

/** Serves the agent_office_* tools over stdio for the Claude Code session that spawned this process. */
export const startMcpServer = (): void => { serveStdio(() => server, { onerror: error => process.stderr.write(`${error.message}\n`) }); };
