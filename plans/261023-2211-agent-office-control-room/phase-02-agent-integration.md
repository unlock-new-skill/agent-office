---
phase: 2
title: Agent integration
status: in-progress
priority: P1
dependencies:
  - 1
---

# Phase 2: Agent integration

## Overview

Build adapters from phase-1 capability evidence, a trusted local connector with bounded durable telemetry spool, verified presence leases, and contained raw-transcript ingestion. Never invent missing CLI identity or delivery evidence.

Context: [shared contracts](./plan.md). Red-team amendments: recoverable fail-open hooks, contact ownership, invocation correlation, file containment, checkpoints/purge, trusted shim.

## Requirements

- The Claude Code integration uses only verified hooks and payloads from the pinned compatibility matrix.
<!-- Updated: Validation Session 1 - distinguish supported transport recovery from unsupported required capability. -->
- Telemetry handoff must persist locally before network acknowledgment. A verified shim may replace an unsuitable direct HTTP transport while retaining required behavior. Unsupported required lifecycle/inbox capability blocks the gate and needs a new user decision; observation gaps describe transient failures in supported integrations, not permission to omit a requirement.
- No permission bypass or hook failure that blocks CLI work. Hook latency must meet plan budget.
- Contact health and activity are independent; lack of events during permission wait is not offline.
- Raw transcripts remain full local plaintext as approved; quotas pause ingestion, never silently truncate records or delete CLI source files.

## Architecture

### Trusted shim and connector

Install versioned binaries/scripts at an owner-controlled absolute path outside agent workspaces. No dynamic `npx` downloads, relative imports, cwd-based executable resolution or PATH-dependent shim lookup. Display exact config merge/uninstall actions and ask before touching user CLI settings; preserve unrelated hooks and provide rollback.

Thin hook shim reads bounded stdin and normalizes sensitive raw tool payload to redacted telemetry; writes event with stable producer/incarnation/id to a private fsynced spool. A long-lived local connector drains idempotently with plan retry limits. Daemon returns durable commit acknowledgment before spool deletion. If transport ack is lost, retry same ID. Network never sits on synchronous hook critical path. Claude HTTP hooks may be used only where phase-1 evidence proves equivalent durable handoff and bounds; otherwise use the verified command shim. A stable trusted command does not replace review of executable updates or CLI hook trust requirements.

Spool exhaustion, unwritable disk, or killed shim before durable append creates an observation gap. Fail open, report local diagnostic, persist a gap marker when possible. Reconcile current process/contact state after recovery; never manufacture missing history. Raw transcript bytes are not copied to telemetry spool.

### Identity and presence

Connector is launched explicitly during onboarding and lives independently of daemon restarts. Register CLI process via verified session/run mapping and process start identity; do not trust `$PPID` blindly because a hook parent can be a shell. If proof is unavailable, contact is `unknown`. Sample live processes every 5s, TTL 20s; lost connector contact is `contact_lost`, verified process exit is `exited`. Store session incarnation and reject delayed lease renewal for retired runs. Reconcile persisted leases on restart.

Track active source invocation IDs. A permission blocker belongs to that invocation; a different tool completing cannot clear it. Matching permission resolution/tool completion or terminal turn/session evidence closes the corresponding blocker with a reason. Unknown invocation correlation stays unknown. Self-reported blockers close only through explicit owner resolve or terminal cancellation. Child agents without verified individual identity appear as labeled parent activity, not separately addressable agents.

### Transcript ingestion

Only trusted collector registration maps a source transcript to an authorized session. Enroll approved Claude Code transcript roots once through manager; never accept arbitrary paths from MCP/HTTP input. Validate real path and opened descriptor owner/type/identity, reject symlinks, replacement races, FIFO/devices and unrelated same-owner files. Store opaque transcript IDs; do not expose absolute file paths in public API responses.

Read bounded byte batches without skipping unread data. Keep generation-aware checkpoints keyed by file identity and offset. Complete record insertion, raw bytes, FTS entries, and checkpoint advancement commit atomically. Partial last JSONL record stays pending; rotation/copy-truncation becomes a new generation. Unknown formats preserve raw bytes and expose parser capability warning rather than inventing derived fields. Chunk large records under append cap; explicit error if unsupported, never silently truncate.

Raw data resides only in transcript rows/indexes; telemetry fields use redacted summaries. Private files/directories follow phase-1 permissions. Storage defaults and quota admission are authoritative in plan.md and confirmed in validation: plaintext, no age-based auto-delete, 10 GiB budget, pause raw ingestion at 8 GiB or <1 GiB free disk; purge covers application copies only, never source CLI files/backups. Paused ingestion resumes at checkpoint if source still exists; missing source/backfill records an observation gap.

### Purge

Manager-only idempotent DELETE persists a session ingestion fence/suppression tombstone before deleting app-owned transcript records and FTS entries. In-flight batches recheck generation inside transaction and cannot commit past fence. Notify clients to clear raw views; older event references become unavailable, not raw-content replay. Re-import stays disabled for purged session across restarts. Source CLI files and old backups are excluded and disclosed. No secure-erasure claim for WAL/disk. Maintain external suppression ledger used by restore; incomplete purge remains pending and raw reads blocked until ledger commit/reconciliation finishes.

## Related Code Files

Create under `/Users/truongpham/Desktop/my-studio/`:
- `src/adapters/claude/`, `src/adapters/common/normalize-event.ts`, `src/adapters/transcripts/`.
- `src/connector/spool.ts`, `src/connector/process-monitor.ts`, `src/connector/daemon-client.ts`, trusted hook entry points.
- `scripts/install-claude-hooks.ts`, installer rollback/uninstall commands.
- `tests/unit/adapters/`, `tests/integration/agents/`, `tests/integration/transcripts/`.
Modify: server HTTP/auth/events/db contracts and `docs/compatibility.md`, `docs/operations.md`.

## Implementation Steps

1. Consume phase-1 fixtures and capability matrix; recheck installed versions on setup, refusing unsupported capabilities with diagnostics.
2. Implement fixed shim/connector credential resolution, durable spool, retry/idempotency, observation-gap telemetry and bounded shutdown.
3. Implement enrollment/session credential binding and per-session MCP launch/config handoff, without making shared global credentials authoritative.
4. Implement explicit connector launch and process-incarnation monitoring; reconcile after agent/daemon/connector crashes.
5. Normalize invocation lifecycle, independent blockers and conservative parent/child state.
6. Implement transcript containment, atomic checkpoints, storage policy routes, raw search, quota pause/resume, and purge/restore ledger coordination.
7. Prepare inbox hook interface for phase 3; do not return success receipts before runtime evidence exists.
8. Add installer dry-run/merge/rollback and trusted-path integrity checks.
9. Run adapter failure, security and ingest-load gates now; phase 6 repeats them with the full UI.

## Success Criteria

- [ ] Real Claude Code sessions register under correct enrolled project/session; fresh events reach daemon/UI under plan latency targets while healthy.
- [ ] Idle/blocked live process stays live; connector loss marks contact lost, PID reuse/old heartbeat cannot resurrect a session.
- [ ] Overlapping same-tool completion never clears unrelated permission blocker.
- [ ] Daemon outage/ack loss drains durable spool without duplicates; spool/disk failures visibly disclose gaps and never block CLI.
- [ ] Trusted shim cannot resolve executable or dependencies from malicious working directory.
- [ ] Transcript root escapes, symlink swaps, FIFOs and unrelated same-owner files are denied.
- [ ] Crash between read/insert/checkpoint and file rotate/truncate cannot silently duplicate/skip raw records.
- [ ] Quota pauses backfill visibly; purge racing with active tail/search and daemon restart cannot resurrect covered app data.
- [ ] Restore preserves suppression or blocks transcript service pending reconciliation.
- [ ] Installer/uninstaller preserves unrelated configuration; real config edits approved separately.

## Risk Assessment

- Synchronous filesystem operations still cost time; measure hook p95/p99. Never promise zero latency or durability after spool failure.
- Process liveness proves contact, not model progress. Unknown metadata must remain unknown.
- Full raw plaintext is intentionally sensitive. App password does not encrypt files or secure another process running as the same OS user.
