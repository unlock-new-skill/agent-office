import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Project, ProjectDetail, ProjectPriority, ProjectSummary, ProjectTask, ProjectTaskState } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import type { OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState; api: Api; notify: (text: string) => void };
type Draft = { title: string; priority: ProjectPriority; goal: string; spec: string; requirements: string; acceptance: string; links: string };
const EMPTY: Draft = { title: '', priority: 'normal', goal: '', spec: '', requirements: '', acceptance: '', links: '' };
const PRIORITY_LABEL: Record<ProjectPriority, string> = { low: 'Thấp', normal: 'Bình thường', high: 'Cao', urgent: 'Gấp' };
/** Columns in the order the work moves; waiting (an input not finished) is kept apart from a real blocker. */
const COLUMNS: Array<{ state: ProjectTaskState; label: string; hint: string }> = [
  { state: 'doing', label: 'Đang làm', hint: 'owner đang làm' },
  { state: 'waiting', label: 'Chờ đầu vào', hint: 'chờ task phía trước xong — không phải lỗi' },
  { state: 'blocked', label: 'Chặn thực sự', hint: 'có blocker hoặc owner báo bị chặn' },
  { state: 'todo', label: 'Sẵn sàng / cần owner', hint: 'bắt đầu được, hoặc thiếu owner/estimate' },
  { state: 'done', label: 'Hoàn thành', hint: 'owner đã DONE kèm đầu ra; chưa phải nghiệm thu' },
];
const toDraft = (project: Project): Draft => ({ title: project.title, priority: project.priority, goal: project.goal, spec: project.spec, requirements: project.requirements, acceptance: project.acceptance, links: project.links.join('\n') });
const toBody = (draft: Draft): Record<string, unknown> => ({ title: draft.title, priority: draft.priority, goal: draft.goal, spec: draft.spec, requirements: draft.requirements, acceptance: draft.acceptance, links: draft.links.split('\n').map(line => line.trim()).filter(Boolean) });

/**
 * Projects (orders): the manager files an order with its spec; the PM splits it into tasks (projectId); owners finish
 * and hand over to their lead. The page shows the order next to where each of its tasks stands and what it delivered.
 */
export function ProjectsView({ state, api, notify }: Props): ReactNode {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  const loadList = useCallback((): void => { void api.get<{ projects: ProjectSummary[] }>('/v1/projects').then(result => setProjects(result.projects)).catch(error => notify(errorText(error))); }, [api, notify]);
  // Only the answer for the order still selected is shown, even if an older request comes back later.
  const wanted = useRef<string | null>(null);
  const loadDetail = useCallback((id: string): void => { wanted.current = id; void api.get<ProjectDetail>(`/v1/projects/${encodeURIComponent(id)}`).then(next => { if (wanted.current === id) setDetail(next); }).catch(error => notify(errorText(error))); }, [api, notify]);
  // Live: any change to a task filed under a project (status, owner, output) reloads the list and the open order.
  const signature = Object.values(state.tasks).filter(task => task.projectId !== null).map(task => `${task.id}:${task.revision}:${task.projectId}`).sort().join('|');
  const [tick, setTick] = useState(0);
  // Orders filed or edited elsewhere (the PM through MCP) show up within half a minute.
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { loadList(); }, [loadList, signature, tick]);
  useEffect(() => { if (!selected && projects?.[0]) setSelected(projects[0].id); }, [projects, selected]);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail, signature, tick]);

  const save = (event: FormEvent): void => {
    event.preventDefault(); if (saving) return;
    setSaving(true);
    const request = editing === 'edit' && detail
      ? api.send<Project>('PATCH', `/v1/projects/${detail.project.id}`, { ...toBody(draft), expectedRevision: detail.project.revision })
      : api.send<Project>('POST', '/v1/projects', toBody(draft));
    void request.then(project => { notify(editing === 'edit' ? 'Đã lưu order — PM được báo thay đổi.' : `Đã gửi order ${project.id} — PM được báo để bóc tách.`); setEditing(null); setSelected(project.id); loadList(); loadDetail(project.id); })
      .catch(error => notify(errorText(error))).finally(() => setSaving(false));
  };
  const setStatus = (project: Project, status: 'open' | 'closed'): void => {
    void api.send<Project>('PATCH', `/v1/projects/${project.id}`, { status, expectedRevision: project.revision }).then(() => { loadList(); loadDetail(project.id); }).catch(error => notify(errorText(error)));
  };
  const field = (key: keyof Draft, label: string, rows: number, placeholder = ''): ReactNode => (
    <label>{label}<textarea rows={rows} value={draft[key]} placeholder={placeholder} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></label>
  );

  return (
    <div className="projects-view">
      <aside className="projects-list">
        <div className="row-actions"><button type="button" className="btn btn-primary" onClick={() => { setDraft(EMPTY); setEditing('new'); }}>+ Order mới</button></div>
        {projects === null ? <p className="muted">Đang tải…</p> : projects.length === 0 ? <p className="muted">Chưa có order nào.</p> : (
          <ul>
            {projects.map(project => (
              <li key={project.id}>
                <button type="button" className={`project-item ${project.id === selected && !editing ? 'active' : ''} ${project.status}`} onClick={() => { setEditing(null); setSelected(project.id); }}>
                  <span className="project-item-title"><code>{project.id}</code> {project.title}</span>
                  <span className="project-item-meta">
                    <span className={`priority priority-${project.priority}`}>{PRIORITY_LABEL[project.priority]}</span>
                    {project.status === 'closed' && <span className="muted">đã đóng</span>}
                    <span>{project.counts.done}/{Object.values(project.counts).reduce((sum, value) => sum + value, 0)} xong</span>
                    {project.counts.blocked > 0 && <span className="warn">{project.counts.blocked} chặn</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="project-main">
        {editing ? (
          <form className="task-form project-form" onSubmit={save}>
            <h2>{editing === 'new' ? 'Order mới' : `Sửa ${detail?.project.id}`}</h2>
            <p className="muted">Chỉ cần tên là gửi được; các phần khác bổ sung sau cũng được. PM được báo ngay để bóc tách thành task cho các phòng ban.</p>
            <label>Tên order<input value={draft.title} maxLength={200} required onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} placeholder="vd. Lobby v2 có danh sách bạn bè" /></label>
            <label>Ưu tiên<select value={draft.priority} onChange={event => setDraft(current => ({ ...current, priority: event.target.value as ProjectPriority }))}>
              {(Object.keys(PRIORITY_LABEL) as ProjectPriority[]).map(priority => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
            </select></label>
            {field('goal', 'Mục tiêu', 2, 'Kết quả mong muốn, cho ai')}
            {field('spec', 'Spec', 8, 'Mô tả chức năng, màn hình, luồng…')}
            {field('requirements', 'Requirements', 5, 'Ràng buộc kỹ thuật, nền tảng, dữ liệu…')}
            {field('acceptance', 'Tiêu chí nghiệm thu', 4, 'Thế nào là xong')}
            {field('links', 'Link tài liệu (mỗi dòng một link)', 3, 'https://…')}
            <div className="row-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>{editing === 'new' ? 'Gửi order' : 'Lưu'}</button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Huỷ</button>
            </div>
          </form>
        ) : detail ? <ProjectPage detail={detail} state={state} onEdit={() => { setDraft(toDraft(detail.project)); setEditing('edit'); }} onStatus={status => setStatus(detail.project, status)} />
          : <p className="muted">Chọn một order, hoặc tạo order mới.</p>}
      </section>
    </div>
  );
}

function ProjectPage({ detail, state, onEdit, onStatus }: { detail: ProjectDetail; state: OfficeState; onEdit: () => void; onStatus: (status: 'open' | 'closed') => void }): ReactNode {
  const { project } = detail;
  const seatTitle = (seatId: string | null): string => seatId ? state.org?.seats.find(seat => seat.id === seatId)?.title ?? seatId : 'chưa có owner';
  const block = (label: string, text: string): ReactNode => text ? <div className="project-block"><h3>{label}</h3><p className="pre">{text}</p></div> : null;
  const card = (entry: ProjectTask): ReactNode => (
    <li key={entry.task.id} className={`project-task state-${entry.state}`}>
      <div><code>{entry.task.id}</code> {entry.task.title}</div>
      <div className="muted">@{entry.task.assigneeSeatId ?? '—'} · {seatTitle(entry.task.assigneeSeatId)}{entry.task.estimateMinutes ? ` · ${entry.task.estimateMinutes}m` : ''}</div>
      {entry.reasons.length > 0 && entry.state !== 'done' && <ul className="project-reasons">{entry.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      {entry.output && <p className="project-output pre">Đầu ra: {entry.output}</p>}
    </li>
  );
  return (
    <div className="project-page">
      <header className="project-head">
        <h2><code>{project.id}</code> {project.title}</h2>
        <span className={`priority priority-${project.priority}`}>{PRIORITY_LABEL[project.priority]}</span>
        {project.status === 'closed' && <span className="muted">đã đóng</span>}
        <span className="muted">tạo {new Date(project.createdAt).toLocaleString()} · sửa {new Date(project.updatedAt).toLocaleString()}</span>
        <div className="row-actions">
          <button type="button" className="btn btn-small" onClick={onEdit}>Sửa</button>
          <button type="button" className="btn btn-small" onClick={() => onStatus(project.status === 'open' ? 'closed' : 'open')}>{project.status === 'open' ? 'Đóng order' : 'Mở lại'}</button>
        </div>
      </header>
      <div className="project-columns">
        {COLUMNS.map(column => {
          const entries = detail.tasks.filter(entry => entry.state === column.state);
          return (
            <section key={column.state} className={`project-column column-${column.state}`}>
              <h3>{column.label} <span className="muted">({entries.length})</span></h3>
              <p className="muted small">{column.hint}</p>
              {entries.length > 0 ? <ul>{entries.map(card)}</ul> : <p className="muted small">—</p>}
            </section>
          );
        })}
      </div>
      {detail.tasks.length === 0 && <p className="muted">PM chưa bóc tách order này thành task. Khi PM tạo task với <code>projectId: {project.id}</code>, chúng hiện ở đây.</p>}
      {block('Mục tiêu', project.goal)}
      {block('Spec', project.spec)}
      {block('Requirements', project.requirements)}
      {block('Tiêu chí nghiệm thu', project.acceptance)}
      {project.links.length > 0 && <div className="project-block"><h3>Tài liệu</h3><ul>{project.links.map(link => <li key={link}>{/^https?:\/\//.test(link) ? <a href={link} target="_blank" rel="noreferrer">{link}</a> : link}</li>)}</ul></div>}
      {detail.changes.length > 0 && <details className="project-block"><summary>Lịch sử sửa ({detail.changes.length})</summary><ul>{detail.changes.map((change, index) => <li key={index}>{new Date(change.createdAt).toLocaleString()} · {change.actorId} sửa {change.field}</li>)}</ul></details>}
    </div>
  );
}
