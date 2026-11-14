import type { AgentSnapshot, OrgView } from '../../shared/contracts.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const ERROR_TEXT: Record<string, string> = {
  invalid_credentials: 'Wrong password.', rate_limited: 'Too many attempts — wait a minute.', setup_required: 'Run npm run setup first.',
  department_has_leader: 'This department already has a leader.', department_has_seated_agents: 'Unassign sessions from this department first.',
  agent_already_seated: 'That session already sits in another seat.', duplicate_id_or_name: 'That id or name is already taken.',
  forbidden_channel: 'Not allowed in this channel.', stale_revision: 'Someone changed this task meanwhile — the card now shows the latest version; edit again.', reassign_doing_requires_handoff: 'The task is in progress: write a handoff note to reassign it.', forbidden_task_read: 'You cannot see tasks of that department.', forbidden_task_change: 'You cannot change this task.', invalid_message_body: 'Message is empty or too long.', leader_only: 'Only a leader can do that.',
  assignee_outside_department: 'Assignee must be in the same department.', deputy_must_be_member_of_department: 'The deputy must be a member seat of this department.', mention_all_not_allowed: '@all is for the manager, leaders and deputies.', invalid_request: 'Invalid input.', unauthorized: 'Session expired — sign in again.',
  task_archived: 'This task is archived: restore it before changing it.', archive_refused: 'Some tasks cannot be archived or restored: preview again and leave them out.', archive_stale: 'A task changed after the preview: preview again.', archive_requires_leader: 'Only the manager, the PM or a department leader can archive tasks.', reason_required: 'Write why these tasks are archived or restored.',
};
export const errorText = (error: unknown): string => error instanceof ApiError ? ERROR_TEXT[error.code] ?? error.code.replaceAll('_', ' ') : error instanceof Error ? error.message : 'Something went wrong.';

export type Api = {
  get: <T>(path: string) => Promise<T>;
  send: <T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<T>;
};

/** Cookie-authenticated JSON client; mutations carry the CSRF token issued at login. */
export const createApi = (csrfToken: string, onUnauthorized: () => void): Api => {
  const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, {
      method, credentials: 'include',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) onUnauthorized();
    if (!response.ok) throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
    return payload as T;
  };
  return { get: path => request('GET', path), send: (method, path, body) => request(method, path, body ?? (method === 'DELETE' ? undefined : {})) };
};

export const login = async (password: string): Promise<string> => {
  const response = await fetch('/v1/auth/login', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const payload = await response.json().catch(() => ({})) as { csrfToken?: string; error?: string };
  if (!response.ok || !payload.csrfToken) throw new ApiError(response.status, payload.error ?? 'login_failed');
  return payload.csrfToken;
};

/** Restores an existing cookie session after reload. */
export const currentSession = async (): Promise<string | null> => {
  const response = await fetch('/v1/me', { credentials: 'include' });
  if (!response.ok) return null;
  return ((await response.json()) as { csrfToken?: string }).csrfToken ?? null;
};

/** The anonymous office map: departments, seats and live status only. */
export const publicMap = async (): Promise<{ org: OrgView; agents: AgentSnapshot[] }> => {
  const response = await fetch('/v1/public/map');
  if (!response.ok) throw new ApiError(response.status, 'public_map_unavailable');
  return await response.json() as { org: OrgView; agents: AgentSnapshot[] };
};
