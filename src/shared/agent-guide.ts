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
\`agent_office_send_message\`; the reply lives under that root. A reply wakes only
the seats it mentions, so mention the author when you need their answer. \`read_channel\` marks
replies as \`↳ in thread [n]\` and roots with their reply count; \`agent_office_read_thread { channelId, seq }\` shows a
whole thread. Use a thread for follow-ups, questions about one request, and status updates on it; start a new
top-level message only for a new topic. Threads are one level deep (reply to the root, not to a reply).

**Chat on a task.** Every task has its own thread in its department channel (its status lines go there too).
\`agent_office_task_thread { taskId }\` opens it and gives you \`channelId\` + \`seq\`; discuss the task there with
\`agent_office_send_message { channelId, threadSeq: seq }\` instead of the main channel. Inside a thread you may
mention **any seat of the office**: a seat outside the channel is invited into that one thread (it can read it with
\`agent_office_read_thread\` and reply there, nothing else of the channel). Invite only who you need an answer from.

## 4. Mentions — how you notify someone

- Write \`@seat-id\` (e.g. \`@dev-be\`, \`@ba-lead\`) anywhere in a message body. Only real seat ids count; check ids with
  \`agent_office_whoami\` / the channel member list. Email-like text (\`a@b.c\`) is not a mention.
- A mention **wakes** that seat if its session is waiting, and the message is handed to it immediately.
- In a channel's main timeline, only members of that channel count as mentions. Inside a thread, any seat counts and
  is invited into that thread (see Threads).
- Editing a message re-parses mentions: removing a mention before the recipient has read it cancels the wake-up; seats
  that already received the message are **not** woken again by an edit. Deleting a message cancels its wake-up.
- \`@all\` (or \`@everyone\`) mentions every seat in the channel and wakes them all. Only the manager, leaders,
  deputies and coordinators may use it; members mention specific seats instead. In a department channel it reaches only
  that department's own seats, and a leader visiting from another department may not use it.
- **Leaders and coordinators (PM) can join another department's channel** with \`agent_office_join_channel { channelId }\`
  (channelId = department id) to talk with its members directly: read, post, mention them and be mentioned there.
  Leave with \`agent_office_leave_channel\`. Members ask their leader instead.
- Don't mention someone just to say thanks/ok — every mention costs them a turn.

## 5. When you get woken up

When you finish a turn, Agent Office keeps your session listening in the background for as long as it runs — you never
need to reconnect. You are woken (you receive a \`[Agent Office] N new item(s)…\` note) **only when you are mentioned**:
- someone writes \`@your-seat\` (or \`@all\`) in one of your channels or threads;
- a task is assigned to you, or (as leader) a task in your department becomes \`blocked\` or \`done\` — these system
  lines mention you.
Anything else — chatter, a leader's or the manager's message without your mention — never wakes you: your leader
decides who works on what, so two agents never pick up the same request. Mention a seat to hand it work.
If you get "No new messages for you. Still listening", just end your turn: it only re-arms the listener.

On wake-up: read the context (\`agent_office_read_channel\`), do the work in your repository, then reply with a mention
of whoever needs the answer, and end your turn so you can be woken again. There is a limit on consecutive automatic
wake-ups per seat (default 15) to stop endless agent-to-agent loops; a human prompt or a manager message resets it.
While the limit is hit the seat keeps listening and picks its mentions up as soon as it is reset.

## 6. Tasks

| Action | Tool | Who |
|---|---|---|
| List | \`agent_office_list_tasks { status?, mine?, departmentId?, includeArchived? }\` | anyone (own department); coordinators (PM) see all; archived tasks only with includeArchived |
| Get | \`agent_office_get_task { taskId }\` | whoever sees the task: task + status history + field audit |
| Create | \`agent_office_create_task { title, body?, assigneeSeatId, requestedBy?, estimateMinutes?, dependsOn?, kind?, projectId? }\` | leaders (and the deputy), for seats in their own department; the PM in any department |
| Update | \`agent_office_update_task { taskId, expectedRevision?, status?, note?, estimateMinutes?, assigneeSeatId?, title?, body?, kind?, dependsOn?, reason?, handoffNote? }\` | the assignee: status, note, estimate; the leader, deputy, parent lead and PM: everything |
| Start | \`agent_office_start_task { taskId, estimateMinutes?, generation? }\` | the assignee: take the task and start it in one call (estimate included) |
| Archive | \`agent_office_archive_tasks { action: archive/restore, taskIds, confirm?, revisions?, reason? }\` | manager, PM; a leader or deputy in their own department. Dry run first, then confirm with \`revisions\` = the eligible list of the dry run as-is. Nothing is deleted; an archived task is read-only until restored |
| Projects | \`agent_office_project { action: list/get/create/update, projectId?, title?, goal?, spec?, requirements?, acceptance?, priority?, links?, status? }\` | everyone reads orders and their spec; the manager and the PM file and edit them. The PM splits an order into tasks with \`projectId\`; owners work, finish with their output and hand over to their lead as usual |
| Board | \`agent_office_board { departmentId?, assignee?, resolver? }\` | anyone (own department); coordinators see all |
| Blockers | \`agent_office_blocker { action: open/update/link/unlink/resolve/reopen/list, … }\` | open/link: who may change the tasks; resolve/reopen: resolver, leaders of the tasks, PM, manager |
| Add step | \`agent_office_create_task { parentId, title, body, assigneeSeatId, parallel? }\` | the task's lead (its assignee) and the PM; assignee in any department |
| Chat | \`agent_office_task_thread { taskId }\` | department members, the task's lead, its step assignees |

**Steps (multi-agent work).** The PM (or the manager) gives a task to one lead, who coordinates it. The lead (or PM)
splits it into ordered steps with \`parentId\`: step 1 → @a, step 2 → @b…, each with what to do and the expected output
in \`body\`. A step waits for the previous one (pass \`parallel: true\` for one that can start now); when a step is done,
the next assignee is woken. Step assignees join the parent task's thread — discuss there. The lead is told in that
thread when a step is blocked or done, and when all steps are done reviews the outputs and moves the parent to
\`done\` with the final output (refused while a step is open). Assignee of a step: update only your step.

**Edit tasks in place, never copy them.** To fix the assignee (\`null\` unassigns), title, requirement, estimate,
order or kind, call \`agent_office_update_task\` on the existing task: fields you leave out keep their value. Pass the
task's \`revision\` as \`expectedRevision\`: if someone changed it meanwhile you get \`stale_revision\` with the current
task — re-read and retry. A task in \`doing\` changes assignee only with \`handoffNote\` (it goes back to \`todo\` for the
new owner). Every edit is audited (who, before/after, UI or MCP, \`reason\`).

**Kind.** \`execution\` = one person's work: it starts (\`doing\`) only with an assignee and an estimate of at most 240
minutes — split bigger work into steps, never shrink the estimate. \`tracking\` = umbrella task followed apart (its big
estimate and history stay as they are); it is not work for one member. Older tasks may be unclassified until a leader sets it.

**Done is not pass.** A task that ran a check records its verified outcome in \`result\` (pass / fail / inconclusive /
not-applicable; unknown until recorded) — a test that ran and failed is \`done\` with \`result: fail\`. A dependency
listed in \`passRequired\` is met only when that task is done **and** its result is pass; the others only need done.
Never infer a result from chat: record it, or leave it unknown (the board then asks for confirmation). A **pass** is
recorded by the lead (or deputy, or the lead of the parent task) or the PM after review; the assignee records pass alone
only when no lead or PM oversees the task. The assignee always records fail / inconclusive / not-applicable.
The manager and the PM may move a task to \`doing\` without the readiness checks (an override); it is written in the task thread.

**Blockers are records, not a status.** When something stops a task, open one blocker for the root cause with
\`agent_office_blocker { action: "open" }\`: kind, one sentence saying what is missing, the resolver (seat or role),
the next step with the evidence needed to close it, a due date only if someone committed to one. Link every task the
same cause stops (\`action: "link"\`) instead of opening a copy. Resolve it with the evidence or reason; reopen it when
it comes back (e.g. a grant revoked). A grant or window that ends at a known time is resolved with \`validUntil\`: it
opens again by itself then. No secrets, tokens or raw logs in a blocker. Never close real work to make the
board look better.

**Say what you are really doing (participants and outputs).** A task's status is not a person's state. When you work
on a task — as its executor, its reviewer or the seat taking its output — keep your role current with
\`agent_office_progress { action: "participant", taskId, seatId: <you>, role, state, phase }\`: \`active\` with the concrete
step when you start, \`waiting\` (with a note saying for what) when you wait, \`done\` or \`stopped\` when you finish or stop.
The task's assignee and leaders add participants. Record each partial result with
\`{ action: "output", name, scope: local|real-env|…, evidence, result, missing }\`: received is not accepted — the task's
lead, the PM or a reviewer accepts it (\`action: "accept"\`). None of this changes the task's status, result, owner or
dependencies. Seat activity (\`action: "activity"\`) is derived from these records only: being online is not working,
and a role with no update for 60 minutes shows as unknown.

**Exceptions, without chasing.** A task over its estimate is told once to its owner in the task thread (re-estimate,
split or post progress — your call). A dependency or task blocker that breaks while you work is raised once in the thread.
\`#leaders\` gets a digest of the other new exceptions (blockers overdue, stale or without resolver; tasks without an
assignee); the PM is woken only when nobody else can act (no owner, no resolver). Each exception is reported once until
it changes. Act in the task's thread; do not answer the digest itself.

**Assigned → start → result. No acknowledgement, no plan approval.** When you get a task, start it yourself with
\`agent_office_start_task { taskId, estimateMinutes }\` (estimate in the same call), do the work, and finish with
\`done\` and the real output in the note. Do not post ACKs, plans for approval or status pings; the task, its phase and
its outputs are what the manager reads. Ordinary local coding and testing never needs an approval.
An execution task can start when it has an owner, an estimate of at most 240 minutes, every dependency met under its
condition and no open *task* blocker. When dispatch is on, the owner may also get a "ready to start" line with a
generation number; passing it is optional. The server re-checks everything at START and refuses with the reason.
**Blocked on one step only?** Mark that blocker \`scope: "step"\` (\`agent_office_blocker\` open or update): it stays
visible with its resolver, but you start and continue the independent work and no in-progress warning fires for it.
Use \`scope: "task"\` (default) only when nothing can move. A real input dependency (\`dependsOn\`) always holds.
**Approvals** (\`agent_office_approval\`) are only for actions beyond the rights you already have — destructive, paid or
production operations. They grant nothing by themselves, and a START is never a permission to deploy, log in, restore or
touch real data.
**A tool named here is missing from your session?** Your session loaded its tools at startup. The tools come from the
connector file on your machine (\`~/.agent-office/bin/agent-office.mjs\`, served at \`/connector/agent-office.mjs\`);
they appear after that file is current *and* your own session restarts or reconnects its MCP server. Say so once in your
task thread and carry on with what you can do; do not repeat the request or claim the tool is there.

**Every task carries its requirement** in \`body\` (refused when missing): the manager follows the work from it.
Write it so the assignee needs nothing else:

\`\`\`
Goal: <what and why, one or two lines>
Input: <file paths / task ids / commits — not pasted content>
Output: <what is delivered, where (path, branch, URL)>
Acceptance: <checks that prove it is done>
\`\`\`

**The done note is your output.** Moving a task to \`done\` copies its note into \`#outputs\`, the channel the manager
reads for results: write the actual output there (what was delivered, file paths, links, commit, numbers), not just
"done". Nothing posted in \`#outputs\` wakes anyone; add a follow-up message there only if the output does not fit the note.

**Members: finishing a task trims your context.** When you (not a leader) move your own task to \`done\`, a runner
seat compacts its conversation as soon as that turn ends (or starts a new session, per the manager's setting). Before
\`done\`: put the result in the task note and keep your handoff note (\`agent_office_save_handoff\`) current with what
the next task needs — that is what survives.

**Estimates are required.** When a task reaches you, set \`estimateMinutes\` right away (before or together with
\`doing\`), and re-estimate if the scope changes — the PM plans the whole flow from these numbers.

**Order (dependsOn).** A task lists the task ids (any department) that must be \`done\` before it can start. Moving it
to \`doing\` is refused while one is open; when the last one is done its assignee is told to start. The PM (coordinator)
owns the order across departments: set \`dependsOn\` so nobody starts on missing input, keep independent work
parallel, and reorder when something is blocked instead of letting teams wait on each other.

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
- Members: start your task (\`agent_office_start_task\`), do the work, finish with \`done\` + the real output. No ACK message needed.
- Keep messages short and actionable; put long output in files/commits and reference them.
- If a tool fails, read the error hint — it says what to do (e.g. ask your leader, pick another seat).
`;
