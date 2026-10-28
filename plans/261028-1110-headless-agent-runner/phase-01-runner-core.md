# Phase 1 — Runner core on the machine

Context: [plan.md](plan.md) · spike results there · existing connector `src/connector/*`.

## Requirements

- `agent-office.mjs runner` runs in the foreground (service wrapper comes in phase 4); `runner init` writes a sample config.
- Local config `~/.agent-office/runner.json` (0600):
  ```json
  { "seats": [ { "seatId": "dev-be", "cwd": "/Users/me/game/server", "permissionMode": "acceptEdits", "autoStart": true } ] }
  ```
  `permissionMode` ∈ `default | acceptEdits | plan` (default `acceptEdits`); optional `model`, `allowedTools` (passed to `--allowedTools`).
  Nothing else is configurable from the server.
- Per seat, a worker:
  - spawns `claude -p --input-format stream-json --output-format stream-json --verbose [--resume <id>] [--permission-mode …]`
    in `cwd`, env = parent env minus nested-session vars, plus `AGENT_OFFICE_SEAT=<seatId>` and `AGENT_OFFICE_RUNNER=1`;
  - starts the first turn with a short "you are seated, check your channels" prompt only when there is no saved session;
  - records `session_id` from the `system/init` message into `~/.agent-office/runner-state.json` for `--resume`;
  - when a turn ends (`result`), long-polls `/v1/wake` (same 60 s rounds/backoff as the Stop listener) with the session
    token the SessionStart hook stored, and writes the wake reason as the next user message;
  - on process exit: restart with `--resume` after backoff 2 s → 60 s; 5 crashes within 10 min → state `failed`;
  - exposes `start / stop / restart / interrupt / prompt` (interrupt = `control_request` interrupt on stdin;
    stop = close stdin, SIGTERM after 10 s; prompt = user message, queued if a turn is running).
- Stop hook: when `AGENT_OFFICE_RUNNER=1`, return `{}` at once — the runner owns waking.
- All stream-json parsing lives in one adapter module.

## Files

- Create `src/connector/runner/claude-process.ts` (spawn + stream-json adapter: send, interrupt, events).
- Create `src/connector/runner/seat-worker.ts` (lifecycle, resume, wake loop, restart policy).
- Create `src/connector/runner/runner-config.ts` (load/validate runner.json with zod, state file).
- Create `src/connector/runner/runner.ts` (owns workers; command dispatch; filled in phase 2 for the server link).
- Modify `src/connector/cli.ts` (modes `runner`, `runner init`), `src/connector/hook-runner.ts` (Stop skip under runner).
- Tests: `tests/unit/runner-seat-worker.test.ts` with a fake `claude` script (Node) that speaks stream-json:
  multi-turn, resume flag on restart, crash backoff and `failed` cap, interrupt, wake → new turn, config refusal.

## Validation

- Unit tests above; real smoke run on this Mac with one seat against a local daemon.

## Risks / rollback

- Protocol drift: adapter isolated; fake-CLI test pins the expected messages. Rollback = stop the runner, seats fall back
  to interactive sessions.
