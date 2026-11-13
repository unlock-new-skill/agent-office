# t-pm-1 — Seat activity and partial outputs (report)

Task: t-pm-1 (REQ #pm 265 / body #pm 270). Smallest change inside existing Office: no bulk status change, no autodispatch, no runner restart.
Deployed: b55d3f3 (2026-11-13 23:01 ICT, schema v25); follow-up for PM question #pm 276 (blocked task vs real activity) in the next commit on `main`.

Readable from anywhere (public repo, fixtures only, no production data):
- Report: https://github.com/unlock-new-skill/agent-office/blob/main/plans/reports/t-pm-1/seat-activity-partial-outputs-report.md
- Tests A–F: https://github.com/unlock-new-skill/agent-office/blob/main/tests/unit/progress-activity.test.ts
- Logic: https://github.com/unlock-new-skill/agent-office/blob/main/src/server/collaboration/progress-service.ts

## Schema / API mapping (schema v25)

| Need | Storage | API | MCP |
|---|---|---|---|
| Participant executor/reviewer/intake, state, phase, note, time, actor, source | `task_participants` (PK task, seat, role) | `PUT /v1/tasks/:id/participants`, `DELETE /v1/tasks/:id/participants/:seat/:role` | `agent_office_progress` participant / remove_participant |
| Partial output: scope, evidence, result, still-missing acceptance; received ≠ accepted | `task_outputs` (accepted_by/at/note) | `POST /v1/tasks/:id/outputs`, `POST …/outputs/:oid/accept` | output / accept |
| Seat activity executing / reviewing / waiting / available / unknown | derived, not stored | `GET /v1/progress` (+ participants/outputs in `GET /v1/tasks/:id`) | activity |
| Audit | `task_changes` field `participant:<seat>:<role>`, `output:<id>` | `GET /v1/tasks/:id` changes | — |

Rules: owner never changes; only leaders name reviewers / revoke acceptance; reviewer cannot accept own output or output of a task it owns; stale after `ACTIVITY_STALE_MS` = 60 min → unknown with last signal; online never used; owning a blocked task listed under `also` only. Seat sees activity of own department + seats on tasks it can read; service tokens get no participants/outputs.

Blocked task vs real activity (#pm 276 point 1): an active role **claimed before** the task was blocked shows waiting (old claim, not evidence). An active role **reported after** the block (participant updatedAt > last `task_events` → blocked) is real work on an independent phase: it shows executing/reviewing with its phase, and `reasons` carries `task blocked: <readiness reasons>`. Activity never changes task status, dependencies or result, so no dependency is bypassed.

## Cases A–F → tests (`tests/unit/progress-activity.test.ts`, isolated fixtures)

| Case | Test | What it asserts |
|---|---|---|
| A (391) | `A: local output accepted while runtime acceptance stays open…` | local output accepted with missing '', real-env output open with runtime/URP/BA/P5 missing; reviewer done ≠ waiting; task status/result unchanged |
| B (511) | `B: contributor executing, owner not claimed active, reviewer and intake done; mesh accepted, PBR open` | D1 contributor executing, D2 owner not shown active, Unity1 reviewer + FE intake done, mesh+UV accepted, PBR/engine open |
| C (513) | `C: a stopped run is not running; result and wait shown apart` | result and wait separate; stopped role never shown as running |
| D (510) | `D: only the recorded phase is shown; nothing implies image complete` | only the recorded phase is shown; no inferred "image complete" |
| E | `E: a seat owning a blocked task but reviewing another shows the review…` | review shown; parent stays blocked, listed under `also` |
| F | `F: silence is unknown with the last signal time…` | no records → unknown + last time; never from owner/online |
| extra | legacy fallback; permissions/audit; no self-acceptance; even staleness; phase after block | see test names |

## Independent review receipt

Reviewer: separate `code-reviewer` agent (no shared context, given the diff), before deploy. Findings 1 critical, 4 high, 4 medium, 1 low — all fixed in b55d3f3:
- critical: task owner could name itself reviewer and accept own output → only leaders name reviewers; reviewer cannot accept own output or output of a task it owns.
- high: `accept` defaulted to true when omitted → omitted = acceptance unchanged (MCP still defaults true explicitly).
- high: staleness uneven (waiting / legacy never went stale) → one 60 min rule everywhere; legacy uses current doing run start only.
- high: active role on blocked task counted as executing → waiting (refined by the #pm 276 follow-up above).
- high: cross-department activity leak → seat sees own department + seats on tasks it can read.
- medium: service tokens saw participants/outputs → stripped; participants from another department could not read the task → `canRead` includes participants; reload storm → client waits 1 s after last change; `@` prefix in remove not stripped → fixed.

## How PM / Lead record real work (#pm 276 point 2)

- MCP `agent_office_progress` and `agent_office_update_task.result` exist in the deployed connector. A seat's tool list is loaded when its session starts, so a seat that started before the deploy does not see them: only **that one seat** needs a Restart (manager, Seats → Restart). No bulk restart.
- Who may write: assignee + task leaders (dept lead/deputy, PM, manager) set executor/intake for anyone; only leaders/PM name reviewers; every participant updates its own role; outputs recorded by assignee, leaders or participants; acceptance as above; `result=pass` by a lead or PM (`pass_needs_review` for others).
- Without a restart: the manager can do the same in the web UI (task card → + Who works / + Output / Accept).
- No SQL, no fake activity: production had 0 participants/outputs at the read-only check (23:05 ICT), so seat cards show the legacy fallback until seats report.

## Verification

- `npm test` (Node 24.11.1): all pass (240 with the follow-up). Lint clean. Production compile ok.
- UI screenshots (isolated demo office, fixtures only, 2026-11-13 ~22:55 ICT): `fixture-org-seat-activity.png` (Org seat cards with activity lines), `fixture-task-progress.png` (task card with participants and RECEIVED output + still-missing + Accept).

## Limits / NOTRUN

- No real-data screenshots of Org/Tasks/Map: production has no participants/outputs yet, and production data is not published in this public repo. Map uses the same `SeatActivityLine` as Org/Tasks; no separate Map fixture screenshot.
- Agents need a seat restart to see the new tool.
