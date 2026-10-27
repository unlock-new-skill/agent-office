---
name: agent-departments-chat-real-session-smoke
created: 2026-10-24
plan: plans/261024-2152-agent-departments-chat
---

# Real-session smoke — Agent Departments Chat

## Environment
Claude Code 2.1.310, Node 24.11.1, temp data dir `/tmp/ao-smoke`, daemon on 127.0.0.1:8091, hooks/MCP via `--settings`/`--mcp-config` (user `~/.claude/settings.json` untouched).

## Verified facts (probes)
- MCP subprocess env has `CLAUDE_CODE_SESSION_ID` == hook stdin `session_id` → no `sessionKey` fallback needed.
- All hook payloads carry `prompt_id`, `cwd`, `session_id`.
- Stop hook `{"decision":"block","reason":…}` makes Claude continue with the reason; next Stop has `stop_hook_active: true`, same `prompt_id`. Hook `timeout: 600` accepted.

## Scenario results
| Step | Result |
|---|---|
| `npm run connect` (password via stdin) | connector.json written 0600 |
| Simulated SessionStart ×3 | self-registered, "not seated" context |
| Manager seats via API | ok; seat context includes specialty |
| Stop hook parked, manager `@dev-be` | hook returned `block` 0.04 s after post |
| MCP stdio (dev-lead): whoami, create_task, routing | ok; cross-dept task/channel → 403 with hint |
| **Real `claude -p` session** in `/tmp/ao-real` | registered → auto-seated as `dev-mobile` → Stop long-poll → manager `@dev-mobile reply PONG` → session woke and posted "PONG from mobile" in #dev via MCP as seat `dev-mobile` |
| Browser (agent-browser) | login, #leaders/#dev chat, @-autocomplete, realtime append, system task lines, Tasks tab, Org view, Unassign + "Assign session…" select all ok |
| Drag-and-drop | handler logic verified by dispatching DragEvents in page (assigned dev-fe); tool's mouse drag did not trigger HTML5 DnD → **needs manual check in a real browser** |

## Gates
`npm run build` ✓, `npm run lint` ✓, `npm test` 77/77 ✓, Postman lint 26 requests ✓.

## Unresolved / follow-ups
- Manual browser check of real mouse drag-and-drop and narrow (≤760px) layout.
- Pre-existing `npm audit` highs in `vite@8.0.0` and `ws@8.18.3` (not introduced here); bump separately.
- Sessions whose long-poll expired cannot be woken (by design) — shown as "idle — needs nudge".
