export type OfficeErrorStatus = 400 | 403 | 404 | 409;

/** Domain error carrying a stable error code and the HTTP status the API should answer with. */
export class OfficeError extends Error {
  /** details: extra fields returned with the error (e.g. the current task on a stale update). */
  constructor(readonly code: string, readonly status: OfficeErrorStatus, readonly details: Record<string, unknown> = {}) { super(code); }
}

export const notFound = (what: string): OfficeError => new OfficeError(`${what}_not_found`, 404);
export const forbidden = (code: string): OfficeError => new OfficeError(code, 403);
export const conflict = (code: string, details: Record<string, unknown> = {}): OfficeError => new OfficeError(code, 409, details);
export const invalid = (code: string): OfficeError => new OfficeError(code, 400);

export const slugify = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
