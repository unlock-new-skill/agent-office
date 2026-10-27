---
title: Agent Office Control Room
description: >-
  Build a local password-protected collaboration bus and Phaser office for
  monitoring Claude Code sessions.
status: cancelled
supersededBy: 261024-2152-agent-departments-chat
priority: P1
branch: ''
tags:
  - feature
  - backend
  - frontend
  - api
  - auth
  - database
  - experimental
blockedBy: []
blocks: []
created: 2026-10-23T00:00:00.000Z
---

# Agent Office Control Room

> **Superseded (2026-10-24)** by [`261024-2152-agent-departments-chat`](../261024-2152-agent-departments-chat/plan.md). Phase 1 core (daemon, auth, event store, WebSocket hub) is reused there; collaboration, MCP and UI were rewritten. Pixel world and SLO/benchmark work are frozen.

## Overview

Build one local TypeScript application that connects Claude Code sessions through hooks + MCP, records normalized agent events and raw local transcripts, derives presence/blockers, exposes REST/WebSocket contracts, and renders a 2D pixel office with editable maps and free pathfinding.

Approved brainstorm: [`plans/reports/brainstorm-261023-2211-agent-office-control-room-report.md`](../reports/brainstorm-261023-2211-agent-office-control-room-report.md)

Target: internal-ready, local-only, password always enabled, 2–20 concurrent agents. No remote/cloud access or remote permission control in this plan.

## Scope rules

- **Current integration scope: Claude Code only**, explicitly selected by user after the Codex smoke test. No Codex adapter, installer, compatibility gate, or fallback is included. Earlier brainstorm and validation history retain the original decision for traceability.

- Core source of truth: daemon event model and SQLite; Phaser is a read/write map client only.
- Manager chat queues messages; MCP is pull-based. Do not promise model wake-up or instant push.
- Raw transcript is stored locally without encryption by explicit decision. Password protects app/network, not filesystem data.
- Heuristic blockers use `suspected` labels.
- Path claims advisory only; no automatic `PreToolUse` denial.
- Hook failures must never block Claude Code. Bounded local spooling recovers accepted hook records; disk/spool failure produces an explicit observation gap, never a complete-history claim.
- Password authenticates the manager; owner-issued scoped credentials authenticate local connectors and agent sessions. Agents never receive the manager password.
- Contact health (`connected`, `contact_lost`, `exited`, `unknown`) is independent of activity (`working`, `idle`, `blocked`, `error`, `stuck_suspected`). Missing telemetry is not proof of process exit.
- The contracts below incorporate the 14 red-team groups approved on 2026-10-24 and supersede conflicting preliminary brainstorm wording. No encryption, editor, pathfinding, or local-only decision is reversed.
- Validation confirmed: unsupported required CLI capability blocks schema freeze and dependent implementation; no silent feature removal or transcript-polling substitution.
- Validation confirmed: keep plaintext/local storage policy with no age-based auto-delete, quota pause and application-only purge; keep next-turn/poll-only idle delivery, without automatic agent wake.
- Validation confirmed: failed applicable performance gates block phase completion and release, including an internal-ready release. Optimize/retest or obtain an explicit new decision; no warn-and-ship or automatic threshold changes. Gates for components not built yet remain pending, never passed by omission.

## Pre-schema feasibility gate — beginning of phase 1

Before freezing schemas, prove the integration in an isolated test workspace. Record exact installed Claude Code version; documented hook names/config and real sanitized payloads; session/run/invocation correlation; normal and blocked process liveness; a next-turn inbox injection accepted by Claude Code; and measured hook overhead. No CLI behavior is claimed supported from research summaries alone.

Pin a compatible Node LTS, npm version, SQLite driver, Hono/WebSocket adapter, React/Vite, Phaser, and desktop browser matrix. Smoke-test native SQLite, migrations/FTS, WebSocket upgrade, and Phaser boot before full scaffold. Commit dependency locks; use reproducible installs and review native/install scripts. Initial release target is this macOS host with current stable Chrome and Safari; record exact OS/hardware/browser versions in benchmark output.

A session gets an individual identity only when the source provides a verified stable identity. Child agents lacking independent verified identity remain labeled activity under the parent, not separate inbox/token owners. Unsupported required hooks/injection or missing lifecycle correlation block contract freeze; surface evidence and ask before changing user-facing behavior.

Each phase owns its security/recovery tests. Phase 6 reruns integrated gates; core validation never waits for pixel-editor completion.

## Phase roadmap

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Core daemon](./phase-01-core-daemon.md) | In Progress |
| 2 | [Agent integration](./phase-02-agent-integration.md) | In Progress |
| 3 | [Collaboration bus](./phase-03-collaboration-bus.md) | In Progress |
| 4 | [Control room](./phase-04-control-room.md) | In Progress |
| 5 | [Pixel world](./phase-05-pixel-world.md) | In Progress |
| 6 | [Hardening](./phase-06-hardening.md) | In Progress |

All phases are P1. Dependencies and deliverables remain defined in each phase file: 1 → 2 → 3 → 4 → 5 → 6. Canonical status table restored because `ck plan check` refused to persist status against the expanded roadmap table; subsequent status changes must use CLI.

## Proposed repository layout

```text
package.json
src/
  server/
    app.ts
    auth/
    db/
    events/
    http/
    mcp/
    websocket/
  adapters/
    claude/
    transcripts/
  client/
    app/
    control-room/
    pixel-world/
    map-editor/
  shared/
    contracts/
    state/
    validation/
scripts/
  install-claude-hooks.ts
public/
  assets/pixel/
tests/
  unit/
  integration/
  e2e/
postman/
  collections/
  environments/
```

Use a single package initially. Split packages only if bundling or ownership requires it.

## API and event contracts

Contract-first. Define Zod schemas and generated OpenAPI/AsyncAPI descriptions from shared contracts. Keep a Postman collection for REST and a WebSocket test harness for deltas.

Event envelope fields:

```ts
{
  v: 1,
  id: string,                 // globally unique producer event ID
  producerId: string,         // authenticated connector, session, manager or daemon identity
  producerIncarnation: string,
  seq: number,                // server sequence, scoped to dataset generation
  datasetGeneration: string,
  ts: string,
  source: 'claude' | 'manager' | 'system',
  sessionId?: string,         // required and authenticated for agent events; absent for workspace events
  sessionIncarnation?: string,// required for agent events
  agentId?: string,
  parentSessionId?: string,
  turnId?: string,
  invocationId?: string,
  tool?: string,
  cwd?: string,
  project?: string,
  pid?: number,
  processStartIdentity?: string,
  kind: string,
  summary?: string,           // redacted, bounded metadata only
  transcriptRef?: string      // opaque reference; raw content stays in transcript store
}
```

REST baseline:

```text
POST   /v1/auth/login
POST   /v1/auth/logout
GET    /v1/me
POST   /v1/channels
GET    /v1/channels
GET    /v1/channels/:channelId
PUT    /v1/channels/:channelId/memberships # manager only; enrolled sessions
GET    /v1/channels/:channelId/events?cursor=&generation=
POST   /v1/channels/:channelId/messages
GET    /v1/channels/:channelId/messages?cursor= # authorized thread/message history
POST   /v1/messages/:messageId/cancel # manager; unacknowledged recipients only
POST   /v1/messages/:messageId/ack
POST   /v1/agents/enrollment           # authenticated manager only
POST   /v1/credentials/:credentialId/revoke # authenticated manager only
POST   /v1/agents/register             # enrollment/connector-bound; idempotent session registration
POST   /v1/credentials/renew           # refresh secret; same bound scope only
POST   /v1/transcripts/:sessionId/chunks # trusted collector only; opaque file ID/generation/offset
GET    /v1/agents
GET    /v1/agents/:agentId
POST   /v1/agents/:agentId/heartbeat   # token owner only
POST   /v1/agents/:agentId/events      # token owner only
GET    /v1/transcripts/:sessionId      # manager only; raw access never granted to agents
GET    /v1/transcripts/:sessionId/search
DELETE /v1/transcripts/:sessionId      # idempotent app-level purge
GET    /v1/maps
POST   /v1/maps
GET    /v1/maps/:mapId
PUT    /v1/maps/:mapId                 # If-Match/ETag required
GET    /v1/maps/:mapId/revisions
POST   /v1/maps/:mapId/restore         # If-Match + retained revision ID
GET    /v1/storage/policy              # manager only
PUT    /v1/storage/policy              # manager only
POST   /v1/blockers/:blockerId/annotations # manager notes; not operational clear
POST   /v1/blockers/:blockerId/resolve # owning agent, explicit self-reported blocker only
DELETE /v1/claims/:claimId             # owning agent or manager; audited reason
```

Every route and MCP tool has deny-by-default scope: manager, scoped connector/collector, or agent-session. Internal system events are daemon-owned, not a role callers may request. Agent tokens cannot read another session's private inbox/state or any raw transcript, mutate maps, or impersonate senders. Authorized channel member metadata and redacted shared activity remain readable. Resource membership is checked server-side; caller-supplied IDs are selectors, never authority. Browser mutations require exact allowed Origin/Host and CSRF protection. Agent bearer auth cannot fall back to browser cookies.

MCP tools:

```text
register_agent, list_agents, send_message, read_inbox,
wait_for_message, acknowledge_message, set_status, report_blocker,
resolve_blocker, claim_paths, release_paths, get_recent_activity
```

MCP session identity derives from the authenticated scoped token. If an explicit session selector remains necessary, registration-bound nonce/proof must match the token; otherwise reject. Live MCP waits re-check revocation before returning.

Delivery states are `queued`, `delivery_attempted`, `acknowledged`, `failed`; only observable facts are recorded. `delivery_attempted` means bytes prepared/returned to a hook or MCP caller, with receipt unconfirmed. `acknowledged` requires recipient's explicit message-ID/attempt-ID action and means receipt asserted, never comprehension or task completion. No `presented`/`read` claims. Detailed transition/lease/dedupe contract belongs to phase 3.

WebSocket uses an atomic subscribe/high-water protocol: register connection, capture snapshot watermark, replay after watermark, then accept live deltas; dedupe by `(datasetGeneration, seq)`. Reconnect uses `since=seq&generation=`; generation mismatch or future cursor forces fresh snapshot. Logout/expiry/revocation closes associated live streams and cancels associated waits; manager logout alone does not revoke independent agent credentials. Stale events cannot overwrite newer session/turn/invocation state.

## Cross-cutting security

- Bind daemon to `127.0.0.1` by default; allowlist Host and exact browser Origin.
- Password login always required; hash with a memory-hard password KDF; never store plaintext password.
- First-run setup is owner-run CLI only, atomic one-time initialization, with documented reset/recovery.
- Use HttpOnly/SameSite session cookie for web plus CSRF protection; separate short-lived scoped agent/MCP tokens.
- Validate/revoke live WebSocket and MCP wait sessions on logout, expiry, credential revocation, and scope changes.
- Keep hook secrets out of repository; install fixed shims at absolute trusted paths; use `0600` config and lockfile/integrity-verified dependencies.
- Transcript paths must map to server-authorized session records under approved CLI roots; `realpath`, no symlink/FIFO/non-regular files, no arbitrary caller path.
- Raw transcript remains unencrypted by explicit decision; enforce local permissions, total quotas, retention, purge fences, and UI warning.
- Never render raw transcript HTML without escaping; messages cannot grant manager/system authority or expand tool permissions.
- Resource authorization deny-by-default: manager, scoped connector/collector, and agent-session scopes; system events are internal only. Test cross-session and cross-channel denial.

## Cross-cutting performance and recovery

- SQLite WAL, indexed `events(seq, session_id, ts)`, indexed unread messages and transcript search.
- Batch high-frequency tool events; preserve semantic order per session and invocation.
- WebSocket snapshot/live handoff is atomic; reconnect from `(datasetGeneration, seq)`.
- Phaser reads derived state and throttles cosmetic animation separately from business events.
- Benchmark workload: 20 active synthetic agents at 10 events/s each for 15 minutes after 2-minute warmup, 10x one-second burst every 60s, event sizes 90% 2 KiB / 10% 22 KiB (4 KiB mean), one 64 KiB transcript append/agent every 5s. Start with 100,000 historical events + 512 MiB raw transcript, keep seed and workload fixed. Run one 128×128/1,000-object/20-avatar pixel client plus one timeline client; repeat Chrome/Safari with recorded hardware/OS/versions, AC power, background apps and viewport. Test fixtures remain isolated synthetic data.
- Release SLO on healthy load: source-collector admission to DOM status p95 <= 500ms, p99 <= 1s; hook p95 overhead <= 50ms measured against hooks disabled, p99 reported; no durably spooled/accepted-event loss after drain; combined daemon+connector RSS <= 1 GiB, growth <= 256 MiB from warmup, mean CPU <= 100% of one core; each UI JS heap <= 512 MiB; p95 frame time <= 33.3ms. Queue bounds remain mandatory. Fault-injection runs separately report outage/recovery latency and gaps rather than pretending normal-load latency holds during outages.
- Durable hook outbox is bounded. On overflow or disk failure, record `observation_gap` and expose it; never claim complete history.
- Phase 1–4 each owns its recovery/security gates. Phase 6 reruns integrated gates, not first discovery.

## Definition of done

- All phase success criteria pass.
- Claude Code sessions real-session integration passes.
- Server restart/reconnect/replay passes.
- Password, raw transcript warning/purge, and hook-failure isolation pass.
- Postman REST contract and WebSocket contract pass.
- Playwright verifies semantic UI state and not only screenshots.
- `npm run lint`, `npm run test`, and `npm run build` pass.

## Shared recovery and authorization contracts

### Credential policy

| Principal | Allowed | Denied |
|---|---|---|
| Manager browser | Own local workspace, map editing, transcript read/purge, membership/enrollment, annotations | Claiming a tool permission was approved; bypassing agent CLI policy |
| Scoped connector | Register verified sessions within enrolled projects/channels, ingest their telemetry and approved transcripts, renew owned leases | Manager routes, arbitrary file reads, other connectors' sessions, message sender impersonation |
| Session-bound MCP agent | Own inbox/status/explicit blockers/claims; send to members of assigned channels; channel messages and redacted activity | Raw transcript access, map writes, enrollment, other inboxes/claims/status, self-assigned memberships |

Tokens are random opaque secrets stored hashed server-side, scoped to principal/project/session incarnation, renewable only within original scope. One-time manager enrollment is short-lived and single-use. Runtime validates claimed session selectors against credentials; it never accepts an ID as proof. Local same-user filesystem compromise is outside these boundaries; this is not an OS sandbox for coding agents.

### Events, streams, and presence

- Event dedupe key: `(producerId, producerIncarnation, id)` plus canonical payload hash. Identical retry returns original seq; conflicting body returns 409. Reject retired session generations for live state; retain late valid records as historical only.
- Session incarnation, source invocation ID, and explicit blocker ID correlate tool starts/completions. Tool name and timestamp alone cannot clear unrelated permission waits. Missing source correlation remains unknown rather than guessed.
- Local connector is long-lived while monitored sessions exist. It samples verified `(pid, processStartIdentity)` every 5s and reports contact leases; TTL 20s marks `contact_lost`, not offline. Verified exit or SessionEnd marks `exited`. Unknown PID ownership/start identity yields `unknown`. Rebuild leases on daemon restart; delayed heartbeats cannot revive closed incarnations.
- Server stream subscription is registered before a transactionally consistent snapshot watermark H. Deliver snapshot H, then fetch durable events > H in bounded batches. Notifications wake the reader but are not delivery truth. Poll authoritative high-water every 1s to catch a missed final notification. Serialize delivery and dedupe; snapshot/live/replay share this mechanism.
- Global seq is not necessarily contiguous in a filtered subscription. Send cursor/progress frames over skipped records; clients use server coverage/high-water, not `seq + 1` assumptions. Purged payloads are never replayed.
- Manual backup/restore only: phase 1 owns supported CLI procedure. Quiesce ingest/writes, create validated SQLite backup plus storage manifest and suppression ledger; restore after schema/integrity check, retain previous database for recovery. Each restore rotates dataset generation, revokes credentials, resets clients, and reconciles sessions; never reuse cursor/ETag authority.

### Transcript containment and storage

- Raw content exists only in application-owned transcript storage/index, not event `raw` fields, hook spool, diagnostics, or WebSocket deltas. Event summaries are bounded/redacted; raw transcript bytes remain unredacted as approved.
- Trusted installed collector resolves source files inside manager-enrolled CLI transcript roots. Validate opened descriptor identity/owner/type, reject symlinks and path substitutions; no HTTP request may name an arbitrary file for reading. APIs use opaque transcript IDs.
- Checkpoints use file generation plus committed byte offset. Commit complete records, FTS entries, and checkpoint atomically; retain partial final record until complete. Rotation/truncation creates new file generation. Batch limit never skips unread bytes.
- Default storage policy: no age-based auto-deletion; 10 GiB application-data budget, pause new raw ingestion at 8 GiB or <1 GiB disk free and warn, preserving capacity for control events. Manager may set finite retention; preview deletion impact before applying. Never silently evict durable messages/events; stop admission visibly when budget is exhausted.
- `DELETE /v1/transcripts/:sessionId` fences this session's ingestion generation, deletes application transcript rows/indexes, suppresses re-import persistently, and invalidates raw UI caches. Workers recheck fence inside commit. Response includes purge ID, covered scope, and excluded source CLI files/backups. Never delete CLI-owned files.
- Purge removes current application access, not forensic bytes from SQLite/WAL/filesystem/backups or already exported copies. Preserve suppression ledger separately across backup restore; if ledger is missing or inconsistent, disable imports until manager explicitly reconciles. Restored raw rows covered by ledger must be removed before HTTP service starts.

### Resource budgets

- Body caps: 64 KiB event, 16 KiB message, 256 KiB transcript append, 2 MiB map; enforce before parse. Bound JSON depth and text lengths. Raw long records may be chunked across appends, never silently truncated; unsupported oversized records pause that stream with a visible error.
- Agent event admission: 20 events/s per session, burst bucket 200; global 500/s, burst bucket 2,000. Bounded concurrent writes; overload yields 429/503 and Retry-After, not silent drops. Connector spool can drain later.
- Global connector spool 256 MiB on this machine; fsynced append before network acknowledgment, idempotent drain, bounded exponential backoff (1–30s). Disk/overflow failures fail open but set an observation-gap marker when writable; warn locally if recording the marker also fails. No lossless claim before durable append.
- At most one active MCP wait/session, 20 total, 25s deadline; cancel/recheck auth on expiry/revoke. Replay at most 500 records/512 KiB per batch. WebSocket queue cap 2 MiB/connection, max 8 connections, close lagging clients with recoverable cursor reset. Limit login failures (5/min/IP and global 20/min); other manager routes have bounded concurrency.

## Red Team Review

### Session — 2026-10-24

14 deduplicated groups accepted by user; 11 High, 3 Medium; 0 groups rejected. These are plan contract defects, not proven runtime vulnerabilities. Reviewer Critical impersonation label adjudicated High: the original plan already required session binding, but lacked an enforceable design. Raw unencrypted transcripts and full editor/free pathfinding remain approved scope.

| # | Accepted finding | Applied to |
|---|---|---|
| 1 | Resource authorization, identity binding, atomic enrollment | In Progress |
| 2 | Atomic snapshot/durable live handoff | In Progress |
| 3 | Early capability gate, bounded hook spool | In Progress |
| 4 | Contact ownership, incarnation/invocation correlation | In Progress |
| 5 | Observable delivery and explicit acknowledgement | In Progress |
| 6 | Blocker lifecycle vs manager annotations | In Progress |
| 7 | Trusted transcript file boundary | Plan, phases 2, 6 |
| 8 | Transcript quota, atomic checkpoints, purge fences | Plan, phases 1–2, 4, 6 |
| 9 | HTTP CSRF/Host policy, live revocation | Plan, phases 1, 3–4, 6 |
| 10 | Authenticated sender and non-authoritative inbox | Plan, phases 3, 6 |
| 11 | Editor draft/revision contracts and route invalidation | Plan, phases 4–6 |
| 12 | Numeric workload/SLO and aggregate resource limits | Plan, phases 1–6 |
| 13 | Manual backup ownership and restore generation | Plan, phases 1, 5–6 |
| 14 | Trusted shim/dependency integrity | Plan, phases 1–2, 6 |

### Whole-Plan Consistency Sweep

- Files reread: `plan.md`, `phase-01-core-daemon.md`, `phase-02-agent-integration.md`, `phase-03-collaboration-bus.md`, `phase-04-control-room.md`, `phase-05-pixel-world.md`, `phase-06-hardening.md`.
- Decision deltas checked: 14 accepted findings; resource auth, scoped identity, atomic stream handoff, durable spool/observation gaps, contact/invocation correlation, delivery/ack semantics, blocker lifecycle, transcript containment/checkpoints/purge, CSRF/revocation, prompt authority, map revision/drafts/routes, measurable SLOs, manual restore generations, trusted shim integrity.
- Reconciled stale references: preliminary `presented/read` delivery labels, caller-authoritative session IDs, unbounded transcript/pixel semantics, late-only hardening, and vague performance thresholds.
- Unresolved contradictions: 0.

## Validation Log

### Session 1 — 2026-10-24

**Trigger:** User invoked `/ck-plan validate` after all 14 red-team groups were applied.
**Questions asked:** 4. All answered; no custom input.

#### Questions & Answers

1. **[Assumptions]** Nếu Claude Code hoặc Codex không cung cấp hook/inbox capability cần thiết trong version bạn dùng, plan nên xử lý thế nào?
   - Options: Stop schema freeze (Recommended) | Degrade visibly | Fallback transcript polling.
   - **Answer:** Stop schema freeze (Recommended).
   - **Rationale:** Stop phase-1 schema freeze and dependent work; disclose missing capability and require approval for CLI/version/contract changes. Do not remove acceptance criteria automatically.
2. **[Tradeoffs]** Xác nhận policy raw transcript local plaintext trong plan?
   - Options: Giữ policy hiện tại (Recommended) | Auto-retention | Mã hoá at rest.
   - **Answer:** Giữ policy hiện tại (Recommended).
   - **Rationale:** Plaintext local, no age-based auto-delete, 10 GiB budget, pause raw ingest at 8 GiB or <1 GiB free. Purge application copies only, excluding original CLI files and backups.
3. **[Architecture]** Manager gửi tin khi agent đang idle: UX/contract nào đúng?
   - Options: Queue until next turn (Recommended) | Desktop alert only | Attempt wake.
   - **Answer:** Queue until next turn (Recommended).
   - **Rationale:** Show queued age; await actual next turn or existing supported poll. No automatic model wake, Stop-loop or extra desktop alert feature.
4. **[Risks]** Chọn policy khi benchmark không đạt SLO p95 500ms/p99 1s, hook overhead p95 50ms, RSS growth 256 MiB, >=30 FPS?
   - Options: Block release (Recommended) | Warn, continue internal use | Auto-adjust threshold.
   - **Answer:** Block release (Recommended).
   - **Rationale:** Failed applicable gates block phase completion/release. Optimize/retest or obtain a new decision; never silently relax thresholds. The operative rendering gate remains plan.md's p95 frame time <=33.3ms; it expresses the 30-FPS target, not a guaranteed minimum for every frame.

#### Confirmed Decisions

- Capability unavailable: stop schema freeze; transient outage gaps are not a substitute for required support.
- Storage: retain explicit plaintext/no-auto-delete/quota/application-only-purge policy.
- Idle delivery: queue until next supported turn/poll; no automatic wake.
- SLOs: block applicable phase exit and release, including internal-ready release.

#### Verification Results

- Tier: Full by six-phase count; prior red-team evidence reused under validate workflow guard. No repeat reviewer fan-out.
- Repository facts checked: 3 — active plan pending with six phases; no package/source implementation yet; no literal `[UNVERIFIED]` tags in seven plan files. Verified: 3 | Failed: 0.
- Runtime unverified: CLI capabilities/version pins, package compatibility, performance targets. These are explicit phase-1/release gates, not inferred passes from absence of tags.
- Validation scope: document decisions/consistency only. No lint/build/runtime tests executed.

#### Action Items

- [x] Record all four answers and preserve approved product scope.
- [x] Propagate capability, storage, queue and blocking-gate decisions to all affected phases.
- [ ] Execute phase-1 capability and compatibility proof when implementation is separately authorized.
- [ ] Execute benchmarks in their owning phases and final hardening before release.

#### Impact on Phases

- Phase 1: hard capability/schema-freeze stop and applicable performance exit gates.
- Phase 2: verified shim fallback distinguished from unsupported features; confirmed storage defaults.
- Phase 3: next-turn/poll-only queue contract; no wake/extra alert scope.
- Phase 4: quota and queued-age UX; latency gates block completion.
- Phase 5: renderer fallback does not waive frame-time/resource gates.
- Phase 6: failed SLOs prohibit release/handoff; changes require explicit approval.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md`, `phase-01-core-daemon.md`, `phase-02-agent-integration.md`, `phase-03-collaboration-bus.md`, `phase-04-control-room.md`, `phase-05-pixel-world.md`, `phase-06-hardening.md`.
- Decision deltas checked: 4 validation answers; capability stop, plaintext/no-auto-delete storage, queue-until-next-turn delivery, blocking SLO policy.
- Reconciled stale references: unsupported fallback wording, idle delivery expectations, advisory performance language, and phase-specific storage descriptions.
- Unresolved contradictions: 0.

## Phase 1 Gate Log — 2026-10-24

- **Claude Code 2.1.310:** isolated no-op prompt passed. Captured `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`; payloads include session/prompt IDs, permission mode, transcript path, cwd, and final assistant message. Exit 0.
- **Codex 0.163.0:** isolated no-op prompt passed after removing unrelated global skill loading. Captured `SessionStart`, `UserPromptSubmit`, `SessionEnd`; payloads include session/turn/model/permission mode, transcript path, cwd, prompt and end reason. Exit 0, response `OK`.
- **Codex `Stop`:** synchronous isolated test did not terminate within 10 minutes; exact test processes were confirmed stopped at 2026-10-24 12:07 local time. Earlier termination claim was incorrect; root cause was not established. Async `Stop` did not appear in successful `codex exec` output.
- **Codex `PermissionRequest`:** not triggered by no-op read-only prompt; remains unverified.
- **External unrelated issue:** default Codex home loaded malformed `/Users/truongpham/.agents/skills/mb-bank-landing-page/SKILL.md`; no source/config change made. Temp `HOME` avoided it.
- **Historical result, superseded:** the dual-CLI gate was blocked. User subsequently selected Claude-only; Codex no longer gates this release. A hung process does not prove the Stop hook caused the hang.

## Scope Change — 2026-10-24

- User selected **Claude-only** after options Test Codex TUI/PTY | Adapt Codex exec | Claude-only, then requested continuation.
- Remove Codex from current contracts, source enum, files, installers and acceptance criteria. Keep historical research/smoke records, not active requirements.
- Preserve local-only/password/raw plaintext storage/full pixel editor/pathfinding and all validated release gates.
- Removing Codex does not mark phase 1 complete. Subsequent bounded Claude probes are recorded below; production guarantees remain gated.

## Claude Capability Evidence — 2026-10-24

- Isolated inbox/tool probe: exit 0, 7.95s, additionalContext nonce and local Read fixture both returned. PreToolUse/PostToolUse shared the same tool_use_id. SessionStart/UserPromptSubmit/Stop/SessionEnd observed. CLI reported cost USD 0.0131814.
- Isolated missing-file/permission probe: exit 0, 6.23s. Missing Read generated PostToolUseFailure with tool_use_id; forced ask produced PermissionRequest and the denial hook prevented reading. PermissionRequest had no tool_use_id, so exact invocation correlation is not guaranteed. Cost USD 0.0130462.
- Official MCP server/client 2.4.0 with Zod 4.6.7: direct stdio client initialized, listed and called identity_nonce. Claude subsequently discovered and called it with a session-scoped config/temporary exact-tool allowlist; exit 0, 8.69s, expected identity and nonce returned. Cost USD 0.0368084. Earlier MCP attempt was permission-denied, not a successful call (USD 0.0886328).
- These prove CLI capabilities, not production authorization. Server identity was an environment fixture, not an authenticated daemon credential. No real user hook/settings files modified; probes had hard process-group timeout/cleanup. Normal CLI-managed logs may still be created outside the scratch directories.
- Node 24.11.1 LTS (`process.release.lts=Krypton`) verified through nvm and pinned in `.nvmrc`/`package.json`. Commands in this session explicitly used the Node 24 path; global Node 26 remains installed but is rejected by runtime guard.

## Direct Evidence — 2026-10-24

- `npm run build`: pass under Node 24.11.1.
- `npm run lint`: pass.
- `npm test`: 22/22 pass, including authz/Origin, nonce registration, stale incarnation/rollover guards, independent blockers, structured/escaped redaction, replay continuation/purge filtering, WebSocket handoff/repair/revocation/publish recovery, buffer accounting, ordered stream repair, restore generation/credential reset, restore-journal interruption/sidecar recovery, and runtime boundary tests.
- Postman collection lint: pass, 11 requests.
- HTTP probes: malformed cookie 401; bad Host/Origin 403; oversized telemetry 413 after body drain; live backup rejected by daemon lock; one-time enrollment reuse 401.
- WebSocket probe: invalid cursor produced `snapshot` then explicit `reset`; authenticated normal snapshot pass.
- Recovery probe: manifest checksum/integrity, generation rewrite in event payloads, live-state reset, credential reset, and target WAL/SHM cleanup pass.
- No full benchmark, sustained hook-overhead measurement, browser matrix, or production Claude connector/token proof yet.

## Phase 1 Review Outcome — 2026-10-24

- Latest direct re-review: build/lint/tests/Postman clean under pinned Node 24.11.1. Additional verified recovery/stream defects were found after earlier clean-scope reports: old WAL/SHM could be reattached to a replacement database during restart recovery, and a later live notification could advance the stream watermark past a missed event. Those paths now have deterministic regressions. Green gates are evidence for exercised behavior, not blanket proof that every Phase 1 acceptance criterion is complete.
- Phase status remains **in-progress**, not complete. Pending gates are explicit plan requirements, not code regressions: production Claude connector/token proof, sustained permission-wait contact tracking, hook overhead measurement, full benchmark/SLO workload, and browser matrix.
- Current manager enrollment binds server-issued one-time registration to manager-declared Claude session identity + nonce. Source-level Claude process/session proof belongs Phase 2 connector integration; no remote/public trust claim is made in Phase 1.

## Unresolved verification gates

- Production connector/token proof, sustained permission-wait contact tracking, and Claude hook overhead remain unverified before schema freeze.
- Full benchmark/SLO workload and browser matrix remain unmeasured. Do not relax thresholds silently.
