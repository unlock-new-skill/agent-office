---
phase: 3
title: Public deployment hardening
status: completed
priority: P1
dependencies: []
---

# Phase 3: Public deployment hardening

## Overview
Daemon assumes loopback: host/origin allowlist is `http://<host>:<port>` (`app.ts:21-24`, `index.ts:37,60,85`), non-container mode refuses non-local hosts (`index.ts:22`), cookie lacks `Secure`, login rate-limit keys on socket peer (`index.ts:42`) which behind a proxy is always the proxy. Make it safe to sit behind Caddy on the public internet.

## Requirements
- Config (`config.ts`):
  - `AGENT_OFFICE_PUBLIC_ORIGIN` (e.g. `https://office.example.com`) → its host added to allowed hosts, origin added to allowed origins (HTTP middleware, static handler, WS upgrade — single shared helper instead of the 2 duplicated computations).
  - `AGENT_OFFICE_TRUST_PROXY=true` → peer key = last `X-Forwarded-For` hop set by Caddy; otherwise socket address (unchanged).
  - `AGENT_OFFICE_MIN_PASSWORD_LENGTH` default stays 8 locally; production compose sets 16. Update the "local-only" comment in `auth-service.ts`.
- Cookie: add `Secure` when public origin is https.
- Security headers on HTML/API: `Strict-Transport-Security` (when https), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, basic CSP for the built client.
- Login rate limit unchanged in numbers (5/key, 20 global per window); add exponential lockout per key? → no (YAGNI); keep.
- Connector/session tokens unchanged (bearer, hashed at rest); document rotating the connector via `npm run connect`.
- `.env.example` gains new keys with comments.

## Files
- Modify: `src/server/config.ts`, `src/server/app.ts`, `src/server/index.ts`, `src/server/auth/auth-service.ts`, `src/server/static-client.ts`, `.env.example`
- Tests: `tests/integration/security.test.ts` — public origin accepted, other origins rejected, XFF ignored unless trusted, `Secure` cookie, WS upgrade with public origin.

## Steps
1. Failing security tests.
2. Shared `allowedHostsAndOrigins(config)` helper used by app + index.
3. Headers middleware, cookie flag, peer resolution.
4. `npm test && npm run lint && npm run build`.

## Risks
- Wrong XFF handling lets attackers spoof IPs to dodge the per-key limit → only honor XFF when `TRUST_PROXY` and app port is not published publicly (compose binds it to the internal network only).
- Exposed `/join/:id` and `/agent-guide` remain unauthenticated GETs → they reveal seat ids/occupancy. Acceptable? Default: require manager cookie or agent bearer for `/join/:id` status JSON when public origin is set. Confirm with user if it breaks their join-link flow.
