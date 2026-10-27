---
phase: 3
title: Stop-hook wake
status: completed
priority: P1
dependencies:
  - 2
---

# Phase 3: Stop-hook wake

## Overview
When a seated session is about to stop, Stop hook long-polls daemon. Relevant unread item → hook returns `{"decision":"block","reason":...}` so Claude continues with the message. Guarded against runaway loops.

## Requirements
- Functional:
  - `GET /v1/wake?wait=<s>` (agent bearer): returns `{wake:false}` or `{wake:true, reason, items[]}`.
  - Wake triggers for seat S (sender ≠ S, message seq > S's wake cursor):
    - message mentioning `@S`
    - manager message in any channel S is member of
    - leader message in S's own dept channel (S is member)
    - task assigned to S / reassigned / commented (phase 4 adds source)
    - **Leaders are NOT woken by plain member chatter** in their dept channel — only @mention, manager msg, or task → blocked/done (phase 4). <!-- Updated: Validation Session 1 - leader wakes only on mention -->
  - Delivered items advance S's `seat_reads` for those channels (no double delivery).
  - Long-poll: resolve immediately if pending; else wait for in-process notifier up to `wait` (default 290s; must be < hook `timeout`).
  - Guard: `seats.consecutive_wakes` ++ per wake; reset on `UserPromptSubmit` hook event (human input) and when manager posts to S's channel. ≥ limit (default 15, config `AGENT_OFFICE_MAX_AUTO_WAKES`) → `{wake:false, reason:'wake_limit'}` + seat flagged in snapshot.
  - Dept `paused=1` → never wake its seats.
  - Unseated session → `{wake:false}` immediately.
- Non-functional: hook fail-open: daemon down/timeout → print `{}`; never error exit. Notifier must clean up waiters on request abort (no leak).

## Architecture
- `src/server/collaboration/wake-service.ts`: `pending(seatId)` pure query + `waitFor(seatId, ms, signal)` using `EventEmitter`/Map<seatId, Set<resolve>>; `MessageService.post` and task updates call `notify(affectedSeatIds)`.
- Hook (`scripts/claude-hook.ts`) on `Stop`: resolve credential by session_id → fetch `/v1/wake?wait=N` with `AbortSignal.timeout(N+5)` → if wake → stdout `{"decision":"block","reason":"<formatted>"}`; else `{}`. Also still spools Stop telemetry.
- Reason format (bounded 4KB):
  ```
  [Agent Office] 2 new items for seat dev-be (Dev BE):
  - #dev @dev-lead: "Please implement login API, task T-12"
  - task T-12 assigned: "Login API" (todo)
  Read full context with agent_office_read_channel, reply with agent_office_send_message.
  ```
- Installer: Stop hook entry with `"timeout": 300` (verify Claude Code max hook timeout in docs at step 1; adjust default wait accordingly).
- Snapshot: seat gains `wakeState: listening|idle|wake_limited` (listening = active long-poll).

## Verification result (2026-10-24, Claude Code 2.1.310)
Probe: Stop hook returning `{"decision":"block","reason":"...reply BANANA"}` made Claude continue and answer "BANANA"; next Stop carried `stop_hook_active: true` and the same `prompt_id` (no new UserPromptSubmit). Hook `"timeout": 600` accepted. All hook payloads carry `prompt_id`, `session_id`, `cwd`. → default long-poll 290s, installer timeout 600; guard reset on `turn.start` (UserPromptSubmit = human input only).

## Related Code Files
- Modify: `scripts/claude-hook.ts`, `scripts/install-claude-hooks.ts`, `src/server/app.ts`, `src/server/collaboration/message-service.ts`, `src/server/config.ts`, `src/shared/contracts.ts`, `.env.example`
- Create: `src/server/collaboration/wake-service.ts`
- Tests create: `tests/unit/wake-service.test.ts`, `tests/integration/wake-api.test.ts`, `tests/unit/claude-hook-stop.test.ts`

## Implementation Steps
1. Verify Claude Code Stop hook contract (`decision`/`reason`, `stop_hook_active`, max `timeout`) via docs; note in this file.
2. **Tests first**:
   - pending rules: mention wakes; plain member chatter doesn't wake other members nor the leader; manager msg wakes; leader msg in dept wakes members; own message never wakes; paused dept no wake; unseated no wake.
   - long-poll: waiter resolves ≤100ms after post; times out with `{wake:false}`; aborted request removes waiter.
   - guard: 15 consecutive → wake_limit; UserPromptSubmit event resets; manager post resets.
   - delivery idempotent: second call after delivery returns nothing.
   - hook: daemon down → `{}` exit 0; wake → valid block JSON; reason truncated at 4KB.
3. Implement until green.
4. Manual: two real sessions (dev-lead, dev-be); manager posts `@dev-be ...` → dev-be continues.

## Success Criteria
- [ ] Mention → listening session resumes ≤2s.
- [ ] Ping-pong between two seats halts at limit; UI shows wake-limited.
- [ ] Daemon stopped → Claude sessions stop normally, no hang beyond hook timeout.
- [ ] build/lint/test pass.

## Risk Assessment
- Session fully stopped after long-poll timeout cannot be woken → UI shows "idle, needs nudge" (accepted limitation).
- Long-poll holds HTTP connections: ≤20 seats, fine; cap concurrent waiters (e.g. 64) → excess returns `{wake:false}`.
- Model may ignore reason; mitigation: reason includes explicit next action.
