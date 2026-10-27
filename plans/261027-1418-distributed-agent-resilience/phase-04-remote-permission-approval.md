---
phase: 4
title: Remote permission approval
status: completed
priority: P1
dependencies:
  - 3
---

# Phase 4: Remote permission approval

## Overview
`PermissionRequest` hook is installed with `timeout: 10` and only sends telemetry (`scripts/install-claude-hooks.ts:8-9`). Turn it into a long-poll: the request shows in the UI with Allow/Deny; the decision is returned to Claude Code. No decision → fall back to the terminal dialog.

## Requirements
- Step 1 verification (blocking): on installed Claude Code, confirm
  - output shape `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message"?}}}`;
  - whether the terminal dialog is visible while the hook runs (if not, keep wait short so a person at the terminal is not stuck);
  - maximum accepted hook `timeout`.
- Storage: `permission_requests(id TEXT PK, agent_id, seat_id NULL, tool TEXT, summary TEXT ≤2000, status 'pending'|'allowed'|'denied'|'expired'|'answered_locally', created_at, decided_at NULL, decided_by NULL)`. Schema bump with additive upgrade.
- Agent API (bearer): `POST /v1/permissions` (create from hook input: tool name + redacted/truncated input) → `{id}`; `GET /v1/permissions/:id/decision?wait=N` long-poll (reuse WakeService waiter pattern, own cap).
- Manager API (cookie + CSRF): `GET /v1/permissions?status=pending`, `POST /v1/permissions/:id/decision {behavior:'allow'|'deny', message?}`. Every decision logged (who/when) and pushed over WS (`collab` kind `permission`).
- Hook: when `AGENT_OFFICE_REMOTE_APPROVAL=true` on the daemon (exposed via `/v1/me`), create → wait up to `AGENT_OFFICE_PERMISSION_WAIT_SECONDS` (default 120) → return decision; timeout/error → `{}` (terminal dialog). Telemetry event still sent.
- Mark `answered_locally` when the next PostToolUse/PostToolUseFailure/Stop for that session arrives while still pending.
- Expire pending rows on session end and after wait window.
- UI: yellow seat shows tool + summary + Allow / Deny; pending badge in header; toast on new request.
- install-hooks prints PermissionRequest `timeout` = wait + 15.

## Files
- Create: `src/server/collaboration/permission-service.ts`
- Modify: `src/server/db/database.ts`, `src/server/collaboration/office.ts`, `src/server/office-routes.ts`, `src/server/config.ts`, `src/shared/contracts.ts`, `src/connector/hook-runner.ts`, `scripts/install-claude-hooks.ts`, `src/client/components/seat-card.tsx`, `src/client/state/office-store.ts`, `src/client/api/http.ts`
- Update: `docs/api/openapi.yaml`, `docs/api/asyncapi.yaml`
- Tests: unit permission-service (create/decide/expire/answered_locally/cap), hook (allow/deny/timeout/flag off), integration end-to-end via fake hook input, security (agent cannot decide, CSRF required).

## Security
- Approving = running commands on agent machines. Only manager session can decide; requires phase 3 deployed (HTTPS, Secure cookie, real-IP rate limit).
- Summary shown is truncated and stored; secrets in commands become visible to the manager — same exposure as the terminal today.
- No auto-allow rules in this phase.

## Risks
- If the terminal dialog is hidden while the hook waits, a local user cannot answer → mitigated by short default wait and the flag.
- Duplicate decision (UI + terminal) → first wins; later decision returns 409.
