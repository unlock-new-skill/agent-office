---
title: Headless Agent Runner
description: >-
  A per-machine runner (connector mode `runner`) that keeps seated Claude Code sessions alive headless, restarts and
  resumes them, feeds them mentions, and takes start/stop/restart/interrupt/prompt commands from the web UI.
status: done
priority: P1
branch: ''
tags:
  - feature
  - backend
  - frontend
  - security
  - devops
blockedBy: []
blocks: []
created: '2026-10-28T04:10:00.000Z'
createdBy: 'claude'
source: chat
---

# Headless Agent Runner

## Overview

The manager is often away from the machines. Today a dead session stays dead, a permission prompt that times out on the
web falls back to a terminal nobody watches, and there is no way to stop, restart or prompt an agent remotely.

Goal: a long-running runner service on each agent machine owns the seats configured for that machine. It runs each seat as a
headless `claude -p` process (stream-json in/out), restarts crashed sessions with `--resume`, hands mentions to the
seat as new turns, streams a live log to the web, and executes manager commands sent from the UI.

## Key decisions (from chat 2026-10-28)

- Approach: headless CLI runner (option 3), not a TUI wrapper and not `/remote-control` only.
- Language: Node, shipped inside the existing connector bundle (`agent-office.mjs runner`); no extra install.
- Drive the `claude` CLI (uses the machine's own Claude login / proxy settings), not the Agent SDK.
- Security boundary: the runner only runs seats and working directories listed in its local `runner.json`; the server
  can never send a command line, path or environment. Commands are manager-only and audited.
- Default permission for runner seats: `acceptEdits` (file edits allowed; shell and other tools wait for Allow/Deny on the
  web, denied when the wait ends). Overridable per seat in `runner.json`.
- Scope: all phases, plus Telegram notifications (phase 5) requested mid-way.
- Notifications: Telegram bot with inline Allow/Deny buttons; all Telegram traffic goes through a manager-supplied
  proxy (VPS is in Vietnam, direct bot traffic is unreliable). Bot is paired to one chat with a code shown in the web UI.

## Spike results (Claude Code 2.1.312, this Mac, 2026-10-28)

| Question | Result |
|---|---|
| One process, many turns (`-p --input-format stream-json --output-format stream-json --verbose`) | ✅ same session id, context kept across turns |
| Resume after the process exits (`--resume <id>`) | ✅ remembers earlier turns |
| PermissionRequest hook in headless mode | ✅ fires; `behavior: allow` lets the tool run. Without a decision the tool is denied (no terminal fallback) |
| Interrupt a running turn (`control_request` `{subtype:'interrupt'}` on stdin) | ✅ `control_response success`, turn ends `error_during_execution` |
| Model / auth | Default model and auth of the machine apply (env/proxy). Do not pass `--model` unless the seat config sets one |
| Nested-session env | Strip `CLAUDECODE`, `CLAUDE_CODE_*` session vars before spawning |

## Phases

| # | Phase | Status | File |
|---|---|---|---|
| 1 | Runner core on the machine | done | [phase-01-runner-core.md](phase-01-runner-core.md) |
| 2 | Server: runner registry, commands, live log | done | [phase-02-server-runner-api.md](phase-02-server-runner-api.md) |
| 3 | Web UI: seat controls, live log, Setup | done | [phase-03-web-controls.md](phase-03-web-controls.md) |
| 4 | Service install, docs, deploy, real E2E | done | [phase-04-service-deploy.md](phase-04-service-deploy.md) |
| 5 | Telegram notifications + approve from chat (via proxy) | done | [phase-05-telegram-notify.md](phase-05-telegram-notify.md) |

Dependencies: 1 → 2 → 3; 4 after 3; 5 needs only the existing permission service (can ship first). Phases 1 and 2 share only the HTTP contract defined in phase 2.

## Acceptance criteria

- Kill a runner-managed `claude` process: it is back within 60 s on the same session (`--resume`), seat context intact.
- Mention a runner seat in a channel: it starts a new turn within seconds, without any terminal.
- From the web: Start, Stop, Restart, Interrupt and Send prompt work on a runner seat; each command shows its result and
  is recorded in an audit log (who, when, what).
- A permission prompt on a runner seat is answered on the web; unanswered prompts are denied after the wait, never stuck.
- Runner survives network loss and daemon restarts (reconnects by itself) and starts at login/boot as a service.
- Runner refuses any seat not in its `runner.json`; server API has no way to pass paths, commands or env.
- Interactive (terminal) seats keep working unchanged; a machine can mix both.
- A pending permission prompt reaches the paired Telegram chat within seconds with Allow/Deny buttons that decide it;
  runner seat failures/stops are notified too. Works when Telegram is reachable only through the proxy.

## Risks

- Claude Code stream-json protocol is not a stable public contract → isolate it in one adapter module with a fake-CLI test.
- Unattended agents with broad permissions → per-seat `permissionMode` in local config, default `acceptEdits`; shell still needs web approval.
- Cost: every wake is a model turn, same as today; restart loops capped (5 crashes / 10 min → seat marked failed).
