import { useState, type ReactNode } from 'react';
import type { AgentPrompt, ApprovalRequest, PermissionRequest } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import { PromptCard } from './prompt-card.js';

type Props = { pending: PermissionRequest[]; decisions: ApprovalRequest[]; prompts?: AgentPrompt[]; promptHistory?: AgentPrompt[]; api: Api; notify: (text: string) => void };
const DELIVERY: Record<ApprovalRequest['delivery']['status'], string> = { queued: 'sending to Telegram…', retry: 'Telegram retrying', sent: 'sent to Telegram', uncertain: 'Telegram: maybe not delivered', failed: 'Telegram: not delivered', disabled: 'Telegram off', not_paired: 'Telegram not paired' };
const until = (at: number): string => new Date(at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

/**
 * Permission prompts from agents' terminals and decisions seats asked the manager for, answerable here (the same
 * decisions also arrive in the paired Telegram chat). Unanswered prompts fall back to the terminal; unanswered
 * decision requests expire as not approved.
 */
export function ApprovalsBar({ pending, decisions, prompts = [], promptHistory = [], api, notify }: Props): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  if (pending.length === 0 && decisions.length === 0 && prompts.length === 0 && promptHistory.length === 0) return null;
  const answer = (request: ApprovalRequest, path: string, body?: unknown): void => {
    setBusy(request.id);
    api.send('POST', `/v1/approvals/${request.id}/${path}`, body).catch(error => notify(errorText(error))).finally(() => setBusy(null));
  };
  const decide = (request: PermissionRequest, behavior: 'allow' | 'deny'): void => {
    setBusy(request.id);
    api.send('POST', `/v1/permissions/${request.id}/decision`, { behavior, message: behavior === 'deny' ? 'Denied by the manager from Agent Office.' : '' })
      .catch(error => notify(errorText(error))).finally(() => setBusy(null));
  };
  return (
    <section className="approvals" aria-label="Permission requests">
      {prompts.map(prompt => <PromptCard key={prompt.id} prompt={prompt} api={api} notify={notify} />)}
      {promptHistory.length > 0 && (
        <details className="approval">
          <summary className="muted">Recent prompts ({promptHistory.length})</summary>
          <ul>{promptHistory.map(prompt => <li key={prompt.id} className="muted">{prompt.id} · @{prompt.seatId} · {prompt.kind === 'question' ? 'question' : prompt.tool} · {prompt.state}</li>)}</ul>
        </details>
      )}
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
      {decisions.map(request => (
        <article key={request.id} className="approval">
          <div className="approval-head"><span className="status-dot status-blocked" aria-hidden /><strong>@{request.requesterSeatId}</strong><span className="muted">asks for your decision · {request.taskId ?? `#${request.channelId} thread ${request.threadSeq}`} · {request.id} r{request.revision}</span></div>
          <pre className="approval-summary">{[`Action: ${request.action}`, `Scope: ${request.scope}`, `Reason: ${request.reason}`, request.consequences && `Consequences: ${request.consequences}`, request.target && `Target: ${request.target}`].filter(Boolean).join('\n')}</pre>
          <span className="muted">Expires {until(request.expiresAt)} (not approved if unanswered) · {DELIVERY[request.delivery.status]}</span>
          <div className="row-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={busy === request.id} onClick={() => answer(request, 'decision', { decision: 'approve', revision: request.revision })}>Approve</button>
            <button type="button" className="btn btn-small btn-warn" disabled={busy === request.id} onClick={() => answer(request, 'decision', { decision: 'reject', revision: request.revision })}>Reject</button>
            {['failed', 'uncertain'].includes(request.delivery.status) && <button type="button" className="btn btn-small" disabled={busy === request.id} onClick={() => answer(request, 'resend')}>Send to Telegram again</button>}
          </div>
        </article>
      ))}
    </section>
  );
}
