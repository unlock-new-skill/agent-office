import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ConnectorRecord = { daemonUrl: string; token: string };
export type SessionRecord = { daemonUrl: string; token: string; agentId: string };
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const defaultAgentOfficeHome = (): string => process.env.AGENT_OFFICE_HOME ?? path.join(homedir(), '.agent-office');

/** Per-user credential files shared by the hook and the MCP server (0700 dirs, 0600 files). */
export class SessionStore {
  constructor(readonly home: string = defaultAgentOfficeHome()) {}

  connector(): ConnectorRecord | null { return this.read<ConnectorRecord>(path.join(this.home, 'connector.json')); }
  saveConnector(record: ConnectorRecord): void { this.write(path.join(this.home, 'connector.json'), record); }
  session(sessionId: string): SessionRecord | null { return this.read<SessionRecord>(this.sessionFile(sessionId)); }
  saveSession(sessionId: string, record: SessionRecord): void { this.write(this.sessionFile(sessionId), record); }
  /** Marks a new Stop-hook listener as the session's only one; earlier listeners see the change and exit. */
  claimListener(sessionId: string): string { const id = randomUUID(); this.write(this.listenerFile(sessionId), { id }); return id; }
  listener(sessionId: string): string | null { return this.read<{ id: string }>(this.listenerFile(sessionId))?.id ?? null; }
  /** Small JSON files kept next to the credentials (runner config/state), same 0600 permissions. */
  readJson<T>(name: string): T | null { return this.read<T>(path.join(this.home, name)); }
  saveJson(name: string, value: unknown): void { this.write(path.join(this.home, name), value); }
  spoolDir(sessionId: string): string { this.assertSessionId(sessionId); return path.join(this.home, 'spool', sessionId); }

  private listenerFile(sessionId: string): string { this.assertSessionId(sessionId); return path.join(this.home, 'listeners', `${sessionId}.json`); }
  private sessionFile(sessionId: string): string { this.assertSessionId(sessionId); return path.join(this.home, 'sessions', `${sessionId}.json`); }
  private assertSessionId(sessionId: string): void { if (!SESSION_ID.test(sessionId)) throw new Error('invalid_session_id'); }

  private read<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); chmodSync(path.dirname(file), 0o700);
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file);
  }
}
