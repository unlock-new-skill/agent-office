import { useState, type FormEvent, type ReactNode } from 'react';
import type { Channel, Task, TaskStatus } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import type { OfficeState } from '../state/office-store.js';
import { workLabel } from '../state/office-store.js';

type Props = { state: OfficeState; channel: Channel; api: Api; notify: (text: string) => void };
const STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

export function TasksPanel({ state, channel, api, notify }: Props): ReactNode {
  const seats = (state.org?.seats ?? []).filter(seat => channel.departmentId === null || seat.departmentId === channel.departmentId);
  const tasks = Object.values(state.tasks).filter(task => channel.departmentId === null || task.departmentId === channel.departmentId).sort((a, b) => b.updatedAt - a.updatedAt);
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState(''); const [dependsOn, setDependsOn] = useState('');
  const isOpen = (taskId: string): boolean => state.tasks[taskId]?.status !== 'done';
  const seatTitle = (seatId: string | null): string => state.org?.seats.find(seat => seat.id === seatId)?.title ?? 'unassigned';

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
            <label>Details<textarea value={body} onChange={event => setBody(event.target.value)} rows={3} maxLength={8000} /></label>
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
              {group.map(task => (
                <li key={task.id} className="task-card">
                  <div className="task-top"><code>{task.id}</code><select aria-label={`Status of ${task.id}`} value={task.status} onChange={event => void move(task, event.target.value as TaskStatus)}>{STATUSES.map(option => <option key={option} value={option}>{option}</option>)}</select></div>
                  <strong className="task-title">{task.title}</strong>
                  <span className="task-assignee">→ {seatTitle(task.assigneeSeatId)}{task.requesterSeatId && <> · requested by @{task.requesterSeatId}</>}</span>
                  <span className="task-plan">
                    <span className={task.estimateMinutes === null ? 'task-no-estimate' : ''}>⏱ {task.estimateMinutes === null ? 'no estimate' : workLabel(task.estimateMinutes * 60_000)}</span>
                    {task.dependsOn.length > 0 && <span className={task.status !== 'done' && task.dependsOn.some(isOpen) ? 'task-waiting' : ''}>
                      {task.dependsOn.some(isOpen) && task.status !== 'done' ? 'waits for' : 'after'} {task.dependsOn.join(', ')}</span>}
                  </span>
                  {task.body && <p className="task-body">{task.body}</p>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {tasks.length === 0 && <p className="empty">No tasks yet.</p>}
    </div>
  );
}
