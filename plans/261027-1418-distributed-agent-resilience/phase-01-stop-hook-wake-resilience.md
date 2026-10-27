---
phase: 1
title: Stop-hook wake resilience
status: completed
priority: P1
dependencies: []
---

# Phase 1: Stop-hook wake resilience

## Overview
Stop hook does one `GET /v1/wake` and returns `{}` on any error (`src/connector/hook-runner.ts:57-66`). A dropped connection, daemon restart (`shutdown`) or waiter cap (`busy`) ends listening permanently. Make the hook keep trying until its own deadline.

## Requirements
- Stop hook loops until `deadline = start + wakeWaitSeconds`:
  - `wake:true` → return `decision: block` (unchanged).
  - `wake:false` with `timeout` → return `{}` (real idle, unchanged).
  - `wake:false` with `paused` / `unseated` / `wake_limit` → return `{}` (intentional, no retry).
  - network error, 5xx, 429, `shutdown`, `busy`, `aborted` → backoff (2, 4, 8, 15, 30 s cap, jittered) then retry with `wait = remaining`.
  - 401 → re-register once through the connector (`ensureSession(..., forceRegister=true)`), then retry; second 401 → `{}`.
- Never exceed the hook `timeout` (600 s): stop retrying ≥15 s before it.
- `/v1/wake` must return the `state` field in its JSON (check `office-routes.ts:94`; add if missing).

## Files
- Modify: `src/connector/hook-runner.ts`, `src/server/office-routes.ts` (only if `state` not exposed)
- Tests: `tests/unit/claude-hook.test.ts` (fake fetch: error→success, shutdown→wake, 401→re-register, timeout→no retry, deadline respected with fake clock)

## Steps
1. Write failing unit tests above (inject clock/sleep through `HookDeps`).
2. Extract `waitForWake(session, deps)` loop in hook-runner; keep `runHook` fail-open.
3. Add `sleep`/`now` optional deps (default real).
4. `npm test && npm run lint`.

## Risks
- Retry while daemon is down keeps the Claude Code process in Stop longer — bounded by deadline, same as today's wait.
- Re-register mints a new token and revokes the old one; MCP stdio reads the session file per call (verify) so it picks up the new token.
