# t-pm-9: routing agent questions and permission prompts to PM/Dev Lead (LOCAL)

Repo root `/Users/truongpham/Desktop/my-studio`, branch `feat/agent-prompt-routing`, base `6b9f8fb` (the rollout candidate stays separate). LOCAL only: no deploy, no Windows, no real hooks/settings, no prod DB. Synthetic data only.

## 1. Capability matrix: verified on this Mac with Claude Code CLI 2.1.323 (`claude -p --input-format stream-json --output-format stream-json`, the runner's launcher)
Probe harness `/tmp/ao-pr/harness.mjs`, streams in `/tmp/ao-pr/t*.jsonl`. Windows CLI version not checked (Windows not touched).

| Kind | Official mechanism | Capture | Answer | Session resumes | Evidence |
|---|---|---|---|---|---|
| Tool permission prompt (non-bypass seats) | `--permission-prompt-tool stdio` → `control_request{subtype:can_use_tool, tool_name, input, tool_use_id, permission_suggestions}` → `control_response{behavior allow+updatedInput / deny+message}` | yes | yes | yes | t1 (allow ran), E2E P_allow / P_deny |
| Same, bypassPermissions seats (all 9 today) | no prompt exists | n/a | n/a | n/a | t2: only AskUserQuestion reached the host |
| AskUserQuestion: single, multiSelect, own words | same `can_use_tool`, `requires_user_interaction:true`; the answer is `updatedInput.answers{question: text}` | yes, **even in bypass** | yes | yes | t2, t10, E2E A |
| AskUserQuestion with no host (runner today) | the tool is **not offered** (init `tools` lacks it) | – | – | – | t3: the model said it could not ask |
| PermissionRequest hook in headless | fires in `-p` | yes | yes (hook output) | – | t4/t7: hook-events.jsonl. The hook printing `{}` → rejected (t7/t8). In t4/t5 a user-level hook on this Mac accepted it: not the probe hook, and not relied on |
| MCP elicitation | `control_request` other subtypes | – | runner replies with an error, so nothing hangs | – | **NOTRUN**: no office MCP server uses elicitation |
| PreToolUse hook DENY (privacy/scout) | none: deny is final | report only | no | the agent sees the reason | t9: tool_result "PreToolUse:Bash hook error: <reason>", plus `permission_denials` |
| Windows ExecutionPolicy | none (OS) | report only (tool output) | no | – | NOTRUN on Windows |
| Interactive stdin of a subprocess | none (no TTY in `-p`) | report only | no | – | not probed; by design |

Not used: terminal scraping, key injection, another provider, an LLM loop.

## 2. Flow implemented (smallest working path)
`claude -p` can_use_tool → `SeatWorker.onPrompt` computes binding = sha256({tool,input}) → `Runner.askOffice` POSTs `/v1/runners/me/prompts` (connector credential, its own seat only, idempotent on requestId) → server `PromptService` stores seat/session/requestId/toolUseId/kind/questions/summary/binding/resolvers/expiry (table `agent_prompts`, schema v31, additive) → a short notice wakes the resolvers (ids and headers only) → a resolver uses `agent_office_prompts` list/get/answer (or the manager uses the web bar) → the runner long-polls `/v1/runners/me/prompts/:id` → `control_response` goes to the same request of the same process → `/delivered`.
- **Resolvers (server-enforced):** a member's leader and deputy, notified in the department channel. Leaders, deputies and coordinators are answered by the coordinators in #leaders. The manager can always answer. Never the asker.
- **Manager-only:** a word list (secret/token/credential/settings.json/ExecutionPolicy/deploy/prod/live/paid/rm -r/git push/…), or no delegate available.
- **Safety:**
  - one decision per prompt (`UPDATE … WHERE status='pending' AND expires_at>now`);
  - the binding must match, both on the server and in the runner;
  - an allowed permission passes the original input unchanged; answers are plain text (control characters flattened, ≤500 chars);
  - 20-minute expiry → denied; a process exit → cancelled; a late or replayed answer is refused (409) and never written to a new process;
  - at most 4 pending prompts per seat;
  - the runner-managed PermissionRequest hook no longer files a second manager prompt.
- **Visibility:**
  - seat status detail `waiting for an answer to <a question|permission for X> since HH:MM UTC`;
  - runner log lines `prompt <id> filed` and `answer delivered` or `denied`;
  - the web bar shows the seat, the waiting time, the resolvers and the expiry; the status goes pending → answered/denied → delivered.
  - No task status, DONE or PASS changes.

Files: `src/server/collaboration/prompt-service.ts` (new), `src/server/db/database.ts` (v31), `src/server/runner-routes.ts`, `src/server/office-routes.ts`, `src/server/collaboration/{office,runner-service}.ts`, `src/connector/runner/{claude-process,seat-worker,runner}.ts`, `src/connector/hook-runner.ts`, `src/connector/mcp-server.ts` (tool `agent_office_prompts`), `src/shared/contracts.ts`, `src/client/components/{prompt-card,approvals-bar}.tsx`, `src/client/state/*`, `src/client/app.tsx`, `docs/operations.md`, `docs/api/openapi.yaml`.

## 3. Tests
- Unit: `tests/unit/agent-prompts.test.ts` (6) covers resolver routing and notice, idempotent filing, wrong actor, asker, other runner, coordinators, manager-only, binding, answer validation, expiry, cancel, queue limit, and two concurrent resolvers giving one decision.
- Unit: `tests/unit/runner-prompts.test.ts` (4) covers control_request parsing and the error reply for other subtypes, the binding, waiting status, the allow answer, an allowed permission passing the original input (injected answers ignored), a mismatched binding giving deny, no routing giving deny, and an exit while waiting giving cancelled with no late write.
- Integration: `tests/integration/agent-prompts-api.test.ts` covers the real HTTP routes with runner, agent and manager auth.
- Full suite **302/302**; tsc, eslint and vite build clean.

## 4. E2E LOCAL with the real harness (synthetic in-memory office, in-process server, real `Runner` + `SeatWorker` + `spawnClaude` + Claude Code 2.1.323)
The CLI ran through the shim `/tmp/ao-pr/bin/claude` with `--setting-sources project --strict-mcp-config`, so no real Agent Office hooks or MCP were loaded. Scripts: `/tmp/ao-pr/e2e-agent-prompts.mts` and `/tmp/ao-pr/e2e-agent-prompts-permission.mts`. Logs: `/tmp/ao-pr/e2e-run.log` and `/tmp/ao-pr/e2e-perm.log`.

| Case | Result |
|---|---|
| A: 3 questions (single, multiSelect, own words), bypass seat | filed to @dev-lead; dev-fe answer 403; lead 200; replay 409; session reply `"Which color?"="Blue", "Which sizes?"="S, L", "Project name?"="Gamma (own words)"`; status delivered |
| B: "Deploy target?" | manager-only (`sensitive: "Deploy"`), lead cannot see it, lead answer 403; manager deny 200; session reply quotes the deny reason and continues; delivered |
| C: seat stopped while waiting | prompt cancelled; late answer 409 |
| P_allow: Bash write outside cwd, acceptEdits seat | permission prompt to @dev-lead; peer 403; lead allow → command ran (file exists) |
| P_deny: same with deny | not run (file absent); agent did not retry another way |

Observed: the seat detail on the server view showed `working` when sampled right after filing (the runner pushes status in batches), while the runner's own status showed `waiting for an answer`. The server-side waiting signal is the prompt itself (pending, createdAt).

## 5. NOTRUN / limits
- Real 20-minute expiry: the E2E did not wait that long. Unit tests cover expiry with a moved clock and the integration test covers cancel.
- Disconnect from the server during the wait: unit level only. The runner retries until expiry plus 60 s, then denies.
- Windows: launcher via cmd.exe, CLI version, ExecutionPolicy. Everything Windows is NOTRUN.
- MCP elicitation: NOTRUN.
- The manager-only list is a heuristic on visible text. It cannot judge "within assigned scope"; resolvers are told to answer only within the seat's assigned work.
- A resolver whose own turn waits on a prompt cannot answer others until it resumes. Expiry bounds that; the manager can always answer.
- Prompt-routing data stays on the server (no new external service). Telegram notification for manager-only prompts was not added (pm2 flow kept separate).

## 6. Activation proposal (for a separate operations decision; not done)
1. Deploy the server with v31 (additive table; 9410fb9/6b9f8fb cannot open v31, so a rollback is `DROP TABLE agent_prompts; PRAGMA user_version=30` with the container stopped and a backup taken, same pattern as the tested v30 → v29).
2. Update the Windows connector (the same pinned install-self path as t-pm-6), then restart the runner. Each seat restarts with `--permission-prompt-tool stdio`; sessions resume.
3. Effect on sessions:
   - bypass seats gain AskUserQuestion, routed to their lead; nothing else changes;
   - non-bypass seats' tool prompts go to the lead instead of the PermissionRequest hook and manager UI.
4. Rollback of the connector restores the old behaviour (no AskUserQuestion; prompts denied).

## Unresolved questions
- Who are the coordinators in the live office? Leaders' prompts go to them; if none, they go to the manager.
- Is a 20-minute expiry right for the team?
- Should manager-only prompts also go to Telegram (a pm2 decision)?

## 7. Revision after PM #475 and the independent review (REQUEST CHANGES)
Review: `plans/reports/code-reviewer-261114-1830-agent-prompt-routing-review-report.md` (3 high, 6 medium; the delta review is appended there).

**Routing bound to actor + task + server-verified binding (PM 1).**
- A prompt binds to the seat's task in progress (`agent_prompts.task_id`).
- Resolvers carry a role:
  - **technical**: the leaders and deputy of the task's department (for members) and the lead of the parent task;
  - **business/priority**: the PM coordinators.
- Never the asker. A resolver that is itself waiting on a prompt is skipped, so seats never wait on each other.
- The manager-only cases, each shown with its reason:
  - no task in progress;
  - no resolver left;
  - every resolver is itself waiting;
  - an input too long to show;
  - sensitive words (checked on the whole input, an extra signal only).
- The notice goes into the task thread.
- The server recomputes the binding from the input it receives; a mismatch gets 400. A request id reused with other content gets 409.

**Lifecycle (PM 2).** Each prompt has a `state` label, the same in the web bar ("Recent prompts") and over MCP:
- waiting;
- answered or denied, not yet delivered;
- delivered;
- for an allowed permission, after its tool result: ran, or ran with an error;
- expired (denied, not run);
- cancelled (session stopped, request withdrawn or runner offline; not run).

**Review fixes.**
- H1: the whole input is scanned and a delegate sees every field; a prompt whose input does not fit is manager-only.
- H2: `control_cancel_request` is handled. The CLI 2.1.323 binary contains this message type. A withdrawn request is never answered and its prompt is cancelled.
- H3: polls are throttled.
- M1/M2:
  - cancels are per prompt id;
  - a prompt filed after the session stopped waiting is withdrawn at once;
  - filing is retried, since it is idempotent;
  - a runner restart cancels its orphaned prompts;
  - the server sweep cancels the prompts of offline runners.
- M3: the input limit is now 256 KB.
- M4: v31 was never created on any persistent database; tsc is used as a gate.
- M5: as above, resolvers that are waiting are skipped.
- M6: tests added.

**Tests:** 306/306; tsc, eslint and build clean.

**E2E rerun** (real CLI, synthetic office with task t-dev-1 in progress). Logs: `/tmp/ao-pr/e2e-run2.log`, `/tmp/ao-pr/e2e-perm2.log`.
- A: the notice says "(task t-dev-1). technical: @dev-lead — answer only within t-dev-1". Peer 403, lead 200, replay 409. State "answered by @dev-lead: answer delivered to the session".
- B: manager-only (Deploy). State "denied by the manager: denial delivered, not run".
- C: "cancelled: the session stopped or restarted, not run"; a late answer gets 409.
- P_allow: "allowed by @dev-lead: delivered, ran".
- P_deny: "denied by @dev-lead: denial delivered, not run"; no file was written.

**About "9 seats bypass":** this was inferred from the launcher default (`permissionMode` defaults to `bypassPermissions` in runner-config and runner-routes). It was not observed at runtime: the t-dev-526 metadata did not include the permission mode, and production data was not read.

## 8. Second revision after the delta review (D1–D6)
- **D1:** a tool permission can only be answered by the task's technical leads. The PM coordinators answer questions only. A permission with no technical lead goes to the manager.
- **D2:** the scope is checked again when someone answers (`prompt_scope_changed`). An ambiguous scope (several tasks in progress, not exactly one execution task) goes to the manager.
- **D3:** a decision that was never delivered is cancelled together with the session, and the record keeps who decided plus `cancel_reason`, e.g. "cancelled (the session withdrew the request), after an answer by @x that was never delivered: not run".
- **D4:** a tool result that arrives before the delivery notice is kept, and the prompt is marked delivered.
- **D6:** the binding is computed in one shared place (`src/shared/prompt-binding.ts`); the keyword scan reads the raw strings, not JSON-escaped text.
- **M4:** new `npm run typecheck` script.
- **M6:** tests added.
- **Checks:** typecheck, 310/310 tests, lint and build all clean.
- **Real E2E rerun:** passed. Logs: `/tmp/ao-pr/e2e-run3.log`, `/tmp/ao-pr/e2e-perm3.log`.
