---
phase: 2
title: Session auto-register and MCP
status: completed
priority: P1
dependencies:
  - 1
---

# Phase 2: Session auto-register and MCP

## Overview
Remove manual per-session enrollment/env export. One-time connector credential lets every Claude Code session self-register on `SessionStart`. Rewrite MCP server so tools act as the seat the session is assigned to.

## Requirements
- Functional:
  - Manager creates connector credential once (`npm run connect` or UI button) → saved `~/.agent-office/connector.json` (0600).
  - `SessionStart` hook: read stdin `session_id`, `cwd` → `POST /v1/sessions/register` with connector bearer → daemon creates/reuses `agents` row (same `session_id` on resume = same agent) + agent credential → hook stores `~/.agent-office/sessions/<session_id>.json` (0600).
  - All other hooks resolve credential by stdin `session_id`; no `AGENT_OFFICE_*` env needed.
  - Manager assigns/unassigns session to seat: `PUT /v1/seats/:id/agent {agentId|null}`.
  - MCP tools: `whoami`, `list_channels`, `read_channel`, `send_message`, `wait_for_message` (tasks tools in phase 4).
  - Unassigned session calling tools → clear error "not seated yet, ask manager to assign".
- Non-functional: hooks fail-open (always print `{}` on error, keep spool behavior); hook p95 overhead not regressed.

## Architecture
- MCP identity problem: stdio MCP server is spawned by Claude Code without session_id.
  - Step 0 (verify): check whether Claude Code exposes session id to MCP subprocess env (e.g. `CLAUDE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID`). If yes → use it.
  - Fallback: `SessionStart` hook returns `hookSpecificOutput.additionalContext` "Agent Office sessionKey: <session_id>. Pass sessionKey to every agent_office_* tool." MCP tools take required `sessionKey`; server loads `~/.agent-office/sessions/<sessionKey>.json`.
  - Threat model: single local user; token files 0600; anyone able to read them already owns the machine. Accept; document.
- Credentials table: add kind `connector` directly in the v2 CREATE block (no migration; reset dev DB).
- `whoami` returns seat title, dept, role, **description**, channels. When seated, `SessionStart` `additionalContext` also includes seat title + description so agent knows its specialty from turn 1.
<!-- Updated: Validation Session 1 - sessionKey fallback approved; seat description in whoami/SessionStart; no migration -->
- MCP identity fallback approved: `sessionKey` via `additionalContext` (if env session id unavailable). **Not needed — see verification result below; not implemented.**
- Connector credential can only: register sessions, post telemetry for sessions it registered. Agent credential: seat-scoped collab endpoints.
- Bearer → actor resolution: `agent credential → agents.id → seats.agent_id → seatId`; no seat → `{kind:'unseated'}` → collab 403 `not_seated`.
- MCP server rewrite `src/server/mcp-stdio.ts` (keep `@modelcontextprotocol/server`, zod schemas). `wait_for_message` = long-poll endpoint from phase 3 with short default (60s).
- `scripts/install-claude-hooks.ts`: emit settings including `SessionStart` register + `Stop` wake hook (phase 3) + `mcpServers` snippet; still print-for-review, never auto-write `~/.claude/settings.json`.

## Verification result (2026-10-24, Claude Code 2.1.310)
Probe MCP server env contained `CLAUDE_CODE_SESSION_ID` equal to hook stdin `session_id` (also `CLAUDE_PROJECT_DIR`). → MCP resolves identity from env; `sessionKey` fallback dropped (`AGENT_OFFICE_SESSION_ID` env override kept for tests/manual runs).

## Related Code Files
- Modify: `scripts/claude-hook.ts`, `scripts/install-claude-hooks.ts`, `src/server/auth/auth-service.ts`, `src/server/app.ts`, `src/server/mcp-stdio.ts`, `src/server/db/database.ts`, `src/shared/contracts.ts`, `package.json` (add `connect` script)
- Create: `scripts/connect-local.ts`, `src/connector/session-store.ts`
- Tests create: `tests/unit/session-store.test.ts`, `tests/integration/session-register.test.ts`, `tests/integration/seat-assign.test.ts`, `tests/unit/claude-hook-identity.test.ts`

## Implementation Steps
1. Verify MCP env session id availability (spawn `claude` with a tiny MCP that logs env) — record result in this file.
2. **Tests first**:
   - register: connector token + new session → 201 agent; same session again → same agent id; enrollment/agent token on register → 401; revoked connector → 401.
   - session-store: writes 0600, reads by session id, rejects path traversal ids (reuse `path-validator`).
   - hook: SessionStart stdin → register call + file write; Stop/PreToolUse with unknown session → `{}` and gap logged, exit 0.
   - seat-assign: assign agent to seat; same agent to second seat → 409; unassign; seated bearer can post to own channel, unseated → 403 `not_seated`.
3. Implement until green; keep old enrollment endpoints working (tests rely on them) but unused by hooks.
4. Manual: run `npm run connect`, start `claude` in a project, see session in `GET /v1/org` unassigned list.

## Success Criteria
- [ ] New Claude session appears unassigned with zero per-session manual steps.
- [ ] Assigned session can `send_message` / `read_channel` via MCP within its routing rights.
- [ ] Hooks never exit non-zero / never block on daemon down.
- [ ] build/lint/test pass.

## Risk Assessment
- ~~`additionalContext` sessionKey relies on model passing arg correctly~~ — moot, identity comes from `CLAUDE_CODE_SESSION_ID`.
- Session resume creates new hook run with same session_id → must reuse agent, not duplicate. Covered by test.
- Credential CHECK change edits CREATE block; requires `npm run wipe -- --yes` on dev DB.
