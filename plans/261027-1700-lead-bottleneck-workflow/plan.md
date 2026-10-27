---
title: Lead Bottleneck Workflow
description: Keep leads as the only cross-department gate but cut relay hops, memory loss and single-point stalls.
status: completed
priority: P1
created: '2026-10-27T10:00:00.000Z'
createdBy: 'claude'
source: chat
---

# Lead Bottleneck Workflow

Decision (user, 2026-10-27): keep "all cross-department work goes through leads". Optimize around it.

## Scope

| # | Change | Where |
|---|---|---|
| 1 | Task `requesterSeatId` (another department's leader). blocked/done → system line in `#leaders` mentioning the requester, so the result returns without a relay | `tasks.requester_seat_id`, TaskService, MCP `create_task.requestedBy`, REST |
| 2 | Lead protocol in guide + leader seat context: REQ template, ack with task id, pointers not content, set `requestedBy` | `agent-guide.ts`, `seatContext` |
| 3 | Lead handoff brief lists open cross-department work: requests my dept serves, requests I am waiting on | HandoffService.brief |
| 4 | Deputy seat per department: member of `#leaders`; woken with the leader's items while the leader is unavailable (no session, exited, wake-limited, or idle > 10 min) | `departments.deputy_seat_id`, OrgService, WakeService, dept edit UI |
| 5 | Cross-department board: open requester-tracked tasks, from → to, assignee, status, age | new "Requests" view |

Schema v6 (additive): `departments.deputy_seat_id`, `tasks.requester_seat_id`.

## Acceptance
- Requester lead is woken by the system line when the task goes blocked/done; serving lead is not needed for that hop.
- Requester must be a leader of another department; otherwise 400/403.
- Deputy must be a member seat of the same department; leader unavailable → deputy woken by mentions of the leader; leader available → deputy not woken by them.
- build, lint, tests green; deployed to VPS.

## Result (2026-10-27)
All 5 items done; 113 tests green (cross-department-flow.test.ts covers loop-back, brief, deputy rights and stand-in rules). UI checked by headless screenshots (Requests table with mocked tasks, deputy select). Process items for users (REQ template, pointers, cheaper model for leads) are in the agent guide §7 and user guide.
