import { useState, type ReactNode } from 'react';
import type { AgentPrompt } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';

type Props = { prompt: AgentPrompt; api: Api; notify: (text: string) => void };
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * A prompt a runner-managed seat is blocked on: who asks, since when, who may answer, until when. The manager can
 * answer any of them (also those meant for delegates); the first answer wins. Questions take an option or own words.
 */
export function PromptCard({ prompt, api, notify }: Props): ReactNode {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const answerOf = (question: string): string => own[question]?.trim() || (picked[question] ?? []).join(', ');
  const complete = prompt.questions.every(item => answerOf(item.question));
  const send = (behavior: 'allow' | 'deny'): void => {
    setBusy(true);
    const answers = prompt.kind === 'question' && behavior === 'allow' ? Object.fromEntries(prompt.questions.map(item => [item.question, answerOf(item.question)])) : undefined;
    api.send('POST', `/v1/prompts/${prompt.id}/answer`, { binding: prompt.binding, behavior, ...(answers ? { answers } : {}), ...(behavior === 'deny' ? { message: 'Denied by the manager from Agent Office.' } : {}) })
      .catch(error => notify(errorText(error))).finally(() => setBusy(false));
  };
  const toggle = (question: string, label: string, multi: boolean): void => setPicked(current => {
    const chosen = current[question] ?? [];
    return { ...current, [question]: multi ? (chosen.includes(label) ? chosen.filter(item => item !== label) : [...chosen, label]) : [label] };
  });
  const resolvers = prompt.managerOnly ? `manager only (${prompt.managerReason})` : `${prompt.resolvers.map(item => `@${item.seatId} (${item.role})`).join(', ')} within ${prompt.taskId}`;
  return (
    <article className="approval">
      <div className="approval-head">
        <span className="status-dot status-blocked" aria-hidden /><strong>@{prompt.seatId}</strong>
        <span className="muted">{prompt.kind === 'question' ? 'asks a question' : `asks to run ${prompt.tool}`} · waiting since {clock(prompt.createdAt)} · answers: {resolvers} · denied at {clock(prompt.expiresAt)} if unanswered · {prompt.id}</span>
      </div>
      {prompt.kind === 'permission' && <pre className="approval-summary">{prompt.summary}</pre>}
      {prompt.questions.map(item => (
        <fieldset key={item.question} className="approval-summary">
          <legend>{item.header ? `${item.header}: ` : ''}{item.question}{item.multiSelect ? ' (several)' : ''}</legend>
          <div className="row-actions">
            {item.options.map(option => (
              <button key={option.label} type="button" title={option.description} aria-pressed={(picked[item.question] ?? []).includes(option.label)} className={`btn btn-small${(picked[item.question] ?? []).includes(option.label) ? ' btn-primary' : ''}`} onClick={() => toggle(item.question, option.label, item.multiSelect)}>{option.label}</button>
            ))}
            <input aria-label={`Own answer: ${item.question}`} placeholder="or type an answer" maxLength={500} value={own[item.question] ?? ''} onChange={event => setOwn(current => ({ ...current, [item.question]: event.target.value }))} />
          </div>
        </fieldset>
      ))}
      <div className="row-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={busy || (prompt.kind === 'question' && !complete)} onClick={() => send('allow')}>{prompt.kind === 'question' ? 'Send answer' : 'Allow'}</button>
        <button type="button" className="btn btn-small btn-warn" disabled={busy} onClick={() => send('deny')}>Deny</button>
      </div>
    </article>
  );
}
