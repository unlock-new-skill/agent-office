# t-pm-1 — Seat activity and partial outputs (report)

Task: t-pm-1 (REQ #pm 265 / body #pm 270). Smallest change inside existing Office: no bulk status change, no autodispatch, no runner restart.

## Schema / API mapping (schema v25)

| Need | Storage | API | MCP |
|---|---|---|---|
| Participant executor/reviewer/intake, state, phase, note, time, actor, source | `task_participants` (PK task, seat, role) | `PUT /v1/tasks/:id/participants`, `DELETE /v1/tasks/:id/participants/:seat/:role` | `agent_office_progress` participant / remove_participant |
| Partial output: scope, evidence, result, still-missing acceptance; received ≠ accepted | `task_outputs` (accepted_by/at/note) | `POST /v1/tasks/:id/outputs`, `POST …/outputs/:oid/accept` | output / accept |
| Seat activity executing / reviewing / waiting / available / unknown | derived, not stored | `GET /v1/progress` (+ participants/outputs in `GET /v1/tasks/:id`) | activity |
| Audit | `task_changes` field `participant:<seat>:<role>`, `output:<id>` | `GET /v1/tasks/:id` changes | — |

Rules: owner never changes; only leaders name reviewers / revoke acceptance; reviewer cannot accept own output or output of a task it owns; stale after `ACTIVITY_STALE_MS` = 60 min → unknown with last signal; online never used; active role on blocked task = waiting; owning a blocked task listed under `also` only. Seat sees activity of own department + seats on tasks it can read; service tokens get no participants/outputs.

## Cases (isolated fixtures, `tests/unit/progress-activity.test.ts`)

A local accepted / real-env open · B contributor executing, owner not active, reviewer+intake done, mesh accepted, PBR open · C stopped ≠ running · D only recorded phase · E reviewing elsewhere while owning blocked task · F silence = unknown, stale with last time · plus legacy, permissions/audit, self-acceptance, even staleness.

## Verification

- `npm test` (Node 24.11.1): 239/239 pass. Lint clean. Production compile ok.
- Independent review (code-reviewer agent): 1 critical + 4 high + 4 medium + 1 low; all fixed except "participant from another department cannot read task" — fixed too (participants can read the task).
- UI screenshots (isolated demo office, port 8099, fixtures only): `fixture-org-seat-activity.png` (Org seat cards with activity lines), `fixture-task-progress.png` (task card with participants and RECEIVED output + still-missing + Accept).

## Limits / NOTRUN

- No real-data screenshots: prod has no participants yet; activity there falls back to owner doing runs (legacy) until seats report roles.
- Agents need a seat restart (manager Restart) to see the new `agent_office_progress` tool.
