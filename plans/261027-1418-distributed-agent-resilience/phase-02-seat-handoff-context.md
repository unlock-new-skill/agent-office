---
phase: 2
title: Seat handoff context
status: completed
priority: P1
dependencies: []
---

# Phase 2: Seat handoff context

## Overview
Work context belongs to the seat, not the session. A session that claims seat S (any machine, fresh start, resume or after compaction) gets enough state to continue S's work.

## Requirements
- Storage: `seat_handoffs(seat_id TEXT PK REFERENCES seats ON DELETE CASCADE, body TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)` — `updated_by` = agent id or `manager`. Body ≤ 8000 chars.
- Schema bump v3 → v4 with additive in-place upgrade (same pattern as `database.ts:64`); fresh DB gets the table in the CREATE block.
- MCP tool `agent_office_save_handoff({ body })` — seated agent overwrites its seat's note. `agent_office_whoami` returns the note.
- REST: `GET/PUT /v1/seats/:id/handoff` — manager (any seat) or the seated agent (own seat only).
- Handoff brief (server-built, ≤ 4000 chars, returned by `/v1/me` for agents as `handoff`):
  1. Seat note (truncated) + age.
  2. Open tasks assigned to S (`todo`/`doing`/`blocked`, ≤10, title + status).
  3. Unread count per channel and whether any unread item would wake S.
- SessionStart hook appends the brief to `additionalContext` for every `source` (startup/resume/clear/compact).
- Instructions: `seatContext` + `agent-guide` + wake reason footer tell agents to call `agent_office_save_handoff` when they finish or pause a task, and before ending a long session.
- UI: seat card shows note age; seat edit dialog shows/edit note (manager).

## Files
- Modify: `src/server/db/database.ts`, `src/server/collaboration/org-service.ts` (or new `handoff-service.ts` if org-service exceeds ~200 lines), `src/server/collaboration/office.ts`, `src/server/office-routes.ts`, `src/server/mcp-stdio.ts`, `src/shared/contracts.ts`, `src/shared/agent-guide.ts`, `src/connector/hook-runner.ts`, `src/server/collaboration/wake-service.ts` (footer only), `src/client/components/seat-card.tsx` + seat edit UI
- Update: `docs/api/openapi.yaml`
- Tests: unit (brief assembly, truncation, permissions), integration (agent A saves → seat reassigned to agent B → B's SessionStart context contains note), migration v3→v4.

## Steps
1. Verify SessionStart input `source` field on installed Claude Code version.
2. Failing tests → schema + service → routes/MCP → hook → UI.
3. `npm test && npm run lint && npm run build`.

## Risks
- Agents forget to save the note → brief still has tasks + unread; reminder in wake footer mitigates.
- Note may contain secrets pasted by agents → stored like messages, manager-visible only; no extra exposure.
