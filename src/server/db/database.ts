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

export const SCHEMA_VERSION = 7;

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

  transaction<T>(operation: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.raw.close(); }

  private migrate(): void {
    const version = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version === SCHEMA_VERSION) return;
    // Additive upgrades run in place: v3 message edit/delete markers, v4 handoff notes + permission requests, v5 install codes, v6 deputies + task requesters, v7 message threads.
    const from = version.user_version;
    if (from >= 2 && from < SCHEMA_VERSION) {
      this.transaction(() => {
        if (from < 3) this.raw.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER; ALTER TABLE messages ADD COLUMN deleted_at INTEGER;');
        if (from < 4) this.raw.exec(V4_TABLES);
        if (from < 5) this.raw.exec(V5_TABLES);
        // v6: department deputy (backup for the leader) and the leader a cross-department task was requested by.
        if (from < 6) this.raw.exec('ALTER TABLE departments ADD COLUMN deputy_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL; ALTER TABLE tasks ADD COLUMN requester_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL;');
        // v7: thread replies point at the seq of their root message in the same channel.
        if (from < 7) this.raw.exec(`ALTER TABLE messages ADD COLUMN thread_seq INTEGER; ${THREAD_INDEX}`);
        this.raw.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
      });
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
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('department','leaders')),
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
