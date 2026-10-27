---
title: Distributed Agent Resilience
description: >-
  Keep seats usable when agents run on many machines: Stop-hook retry, seat
  handoff context, remote permission approval, and a hardened public VPS deploy.
status: in-progress
priority: P1
branch: ''
tags:
  - feature
  - backend
  - frontend
  - security
  - devops
blockedBy: []
blocks: []
created: '2026-10-27T07:18:00.000Z'
createdBy: 'claude'
source: chat
---

# Distributed Agent Resilience

## Overview

Agents run on several machines and connect to one daemon. Today: transcript context stays on the machine that ran it, a network blip during the Stop long-poll makes the seat fall asleep for good, and permission prompts can only be answered in that machine's terminal. Daemon is loopback/LAN-only by design.

Goal: (1) Stop hook survives blips/daemon restarts, (2) a seat carries a handoff so a fresh session on any machine picks up the work, (3) manager approves/denies permission prompts from the UI, (4) daemon runs on a small VPS behind public HTTPS.

## Key decisions (from chat 2026-10-27)

- Scope: all three proposals + VPS deploy.
- Listening: **retry only, no heartbeat** — no token spend while idle; sessions that exceed the wait window still need a nudge (UI already shows "idle — needs nudge"; Claude Code `/remote-control` documented as manual fallback).
- Network: **public HTTPS + domain** (Caddy auto-TLS). Not Tailscale.
- Context: handoff = seat note written by the agent + server-assembled state (open tasks, unread). Full transcript is NOT moved across machines; same-machine `claude --resume` keeps using the local transcript.
- Remote approval ships behind `AGENT_OFFICE_REMOTE_APPROVAL` (default off) and is only enabled in production after phase 3 hardening is deployed.
- Still out of scope: heartbeat wake, headless spawn / per-machine runner, per-seat auto-allow rules, multi-user manager accounts.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Stop-hook wake resilience](./phase-01-stop-hook-wake-resilience.md) | Completed |
| 2 | [Seat handoff context](./phase-02-seat-handoff-context.md) | Completed |
| 3 | [Public deployment hardening](./phase-03-public-deployment-hardening.md) | Completed |
| 4 | [Remote permission approval](./phase-04-remote-permission-approval.md) | Completed |
| 5 | [VPS deploy and docs](./phase-05-vps-deploy-and-docs.md) | In progress — files ready, VPS deploy pending |

Order: 1 → 2 → 3 → 4 → 5. Phases 1 and 2 are independent of each other and of the deploy; 4 depends on 3 (approval over public internet requires hardening); 5 needs a VPS + domain from the user.

## Acceptance criteria (whole plan)

- Daemon restart or a ≤60 s network drop while a seat is parked in Stop → seat is listening again within the original wait window, no manual nudge.
- New session (any machine) that claims seat S receives S's handoff note + open tasks + unread summary in SessionStart context; `startup`, `resume`, `compact` sources all get it.
- With remote approval on: permission prompt on agent machine appears in UI ≤2 s; Allow/Deny in UI resolves it in Claude Code; no decision within wait window → normal terminal prompt (fail-open).
- Daemon serves only via `https://<domain>`; host/origin/WS checks accept the public origin; session cookie `Secure`; login rate-limit keyed by real client IP.
- VPS footprint: 1 vCPU / 1 GB RAM sufficient (target idle RSS < 150 MB); nightly backup of the data volume.
- `npm run build`, `npm run lint`, `npm test` pass; existing 81 tests stay green.

## Unverified (checked in phase step 1 before coding)

- PermissionRequest hook output shape (`hookSpecificOutput.decision.behavior`) and whether the terminal dialog is shown while the hook is still running — decides the approval wait length (phase 4).
- Max allowed hook `timeout` for PermissionRequest (phase 4).
- SessionStart `source` values available in hook input (phase 2).

## Validation Log

### Session 1 — 2026-10-27
- Domain: `my-studio.victorpham.dev` (currently resolves to 216.198.79.1, a Vercel address; must point at the VPS).
- `/join/:id` and `/agent-guide` require a manager or agent session (user decision).
- Claude Code docs (hooks reference): PermissionRequest output `hookSpecificOutput.decision.behavior` allow|deny (+`message` for deny); the hook runs when Claude Code is about to ask, so the terminal dialog appears only after it returns → wait is per agent machine (`AGENT_OFFICE_PERMISSION_WAIT_SECONDS`, default 120, 0 = off). Command hook default timeout 600 s. SessionStart sources: startup/resume/clear/compact/fork.
- Parallel subagents share one session id, so several prompts per agent may be pending (cap 8) instead of superseding.
- Prod image smoke (local container, public origin): Secure cookie, HSTS, CSP, foreign Origin 403, unauthenticated `/join` 401, idle RSS ≈ 39 MB, online `VACUUM INTO` backup OK.

## Open questions

- VPS host + SSH access (phase 5 deploy and real two-machine smoke test).
