---
phase: 4
title: Tasks
status: completed
priority: P2
dependencies:
  - 3
---

# Phase 4: Tasks

## Overview
Department tasks with status so leaders delegate concrete work instead of only chatting. Task changes post a system line in dept channel and wake assignee.

## Requirements
- Functional:
  - Leader (or manager) creates task in own dept, assigns to seat in same dept.
  - Status: `todo → doing → blocked → done` (any transition allowed except from `done` unless leader/manager reopens).
  - Assignee or dept leader/manager updates status + optional note; others 403.
  - Cross-dept requests: leader of A cannot assign seats in B; must ask B's leader in `leaders` channel (enforced).
  - Each create/assign/status change → system message in dept channel (`sender_kind='system'`) + wake assignee (create/assign) or leader (blocked/done).
  - MCP tools: `list_tasks {status?, mine?}`, `create_task {title, body, assigneeSeatId}`, `update_task {taskId, status, note?}`.
- Non-functional: title ≤200, body ≤8000, note ≤2000.

## Architecture
```
tasks(id PK, short_id INT per dept, department_id FK, assignee_seat_id FK NULL, created_by_kind, created_by_id,
      title, body, status CHECK(todo|doing|blocked|done), source_message_id NULL, created_at, updated_at)
task_events(id PK, task_id FK, actor_kind, actor_id, from_status, to_status, note, created_at)
```
- Add to v2 CREATE block (no migration; reset dev DB).
- `messages.sender_kind` CHECK adds `system`.
- `src/server/collaboration/task-service.ts`; permission check pure fn in `routing.ts` (`canManageTask`).
- REST (as built): `GET /v1/tasks?departmentId&status&assignee=me`, `POST /v1/tasks {departmentId?, title, body, assigneeSeatId}` (department defaults to the leader's own / assignee's), `PATCH /v1/tasks/:id {status?, note?, assigneeSeatId?}`. Task ids `t-<dept>-<n>`. Wakes are driven by explicit mentions on the system line (no separate task cursor).
- Wake integration: `wake-service` pending query includes task_events targeting seat after cursor.

## Related Code Files
- Modify: `src/server/db/database.ts`, `src/server/app.ts`, `src/server/mcp-stdio.ts`, `src/server/collaboration/wake-service.ts`, `src/server/collaboration/routing.ts`, `src/shared/contracts.ts`
- Create: `src/server/collaboration/task-service.ts`
- Tests create: `tests/unit/task-service.test.ts`, `tests/integration/tasks-api.test.ts`

## Implementation Steps
1. **Tests first**: leader creates for own member ok; member creates → 403; leader assigns other dept seat → 403; assignee moves todo→doing→done; non-assignee member updates → 403; done→todo only leader/manager; create emits system message + wakes assignee; done wakes leader.
2. Implement service, routes, MCP tools.
3. Snapshot/delta: tasks included per dept (bounded: open tasks + last 50 done).

## Success Criteria
- [ ] Permission matrix tests green.
- [ ] Task lifecycle visible as system lines in channel.
- [ ] build/lint/test pass.

## Risk Assessment
- Scope creep (comments, due dates, priorities) — explicitly out; note field only.
