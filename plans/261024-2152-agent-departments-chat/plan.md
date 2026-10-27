---
title: Agent Departments Chat
description: >-
  Local chat bus organizing Claude Code sessions into departments (channels,
  leaders, seats, tasks) with Stop-hook wake and Slack-like UI.
status: completed
priority: P1
branch: ''
tags:
  - feature
  - backend
  - frontend
  - api
  - database
  - tdd
blockedBy: []
blocks: []
created: '2026-10-24T15:09:43.935Z'
createdBy: 'ck:plan'
source: skill
---

# Agent Departments Chat

## Overview

Turn existing daemon into personal, local "radio.plasma.ai"-style company: departments (Dev, DevOps, BA, Design, extensible) each with own channel, 1 leader seat + N member seats; leaders share `Leaders` channel. Claude Code sessions self-register, manager drags them onto seats in UI. Stop hook wakes seats when relevant messages/tasks arrive. Slack-like UI + org chart.

Brainstorm (approved): [`../reports/brainstorm-261024-2152-agent-departments-chat-report.md`](../reports/brainstorm-261024-2152-agent-departments-chat-report.md)

Mode: `--tdd` — each phase writes failing tests first, then implementation. Existing 22 tests must stay green (auth/event/stream invariants are the regression lock).

## Key decisions

- Keep: Hono, `node:sqlite`, `AuthService`, `EventStore`, `WebSocketHub`, spool connector, hook normalizer.
- Replace: `CollaborationService`, `mcp-stdio.ts`, `src/client/*` main view.
- Freeze (no work, no deletion): Phaser `pixel-world.tsx`, SLO/benchmark, restore-generation extras.
- Identity: **seat** = durable position (dept + role). Session self-registers → "unassigned" → manager assigns to seat. Messages/tasks bind to seat.
- Routing: member → own dept channel; leader → own dept + `leaders`; manager → all. Server-enforced.
- Wake: Stop hook long-polls daemon; returns `decision: block` with unread summary. Guard: max consecutive auto-wakes, ignore own messages, per-dept pause.
- Out of scope: pixel office, headless spawn, Codex, LAN/remote, direct/DM channels, SLO benchmark.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Org schema and routing](./phase-01-org-schema-and-routing.md) | Completed |
| 2 | [Session auto-register and MCP](./phase-02-session-auto-register-and-mcp.md) | Completed |
| 3 | [Stop-hook wake](./phase-03-stop-hook-wake.md) | Completed |
| 4 | [Tasks](./phase-04-tasks.md) | Completed |
| 5 | [Chat and org chart UI](./phase-05-chat-and-org-chart-ui.md) | Completed |
| 6 | [E2E smoke and cleanup](./phase-06-e2e-smoke-and-cleanup.md) | Completed |

Order: 1 → 2 → 3 → 4 → 5 → 6. Phase 5 can start after phase 1 API is stable (mock-free: use real daemon).

## Acceptance criteria (whole plan)

- Seed from `office.yaml` creates DevOps(1)/Dev(6)/BA(2)/Design(5) = 14 seats with descriptions, each dept with channel; `leaders` channel auto-contains 4 leader seats.
- Member seat posting to another dept channel or `leaders` → 403.
- New Claude Code session appears as "unassigned" without manual env/token steps (after one-time connector setup).
- @mention to a seat whose session is in Stop-hook long-poll → session continues ≤2s.
- Loop guard stops two agents ping-ponging after configured limit; dept pause stops wakes.
- Leader creates task for member via MCP; member updates status; UI reflects realtime.
- UI: sidebar, chat, members/tasks panel, org chart with drag-assign, realtime without reload.
- `npm run build`, `npm run lint`, `npm test` pass.

## Validation Log

### Session 1 — 2026-10-24
Verification: claims checked 14 | verified 12 | failed 1 | unverified 1 (tier Full, sampled).
- FAILED → fixed: `tests/integration/security.test.ts` constructs `CollaborationService`; added to phase 1 modify list.
- UNVERIFIED (kept as phase step 1 checks): MCP env session id availability (phase 2); Stop hook max timeout / `stop_hook_active` (phase 3).
- Found: `Delta` is telemetry-only → collab delta union needed; WS snapshot capped 2MB → messages via REST.

Decisions:
1. Seed format: `office.yaml` + `js-yaml`.
2. DB: full reset, no v1→v2 migration; all schema changes edit single v2 CREATE block.
3. Leader wake: only on @mention / manager msg / task blocked|done — not plain member chatter.
4. MCP identity fallback: `sessionKey` via SessionStart `additionalContext` — superseded by verification: Claude Code passes `CLAUDE_CODE_SESSION_ID` to MCP subprocesses, so no fallback was built.
5. `vite.config.ts` proxy edit approved.
6. Wake limit default 15.
7. Seed shape: DevOps{Ops Lead}; Dev{Dev Lead, FE, BE, Unity, Mobile, Docs}; BA{BA Lead, BA Docs}; Design{Design Lead, Atom Asset, Map, Character & Monster, Item Art}.
8. Seat `description` field (yaml + UI editable), surfaced in `whoami` and SessionStart context.

Propagated: phases 1–6 (markers `Updated: Validation Session 1`).

### Whole-Plan Consistency Sweep
Searched for: migration v3/v2→v3, `migration-v2.test`, `dev-1`, "leader + 2 member", "backup before migrate", "ask before editing vite". All stale references updated. Unresolved contradictions: 0.

## Dependencies

- Supersedes `plans/261023-2211-agent-office-control-room` (mark `cancelled`/superseded once this plan starts; its Phase 1 core is reused).
