import { useState, type ReactNode } from 'react';
import type { Seat, Task, TaskStatus } from '../../shared/contracts.js';
import { StatusDot } from '../components/status-dot.js';
import { seatStatus, workLabel, type OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState };
/** Open tasks older than this are flagged: probably stuck. */
const STALE_MS = 2 * 3_600_000;
const ORDER: Record<TaskStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
const DONE_PER_SEAT = 5;

const age = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
};

/**
 * Task board grouped by seat: each seat's open tasks (in progress first) with estimate, order and the full requirement
 * one click away. Filters by department, text and whether recently finished tasks are shown.
 */
export function RequestsView({ state }: Props): ReactNode {
  const [department, setDepartment] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (taskId: string): void => setExpanded(current => { const next = new Set(current); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });

  const org = state.org; const now = Date.now();
  if (!org) return <div className="loading">Loading office…</div>;
  const needle = query.trim().toLowerCase();
  const matches = (task: Task): boolean => !needle || `${task.id} ${task.title} ${task.body}`.toLowerCase().includes(needle);
  const allTasks = Object.values(state.tasks);
  const statusOf = (taskId: string): TaskStatus | undefined => state.tasks[taskId]?.status;
  const tasksOf = (seatId: string | null, departmentId?: string): Task[] => {
    const own = allTasks.filter(task => (seatId ? task.assigneeSeatId === seatId : !task.assigneeSeatId && task.departmentId === departmentId) && matches(task));
    const open = own.filter(task => task.status !== 'done').sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.createdAt - b.createdAt);
    const done = showDone ? own.filter(task => task.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DONE_PER_SEAT) : [];
    return [...open, ...done];
  };
  const departments = org.departments.filter(candidate => department === 'all' || candidate.id === department);
  const openCount = (departmentId: string): number => allTasks.filter(task => task.departmentId === departmentId && task.status !== 'done').length;

  const taskRow = (task: Task): ReactNode => {
    const open = expanded.has(task.id);
    const waiting = task.status !== 'done' ? task.dependsOn.filter(id => statusOf(id) !== 'done') : [];
    const stale = task.status !== 'done' && now - task.createdAt > STALE_MS;
    return (
      <li key={task.id} className={`board-task status-${task.status}`}>
        <button type="button" className="board-task-head" aria-expanded={open} onClick={() => toggle(task.id)}>
          <span className={`status-pill ${task.status}`}>{task.status}</span>
          <code>{task.id}</code>
          <span className="board-task-title">{task.title}</span>
          <span className="board-task-meta">
            {task.estimateMinutes !== null ? <span>⏱ {workLabel(task.estimateMinutes * 60_000)}</span> : task.status !== 'done' && <span className="task-no-estimate">no estimate</span>}
            {waiting.length > 0 && <span className="task-waiting">waits for {waiting.join(', ')}</span>}
            <span className={stale ? 'task-waiting' : 'muted'}>{age((task.status === 'done' ? task.updatedAt : now) - task.createdAt)}</span>
          </span>
        </button>
        {open && <div className="board-task-detail">
          <dl>
            {task.requesterSeatId && <><dt>Requested by</dt><dd>@{task.requesterSeatId}</dd></>}
            <dt>Created</dt><dd>{new Date(task.createdAt).toLocaleString()} by {task.createdByKind === 'manager' ? 'manager' : `@${task.createdById}`}</dd>
            <dt>Updated</dt><dd>{new Date(task.updatedAt).toLocaleString()}</dd>
            {task.dependsOn.length > 0 && <><dt>After</dt><dd>{task.dependsOn.map(id => <span key={id} className={statusOf(id) === 'done' ? 'muted' : 'task-waiting'}>{id} ({statusOf(id) ?? 'unknown'}) </span>)}</dd></>}
          </dl>
          <h4>Requirement</h4>
          {task.body ? <p className="board-requirement">{task.body}</p> : <p className="task-no-estimate">No requirement written for this task.</p>}
        </div>}
      </li>
    );
  };

  const seatCard = (seat: Seat): ReactNode => {
    const tasks = tasksOf(seat.id);
    if (tasks.length === 0 && (needle || department === 'all')) return null;
    const open = tasks.filter(task => task.status !== 'done');
    const left = open.reduce((total, task) => total + (task.estimateMinutes ?? 0), 0);
    const count = (status: TaskStatus): number => open.filter(task => task.status === status).length;
    return (
      <section key={seat.id} className="board-seat" aria-label={`Tasks of ${seat.title}`}>
        <header>
          <StatusDot status={seatStatus(seat, state.agents)} />
          <strong>{seat.title}</strong><span className="muted">@{seat.id}</span>
          <span className="spacer" />
          <span className="board-counts">
            {count('doing') > 0 && <span className="status-pill doing">{count('doing')} doing</span>}
            {count('blocked') > 0 && <span className="status-pill blocked">{count('blocked')} blocked</span>}
            {count('todo') > 0 && <span className="status-pill">{count('todo')} todo</span>}
            {left > 0 && <span className="muted">⏱ {workLabel(left * 60_000)} left</span>}
          </span>
        </header>
        {tasks.length ? <ul>{tasks.map(taskRow)}</ul> : <p className="muted board-empty">No open tasks.</p>}
      </section>
    );
  };

  const sections = departments.map(candidate => {
    const seats = org.seats.filter(seat => seat.departmentId === candidate.id).sort((a, b) => (a.role === 'leader' ? -1 : 0) - (b.role === 'leader' ? -1 : 0) || a.sort - b.sort);
    const cards = seats.map(seatCard).filter(Boolean);
    const unassigned = tasksOf(null, candidate.id);
    if (cards.length === 0 && unassigned.length === 0) return null;
    return (
      <section key={candidate.id} className="board-department" aria-label={candidate.name}>
        <h2><span className="board-swatch" style={{ background: candidate.color }} />{candidate.name} <span className="muted">{openCount(candidate.id)} open</span></h2>
        <div className="board-seats">
          {cards}
          {unassigned.length > 0 && <section className="board-seat"><header><strong>Unassigned</strong></header><ul>{unassigned.map(taskRow)}</ul></section>}
        </div>
      </section>
    );
  }).filter(Boolean);

  return (
    <div className="requests-view">
      <div className="board-filters">
        <label className="sr-only" htmlFor="board-department">Department</label>
        <select id="board-department" value={department} onChange={event => setDepartment(event.target.value)}>
          <option value="all">All departments</option>
          {org.departments.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} ({openCount(candidate.id)})</option>)}
        </select>
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search id, title, requirement…" aria-label="Search tasks" />
        <label className="board-toggle"><input type="checkbox" checked={showDone} onChange={event => setShowDone(event.target.checked)} /> Show recently done</label>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={() => setExpanded(new Set(expanded.size ? [] : allTasks.filter(task => task.status !== 'done').map(task => task.id)))}>{expanded.size ? 'Collapse all' : 'Expand all'}</button>
      </div>
      {sections.length ? sections : <p className="muted">No tasks match.</p>}
    </div>
  );
}
