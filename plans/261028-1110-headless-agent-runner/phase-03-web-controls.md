# Phase 3 — Web UI: seat controls, live log, Setup

Context: [plan.md](plan.md) · `src/client/components/seat-card.tsx`, `views/setup-view.tsx`, map seat panel.

## Requirements

- Seat card (Org + Map detail) for a seat offered by a connected runner: badge "runner · <machine>", runner state
  (running / idle / stopped / failed, restart count), buttons Start, Stop, Restart, Interrupt, and a Send prompt box.
  Destructive actions (Stop, Restart) ask for confirmation in a modal (no native confirm()).
- Command feedback: pending → done/failed with the runner's message (toast).
- Live log drawer per seat: last 300 entries (text, tool name, result, errors), auto-scroll, updates over WS.
- Audit list in the drawer: last commands with who/when/result.
- Seat status mapping: runner `failed` → red, `stopped` → offline style; map 3D/2D reuse existing statuses.
- Setup page: new section "Chạy agent không cần terminal (runner)": `runner init`, edit `runner.json` (example per OS),
  run in foreground, install as service (phase 4 commands), mixing with interactive seats.

## Files

- Create `src/client/components/runner-controls.tsx`, `src/client/components/seat-log-drawer.tsx`.
- Modify `src/client/components/seat-card.tsx`, `src/client/state/office-store.ts` (runner state, log, commands),
  `src/client/use-office.ts` (WS events), `src/client/views/setup-view.tsx`, `src/client/styles.css`.
- Tests: store reducer tests for runner events/log ring.

## Validation

- Playwright screenshots with mocked runner state (desktop + 390 px); real run in phase 4.
- Developer must open the browser to check the golden path (start → prompt → log → interrupt → stop) and narrow screens.
