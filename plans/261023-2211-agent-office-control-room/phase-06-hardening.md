---
phase: 6
title: Hardening
status: in-progress
priority: P1
dependencies:
  - 1
  - 2
  - 3
  - 4
  - 5
---

# Phase 6: Hardening

## Overview

Rerun integrated gates after each owning phase already passed its local contract. Validate real CLI integration, authorization, recovery, transcript lifecycle, API contracts, UI semantics, and the fixed 20-agent performance workload. Do not discover core feasibility only here.

Context: [shared contracts](./plan.md). Red-team amendments: measurable SLOs, overload/revocation tests, purge/restore, stream races, durable spool, negative authorization.

## Requirements

- Deterministic restart/crash/reconnect/replay, duplicate delivery, stale event, purge, restore, map conflict, route invalidation and no-route behavior.
- Contract tests cover every REST route, scopes, WebSocket atomic handoff/generation, MCP tools/ack/wait/revoke, storage policy/purge, and map revisions/restore.
- Security tests cover bootstrap race, route-level authz, session impersonation, token revocation, CSRF/Origin/Host, transcript roots/symlinks/FIFOs, prompt-injection authority, input limits, queue caps and dependency/shim integrity.
- Execute the exact seeded workload in plan.md, including warmup, historical database, per-agent transcript rate, 60s burst cadence, payload distribution and maximum map. Record reference hardware/OS/browser and repeat for Chrome/Safari; two connected clients.
- Apply plan.md SLOs: source-collector-admission-to-DOM p95 <= 500ms/p99 <= 1s; hook overhead p95 <= 50ms; zero durable accepted-event loss; combined daemon/connector RSS <= 1 GiB and growth <= 256 MiB; mean CPU <= one core; browser heap <= 512 MiB/client; p95 frame time <= 33.3ms. Separately measure fault recovery; 429/503 overload is not silently dropped traffic.
- Build/lint/test gates pass; no secrets/raw private fixtures/local data committed.
<!-- Updated: Validation Session 1 - all release SLOs are mandatory, including internal-ready use. -->
- Any failed release SLO blocks release/handoff. Report measured result and threshold; optimize and rerun. Workload/scope/threshold changes require explicit user approval. No warn-and-ship internal exception and no automatic threshold adjustment.

## Architecture

Layer verification:

1. Unit: state machine, identity/dedupe, authz policy, adapters, checkpoints/purge fences, pathfinding, reducers, delivery states.
2. Integration: temporary SQLite, migrations, bootstrap, manual backup/restore, hook payloads, connector spool, MCP waits/revocation.
3. Real-session: Claude Code only in dedicated authorized test workspace; no production/project files.
4. E2E: Playwright against local daemon; assert DOM + state/event fixtures, not screenshots alone.
5. Load/soak: synthetic sessions at fixed workload; real CLIs smoke only. Track CPU/RSS/latency/drops/hook overhead/frame rate/disk.
6. Postman REST collection + WebSocket/AsyncAPI harness; collection schemas and environments follow installed Postman format skill.

### Recovery runbooks

- Daemon outage: hooks/spool remain non-blocking, drain after ack, disclose observation gap on overflow, reconcile current contact state.
- WebSocket: race event during subscribe, no-later-event case, publication wake loss, slow-client reset, generation mismatch and future cursor.
- Transcript: crash between row/FTS/checkpoint, partial JSONL, rotation, purge during tail, restore with suppression ledger.
- Restore: quiesce writers, validate schema/integrity, preserve current DB, rotate dataset generation, revoke credentials/reset clients, reconcile leases/maps, block raw service if purge ledger inconsistent.
- Map: stale ETag, dirty draft reconnect, restore generation, stale path result and destination deletion.

## Related Code Files

Create under `/Users/truongpham/Desktop/my-studio/`:
- `tests/unit/**/*`, `tests/integration/**/*`, `tests/e2e/**/*`, `tests/load/*`.
- `postman/collections/*`, `postman/environments/local.json`.
- `docs/architecture.md`, `docs/operations.md`, `docs/compatibility.md`.
Modify source only for verified failures; update plan/contracts first when behavior changes intentionally.

## Implementation Steps

1. Run phase-1 through phase-5 local gates before integrated run; preserve evidence/metrics.
2. Execute real CLI smoke tests with daemon unavailable/delayed, malformed, duplicated, out-of-order and unsupported payloads.
3. Execute authz/security matrix: valid credentials against wrong session/transcript/channel/map, bootstrap race, revoke live socket/wait, same-site CSRF, Host/Origin, path traversal/symlink/FIFO, prompt injection.
4. Execute transcript checkpoint/purge/quota/restore tests; verify app copies, search, replay, caches, suppression and excluded source/backups match contract.
5. Execute stream interleavings and backpressure: snapshot race, publication loss, slow client, future cursor, reset, duplicate deltas, 429/503/retry.
6. Run fixed 20-agent soak; report p50/p95/p99, hook overhead, CPU/RSS growth, dropped/observation-gap count, SQLite growth, queue maxima, frame rate.
7. Run Phaser editor/path tests: dirty draft/conflict/restore/map generation/stale routes/blocked map/reduced motion/DOM fallback.
8. Run Postman/AsyncAPI/Playwright contract gates; do not update collection to hide implementation drift.
9. Verify trusted shim absolute path, lockfile/integrity/native artifacts, `.gitignore`, no debug logs, docs/rollback/runbooks, and dependency licenses.

## Success Criteria

- [ ] All owning-phase security/recovery gates pass before final integration.
- [ ] Real Claude Code sessions pass registration, event, blocker, delivery attempt/ack, outage, purge and shutdown checks within supported matrix.
- [ ] Cross-session authorization and credential revocation tests pass for every route/tool/stream.
- [ ] Atomic snapshot/replay, duplicate/conflicting events, durable spool, checkpoint/purge, restore-generation tests pass.
- [ ] Fixed 20-agent workload meets every numeric SLO; failures include measured values, not vague “responsive” wording.
- [ ] `npm run lint`, `npm run test`, and `npm run build` pass.
- [ ] Postman REST, WebSocket/AsyncAPI and MCP schema tests pass.
- [ ] Playwright passes login/authz, blockers, truthful delivery, transcript purge, recovery, map conflict, route invalidation and pixel flows.
- [ ] Security review confirms no secrets/private fixtures and no unsupported secure-erasure claims.

## Risk Assessment

- Real-agent tests can mutate local sessions/files: dedicated test workspace, explicit command allowlist, backups and no user project paths.
- Synthetic load is not proof of model behavior; keep real sessions for smoke and disclose observation gaps.
- Plain raw transcript can fill disk; quotas pause ingestion and alert before control-plane capacity is threatened.
- New CLI versions can break hooks; installer checks compatibility and fails actionable, not silently.
