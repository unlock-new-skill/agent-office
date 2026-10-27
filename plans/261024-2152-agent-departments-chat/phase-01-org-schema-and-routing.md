---
phase: 1
title: Org schema and routing
status: completed
priority: P1
dependencies: []
---

# Phase 1: Org schema and routing

## Overview
Schema v2 for departments/seats/channels/messages, `office.yaml` seed, REST API, server-enforced routing rules. Collaboration changes are pushed as best-effort WS notifications; clients resync over REST.

## Requirements
- Functional: CRUD departments + seats (manager); list channels per viewer; post/read messages with seq; per-seat read cursor; `leaders` channel membership auto-synced from leader seats; mentions parsed `@seat-id`.
- Non-functional: **no data migration** — existing `./data` is reset (`npm run wipe -- --yes` + `npm run setup`); existing auth/event tests unchanged; only new dep: `js-yaml` (+ `@types/js-yaml` dev).
<!-- Updated: Validation Session 1 - DB reset instead of v1→v2 migration; js-yaml approved; seat description; seed shape -->

Seed shape (`office.example.yaml`, copied to `office.yaml` on first setup):
| Dept | Leader | Members |
|---|---|---|
| DevOps | Ops Lead (does all ops) | — |
| Dev | Dev Lead (coordinate/review, no direct coding) | Dev FE, Dev BE, Dev Unity, Dev Mobile, Dev Docs (repo docs for bug tracing) |
| BA | BA Lead (also main BA) | BA Docs (keeps docs updated) |
| Design | Design Lead | Atom Asset Designer, Map Designer, Character & Monster Designer, Item Art Designer |

Total 14 seats; `leaders` = 4 leaders. Each seat has `description` (specialty brief) from yaml.

## Architecture
Schema v2 (`src/server/db/database.ts`, `PRAGMA user_version=2`):
```
departments(id TEXT PK, name UNIQUE, color, sort INT, paused INT DEFAULT 0)
seats(id TEXT PK, department_id FK, title, description TEXT ≤2000, role CHECK(leader|member), agent_id NULL FK agents, consecutive_wakes INT DEFAULT 0)
  UNIQUE partial: one leader per department; agent_id UNIQUE when not null
channels(id TEXT PK, name UNIQUE, kind CHECK(department|leaders), department_id NULL FK)
channel_members(channel_id, seat_id, PK both)
messages(id PK, channel_id FK, seq INT, sender_kind CHECK(seat|manager), sender_id, body ≤16384, mentions_json, created_at)
  UNIQUE(channel_id, seq)
seat_reads(seat_id, channel_id, last_read_seq, PK both)
```
- No migration: rewrite `CREATE` block in `migrate()` to new schema, `PRAGMA user_version=2`. Existing v1 DB → throw `schema_reset_required` with message "run npm run wipe -- --yes && npm run setup". Later phases (2, 4) edit the same CREATE block (nothing shipped; reset dev DB between phases).
- `src/server/collaboration/org-service.ts`: departments/seats/membership sync. Invariant fn `syncChannelMembers()` rebuilds membership: dept channel = all seats of dept; `leaders` = all leader seats. Called after every seat/department mutation inside same transaction.
- `src/server/collaboration/message-service.ts` (replaces `service.ts`): `post(actor, channelId, body)` → `canPost(actor, channel)` → insert with next per-channel seq → append collab event to EventStore so hub publishes delta.
- Actor type: `{ kind: 'manager' } | { kind: 'seat', seatId }`.
- Routing rule (pure fn, `src/server/collaboration/routing.ts`):
  - manager → any
  - seat → channel where seat is member (member: own dept; leader: own dept + leaders)
- Realtime (as built): collaboration changes are NOT appended to the telemetry event log (its replay schema is telemetry-only). `WebSocketHub.broadcast` sends best-effort `{type:'collab', kind:'message'|'org'|'task'}` notifications; SQLite is the source of truth and the UI refetches REST state on every (re)connect. Snapshot gains `org` (departments, seats incl. description, channels); **messages are never in the snapshot** (WS snapshot capped 2MB).
- Seed: `office.yaml` at repo root (`office.example.yaml` committed, `office.yaml` gitignored), parsed with `js-yaml` + zod schema, loaded by `npm run setup` and `POST /v1/org/seed` only when DB has zero departments.

REST (manager = cookie+CSRF; seat = bearer from phase 2):
```
GET    /v1/org                         → departments, seats, channels
POST   /v1/departments                 {name,color}
PATCH  /v1/departments/:id             {name?,color?,paused?}
DELETE /v1/departments/:id             (only if no seats assigned to agents)
POST   /v1/departments/:id/seats       {title, role}
PATCH  /v1/seats/:id                   {title?, role?}
DELETE /v1/seats/:id
GET    /v1/channels/:id/messages?after=&limit=
POST   /v1/channels/:id/messages       {body}
POST   /v1/channels/:id/read           {seq}
```

## Related Code Files
- Modify: `src/server/db/database.ts`, `src/server/app.ts`, `src/server/index.ts`, `src/server/events/event-store.ts`, `src/shared/contracts.ts`, `scripts/setup-local.ts`, `scripts/reset-local.ts`, `tests/integration/security.test.ts` (constructs `CollaborationService` at lines 4/15/32 — switch to new services), `package.json`, `.gitignore`
- Create: `src/server/collaboration/org-service.ts`, `message-service.ts`, `routing.ts`, `seed.ts`; `office.example.yaml`
- Delete: `src/server/collaboration/service.ts`, `tests/unit/collaboration.test.ts` (replaced)
- Tests create: `tests/unit/routing.test.ts`, `tests/unit/org-service.test.ts`, `tests/unit/message-service.test.ts`, `tests/unit/seed.test.ts`, `tests/integration/org-api.test.ts`

## Implementation Steps
1. **Tests first** (all failing):
   - routing: member→own dept ok; member→other dept 403; member→leaders 403; leader→own+leaders ok; leader→other dept 403; manager→all ok.
   - org-service: create dept creates its channel; add leader seat → appears in leaders channel; second leader in same dept rejected; change role leader→member removes from leaders; delete seat removes membership.
   - message-service: per-channel seq monotonic; body >16384 rejected; mentions parsed only for existing seat ids; post emits collab delta with seq > previous.
   - schema: opening a `user_version=1` DB throws `schema_reset_required`.
   - seed: example yaml → 4 depts, 14 seats, descriptions stored; invalid yaml (two leaders in dept, unknown role) rejected by zod; second run no-op.
   - API: manager CRUD + 401 without CSRF.
2. Implement migration + services + routes until green.
3. Run full suite; existing 22 tests must pass unchanged (except replaced collaboration test).

## Success Criteria
- [ ] New tests pass; old tests green.
- [ ] Seed creates DevOps(1)/Dev(6)/BA(2)/Design(5) seats per table above; `leaders` has 4 members.
- [ ] Message post produces WS delta (verified by existing websocket test harness).
- [ ] `npm run build && npm run lint && npm test` pass.

## Risk Assessment
- `js-yaml` approved (already transitive in lockfile, ~40KB).
- Collab notifications are best-effort (no seq); a client that misses one resyncs from REST on reconnect.
- DB reset wipes manager password/credentials/telemetry; user approved. Optional `npm run backup` first.
