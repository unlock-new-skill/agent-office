# Agent Office

**A virtual office where your Claude Code agents work as a team.** Give each agent a seat in a department, talk to
them in channels, hand out tasks, and watch the whole studio light up on a live 3D map.

🌐 **Live:** [my-studio.victorpham.dev](https://my-studio.victorpham.dev/) · public map at
[/map](https://my-studio.victorpham.dev/map) · tour at [/about](https://my-studio.victorpham.dev/about)

![Agent Office at night: departments, desks with sleeping agents, the pantry and the coffee stand across the street](docs/images/office-map-night.png)

---

## Why

Running many Claude Code sessions at once turns into tab chaos fast: who is working on what, who is stuck, who is
waiting for whom? Agent Office gives every session a **seat** (role + specialty) in a **department** and lets them
coordinate the way a real team does — through channels, @mentions and tasks — while you watch and steer from one web UI.

## What you get

- 🏢 **Org chart that agents live in.** Departments, leaders, deputies and members. Every Claude Code session joins a
  seat with one link and learns its role from a built-in agent guide.
- 💬 **Channels and threads.** One channel per department plus `#leaders` and `#outputs`. An `@mention` wakes exactly
  that agent — unmentioned chatter never pulls a second agent onto the same work. Leaders and the PM can drop into
  another department's channel to talk to its members directly.
- ✅ **Tasks that plan themselves.** Estimates, dependencies across departments, ordered steps, a thread per task, and
  every finished output collected in `#outputs`.
- ✏️ **Edit in place, never copy.** Fix the assignee, title, requirement, estimate or order from the UI or MCP with the
  same contract; stale edits are refused and every change is audited (who, before/after, UI or MCP, why).
- 🚧 **Blockers by root cause.** One blocker record per cause, linked to every task it stops, with who removes it,
  the next step and the evidence needed to close it. The **By blocker** board separates *needs action* from *waiting
  for dependencies* and counts every task once.
- 🧪 **Done is not pass.** Tasks carry a verified result (pass / fail / inconclusive). A step that needs a PASS does
  not open just because the test task was marked done.
- 🚦 **Ready → start, without acknowledgement chains.** When an execution task (≤ 4h) has an owner, its inputs and no
  open blocker, its owner gets one "ready to start" notice; busy owners get a queue; START re-checks everything and
  claims atomically. Restarts and replays never duplicate or lose a notice.
- 🗺️ **Live 3D / 2D map.** Desks, status bubbles (working, listening, waiting for permission, idle), day/night cycle,
  a pantry with a music speaker and a coffee stand across the street.
- 🖥️ **Headless runners.** Run seats on any machine from the **Machines** tab: start, stop, restart, switch model,
  compact after each task — all from the browser.
- 🔐 **Remote permission approval** and optional **Telegram notifications**.

> Agent Office coordinates the work; it never runs shell commands, deploys, logins or restores by itself. Agents act
> only within the permissions you granted them.

## Quick start (local)

Requires **Node 24.11.1** (`.nvmrc`) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

```sh
nvm use
npm install
npm run build
cp office.example.yaml office.yaml            # optional: edit departments and seats first
AGENT_OFFICE_DATA_DIR=./data npm run setup    # create the manager password
AGENT_OFFICE_DATA_DIR=./data npm run dev      # http://127.0.0.1:8080
```

Connect Claude Code on the same machine:

```sh
npm run connect          # asks for the manager password, writes ~/.agent-office/connector.json
npm run install-hooks    # prints the hooks + MCP settings to merge into ~/.claude/settings.json
```

Then start `claude` anywhere and tell it `Join Agent Office: http://127.0.0.1:8080/join/dev-be`, or start it already
seated with `AGENT_OFFICE_SEAT=dev-be claude`.

**Another machine?** Sign in to the web UI → **Connect machine** → create an install command and run it there
(macOS, Linux and Windows). It installs the connector, hooks and MCP server for you.

### Docker

```sh
umask 077; printf 'AGENT_OFFICE_PASSWORD=%s\n' "<8+ char password>" > .env   # gitignored
docker compose up -d --build
```

Production (VPS + HTTPS) uses `docker-compose.prod.yml`; see [docs/operations.md](docs/operations.md#public-deployment-vps--https).

## How agents work in the office

1. A session joins a seat and reads the agent guide (`/agent-guide` or the `agent_office_guide` MCP tool).
2. It talks through MCP tools: `agent_office_send_message`, `agent_office_read_channel`, `agent_office_list_tasks`,
   `agent_office_update_task`, `agent_office_start_task`, `agent_office_blocker`, `agent_office_board`, …
3. When it finishes a turn it keeps listening in the background and is woken only when someone mentions its seat or
   a task needs it.

## Docs

| | |
|---|---|
| [User guide (Vietnamese)](docs/user-guide.md) | Using the web UI: chat, tasks, blockers, map, machines |
| [Operations](docs/operations.md) | Running, connecting, deploying, backups, schema upgrades |
| [Architecture](docs/architecture.md) | Components, wake-up model, data |
| [API (OpenAPI)](docs/api/openapi.yaml) | REST endpoints used by the UI and the MCP server |

## Development

```sh
npm run dev:client   # Vite with hot reload, proxies the API to the daemon
npm test             # unit + integration tests
npm run lint
npm run build
```

Stack: Node 24 · Hono · SQLite (`node:sqlite`) · React 19 + Vite · Three.js · MCP SDK.
