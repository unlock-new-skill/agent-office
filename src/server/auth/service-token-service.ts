import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import { invalid, notFound } from '../collaboration/office-error.js';
import type { OrgService } from '../collaboration/org-service.js';

/** Bearer prefix that marks a service token (seat and connector tokens never start with it). */
export const SERVICE_TOKEN_PREFIX = 'aos_';
const DAY_MS = 86_400_000; const MAX_DAYS = 365; const DEFAULT_DAYS = 90;
/** Requests per token per minute. */
export const SERVICE_RATE_LIMIT = 120;
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** departments null = the whole office. */
export type ServiceScope = { id: string; label: string; departments: string[] | null };
export type ServiceTokenView = ServiceScope & { createdAt: number; expiresAt: number; revokedAt: number | null; lastUsedAt: number | null };
type Row = { id: string; label: string; departments: string | null; createdAt: number; expiresAt: number; revokedAt: number | null; lastUsedAt: number | null };
const COLUMNS = 'id,label,departments,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt,last_used_at AS lastUsedAt';
const toView = (row: Row): ServiceTokenView => ({ ...row, departments: row.departments === null ? null : JSON.parse(row.departments) as string[] });

/**
 * Read-only credentials for server integrations (e.g. a schedule page adapter). Only the manager creates and revokes
 * them; the token is shown once and only its SHA-256 is stored; every token expires. A service token reads tasks,
 * task details, the board, blockers and the directory of its scope and nothing else (enforced in app.ts).
 */
export class ServiceTokenService {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly db: Database, private readonly org: OrgService) {}

  list(): ServiceTokenView[] { return (this.db.raw.prepare(`SELECT ${COLUMNS} FROM service_tokens ORDER BY created_at DESC`).all() as Row[]).map(toView); }

  create(input: { label: string; departments?: string[] | null | undefined; expiresInDays?: number | undefined }, now = Date.now()): { token: string; serviceToken: ServiceTokenView } {
    const label = input.label.trim(); const days = input.expiresInDays ?? DEFAULT_DAYS;
    if (label.length === 0 || label.length > 80) throw invalid('invalid_label');
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw invalid('invalid_expiry');
    const departments = input.departments === undefined || input.departments === null ? null : [...new Set(input.departments)];
    if (departments) { if (departments.length === 0) throw invalid('departments_empty'); for (const id of departments) this.org.department(id); }
    const id = `st-${randomBytes(6).toString('hex')}`; const token = `${SERVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.db.raw.prepare('INSERT INTO service_tokens(id,label,token_hash,departments,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(id, label, hash(token), departments ? JSON.stringify(departments) : null, now, now + days * DAY_MS);
    return { token, serviceToken: this.get(id) };
  }

  revoke(id: string, now = Date.now()): ServiceTokenView {
    this.get(id);
    this.db.raw.prepare('UPDATE service_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now, id);
    return this.get(id);
  }

  /** The scope of a valid token, or null (unknown, revoked or expired). Marks it used at most once a minute. */
  authenticate(token: string, now = Date.now()): ServiceScope | null {
    if (!token.startsWith(SERVICE_TOKEN_PREFIX)) return null;
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM service_tokens WHERE token_hash=?`).get(hash(token)) as Row | undefined;
    if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
    this.db.raw.prepare('UPDATE service_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)').run(now, row.id, now - 60_000);
    const { id, label, departments } = toView(row);
    return { id, label, departments };
  }

  /** Fixed one-minute window per token; false once the token used up its requests. */
  allow(id: string, now = Date.now()): boolean {
    const window = this.windows.get(id);
    if (!window || now - window.start >= 60_000) { this.windows.set(id, { start: now, count: 1 }); return true; }
    window.count++;
    return window.count <= SERVICE_RATE_LIMIT;
  }

  private get(id: string): ServiceTokenView {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM service_tokens WHERE id=?`).get(id) as Row | undefined;
    if (!row) throw notFound('service_token');
    return toView(row);
  }
}
