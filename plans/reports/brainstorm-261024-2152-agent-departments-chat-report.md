---
name: agent-departments-chat
status: approved
created: 2026-10-24
modes: []
supersedes: plans/261023-2211-agent-office-control-room
---

# Agent Departments Chat — Brainstorm

## Problem

Want local, personal "radio.plasma.ai"-like chat bus for Claude Code agents, organized as company: departments (Dev, DevOps, BA, Design, extensible), each with own channel, 1 leader + N members. Leaders share a `Leaders` channel → agent can be in 2 channels. Need real UI. Codex output: heavy security/durability infra, near-zero product (1 hardcoded channel, inbox-style messages, placeholder Phaser UI, no chat UI).

Core hard problem: Claude Code sessions don't wake on new messages (MCP is pull). Without wake mechanism, departments = passive chat log.

## Scout facts

- Stack: Node 24, Hono, `node:sqlite`, ws, MCP server SDK, Zod, React 19, Vite 8, Phaser 3.
- `channels(id,name)` no membership/role; `messages` + `message_recipients` inbox model; `CollaborationService` 25 lines.
- `mcp-stdio.ts`: 3 tools (read inbox, ack, send).
- UI: login + session list + inspector + Phaser rectangles.
- Old plan: 6 phases all in-progress, monitoring/SLO focused.

## Decisions (user-approved)

| Topic | Decision |
|---|---|
| Agent runtime | Human-launched Claude Code sessions; Stop hook wake + long-poll; `wait_for_message` fallback |
| Codebase | Keep core (Hono/SQLite/auth/WS hub/hook connector/event store); rewrite collaboration, MCP, client UI; freeze SLO/benchmark/Phaser |
| UI | Slack-like chat + org chart; pixel office out of scope |
| Routing | Cross-dept via leaders only |
| Identity | Session self-registers; manager drags session onto **seat** in UI; history/tasks bound to seat |
| Config | Seed departments/seats/channels from `office.yaml`; CRUD on UI, persisted in SQLite |
| Scope | Departments+channels+membership, Stop-hook wake, UI chat+org chart, tasks with status |

## Approaches considered (wake)

- A. MCP long-poll only — simple; agent stuck in wait loop, burns context. Fallback only.
- B. Stop hook wake — **chosen**; reuses hooks; can't wake fully stopped session (UI flags "idle, needs nudge").
- C. Daemon spawns headless `claude -p`/Agent SDK — true autonomy; token cost + runaway loop risk. Deferred.

## Data model

```
departments(id, name, color, sort)
seats(id, department_id, title, role leader|member, session_agent_id NULL)
channels(id, name, kind department|leaders|direct, department_id NULL)
channel_members(channel_id, seat_id)
messages(id, channel_id, seq, sender_kind seat|manager, sender_id, body, mentions JSON, created_at)
seat_reads(seat_id, channel_id, last_read_seq)
tasks(id, department_id, assignee_seat_id, created_by, title, body,
      status todo|doing|blocked|done, source_message_id, updated_at)
```

- `leaders` channel membership auto-synced from leader seats.
- Server-enforced send rules: member → own dept channel; leader → own dept + leaders; manager → all.
- Replaces `message_recipients` inbox model with per-seat read cursor.

## Wake mechanism

Stop hook → `GET /v1/seats/me/wake?wait=Ns`:
- Wake triggers: @mention of seat, task assigned/updated for seat, leader message in own dept channel, manager message.
- Pending → `{"decision":"block","reason":"<unread summary + use read_channel>"}`.
- None → long-poll up to N s (default 300, bounded by hook timeout) → allow stop.
- Guards: max consecutive auto-wakes per seat (default 15), never wake on own messages, per-department Pause toggle.
- Hook failure must never block Claude (keep existing spool/fail-open principle).

## MCP tools (rewrite)

`whoami`, `list_channels`, `read_channel`, `send_message`, `wait_for_message`, `list_tasks`, `create_task` (leader), `update_task` (assignee/leader).

## UI

- Sidebar: Leaders channel, departments → channel + seats, "Unassigned sessions".
- Realtime chat (WS), manager posts, @mention autocomplete.
- Right panel: members + status (working/idle/blocked/offline) | department tasks.
- Org chart: dept → leader → members; drag session to seat; CRUD departments/seats.

## Phases

1. Schema/migration, `office.yaml` seed, REST for departments/seats/channels/messages, routing rules + tests.
2. MCP tools + Stop-hook wake/long-poll + loop guard.
3. Tasks: API, MCP, wake events.
4. UI: chat, sidebar, panels, org chart, drag-assign.
5. E2E smoke: manager → Dev leader → task to member → done → leader reports in Leaders.

## Acceptance criteria

- Seed 4 departments, each own channel; `Leaders` auto-contains 4 leaders.
- Member posting to other dept channel → 403.
- @mention to stopped-but-polling seat → session resumes ≤2s.
- Loop guard stops 2-agent ping-pong.
- UI updates messages/status/tasks realtime without reload.
- `npm run build`, `npm run lint`, `npm test` pass.

## Out of scope

Pixel office, headless spawn mode, Codex, LAN/remote, SLO benchmark.

## Risks

- Stop hook timeout limits long-poll window; fully stopped sessions need manual nudge.
- Agent chatter cost; mitigated by narrow wake triggers + guard + pause.
- Migration from old `messages/message_recipients` schema; data is dev-only → drop & recreate acceptable (confirm in plan).
- Seat reassignment UX when multiple sessions share project dir.

## Unresolved questions

- Exact Stop hook max timeout in current Claude Code version — verify in docs during planning.
- Drop old collaboration tables or migrate? (assume drop; dev data only).
