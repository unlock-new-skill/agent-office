---
name: agent-office-planning
created: 2026-10-24
---

# Agent Office Planning

## Context

Greenfield local project. No source code existed. Brainstorm and implementation plan completed; no implementation, lint, build, or runtime test ran.

## Decisions

- Build custom local TypeScript daemon with Hono, SQLite, REST, WebSocket, MCP, and React/Phaser UI.
- Connect Claude Code and Codex through hooks plus MCP.
- Require password for web, API, and MCP.
- Store raw local transcripts unencrypted by explicit user decision; password does not protect filesystem data.
- Include full pixel map editor and free pathfinding.
- Keep deployment local-only for 2–20 agents; exclude remote access and remote permission control.
- Keep event/state daemon-owned; Phaser remains visualization/editor layer.

## Review and validation

Applied 14 user-approved red-team groups across all seven plan files. Four validation answers confirmed: stop schema freeze if required CLI capability is missing; retain plaintext/no-age-deletion storage and quotas; queue idle-agent messages until next supported turn/poll; block phase exit/release on applicable SLO failures. Whole-plan document consistency checked; runtime compatibility and performance remain unverified.

## Next

Await separate implementation authorization. Begin with phase-1 CLI/runtime feasibility proof; no source implementation or application tests ran during planning.

Plan: `plans/261023-2211-agent-office-control-room/plan.md`
