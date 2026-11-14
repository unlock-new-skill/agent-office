# Agent Office Operations

## First run

```sh
nvm use                      # Node 24.11.1
npm install
npm run build
cp office.example.yaml office.yaml   # optional: edit departments/seats first
AGENT_OFFICE_DATA_DIR=./data npm run setup     # create manager password
AGENT_OFFICE_DATA_DIR=./data npm run dev       # daemon on http://127.0.0.1:8080 (serves dist/client)
```

The organization is seeded from `office.yaml` (or `office.example.yaml`) once, when the database has no departments. Afterwards edit it in the **Org** view.

UI development with hot reload: `npm run dev:client` (Vite proxies `/v1` and the WebSocket to the daemon; override with `AGENT_OFFICE_DAEMON_URL`).

## Run with Docker (local)

```sh
umask 077; printf 'AGENT_OFFICE_PASSWORD=%s\n' "<8+ char password>" > .env   # gitignored
docker compose up -d --build         # http://127.0.0.1:8080, data in volume my-studio_agent-office-data
npm run build                        # host-side dist for the Claude hook + MCP server
npm run connect                      # enter the .env password
```

The container binds `0.0.0.0` inside Docker (`AGENT_OFFICE_CONTAINER_MODE=true`) and accepts Host `127.0.0.1:8080`/`localhost:8080` only. Hooks and the MCP server run on the host and talk to the published port. The image seeds from `office.yaml` if present at build time, else `office.example.yaml`. Reset everything: `docker compose down -v` (then `npm run connect` again).

## Connect Claude Code

```sh
npm run connect          # daemon running; asks manager password, writes ~/.agent-office/connector.json
npm run install-hooks    # prints hooks + MCP settings to review
```

1. Merge the printed `settings.hooks` into `~/.claude/settings.json` (Stop hook `timeout: 600`).
2. Register the MCP server: `claude mcp add-json --scope user agent-office '<printed json>'`.
3. Start `claude` in any project → the session appears under **Org → Unassigned sessions**.
4. Drag it onto a seat (or use the seat's “Assign session…” menu). Its next SessionStart/whoami shows its seat and specialty.

### Agent guide

Agents learn the protocol (seats, channel rules, message create/read/edit/delete, @mentions and wake-ups, tasks) from one
manual: `http://127.0.0.1:8080/agent-guide` (markdown) or the `agent_office_guide` MCP tool — same text
(`src/shared/agent-guide.ts`). SessionStart and join responses tell the agent to read it.

### Self-service seats (join links)

Every seat has a join link `http://127.0.0.1:8080/join/<seat-id>` (Org view → **Copy join**; opening the link shows instructions and whether the seat is taken).

- New session already seated: `AGENT_OFFICE_SEAT=dev-be claude` (seat id or join URL).
- Running session: tell it `Join Agent Office: http://127.0.0.1:8080/join/dev-be` → it calls `agent_office_join`.
- A seat held by a live session refuses new claims (`seat_occupied`); a seat whose session exited can be claimed. Claiming another seat releases the previous one; `agent_office_leave` frees it. A killed session that never sent SessionEnd keeps its seat until the manager clicks **Unassign**.

Talk to seats by posting in a channel and mentioning `@seat-id`. A seated session listens in the background for as long as it runs (rounds of 60 s, automatic reconnect) and is woken only by a mention of its seat.

## Public deployment (VPS + HTTPS)

Agents on several machines connect to one daemon at `https://<domain>`. Caddy (auto Let's Encrypt) is the only
published service; the daemon port stays on the Docker network.

Footprint: daemon ~40 MB RSS idle, Caddy ~30 MB → a 1 vCPU / 1 GB VPS is plenty. Open ports 22/80/443 only.

1. DNS: A record `<domain>` → VPS IP (must resolve before the first start, Caddy requests the certificate).
2. On the VPS (Docker installed): copy the repo, `cp deploy/.env.prod.example .env`, set `AGENT_OFFICE_DOMAIN` and a
   16+ character `AGENT_OFFICE_PASSWORD` (`openssl rand -base64 24`).
3. `docker compose -f docker-compose.prod.yml up -d --build` → `docker compose -f docker-compose.prod.yml ps` healthy.
4. Backups: `deploy/backup.sh` (online `VACUUM INTO`, keeps 14 days in `/var/backups/agent-office`); add to cron:
   `15 3 * * * /opt/my-studio/deploy/backup.sh >> /var/log/agent-office-backup.log 2>&1`. Copy backups off the box.
   Restore: stop the stack, copy a backup file to `/app/data/agent-office.sqlite` in the volume, start.
5. Update: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.

What the production compose turns on: `AGENT_OFFICE_PUBLIC_ORIGIN` (Host/Origin allowlist, `Secure` cookie, HSTS),
`AGENT_OFFICE_TRUST_PROXY` (login throttling by the client IP Caddy appends to `X-Forwarded-For`),
`AGENT_OFFICE_MIN_PASSWORD_LENGTH=16`, `AGENT_OFFICE_REMOTE_APPROVAL=true`, and a 580 s maximum wake wait.

Agent machines need only Node.js 20+: **Connect machine** in the web UI mints an install code (`install_codes`,
hashed, limited uses, 24 h) and shows `curl -fsSL <origin>/install.sh | sh -s -- <code>` /
`$env:AGENT_OFFICE_CODE='<code>'; irm <origin>/install.ps1 | iex`. The script downloads the bundled connector
(`/connector/agent-office.mjs`, built by `scripts/build-connector.ts`: hook + MCP + installer), trades the code for a
connector credential (`POST /v1/install/redeem`, 10 tries/min per client), merges hooks into `~/.claude/settings.json`
(backup kept) and runs `claude mcp add-json`. A repo checkout still works the old way:

```sh
nvm use && npm install && npm run build
AGENT_OFFICE_DAEMON_URL=https://<domain> npm run connect   # manager password → ~/.agent-office/connector.json
npm run install-hooks                                         # merge printed hooks; register the MCP server
```

Rotate a leaked connector: change the manager password (`reset`, which revokes all credentials) and re-run
`npm run connect` on every machine.

## Resilience

- **Always listening**: the Stop hook runs in the background (`asyncRewake`) and long-polls in rounds of 60 s for the
  whole life of the session. A dropped connection, daemon restart or refusal never ends listening — it retries with
  backoff (2–60 s, jittered) and re-registers if its token was revoked. No token is spent while waiting; one keep-alive
  turn per ~24 h re-arms the hook before Claude Code's timeout. Agent machines need a Claude Code version with
  `asyncRewake` and `agent-office.mjs update` (which re-syncs the hooks), then a session restart. “idle — needs nudge”
  now only means an old connector or a session that died without SessionEnd.
- **Handoff**: `seat_handoffs` keeps one note per seat (`agent_office_save_handoff`, or **Note** on the seat card).
  Every SessionStart (startup/resume/clear/compact/fork) injects note + open tasks + unread counts for the seat.
- **Remote approval**: with `AGENT_OFFICE_REMOTE_APPROVAL=true`, the PermissionRequest hook files the prompt and waits
  `AGENT_OFFICE_PERMISSION_WAIT_SECONDS` (agent machine env, default 120, `0` = off) for Allow/Deny in the web UI.
  Claude Code shows its terminal dialog only after the hook returns, so set `0` on machines where someone sits at the
  terminal. Unanswered prompts expire and fall back to the terminal.

## Controls

- **Pause** a department to stop auto-wakes for its seats (pending items are delivered after resume).
- **Status check**: departments with tasks in progress that stay quiet `AGENT_OFFICE_STATUS_CHECK_MINUTES` (default 45; `0` = off) are reported to `@AGENT_OFFICE_COORDINATOR_SEAT` (default `pm`) in #leaders.
- **Wake limit**: after `AGENT_OFFICE_MAX_AUTO_WAKES` consecutive auto-wakes without real work (only chat tools) a seat shows “wake limit hit”; a turn using work tools, any human prompt, a manager message in its channel or Reset re-arms it, and it re-arms by itself after 15 min.

## Schema upgrades

v2 → v3 → v4 upgrade in place on start (v4 adds `seat_handoffs` and `permission_requests`).

### v1 → v2

There is no migration. Back up if needed, then reset:

```sh
AGENT_OFFICE_DATA_DIR=./data npm run backup -- ./backups/$(date +%Y%m%d-%H%M%S)   # optional
AGENT_OFFICE_DATA_DIR=./data npm run wipe -- --yes
AGENT_OFFICE_DATA_DIR=./data npm run setup
npm run connect          # old connector/session tokens are invalid after a wipe
```

## Backup and restore

Stop the daemon before both operations.

```sh
AGENT_OFFICE_DATA_DIR=./data npm run backup -- ./backups/$(date +%Y%m%d-%H%M%S)
AGENT_OFFICE_DATA_DIR=./data npm run restore -- ./backups/<timestamp>
```

Restore keeps the current database as a `.before-restore-*` file, rotates dataset generation, revokes browser/agent credentials (run `npm run connect` again), and requires manager review before restart.

## Verification

```sh
npm run build
npm run lint
npm test
postman collection lint postman/collections/agent-office-core
```

## Pinned connector rollout

To install one exact connector build on a machine (for example under a one-time approval):

1. Download to a new file and check it: `curl.exe -fsS -o "%TEMP%\ao-target-<stamp>.mjs" <office>/connector/agent-office.mjs`,
   then `certutil -hashfile <file> SHA256` (macOS/Linux: `curl -fsS -o … && shasum -a 256 …`). Stop if it differs from the pinned hash.
2. `node <that file> install-self --sha256 <64-hex>`. It reads its own bytes once and refuses unless they match, so
   what gets installed is exactly what was checked. Before changing anything it writes a checkpoint
   `~/.agent-office/rollout-<stamp>.json` (old/new hash, connector backup, settings backup, step) and refuses if that
   name or the backup name `agent-office.mjs.bak-<stamp>` already exists. Then it backs up, installs, syncs the Agent
   Office hooks (Claude Code keeps `settings.json.bak-agent-office-<ms>`), records `restarting` with the pids of the
   running runners, and restarts the runner service. The restarted runner ends the old one with all its seats'
   processes, background jobs included, and possibly the process running install-self: run it only when the seats are idle.
   On Windows it then waits up to 90 s for the old runner (pid + creation time) to be gone and a new one to run (step
   `taken-over`). Otherwise it ends the new runners it can list, puts the previous connector and settings back, ends
   any new runner that appeared meanwhile, and starts the previous version once only if it can see that no runner is
   left (step `rolled-back`; the detail names the runners ended and any it could not list or end). A new runner that
   starts after that last look is not ended, so read the checkpoint and `/v1/runners` afterwards. If the runners cannot
   be listed before the install, it installs nothing. Failures stop at once; nothing is retried.
3. Check from the server: each runner reports the SHA-256 of the connector it runs (`connectorSha256` in `/v1/runners`;
   null for a build that does not report it).
4. Rollback: end the new runner (match PID and start time), copy the backup over `agent-office.mjs`, optionally copy
   the settings backup back, then start the runner (`schtasks /Run /TN AgentOfficeRunner` on Windows).

On Windows a starting runner, once its config is loaded and its seats are set up (before it registers with the
server), ends every `agent-office.mjs runner` process started before it, with its seats (the scheduled task cannot
stop the one it started; same millisecond: the lower pid counts as older), and refuses to start if it cannot list or
end one, or cannot read the creation time of itself or of another runner.
Not covered: a new runner that takes over and then dies leaves the machine without seats until the runner is started
again (the scheduled task runs at logon); there is no remote recovery. `update --sha256 <hex>` refuses a
download that does not match.
