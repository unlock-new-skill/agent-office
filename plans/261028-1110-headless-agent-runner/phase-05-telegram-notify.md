# Phase 5 — Telegram notifications + approve from chat

Context: [plan.md](plan.md) · `src/server/collaboration/permission-service.ts` (pending prompts, decide), config/env.

## Requirements

- Server env (VPS `.env`, never committed; documented in `deploy/.env.prod.example`):
  `AGENT_OFFICE_TELEGRAM_BOT_TOKEN`, `AGENT_OFFICE_TELEGRAM_PROXY` (`http://user:pass@host:port` or
  `socks5://user:pass@host:port`). Feature off when the token is missing.
- All Telegram API calls (sendMessage, editMessageText, answerCallbackQuery, getUpdates) go through the proxy dispatcher.
- Updates by long-polling `getUpdates` (outbound only, through the proxy) — no public webhook. Retry with backoff; log
  proxy/network failures without the URL credentials.
- Pairing: web UI (Setup → Notifications) shows a one-time code (10 min); the manager sends `/start <code>` to the bot;
  the chat id is stored (schema: `settings` row). Only that chat is served; others get no reply. Unpair button in UI.
- Notify on: new permission prompt (seat, tool, short input, wait deadline) with inline buttons Allow / Deny; prompt
  resolved elsewhere or expired → message edited to show the outcome; runner seat `failed`/unexpected stop; optional
  wake-limit hit. Rate limit: max 20 messages/min, collapse bursts.
- Button callback → `permissions.decide(id, allow|deny, by: 'telegram')`, answerCallbackQuery, edit message.
  Callback data carries only the prompt id + decision; decision checked against the paired chat id.
- Setup page section with steps: create bot with @BotFather, set the two env vars, restart, pair.

## Files

- Create `src/server/notify/telegram-client.ts` (proxy dispatcher, API calls), `src/server/notify/telegram-notifier.ts`
  (pairing, update loop, subscriptions to permission/runner events, message formatting).
- Modify `src/server/config.ts`, `src/server/index.ts` (start/stop), `src/server/db/database.ts` (settings table if
  missing), `src/server/collaboration/permission-service.ts` (event hook for created/settled), routes for pairing,
  `src/client/views/setup-view.tsx`, `deploy/.env.prod.example`, docs.
- Dependencies: `undici` (ProxyAgent for http proxies), `fetch-socks` (socks5) — check size before adding.
- Tests: notifier with a fake Telegram API (pairing, wrong chat ignored, approve via callback, expiry edit, rate limit).

## Validation

- Tests; real check on the VPS with the manager's bot + proxy (send a test message from the UI).

## Security

- Bot token and proxy credentials only in server env; never logged or sent to the browser.
- Callback approval only from the paired chat; prompt ids are random; decisions are audited like web decisions.
