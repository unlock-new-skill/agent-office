# Code Review: agent prompt routing (uncommitted, base 6b9f8fb)

## Scope
- Files: prompt-service.ts (new), runner-routes.ts, office-routes.ts, database.ts (v31), runner-service.ts, office.ts, claude-process.ts, seat-worker.ts, runner.ts, hook-runner.ts, mcp-server.ts, contracts.ts, client prompt-card/approvals-bar/state, 3 new test files.
- LOC: about 290 changed lines plus 540 new lines.
- Gates (run 17:18-17:20): `npm test` 302/302 pass. `npm run lint` clean. `npx tsc --noEmit` **FAILS** on the current tree (see M4).
- **Warning: the tree changed while I was reviewing it.** `src/shared/contracts.ts` (17:19:55), `src/server/collaboration/prompt-service.ts` (17:20:35) and the v31 DDL in `database.ts` were rewritten during the review. The rewrite adds task-bound resolvers and new fields (`taskId`, `resolvers`, `outcome`, `outcome_at`). Line numbers below refer to the prompt-service.ts I read at the start (the 17:06 version, 249 lines). Findings about `resolversFor`/notice may already be partly stale. All other findings still apply to the current files.

## Verdict: REQUEST CHANGES

Requirements check:
- Self-answer refused: OK.
- Resolver list enforced: OK.
- One decision per prompt: OK. The atomic `UPDATE … WHERE status='pending' AND expires_at>?` plus synchronous SQLite rules out a double decision.
- Expiry, cancel and wrong actor never allow: OK.
- An answer cannot change a permission's input: OK. seat-worker passes `event.input` unchanged.
- Hook DENY not routed: OK.
- Windows `stdio` argument is shell-safe: OK.
- No auto DONE/PASS: OK. Nothing touches task status.

Gaps:
- Manager-only detection can be bypassed (H1).
- Prompts that Claude Code cancels are not tracked (H2).
- Runner hot loop (H3).
- Orphaned or stale prompts (M1, M2).
- Moving tree and broken typecheck (M4).

## Critical
None found.

## High

### H1. The manager-only check reads only the shortened summary. Long commands and file contents get past it.
- Where: prompt-service.ts:68-72 (`visible = summary` for permissions) together with permission-service.ts:11-16 (`summarizeToolInput`).
- The problem: the summary shows only `command`, or for file tools only `file_path` (+ " (edit)"), and is cut at 2000 characters. MANAGER_ONLY runs on that string. The resolver also sees only that string, and the binding covers the full input.
- Failure 1: a Bash command of `echo <1990 chars>; git push --force origin main` (or `curl … | sh`). The cut removes the tail, the regex does not match, and `dev-lead` sees a harmless prefix and allows. The runner then runs the full command.
- Failure 2: `Write` to `src/config.ts` with content holding a token. The delegate sees only `Write: src/config.ts`. No sensitive word is checked and the resolver never sees the content.
- Fix: the server already receives `input` at create time.
  - Run MANAGER_ONLY on `JSON.stringify(input)`, not on the summary.
  - Set `managerOnly` whenever the summary was cut, or when the tool's real payload is not shown (Write/Edit/MultiEdit/NotebookEdit content, MCP tools whose JSON was cut).
  - Or show resolvers the full payload they are allowing.
  - Add tests for the cut-off command and for Write content.

### H2. `control_cancel_request` is not handled, so a cancelled prompt stays live.
- Where: claude-process.ts:87-93 (only `control_request` is parsed) and seat-worker.ts:206-207, 230.
- The problem: when the seat is interrupted (`SeatWorker.interrupt` → `control_request interrupt`), Claude Code drops the pending `can_use_tool` and sends `control_cancel_request {request_id}`. The runner ignores that message:
  - `prompts` still holds the request id, so `alive()` stays true;
  - the seat status stays "waiting for an answer…";
  - the server prompt stays pending, keeps a MAX_PENDING slot and keeps resolvers woken.
- Failure: a resolver allows 5 minutes later. The runner writes a `control_response` for a request that is no longer waiting, logs "answer delivered" and calls `/delivered`, so the audit trail is wrong. This breaks the requirement "applied only to … request that is still waiting". It is safe only as long as Claude Code drops responses for unknown ids. Confirm that on the pinned Claude Code version.
- Fix: parse `control_cancel_request` → `{kind:'control-cancel', requestId}`. In SeatWorker, `prompts.delete(requestId)` so `alive()` turns false and the ask loop exits. Tell the server to cancel that one prompt (new `cancel` body `{promptId}` or `{requestId}`). Add a unit test.

### H3. When the waiter cap is full, the runner polls in a tight loop with no backoff.
- Where: prompt-service.ts:137 (`this.waiterCount() < MAX_WAITERS`, global 64) and runner.ts:144-150.
- The problem: when 64 waiters are already parked (for example 16 seats each with 4 pending prompts, or several runners), `wait()` returns `pending` at once. `askOffice` treats any `pending` as a normal long-poll return and loops with no sleep.
- Failure: every prompt over the cap spins at network round-trip speed. Each call also runs `expireDue()` plus a full row read. The more load, the faster it spins.
- Fix (either):
  - Server: return 429 or a `retryAfterMs` when the cap is hit.
  - Runner: sleep about 2 s whenever a `pending` reply came back much faster than the requested wait.

## Medium

### M1. Orphaned pending prompts block a seat for 20 minutes and wake resolvers for nothing.
- Where: prompt-service.ts:80-81 (MAX_PENDING_PER_SEAT=4), runner.ts:139-140, seat-worker.ts:248, office.ts sweep.
- Ways an orphan appears:
  - (a) The process exits while `POST /prompts` is in flight. `cancelPrompts` runs before the insert, so the prompt is created afterwards and stays pending.
  - (b) `POST /prompts` times out after 10 s but the server committed it. The runner denies at once (no retry, no cancel).
  - (c) The runner daemon crashes or restarts. No cancel is sent.
  - (d) The runner goes stale or offline per `runners.sweep()`. Its prompts are never cancelled.
- Failure: four orphans mean `too_many_pending_prompts`. Every new prompt from that seat is then denied with no answer for up to 20 minutes, and resolvers are pinged for dead prompts.
- Fix:
  - On create, cancel pending prompts of the same seat whose `session_id` differs.
  - Count the pending limit per session.
  - Have `runners.sweep()` cancel pending prompts of runners it marks offline.
  - When filing fails, the runner sends a cancel for that request id.

### M2. `cancelPrompts(seatId)` can cancel the new process's prompts.
- Where: runner.ts:124, prompt-service.ts:161-168.
- The problem: the cancel is fire-and-forget and scoped to runner+seat. If the restart is quick (fresh/prompt command, or the first crash restart), process B can file a prompt before A's cancel lands, and A's cancel then cancels B's prompt.
- Impact: this fails safe (deny), but it is wrong behaviour.
- Fix: send `sessionId` (or the prompt ids the worker tracked) and cancel only those.

### M3. The 16 KB input limit silently denies large edits, and the "input never leaves the machine" comment is false.
- Where: runner-routes.ts:385, database.ts v31 comment, runner.ts:139-140.
- Failure: in a non-bypass seat, any `Write`/`Edit` whose input is over 16 KB gets a 400. The runner turns that into `deny(null)` and the agent sees the generic NO_ANSWER text. Nobody is notified and the log does not say why.
- The comment says the full tool input never leaves the machine, but it is POSTed in full. It is only not stored.
- Fix (either):
  - The runner sends a reduced input (the summary fields), and the server checks the binding hash against what it receives.
  - Raise the cap and log the refusal reason.
- Correct the comment either way.

### M4. The tree is moving and the type gate is broken. v31 DDL was edited in place.
- At 17:20, `npx tsc --noEmit` failed: `prompt-service.ts(236,5): TS2739 … missing taskId, resolvers, outcome` (contracts.ts was changed before prompt-service.ts caught up).
- `npm test` runs through tsx and does no type checking. `npm run lint` does not type-check either. So this kind of break passes every gate the project runs.
- `V31_TABLES` was changed after being written (added `task_id`, `outcome`, `outcome_at`). Any database already upgraded to v31 (local e2e per the office-dev capability report) keeps the old table and will throw on the new columns.
- Fix:
  - Freeze the tree and re-review the final state.
  - Add `tsc --noEmit` to the pre-commit/CI gate.
  - Recreate any local v31 database, or ship the change as v32. Never edit a migration that has already run.

### M5. Resolvers can block each other until the prompts expire.
- Where: `resolversFor` in prompt-service.ts:186-194.
- Failure: coordinator C1 blocks on a prompt that goes to C2, while C2 blocks on a prompt that goes to C1. A blocked `-p` turn cannot take its wake, so both wait 20 minutes and are both denied. The same happens when a leader is blocked waiting on a coordinator while members wait on that leader.
- Impact: bounded by the TTL, but it stalls the office.
- Fix: leave out resolvers that currently have their own pending prompt (or whose seat status is "waiting for an answer"), and fall back to the manager when none are left.

### M6. Tests are missing.
- Nothing covers `Runner.askOffice`:
  - deny when filing fails;
  - the unreachable-server path (expiry + 60 s);
  - `delivered` / `cancelled` statuses;
  - the hot loop in H3.
- Nothing covers `control_cancel_request`, cut-off summary sensitivity, or the v30→v31 upgrade (only fresh-create runs in tests).
- The test "two resolvers answering at the same time" runs the two answers one after the other. It is valid because the DB is synchronous, but the name claims more than it tests. The atomic `UPDATE` guard is the real protection; assert that `changes === 0` when an expired or answered row is updated directly.

## Low

### L1. The idempotent create path does not compare the request.
- Where: prompt-service.ts:58-59.
- The problem: the existing row is returned without checking `seatId`/`sessionId`/`binding`. The lookup is outside the transaction, so two concurrent duplicates hit UNIQUE and get a 500.
- Fix: do the lookup inside the transaction and refuse a mismatched binding with 409.

### L2. The runner's binding check proves little, and the server never checks the binding.
- Where: seat-worker.ts:237.
- The problem: `verdict.binding` is the binding the runner itself sent, echoed back by the server, so this check only catches request-id collisions. The real binding check is in `answer()` on the server. The server never confirms `binding === sha256(JSON.stringify({tool,input}))`, even though it has the input.
- Fix: check the binding on the server at create time.

### L3. The question `header` is agent-written and goes into the chat notice unchecked.
- Where: prompt-service.ts:214.
- The problem: the header (up to 40 characters) is not part of `visible`, so MANAGER_ONLY never sees it. A header holding a secret would be posted into the channel.
- Fix: add headers to `visible`, or leave them out of the notice.

### L4. The runner compares its own clock with the server's expiry time.
- Where: runner.ts:153 compares local `Date.now()` with the server's `expiresAt`.
- Impact: clock skew only moves when the runner gives up. Low.

### L5. The resolver list is fixed when the prompt is created.
- A leader demoted after the prompt was filed can still answer for up to 20 minutes. The task-bound rewrite may change this.

### L6. One deny text is hard-coded in the client.
- prompt-card.tsx:21 has the deny message as a fixed English string. This is consistent with the rest of this repo's client, which does not use i18n.

## Edge cases from scouting
- An interrupt during a pending prompt (H2).
- The process exits during filing (M1a).
- The runner restarts (M1c).
- The waiter cap is reached (H3).
- Input over 16 KB (M3).
- Commands over 2000 characters (H1).
- A v31 database created before the DDL edit (M4).

## Positive observations (risk calibration)
- The `answer` ordering is correct. Authorization is checked before status, so a stranger cannot learn a prompt's state from the error. The update is guarded by `status='pending' AND expires_at>now`.
- Permission allow sends back the original `event.input`, and resolver `answers` are dropped for permissions on both server and runner. Answer text cannot reach tool input.
- The PermissionRequest hook is skipped for runner-managed seats, so no prompt is filed twice.
- The WS `prompts` broadcast goes only to manager sessions (hub subscribe uses the auth session), so summaries do not leak to seats.

## Recommended actions
1. H1: run the sensitive check on the full input, and make cut-off or file-content permissions manager-only.
2. M4: stop the parallel edits, re-run `tsc --noEmit`, add a typecheck gate, and resolve whether to keep editing v31 or ship v32.
3. H2: handle `control_cancel_request`.
4. H3: back off when the waiter cap is full.
5. M1 and M2: cancel by session, and cancel in the runner-offline sweep.
6. M3: input size and the false comment.
7. M6: add the missing tests.

## Metrics
- Type check: failing on the current tree (TS2739).
- Tests: 302 pass. No askOffice or cancel-request coverage.
- Lint: 0 issues.

## Unresolved questions
- Does the pinned Claude Code version send `control_cancel_request` for pending `can_use_tool` on interrupt, and does it ignore a response for an unknown id? This sets whether H2 is cosmetic or a safety issue.
- Has any database (local e2e) already been upgraded to the earlier v31 DDL?
- Who is editing contracts.ts, prompt-service.ts and database.ts in parallel? This review covers the snapshot from before the task-bound rewrite.

Status: DONE_WITH_CONCERNS
Summary: REQUEST CHANGES. Manager-only detection can be bypassed through cut-off summaries and file content; Claude Code's cancel messages are ignored; the runner can hot-loop; and the tree was rewritten during the review, leaving the typecheck failing.

---

## Delta review (stable tree, 17:28)

Gates I ran myself:
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test`: 306/306 pass.
- E2E log `/tmp/ao-pr/e2e-perm2.log`: allow → "allowed by @dev-lead: delivered, ran"; deny → "denied by @dev-lead: denial delivered, not run"; peer 403, lead 200; the denied file was not written.
- Line references below are to the current `prompt-service.ts` (346 lines).

### Earlier findings

| ID | Status | Evidence |
|---|---|---|
| H1 | Fixed | `showInput` lists every field. A summary over 2000 chars → manager-only (:101-109). The keyword scan runs on `JSON.stringify(input)` and on headers (:106). The server recomputes the binding (:90). Tested (:92). |
| H2 | Fixed | `control_cancel_request` → `prompt-cancel`. The worker removes the request, cancels that one id and never responds. Tested (runner-prompts :81-87). |
| H3 | Fixed | runner.ts: sleeps 2 s when a poll returns pending in under 1 s. |
| M1 | Fixed | Filing retries; a prompt filed after the session stopped waiting is cancelled; first registration cancels all; `cancelOffline` in the sweep. |
| M2 | Fixed | Cancels go by prompt id (seat-worker onExit, `cancel({ids})`). |
| M3 | Fixed | Limit is 256 KB; the database comment is corrected. |
| M4 | Fixed (claim) | v31 only ever ran on `:memory:` (I cannot verify this beyond the report). tsc is clean. There is still no `typecheck` script: tsc only runs inside `npm run build`, and `npm test`/`lint` do not type-check. See D6. |
| M5 | Fixed | Resolvers with a pending prompt are skipped (:277-279). Tested (:84). |
| M6 | Mostly fixed | Tests now cover askOffice (integration :66), cancel, cut-off summaries, the full-input scan and request-id reuse. `cancelOffline` has no test, and one test is a no-op (D5). |
| L1 | Fixed | `existing()` compares seat, session and binding → 409 `prompt_request_reused`. Insert race handled. |
| L2 | Fixed | The server verifies the binding at create time. |
| L3 | Fixed | Headers are now scanned. |
| L4 | Fixed | The give-up time is measured on the runner's own clock. |

### New findings against PM requirements (1) and (2)

**D1. High. Business vs technical routing is a label only; any listed resolver can decide any prompt.** Requirement (1).
- Where: prompt-service.ts:161-165 checks only `resolverIds(row).includes(actor.seatId)`. The `role` is never compared with what the prompt asks. Prompts are never classified as business or technical.
- Failure: a member's `Bash` permission (`command: npm run migrate …`) lists `{dev-lead: technical}` and `{ops-lead: business}`. The PM coordinator `ops-lead` allows it and the command runs. A business question can likewise be answered by the technical lead.
- For a leader's prompt (`steering`), technical is only the parent-task lead, so tool permissions of leaders are usually approved by the PM alone.
- Fix: classify the prompt at create time, e.g. `kind==='permission'` → technical, and questions → both (or a business/technical flag from the header). Enforce `resolver.role` in `answer()`: business resolvers may answer questions but never allow permissions. If no resolver has the needed role, mark the prompt manager-only with that reason. Add tests: a coordinator allowing a permission gets 403; a business question goes to the coordinator.

**D2. Medium. The task scope is fixed at creation and never re-checked at answer.** Requirement (1).
- Where: `resolversFor` (:260-281) picks a single `doing` task (execution first, then most recently updated). `answer()` never confirms the task is still `doing`, still assigned to the asker, or that the resolver still leads it or is still a coordinator.
- Failure 1: the task is reassigned, or set to done, or the lead is demoted. For up to 20 minutes the former resolver can still allow.
- Failure 2: a seat with two `doing` tasks gets its prompt bound to the "wrong" task's leads.
- Fix: in `answer()`, recompute `resolversFor(asker)` (or at least check the task status, assignee and the resolver's current role). If the result differs, refuse with `prompt_scope_changed` and switch the prompt to manager-only.

**D3. Medium. A prompt answered after the session stopped waiting stays "not yet delivered" forever.** Requirement (2).
- Where: `cancel()` only touches `status='pending'` (:229-231). The runner returns silently when `!alive()` (seat-worker onPrompt), so it neither delivers nor cancels.
- Failure: the lead allows at 10:00:00. Then the session is interrupted (`prompt-cancel`) or the process exits before the runner's poll returns. The row stays `answered`, and the UI and MCP show "allowed by @dev-lead, not yet delivered to the session" with no end. That reads like something is still about to run. Expiry does not cover it either, because `expireDue` handles only pending rows.
- Fix: let `cancel(ids)` also move `answered`/`denied` rows to a distinct terminal state ("withdrawn" or "undeliverable": not run) and record `decided_by` for the cancel. Alternatively, have the runner send cancel when `!alive()` after a decision. Optionally, a sweep could close `answered` rows older than the TTL.

**D4. Medium. A fast tool can lose its outcome report, leaving "approved" indistinguishable from "executed".** Requirement (2).
- Where: runner.ts sends `delivered` and `outcome` as two independent fire-and-forget POSTs. `outcome()` only updates rows where `status='delivered'` (:219).
- Failure: `ls`/`echo` produce their `tool_result` within milliseconds of the allow, so the `/outcome` POST can reach the server before `/delivered`. It updates 0 rows and is dropped silently. The row then stays "delivered, not reported as run yet" forever. The test at agent-prompts.test.ts:151 shows that an outcome before delivery is dropped.
- Fix (either):
  - Chain the calls: `delivered(id).then(() => outcome(...))`, and queue the outcome until delivered resolves.
  - Let `outcome()` accept `status IN ('answered','delivered')` and set delivered at the same time.
- Add a test with the outcome arriving first.

**D5. Low. A test that cannot fail.**
- Where: agent-prompts.test.ts:151 `assert.throws(() => prompts.outcome(...) && assert.fail(), /./)`.
- The problem: if `outcome` throws, the assertion passes. If it returns the row (the real behaviour), `assert.fail()` throws and the assertion still passes. It proves nothing.
- Fix: assert `prompts.outcome(...).outcome === null` and that the status is unchanged.

**D6. Low. Smaller gaps.**
- No `typecheck` script. `npm test`/`lint` let type breaks through, which is exactly what happened mid-review. Add `"typecheck": "tsc -p tsconfig.json --noEmit"` to the lint/CI gate.
- The binding is computed twice (`promptBinding` in seat-worker.ts and `bindingOf` in prompt-service.ts). If one changes alone, every prompt fails with a 400 (fails safe). Move it to `src/shared/`.
- The keyword scan runs on JSON-escaped text: `git\npush` or `rm\t-rf` in a command becomes a literal backslash sequence, and the `\s+` patterns miss it. It is only an extra signal now, but with D1 open it is the main guard for destructive Bash. Also scan `Object.values(input)` as raw strings.
- `stateOf('cancelled')` always says "the session stopped or restarted", even when `decided_by` is `runner-offline` or the request was withdrawn by an interrupt. The audit is less exact than the data allows; use `decided_by` in the text.
- `cancelOffline` has no test. It also cancels live prompts when a runner is missing past `ONLINE_MS` or right after a server restart. That fails safe (deny), but is worth documenting.
- The notice adds coordinators as guests of the task thread, so they can read that whole department thread. This is existing behaviour, but now triggered by prompts as well.

### Requirement check (PM 1 and 2)

| Requirement | Result |
|---|---|
| Authorization rests on actor + task/scope + server-verified binding | Partial. Actor and binding are good; scope is not re-checked (D2). |
| Keywords only push towards the manager | OK. They only add `managerOnly` and never allow. |
| Business → PM coordinators, technical → task leads | Not enforced (D1). |
| A PM's or coordinator's request is never routed back to itself | OK (:274-275 exclude the asker). |
| No valid resolver → shown as manager-only with a reason | OK. |
| Deny, expired and cancelled distinct in audit and UI | OK (`stateOf`, separate statuses). |
| A decision applies only to a request still waiting; no revival | OK. `alive()` checks generation, process and request id. Cancelled, expired and delivered all reach the runner as deny. A late answer after cancel → 409. |
| "Approved" ≠ "executed" | Mostly. The `outcome` field and state text exist, but the outcome can be lost (D4) and stale "not yet delivered" rows persist (D3). |

### Delta verdict: REQUEST CHANGES (narrow)

- Blocking: D1, because requirement (1) explicitly separates business from technical and today a PM coordinator can allow tool permissions.
- Should fix before merge: D2, D3 and D4. Each is small: a re-check in `answer()`, a wider `cancel()`, and chaining `delivered`/`outcome`.
- Everything from the first review is fixed.

Status: DONE_WITH_CONCERNS
Summary: All first-round findings are fixed and the gates are green; the remaining blocker is that any listed resolver, including a PM coordinator, can allow technical tool permissions, plus three medium audit and scope gaps.

---

## Delta review 2 (final, 17:40)

Gates I ran myself:
- `npm run typecheck`: clean. The script now exists: `"typecheck": "tsc --noEmit -p ."`.
- `npm run lint`: clean.
- `npm test`: 310/310 pass.
- E2E: `/tmp/ao-pr/e2e-perm3.log` shows "allowed by @dev-lead: delivered, ran" and "denied by @dev-lead: denial delivered, not run". In `/tmp/ao-pr/e2e-run3.log` a "deploy" question goes to the manager only and its deny is honoured.
- Line references are to the current `prompt-service.ts` (358 lines).

### D1–D6, M4, M6

| ID | Status | Evidence |
|---|---|---|
| D1 | Fixed | `resolversFor(seat, kind)` adds coordinators (business) only for `kind==='question'` (:286-287). A permission with no technical lead → manager-only "no technical lead other than @x" (:291). Test: a coordinator answering a permission gets `not_prompt_resolver` (test :169). |
| D2 | Fixed | `answer()` recomputes the resolvers with `skipWaiting=false` and refuses `prompt_scope_changed` on a different taskId or a lost role (:168-170). Ambiguous scope → manager-only "several tasks in progress" (:274-277). Tested (:179, :184). |
| D3 | Fixed | `cancel()` also covers `answered`/`denied`, keeps `decided_by` and stores `cancel_reason` (:235-243). The state text names the reason and "never delivered: not run" (:59). The runner sends reasons. Tested (:193). |
| D4 | Fixed | `outcome()` accepts `answered|delivered` and sets delivered. A later `delivered()` call is a no-op, so the outcome is kept (:222-229). Tested (:197). |
| D5 | Fixed | The test now asserts `outcome === null` before an answer (:151). |
| D6 | Fixed | One `promptBinding` in `src/shared/prompt-binding.ts` (Node-only, not imported by the client). `plainText()` scans the raw strings (:27, :109). Cancel labels carry the reason. `cancelOffline` is tested (:205). |
| M4 | Fixed | `typecheck` script added. v31, including `cancel_reason`, was never deployed (per the coordinator; the e2e runs used `:memory:`). |
| M6 | Fixed | Tests cover roles, scope re-check, ambiguous scope, cancelling an undelivered decision, outcome before delivered, and `cancelOffline`. |

### Remaining findings (none blocking)

**R1. Medium. A bulk cancel can label a decision that was actually delivered as "never delivered: not run".** Requirement (2).
- Where: `cancel()` with no ids (:237-239), used by `cancelOffline` (:248) and by the runner's first registration ("the runner restarted", runner.ts:303). It now also flips `answered` rows.
- The problem: the runner's `/delivered` POST is fire-and-forget with no retry (runner.ts:213).
- Failure: the runner writes the allow to the session and the tool runs, but `/delivered` fails during a short outage. If the runner then counts as offline (or restarts) while it has another prompt pending, the bulk cancel turns that row into "cancelled (the runner went offline), after an answer by @dev-lead that was never delivered: not run". `outcome()` then refuses the row because its status is `cancelled`, so the audit permanently records "not run" for a command that ran.
- Fix (any of):
  - Retry `delivered` (and `outcome`) a few times with backoff.
  - For cancels without ids, move only `pending` rows and leave `answered` rows untouched.
  - Use a distinct label for them ("delivery not confirmed"), and let `outcome()` correct a row that was cancelled after an answer.

**R2. Low. A question can be answered by either role.**
- Questions are not classed as business or technical, so the technical lead and the PM coordinator may both answer any question.
- This matches the stated design ("questions may be business too") and permissions are now strictly technical. The PM should confirm this reading of requirement (1).

**R3. Low (policy). The "parent task lead" can be an ordinary member.**
- Where: `createStep` in `task-service.ts:198-205` lets the parent's assignee add steps for seats in any department. `resolversFor` then lists that assignee as technical (:282).
- Effect: a member who holds a top-level task can approve tool permissions of a step assignee in another department.
- This follows the stated rule "the parent task's lead counts as technical". If the PM means a lead role, also require the parent assignee to be a leader or deputy.

**R4. Low. A former resolver can still read the prompt.**
- `canRead`/`list` (:330-333) still use the stored resolver list.
- A resolver whose scope changed can still read the prompt summary, though it can no longer answer. Minor exposure; re-checking at read time would close it.

**R5. Low. A wrong error code for late answers from a former resolver.**
- The scope check runs before the status check (:168-172). A former resolver answering an already-decided prompt gets 403 `prompt_scope_changed` rather than 409. Cosmetic.

### PM requirements, final

| Requirement | Result |
|---|---|
| Authorization on actor + task/scope + server-verified binding | OK. The actor is checked against stored ∩ recomputed resolvers; the scope must be unambiguous and is re-checked at answer; the binding is recomputed on the server. |
| Keywords only push towards the manager | OK. They scan the plain text of the full input and never allow. |
| Business → PM coordinators, technical → task leads | OK for permissions (technical only). Questions are shared by both roles (R2, by design). |
| A PM's or coordinator's request never routes back to itself | OK. |
| No valid resolver → shown as manager-only with a reason | OK. Reasons: no task, several tasks, no technical lead, everyone waiting, sensitive, too long. |
| Deny, expired and cancelled distinct in audit and UI | OK. The cancel reason and the earlier decider are kept. |
| A decision applies only to the request still waiting; no revival | OK. `alive()` checks generation, process and request; cancelled, expired and delivered resolve to deny; a late answer → 409/403. |
| "Approved" ≠ "executed" | OK. `outcome` is recorded even when the result arrives before the delivery notice. Edge case R1 remains. |

### Final verdict: APPROVE WITH NOTES

- All blocking and medium findings from rounds 1 and 2 are fixed and covered by tests.
- R1 is a real but narrow audit-accuracy gap (a lost `/delivered` followed by a bulk cancel). It never causes anything to execute. Fix it soon, preferably before relying on the audit for compliance.
- R2 and R3 are policy points for the PM to confirm.

Status: DONE
Summary: APPROVE WITH NOTES. D1–D6, M4 and M6 are verified fixed and the gates are green; one medium audit edge remains (a bulk cancel can mark a delivered decision "not run"), plus two policy points for the PM.
