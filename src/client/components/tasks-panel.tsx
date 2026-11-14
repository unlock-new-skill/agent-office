import { useState, type FormEvent, type ReactNode } from 'react';
import { MAX_EXECUTION_MINUTES, TASK_RESULTS, type Channel, type Seat, type Task, type TaskArchivePlan, type TaskKind, type TaskResult, type TaskStatus } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import { TaskProgress } from './progress-parts.js';
import { useProgress } from '../state/use-progress.js';
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

const ids = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);
const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Edits the task in place (title, requirement, assignee, estimate, order, kind). Only changed fields are sent, with the
 * revision the form was opened at: if someone changed the task meanwhile the server refuses and the card shows the new state.
 */
function EditForm({ task: live, seats, api, notify, onDone }: { task: Task; seats: Seat[]; api: Api; notify: (text: string) => void; onDone: () => void }): ReactNode {
  // The version the form was opened on: edits are compared and sent against it, so a change made meanwhile conflicts.
  const [task] = useState(live); const changedMeanwhile = live.revision !== task.revision;
  const [title, setTitle] = useState(task.title); const [body, setBody] = useState(task.body); const [assignee, setAssignee] = useState(task.assigneeSeatId ?? '');
  const [estimate, setEstimate] = useState(task.estimateMinutes === null ? '' : String(task.estimateMinutes / 60)); const [dependsOn, setDependsOn] = useState(task.dependsOn.join(', '));
  const [kind, setKind] = useState<TaskKind | ''>(task.kind ?? ''); const [reason, setReason] = useState(''); const [handoffNote, setHandoffNote] = useState('');
  const [passRequired, setPassRequired] = useState(task.passRequired.join(', ')); const [result, setResult] = useState<TaskResult>(task.result);
  const owner = assignee || null; const handingOver = task.status === 'doing' && owner !== task.assigneeSeatId;
  const minutes = estimate.trim() === '' ? null : Math.round(Number(estimate) * 60);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const patch: Record<string, unknown> = { expectedRevision: task.revision };
    if (title !== task.title) patch.title = title;
    if (body !== task.body) patch.body = body;
    if (owner !== task.assigneeSeatId) patch.assigneeSeatId = owner;
    if (minutes !== task.estimateMinutes) patch.estimateMinutes = minutes;
    if (!sameIds(ids(dependsOn), task.dependsOn)) patch.dependsOn = ids(dependsOn);
    if (kind && kind !== task.kind) patch.kind = kind;
    if (!sameIds(ids(passRequired), task.passRequired)) patch.passRequired = ids(passRequired);
    if (result !== task.result) patch.result = result;
    if (reason.trim()) patch.reason = reason.trim();
    if (handingOver) patch.handoffNote = handoffNote;
    try { await api.send('PATCH', `/v1/tasks/${encodeURIComponent(task.id)}`, patch); onDone(); }
    catch (error) { notify(errorText(error)); }
  };
  return (
    <form className="task-form" onSubmit={event => void submit(event)}>
      <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required autoFocus /></label>
      <label>Assignee<select value={assignee} onChange={event => setAssignee(event.target.value)}>
        <option value="">Unassigned</option>
        {seats.map(seat => <option key={seat.id} value={seat.id}>{seat.title} (@{seat.id})</option>)}
      </select></label>
      <label>Kind<select value={kind} onChange={event => setKind(event.target.value as TaskKind)}>
        {kind === '' && <option value="" disabled>Not classified</option>}
        <option value="execution">execution — one person, ≤ 4h</option>
        <option value="tracking">tracking — umbrella, followed apart</option>
      </select></label>
      <label>Estimate (hours)<input type="number" min="0.25" step="0.25" value={estimate} onChange={event => setEstimate(event.target.value)} /></label>
      {kind === 'execution' && minutes !== null && minutes > MAX_EXECUTION_MINUTES && <p className="task-no-estimate">Over 4h: it cannot start as one execution task — split it into steps or make it tracking.</p>}
      <label>Waits for (task ids)<input value={dependsOn} onChange={event => setDependsOn(event.target.value)} placeholder="t-design-3, t-dev-2" /></label>
      <label>Needs PASS from (subset of waits for)<input value={passRequired} onChange={event => setPassRequired(event.target.value)} placeholder="t-dev-503" /></label>
      <label>Result (separate from done)<select value={result} onChange={event => setResult(event.target.value as TaskResult)}>{TASK_RESULTS.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
      <label>Requirement<textarea value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={8000} /></label>
      {handingOver && <label>Handoff (required: the task is in progress)<textarea value={handoffNote} onChange={event => setHandoffNote(event.target.value)} rows={3} maxLength={2000} required placeholder={'Done so far:\nLeft:\nWhere the work is:'} /></label>}
      <label>Reason (kept in the task history)<input value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></label>
      {changedMeanwhile && <p className="task-no-estimate" role="status">Someone changed this task while you were editing. Saving will be refused: cancel and edit again on the latest version.</p>}
      <div className="row-actions"><button type="submit" className="btn btn-primary">Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** "t-dev-1..t-dev-5" or "t-dev-1..5" expands to the exact ids; the server only ever receives exact ids. */
const expandIds = (text: string): string[] => ids(text).flatMap(token => {
  const range = /^(t-[a-z0-9-]+?-)(\d+)\.\.(?:\1)?(\d+)$/.exec(token);
  if (!range) return [token];
  const [, prefix, from, to] = range; const start = Number(from); const end = Number(to);
  return end < start || end - start >= 1000 ? [token] : Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${start + index}`);
});

/**
 * Bulk archive / restore of exact task ids: preview first (eligible tasks with their revision, refused ones with the
 * reason), then confirm the previewed eligible set. A task changed meanwhile fails the whole batch; nothing is deleted.
 */
function ArchiveForm({ api, notify, onDone }: { api: Api; notify: (text: string) => void; onDone: () => void }): ReactNode {
  const [action, setAction] = useState<'archive' | 'restore'>('archive'); const [text, setText] = useState(''); const [reason, setReason] = useState('');
  const [plan, setPlan] = useState<TaskArchivePlan | null>(null); const [busy, setBusy] = useState(false);
  const taskIds = [...new Set(expandIds(text))];
  const preview = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true);
    try { setPlan(await api.send<TaskArchivePlan>('POST', `/v1/tasks/${action}`, { taskIds })); } catch (error) { notify(errorText(error)); } finally { setBusy(false); }
  };
  const confirm = async (): Promise<void> => {
    if (!plan || plan.eligible.length === 0) return;
    setBusy(true);
    try {
      const done = await api.send<TaskArchivePlan>('POST', `/v1/tasks/${plan.action}`, { taskIds: plan.eligible.map(entry => entry.id), confirm: true, reason, expectedRevisions: Object.fromEntries(plan.eligible.map(entry => [entry.id, entry.revision])) });
      notify(`${done.action === 'archive' ? 'Archived' : 'Restored'} ${done.eligible.length} task(s).`); onDone();
    } catch (error) {
      notify(errorText(error));
      // Show the server's current view instead of a blank form: the refused ids and their reasons.
      try { setPlan(await api.send<TaskArchivePlan>('POST', `/v1/tasks/${plan.action}`, { taskIds: plan.eligible.map(entry => entry.id) })); } catch { setPlan(null); }
    } finally { setBusy(false); }
  };
  return (
    <form className="task-form" onSubmit={event => void preview(event)}>
      <label>Action<select value={action} onChange={event => { setAction(event.target.value as 'archive' | 'restore'); setPlan(null); }}><option value="archive">Archive (hide from board, keep everything)</option><option value="restore">Restore archived tasks</option></select></label>
      <label>Task ids (exact; ranges like t-dev-1..40 expand)<textarea value={text} onChange={event => { setText(event.target.value); setPlan(null); }} rows={4} required placeholder="t-dev-12, t-dev-30..45" /></label>
      <span className={taskIds.length > 1000 ? 'task-no-estimate' : 'task-assignee'}>{taskIds.length} id(s){taskIds.length > 1000 ? ' — at most 1000 per batch' : ''}</span>
      <label>Reason (kept in each task's history)<input value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></label>
      {plan && <div role="status" className="task-plan">
        <span>{plan.eligible.length} eligible{plan.refused.length ? `, ${plan.refused.length} refused` : ''}.</span>
        {plan.refused.length > 0 && <ul className="task-steps">{plan.refused.slice(0, 50).map(entry => <li key={entry.id}><code>{entry.id}</code> {entry.reason}</li>)}{plan.refused.length > 50 && <li>+{plan.refused.length - 50} more</li>}</ul>}
        {plan.refused.length > 0 && <span className="task-no-estimate">Confirm sends only the eligible ids; the server checks the set again.</span>}
      </div>}
      <div className="row-actions">
        <button type="submit" className="btn" disabled={busy || taskIds.length === 0 || taskIds.length > 1000}>Preview</button>
        <button type="button" className="btn btn-primary" disabled={busy || !plan || plan.eligible.length === 0 || reason.trim() === ''} onClick={() => void confirm()}>{plan ? `Confirm ${plan.action} of ${plan.eligible.length}` : 'Confirm'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function TasksPanel({ state, channel, api, notify, onOpenThread }: Props): ReactNode {
  const progress = useProgress(api, state);
  const allSeats = state.org?.seats ?? [];
  const seats = allSeats.filter(seat => channel.departmentId === null || seat.departmentId === channel.departmentId);
  const inChannel = (task: Task): boolean => channel.departmentId === null || task.departmentId === channel.departmentId;
  // A step shows under its parent when the parent is listed here; otherwise (other department) on its own.
  const tasks = Object.values(state.tasks).filter(task => inChannel(task) && !(task.parentId && state.tasks[task.parentId] && inChannel(state.tasks[task.parentId]!))).sort((a, b) => b.updatedAt - a.updatedAt);
  const stepsOf = (parentId: string): Task[] => Object.values(state.tasks).filter(task => task.parentId === parentId).sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState(''); const [dependsOn, setDependsOn] = useState(''); const [stepFor, setStepFor] = useState<string | null>(null); const [editing, setEditing] = useState<string | null>(null);
  const [kind, setKind] = useState<TaskKind>('execution'); const [archiving, setArchiving] = useState(false);
  const isOpen = (taskId: string): boolean => state.tasks[taskId]?.status !== 'done';
  const seatTitle = (seatId: string | null): string => allSeats.find(seat => seat.id === seatId)?.title ?? 'unassigned';

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const minutes = Math.round(Number(estimate) * 60); const after = ids(dependsOn);
    try {
      await api.send('POST', '/v1/tasks', { title, body, assigneeSeatId: assignee, kind, ...(minutes > 0 ? { estimateMinutes: minutes } : {}), ...(after.length ? { dependsOn: after } : {}) });
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
            <label>Kind<select value={kind} onChange={event => setKind(event.target.value as TaskKind)}><option value="execution">execution — one person, ≤ 4h</option><option value="tracking">tracking — umbrella, followed apart</option></select></label>
            <label>Estimate (hours)<input type="number" min="0.25" step="0.25" value={estimate} onChange={event => setEstimate(event.target.value)} placeholder="e.g. 1.5" /></label>
            <label>Waits for (task ids)<input value={dependsOn} onChange={event => setDependsOn(event.target.value)} placeholder="t-design-3, t-dev-2" /></label>
            <label>Requirement<textarea value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={8000} required placeholder={'Goal:\nInput:\nOutput:\nAcceptance:'} /></label>
            <div className="row-actions"><button type="submit" className="btn btn-primary">Create task</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
          </form>
        : <button type="button" className="btn btn-block" onClick={() => setOpen(true)}>+ New task</button>}
      {archiving ? <ArchiveForm api={api} notify={notify} onDone={() => setArchiving(false)} /> : <button type="button" className="btn btn-block" onClick={() => setArchiving(true)}>Archive / restore tasks…</button>}
      {[...STATUSES.map(status => ({ key: status, label: status, group: tasks.filter(task => task.kind !== 'tracking' && task.status === status) })),
        { key: 'tracking', label: 'tracking', group: tasks.filter(task => task.kind === 'tracking') }].map(({ key, label, group }) => {
        if (group.length === 0) return null;
        return (
          <section key={key} className="task-group">
            <h3 className={`task-group-title status-${key}`}>{label} <span>{group.length}</span></h3>
            <ul>
              {group.map(task => {
                const steps = stepsOf(task.id); const parent = task.parentId ? state.tasks[task.parentId] : undefined;
                return (
                  <li key={task.id} className="task-card">
                    <div className="task-top"><code>{task.id}</code>{task.kind === 'tracking' && <span className="pill">tracking</span>}{task.kind === null && <span className="pill" title="Not classified as execution or tracking yet">?</span>}{task.result !== 'unknown' && <span className={`pill result-${task.result}`}>{task.result}</span>}{statusSelect(task)}</div>
                    <strong className="task-title">{task.title}</strong>
                    {task.parentId && <span className="task-assignee">step {task.step} of {task.parentId}{parent ? ` "${parent.title}"` : ''}</span>}
                    <span className="task-assignee">→ {seatTitle(task.assigneeSeatId)}{steps.length > 0 && ' (lead)'}{task.requesterSeatId && <> · requested by @{task.requesterSeatId}</>}</span>
                    <span className="task-plan">
                      <span className={task.estimateMinutes === null ? 'task-no-estimate' : ''}>⏱ {task.estimateMinutes === null ? 'no estimate' : workLabel(task.estimateMinutes * 60_000)}</span>
                      {task.dependsOn.length > 0 && <span className={task.status !== 'done' && task.dependsOn.some(isOpen) ? 'task-waiting' : ''}>
                        {task.dependsOn.some(isOpen) && task.status !== 'done' ? 'waits for' : 'after'} {task.dependsOn.join(', ')}</span>}
                    </span>
                    {task.body && <p className="task-body">{task.body}</p>}
                    <TaskProgress task={task} seats={allSeats} participants={progress.participants.filter(row => row.taskId === task.id)} outputs={progress.outputs.filter(row => row.taskId === task.id)} api={api} notify={notify} />
                    {steps.length > 0 && <ol className="task-steps" aria-label={`Steps of ${task.id}`}>
                      {steps.map(step => (
                        <li key={step.id} className={`task-step status-${step.status}`}>
                          <span className="task-step-head"><b>{step.step}.</b> <span className="task-step-title">{step.title}</span>{statusSelect(step)}</span>
                          <span className="task-assignee"><code>{step.id}</code> → {seatTitle(step.assigneeSeatId)}{step.dependsOn.some(isOpen) && step.status !== 'done' ? ` · waits for ${step.dependsOn.filter(isOpen).join(', ')}` : ''}</span>
                        </li>
                      ))}
                    </ol>}
                    {editing === task.id
                      ? <EditForm task={task} seats={allSeats.filter(seat => seat.departmentId === task.departmentId)} api={api} notify={notify} onDone={() => setEditing(null)} />
                      : stepFor === task.id
                      ? <StepForm parent={task} seats={allSeats} api={api} notify={notify} onDone={() => setStepFor(null)} />
                      : <div className="row-actions">{chatButton(task)}<button type="button" className="btn btn-small" aria-label={`Edit ${task.id}`} onClick={() => { setStepFor(null); setEditing(task.id); }}>✎ Edit</button>{!task.parentId && task.status !== 'done' && <button type="button" className="btn btn-small" onClick={() => setStepFor(task.id)}>+ Step</button>}</div>}
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
