---
phase: 5
title: VPS deploy and docs
status: in-progress
priority: P2
dependencies:
  - 3
  - 4
---

# Phase 5: VPS deploy and docs

## Overview
Run the daemon on a small VPS behind Caddy (auto Let's Encrypt). Agent machines keep a local clone of this repo (hooks + MCP run locally) and point the connector at the public URL.

## Resource estimate
- Node 24 + SQLite single process, no background workers: expect ~80–150 MB RSS, near-zero idle CPU; long-polls are cheap (≤64 waiters).
- Caddy ~30 MB. Disk: image ~250 MB, DB grows with telemetry events (monitor; prune later if needed).
- → 1 vCPU / 1 GB RAM / 10–20 GB disk VPS is enough (≈ $4–6/month class). Measure with `docker stats` after deploy.

## Requirements
- `docker-compose.prod.yml`: `agent-office` (no published port, internal network), `caddy` (80/443), volumes for data + Caddy certs. Env: `AGENT_OFFICE_PUBLIC_ORIGIN`, `AGENT_OFFICE_TRUST_PROXY=true`, `AGENT_OFFICE_MIN_PASSWORD_LENGTH=16`, `AGENT_OFFICE_REMOTE_APPROVAL=true`.
- `Caddyfile`: `{$DOMAIN} { reverse_proxy agent-office:8080 }` (WS works by default); request body limit.
- Host firewall: allow 22/80/443 only; SSH key auth.
- Backup: cron `docker compose exec agent-office npm run backup` (verify script works in container) + copy off-box; document restore.
- Agent machine setup: `AGENT_OFFICE_DAEMON_URL=https://<domain> npm run connect` (already supported by `scripts/connect-local.ts:6`), `npm run install-hooks`, register MCP.
- Docs: update `docs/user-guide.md` (remote setup, handoff, approvals, `/remote-control` fallback for idle seats), `docs/operations.md` (deploy, backup, rotate password/connector), `docs/architecture.md` (remove LAN/remote from Frozen, new tables/flows).

## Steps
1. User provides VPS (SSH access) + domain with A record → VPS IP.
2. Install Docker, copy repo, set `.env` (strong password), `docker compose -f docker-compose.prod.yml up -d --build`.
3. Smoke: login over https, WS connects, 2 agents on 2 machines: mention wake, kill network 30 s during Stop → recovers, handoff after reassign, approve a Bash prompt from phone.
4. Write smoke report in `plans/reports/`.

## Risks
- Migrating existing local data: optional `npm run backup` locally → restore on VPS; otherwise start fresh and re-run `npm run connect` on every machine.
- Domain/TLS misconfig → Caddy logs; daemon never published directly.
