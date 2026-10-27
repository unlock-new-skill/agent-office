---
phase: 3
title: Collaboration bus
status: in-progress
priority: P1
dependencies:
  - 1
  - 2
---

# Phase 3: Collaboration bus

## Overview

Implement scoped channels/threads, MCP inbox delivery, explicit receipts, independent blockers and advisory claims. Persisted message, transport attempt, receipt assertion and task completion must not be conflated.

Context: [shared API/auth/budget contracts](./plan.md). Red-team amendments: server-owned identity, observable delivery, blocker lifecycle, authority boundaries, deferred-response revocation.

## Requirements

- Manager and agents can chat; only members may receive channel/direct messages. Thread parent belongs to same authorized channel.
- Runtime derives caller identity from session-scoped credential. Explicit session selectors must match registered token binding; reject mismatches.
- MCP surface: `register_agent`, `list_agents`, `send_message`, `read_inbox`, `wait_for_message`, `acknowledge_message`, `set_status`, `report_blocker`, `resolve_blocker`, `claim_paths`, `release_paths`, `get_recent_activity`.
- Agent registry/activity lists expose only enrolled channel metadata, not raw transcripts or other inboxes.
<!-- Updated: Validation Session 1 - idle-agent delivery is queue-until-next-turn/poll only. -->
- Hook injection only at exact phase-1-proven events. An idle session with no hook/poll remains queued with visible age; do not create a polling/model loop to force a turn. No forced wake, Stop-loop, desktop-alert scope addition or permission bypass. Unsupported required injection stops the capability gate, not a silent replacement with transcript polling.

## Architecture

`MCP/REST -> authentication -> resource policy -> transactional service -> event store -> durable stream`.

Message sender role/source/identity comes from authenticated principal, never body fields. Client-supplied message ID/idempotency key is unique within principal and operation; identical retry returns result, conflicting payload returns 409. Create message, recipient records and event in one transaction. Late-joining members cannot receive old DMs through replay.

### Observable delivery state machine

| State | Evidence/actor | Transition |
|---|---|---|
| queued | Server durably stores message for authorized recipient | Eligible for next authorized hook/MCP attempt; idle has no delivery deadline |
| delivery_attempted | Server creates durable attempt ID and prepares/returns bytes; actual receipt unknown | May retry after lease, acknowledge explicitly, or fail on terminal routing/auth cancellation |
| acknowledged | Recipient explicitly calls ack with message ID + its issued attempt ID | Terminal receipt assertion; does not mean comprehension, execution or success |
| failed | Server proves recipient session terminated/revoked before ack, or manager cancels | Record reason; no automatic rerouting to another incarnation |

`read_inbox` and `wait_for_message` return attempts, not read receipts. Hook output written successfully is still an attempt, never guaranteed model presentation. Do not use `presented` or `read` as UI delivery claims.

Attempts have a 30s lease and per-recipient dedupe. Retry same message identity after timeout, with new attempt ID; record all attempts. Limit automatic presentation to three unacknowledged attempts; then hold `delivery_attempted` with needs-attention flag, not a false permanent failure. Explicit recipient fetch may request it again. Acknowledging any issued attempt for the same authorized recipient is idempotent and stops further retries. Lease expiry alone does not invalidate a late ack; credential/session revocation does. Crash windows allow duplicate presentation (at-least-once attempt semantics); never claim exactly-once model delivery.

`wait_for_message`: one/session, global 20, timeout 25s returning no-message response; reauthorize before deferred return, cancel on disconnect/expiry/revoke. No unlimited pending waits. Manager can see queued-age and last-attempt time.

### Blocker lifecycle

Blocker key includes session incarnation, kind and invocation ID or explicit report ID. Repeated source report updates same blocker, not a new incident. A new invocation/recurrence creates a new blocker. Explicit agent reports require `resolve_blocker`; permission blockers require matching lifecycle evidence; heuristics close when their evidence is invalidated. Terminal sessions cancel remaining blockers with reason, not success.

Manager acknowledgement/notes are annotations only. They never mark process healthy, grant permission or clear source blocker. Session status aggregates active invocations/blockers; an unrelated event cannot clear them. Agent `set_status` adds self-reported activity/note only and cannot override observed permission waits, contact loss or active blockers. Default heuristics: three failures of matching tool+operation within five minutes; five minutes silence while active with no open long-running invocation. Open long-running tools show duration/unknown progress, not an automatic confirmed blocker. All heuristic thresholds are configurable and labeled suspected.

### Claims and collaboration

Advisory paths are canonical project-relative paths scoped to an enrolled root; reject outside-root paths. Claims carry owner, TTL and evidence; release only by owner or manager administrative action. Expiration is visible. No deny/edit enforcement. Direct messages/replies show explicit collaboration; shared channel or claim conflict is labeled co-activity/conflict, not proof of joint work.

### Trust boundary

Bus content is untrusted input. Server renders trusted sender identity separately and rejects caller-asserted manager/system roles. Include scoped task/channel context and non-authoritative delimiters in injected summary, but never claim delimiters stop prompt injection. Messages cannot confer user consent, lift tool permissions or authorize reading secrets. Keep CLI permission/sandbox policy intact; no new arbitrary execution/egress tool in bus. Outbound message destination is membership-checked. If an agent already runs unsandboxed as the same OS user, model-driven filesystem/egress misuse remains outside bus enforcement; disclose this, test prompt attempts, do not promise isolation that runtime cannot supply.

## Related Code Files

Create under `/Users/truongpham/Desktop/my-studio/`:
- `src/server/collaboration/`, `src/server/mcp/`, `src/shared/contracts/collaboration.ts`.
- `tests/unit/collaboration/`, `tests/integration/mcp/`, `tests/integration/inbox-delivery/`.
Modify: auth/db/events/WebSocket modules, the Claude adapter and capability documentation.

## Implementation Steps

1. Migrate channels/memberships/messages/recipients/attempts/receipts/blockers/annotations/claims with ownership constraints.
2. Implement role/resource policy and owner-bound per-session MCP provisioning; test identity spoofing before adding message behaviors.
3. Implement transactionally persisted chat/thread routing and dedupe.
4. Implement attempt/lease/ack state machine, terminal handling, bounded waits and revocation.
5. Implement exact verified inbox hooks; if pinned runtime changes, disable unsupported integration with visible error, not false delivery.
6. Implement independent blocker recurrence/annotations and advisory claims.
7. Add authenticated provenance and untrusted-input rendering; preserve CLI permission policy.
8. Update OpenAPI/AsyncAPI/Postman contract and add negative/recovery tests before UI delivery.

## Success Criteria

- [ ] Valid agent token cannot claim another sender/session, read another inbox/transcript, alter maps/membership or write another agent status.
- [ ] Manager-to-agent and agent-to-agent channel/thread chat works between verified Claude Code sessions.
- [ ] Idle/no-poll session remains queued; ack is explicit and separate from task success.
- [ ] Lost response, crash before/after attempt commit, duplicate fetch/ack, and retry cap retain truthful state.
- [ ] Revocation/expiry cancels live wait and prevents deferred unauthorized delivery.
- [ ] Manager annotations do not clear permission or self-reported blockers.
- [ ] Repeated/overlapping failures produce scoped blockers; unrelated tool completion does not clear them.
- [ ] Malicious sender/manager-authority claims fail server policy; prompt injection residual limits are documented.
- [ ] Claims remain advisory; membership and path bounds pass negative tests.

## Risk Assessment

- Model receipt is not comprehension. Explicit ack is only an assertion by authenticated recipient.
- Same-user unconfined agent execution is not isolated by tokens or prompt formatting.
- Delivery while idle is intentionally deferred until next verified hook/poll; show this prominently.
