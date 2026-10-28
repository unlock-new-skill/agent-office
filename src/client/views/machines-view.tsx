import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { MachineSeat, MachineSession, RunnerView } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import { CommandRow } from '../components/command-row.js';
import type { OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState; api: Api; notify: (text: string) => void };
type Install = { code: string; expiresAt: number; commands: { unix: string; windows: string } };

const MODES: Array<{ value: MachineSeat['permissionMode']; label: string }> = [
  { value: 'bypassPermissions', label: 'Bỏ qua mọi quyền (mặc định)' }, { value: 'acceptEdits', label: 'Tự sửa file, shell hỏi web' },
  { value: 'default', label: 'Mọi thứ hỏi web' }, { value: 'plan', label: 'Chỉ lập kế hoạch' },
];
const STATE_LABEL: Record<string, string> = { starting: 'starting', running: 'working', idle: 'listening', stopped: 'stopped', failed: 'failed' };
const shortPath = (value: string): string => value.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || value;
const ago = (ts: number): string => { const minutes = Math.round((Date.now() - ts) / 60_000); return minutes < 1 ? 'vừa xong' : minutes < 60 ? `${minutes} phút trước` : `${Math.round(minutes / 60)} giờ trước`; };

/**
 * Machines that run seats headless. Each machine's seat list (repo folder, permissions, session to resume) is edited
 * here and synced live to its runner; a one-line command installs everything on the machine.
 */
export function MachinesView({ state, api, notify }: Props): ReactNode {
  const [label, setLabel] = useState('');
  const add = (event: FormEvent): void => {
    event.preventDefault();
    if (!label.trim()) return;
    api.send<RunnerView>('POST', '/v1/machines', { label: label.trim() }).then(() => { setLabel(''); notify('Đã thêm máy. Bấm "Lệnh cài" để lấy lệnh chạy trên máy đó.'); }).catch(error => notify(errorText(error)));
  };
  return (
    <div className="machines-view">
      <header className="setup-head">
        <div><h1>Machines</h1><p className="muted">Mỗi máy chạy các ghế không cần terminal (runner). Sửa ở đây là máy áp dụng ngay; thư mục repo phải nằm trong vùng máy cho phép (mặc định: thư mục home).</p></div>
        <form className="row-actions" onSubmit={add}>
          <label className="sr-only" htmlFor="machine-label">Tên máy mới</label>
          <input id="machine-label" value={label} onChange={event => setLabel(event.target.value)} placeholder="Tên máy, vd Mac mini studio" maxLength={80} />
          <button type="submit" className="btn btn-small btn-primary" disabled={!label.trim()}>Thêm máy</button>
        </form>
      </header>
      {state.runners.length === 0 && <p className="muted">Chưa có máy nào. Thêm máy, bấm "Lệnh cài", chạy lệnh đó trên máy là xong.</p>}
      <div className="machine-list">{state.runners.map(runner => <MachineCard key={runner.id} runner={runner} state={state} api={api} notify={notify} />)}</div>
    </div>
  );
}

function MachineCard({ runner, state, api, notify }: { runner: RunnerView; state: OfficeState; api: Api; notify: (text: string) => void }): ReactNode {
  const [draft, setDraft] = useState<MachineSeat[]>(runner.config.seats);
  const [dirty, setDirty] = useState(false); const [saving, setSaving] = useState(false);
  const [install, setInstall] = useState<Install | null>(null); const [os, setOs] = useState<'unix' | 'windows'>(() => navigator.userAgent.includes('Windows') ? 'windows' : 'unix');
  const [sessions, setSessions] = useState<MachineSession[]>([]); const [confirmDelete, setConfirmDelete] = useState(false);
  // Follow the server's copy until the manager starts editing.
  useEffect(() => { if (!dirty) setDraft(runner.config.seats); }, [runner.config.version, runner.config.seats, dirty]);
  useEffect(() => { void api.get<{ sessions: MachineSession[] }>(`/v1/machines/${runner.id}/sessions`).then(result => setSessions(result.sessions)).catch(() => undefined); }, [api, runner.id, runner.lastSeenAt]);

  const seatsElsewhere = useMemo(() => new Set(state.runners.filter(other => other.id !== runner.id).flatMap(other => other.config.seats.map(seat => seat.seatId))), [state.runners, runner.id]);
  const orgSeats = state.org?.seats ?? [];
  const status = (seatId: string) => runner.seats.find(seat => seat.seatId === seatId);
  const edit = (index: number, patch: Partial<MachineSeat>): void => { setDraft(draft.map((seat, at) => at === index ? { ...seat, ...patch } : seat)); setDirty(true); };
  const addSeat = (): void => {
    const free = orgSeats.find(seat => !seatsElsewhere.has(seat.id) && !draft.some(row => row.seatId === seat.id));
    if (!free) { notify('Không còn ghế trống để thêm.'); return; }
    setDraft([...draft, { seatId: free.id, cwd: '', permissionMode: 'bypassPermissions', sessionId: null, autoStart: true, showWindow: true }]); setDirty(true);
  };
  const save = (): void => {
    if (draft.some(seat => !seat.cwd.trim())) { notify('Điền thư mục repo cho mọi ghế.'); return; }
    setSaving(true);
    api.send('PUT', `/v1/machines/${runner.id}/config`, { seats: draft.map(seat => ({ ...seat, cwd: seat.cwd.trim() })) })
      .then(() => { setDirty(false); notify(runner.online ? 'Đã lưu — máy đang áp dụng.' : 'Đã lưu — máy sẽ áp dụng khi runner kết nối.'); })
      .catch(error => notify(errorText(error))).finally(() => setSaving(false));
  };
  const getInstall = (): void => { api.send<Install>('POST', `/v1/machines/${runner.id}/install-code`).then(setInstall).catch(error => notify(errorText(error))); };
  const remove = (): void => {
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 4000); return; }
    api.send('DELETE', `/v1/machines/${runner.id}`).then(() => notify('Đã xoá máy và thu hồi quyền kết nối của nó.')).catch(error => notify(errorText(error)));
  };
  const name = runner.label ?? (runner.machine || runner.id);
  const presence = runner.lastSeenAt === 0 ? 'chưa cài' : runner.online ? 'online' : `offline · ${ago(runner.lastSeenAt)}`;

  return (
    <section className="machine-card" aria-label={name}>
      <header className="machine-head">
        <span className={`machine-dot ${runner.online ? 'on' : ''}`} aria-hidden="true" />
        <div className="machine-title"><strong>{name}</strong><span className="muted">{runner.machine && runner.label ? `${runner.machine} · ` : ''}{presence}</span></div>
        <span className="spacer" />
        <button type="button" className="btn btn-small btn-primary" onClick={getInstall}>Lệnh cài</button>
        <button type="button" className={`btn btn-small ${confirmDelete ? 'btn-warn' : ''}`} onClick={remove}>{confirmDelete ? 'Xác nhận xoá' : 'Xoá'}</button>
      </header>

      {install && (
        <div className="machine-install">
          <span className="map-mode" role="group" aria-label="Operating system">
            <button type="button" className={os === 'unix' ? 'active' : ''} aria-pressed={os === 'unix'} onClick={() => setOs('unix')}>macOS / Linux</button>
            <button type="button" className={os === 'windows' ? 'active' : ''} aria-pressed={os === 'windows'} onClick={() => setOs('windows')}>Windows</button>
          </span>
          <CommandRow text={install.commands[os]} notify={notify} />
          <p className="muted">Chạy 1 lần trên máy đó (cần Node.js 20+ và Claude Code đã đăng nhập): cài connector, gắn máy vào thẻ này và cài runner tự chạy khi đăng nhập. Mã dùng 1 lần, hết hạn {new Date(install.expiresAt).toLocaleString()}.</p>
        </div>
      )}

      <table className="machine-seats">
        <thead><tr><th>Ghế</th><th>Thư mục repo</th><th>Quyền</th><th>Session</th><th>Tự chạy</th><th title="Mở cửa sổ Terminal trên máy để xem session trực tiếp">Cửa sổ</th><th>Trạng thái</th><th><span className="sr-only">Xoá</span></th></tr></thead>
        <tbody>
          {draft.length === 0 && <tr><td colSpan={8} className="muted">Chưa có ghế. Bấm "+ Thêm ghế".</td></tr>}
          {draft.map((seat, index) => {
            const live = status(seat.seatId); const chosen = sessions.find(session => session.sessionId === seat.sessionId);
            return (
              <tr key={index}>
                <td data-label="Ghế"><select aria-label="Ghế" value={seat.seatId} onChange={event => edit(index, { seatId: event.target.value })}>
                  {orgSeats.map(option => <option key={option.id} value={option.id} disabled={seatsElsewhere.has(option.id) || (option.id !== seat.seatId && draft.some(row => row.seatId === option.id))}>{option.title} (@{option.id})</option>)}
                </select></td>
                <td data-label="Thư mục repo"><input aria-label="Thư mục repo (đường dẫn tuyệt đối)" value={seat.cwd} placeholder="/Users/me/projects/game" list={`cwd-${runner.id}`} onChange={event => edit(index, { cwd: event.target.value })} /></td>
                <td data-label="Quyền"><select aria-label="Quyền" value={seat.permissionMode} onChange={event => edit(index, { permissionMode: event.target.value as MachineSeat['permissionMode'] })}>
                  {MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                </select></td>
                <td data-label="Session">
                  <select aria-label="Session để tiếp tục" value={seat.sessionId ?? ''} onChange={event => {
                    const picked = sessions.find(session => session.sessionId === event.target.value);
                    edit(index, { sessionId: event.target.value || null, ...(picked && !seat.cwd ? { cwd: picked.project } : {}) });
                  }}>
                    <option value="">Tự quản lý (mới hoặc session runner đang dùng)</option>
                    {seat.sessionId && !chosen && <option value={seat.sessionId}>{seat.sessionId.slice(0, 8)}</option>}
                    {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{shortPath(session.project)} · {session.sessionId.slice(0, 8)}{session.seatId ? ` · @${session.seatId}` : ''}{session.ended ? ' · đã đóng' : ' · đang mở'}</option>)}
                  </select>
                  {chosen && !chosen.ended && <span className="machine-warn">Session đang mở ở một terminal — đóng terminal đó trước khi lưu.</span>}
                  {chosen && chosen.project !== seat.cwd && <button type="button" className="link-btn" onClick={() => edit(index, { cwd: chosen.project })}>Dùng thư mục của session</button>}
                </td>
                <td data-label="Tự chạy"><input type="checkbox" aria-label="Tự chạy khi runner khởi động" checked={seat.autoStart} onChange={event => edit(index, { autoStart: event.target.checked })} /></td>
                <td data-label="Cửa sổ"><input type="checkbox" aria-label="Mở cửa sổ theo dõi session trên desktop của máy" checked={seat.showWindow !== false} onChange={event => edit(index, { showWindow: event.target.checked })} /></td>
                <td data-label="Trạng thái" className={`runner-state state-${live?.state ?? 'stopped'}`}>{live ? STATE_LABEL[live.state] ?? live.state : '—'}{live?.state === 'failed' && live.detail ? <span className="machine-detail muted">{live.detail}</span> : null}</td>
                <td><button type="button" className="icon-btn" aria-label={`Bỏ ghế ${seat.seatId} khỏi máy này`} onClick={() => { setDraft(draft.filter((_, at) => at !== index)); setDirty(true); }}>✕</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id={`cwd-${runner.id}`}>{[...new Set(sessions.map(session => session.project))].map(project => <option key={project} value={project} />)}</datalist>
      <div className="row-actions">
        <button type="button" className="btn btn-small" onClick={addSeat}>+ Thêm ghế</button>
        <span className="spacer" />
        {dirty && <button type="button" className="btn btn-small" onClick={() => { setDraft(runner.config.seats); setDirty(false); }}>Huỷ thay đổi</button>}
        <button type="button" className="btn btn-small btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
      </div>
    </section>
  );
}
