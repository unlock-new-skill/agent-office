---
phase: 1
title: Core daemon
status: in-progress
priority: P1
dependencies: []
---

# Phase 1: Core daemon

## Overview

First prove CLI/runtime feasibility; then build the local daemon, password bootstrap, scoped authentication, SQLite event store, and durable WebSocket replay. Security and recovery tests are phase exit gates, not deferred to phase 6.

Context: [approved plan and shared contracts](./plan.md). Red-team amendments: authorization/bootstrap, snapshot race, early feasibility, event correlation, resource bounds, backup ownership, dependency integrity.

## Requirements

<!-- Updated: Validation Session 1 - capability and applicable performance gates block handoff. -->
- Pass pre-schema feasibility gate for Claude Code, including source identity, required events, next-turn inbox injection, and overhead. Pin exact versions and record evidence. Unsupported required behavior stops schema freeze and dependent implementation; report missing capability and ask before changing CLI/version/contract. No automatic degraded release or transcript-polling substitute.
- Failures of applicable core/hook performance gates block this phase's completion. Later UI/render gates remain pending until their owning phase, not waived or implicitly passed.
- Pin Node/npm/SQLite/Hono/Vite/Phaser versions; minimal driver/FTS/upgrade/browser smoke checks before full scaffold.
- Local-only, password-required app with no unauthenticated HTTP setup endpoint.
- Server-owned identities; deny-by-default permissions for each REST/MCP/stream consumer.
- Atomic event persistence, stable dedupe, dataset-aware replay, and truthful activity/contact health.
- Local manual backup/restore supported; no scheduled backup service.

## Architecture

`Hono -> authentication -> resource authorization -> service -> repository -> SQLite`.

### Bootstrap and credentials

Owner-run interactive CLI initializes password atomically in a private data directory (`0700`, secret files `0600`, including database/WAL/SHM). Refuse daemon serving before setup completes. Hash password with a supported memory-hard KDF. Concurrent setup attempts must have exactly one winner. CLI reset requires owner access and daemon quiescence; revoke existing sessions/tokens, never recover plaintext passwords.

Manager enrollment issues one-time scoped connector credentials; a verified session registration mints a session-bound agent credential. Implement plan permission matrix. Store token hashes; reject mismatched project/session/resource selectors before service access. Registering a session does not authorize arbitrary identity claims. Per-session MCP config/launch context must carry its own credential; a shared global MCP token cannot impersonate all sessions.

Browser login yields random revocable server sessions, not tokens derived directly from password. Use HttpOnly/SameSite cookie, exact Origin + Host checks, and CSRF defense for browser mutations. Keep API bearer validation separate. Bind active sockets/waits to session IDs; expiry/logout/revoke cancels associated live work. Manager logout does not terminate unrelated agent credentials; explicit credential revoke does. Test cookie settings on supported loopback browsers; never expose this HTTP-only mode on LAN.

### Event transaction and ordering

Persist event, canonical payload hash, unique producer key, current derived projection, and assigned seq in one transaction. Duplicate identical event returns original result; conflicting duplicate returns 409. `seq` orders committed observations, not source causality. State uses session incarnation and source invocation IDs; keep active invocation set and independent blockers. Missing correlation is unknown. Retired-session telemetry can enter historical log but must not revive live state.

### Stream handoff

Register wake subscription, read projection + watermark H in one consistent database snapshot, send snapshot H, then query committed log after H. Only serialized database catch-up emits deltas; pub/sub notifications wake it. Poll high-water every 1s so missed final notifications cannot stall silently. Buffer/queue bounds follow plan; overflow closes socket and client reconnects from last confirmed cursor.

Cursor is `(datasetGeneration, seq)`. Filtered channels send coverage/progress over omitted events, avoiding false `seq + 1` gaps. Expired/future cursor or generation mismatch yields explicit reset. Revoked channels are removed immediately; raw transcripts never enter stream payloads.

### Backup/restore

Implement owner-run manual commands/procedure: pause collector/drain writes; create consistent SQLite backup, schema/storage manifest and suppression ledger; validate before replacing anything. Restore preserves current DB for rollback, merges current purge ledger, rotates dataset generation, revokes credentials, and reconciles contact leases. Future cursors and old map ETags fail. If purge ledger cannot be reconciled, do not expose restored transcripts or restart imports until manager resolves it. No blind copying of a live WAL database.

## Related Code Files

Create under `/Users/truongpham/Desktop/my-studio/`:
- `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, test/lint configuration; review config before creation as required by repo rules.
- `src/server/app.ts`, `src/server/auth/`, `src/server/db/`, `src/server/events/`, `src/server/http/`, `src/server/websocket/`.
- `src/shared/contracts/`, `scripts/setup-local.ts`, `scripts/backup-local.ts`, `scripts/restore-local.ts`.
- `tests/fixtures/agents/`, `tests/unit/events/`, `tests/integration/daemon/`, `docs/operations.md`, `docs/compatibility.md`.
- `postman/collections/` using schema supported by installed Postman CLI; load collection-schema skill before hand-authoring.

## Implementation Steps

1. In an authorized isolated workspace, capture sanitized fixtures and exact CLI injection/lifecycle matrix. Measure hook overhead and process-start correlation. No edits to real user CLI configuration without approval.
2. Prove runtime/package/native/browser compatibility; freeze lockfile and supported versions. Keep spike code only if it becomes real adapter/test code.
3. Establish scripts `dev`, `build`, `lint`, `test`, migration and manual operations commands. Fixtures are test-only, never app seed/fake production data.
4. Define schemas from proved capabilities and shared plan: auth scopes, credentials, event IDs, contact/activity, generation cursors, errors, bounded inputs.
5. Add schema migrations, setup/reset/enrollment, route-level policy and revocation registry.
6. Implement transaction/dedupe/projection and durable snapshot/replay mechanism with deterministic interleaving tests.
7. Implement aggregate resource budgets, input caps before parsing, admission/backpressure, and safe logs.
8. Define OpenAPI/AsyncAPI/Postman contracts, including later phases' ack, purge, storage policy, blocker annotations and map revisions. Do not expose unimplemented placeholder routes.
9. Add manual backup/restore and suppression-ledger protocol; test empty/current/previous supported schema upgrade, failed migration recovery, and restore generation changes.
10. Pass owning-phase security/recovery tests before beginning production adapters.

## Success Criteria

- [ ] Exact supported CLI/package/browser matrix proven; no required hook/injection assumed from memory. Current scope is Claude-only by explicit user decision. Bounded real probes passed inbox additionalContext, Read success/failure, PermissionRequest deny, and session-local stdio MCP tool discovery/call. PermissionRequest did not include tool_use_id; retain unknown correlation instead of guessing. Production token binding, sustained permission wait, hook overhead, LTS/runtime/browser compatibility remain pending. Codex is not a release gate.
- [x] CLI setup/reset is atomic; unauthenticated network client cannot initialize password or enroll agents.
- [ ] Valid agent credentials still fail cross-session, raw-transcript, map mutation and membership escalation tests; raw transcript/map routes are later phases.
- [x] Host/Origin/CSRF, login rate limits and live token revocation pass direct/unit checks.
- [x] Duplicate/conflicting events and overlapping same-tool invocations behave deterministically.
- [x] Append during snapshot setup and commit-before-notify failure both deliver final event; publish failure replay and WebSocket repair/handoff regression tests pass.
- [x] Filtered progress, slow clients, future cursors and dataset reset pass direct/unit checks.
- [x] Restore rotates identities, rewrites event envelope generation, preserves purge suppression, revokes credentials and resets live state.
- [ ] Core contract tests, lint, tests and build pass; benchmark admission/backpressure and Claude hook overhead remain before phase completion. Routes implemented in later phases receive policy/schema tests here and real endpoint tests in their owning phase; no premature claim of end-to-end coverage.

## Risk Assessment

- Claude 2.1.310 hook/MCP capability probes passed; full implementation, token authorization, hook-overhead and runtime/browser compatibility have not. Keep those gates explicit.
- Same-user OS compromise bypasses app credential files; authorization protects API boundaries, not arbitrary local execution.
- Private-directory permissions must cover WAL, temporary files and backups, not SQLite file alone.
- Backup/purge semantics are application-level access guarantees, not forensic secure erase.
