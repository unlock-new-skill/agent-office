import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const assertPrivate = (filename: string, directory: boolean): void => {
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('unsafe_data_path');
  }
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('data_permissions_must_be_private');
  }
};

export const SCHEMA_VERSION = 26;

/** v8: the summary Claude Code produced at a seat's latest context compaction (auto handoff for the next session). */
const V8_TABLES = `CREATE TABLE seat_compactions(
  seat_id TEXT PRIMARY KEY REFERENCES seats(id) ON DELETE CASCADE, summary TEXT NOT NULL CHECK(length(summary) <= 6000),
  agent_id TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;`;
/** v9: per-machine runners with an audited command queue, and small app settings (e.g. the paired Telegram chat). */
const V9_TABLES = `CREATE TABLE runners(
  id TEXT PRIMARY KEY, machine TEXT NOT NULL, seats_json TEXT NOT NULL, last_seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE runner_commands(
  id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('start','stop','restart','interrupt','prompt')), text TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','sent','done','failed','expired')), result TEXT,
  requested_by TEXT NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER
) STRICT;
CREATE INDEX runner_commands_runner ON runner_commands(runner_id, status);
CREATE INDEX runner_commands_seat ON runner_commands(seat_id, created_at);
CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;
/** v10: machines managed from the web — install codes bound to a machine, its seat config, and which machine a session runs on. */
const V10_COLUMNS = `ALTER TABLE install_codes ADD COLUMN machine_id TEXT;
ALTER TABLE runners ADD COLUMN label TEXT;
ALTER TABLE runners ADD COLUMN config_json TEXT NOT NULL DEFAULT '{"seats":[]}';
ALTER TABLE runners ADD COLUMN config_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN machine_id TEXT;`;
/** v11: sessions the manager dismissed from the lobby (shown again when the session starts anew). */
const V11_COLUMNS = 'ALTER TABLE agents ADD COLUMN dismissed_at INTEGER;';
/** v12: total time each seat spent working (summed over its sessions' turns) and the model a session last answered with. */
const V12_COLUMNS = 'ALTER TABLE seats ADD COLUMN work_ms INTEGER NOT NULL DEFAULT 0; ALTER TABLE agents ADD COLUMN model TEXT;';
const V13_COLUMNS = 'ALTER TABLE seats ADD COLUMN last_wake_at INTEGER;';
const V14_COLUMNS = 'ALTER TABLE agents ADD COLUMN work_mark INTEGER;';
/** v16: runner command 'fresh' (restart a seat in a new session); SQLite needs the table rebuilt to widen the CHECK. */
const V16_TABLES = `CREATE TABLE runner_commands_v16(
  id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('start','stop','restart','fresh','interrupt','prompt')), text TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','sent','done','failed','expired')), result TEXT,
  requested_by TEXT NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER
) STRICT;
INSERT INTO runner_commands_v16 SELECT id,runner_id,seat_id,kind,text,status,result,requested_by,created_at,done_at FROM runner_commands;
DROP TABLE runner_commands;
ALTER TABLE runner_commands_v16 RENAME TO runner_commands;
CREATE INDEX runner_commands_runner ON runner_commands(runner_id, status);
CREATE INDEX runner_commands_seat ON runner_commands(seat_id, created_at);`;
/** v17: per-seat choice of what happens to a member's context after it finishes a task (null = office default). */
const V17_COLUMNS = "ALTER TABLE seats ADD COLUMN after_task TEXT CHECK(after_task IN ('compact','clear','off'));";
/** v18: saved YouTube tracks for the pantry speaker, starting with the office's first song. */
const V18_TABLES = `CREATE TABLE music_tracks(
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL UNIQUE, start_seconds INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL CHECK(length(title) <= 200), added_at INTEGER NOT NULL
) STRICT;
INSERT INTO music_tracks(id,video_id,start_seconds,title,added_at) VALUES ('CXJJDxg7Mos','CXJJDxg7Mos',0,'OIIA OIIA CAT 10 HOURS',0);`;
/**
 * v19: channel kind 'outputs' (the read-only feed of finished task outputs). SQLite needs the table rebuilt to widen the
 * CHECK; it runs with foreign keys off so dropping the old table does not cascade into messages and memberships.
 */
const V19_CHANNELS = `CREATE TABLE channels_v19(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('department','leaders','outputs')),
  department_id TEXT UNIQUE REFERENCES departments(id) ON DELETE CASCADE
) STRICT;
INSERT INTO channels_v19 SELECT id,name,kind,department_id FROM channels;
DROP TABLE channels;
ALTER TABLE channels_v19 RENAME TO channels;`;
/** v20: the thread each task's system lines go to (department channel, and #leaders for cross-department requests). */
const V20_COLUMNS = 'ALTER TABLE tasks ADD COLUMN thread_seq INTEGER; ALTER TABLE tasks ADD COLUMN request_thread_seq INTEGER;';
/**
 * v21: seats from outside a channel invited into one thread by a mention (with their own read cursor), and steps:
 * a task split into ordered sub-tasks (parent_id + step), each assignable in any department.
 */
const V21_TABLES = `CREATE TABLE thread_guests(
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, thread_seq INTEGER NOT NULL,
  seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE, last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, thread_seq, seat_id)
) STRICT;
CREATE INDEX thread_guests_seat ON thread_guests(seat_id);
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN step INTEGER;`;
/**
 * v22: coordinator flag on seats (PM rights over every department), task revision (stale updates conflict) and kind
 * (execution | tracking, NULL = not classified yet), field-level task audit, department channels a leader joined,
 * task result + dependencies that need a PASS, structured blockers linked to tasks, the persisted readiness of each
 * task (generation bumps on every real not-ready → ready) and the ledger of readiness notifications (one per key).
 */
const V22_TABLES = `ALTER TABLE seats ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0 CHECK(coordinator IN (0,1));
ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN kind TEXT CHECK(kind IN ('execution','tracking'));
CREATE TABLE task_changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('ui','mcp','api')), field TEXT NOT NULL,
  before_json TEXT, after_json TEXT, reason TEXT NOT NULL DEFAULT '' CHECK(length(reason) <= 2000), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_changes_task ON task_changes(task_id, id);
ALTER TABLE tasks ADD COLUMN pass_required TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN result TEXT NOT NULL DEFAULT 'unknown' CHECK(result IN ('not-applicable','pass','fail','inconclusive','unknown'));
ALTER TABLE tasks ADD COLUMN result_by TEXT;
ALTER TABLE tasks ADD COLUMN result_at INTEGER;
ALTER TABLE tasks ADD COLUMN actual_start INTEGER;
CREATE TABLE blockers(
  id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('dependency','missing-input','permission','environment','defect','owner-missing','decision')),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 500), resolver_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL,
  resolver_role TEXT CHECK(length(resolver_role) <= 80), next_step TEXT NOT NULL DEFAULT '' CHECK(length(next_step) <= 1000), due_at INTEGER,
  origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, refs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  opened_by TEXT NOT NULL, opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_by TEXT, resolved_at INTEGER,
  resolution TEXT NOT NULL DEFAULT '' CHECK(length(resolution) <= 1000)
) STRICT;
CREATE TABLE task_blockers(
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, blocker_id TEXT NOT NULL REFERENCES blockers(id) ON DELETE CASCADE, PRIMARY KEY(task_id, blocker_id)
) STRICT;
CREATE INDEX task_blockers_blocker ON task_blockers(blocker_id);
CREATE TABLE task_readiness(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, ready INTEGER NOT NULL, generation INTEGER NOT NULL, gate_ok INTEGER NOT NULL,
  ready_since INTEGER, reasons TEXT NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE task_notifications(
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, generation INTEGER NOT NULL, recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(task_id, kind, generation, recipient)
) STRICT;
CREATE TABLE channel_visitors(
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL, PRIMARY KEY(channel_id, seat_id)
) STRICT;`;
/**
 * v23: a resolved blocker may be valid only until a time (a granted window, a temporary permission): past it the blocker
 * opens again. alert_state remembers which exception alerts were already reported so the digest lists only new ones.
 */
const V23_TABLES = `ALTER TABLE blockers ADD COLUMN valid_until INTEGER;
CREATE TABLE alert_state(key TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, notified_at INTEGER, active INTEGER NOT NULL) STRICT;`;
/** v24: read-only service tokens for server integrations (hash only, optional department scope, expiry, revocation). */
const V24_TABLES = `CREATE TABLE service_tokens(
  id TEXT PRIMARY KEY, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80), token_hash TEXT NOT NULL UNIQUE, departments TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER
) STRICT;`;
/**
 * Manager approval requests: a seat asks the manager for one specific decision tied to a task or a thread. The decision
 * (status) and the Telegram delivery are kept apart; `nonce` is the opaque, per-revision token the Telegram buttons carry.
 */
const V26_TABLES = `CREATE TABLE approval_requests(
  id TEXT PRIMARY KEY, requester_seat_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  channel_id TEXT NOT NULL, thread_seq INTEGER, action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 200),
  scope TEXT NOT NULL CHECK(length(scope) BETWEEN 1 AND 500), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  consequences TEXT NOT NULL DEFAULT '' CHECK(length(consequences) <= 500), target TEXT NOT NULL DEFAULT '' CHECK(length(target) <= 200),
  dedupe_key TEXT NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled')), revision INTEGER NOT NULL DEFAULT 1,
  nonce TEXT NOT NULL UNIQUE, decided_by TEXT, decided_via TEXT, decided_at INTEGER, decision_note TEXT NOT NULL DEFAULT '',
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('queued','sent','retry','uncertain','failed','disabled','not_paired')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0, delivery_error TEXT NOT NULL DEFAULT '', next_attempt_at INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER, sent_at INTEGER, stale_message_id INTEGER, final_edited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX approval_requests_status ON approval_requests(status, expires_at);
CREATE INDEX approval_requests_dedupe ON approval_requests(requester_seat_id, dedupe_key, status);
CREATE TABLE approval_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL, revision INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '' CHECK(length(detail) <= 1000),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX approval_events_approval ON approval_events(approval_id, id);`;
/**
 * v25: who actually works on a task besides its owner (executor / reviewer / intake, with their phase and state) and
 * the partial outputs a task produced (received with evidence, accepted separately, remaining acceptance spelled out).
 */
const V25_TABLES = `CREATE TABLE task_participants(
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('executor','reviewer','intake')), state TEXT NOT NULL CHECK(state IN ('active','waiting','done','stopped')),
  phase TEXT NOT NULL DEFAULT '' CHECK(length(phase) <= 200), note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 500),
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('ui','mcp','api')),
  PRIMARY KEY(task_id, seat_id, role)
) STRICT;
CREATE INDEX task_participants_seat ON task_participants(seat_id);
CREATE TABLE task_outputs(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  scope TEXT NOT NULL DEFAULT '' CHECK(length(scope) <= 80), evidence TEXT NOT NULL DEFAULT '' CHECK(length(evidence) <= 1000),
  result TEXT NOT NULL DEFAULT 'unknown' CHECK(result IN ('not-applicable','pass','fail','inconclusive','unknown')),
  missing TEXT NOT NULL DEFAULT '' CHECK(length(missing) <= 1000), recorded_by TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ui','mcp','api')), accepted_by TEXT, accepted_at INTEGER, acceptance_note TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX task_outputs_task ON task_outputs(task_id);`;
const V15_COLUMNS = "ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER; ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';";
const THREAD_INDEX = 'CREATE INDEX messages_thread ON messages(channel_id, thread_seq);';

/** v4 additions: seat handoff notes and remotely answerable permission prompts. */
const V4_TABLES = `CREATE TABLE seat_handoffs(
  seat_id TEXT PRIMARY KEY REFERENCES seats(id) ON DELETE CASCADE, body TEXT NOT NULL CHECK(length(body) <= 8000),
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
) STRICT;
CREATE TABLE permission_requests(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, seat_id TEXT,
  tool TEXT NOT NULL, summary TEXT NOT NULL CHECK(length(summary) <= 2000),
  status TEXT NOT NULL CHECK(status IN ('pending','allowed','denied','expired')), message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT
) STRICT;
CREATE INDEX permission_requests_pending ON permission_requests(status, agent_id);`;
/** v5: one-time-ish codes a new machine trades for a connector credential (install script), stored hashed. */
const V5_TABLES = `CREATE TABLE install_codes(
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, uses_left INTEGER NOT NULL CHECK(uses_left >= 0),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;`;

export class Database {
  readonly raw: DatabaseSync;

  constructor(options: { filename: string }) {
    if (options.filename !== ':memory:') {
      const directory = path.dirname(options.filename);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      assertPrivate(directory, true);
      try { assertPrivate(options.filename, false); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        closeSync(openSync(options.filename, 'wx', 0o600));
      }
      for (const suffix of ['-wal', '-shm']) {
        try { assertPrivate(options.filename + suffix, false); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
    }
    this.raw = new DatabaseSync(options.filename);
    try {
      this.raw.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.migrate();
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  private depth = 0;

  /** Runs `operation` atomically. A nested call becomes a savepoint, so a step and the lines it posts commit together. */
  transaction<T>(operation: () => T): T {
    const savepoint = this.depth > 0 ? `sp_${this.depth}` : null;
    this.raw.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = operation();
      this.raw.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      // A failed COMMIT/RELEASE leaves the transaction open: roll it back too (ignore "no transaction" if it already ended).
      try { this.raw.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); } catch { /* already closed */ }
      throw error;
    } finally { this.depth--; }
  }

  close(): void { this.raw.close(); }

  private migrate(): void {
    const version = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version === SCHEMA_VERSION) return;
    // Additive upgrades run in place: v3 message edit/delete markers, v4 handoff notes + permission requests, v5 install codes, v6 deputies + task requesters, v7 message threads, v8 compaction summaries, v9 runners + app settings, v10 web-managed machines, v11 dismissed sessions, v12 seat work time + session model.
    const from = version.user_version;
    if (from >= 2 && from < SCHEMA_VERSION) {
      // Table rebuilds (v19) must not cascade: foreign keys are off for the upgrade and checked afterwards.
      this.raw.exec('PRAGMA foreign_keys=OFF');
      try {
      this.transaction(() => {
        if (from < 3) this.raw.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER; ALTER TABLE messages ADD COLUMN deleted_at INTEGER;');
        if (from < 4) this.raw.exec(V4_TABLES);
        if (from < 5) this.raw.exec(V5_TABLES);
        // v6: department deputy (backup for the leader) and the leader a cross-department task was requested by.
        if (from < 6) this.raw.exec('ALTER TABLE departments ADD COLUMN deputy_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL; ALTER TABLE tasks ADD COLUMN requester_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL;');
        // v7: thread replies point at the seq of their root message in the same channel.
        if (from < 7) this.raw.exec(`ALTER TABLE messages ADD COLUMN thread_seq INTEGER; ${THREAD_INDEX}`);
        if (from < 8) this.raw.exec(V8_TABLES);
        if (from < 9) this.raw.exec(V9_TABLES);
        if (from < 10) this.raw.exec(V10_COLUMNS);
        if (from < 11) this.raw.exec(V11_COLUMNS);
        if (from < 12) this.raw.exec(V12_COLUMNS);
        if (from < 13) this.raw.exec(V13_COLUMNS);
        if (from < 14) this.raw.exec(V14_COLUMNS);
        if (from < 15) this.raw.exec(V15_COLUMNS);
        if (from < 16) this.raw.exec(V16_TABLES);
        if (from < 17) this.raw.exec(V17_COLUMNS);
        if (from < 18) this.raw.exec(V18_TABLES);
        if (from < 19) this.raw.exec(V19_CHANNELS);
        if (from < 20) this.raw.exec(V20_COLUMNS);
        if (from < 21) this.raw.exec(V21_TABLES);
        if (from < 22) this.raw.exec(V22_TABLES);
        if (from < 23) this.raw.exec(V23_TABLES);
        if (from < 24) this.raw.exec(V24_TABLES);
        if (from < 25) this.raw.exec(V25_TABLES);
        if (from < 26) this.raw.exec(V26_TABLES);
        if ((this.raw.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > 0) throw new Error('migration_foreign_key_violation');
        this.raw.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
      });
      } finally { this.raw.exec('PRAGMA foreign_keys=ON'); }
      return;
    }
    if (version.user_version !== 0) throw new Error('schema_reset_required: run npm run wipe -- --yes && npm run setup');
    const oldSchema = this.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (oldSchema) throw new Error('unversioned_database_requires_manual_migration');
    this.transaction(() => this.raw.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta VALUES ('dataset_generation', lower(hex(randomblob(16))));
      INSERT INTO meta VALUES ('event_seq', '0');
      CREATE TABLE users(
        id TEXT PRIMARY KEY CHECK(id='manager'), password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE auth_sessions(
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER
      ) STRICT;
      CREATE TABLE credentials(
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('enrollment','agent','connector')), binding_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER
      ) STRICT;
      CREATE TABLE agents(
        id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'claude', project TEXT NOT NULL, session_id TEXT NOT NULL,
        incarnation TEXT NOT NULL, ended_at TEXT, last_event_at TEXT, last_contact_at INTEGER,
        active_turn TEXT, turn_started_at TEXT, activity TEXT NOT NULL DEFAULT 'online',
        UNIQUE(session_id, incarnation)
      ) STRICT;
      CREATE TABLE turns(
        agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(agent_id, turn_id)
      ) STRICT;
      CREATE TABLE invocations(
        agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL, tool TEXT, state TEXT NOT NULL,
        PRIMARY KEY(agent_id, invocation_id)
      ) STRICT;
      CREATE INDEX invocation_turn ON invocations(agent_id,turn_id,state);
      CREATE TABLE permission_waits(
        agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT NOT NULL,
        invocation_key TEXT NOT NULL, PRIMARY KEY(agent_id,turn_id,invocation_key)
      ) STRICT;
      CREATE TABLE departments(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), deputy_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL
      ) STRICT;
      CREATE TABLE seats(
        id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
        role TEXT NOT NULL CHECK(role IN ('leader','member')), sort INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT UNIQUE REFERENCES agents(id) ON DELETE SET NULL, consecutive_wakes INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE UNIQUE INDEX one_leader_per_department ON seats(department_id) WHERE role='leader';
      CREATE TABLE channels(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('department','leaders','outputs')),
        department_id TEXT UNIQUE REFERENCES departments(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE channel_members(
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
        PRIMARY KEY(channel_id, seat_id)
      ) STRICT;
      CREATE TABLE messages(
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
        sender_kind TEXT NOT NULL CHECK(sender_kind IN ('seat','manager','system')), sender_id TEXT NOT NULL,
        body TEXT NOT NULL CHECK(length(body) <= 16384), mentions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
        edited_at INTEGER, deleted_at INTEGER, thread_seq INTEGER,
        UNIQUE(channel_id, seq)
      ) STRICT;
      ${THREAD_INDEX}
      CREATE TABLE seat_reads(
        seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        last_read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(seat_id, channel_id)
      ) STRICT;
      CREATE TABLE tasks(
        id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE, number INTEGER NOT NULL,
        assignee_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL, requester_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL,
        created_by_kind TEXT NOT NULL, created_by_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 8000),
        status TEXT NOT NULL CHECK(status IN ('todo','doing','blocked','done')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(department_id, number)
      ) STRICT;
      ${V4_TABLES}
      ${V5_TABLES}
      ${V8_TABLES}
      ${V9_TABLES}
      ${V10_COLUMNS}
      ${V11_COLUMNS}
      ${V12_COLUMNS}
      ${V13_COLUMNS}
      ${V14_COLUMNS}
      ${V15_COLUMNS}
      ${V16_TABLES}
      ${V17_COLUMNS}
      ${V18_TABLES}
      ${V20_COLUMNS}
      ${V21_TABLES}
      ${V22_TABLES}
      ${V23_TABLES}
      ${V24_TABLES}
      ${V25_TABLES}
      ${V26_TABLES}
      CREATE TABLE task_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000), created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, generation TEXT NOT NULL,
        producer_id TEXT NOT NULL, producer_incarnation TEXT NOT NULL, event_id TEXT NOT NULL,
        session_id TEXT NOT NULL, turn_id TEXT, invocation_id TEXT,
        payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(producer_id,producer_incarnation,event_id)
      ) STRICT;
      CREATE INDEX events_session_time ON events(session_id,created_at,seq);
      CREATE INDEX events_turn_invocation ON events(session_id,turn_id,invocation_id,seq);
      CREATE TABLE purge_suppressions(session_id TEXT PRIMARY KEY, purged_at INTEGER NOT NULL, generation TEXT NOT NULL) STRICT;
      PRAGMA user_version=${SCHEMA_VERSION};
    `));
  }
}
