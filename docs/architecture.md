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

Guards: `consecutive_wakes` per seat capped by `AGENT_OFFICE_MAX_AUTO_WAKES` (default 15), counting only chat-only wakes: any `tool.start` of a work tool (not `mcp__agent-office__*`, ToolSearch, Todo/Task bookkeeping) resets it, as do a human prompt (`UserPromptSubmit` → `turn.start`), a manager message in the seat's channel or the Reset button; a limited seat re-arms itself 15 min after its last auto-wake (`seats.last_wake_at`) with a fresh budget; paused departments never wake; ≤64 parked waiters. Task system lines are threaded (schema v20 `tasks.thread_seq` / `request_thread_seq`): the first line about a task becomes the thread root in its department channel (and the accepted-request line in #leaders), later lines are replies; a deleted root falls back to a new top-level line. Tasks carry `estimate_minutes` and `depends_on` (JSON task ids, any department; schema v15). Moving to `doing` is refused for seats while a dependency is open; finishing the last dependency posts "ready to start" mentioning the waiting assignee. The coordinator seat (`AGENT_OFFICE_COORDINATOR_SEAT`, default `pm`) has leader task rights in every department. After-task context trim: when a member seat (not leader/deputy) marks its own task done, the next `turn.stop` of that session queues a runner command for the seat — `prompt` `/compact <focus>` or `fresh`, per `seats.after_task` (schema v17), else the manager default (`app_settings` `after_task.default`), else `AGENT_OFFICE_AFTER_TASK` (default `compact`); `off` does nothing; skipped while another task is `doing` or when no online runner owns the seat. `#outputs` (channel kind `outputs`, schema v19 rebuilt `channels` with foreign keys off): every seat is a member; a task moving to `done` posts its done note there as a system line without mentions, and the wake service skips the channel entirely. Status check (`StatusCheck`, every 5 min): a non-paused department with `doing`/`blocked` tasks and no channel message or task change for `AGENT_OFFICE_STATUS_CHECK_MINUTES` (default 45) is reported in #leaders with a mention of `AGENT_OFFICE_COORDINATOR_SEAT` (default `pm`, must be seated and in #leaders); each department at most once per window. A seat with a live session but no parked long-poll is "idle — needs nudge" in the UI (old connector, or the session died without SessionEnd).

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

`messages.thread_seq` (schema v7) points a reply at its root's seq in the same channel; threads are one level deep. Replies share the channel seq, so read cursors, unread counts and wake rules work unchanged; replies wake only the seats they mention. `GET …/messages?view=timeline` returns roots only with `replyCount`/`lastReplyAt`; `GET …/threads/:seq` returns root + replies; every reply also pushes the refreshed root over the WebSocket. Thread guests (schema v21 `thread_guests`, own `last_read_seq`): a mention inside a thread of a seat outside the channel invites it into that thread only — it may read the thread, post/edit/delete its replies there, and is woken by mentions in it (wake scans guest threads after channels); top-level mentions still count channel members only. `POST /v1/tasks/:id/thread` returns (creating if needed) a task's thread `{ channelId, seq }` and invites a caller entitled to the task (lead of the parent, step assignee, PM). Steps (schema v21 `tasks.parent_id`, `tasks.step`, one level): created with `parentId` by the manager, the PM or the parent's assignee (the lead); the assignee may be in any department (the step lives there); a step depends on the previous one unless `parallel`; its assignee becomes a guest of the parent thread; step blocked/done is posted in the parent thread mentioning the lead, the last done asks the lead to close; the parent cannot move to done while a step is open; seats also list steps of tasks they lead and parents of their steps.

## Cross-department flow

Tasks may carry `requesterSeatId` (a leader of another department, set via `requestedBy`). Creation posts an acceptance line in `#leaders` mentioning the requester; `blocked`/`done` post the result there too, so the serving leader does not relay. A department's optional `deputySeatId` (member) is a `#leaders` member, has the leader's task rights in its department, and `WakeService.standingInFor` wakes it with the leader's mentions while the leader has no session, ended, is wake-limited, or idle > 10 min without a parked wait. Leaders' and deputies' handoff briefs list requests served and requests waiting. Schema v6 adds both columns.

## Task edits, blockers, readiness, dispatch (schema v22)

- **Coordinators**: `seats.coordinator` (set by the manager) or the env seat `AGENT_OFFICE_COORDINATOR_SEAT`; leader rights over every department's tasks, member of `#leaders`. Read refusals are `forbidden_task_read`, change refusals `forbidden_task_change`.
- **Edits in place** (`TaskService.update`): one PATCH contract for UI (manager cookie → source `ui`) and MCP (bearer → `mcp`). Omitted fields keep their value; everything is validated before the write; `tasks.revision` is compared-and-set (`expectedRevision` → 409 `stale_revision` with the current task); a `doing` task changes assignee only with `handoffNote` and returns to `todo`. Each changed field lands in `task_changes` (actor, source, before/after, reason). `kind`: `execution` (START needs an owner and an estimate ≤ 240), `tracking` (followed apart), NULL = legacy, unclassified.
- **Results**: `tasks.result` (`unknown` by default) is independent from `done`; `tasks.pass_required` lists the dependencies that need `done` + `pass`.
- **Blockers** (`BlockerService`): `blockers` + `task_blockers`; kinds dependency, missing-input, permission, environment, defect, owner-missing, decision; resolve needs evidence, reopen models a revoked grant or closed window. Changes are posted in each affected task's thread.
- **Readiness** (`readiness.ts`, pure): ready / waiting / needs-action / doing / done / tracking with reasons grouped by root cause (blocker id, `dep:`, `result:`, `confirm:`, missing owner/estimate/kind, blocked without record). `GET /v1/board` groups them and counts each task once.
- **Dispatch** (`DispatchService`): after every task, blocker or org change and once at start, every task is re-evaluated and stored in `task_readiness` (a real not-ready → ready bumps `generation`). Mode (`app_settings` `dispatch.mode`): `off`, `suggest` (default), `on`. With `on`, the oldest ready execution task of a free owner gets one line, keyed in `task_notifications` (task, kind, generation, recipient) and written in the same transaction (nested transactions are savepoints), so restarts and replays neither repeat nor lose it. START (`POST /v1/tasks/:id/start`) checks the offered generation, re-runs the gate (readiness + no other execution `doing` for the owner) and claims by revision. A `doing` task whose gate breaks gets one warning to owner and leader; nothing is stopped or changed.
- **Exceptions** (`AlertService`, schema v23 `alert_state`): every 5 min (with `BlockerService.expireDue`, which reopens resolved blockers past `valid_until`) the current alerts — owner missing, overdue (time in doing summed over the doing periods in `task_events` > 1.25 × estimate; `actual_start` stays the first start), gate broken while doing, blocker overdue / stale 24h / without resolver — are diffed against `alert_state`; only new or returning keys are posted as one digest in `#leaders` mentioning coordinators and the owners. Off with dispatch `off`. `StatusCheck` pings the env seat or, failing that, a flagged coordinator.
- **Service tokens** (schema v24 `service_tokens`, `ServiceTokenService`): manager-issued, read-only bearer tokens `aos_…` for server integrations; SHA-256 at rest, shown once, expiry (default 90 days, max 365), revocation, optional department scope, last-used (≤ once/min), 120 req/min. An app middleware lets them through only for GET `/v1/tasks`, `/v1/tasks/:id`, `/v1/board`, `/v1/blockers`, `/v1/directory`; routes then apply the scope. `TaskService.page` pages over a snapshot ordered by (created_at, id) with `total`, `snapshotAt`, `nextCursor`, `changedSinceSnapshot`; tasks carry `activeMs`/`runs` (`doingTime`, shared with the overdue alert).
- **Seat activity and partial outputs** (schema v25 `task_participants`, `task_outputs`; `ProgressService`): participants are executor / reviewer / intake seats of a task with state (active, waiting, done, stopped), concrete phase, note, time, actor and source; they never change the task's owner. Outputs are partial results (name, scope such as local / real-env, evidence, result, `missing` acceptance) — received ≠ accepted; acceptance by the task's leaders/PM/manager or a reviewer participant (only leaders name reviewers or revoke; a reviewer never accepts an output it recorded or of a task it owns; participants can read the task); outputs never change status, result or dependencies. All writes are audited in `task_changes` (`participant:<seat>:<role>`, `output:<id>`). `GET /v1/progress` derives each seat's activity from these records only: executing (active executor, else the owner's current doing run when the task has no participants), reviewing (active reviewer/intake), waiting (waiting role, or an active role claimed before its task was blocked, + readiness reasons; an active role reported after the block stays executing/reviewing with the task's blockers in `reasons` — the task's status and dependencies are untouched), available (a role finished/stopped recently and nothing else running), otherwise unknown. Anything older than `ACTIVITY_STALE_MS` = 60 min is stale → unknown with the last signal; online/runner state is shown separately and never used; owning a blocked task is listed under `also`, not used as the person's state. A seat sees activity of its own department and of seats on tasks it can read; manager/coordinators see all; service tokens get no participants/outputs.
- **Channel visitors**: `channel_visitors` lets leaders and coordinators join another department channel (membership derived in `syncMembership`); `@all` there expands to the department's own seats only.

## Public deployment

`AGENT_OFFICE_PUBLIC_ORIGIN` adds the public host/origin to the allowlists (`src/server/http-policy.ts`, shared by app, static handler and WS upgrade), marks the cookie `Secure` and sends HSTS. Security headers (CSP, frame/sniff/referrer) on every response. `AGENT_OFFICE_TRUST_PROXY` keys login throttling on the proxy-appended `X-Forwarded-For` hop. `/join/:id` and `/agent-guide` require a manager or agent session. Deployment: `docker-compose.prod.yml` + `deploy/Caddyfile`.

## Storage

Schema version 6 (`PRAGMA user_version=6`); v2–v5 upgrade in place. No in-place migration from v1: the daemon refuses a v1 database (`schema_reset_required`); run `npm run wipe -- --yes && npm run setup`. Tables: auth (`users`, `auth_sessions`, `credentials`), telemetry (`agents`, `turns`, `invocations`, `permission_waits`, `events`), collaboration (`departments`, `seats`, `channels`, `channel_members`, `messages`, `seat_reads`, `tasks`, `task_events`, `seat_handoffs`, `permission_requests`).

## Runner (headless seats)

`agent-office.mjs runner` runs the seats of the machine's `~/.agent-office/runner.json` as `claude -p --input-format stream-json --output-format stream-json --verbose` processes (env: `AGENT_OFFICE_SEAT`, `AGENT_OFFICE_RUNNER=1`, nested-session vars stripped). `SeatWorker` keeps the session id per seat (`runner-state.json`) and restarts crashes with `--resume` (backoff 2–60 s, 5 crashes / 10 min → `failed`; an unresumable session starts fresh). When a turn ends it long-polls `/v1/wake` with the session token the SessionStart hook stored and writes the reason as the next user message; the Stop hook returns at once under `AGENT_OFFICE_RUNNER=1`. Prompts written by Agent Office start with `[Agent Office]`; their `turn.start` telemetry carries `summary: agent-office:auto` so the auto-wake guard is not reset as it is for a human prompt. Interrupt = stream-json `control_request {subtype: interrupt}`. `fresh` (schema v16) stops the seat, forgets its session id and starts a new session; when the runner reports it done the server unseats the old session so the new one can claim the seat at once.

The runner authenticates with the machine's connector credential (runner id = credential id) and talks outbound only: `POST /v1/runners/register` (seats offered; unknown ids refused), long-poll `GET /v1/runners/me/commands?wait=60`, `POST …/commands/:id/result`, batched `POST /v1/runners/me/status` and `/log`. `RunnerService` (schema v9: `runners`, `runner_commands`) routes a manager command to the most recently seen runner offering the seat, rejects it when that runner is offline (no poll for 90 s), expires unpicked commands after 2 min, rate-limits 30/min and keeps every command as an audit row. The live log is an in-memory ring of 300 entries per seat, pushed over the WebSocket. Service install writes a launchd agent / systemd user unit / logon task with an allowlist of env vars (no API tokens).

### Web-managed machines

Schema v10. `POST /v1/machines` creates a runner row (`m-…`) before anything is installed; `POST /v1/machines/:id/install-code` mints a one-use install code bound to it, and redeeming it creates a connector credential whose binding carries `machineId` — runner endpoints and session registration then act as that machine (`agents.machine_id`, used by `GET /v1/machines/:id/sessions` to suggest folders and session ids). The installer installs the runner service when the code is bound to a machine. `PUT /v1/machines/:id/config` stores the seat list (seat, absolute cwd, permission mode, optional session id, auto-start) with a version; a seat may be configured on one machine only. Runners long-poll commands with `version=<applied>`; a newer version returns at once and the runner fetches `GET /v1/runners/me/config` and applies it: new seats start, seats whose cwd/permissions/session changed restart (a given session id is written to the resume state), removed seats stop. Seats default to `bypassPermissions`, which the runner passes as `--dangerously-skip-permissions`. With `showWindow` (default on) starting a seat opens a desktop terminal running `runner watch <seat>` — a read-only renderer that follows the seat's session id and tails its transcript (`<claude config>/projects/*/<session>.jsonl`); a pid file prevents duplicates and turning the switch off closes it (macOS: `.command` opened in Terminal; Windows: `start`; Linux: first terminal emulator found when a display exists). Before starting a seat the runner asks `GET /v1/runners/me/seat-check`: it waits (showing why) while the session to resume still runs elsewhere or another live session holds the seat (live = not ended and seen within 3 min; wake polls count as contact). Saving a seat with a session that is still live in a terminal flags a takeover: that session's Stop-hook listener gets `taken_over` (older listeners get one short wake turn, after which the current hook runs) and sends SIGTERM to its Claude Code process (`CLAUDE_PID`); after its SessionEnd the runner resumes the session. Sessions already run by a runner are never flagged. Web-managed folders must exist and lie inside the machine's `allowedRoots` (local runner.json, default the home directory) — the runner refuses others and reports the seat as failed. Deleting a machine revokes its connector credentials.

## Telegram notifications

`TelegramNotifier` (enabled by `AGENT_OFFICE_TELEGRAM_BOT_TOKEN`) receives collab events: new permission prompts become messages with Allow/Deny inline buttons (`p:a|d:<id>` callback data), resolved prompts edit the message with the outcome; runner seats that turn `failed` are reported. Updates come from long-polling `getUpdates`; all Bot API traffic goes through `AGENT_OFFICE_TELEGRAM_PROXY` (undici `ProxyAgent` for http(s), `fetch-socks` for socks5). One chat is served, paired with a 10-minute code from the web UI (`app_settings`); callbacks from other chats are refused; decisions record `decided_by='telegram'`. Errors mask the token; logs mask proxy credentials. Max 20 messages/min.

## Public map and lobby

`GET /v1/public/map` (no auth, cached 2 s) returns the org and live agents through `publicMap`: seat descriptions, channels, session ids and project paths are removed and agent ids are replaced by per-response aliases; the client renders it read-only at `/map` for anonymous visitors. The lobby shows unseated sessions that have not exited, were not dismissed (`agents.dismissed_at`, schema v11, cleared on the next registration) and reached the daemon within 5 minutes (`isLobbySession`). Machine seats may set `model`, passed to `claude --model`.

## Model and working time

On Stop the hook reads the transcript tail (`transcript_path`) and sends the model of the latest non-synthetic assistant reply as `model` on `turn.stop`; the daemon stores it in `agents.model`. Working time is activity-based: every telemetry event adds the gap since the session's previous event (`agents.work_mark`, schema v14; at most 15 min per gap) to `seats.work_ms` of the seat the session sits in, unless that previous event was `turn.stop`, `session.end` or `permission.request`. Turns cut off without a stop (runner restart, crash) therefore still count, and idle time never does. Both appear on the 3D desk plates, map tooltips and the public map.

## Code map

| Path | Role |
|---|---|
| `src/server/collaboration/org-service.ts` | Departments, seats, membership sync, agent assignment |
| `src/server/collaboration/message-service.ts` | Channel posts, paging, read cursors, mentions, routing |
| `src/server/collaboration/wake-service.ts` | Wake rules, long-poll waiters, loop guard, reason text |
| `src/server/collaboration/task-service.ts` | Department tasks, permissions, system lines |
| `src/server/collaboration/blocker-service.ts` | Blocker records linked to tasks, resolve/reopen, thread lines |
| `src/server/collaboration/readiness.ts` | Pure readiness evaluation and grouping by root cause |
| `src/server/collaboration/dispatch-service.ts` | Persisted readiness, ready offers + ledger, owner queue, START, board |
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
