import { useState, type ReactNode } from 'react';
import type { PermissionRequest } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';

type Props = { pending: PermissionRequest[]; api: Api; notify: (text: string) => void };

/** Permission prompts from agents' terminals, answerable here. Unanswered prompts fall back to the terminal. */
export function ApprovalsBar({ pending, api, notify }: Props): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  if (pending.length === 0) return null;
  const decide = (request: PermissionRequest, behavior: 'allow' | 'deny'): void => {
    setBusy(request.id);
    api.send('POST', `/v1/permissions/${request.id}/decision`, { behavior, message: behavior === 'deny' ? 'Denied by the manager from Agent Office.' : '' })
      .catch(error => notify(errorText(error))).finally(() => setBusy(null));
  };
  return (
    <section className="approvals" aria-label="Permission requests">
      {pending.map(request => (
        <article key={request.id} className="approval">
          <div className="approval-head"><span className="status-dot status-blocked" aria-hidden /><strong>{request.seatId ? `@${request.seatId}` : request.agentId}</strong><span className="muted">asks to run {request.tool}</span></div>
          <pre className="approval-summary">{request.summary}</pre>
          <div className="row-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={busy === request.id} onClick={() => decide(request, 'allow')}>Allow</button>
            <button type="button" className="btn btn-small btn-warn" disabled={busy === request.id} onClick={() => decide(request, 'deny')}>Deny</button>
          </div>
        </article>
      ))}
    </section>
  );
}
