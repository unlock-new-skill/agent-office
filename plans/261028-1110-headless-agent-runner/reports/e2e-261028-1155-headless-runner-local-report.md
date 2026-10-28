# E2E — headless runner on a real Claude Code (local daemon)

Date: 2026-10-28 · Claude Code 2.1.312 · macOS · local Docker daemon · isolated `AGENT_OFFICE_HOME` + `CLAUDE_CONFIG_DIR` under /tmp (removed after).

| Check | Result |
|---|---|
| Runner registers, seat `dev-be` auto-starts, first turn runs, seat idles "listening" | ✅ |
| Agent Office MCP tools usable headless | ❌ → fixed: runner always passes `--allowedTools mcp__agent-office` (calls were denied with nobody to approve) |
| Restart runner → session resumed (`--resume`, same id), resume prompt turn | ✅ |
| Manager mentions `@dev-be` in #dev → woken without terminal, replied `RUNNER-PONG` (< 10 s) | ✅ |
| `kill -9` the claude process → restart after 2 s with the same session | ✅ |
| Web commands: prompt (sent), interrupt while idle (refused: no turn running), stop (stopped), start (resumed 941cdc1c) — audit rows done/failed with results | ✅ |
| SIGTERM to runner → seat stopped cleanly | ✅ |
| Shell command needing approval with nobody approving (`curl`) → denied at once, agent reports it, seat back to listening | ✅ (`touch` in cwd is auto-allowed by `acceptEdits`, as designed by Claude Code) |

Not exercised live: approving from the web/Telegram in headless mode (local daemon has remote approval off). Covered by the spike (PermissionRequest hook `allow` works headless) and unit tests (notifier decides prompts). Windows/Linux services: generated files unit-tested only.
