---
name: agent-office-control-room-brainstorm
status: approved
created: 2026-10-23
updated: 2026-10-24
scope: internal-ready-local
---

# Agent Office Control Room

## Summary

Thiết kế local-first cho kênh giao tiếp Claude Code + Codex, presence/blocker tracking, raw transcript storage, và web pixel office 2D. Custom TypeScript daemon + Phaser renderer. Không fork pixel-agents/Agent-Quest.

## Problem-first

### Solution-jumping diagnosis

Nhiều coding agents chạy song song trong terminal riêng. Manager thiếu một operational view để biết agent nào đang làm gì, ai đang chờ, ai bị kẹt, và agent nào đang phối hợp.

### Underlying problem

Thiếu single operational view cho presence, activity, communication, blockers, ownership, và history của nhiều agents.

### Assumption challenges

| Assumption | Risk | Validation |
|---|---|---|
| Hooks bắt đủ lifecycle | Presence sai | Chạy Claude + Codex thật, kill process, reconnect |
| Agent đọc inbox | Message bị bỏ qua | Inject inbox summary ở lượt kế tiếp |
| Pixel giúp xử lý blocker nhanh hơn | Game đẹp nhưng ít giá trị | Đo time-to-find-blocker so với list/timeline |
| Raw transcript đáng giá | Lộ source/prompt/secret | Kiểm tra local access, purge, retention |
| Relationship suy ra từ event | Hiển thị sai collaboration | Chỉ tạo edge khi có message/reply/claim evidence |

### Problem statement

Manager cần theo dõi 2–20 agents local, xem presence/activity/blocker gần realtime, gửi message vào channel, replay history sau restart, và quan sát collaboration trong pixel office. Thành công khi manager xử lý blocker mà không cần mở từng terminal.

### Alternative framings

- **Agent control room:** presence, blocker, replay là core; pixel là view.
- **Agent social network:** channel/thread/identity là core; presence là metadata.
- **Agent game world:** map/movement/editor là core; bus là backend.

Chọn control room + social network làm core; game world làm visualization.

### Evidence status

Weak → medium. Có workflow need thực tế, Radio/pixel-agent patterns, và feasibility evidence; chưa có metric time-to-resolution.

### Validation plan

- Chạy Claude Code và Codex thật với hooks.
- Kill/restart daemon và agent process; kiểm tra TTL/replay.
- Đo hook overhead, event latency, message delivery ở next turn.
- So sánh xử lý blocker bằng list/timeline với pixel view.
- Soak test 20 agents.

### Stakeholder message

Xây một control room local cho agent trước; pixel office là lớp quan sát, không phải nguồn dữ liệu. Bus, event model, presence, và blocker phải dùng được kể cả khi tắt pixel.

## Approved decisions

- **Agents:** Claude Code + Codex.
- **Deployment:** local-only; 2–20 agents; không remote/cloud/multi-user trong build đầu.
- **Auth:** password luôn bật cho web/API/MCP.
- **Transport:** MCP + hooks.
- **Manager:** theo dõi + gửi chat; không remote permission control.
- **Stack:** TypeScript; Hono HTTP; SQLite WAL; WebSocket; Phaser renderer.
- **Pixel:** custom renderer; full map editor + free pathfinding.
- **Transcript:** raw local, không mã hoá theo quyết định user.
- **Assets:** Kenney CC0.
- **Base:** custom daemon + renderer; không fork pixel-agents hoặc Agent-Quest.

### Explicit security warning

Password bảo vệ app/network, không mã hoá SQLite. Ai đọc được filesystem có thể đọc raw transcript. Mitigation đã chốt: localhost-only, file permission `0600`, retention, purge, không expose remote. Raw transcript có thể chứa prompt, source, shell command, hoặc secret.

## Architecture

```text
Claude Code hooks ─┐
                   ├─> Event adapters ─> State machine ─> SQLite
Codex hooks/shim ──┘                              │
                                                 ├─> MCP server
Web UI <──────────── WebSocket snapshot/delta ───┘
```

### Control plane

- Hono HTTP API.
- WebSocket realtime.
- Password login, cookie/session for web.
- MCP token/session auth.
- SQLite WAL.
- Event replay by cursor/sequence.

### Agent adapters

- Claude HTTP hooks.
- Codex async command shim reading stdin and POSTing to daemon.
- Server-side normalization to one event envelope.
- Hook failure must never block or break agent CLI.

### Presence state

`online`, `working`, `blocked`, `idle`, `error`, `stuck_suspected`, `offline`.

### Blocker signals

Certain: permission request, explicit `report_blocker`, explicit error/stop failure, abnormal process exit.

Heuristic: repeated tool failure, silence while working, heartbeat loss, transcript not progressing. UI must label heuristic state as `suspected`.

### Collaboration relationship

Create agent-to-agent edge only from direct message, thread reply, shared channel activity, path claim conflict, or explicit recipient. Do not infer collaboration from simultaneous online state.

## API contract v1

### REST

```text
POST   /v1/auth/login
POST   /v1/auth/logout
GET    /v1/me

POST   /v1/channels
GET    /v1/channels/:channelId
GET    /v1/channels/:channelId/events?cursor=
POST   /v1/channels/:channelId/messages

POST   /v1/agents/register
GET    /v1/agents
GET    /v1/agents/:agentId
POST   /v1/agents/:agentId/heartbeat
POST   /v1/agents/:agentId/events

GET    /v1/transcripts/:sessionId
GET    /v1/transcripts/:sessionId/search

GET    /v1/maps/:mapId
PUT    /v1/maps/:mapId
```

### WebSocket

Initial snapshot:

```json
{"type":"snapshot","seq":182,"agents":[],"channels":[],"map":{}}
```

Incremental delta:

```json
{"type":"delta","seq":183,"event":{},"agent":{}}
```

Reconnect uses `?since=seq`; server replays missed events.

### MCP tools

```text
register_agent
list_agents
send_message
read_inbox
wait_for_message
set_status
report_blocker
claim_paths
release_paths
get_recent_activity
```

`claim_paths` advisory by default. Enforcement through `PreToolUse` is separate security scope.

## Pixel UI

- Top status bar: server/auth, online, working, blocked, alerts.
- Left panel: channels, agents, blockers, transcript.
- Center: Phaser pixel office.
- Right inspector: status, activity, current tool, chat.
- Bottom timeline: events, replay, filtering, search.
- Agent click focuses camera and inspector.
- Blocked agents show red marker and blocker queue entry.
- Recent collaboration shows route/line between agents.
- Map editor supports floor/wall/furniture, zones, desks, save/load.
- Navigation grid + A* handles free movement.
- Phaser only renders normalized state; business state remains daemon-owned.

## Data model

```text
users
auth_sessions
channels
agents
agent_sessions
events
messages
message_recipients
blockers
transcripts
maps
map_tiles
map_objects
path_claims
```

Event log is source for audit/replay. Presence, unread counts, blocker summaries are derived state.

## Build phases

1. **Core daemon:** auth, SQLite, event envelope, state machine, REST, WebSocket, replay/reconnect.
2. **Agent integration:** Claude hooks, Codex shim, registration, heartbeat/TTL/PID, normalization, inbox injection.
3. **Collaboration:** channels, threads, MCP tools, routing, manager chat, advisory path claims, blocker queue.
4. **Control room:** agent list, activity timeline, blocker panel, transcript search, chat, reconnect.
5. **Pixel world:** Phaser scene, Kenney assets, editor, collision, A*, avatars, relationship visualization.
6. **Hardening:** 20-agent soak, restart/replay, password/session tests, transcript purge, contract tests, Playwright state tests.

“No MVP” interpreted as internal-ready product, not one unsafe big-bang change. Phases remain dependency order.

## Acceptance criteria

1. Claude Code + Codex sessions register and show `online` under 1 second.
2. Tool events update status/avatar under 1 second.
3. Permission request shows `blocked` under 1 second.
4. Repeated failures/silence show `suspected` with reason and timestamp.
5. Manager messages appear in agent inbox summary on next turn.
6. Agent-to-agent MCP message appears as thread and relationship.
7. Restart preserves events, messages, map, and session summary.
8. WebSocket reconnect replays from cursor.
9. 20 agents keep UI responsive and do not materially slow CLI.
10. Map editor saves/loads layout; A* moves agents over valid routes.
11. Password is required for web/API/MCP.
12. Raw transcript supports search and purge; UI warns it is unencrypted.
13. Daemon failure never blocks or breaks Claude/Codex.
14. API has OpenAPI/AsyncAPI/Postman contract validation.

## Risks

- Raw plain transcript is sensitive and not protected at rest.
- MCP is pull-only; manager chat queues for next agent turn, not instant model push.
- Codex hooks can arrive out of order; daemon owns sequence.
- Full editor/pathfinding can consume effort; keep isolated from core.
- Claude/Codex CLI schemas can drift; adapters tolerate unknown fields and record CLI version.

## References

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Codex Config Reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)
- [Agent-Quest](https://github.com/FulAppiOS/Agent-Quest)
- [Radio overview](https://dev.to/damasosanoja/plasma-radio-lets-my-parallel-claude-code-sessions-share-one-room-4eil)

## Unresolved questions

- Minimum supported Claude Code and Codex versions.
- Whether raw transcript retention is fixed or configurable per channel/project.
- Whether path claims stay advisory permanently or later become enforceable.
- Whether Codex subagents need individual visual identities; current Codex hooks may report parent session IDs.
- Exact Phaser version and browser support matrix.
