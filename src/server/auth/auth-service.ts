import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';

const COOKIE_NAME = 'agent_office_session';
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
type Session = { id: string; expiresAt: number; csrfToken: string };
export type Credential = { id: string; agentId: string; sessionId: string; incarnation: string; project: string; scopes: string[] };
const now = (): number => Date.now();
/** Floor for a loopback-only UI; public deployments raise it with AGENT_OFFICE_MIN_PASSWORD_LENGTH. */
export const MIN_PASSWORD_LENGTH = 8;
const CONNECTOR_TTL_MS = 365 * 24 * 3600 * 1000;
const SESSION_CREDENTIAL_TTL_MS = 30 * 24 * 3600 * 1000;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const hashPassword = (password: string, salt: Buffer): Buffer => scryptSync(password, salt, 64, SCRYPT_OPTIONS);
const parseCookie = (header: string | null, name: string): string | null => {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); } catch { return null; }
    }
  }
  return null;
};
export const sessionCookie = (token: string, maxAge: number, secure = false): string => `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
export const clearedSessionCookie = (secure = false): string => `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

export class AuthService {
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly db: Database, private readonly sessionTtlSeconds: number, private readonly minPasswordLength = MIN_PASSWORD_LENGTH) {}

  isSetupComplete(): boolean { return Boolean(this.db.raw.prepare("SELECT 1 FROM users WHERE id='manager'").get()); }

  setupPassword(password: string): void {
    if (password.length < this.minPasswordLength || password.length > 256) throw new Error('weak_password');
    if (this.isSetupComplete()) throw new Error('already_setup');
    const salt = randomBytes(16);
    const passwordHash = hashPassword(password, salt);
    this.db.transaction(() => {
      if (this.isSetupComplete()) throw new Error('already_setup');
      this.db.raw.prepare('INSERT INTO users(id,password_salt,password_hash,created_at) VALUES (?,?,?,?)').run('manager', salt.toString('base64'), passwordHash.toString('base64'), now());
    });
  }

  resetPassword(currentPassword: string, nextPassword: string): void {
    if (nextPassword.length < this.minPasswordLength || nextPassword.length > 256) throw new Error('weak_password');
    const user = this.db.raw.prepare("SELECT password_salt,password_hash FROM users WHERE id='manager'").get() as { password_salt: string; password_hash: string } | undefined;
    if (!user) throw new Error('setup_required');
    const actual = hashPassword(currentPassword, Buffer.from(user.password_salt, 'base64')); const expected = Buffer.from(user.password_hash, 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid_credentials');
    const salt = randomBytes(16); const passwordHash = hashPassword(nextPassword, salt);
    this.db.transaction(() => {
      this.db.raw.prepare("UPDATE users SET password_salt=?,password_hash=? WHERE id='manager'").run(salt.toString('base64'), passwordHash.toString('base64'));
      this.db.raw.exec('DELETE FROM auth_sessions; DELETE FROM credentials;');
    });
  }

  login(password: string, key = 'local'): { token: string; csrfToken: string; expiresAt: number } {
    const timestamp = now();
    const attempt = this.loginAttempts.get(key); const globalAttempt = this.loginAttempts.get('global');
    if ((attempt && attempt.resetAt > timestamp && attempt.count >= 5) || (globalAttempt && globalAttempt.resetAt > timestamp && globalAttempt.count >= 20)) throw new Error('rate_limited');
    const user = this.db.raw.prepare("SELECT password_salt,password_hash FROM users WHERE id='manager'").get() as { password_salt: string; password_hash: string } | undefined;
    if (!user) throw new Error('setup_required');
    const actual = hashPassword(password, Buffer.from(user.password_salt, 'base64'));
    const expected = Buffer.from(user.password_hash, 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      const current = attempt && attempt.resetAt > timestamp ? attempt : { count: 0, resetAt: timestamp + 60_000 };
      this.loginAttempts.set(key, { count: current.count + 1, resetAt: current.resetAt });
      const globalAttempt = this.loginAttempts.get('global');
      this.loginAttempts.set('global', { count: (globalAttempt?.resetAt ?? 0) > timestamp ? (globalAttempt?.count ?? 0) + 1 : 1, resetAt: (globalAttempt?.resetAt ?? 0) > timestamp ? globalAttempt!.resetAt : timestamp + 60_000 });
      if (this.loginAttempts.size > 10_000) for (const [entryKey, entry] of this.loginAttempts) if (entry.resetAt <= timestamp) this.loginAttempts.delete(entryKey);
      throw new Error('invalid_credentials');
    }
    this.loginAttempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = timestamp + this.sessionTtlSeconds * 1000;
    this.db.raw.prepare('INSERT INTO auth_sessions(id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)').run(randomBytes(16).toString('hex'), hashToken(token), csrfToken, expiresAt);
    return { token, csrfToken, expiresAt };
  }

  authenticateRequest(request: Request): Session | null {
    const token = parseCookie(request.headers.get('cookie'), COOKIE_NAME);
    if (!token) return null;
    const row = this.db.raw.prepare('SELECT id,expires_at,csrf_token,revoked_at FROM auth_sessions WHERE token_hash=?').get(hashToken(token)) as { id: string; expires_at: number; csrf_token: string; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at || row.expires_at <= now()) return null;
    return { id: row.id, expiresAt: row.expires_at, csrfToken: row.csrf_token };
  }

  isSessionActive(sessionId: string): boolean {
    const row = this.db.raw.prepare('SELECT 1 FROM auth_sessions WHERE id=? AND revoked_at IS NULL AND expires_at>?').get(sessionId, now());
    return Boolean(row);
  }

  requireCsrf(request: Request, session: Session): boolean { return request.method === 'GET' || request.headers.get('x-csrf-token') === session.csrfToken; }
  revokeRequest(request: Request): void { const token = parseCookie(request.headers.get('cookie'), COOKIE_NAME); if (token) this.db.raw.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?').run(now(), hashToken(token)); }

  createEnrollmentCredential(input: { agentId: string; project: string; sessionId: string; incarnation: string }): { token: string; id: string; nonce: string } {
    const token = randomBytes(32).toString('base64url'); const id = randomBytes(16).toString('hex'); const nonce = randomBytes(16).toString('hex');
    this.db.raw.prepare('INSERT INTO credentials(id,token_hash,kind,binding_json,expires_at) VALUES (?,?,?,?,?)').run(id, hashToken(token), 'enrollment', JSON.stringify({ ...input, nonce }), now() + 300_000);
    return { token, id, nonce };
  }

  authenticateEnrollment(request: Request): ({ id: string; project: string; nonce: string; agentId: string; sessionId: string; incarnation: string }) | null {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    const row = this.db.raw.prepare("SELECT id,binding_json,expires_at,revoked_at FROM credentials WHERE token_hash=? AND kind='enrollment'").get(hashToken(header.slice(7))) as { id: string; binding_json: string; expires_at: number; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at || row.expires_at <= now()) return null;
    return { id: row.id, ...(JSON.parse(row.binding_json) as { agentId: string; project: string; nonce: string; sessionId: string; incarnation: string }) };
  }

  registerAgent(enrollmentId: string, nonce: string): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url'); const id = randomBytes(16).toString('hex');
    this.db.transaction(() => {
      const row = this.db.raw.prepare("SELECT binding_json,expires_at,revoked_at FROM credentials WHERE id=? AND kind='enrollment'").get(enrollmentId) as { binding_json: string; expires_at: number; revoked_at: number | null } | undefined;
      if (!row || row.revoked_at || row.expires_at <= now()) throw new Error('invalid_enrollment');
      const binding = JSON.parse(row.binding_json) as { agentId: string; project: string; nonce: string; sessionId: string; incarnation: string };
      if (binding.nonce !== nonce) throw new Error('invalid_enrollment_nonce');
      this.db.raw.prepare('INSERT INTO credentials(id,token_hash,kind,binding_json,expires_at) VALUES (?,?,?,?,?)').run(id, hashToken(token), 'agent', JSON.stringify(binding), now() + this.sessionTtlSeconds * 1000);
      this.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(now(), enrollmentId);
    });
    return { token, id };
  }

  createScopedCredential(input: { agentId: string; project: string; sessionId: string; incarnation: string }): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url'); const id = randomBytes(16).toString('hex');
    this.db.raw.prepare('INSERT INTO credentials(id,token_hash,kind,binding_json,expires_at) VALUES (?,?,?,?,?)').run(id, hashToken(token), 'agent', JSON.stringify(input), now() + this.sessionTtlSeconds * 1000);
    return { token, id };
  }

  authenticateBearer(request: Request): Credential | null {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    const row = this.db.raw.prepare("SELECT id,binding_json,expires_at,revoked_at FROM credentials WHERE token_hash=? AND kind='agent'").get(hashToken(header.slice(7))) as { id: string; binding_json: string; expires_at: number; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at || row.expires_at <= now()) return null;
    return { id: row.id, ...(JSON.parse(row.binding_json) as { agentId: string; project: string; sessionId: string; incarnation: string }), scopes: ['agent:ingest'] };
  }

  /** Long-lived machine credential used only by the hook connector to self-register Claude Code sessions. */
  /** Code for the install script: valid for `uses` machines until it expires. Only its hash is stored. */
  createInstallCode(uses: number, ttlMs: number, machineId: string | null = null): { code: string; expiresAt: number; uses: number } {
    const code = randomBytes(18).toString('base64url'); const expiresAt = now() + ttlMs;
    this.db.raw.prepare('INSERT INTO install_codes(id,code_hash,uses_left,created_at,expires_at,machine_id) VALUES (?,?,?,?,?,?)').run(randomBytes(12).toString('hex'), hashToken(code), uses, now(), expiresAt, machineId);
    return { code, expiresAt, uses };
  }

  /** Spends one use of an install code and mints a connector credential for that machine; null if invalid/expired/used up. */
  redeemInstallCode(request: Request): { token: string; id: string; machineId: string | null } | null {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return this.db.transaction(() => {
      const row = this.db.raw.prepare('UPDATE install_codes SET uses_left=uses_left-1 WHERE code_hash=? AND uses_left>0 AND expires_at>? RETURNING machine_id AS machineId').get(hashToken(header.slice(7)), now()) as { machineId: string | null } | undefined;
      return row ? { ...this.createConnectorCredential(row.machineId), machineId: row.machineId } : null;
    });
  }

  /** A connector minted from a machine's install code carries that machine id: its runner and sessions belong to it. */
  createConnectorCredential(machineId: string | null = null): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url'); const id = randomBytes(16).toString('hex');
    this.db.raw.prepare('INSERT INTO credentials(id,token_hash,kind,binding_json,expires_at) VALUES (?,?,?,?,?)').run(id, hashToken(token), 'connector', JSON.stringify(machineId ? { machineId } : {}), now() + CONNECTOR_TTL_MS);
    return { token, id };
  }

  /** `machine` is the machine this connector speaks for: its bound machine id, or the credential id for older installs. */
  authenticateConnector(request: Request): { id: string; machine: string } | null {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    const row = this.db.raw.prepare("SELECT id,binding_json,expires_at,revoked_at FROM credentials WHERE token_hash=? AND kind='connector'").get(hashToken(header.slice(7))) as { id: string; binding_json: string; expires_at: number; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at || row.expires_at <= now()) return null;
    const machineId = (JSON.parse(row.binding_json) as { machineId?: string }).machineId;
    return { id: row.id, machine: machineId ?? row.id };
  }

  /** Revokes every connector bound to a machine (the machine was deleted on the web). */
  revokeMachine(machineId: string): void {
    this.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE kind='connector' AND revoked_at IS NULL AND json_extract(binding_json,'$.machineId')=?").run(now(), machineId);
  }

  /**
   * Registers (or re-registers on resume) a Claude Code session. The agent id is derived from the session id so a
   * resumed session keeps its seat; any older token for the same agent is revoked.
   */
  registerSession(input: { sessionId: string; project: string }, machine: string | null = null): { agentId: string; token: string; credentialId: string } {
    const agentId = `cc-${createHash('sha256').update(input.sessionId).digest('hex').slice(0, 12)}`;
    const token = randomBytes(32).toString('base64url'); const credentialId = randomBytes(16).toString('hex'); const timestamp = now();
    const binding = { agentId, project: input.project, sessionId: input.sessionId, incarnation: input.sessionId };
    this.db.transaction(() => {
      const existing = this.db.raw.prepare('SELECT 1 FROM agents WHERE id=?').get(agentId);
      if (existing) this.db.raw.prepare("UPDATE agents SET project=?,ended_at=NULL,activity='online',last_contact_at=?,machine_id=COALESCE(?,machine_id) WHERE id=?").run(input.project, timestamp, machine, agentId);
      else this.db.raw.prepare("INSERT INTO agents(id,source,project,session_id,incarnation,last_contact_at,activity,machine_id) VALUES (?,'claude',?,?,?,?,'online',?)").run(agentId, input.project, input.sessionId, input.sessionId, timestamp, machine);
      this.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE kind='agent' AND revoked_at IS NULL AND json_extract(binding_json,'$.agentId')=?").run(timestamp, agentId);
      this.db.raw.prepare('INSERT INTO credentials(id,token_hash,kind,binding_json,expires_at) VALUES (?,?,?,?,?)').run(credentialId, hashToken(token), 'agent', JSON.stringify(binding), timestamp + SESSION_CREDENTIAL_TTL_MS);
    });
    return { agentId, token, credentialId };
  }

  revokeCredential(id: string): void { this.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(now(), id); }
}
