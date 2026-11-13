# Test report + handover — task edit, blockers, readiness, dispatch

Date: 2026-11-13 · Commit: `858fc74` (code), `1ae41e1` (README) · Repo: github.com/unlock-new-skill/agent-office `main`
Requirement: /Users/truongpham/Desktop/requiremtn.md (PM pm-live)

## Run

- `npm test` on Node 24.11.1 (`.nvmrc`): **224 tests, 224 pass, 0 fail** (incl. P1: alerts digest, window expiry, review fixes). `npm run lint` clean, `npm run build` ok.
- On Node 26 the backup/restore test fails with `unsupported_node_runtime` (script guard) — environment, not code.
- New test files: `tests/unit/task-edit.test.ts`, `tests/unit/readiness-dispatch.test.ts`, `tests/unit/channel-visit.test.ts`,
  `tests/integration/task-edit-api.test.ts`. All tests use their own in-memory office (no real task touched).

## Acceptance cases → tests

| Case (requirement §4) | Result | Test |
|---|---|---|
| PM coordinator lists/reads Dev; member / other dept refused | pass | task-edit: *a coordinator flagged on the seat…*; api: *the manager flags a coordinator seat…* |
| PM/lead assigns an unassigned task via UI and MCP | pass | task-edit: *the PM assigns an unassigned task in place…* (same id, audit source, owner told once); api: *the web UI and an agent edit a task through the same contract* |
| Two updates on the same revision | pass | task-edit: *a stale revision conflicts…*; api: *a stale update answers 409 with the current task* |
| 503 DONE + FAIL, 487 needs passed | pass | readiness: *DONE is not PASS…* (also: unknown result → needs confirmation) |
| A DONE, B only needs completed | pass | readiness: *a dependency that only needs completed…* |
| Dependency met but permission/input/window blocker | pass | readiness: *dependencies met but an open permission…*; api: *blockers, board, dispatch setting and START over HTTP* |
| All met, owner free | pass | readiness: *ready and owner free: exactly one notice…* |
| Owner busy / two competing STARTs | pass | readiness: *a busy owner gets the next ready task queued…*, *…START claims once* |
| Restart / replay the same event | pass | readiness: *restart and replay…* (second office on the same DB; offer missed while off is sent once) |
| Dependency reopened / grant revoked before START | pass | readiness: *a dependency reopened or a grant revoked before START…* (`readiness_changed`) |
| Running task revoked | pass | readiness: *a task in progress whose grant is revoked only warns…* (status stays doing) |
| Cycle, missing task, invalid assignee | pass | task-edit: *invalid edits are refused whole…* (no partial write, revision unchanged) |
| 3 tasks share 2 blockers | pass | readiness: *board: 3 tasks sharing 2 blockers…* (tasks 3, blockers 2) |
| Legacy BLOCKED without metadata | pass | readiness: *legacy BLOCKED tasks without metadata…* (unresolved, not started, not closed) |
| Execution estimate > 240 / tracking 4800 | pass | task-edit: *execution starts only with an estimate up to 4h…*; readiness board keeps 4800 |

Extra: reassign while doing needs a handoff; omitted fields keep their value; blocker permissions; leader channel visiting.

## Production (2026-11-13 16:08)

- Backup before deploy: `/var/backups/agent-office/agent-office-20261113-160847.sqlite`; old image tagged `my-studio-agent-office:pre-v22`.
- After deploy: container healthy, schema v22, 495 tasks kept, readiness computed for all 495, dispatch `suggest`,
  0 ready notices sent, no message burst. `/`, `/map`, `/about` → 200.
- Root cause of the PM 403 confirmed: PM seat is `pm-live`, coordinator default was `pm`. Manager has since flagged `pm-live`.

## What ships

- REST: `PATCH /v1/tasks/:id` (title, body, assigneeSeatId|null, estimateMinutes, dependsOn, passRequired, kind, result,
  expectedRevision, reason, handoffNote), `GET /v1/tasks/:id` (task, history, changes, readiness, blockers),
  `POST /v1/tasks/:id/start`, `GET /v1/board`, `/v1/blockers` (+ `/link`, `/unlink`, `/resolve`, `/reopen`),
  `GET|PUT /v1/settings/dispatch`, `POST /v1/channels/:id/join|leave`.
- MCP: `agent_office_update_task` (new fields), `agent_office_get_task`, `agent_office_start_task`, `agent_office_board`,
  `agent_office_blocker`, `agent_office_join_channel`, `agent_office_leave_channel`; `create_task` takes `kind`, `passRequired`.
- Permissions: manager + coordinator seats = everything; department leader/deputy and parent lead = their tasks;
  assignee = status, estimate, result; blockers resolved by resolver, coordinator, manager or a leader of an affected task.

## Turning dispatch on / off

Tasks → **By blocker** → *Dispatch*: `suggest` (default: readiness only), `on` (one ready notice per task generation),
`off` (legacy "ready to start" lines only). Switching back is the rollback; tasks, history and running work stay.

## Limits (not in this release)

- Agents' machines must run `agent-office.mjs update` to get the new MCP tools (runners do not self-update).
- No demo on a dedicated test task in production yet; `t-dev-391` not reassigned (owner choice: likely `unity-ui-chuye-n-hud`).
- Older builds refuse the v22 database: roll back = restore the backup + `pre-v22` image.

## Review + browser demo (local isolated instance, port 8099)

- Browser demo (desktop 1440 + mobile 390, no horizontal scroll): board groups, waiting on FAIL, ready, tracking, coordinator checkbox.
- Found in the demo and fixed: the edit form compared against the live task, so a concurrent edit was silently overwritten;
  it now edits the version it opened and shows "Someone changed this task" (save refused). Raw group codes relabelled.
- Independent code review fixed: assignee could unlink a blocker from its own task (now resolver/leader/PM/manager only,
  posted in the thread); transaction depth counter after a failed COMMIT; reopening a done task keeps a stale pass
  (result back to unknown); reassign + doing skipped START checks; warnings sent in mode off; a failing recompute
  turned a committed edit into a 500 (now logged); board group titles of unreadable tasks hidden; blocker link lookup O(n).
- Decided by the owner (2026-11-13): PASS is recorded by the lead (deputy, parent lead) or the PM; the assignee self-passes
  only when no lead or PM oversees the task (fail/inconclusive always allowed). The manager and the PM may start a task
  without the readiness checks; the override is written in the task thread.

## P1 review + browser check

- Browser (desktop + mobile, no horizontal scroll): Alerts section on Tasks → By blocker shows kind, text, owner, next step.
- Review fixed: one org read per alert scan (was one per alert); digests carry at most 30 new alerts and the rest wait for
  the next run instead of being marked reported unseen; board alerts empty in dispatch off; reported keys of cleared
  alerts are deleted (no unbounded alert_state); expiry and digest fail independently; coordinators mentioned only when
  in #leaders; a blocker shared by departments alerts on each board; digest state saved after the line is posted;
  ended grants close at startup too.

## Unresolved questions


- Who owns `t-dev-391` (Unity 2 = `unity-ui-chuye-n-hud`?).
- When to switch dispatch to `on` (after leads classify open tasks).
