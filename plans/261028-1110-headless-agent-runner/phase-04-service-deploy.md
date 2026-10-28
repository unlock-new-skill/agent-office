# Phase 4 — Service install, docs, deploy, real E2E

Context: [plan.md](plan.md) · `src/connector/cli.ts`, `install-scripts/`, `docs/`.

## Requirements

- `agent-office.mjs runner install-service` / `uninstall-service`:
  - macOS: `~/Library/LaunchAgents/dev.agent-office.runner.plist` (RunAtLoad, KeepAlive, logs in `~/.agent-office/logs`);
  - Linux: `systemctl --user` unit (`Restart=always`), hint for `loginctl enable-linger`;
  - Windows: Task Scheduler task at logon (restart on failure).
  The service runs with the user's environment so the machine's Claude login/proxy env is used; the installer prints
  which env vars it captured (names only).
- `update` restarts the runner service when installed.
- Docs: user guide (VI) runner section, operations, architecture, OpenAPI.
- Deploy to VPS; real E2E on this Mac: 1 runner seat, mention → turn, kill process → resume, web interrupt/stop/start,
  permission prompt answered on web and auto-denied on timeout.

## Validation

- Test results + E2E notes in `reports/`.

## Rollback

- `runner uninstall-service`; seats can be used interactively again (Unassign + open with join link).
