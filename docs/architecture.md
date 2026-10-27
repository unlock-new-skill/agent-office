# Agent Office Architecture

## Overview

Local-only TypeScript daemon that organizes Claude Code sessions into a company: departments with a channel each, one leader seat and N member seats per department, and a shared `#leaders` channel. Sessions self-register through Claude Code hooks; the manager seats them in the UI; a Stop hook wakes seated sessions when something addressed to them arrives. Codex is out of scope.

```
Claude Code session ──hooks──▶ scripts/claude-hook.ts ──HTTP──▶ daemon (Hono + node:sqlite) ──WS──▶ React UI (manager)
        └──MCP stdio── src/server/mcp-stdio.ts ──HTTP (agent bearer)──┘
```

## Concepts

| Concept | Meaning |
|---|---|
| Department | `departments` row; owns a `department` channel (id = department id). Can be paused. |
| Seat | Durable position (`seats`): title, role `leader`/`member`, specialty `description`. At most one leader per department. Messages and tasks bind to seats, not sessions. |
| Session / agent | A Claude Code session (`agents`, id `cc-<sha256(session_id)[:12]>`). Resume keeps the id. Bound to at most one seat via `seats.agent_id`. |
| Channel membership | Always derived (`OrgService.syncMembership`): department channel = its seats; `#leaders` = all leader seats. |
| Manager | The human, cookie session + CSRF. May read/post everywhere and manage the org. |

## Routing rules (server-enforced, `MessageService`)

- Member seat → only its department channel.
- Leader seat → its department channel + `#leaders`.
- Manager → any channel.
- Cross-department work goes through leaders in `#leaders`; tasks can only be assigned inside the creator's department.

## Wake model (`WakeService`)

Stop hook calls `GET /v1/wake?wait=N` (default 290 s, hook timeout 600 s). The daemon answers immediately if items are pending, otherwise parks the request until a relevant post or timeout. A wake returns `{"decision":"block","reason":…}` to Claude Code, which continues the session with the items (verified on Claude Code 2.1.310).

Wake triggers for seat S (sender ≠ S, after S's read cursor): `@S` mention; any manager message; for members, a leader message in their department channel. Plain member chatter wakes nobody; leaders are woken only by mention, manager, or task blocked/done (task changes post `system` lines whose explicit mentions drive wakes).

Guards: `consecutive_wakes` per seat capped by `AGENT_OFFICE_MAX_AUTO_WAKES` (default 15), reset by a human prompt (`UserPromptSubmit` → `turn.start`) or a manager message in the seat's channel; paused departments never wake; ≤64 parked waiters. A session whose long-poll expired is "idle — needs nudge" in the UI.

## Identity and credentials

- `npm run connect` (manager login) stores a long-lived connector credential in `~/.agent-office/connector.json` (0600).
- `SessionStart` hook registers the session with the connector → per-session agent token in `~/.agent-office/sessions/<session_id>.json`; re-registration revokes the previous token.
- MCP server resolves its session from `CLAUDE_CODE_SESSION_ID` (provided by Claude Code to MCP subprocesses) and uses that token.
- Stop hook retries network errors, 5xx/429 and `shutdown`/`busy`/`aborted` wake states with jittered backoff until its wait window ends; a 401 triggers one re-registration.
- Hooks fail open: any error prints `{}`. Undeliverable telemetry is spooled per session and drained on the next successful send; 4xx rejections are dropped so the spool cannot wedge.

## Realtime

WebSocket `/v1/stream` (manager only): telemetry deltas keep the existing generation + seq replay contract; collaboration events (`{type:'collab', kind:'message'|'org'|'task'}`) are best-effort notifications. State lives in SQLite; the UI refetches org, tasks and open channel histories over REST on every (re)connect. The snapshot carries `org` but never message history.

## Handoff and remote approval

- `HandoffService`: one note per seat (`seat_handoffs`); `/v1/me` returns `handoff` + `handoffBrief` (note, open tasks, unread). SessionStart injects the brief, so context follows the seat across sessions and machines.
- `PermissionService`: PermissionRequest hook → `POST /v1/permissions` → long-poll `GET /v1/permissions/:id/decision`; manager answers via `POST …/decision`; pending list pushed as `collab` kind `permission`. Off unless `AGENT_OFFICE_REMOTE_APPROVAL=true`; unanswered → `expired` → terminal prompt.

## Cross-department flow

Tasks may carry `requesterSeatId` (a leader of another department, set via `requestedBy`). Creation posts an acceptance line in `#leaders` mentioning the requester; `blocked`/`done` post the result there too, so the serving leader does not relay. A department's optional `deputySeatId` (member) is a `#leaders` member, has the leader's task rights in its department, and `WakeService.standingInFor` wakes it with the leader's mentions while the leader has no session, ended, is wake-limited, or idle > 10 min without a parked wait. Leaders' and deputies' handoff briefs list requests served and requests waiting. Schema v6 adds both columns.

## Public deployment

`AGENT_OFFICE_PUBLIC_ORIGIN` adds the public host/origin to the allowlists (`src/server/http-policy.ts`, shared by app, static handler and WS upgrade), marks the cookie `Secure` and sends HSTS. Security headers (CSP, frame/sniff/referrer) on every response. `AGENT_OFFICE_TRUST_PROXY` keys login throttling on the proxy-appended `X-Forwarded-For` hop. `/join/:id` and `/agent-guide` require a manager or agent session. Deployment: `docker-compose.prod.yml` + `deploy/Caddyfile`.

## Storage

Schema version 6 (`PRAGMA user_version=6`); v2–v5 upgrade in place. No in-place migration from v1: the daemon refuses a v1 database (`schema_reset_required`); run `npm run wipe -- --yes && npm run setup`. Tables: auth (`users`, `auth_sessions`, `credentials`), telemetry (`agents`, `turns`, `invocations`, `permission_waits`, `events`), collaboration (`departments`, `seats`, `channels`, `channel_members`, `messages`, `seat_reads`, `tasks`, `task_events`, `seat_handoffs`, `permission_requests`).

## Code map

| Path | Role |
|---|---|
| `src/server/collaboration/org-service.ts` | Departments, seats, membership sync, agent assignment |
| `src/server/collaboration/message-service.ts` | Channel posts, paging, read cursors, mentions, routing |
| `src/server/collaboration/wake-service.ts` | Wake rules, long-poll waiters, loop guard, reason text |
| `src/server/collaboration/task-service.ts` | Department tasks, permissions, system lines |
| `src/server/collaboration/handoff-service.ts` | Seat handoff notes and SessionStart brief |
| `src/server/collaboration/permission-service.ts` | Remote permission prompts, long-poll decisions |
| `src/server/http-policy.ts` | Host/origin allowlists, security headers, client peer |
| `src/server/office-routes.ts` | REST surface for the above |
| `src/connector/hook-runner.ts` | Hook logic (register, telemetry, Stop wake with retry, remote permission) |
| `src/server/mcp-stdio.ts` | MCP tools `agent_office_*` |
| `src/client/map3d/office-3d.ts` | 3D map (default): Three.js isometric low-poly office reusing the 2D layout; loaded lazily as its own chunk; rebuilds meshes only on org layout changes, restyles actors on status changes |
| `src/client/map/` | Map tab: pure room/desk layout + hit testing (`office-map-layout.ts`) and Canvas 2D pixel painter (`office-map-painter.ts`), no game engine |
| `src/client/` | React UI: Chat (sidebar, messages, members/tasks) and Org (seat cards, drag-assign) |

## Frozen

SLO/benchmark work, headless agent spawning, heartbeat wakes.
