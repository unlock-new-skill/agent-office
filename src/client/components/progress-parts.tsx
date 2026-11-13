import { useState, type FormEvent, type ReactNode } from 'react';
import { TASK_RESULTS, type ParticipantRole, type ParticipantState, type Seat, type SeatActivity, type Task, type TaskOutput, type TaskParticipant, type TaskResult } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';

const ago = (at: number | null): string => {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};
const ICON: Record<SeatActivity['state'], string> = { executing: '▶', reviewing: '◎', waiting: '⏸', available: '○', unknown: '?' };

/**
 * One line saying what a seat is really doing, from task roles and doing runs only — never from being online.
 * Shows task, role, phase, when and from where; stale or missing data says unknown with the last signal.
 */
export function SeatActivityLine({ activity }: { activity: SeatActivity | undefined }): ReactNode {
  if (!activity) return null;
  const what = activity.taskId ? `${activity.taskId}${activity.role ? ` · ${activity.role}` : ''}${activity.phase ? ` · ${activity.phase}` : ''}` : '';
  const others = activity.also.filter(entry => entry.taskId !== activity.taskId).length;
  return (
    <span className={`seat-activity activity-${activity.state}${activity.stale ? ' activity-stale' : ''}`} title={`${activity.source}${activity.reasons.length ? ` — ${activity.reasons.join('; ')}` : ''}`}>
      <b>{ICON[activity.state]} {activity.state}{activity.stale ? ' (stale)' : ''}</b>
      {what && <> {what}</>}
      {activity.since && <span className="muted"> · {ago(activity.since)}</span>}
      {activity.state !== 'unknown' && activity.reasons.length > 0 && <span className="task-waiting"> · {activity.reasons[0]}</span>}
      {activity.state === 'unknown' && !activity.taskId && <span className="muted"> · {activity.source}</span>}
      {others > 0 && <span className="muted"> · +{others} other task{others === 1 ? '' : 's'}</span>}
    </span>
  );
}

/** Participants and partial outputs of one task, with the manager's forms to record them. */
export function TaskProgress({ task, seats, participants, outputs, api, notify }: { task: Task; seats: Seat[]; participants: TaskParticipant[]; outputs: TaskOutput[]; api: Api; notify: (text: string) => void }): ReactNode {
  const [form, setForm] = useState<'none' | 'participant' | 'output'>('none');
  const [seatId, setSeatId] = useState(''); const [role, setRole] = useState<ParticipantRole>('executor'); const [state, setState] = useState<ParticipantState>('active'); const [phase, setPhase] = useState('');
  const [name, setName] = useState(''); const [scope, setScope] = useState('local'); const [evidence, setEvidence] = useState(''); const [result, setResult] = useState<TaskResult>('unknown'); const [missing, setMissing] = useState('');
  const base = `/v1/tasks/${encodeURIComponent(task.id)}`;
  const run = (promise: Promise<unknown>, done: () => void): void => { promise.then(done).catch(error => notify(errorText(error))); };
  const saveParticipant = (event: FormEvent): void => { event.preventDefault(); run(api.send('PUT', `${base}/participants`, { seatId, role, state, phase }), () => { setForm('none'); setPhase(''); }); };
  const saveOutput = (event: FormEvent): void => { event.preventDefault(); run(api.send('POST', `${base}/outputs`, { name, scope, evidence, result, missing }), () => { setForm('none'); setName(''); setEvidence(''); setMissing(''); }); };
  const accept = (output: TaskOutput): void => run(api.send('POST', `${base}/outputs/${output.id}/accept`, { missing: output.missing, accept: true }), () => notify(`Accepted "${output.name}".`));
  if (participants.length === 0 && outputs.length === 0 && form === 'none') {
    return <div className="row-actions task-progress-actions"><button type="button" className="btn btn-small" onClick={() => setForm('participant')}>+ Who works</button><button type="button" className="btn btn-small" onClick={() => setForm('output')}>+ Output</button></div>;
  }
  return (
    <div className="task-progress">
      {participants.length > 0 && <ul className="task-participants" aria-label={`People on ${task.id}`}>
        {participants.map(participant => <li key={`${participant.seatId}:${participant.role}`} className={`participant participant-${participant.state}`}>
          <b>@{participant.seatId}</b> {participant.role} · {participant.state}{participant.phase ? ` · ${participant.phase}` : ''} <span className="muted">· {ago(participant.updatedAt)} ({participant.source} by {participant.updatedBy})</span>
        </li>)}
      </ul>}
      {outputs.length > 0 && <ul className="task-outputs" aria-label={`Outputs of ${task.id}`}>
        {outputs.map(output => <li key={output.id}>
          <span className={`pill${output.acceptedBy ? ' result-pass' : ''}`}>{output.acceptedBy ? 'accepted' : 'received'}</span>{' '}
          <b>{output.name}</b>{output.scope ? <span className="pill">{output.scope}</span> : null}{output.result !== 'unknown' && <span className={`pill result-${output.result}`}>{output.result}</span>}
          <span className="muted"> · {output.recordedBy} {ago(output.recordedAt)}{output.acceptedBy ? ` · accepted by ${output.acceptedBy} ${ago(output.acceptedAt)}` : ''}</span>
          {output.evidence && <div className="muted">evidence: {output.evidence}</div>}
          {output.missing && <div className="task-waiting">still missing: {output.missing}</div>}
          {!output.acceptedBy && <button type="button" className="btn btn-small" onClick={() => accept(output)}>Accept</button>}
        </li>)}
      </ul>}
      {form === 'participant' && <form className="task-form" onSubmit={saveParticipant}>
        <label>Seat<select value={seatId} onChange={event => setSeatId(event.target.value)} required><option value="" disabled>Choose seat…</option>{seats.map(seat => <option key={seat.id} value={seat.id}>{seat.title} (@{seat.id})</option>)}</select></label>
        <label>Role<select value={role} onChange={event => setRole(event.target.value as ParticipantRole)}><option value="executor">executor</option><option value="reviewer">reviewer</option><option value="intake">intake</option></select></label>
        <label>State<select value={state} onChange={event => setState(event.target.value as ParticipantState)}><option value="active">active</option><option value="waiting">waiting</option><option value="done">done</option><option value="stopped">stopped</option></select></label>
        <label>Phase (concrete step)<input value={phase} onChange={event => setPhase(event.target.value)} maxLength={200} placeholder="e.g. export FBX v02" /></label>
        <div className="row-actions"><button type="submit" className="btn btn-primary">Save</button><button type="button" className="btn" onClick={() => setForm('none')}>Cancel</button></div>
      </form>}
      {form === 'output' && <form className="task-form" onSubmit={saveOutput}>
        <label>Output<input value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="e.g. Mesh + UV (intermediate)" /></label>
        <label>Scope<input value={scope} onChange={event => setScope(event.target.value)} maxLength={80} placeholder="local | real-env" /></label>
        <label>Evidence<input value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={1000} placeholder="paths, receipts" /></label>
        <label>Result<select value={result} onChange={event => setResult(event.target.value as TaskResult)}>{TASK_RESULTS.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
        <label>Acceptance still missing<input value={missing} onChange={event => setMissing(event.target.value)} maxLength={1000} placeholder="e.g. PBR textures, engine import" /></label>
        <div className="row-actions"><button type="submit" className="btn btn-primary">Record (received, not accepted)</button><button type="button" className="btn" onClick={() => setForm('none')}>Cancel</button></div>
      </form>}
      {form === 'none' && <div className="row-actions task-progress-actions"><button type="button" className="btn btn-small" onClick={() => setForm('participant')}>+ Who works</button><button type="button" className="btn btn-small" onClick={() => setForm('output')}>+ Output</button></div>}
    </div>
  );
}
