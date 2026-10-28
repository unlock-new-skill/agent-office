# Phase 2 — Server: runner registry, commands, live log

Context: [plan.md](plan.md) · `src/server/install-routes.ts` (connector credential), `office-routes.ts`, `db/database.ts` (v8).

## Requirements

- Schema v9: `runners(id, machine, connector_id, seats_json, last_seen_at)`,
  `runner_commands(id, runner_id, seat_id, kind, text, status, result, requested_by, created_at, done_at)`.
- Runner auth: connector credential → `POST /v1/runners/register { machine, seats:[{seatId, permissionMode}] }` →
  runner token. Seats offered by a runner are only those in its local config; server rejects unknown seat ids.
- Command channel (runner → server, outbound only): `GET /v1/runners/me/commands?wait=60` long-poll (≤ 60 s rounds for
  Cloudflare), `POST /v1/runners/me/commands/:id/result { ok, message }`. Commands expire after 2 min if not picked up.
- Manager API: `POST /v1/seats/:id/runner-commands { kind: start|stop|restart|interrupt|prompt, text? }`
  (cookie + CSRF, rate-limited), `GET /v1/runner-commands?seat=` (audit list).
- Status: `POST /v1/runners/me/status [{ seatId, state: starting|running|idle|stopped|failed, sessionId, restarts }]`;
  runner presence = a command poll parked within the last 90 s (no heartbeat beyond the poll itself).
- Live log: `POST /v1/runners/me/log [{ seatId, ts, kind: text|tool|result|error, summary }]` (summary ≤ 500 chars, no
  tool outputs), in-memory ring of 300 per seat, pushed over WS; `GET /v1/seats/:id/log`.
- OpenAPI updated.

## Files

- Create `src/server/collaboration/runner-service.ts` (registry, command queue + waiters, log ring, presence).
- Create `src/server/runner-routes.ts`; wire in `src/server/app.ts`.
- Modify `src/server/db/database.ts` (v9 migration), `src/shared/contracts.ts` (RunnerSeatState, RunnerCommand, LogEntry),
  `docs/api/openapi.yaml`.
- Modify `src/connector/runner/runner.ts`: register, poll commands, report status/log (batched every 1 s).
- Tests: `tests/integration/runner-api.test.ts` (register, unknown seat refused, command round trip, expiry, audit,
  manager-only, log ring), migration test update.

## Validation

- Integration tests; `npm test`, lint, build.

## Risks

- Manager account becomes remote control for every machine → CSRF + rate limit + audit; commands carry no paths/env.
