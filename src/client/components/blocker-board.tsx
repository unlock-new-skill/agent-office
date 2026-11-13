import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Board, BoardGroup, DispatchMode, OrgView, Task } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';

type Props = { api: Api; org: OrgView; tasks: Record<string, Task>; departmentId: string; notify: (text: string) => void };
const MODE_LABEL: Record<DispatchMode, string> = { off: 'Off — legacy notices only, no alerts', suggest: 'Suggest — readiness + alert digest, no ready notices', on: 'On — notify owners when ready' };

/**
 * PM / manager board by root cause: "needs action" (someone must remove a blocker, set an owner or estimate, confirm a
 * result) apart from "waiting" (dependencies only), then ready / doing / done / tracking. Each group shows who
 * resolves it, the next step, the due date if committed and its tasks; totals count every task once.
 */
export function BlockerBoard({ api, org, tasks, departmentId, notify }: Props): ReactNode {
  const [board, setBoard] = useState<Board | null>(null); const [resolver, setResolver] = useState('');
  const [mode, setMode] = useState<DispatchMode | null>(null);
  // The parent may pass a new notify each render; keep it out of the fetch dependencies.
  const notifyRef = useRef(notify); notifyRef.current = notify;
  // Any task change (blocker changes re-send their tasks too) refreshes the board.
  const version = Object.values(tasks).reduce((latest, task) => Math.max(latest, task.updatedAt + task.revision), 0) + Object.keys(tasks).length;
  useEffect(() => {
    const query = new URLSearchParams({ ...(departmentId !== 'all' ? { departmentId } : {}), ...(resolver ? { resolver } : {}) });
    let live = true;
    api.get<Board>(`/v1/board?${query.toString()}`).then(result => { if (live) setBoard(result); }).catch(error => notifyRef.current(errorText(error)));
    return () => { live = false; };
  }, [api, departmentId, resolver, version]);
  useEffect(() => { api.get<{ mode: DispatchMode }>('/v1/settings/dispatch').then(result => setMode(result.mode)).catch(() => undefined); }, [api]);
  const changeMode = (next: DispatchMode): void => { api.send<{ mode: DispatchMode }>('PUT', '/v1/settings/dispatch', { mode: next }).then(result => setMode(result.mode)).catch(error => notify(errorText(error))); };

  if (!board) return <p className="muted">Loading board…</p>;
  const title = (taskId: string): string => board.tasks[taskId]?.title ?? '';
  const taskList = (ids: string[]): ReactNode => (
    <ul className="blocker-tasks">{ids.map(id => (
      <li key={id}><code>{id}</code> {title(id)}{board.tasks[id]?.assigneeSeatId ? <span className="muted"> → @{board.tasks[id]!.assigneeSeatId}</span> : <span className="task-no-estimate"> unassigned</span>}
        {board.readiness[id]?.queued && <span className="pill">queued</span>}
        {board.tasks[id]?.result && board.tasks[id]!.result !== 'unknown' && <span className={`pill result-${board.tasks[id]!.result}`}>{board.tasks[id]!.result}</span>}
      </li>
    ))}</ul>
  );
  const group = (entry: BoardGroup): ReactNode => (
    <details key={entry.id} className="blocker-group">
      <summary>
        <span className="pill">{entry.kind}</span> <strong>{entry.title}</strong>
        <span className="muted"> · {entry.taskIds.length} task{entry.taskIds.length === 1 ? '' : 's'}</span>
      </summary>
      <dl>
        <dt>Resolver</dt><dd className={entry.resolver ? '' : 'task-no-estimate'}>{entry.resolver ?? 'not assigned'}</dd>
        <dt>Next step</dt><dd>{entry.nextStep || <span className="task-no-estimate">not set</span>}</dd>
        {entry.dueAt && <><dt>Due</dt><dd>{new Date(entry.dueAt).toLocaleString()}</dd></>}
        {entry.blockerId && <><dt>Blocker</dt><dd><code>{entry.blockerId}</code></dd></>}
      </dl>
      {taskList(entry.taskIds)}
    </details>
  );
  const section = (heading: string, body: ReactNode, count: number): ReactNode => (
    <section className="blocker-section"><h3>{heading} <span className="muted">{count}</span></h3>{count ? body : <p className="muted">None.</p>}</section>
  );
  const seats = org.seats;

  return (
    <div className="blocker-board">
      <div className="board-filters">
        <label>Resolver <select value={resolver} onChange={event => setResolver(event.target.value)}>
          <option value="">Anyone</option>
          {seats.map(seat => <option key={seat.id} value={seat.id}>@{seat.id}</option>)}
        </select></label>
        <span className="spacer" />
        {mode && <label>Dispatch <select value={mode} onChange={event => changeMode(event.target.value as DispatchMode)}>
          {(Object.keys(MODE_LABEL) as DispatchMode[]).map(option => <option key={option} value={option}>{MODE_LABEL[option]}</option>)}
        </select></label>}
      </div>
      <p className="muted blocker-scope">
        Scope: {board.scope.departmentId ?? 'all departments'}{board.scope.resolver ? ` · resolver ${board.scope.resolver}` : ''} · snapshot {new Date(board.snapshotAt).toLocaleTimeString()} ·
        {' '}{board.totals.tasks} tasks (each counted once) · {board.totals.blockers} blocker records · {board.totals.groups} causes
      </p>
      {board.alerts.length > 0 && section('Alerts', <ul className="blocker-tasks">{board.alerts.map(alert => (
        <li key={alert.key}><span className="pill">{alert.kind}</span> {alert.text} <span className="muted">— owner {alert.owner} — next: {alert.next}</span></li>
      ))}</ul>, board.alerts.length)}
      {section('Needs action', board.needsAction.map(group), board.needsAction.length)}
      {section('Waiting for dependencies', board.waiting.map(group), board.waiting.length)}
      {section('Ready', taskList(board.ready), board.ready.length)}
      {section('Doing', taskList(board.doing), board.doing.length)}
      {section('Done (recent)', taskList(board.done), board.done.length)}
      {section('Tracking (umbrella tasks)', taskList(board.tracking), board.tracking.length)}
    </div>
  );
}
