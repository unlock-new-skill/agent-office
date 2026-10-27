---
phase: 4
title: Control room
status: in-progress
priority: P1
dependencies:
  - 1
  - 2
  - 3
---

# Phase 4: Control room

## Overview

Build the React/Vite manager UI for authenticated operational state: agent/contact/activity view, blocker annotations, delivery truth, transcript search/purge, channel chat, and reconnect-safe WebSocket state. Pixel is not the only source of status.

Context: [shared contracts](./plan.md). Red-team amendments: authorization-aware views, atomic stream handoff, truthful delivery, blocker lifecycle, transcript purge, bounded queues.

## Requirements

- Manager-only login/logout, exact connection state, local-only warning, and raw-unencrypted-transcript warning.
- Enforce server scopes; never assume hidden controls equal authorization. Agent-facing UI, if exposed later, receives only scoped data.
- Filter agents by project/channel/source/contact/activity; inspector shows session incarnation, last event, contact lease, current invocations, blocker evidence, claims, inbox age and observation gaps.
- Blocker queue distinguishes confirmed, suspected, contact-lost and manager annotation. Acknowledge/notes never mark healthy or clear source blocker. Explicit resolve only where server policy permits.
- Timeline supports cursor/generation pagination, coverage/progress, event detail and replay reset. Purged transcript payloads never appear in events/cache.
- Chat shows only `queued`, `delivery_attempted`, `acknowledged`, `failed`. Never claim model read/comprehension. Only the authenticated recipient can acknowledge its own message receipt; manager cannot acknowledge on an agent's behalf.
- Transcript search/detail/purge is manager-only, opaque-ID based, escaped text, scope/size warning and explicit excluded-source/backups disclosure.
- WebSocket reconnect uses atomic snapshot/high-water protocol and generation-aware cursor; browser mutation uses CSRF/Origin/Host protections.
- Keyboard access, semantic labels, reduced motion, loading skeletons, inline errors; no native alert/confirm/prompt.
<!-- Updated: Validation Session 1 - preserve storage/queue UX and enforce applicable latency gates. -->
- Default transcript policy remains no age-based auto-delete; display quota pause and excluded source/backups explicitly. Idle chat shows queued age, never a promise of auto-wake.
- Failed UI latency gates block phase completion and release. Do not turn a failing metric into a warning-only internal release.

## Architecture

React state store owns authenticated snapshot, generation/watermark, deltas, replay state and commands. Apply deltas through reducer keyed by `(generation, seq)` and coverage frames. On gap, stop optimistic rendering, request bounded replay; on future/mismatched cursor, request fresh snapshot. Duplicate deltas are idempotent. Treat `seq` as server commit order, not contiguous order inside a filtered view.

REST handles commands/pagination; WebSocket handles state updates. UI does not call agent APIs directly. Connection state distinguishes connected, reconnecting, contact-lost, server-reset and unauthorized. On logout/revoke, clear browser state and close stream; server revocation is authoritative.

Keep `AgentInspector`, `BlockerQueue`, `ActivityTimeline`, `ChatPanel`, `TranscriptSearch`, `ConnectionStatus`, and `StorageWarning` independent of Phaser. All raw transcript content is text-only/escaped. Use DOM panels for every important canvas status.

### Blocker UI semantics

- Confirmed blocker: source evidence, invocation/report ID, since, last evidence, owner, clear rule.
- Suspected blocker: heuristic, threshold, confidence label, dismiss/annotate only; cannot imply permission wait.
- Contact lost: telemetry gap with contact timestamp, not offline unless server has verified exit.
- Manager annotation: separate note event; no source-state mutation.

### Delivery UI semantics

Show queued age, attempt count, last attempt, ack status and why no immediate wake occurred. `acknowledged` is recipient assertion only. Idle agent remains queued. Retry cap holds attempted messages with needs-attention; terminal routing failure/revocation shows explicit reason. Lease timeout is not a terminal expiry.

### Transcript purge UI

Show purge scope and confirmation: application rows/indexes/cache only; source CLI files and old backups excluded. After purge, invalidate affected views and block reload until suppression ledger state is confirmed. Do not present secure-erasure promise.

## Related Code Files

Create under `/Users/truongpham/Desktop/my-studio/`:
- `src/client/main.tsx`, `src/client/app/`, `src/client/control-room/`, `src/client/state/`, `src/client/api/`.
- `tests/unit/client-state/`, `tests/e2e/control-room/`.
Modify shared contracts only through intentional versioned contract changes.

## Implementation Steps

1. Create Vite React entry, authenticated view shell, CSP/static asset policy, theme tokens and accessible layout.
2. Implement login/session bootstrap, logout/revoke response, connection/observation-gap banner, and scoped data fetch.
3. Implement snapshot/high-water/replay reducer with generation, coverage, duplicate, reset and reconnect backoff handling.
4. Build agent list/filter/inspector with contact/activity separation and evidence links.
5. Build blocker queue with confirmed/suspected/contact-lost labels, annotation flow, explicit permitted resolution and recurrence display.
6. Build activity timeline with cursor/generation pagination, redaction and purged-content handling.
7. Build chat/channel/thread UI with auth-scoped recipient picker and truthful delivery state machine.
8. Build transcript search/detail/purge with escaped text, quota warning, suppression-pending state and manager authorization.
9. Add accessible loading/error/empty states, keyboard navigation, reduced-motion and server-down fallback.
10. Add semantic UI tests and browser E2E against local daemon, including event interleavings and authorization negatives.

## Success Criteria

- [ ] Manager login/logout and server revocation clear all browser data/live streams.
- [ ] Cross-session/channel data requests are denied server-side; UI never relies on hidden buttons.
- [ ] Snapshot event interleaving test shows no lost event, including no later event after race.
- [ ] Generation mismatch/future cursor/filtered coverage reset safely without regressions.
- [ ] Confirmed, suspected and contact-lost blockers remain distinct; manager annotation cannot clear source state.
- [ ] Chat exposes only observable delivery states and queues idle-agent messages truthfully.
- [ ] Transcript raw data is escaped, scope-authorized, searchable, purgeable and never replayed after purge.
- [ ] WebSocket/send queue overload yields recoverable reset, not browser freeze.
- [ ] All icon-only controls have accessible names; keyboard/reduced-motion paths work.
- [ ] UI meets event-to-UI p95/p99 budget under benchmark workload.

## Risk Assessment

- Dashboard can create false confidence; show evidence, source, timestamps, contact age and observation gaps prominently.
- Raw transcript XSS/secret exposure remains high-impact; text-only rendering, authz, purge fences and warnings required.
- Client state races require server generation/coverage, not local seq guesses.
- Large timeline use pagination first; virtualization only after measurement.
