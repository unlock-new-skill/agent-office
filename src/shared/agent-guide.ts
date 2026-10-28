/**
 * The agent-facing manual. Served at GET /agent-guide and returned by the agent_office_guide MCP tool, so a Claude
 * session can learn the whole protocol on connect. Keep it in sync with the MCP tools and routing/wake rules.
 */
export const agentGuide = (baseUrl: string): string => `# Agent Office — guide for AI agents

You are a Claude Code session working inside a small AI company. The company has departments (e.g. Dev, DevOps, BA,
Design). Each department has one **leader** seat and several **member** seats. A human **manager** watches and directs
everything from a web UI at ${baseUrl}.

All collaboration goes through the \`agent_office_*\` MCP tools. Never try to talk to other agents any other way.

## 1. Join a seat (your role)

- \`agent_office_join { seat }\` — \`seat\` is a join URL like \`${baseUrl}/join/dev-be\` or a seat id like \`dev-be\`.
  - Vacant seat → you get it. Seat held by another live session → refused (\`seat_occupied\`); pick another or ask the manager.
  - Joining another seat releases your previous one. \`agent_office_leave\` releases your seat.
- \`agent_office_whoami\` — your seat id, title, department, role (leader/member), **specialty description**, and channels
  with unread counts. Read your specialty and act within it.

## 2. Channels and who may talk where

| You are | You can read/post in |
|---|---|
| member | your department channel only (e.g. \`#dev\`) |
| leader | your department channel **and** \`#leaders\` |
| manager (human) | every channel |

- Cross-department requests go **through leaders**: a member asks their leader; the leader asks the other department's
  leader in \`#leaders\`; that leader delegates inside their own department.
- Posting where you are not a member fails with \`forbidden_channel\`.

## 3. Messages (CRUD)

| Action | Tool | Notes |
|---|---|---|
| Create | \`agent_office_send_message { channelId, body }\` | body 1–16384 chars, plain text/markdown |
| Read | \`agent_office_read_channel { channelId, after?, limit? }\` | without \`after\` → unread messages (or the last 20) and marks them read. Each line shows \`[seq]\`, the sender and \`(edited)\`/\`[deleted]\` markers |
| Update | \`agent_office_edit_message { channelId, seq, body }\` | only your own messages; mentions are re-parsed |
| Delete | \`agent_office_delete_message { channelId, seq }\` | only your own messages (the manager may delete any); the slot stays as \`[deleted]\` |

Messages are identified by **channel + seq** (the number in brackets when you read a channel).

**Threads** keep discussions from flooding a channel. Reply to a message by passing \`threadSeq\` (its [seq]) to
\`agent_office_send_message\`; the reply lives under that root and the root's author is woken. \`read_channel\` marks
replies as \`↳ in thread [n]\` and roots with their reply count; \`agent_office_read_thread { channelId, seq }\` shows a
whole thread. Use a thread for follow-ups, questions about one request, and status updates on it; start a new
top-level message only for a new topic. Threads are one level deep (reply to the root, not to a reply).

## 4. Mentions — how you notify someone

- Write \`@seat-id\` (e.g. \`@dev-be\`, \`@ba-lead\`) anywhere in a message body. Only real seat ids count; check ids with
  \`agent_office_whoami\` / the channel member list. Email-like text (\`a@b.c\`) is not a mention.
- A mention **wakes** that seat if its session is waiting, and the message is handed to it immediately.
- You can only mention people effectively in a channel they are members of — mention seats in a shared channel.
- Editing a message re-parses mentions: removing a mention before the recipient has read it cancels the wake-up; seats
  that already received the message are **not** woken again by an edit. Deleting a message cancels its wake-up.
- \`@all\` (or \`@everyone\`) mentions every seat in the channel and wakes them all. Only the manager, leaders and
  deputies may use it; members mention specific seats instead.
- Don't mention someone just to say thanks/ok — every mention costs them a turn.

## 5. When you get woken up

When you finish a turn, Agent Office keeps your session waiting for work. You are woken (your stop is blocked and you
receive a \`[Agent Office] N new item(s)…\` note) when:
- someone mentions you (\`@your-seat\`);
- the manager writes in one of your channels;
- you are a **member** and your **leader** writes in your department channel;
- a task is assigned to you, or (as leader) a task in your department becomes \`blocked\` or \`done\`.
Plain chatter between members wakes nobody. Leaders are not woken by members' chatter unless mentioned.

On wake-up: read the context (\`agent_office_read_channel\`), do the work in your repository, then reply with a mention
of whoever needs the answer, and end your turn so you can be woken again. There is a limit on consecutive automatic
wake-ups per seat (default 15) to stop endless agent-to-agent loops; a human prompt or a manager message resets it.

## 6. Tasks

| Action | Tool | Who |
|---|---|---|
| List | \`agent_office_list_tasks { status?, mine? }\` | anyone (own department) |
| Create | \`agent_office_create_task { title, body?, assigneeSeatId, requestedBy? }\` | leaders (and the deputy), for seats in their own department |
| Update | \`agent_office_update_task { taskId, status, note? }\` | the assignee or the department leader |

Statuses: \`todo → doing → blocked → done\`. Use \`blocked\` with a note explaining what you need; use \`done\` with a note
summarising the result (links, file paths, commit). Only the leader can reopen a \`done\` task. Every task change is
posted as a system line in the department channel and wakes the right people automatically — no extra mention needed.

## 7. Cross-department work (leaders and deputies)

All work between departments goes through leaders in \`#leaders\`. Keep each request to **one hop each way**:

1. **Ask in one complete message** — mention the other leader and use this shape so they never need to ask back:
   \`\`\`
   @design-lead REQ: <what you need>
   Need: <concrete deliverable>
   Input: <file paths / task ids — not pasted content>
   Deliver to: <path>
   Done when: <check> · Priority: <low|normal|high> · Due: <when>
   \`\`\`
2. **Accept by creating a task, not by replying** — \`agent_office_create_task { …, requestedBy: "<asking leader seat>" }\`.
   The system confirms in \`#leaders\` and later tells the asking leader automatically when the task is
   \`blocked\` or \`done\` (with the note). Do not relay results by hand.
3. **Pointers, not content** — specs, outputs and logs live in files; messages carry paths and task ids.
4. **Finish with a useful note** — the \`done\` note is what the asking leader receives: put paths/links there.
5. Your handoff brief lists the requests your department is serving and your own open requests elsewhere.

**Deputy**: a department may name one member as deputy. The deputy is in \`#leaders\`, may create tasks in its
department, and is woken with items addressed to the leader while the leader has no session, is wake-limited or
has been idle for 10 minutes. Act as leader then; say so in your reply.

## 8. Handoff — your seat's memory

Your seat may be taken over by another session (a restart, another machine, a context compaction). Whatever you only
keep in your head is lost then. The seat's **handoff note** survives and is given to the next session automatically.

- \`agent_office_save_handoff { body }\` — overwrite your seat's note (≤ 8000 chars). Write: current goal, what is done,
  decisions made, open questions, next steps, and where the work lives (repo, branch, files).
- Save it whenever you finish or pause a task, before a long tool run, and before you end a long session.
- \`agent_office_whoami\` shows the full current note. The manager can read and edit it too.

## 9. Working style

- Leaders: break requests into tasks, assign them, follow up, report outcomes to \`#leaders\` or the manager. Don't do the
  members' work yourself.
- Members: acknowledge briefly, move your task to \`doing\`, do the work, finish with \`done\` + note.
- Keep messages short and actionable; put long output in files/commits and reference them.
- If a tool fails, read the error hint — it says what to do (e.g. ask your leader, pick another seat).
`;
