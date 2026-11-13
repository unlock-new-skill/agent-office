# t-pm-2 — Telegram manager approval requests (report)

Task t-pm-2 (#pm 281, from manager #pm 278). START 23:20 ICT. Reuses the existing Office Telegram bot (`src/server/notify/*`): one paired chat, proxy, long-polling, inline buttons. No second bot or framework.

## Mapping

| Need | Storage | API | MCP |
|---|---|---|---|
| Request: id, requester, action, scope, reason, consequences, target, expiry, link to task/thread | `approval_requests` (schema v26) | `POST /v1/approvals`, `GET /v1/approvals[?status]`, `GET /v1/approvals/:id` | `agent_office_approval` request / list / status |
| Edit = new revision + new nonce; cancel | same | `PATCH /v1/approvals/:id`, `POST …/cancel` | update / cancel |
| Manager decision (web) | status, decided_by/via/at, note | `POST …/decision {decision, revision}` (manager only) | — (manager is not a seat) |
| Telegram decision | nonce per revision (24 hex, never leaves the server) | callback `ap:a|r:<nonce>` | — |
| Delivery status, kept apart from the decision | delivery_status / attempts / error / next_attempt_at / message_id | `POST …/resend` (manager) | shown in status |
| Audit | `approval_events` (requested, superseded, approved, rejected, expired, cancelled, delivery_*, callback_refused, resend) | `GET /v1/approvals/:id` events | status |

Web: pending requests appear in the approvals bar at the top right, next to permission prompts, with Approve / Reject and "Send to Telegram again" on failed or uncertain delivery.

## Rules (verified by tests, `tests/unit/manager-approvals.test.ts`, SYNTHETIC fixtures + fake Bot API)

- **Who can ask:** a seat only, about a task it can read or a thread it is in. The manager cannot ask; seats from other departments are refused (`forbidden_task_read` / `forbidden_channel`).
- **No credentials:** text that looks like a credential is refused (`approval_contains_secret`): key=value, JSON form, prose, bearer, private keys, URL with a password, Telegram/GitHub/Slack/AWS/Office tokens, long mixed-case strings. Paths, slugs and commit hashes are allowed.
- **Telegram gets a minimal summary:** id/revision, requester, task/thread, action, scope, reason (max 300 characters), consequences, target, expiry and "runs nothing".
- **Retries don't duplicate:** the same pending content asked again returns the same request (HTTP 200, `duplicate: true`), and only one Telegram message is sent. Editing a request so it matches another pending one is refused. Limits: 10 pending per seat, 100 in total.
- **Only the manager decides:**
  - From the web: the manager session, with the revision the manager saw (an older revision gives `approval_superseded`).
  - From Telegram: the paired chat only, and only if it is private. The sender must be that user, and the press must be on the message sent for the current revision.
  - Refused presses are recorded as `callback_refused`: wrong chat, wrong sender, group chat, button from another message.
- **Repeats and edits:** pressing again or sending the same web decision again changes nothing ("Already approved."). Each edit is a new revision; old buttons answer "Not current" and the old message is marked "Replaced".
- **Expiry:** at expiry a request becomes expired, never approved. The sweep runs every 60 s and on reads.
- **Result goes back to the conversation:** a line in the task thread (or the original thread) wakes the requester and its lead. It states scope, actor, channel, time and "valid until". It wakes no seat that caused the line (for example a requester cancelling).
- **Approval only records the decision:** task status, result and dependencies stay unchanged (tested). Nothing is executed.
- **Delivery status is truthful:**
  - Telegram off → `disabled`. Not paired → `not_paired`; it sends by itself once paired.
  - Group chat paired → `failed`.
  - 429 → retries after `retry_after`. Network error before sending → retries with backoff, then `failed` after 5 attempts.
  - Timeout or 5xx → `uncertain`. It is never resent by itself; the manager can resend.
  - In every case the decision stays `pending` until someone decides.
- **Failure handling:** after a saved decision, posting the line or a removed seat or channel never turns into an error. Edits share the rate budget and are retried until they succeed.

## Review

Independent `code-reviewer` agent (separate context, given the diff only) found 0 critical, 0 high, 3 medium and 7 low issues. Fixed:
- **Medium:** an error after a saved decision (posting the line could throw because the requester seat was removed); credential filter missed JSON and prose; a cancelling seat woke itself.
- **Low:** a send during an edit left a message that looked live → it is now marked replaced; 5xx is now uncertain (no duplicate); edits are retried and rate-limited; `list` filtered after LIMIT; misplaced migration comment; editing could create a duplicate pending request.

Not fixed (documented): if a timed-out send actually arrived, that message never gets its outcome edit. Its buttons still decide only the current revision, and the Office audit is the source of truth.

Verified OK by the reviewer:
- The nonce is never in the API, events or WebSocket payloads; WebSocket is manager-only; service tokens cannot read approvals.
- The conditional `UPDATE … WHERE status='pending' AND revision=?` makes concurrent and replayed decisions safe.
- The migration only adds tables.

## Verification

`npm test` 248/248 (Node 24.11.1); lint clean; production compile ok; gitleaks clean.

## Operator setup (no secrets here)

- **Already on prod:** bot token and proxy in the server `.env`, chat paired. Read-only check at 23:20: the paired chat is private.
- **Missing chat or bot:** Setup → Telegram → pair from a **private** chat with the bot. The token is only ever set on the server (`AGENT_OFFICE_TELEGRAM_BOT_TOKEN`); never paste it in Office or chat.
- **Optional:** `AGENT_OFFICE_PUBLIC_ORIGIN=https://…` adds an "Open Agent Office" button. It is not set on prod.
- **New tool:** `agent_office_approval`. Only seats that need to ask must be restarted once. No other tool schema changed.

## Rollback

Restore the DB backup taken before the deploy (`/var/backups/agent-office/`) and deploy the previous commit. v26 only adds tables, so the old code ignores them.

## Limits / NOTRUN

- Live end-to-end on real Telegram: see the done note. It needs one seat with the new tool (a single seat restart) and one manager press on a TEST request.
