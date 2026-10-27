---
phase: 5
title: Chat and org chart UI
status: completed
priority: P1
dependencies:
  - 1
  - 4
---

# Phase 5: Chat and org chart UI

## Overview
Replace current single-file control room with Slack-like workspace + org chart. React 19 only, no new UI libs. Realtime via existing WS stream.

## Requirements
- Functional:
  - Login (keep), then 2 views via top tabs: **Chat**, **Org**.
  - Chat view:
    - Left sidebar: `# leaders`, then each department (color dot, paused badge) → `# channel` + seat list with status dot (working/listening/idle/offline/wake-limited) + unread counts.
    - Center: message list (seq order, sender seat title + dept color, system lines styled differently, @mentions highlighted), composer with `@` autocomplete of seats, Enter send / Shift+Enter newline. Infinite scroll up via `after`/`before` paging.
    - Right panel tabs: **Members** (seat, role, bound session, current tool, wake state) | **Tasks** (dept tasks grouped by status; manager can create/update).
  - Org view:
    - Columns per department: leader card on top, member cards below (title + description excerpt), "+ seat", edit seat (title, description, role), dept settings (rename, color, pause, delete).
    - "Unassigned sessions" tray (project/cwd, last activity). Drag session card onto empty seat → assign; drag off → unassign. Keyboard alternative: seat menu "Assign session…" select.
    - "+ Department".
  - Errors: toast for action failures, inline empty states.
- Non-functional: responsive ≥1024px primary, usable at 768px (panels collapse); a11y: buttons for actions, labels on inputs, focus visible; no `dangerouslySetInnerHTML` (render text, mentions via split).

## Architecture
```
src/client/
  main.tsx, styles.css (rewrite tokens)
  api/http.ts            fetch wrapper + CSRF header
  api/stream.ts          WS connect, snapshot + delta reducer, reconnect w/ backoff
  state/office-store.ts  useReducer-based store (no new dep): org, messages by channel, tasks, agents
  views/login-view.tsx, chat-view.tsx, org-view.tsx
  components/sidebar.tsx, message-list.tsx, composer.tsx, members-panel.tsx, tasks-panel.tsx,
             seat-card.tsx, session-card.tsx, department-column.tsx, toast.tsx
```
(kebab-case file names match existing `src/client/pixel-world.tsx`.)
- CSRF: login returns `csrfToken`; currently stored but unused (`setCsrf` discarded) — fix: send `x-csrf-token` on mutations.
- Reducer applies collab deltas (message, org, task, agent) by seq; on `reset` replace state.
- `pixel-world.tsx` left in repo, not imported (frozen).
- Vite dev: add `server.proxy` `/v1` (incl. `ws: true` for `/v1/stream`) → daemon. Approved by user (Validation Session 1).
- Message history loaded via REST `GET /v1/channels/:id/messages` (not in WS snapshot); deltas append live.

## Related Code Files
- Modify: `src/client/main.tsx`, `src/client/styles.css`, `src/client/app.tsx` (becomes thin router), `vite.config.ts`
- Create: files listed above
- Tests: reducer + mention parsing unit tests `tests/unit/office-store.test.ts`, `tests/unit/mentions.test.ts` (pure TS, run under node test). No UI snapshot tests.

## Implementation Steps
1. **Tests first**: reducer (snapshot load, message delta append in order, duplicate seq ignored, org delta updates membership, reset replaces); mention split/highlight; unread count from cursor.
2. Build api/state layer, then views. Use `ck:frontend-design` / `ui-ux-pro-max` guidance for visual polish (clean, dense, Slack-like; dept colors as accents).
3. Manual browser check: golden path (login → seed visible → post to #dev → see realtime) + edge cases (WS drop/reconnect, long message, 20 seats, empty dept).

## Success Criteria
- [ ] Manager can run whole org from UI without curl.
- [ ] Realtime updates for messages, seat status, tasks without reload.
- [ ] Drag-assign + keyboard assign both work.
- [ ] build/lint/test pass; dev manually verified in browser (AI cannot verify rendering).

## Risk Assessment
- Big UI surface; keep components small (<200 lines each).
- Delta ordering bugs → covered by reducer tests.
