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

The Stop hook runs in the background (`asyncRewake: true`, timeout 24 h), so the terminal stays usable while the seat listens. It long-polls `GET /v1/wake?wait=60` and starts the next round as soon as one ends; network errors, 5xx/429, daemon restarts and refusals (`paused`, `wake_limit`, `not_seated`) back off up to 60 s and continue, and a 401 re-registers. A wake makes the hook print the reason on stderr and exit 2, which wakes Claude even from an idle prompt. Just before the hook timeout it sends one keep-alive wake ("end your turn") so a fresh listener takes over. A listener exits quietly when the daemon reports `ended` (SessionEnd), when a newer Stop hook of the same session claimed `~/.agent-office/listeners/<session>.json`, or when its parent Claude Code process is gone — so no orphan consumes mentions. Requires a Claude Code version that supports `asyncRewake` (verified on 2.1.312).

Wake trigger for seat S (sender ≠ S, after S's read cursor): only a message whose mentions include S — `@S`, `@all`/`@everyone` expanded to channel members, or a task `system` line (assignment → assignee, blocked/done → leader). Leaders split the work, so unmentioned leader/manager messages and thread replies wake nobody and two agents never take the same request.

Guards: `consecutive_wakes` per seat capped by `AGENT_OFFICE_MAX_AUTO_WAKES` (default 15), reset by a human prompt (`UserPromptSubmit` → `turn.start`) or a manager message in the seat's channel; paused departments never wake; ≤64 parked waiters. A seat with a live session but no parked long-poll is "idle — needs nudge" in the UI (old connector, or the session died without SessionEnd).

## Identity and credentials

- `npm run connect` (manager login) stores a long-lived connector credential in `~/.agent-office/connector.json` (0600).
- `SessionStart` hook registers the session with the connector → per-session agent token in `~/.agent-office/sessions/<session_id>.json`; re-registration revokes the previous token.
- MCP server resolves its session from `CLAUDE_CODE_SESSION_ID` (provided by Claude Code to MCP subprocesses) and uses that token.
- The Stop listener retries network errors, 5xx/429 and every non-wake state with jittered backoff (2 s → 60 s) for as long as the session lives; a 401 re-registers.
- Hooks fail open: any error prints `{}`. Undeliverable telemetry is spooled per session and drained on the next successful send; 4xx rejections are dropped so the spool cannot wedge.

## Realtime

WebSocket `/v1/stream` (manager only): telemetry deltas keep the existing generation + seq replay contract; collaboration events (`{type:'collab', kind:'message'|'org'|'task'}`) are best-effort notifications. State lives in SQLite; the UI refetches org, tasks and open channel histories over REST on every (re)connect. The snapshot carries `org` but never message history.

## Handoff and remote approval

- `HandoffService`: one note per seat (`seat_handoffs`); `/v1/me` returns `handoff` + `handoffBrief` (note, open tasks, unread). SessionStart injects the brief, so context follows the seat across sessions and machines.
- `PermissionService`: PermissionRequest hook → `POST /v1/permissions` → long-poll `GET /v1/permissions/:id/decision`; manager answers via `POST …/decision`; pending list pushed as `collab` kind `permission`. Off unless `AGENT_OFFICE_REMOTE_APPROVAL=true`; unanswered → `expired` → terminal prompt.

## Compaction

SessionStart with `source=compact` calls `/v1/me?source=compact`; the brief then adds the seat's recent conversation (own messages, mentions, replies in threads it joined) but omits the stored compaction summary, which the session already holds. The `PostCompact` hook posts Claude's `compact_summary` to `/v1/seats/me/compaction` (`seat_compactions`, schema v8); later sessions on the seat get it when it is newer than the hand-written note. `agent-office.mjs update` re-syncs the hook list with the new file (`sync-hooks`).

## Threads

`messages.thread_seq` (schema v7) points a reply at its root's seq in the same channel; threads are one level deep. Replies share the channel seq, so read cursors, unread counts and wake rules work unchanged; replies wake only the seats they mention. `GET …/messages?view=timeline` returns roots only with `replyCount`/`lastReplyAt`; `GET …/threads/:seq` returns root + replies; every reply also pushes the refreshed root over the WebSocket.

## Cross-department flow

Tasks may carry `requesterSeatId` (a leader of another department, set via `requestedBy`). Creation posts an acceptance line in `#leaders` mentioning the requester; `blocked`/`done` post the result there too, so the serving leader does not relay. A department's optional `deputySeatId` (member) is a `#leaders` member, has the leader's task rights in its department, and `WakeService.standingInFor` wakes it with the leader's mentions while the leader has no session, ended, is wake-limited, or idle > 10 min without a parked wait. Leaders' and deputies' handoff briefs list requests served and requests waiting. Schema v6 adds both columns.

## Public deployment

`AGENT_OFFICE_PUBLIC_ORIGIN` adds the public host/origin to the allowlists (`src/server/http-policy.ts`, shared by app, static handler and WS upgrade), marks the cookie `Secure` and sends HSTS. Security headers (CSP, frame/sniff/referrer) on every response. `AGENT_OFFICE_TRUST_PROXY` keys login throttling on the proxy-appended `X-Forwarded-For` hop. `/join/:id` and `/agent-guide` require a manager or agent session. Deployment: `docker-compose.prod.yml` + `deploy/Caddyfile`.

## Storage

Schema version 6 (`PRAGMA user_version=6`); v2–v5 upgrade in place. No in-place migration from v1: the daemon refuses a v1 database (`schema_reset_required`); run `npm run wipe -- --yes && npm run setup`. Tables: auth (`users`, `auth_sessions`, `credentials`), telemetry (`agents`, `turns`, `invocations`, `permission_waits`, `events`), collaboration (`departments`, `seats`, `channels`, `channel_members`, `messages`, `seat_reads`, `tasks`, `task_events`, `seat_handoffs`, `permission_requests`).

## Runner (headless seats)

`agent-office.mjs runner` runs the seats of the machine's `~/.agent-office/runner.json` as `claude -p --input-format stream-json --output-format stream-json --verbose` processes (env: `AGENT_OFFICE_SEAT`, `AGENT_OFFICE_RUNNER=1`, nested-session vars stripped). `SeatWorker` keeps the session id per seat (`runner-state.json`) and restarts crashes with `--resume` (backoff 2–60 s, 5 crashes / 10 min → `failed`; an unresumable session starts fresh). When a turn ends it long-polls `/v1/wake` with the session token the SessionStart hook stored and writes the reason as the next user message; the Stop hook returns at once under `AGENT_OFFICE_RUNNER=1`. Prompts written by Agent Office start with `[Agent Office]`; their `turn.start` telemetry carries `summary: agent-office:auto` so the auto-wake guard is not reset as it is for a human prompt. Interrupt = stream-json `control_request {subtype: interrupt}`.

The runner authenticates with the machine's connector credential (runner id = credential id) and talks outbound only: `POST /v1/runners/register` (seats offered; unknown ids refused), long-poll `GET /v1/runners/me/commands?wait=60`, `POST …/commands/:id/result`, batched `POST /v1/runners/me/status` and `/log`. `RunnerService` (schema v9: `runners`, `runner_commands`) routes a manager command to the most recently seen runner offering the seat, rejects it when that runner is offline (no poll for 90 s), expires unpicked commands after 2 min, rate-limits 30/min and keeps every command as an audit row. The live log is an in-memory ring of 300 entries per seat, pushed over the WebSocket. Service install writes a launchd agent / systemd user unit / logon task with an allowlist of env vars (no API tokens).

### Web-managed machines

Schema v10. `POST /v1/machines` creates a runner row (`m-…`) before anything is installed; `POST /v1/machines/:id/install-code` mints a one-use install code bound to it, and redeeming it creates a connector credential whose binding carries `machineId` — runner endpoints and session registration then act as that machine (`agents.machine_id`, used by `GET /v1/machines/:id/sessions` to suggest folders and session ids). The installer installs the runner service when the code is bound to a machine. `PUT /v1/machines/:id/config` stores the seat list (seat, absolute cwd, permission mode, optional session id, auto-start) with a version; a seat may be configured on one machine only. Runners long-poll commands with `version=<applied>`; a newer version returns at once and the runner fetches `GET /v1/runners/me/config` and applies it: new seats start, seats whose cwd/permissions/session changed restart (a given session id is written to the resume state), removed seats stop. Seats default to `bypassPermissions`, which the runner passes as `--dangerously-skip-permissions`. With `showWindow` (default on) starting a seat opens a desktop terminal running `runner watch <seat>` — a read-only renderer that follows the seat's session id and tails its transcript (`<claude config>/projects/*/<session>.jsonl`); a pid file prevents duplicates and turning the switch off closes it (macOS: `.command` opened in Terminal; Windows: `start`; Linux: first terminal emulator found when a display exists). Before starting a seat the runner asks `GET /v1/runners/me/seat-check`: it waits (showing why) while the session to resume still runs elsewhere or another live session holds the seat (live = not ended and seen within 3 min; wake polls count as contact). Saving a seat with a session that is still live in a terminal flags a takeover: that session's Stop-hook listener gets `taken_over` (older listeners get one short wake turn, after which the current hook runs) and sends SIGTERM to its Claude Code process (`CLAUDE_PID`); after its SessionEnd the runner resumes the session. Sessions already run by a runner are never flagged. Web-managed folders must exist and lie inside the machine's `allowedRoots` (local runner.json, default the home directory) — the runner refuses others and reports the seat as failed. Deleting a machine revokes its connector credentials.

## Telegram notifications

`TelegramNotifier` (enabled by `AGENT_OFFICE_TELEGRAM_BOT_TOKEN`) receives collab events: new permission prompts become messages with Allow/Deny inline buttons (`p:a|d:<id>` callback data), resolved prompts edit the message with the outcome; runner seats that turn `failed` are reported. Updates come from long-polling `getUpdates`; all Bot API traffic goes through `AGENT_OFFICE_TELEGRAM_PROXY` (undici `ProxyAgent` for http(s), `fetch-socks` for socks5). One chat is served, paired with a 10-minute code from the web UI (`app_settings`); callbacks from other chats are refused; decisions record `decided_by='telegram'`. Errors mask the token; logs mask proxy credentials. Max 20 messages/min.

## Public map and lobby

`GET /v1/public/map` (no auth, cached 2 s) returns the org and live agents through `publicMap`: seat descriptions, channels, session ids and project paths are removed and agent ids are replaced by per-response aliases; the client renders it read-only at `/map` for anonymous visitors. The lobby shows unseated sessions that have not exited, were not dismissed (`agents.dismissed_at`, schema v11, cleared on the next registration) and reached the daemon within 5 minutes (`isLobbySession`). Machine seats may set `model`, passed to `claude --model`.

## Model and working time

On Stop the hook reads the transcript tail (`transcript_path`) and sends the model of the latest non-synthetic assistant reply as `model` on `turn.stop`; the daemon stores it in `agents.model`. A turn starts at `turn.start`, or at its first `tool.start` when a Stop-hook wake skipped UserPromptSubmit; when it ends (`turn.stop`/`session.end`) its duration (capped at 6 h) is added to `seats.work_ms` of the seat the session sits in (schema v12). Both appear on the 3D desk plates, map tooltips and the public map.

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
| `src/connector/runner/*` | Runner: config, stream-json adapter, seat worker, server link, service install |
| `src/server/collaboration/runner-service.ts`, `src/server/runner-routes.ts` | Runner registry, command queue + audit, live log |
| `src/server/notify/*` | Telegram client (proxy), notifier, pairing routes |
| `src/connector/hook-runner.ts` | Hook logic (register, telemetry, Stop wake with retry, remote permission) |
| `src/server/mcp-stdio.ts` | MCP tools `agent_office_*` |
| `src/client/map3d/office-3d.ts` | 3D map (default): Three.js isometric open-plan office floor (department zones with own flooring, windowed shell, pantry/lounge, plants, pendant lamps; props in `office-3d-props.ts`, clock-driven lighting in `day-night.ts`) reusing the 2D layout; loaded lazily as its own chunk; rebuilds meshes only on org layout changes, restyles actors on status changes |
| `src/client/map/` | Map tab: pure room/desk layout + hit testing (`office-map-layout.ts`) and Canvas 2D pixel painter (`office-map-painter.ts`), no game engine |
| `src/client/router.ts` | URL routes per view (`/chat[/<channel>]`, `/map`, `/org`, `/requests`) on the History API; views are `React.lazy` chunks loaded on first visit; the daemon serves `index.html` for these paths |
| `src/client/` | React UI: Chat (sidebar, messages, members/tasks) and Org (seat cards, drag-assign) |

## Frozen

SLO/benchmark work, heartbeat wakes, spawning seats on machines that have no runner.json entry for them.
