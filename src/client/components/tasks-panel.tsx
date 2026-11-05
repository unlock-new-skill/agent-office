import { useState, type FormEvent, type ReactNode } from 'react';
import type { Channel, Seat, Task, TaskStatus } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import type { OfficeState } from '../state/office-store.js';
import { workLabel } from '../state/office-store.js';

type Props = { state: OfficeState; channel: Channel; api: Api; notify: (text: string) => void; onOpenThread: (task: Task) => void };
const STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

/** Form for one step of a parent task: any seat of the office, waits for the previous step unless run in parallel. */
function StepForm({ parent, seats, api, notify, onDone }: { parent: Task; seats: Seat[]; api: Api; notify: (text: string) => void; onDone: () => void }): ReactNode {
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [parallel, setParallel] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try { await api.send('POST', '/v1/tasks', { title, body, assigneeSeatId: assignee, parentId: parent.id, ...(parallel ? { parallel } : {}) }); onDone(); }
    catch (error) { notify(errorText(error)); }
  };
  return (
    <form className="task-form step-form" onSubmit={event => void submit(event)}>
      <label>Step title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required autoFocus /></label>
      <label>Assignee (any department)<select value={assignee} onChange={event => setAssignee(event.target.value)} required>
        <option value="" disabled>Choose seat…</option>
        {seats.map(seat => <option key={seat.id} value={seat.id}>{seat.title} (@{seat.id} · {seat.departmentId})</option>)}
      </select></label>
      <label>Work and expected output<textarea value={body} onChange={event => setBody(event.target.value)} rows={4} maxLength={8000} required placeholder={'Do:\nExpected output:\nAcceptance:'} /></label>
      <label className="check"><input type="checkbox" checked={parallel} onChange={event => setParallel(event.target.checked)} /> Start now (do not wait for the previous step)</label>
      <div className="row-actions"><button type="submit" className="btn btn-primary">Add step</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

export function TasksPanel({ state, channel, api, notify, onOpenThread }: Props): ReactNode {
  const allSeats = state.org?.seats ?? [];
  const seats = allSeats.filter(seat => channel.departmentId === null || seat.departmentId === channel.departmentId);
  const inChannel = (task: Task): boolean => channel.departmentId === null || task.departmentId === channel.departmentId;
  // A step shows under its parent when the parent is listed here; otherwise (other department) on its own.
  const tasks = Object.values(state.tasks).filter(task => inChannel(task) && !(task.parentId && state.tasks[task.parentId] && inChannel(state.tasks[task.parentId]!))).sort((a, b) => b.updatedAt - a.updatedAt);
  const stepsOf = (parentId: string): Task[] => Object.values(state.tasks).filter(task => task.parentId === parentId).sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState(''); const [dependsOn, setDependsOn] = useState(''); const [stepFor, setStepFor] = useState<string | null>(null);
  const isOpen = (taskId: string): boolean => state.tasks[taskId]?.status !== 'done';
  const seatTitle = (seatId: string | null): string => allSeats.find(seat => seat.id === seatId)?.title ?? 'unassigned';

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const minutes = Math.round(Number(estimate) * 60); const after = dependsOn.split(/[\s,]+/).filter(Boolean);
    try {
      await api.send('POST', '/v1/tasks', { title, body, assigneeSeatId: assignee, ...(minutes > 0 ? { estimateMinutes: minutes } : {}), ...(after.length ? { dependsOn: after } : {}) });
      setTitle(''); setBody(''); setEstimate(''); setDependsOn(''); setOpen(false);
    }
    catch (error) { notify(errorText(error)); }
  };
  const move = async (task: Task, status: TaskStatus): Promise<void> => {
    try { await api.send('PATCH', `/v1/tasks/${encodeURIComponent(task.id)}`, { status }); } catch (error) { notify(errorText(error)); }
  };
  const statusSelect = (task: Task): ReactNode => (
    <select aria-label={`Status of ${task.id}`} value={task.status} onChange={event => void move(task, event.target.value as TaskStatus)}>{STATUSES.map(option => <option key={option} value={option}>{option}</option>)}</select>
  );
  const chatButton = (task: Task): ReactNode => <button type="button" className="btn btn-small" aria-label={`Chat about ${task.id}`} onClick={() => onOpenThread(task)}>💬 Chat</button>;

  return (
    <div className="tasks-panel">
      {open
        ? <form className="task-form" onSubmit={event => void create(event)}>
            <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required autoFocus /></label>
            <label>Assignee<select value={assignee} onChange={event => setAssignee(event.target.value)} required>
              <option value="" disabled>Choose seat…</option>
              {seats.map(seat => <option key={seat.id} value={seat.id}>{seat.title} (@{seat.id})</option>)}
            </select></label>
            <label>Estimate (hours)<input type="number" min="0.25" step="0.25" value={estimate} onChange={event => setEstimate(event.target.value)} placeholder="e.g. 1.5" /></label>
            <label>Waits for (task ids)<input value={dependsOn} onChange={event => setDependsOn(event.target.value)} placeholder="t-design-3, t-dev-2" /></label>
            <label>Requirement<textarea value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={8000} required placeholder={'Goal:\nInput:\nOutput:\nAcceptance:'} /></label>
            <div className="row-actions"><button type="submit" className="btn btn-primary">Create task</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
          </form>
        : <button type="button" className="btn btn-block" onClick={() => setOpen(true)}>+ New task</button>}
      {STATUSES.map(status => {
        const group = tasks.filter(task => task.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} className="task-group">
            <h3 className={`task-group-title status-${status}`}>{status} <span>{group.length}</span></h3>
            <ul>
              {group.map(task => {
                const steps = stepsOf(task.id); const parent = task.parentId ? state.tasks[task.parentId] : undefined;
                return (
                  <li key={task.id} className="task-card">
                    <div className="task-top"><code>{task.id}</code>{statusSelect(task)}</div>
                    <strong className="task-title">{task.title}</strong>
                    {task.parentId && <span className="task-assignee">step {task.step} of {task.parentId}{parent ? ` "${parent.title}"` : ''}</span>}
                    <span className="task-assignee">→ {seatTitle(task.assigneeSeatId)}{steps.length > 0 && ' (lead)'}{task.requesterSeatId && <> · requested by @{task.requesterSeatId}</>}</span>
                    <span className="task-plan">
                      <span className={task.estimateMinutes === null ? 'task-no-estimate' : ''}>⏱ {task.estimateMinutes === null ? 'no estimate' : workLabel(task.estimateMinutes * 60_000)}</span>
                      {task.dependsOn.length > 0 && <span className={task.status !== 'done' && task.dependsOn.some(isOpen) ? 'task-waiting' : ''}>
                        {task.dependsOn.some(isOpen) && task.status !== 'done' ? 'waits for' : 'after'} {task.dependsOn.join(', ')}</span>}
                    </span>
                    {task.body && <p className="task-body">{task.body}</p>}
                    {steps.length > 0 && <ol className="task-steps" aria-label={`Steps of ${task.id}`}>
                      {steps.map(step => (
                        <li key={step.id} className={`task-step status-${step.status}`}>
                          <span className="task-step-head"><b>{step.step}.</b> <span className="task-step-title">{step.title}</span>{statusSelect(step)}</span>
                          <span className="task-assignee"><code>{step.id}</code> → {seatTitle(step.assigneeSeatId)}{step.dependsOn.some(isOpen) && step.status !== 'done' ? ` · waits for ${step.dependsOn.filter(isOpen).join(', ')}` : ''}</span>
                        </li>
                      ))}
                    </ol>}
                    {stepFor === task.id
                      ? <StepForm parent={task} seats={allSeats} api={api} notify={notify} onDone={() => setStepFor(null)} />
                      : <div className="row-actions">{chatButton(task)}{!task.parentId && task.status !== 'done' && <button type="button" className="btn btn-small" onClick={() => setStepFor(task.id)}>+ Step</button>}</div>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {tasks.length === 0 && <p className="empty">No tasks yet.</p>}
    </div>
  );
}
