import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AfterTask, MachineSeat, MachineSession, RunnerCommandKind, RunnerView } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import { CommandRow } from '../components/command-row.js';
import type { OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState; api: Api; notify: (text: string) => void };
type Install = { code: string; expiresAt: number; commands: { unix: string; windows: string } };

const MODES: Array<{ value: MachineSeat['permissionMode']; label: string }> = [
  { value: 'bypassPermissions', label: 'Bỏ qua mọi quyền (mặc định)' }, { value: 'acceptEdits', label: 'Tự sửa file, shell hỏi web' },
  { value: 'default', label: 'Mọi thứ hỏi web' }, { value: 'plan', label: 'Chỉ lập kế hoạch' },
];
/** Suggestions only; any model name the machine's Claude Code (or its proxy) accepts can be typed. */
const MODELS = ['claude-opus-5-5', 'gpt-6-astra', 'opus', 'sonnet'];
/** Same rule as the server: letters, digits and . _ : @ - / [ ] only, up to 80 characters. */
const MODEL_NAME = /^[A-Za-z0-9._:@\-/[\]]{0,80}$/;
const STATE_LABEL: Record<string, string> = { starting: 'starting', running: 'working', idle: 'listening', stopped: 'stopped', failed: 'failed' };
const AFTER_TASK: Array<{ value: AfterTask; label: string; hint: string }> = [
  { value: 'compact', label: 'Compact', hint: 'nén context, giữ tóm tắt' },
  { value: 'clear', label: 'Clear', hint: 'mở session mới, chỉ giữ ghi chú bàn giao + task + tin nhắn' },
  { value: 'off', label: 'Không làm gì', hint: 'giữ nguyên context' },
];
const afterTaskLabel = (mode: AfterTask): string => AFTER_TASK.find(option => option.value === mode)?.label ?? mode;
const shortPath = (value: string): string => value.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || value;
const ago = (ts: number): string => { const minutes = Math.round((Date.now() - ts) / 60_000); return minutes < 1 ? 'vừa xong' : minutes < 60 ? `${minutes} phút trước` : `${Math.round(minutes / 60)} giờ trước`; };

const ACTIVE = (state: string): boolean => state !== 'stopped' && state !== 'failed';
/** Sends one runner command to many seats; resolves to how many were accepted. */
const sendAll = async (api: Api, seatIds: string[], kind: RunnerCommandKind): Promise<{ ok: number; failed: number }> => {
  const results = await Promise.allSettled(seatIds.map(seatId => api.send('POST', `/v1/seats/${seatId}/runner-commands`, { kind })));
  const failed = results.filter(result => result.status === 'rejected').length;
  return { ok: seatIds.length - failed, failed };
};

/** A button that needs a second click within 4 s; for actions that cut a running session. */
function ConfirmButton({ label, confirm, title, disabled, onConfirm }: { label: string; confirm: string; title: string; disabled?: boolean; onConfirm: () => void }): ReactNode {
  const [armed, setArmed] = useState(false); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const click = (): void => {
    if (armed) { setArmed(false); onConfirm(); return; }
    setArmed(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(false), 4000);
  };
  return <button type="button" className={`btn btn-small ${armed ? 'btn-warn' : ''}`} title={title} disabled={disabled} onClick={click}>{armed ? confirm : label}</button>;
}

/**
 * Machines that run seats headless. Each machine's seat list (repo folder, permissions, session to resume) is edited
 * here and synced live to its runner; a one-line command installs everything on the machine.
 */
export function MachinesView({ state, api, notify }: Props): ReactNode {
  const [label, setLabel] = useState('');
  const [afterTask, setAfterTask] = useState<AfterTask | null>(null);
  // Seats running on online machines: "stop everything" stops their Claude processes (sessions are kept for Start).
  const activeSeats = state.runners.filter(runner => runner.online).flatMap(runner => runner.seats.filter(seat => ACTIVE(seat.state) && runner.config.seats.some(row => row.seatId === seat.seatId)).map(seat => seat.seatId));
  const stopEverything = (): void => {
    sendAll(api, activeSeats, 'stop').then(({ ok, failed }) => notify(`Đã gửi lệnh dừng ${ok} ghế${failed ? `; ${failed} ghế lỗi` : ''}. Bấm "Chạy" từng ghế (hoặc "Chạy cả máy") để chạy lại.`));
  };
  useEffect(() => { api.get<{ mode: AfterTask }>('/v1/settings/after-task').then(result => setAfterTask(result.mode)).catch(() => undefined); }, [api]);
  const changeAfterTask = (mode: AfterTask): void => {
    api.send<{ mode: AfterTask }>('PUT', '/v1/settings/after-task', { mode }).then(result => { setAfterTask(result.mode); notify(`Mặc định sau khi xong task: ${afterTaskLabel(result.mode)}.`); }).catch(error => notify(errorText(error)));
  };
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
      <div className="stop-everything">
        <ConfirmButton label={`⏹ Dừng mọi agent (${activeSeats.length})`} confirm={`Xác nhận dừng ${activeSeats.length} ghế`} title="Dừng Claude ở mọi ghế đang chạy bằng runner; session được giữ để chạy tiếp sau" disabled={activeSeats.length === 0} onConfirm={stopEverything} />
        <span className="muted">Chỉ dừng ghế chạy bằng runner; session được giữ nguyên, bấm "Chạy" để tiếp tục. Ghế mở trong terminal phải tự dừng ở máy đó.</span>
      </div>
      <div className="after-task-default">
        <label htmlFor="after-task-default">Khi agent thành viên xong task</label>
        <select id="after-task-default" value={afterTask ?? ''} disabled={!afterTask} onChange={event => changeAfterTask(event.target.value as AfterTask)}>
          {AFTER_TASK.map(option => <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>)}
        </select>
        <span className="muted">Mặc định cho mọi ghế chạy bằng runner; chỉnh riêng từng ghế ở cột "Sau task". Lead / deputy không áp dụng.</span>
      </div>
      {state.runners.length === 0 && <p className="muted">Chưa có máy nào. Thêm máy, bấm "Lệnh cài", chạy lệnh đó trên máy là xong.</p>}
      <div className="machine-list">{state.runners.map(runner => <MachineCard key={runner.id} runner={runner} state={state} api={api} notify={notify} afterTaskDefault={afterTask} />)}</div>
    </div>
  );
}

function MachineCard({ runner, state, api, notify, afterTaskDefault }: { runner: RunnerView; state: OfficeState; api: Api; notify: (text: string) => void; afterTaskDefault: AfterTask | null }): ReactNode {
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
  const invalid = (seats: MachineSeat[]): string | null => {
    if (seats.some(seat => !seat.cwd.trim())) return 'Điền thư mục repo cho mọi ghế.';
    const badModel = seats.find(seat => seat.model && !MODEL_NAME.test(seat.model));
    return badModel ? `Tên model "${badModel.model}" có ký tự không hợp lệ (chỉ chữ, số và . _ : @ - / [ ]).` : null;
  };
  // Active/Inactive is switched on its own (setActive); a draft never overwrites it with a stale value.
  const savedActive = (seat: MachineSeat): boolean => runner.config.seats.find(row => row.seatId === seat.seatId)?.autoStart ?? seat.autoStart;
  /** Saves just this row on top of the saved config: the machine restarts that seat on its current session with the new values. */
  const applyRow = (seat: MachineSeat): void => {
    const merged = { ...seat, autoStart: savedActive(seat) };
    const seats = runner.config.seats.some(row => row.seatId === seat.seatId) ? runner.config.seats.map(row => row.seatId === seat.seatId ? merged : row) : [...runner.config.seats, merged];
    const problem = invalid([seat]); if (problem) { notify(problem); return; }
    setSaving(true);
    api.send('PUT', `/v1/machines/${runner.id}/config`, { seats: seats.map(row => ({ ...row, cwd: row.cwd.trim() })) })
      .then(() => { if (draft.every(row => row.seatId === seat.seatId || !unsaved(row))) setDirty(false); notify(`@${seat.seatId}: đã áp dụng — ghế khởi động lại trên session hiện tại với cấu hình mới.`); })
      .catch(error => notify(errorText(error))).finally(() => setSaving(false));
  };
  const save = (): void => {
    const problem = invalid(draft); if (problem) { notify(problem); return; }
    setSaving(true);
    api.send('PUT', `/v1/machines/${runner.id}/config`, { seats: draft.map(seat => ({ ...seat, autoStart: savedActive(seat), cwd: seat.cwd.trim() })) })
      .then(() => { setDirty(false); notify(runner.online ? 'Đã lưu — máy đang áp dụng; ghế có thay đổi sẽ khởi động lại với cấu hình mới.' : 'Đã lưu — máy sẽ áp dụng khi runner kết nối.'); })
      .catch(error => notify(errorText(error))).finally(() => setSaving(false));
  };
  const getInstall = (): void => { api.send<Install>('POST', `/v1/machines/${runner.id}/install-code`).then(setInstall).catch(error => notify(errorText(error))); };
  const remove = (): void => {
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 4000); return; }
    api.send('DELETE', `/v1/machines/${runner.id}`).then(() => notify('Đã xoá máy và thu hồi quyền kết nối của nó.')).catch(error => notify(errorText(error)));
  };
  const command = (seatId: string, kind: RunnerCommandKind): Promise<void> => api.send('POST', `/v1/seats/${seatId}/runner-commands`, { kind }).then(() => undefined);
  const DONE_TEXT: Partial<Record<RunnerCommandKind, string>> = { fresh: 'đang mở session mới', restart: 'đang khởi động lại session', stop: 'đã dừng (session được giữ)', start: 'đang chạy lại' };
  const run = (seatId: string, kind: RunnerCommandKind): void => {
    command(seatId, kind).then(() => notify(`@${seatId}: ${DONE_TEXT[kind] ?? kind}.`)).catch(error => notify(errorText(error)));
  };
  /**
   * Active/Inactive switch: saves autoStart for this seat only (so the choice survives runner restarts) and starts or
   * stops it right away. The session is kept either way.
   */
  const [toggling, setToggling] = useState<string | null>(null);
  const setActive = (seatId: string, active: boolean): void => {
    setToggling(seatId);
    const seats = runner.config.seats.map(row => row.seatId === seatId ? { ...row, autoStart: active } : row);
    api.send('PUT', `/v1/machines/${runner.id}/config`, { seats })
      .then(() => runner.online ? command(seatId, active ? 'start' : 'stop').catch(() => undefined) : undefined)
      .then(() => notify(`@${seatId}: ${active ? 'Active — đang chạy lại' : 'Inactive — đã cho nghỉ (session được giữ)'}${runner.online ? '' : '; máy đang offline, sẽ áp dụng khi kết nối'}.`))
      .catch(error => notify(errorText(error))).finally(() => setToggling(null));
  };
  const machineActive = runner.seats.filter(seat => ACTIVE(seat.state) && runner.config.seats.some(row => row.seatId === seat.seatId)).map(seat => seat.seatId);
  const machineStopped = runner.config.seats.filter(row => row.autoStart).map(row => row.seatId).filter(seatId => !machineActive.includes(seatId));
  const bulk = (seatIds: string[], kind: 'stop' | 'start'): void => {
    sendAll(api, seatIds, kind).then(({ ok, failed }) => notify(`${kind === 'stop' ? 'Dừng' : 'Chạy lại'} ${ok} ghế trên ${runner.label ?? runner.machine}${failed ? `; ${failed} ghế lỗi` : ''}.`));
  };
  const runningSeats = runner.seats.filter(seat => runner.config.seats.some(row => row.seatId === seat.seatId)).map(seat => seat.seatId);
  const restartAll = (): void => {
    Promise.allSettled(runningSeats.map(seatId => command(seatId, 'restart'))).then(results => {
      const failed = results.filter(result => result.status === 'rejected').length;
      notify(failed ? `Khởi động lại ${runningSeats.length - failed}/${runningSeats.length} ghế; ${failed} ghế lỗi.` : `Đang khởi động lại ${runningSeats.length} ghế.`);
    });
  };
  const setSeatAfterTask = (seatId: string, mode: AfterTask | null): void => {
    api.send('PUT', `/v1/seats/${seatId}/after-task`, { mode }).then(() => notify(`@${seatId} sau task: ${mode ? afterTaskLabel(mode) : 'theo mặc định'}.`)).catch(error => notify(errorText(error)));
  };
  const leadLike = (seatId: string): boolean => {
    const seat = orgSeats.find(candidate => candidate.id === seatId);
    return !seat || seat.role === 'leader' || state.org?.departments.some(department => department.deputySeatId === seatId) === true;
  };
  // A row whose repo, model, permissions or session differ from the saved config: the machine still runs the old values.
  const unsaved = (seat: MachineSeat): boolean => {
    const saved = runner.config.seats.find(row => row.seatId === seat.seatId);
    return !saved || saved.cwd !== seat.cwd || (saved.model ?? null) !== (seat.model ?? null) || saved.permissionMode !== seat.permissionMode || saved.sessionId !== seat.sessionId || saved.showWindow !== seat.showWindow;
  };
  const name = runner.label ?? (runner.machine || runner.id);
  const presence = runner.lastSeenAt === 0 ? 'chưa cài' : runner.online ? 'online' : `offline · ${ago(runner.lastSeenAt)}`;

  return (
    <section className="machine-card" aria-label={name}>
      <header className="machine-head">
        <span className={`machine-dot ${runner.online ? 'on' : ''}`} aria-hidden="true" />
        <div className="machine-title"><strong>{name}</strong><span className="muted">{runner.machine && runner.label ? `${runner.machine} · ` : ''}{presence}</span></div>
        <span className="spacer" />
        <ConfirmButton label="Dừng cả máy" confirm={`Xác nhận dừng ${machineActive.length} ghế`} title="Dừng Claude ở mọi ghế đang chạy trên máy này (giữ session)" disabled={!runner.online || machineActive.length === 0} onConfirm={() => bulk(machineActive, 'stop')} />
        <button type="button" className="btn btn-small" title="Chạy lại mọi ghế đang dừng trên máy này (tiếp tục session cũ)" disabled={!runner.online || machineStopped.length === 0 || dirty} onClick={() => bulk(machineStopped, 'start')}>Chạy cả máy</button>
        <ConfirmButton label="Restart tất cả" confirm={`Xác nhận restart ${runningSeats.length} ghế`} title="Khởi động lại session của mọi ghế trên máy này (tiếp tục đúng session cũ)" disabled={!runner.online || runningSeats.length === 0 || dirty} onConfirm={restartAll} />
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

      {dirty && <div className="machine-unsaved" role="status">
        <span><strong>Có thay đổi chưa lưu.</strong> Máy vẫn chạy cấu hình cũ cho tới khi bấm Lưu; ghế đổi repo, model, quyền hoặc session sẽ tự khởi động lại với cấu hình mới.</span>
        <button type="button" className="btn btn-small" onClick={() => { setDraft(runner.config.seats); setDirty(false); }}>Huỷ</button>
        <button type="button" className="btn btn-small btn-primary" disabled={saving} onClick={save}>{saving ? 'Đang lưu…' : 'Lưu & áp dụng'}</button>
      </div>}
      <table className="machine-seats">
        <thead><tr><th>Ghế</th><th>Thư mục repo</th><th>Model</th><th>Quyền</th><th>Session</th><th title="Inactive: ghế nghỉ (không chạy Claude), kể cả khi runner khởi động lại; mention vẫn được giữ chờ">Active</th><th title="Mở cửa sổ Terminal trên máy để xem session trực tiếp">Cửa sổ</th><th title="Khi agent thành viên tự đánh dấu xong task">Sau task</th><th>Trạng thái</th><th>Điều khiển</th><th><span className="sr-only">Xoá</span></th></tr></thead>
        <tbody>
          {draft.length === 0 && <tr><td colSpan={11} className="muted">Chưa có ghế. Bấm "+ Thêm ghế".</td></tr>}
          {draft.map((seat, index) => {
            const live = status(seat.seatId); const chosen = sessions.find(session => session.sessionId === seat.sessionId); const changed = unsaved(seat);
            return (
              <tr key={index} className={changed ? 'row-unsaved' : undefined}>
                <td data-label="Ghế"><select aria-label="Ghế" value={seat.seatId} onChange={event => edit(index, { seatId: event.target.value })}>
                  {orgSeats.map(option => <option key={option.id} value={option.id} disabled={seatsElsewhere.has(option.id) || (option.id !== seat.seatId && draft.some(row => row.seatId === option.id))}>{option.title} (@{option.id})</option>)}
                </select></td>
                <td data-label="Thư mục repo"><input aria-label="Thư mục repo (đường dẫn tuyệt đối)" value={seat.cwd} placeholder="/Users/me/projects/game" list={`cwd-${runner.id}`} onChange={event => edit(index, { cwd: event.target.value })} /></td>
                <td data-label="Model"><input aria-label="Model (trống = mặc định của máy; gõ tên bất kỳ)" list="runner-models" value={seat.model ?? ''} placeholder="mặc định · gõ tên bất kỳ" maxLength={80} aria-invalid={Boolean(seat.model && !MODEL_NAME.test(seat.model))} onChange={event => edit(index, { model: event.target.value.trim() || null })} />
                  {seat.model && !MODEL_NAME.test(seat.model) && <span className="machine-warn">Chỉ dùng chữ, số và . _ : @ - / [ ]</span>}</td>
                <td data-label="Quyền"><select aria-label="Quyền" value={seat.permissionMode} onChange={event => edit(index, { permissionMode: event.target.value as MachineSeat['permissionMode'] })}>
                  {MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                </select></td>
                <td data-label="Session">
                  <input aria-label="Session để tiếp tục (chọn hoặc dán session id)" list={`sessions-${runner.id}`} value={seat.sessionId ?? ''} placeholder="Trống = tự quản lý · dán session id để tiếp tục"
                    onChange={event => {
                      const value = event.target.value.trim();
                      const picked = sessions.find(session => session.sessionId === value);
                      edit(index, { sessionId: value || null, ...(picked && !seat.cwd ? { cwd: picked.project } : {}) });
                    }} />
                  {chosen && !chosen.ended && <span className="machine-warn">Session đang mở ở một terminal — khi lưu, hệ thống tự đóng Claude ở terminal đó (sau lượt đang chạy) rồi runner chạy tiếp session này.</span>}
                  {chosen && chosen.project !== seat.cwd && <button type="button" className="link-btn" onClick={() => edit(index, { cwd: chosen.project })}>Dùng thư mục của session</button>}
                </td>
                <td data-label="Active">{(() => {
                  const saved = runner.config.seats.find(row => row.seatId === seat.seatId); const active = saved?.autoStart ?? seat.autoStart;
                  return <button type="button" role="switch" aria-checked={active} className={`switch ${active ? 'on' : ''}`} disabled={!saved || saving || toggling === seat.seatId}
                    title={active ? 'Active — bấm để cho ghế nghỉ (dừng Claude, giữ session)' : 'Inactive — bấm để chạy lại ghế (tiếp tục session cũ)'} onClick={() => setActive(seat.seatId, !active)}>
                    <span className="switch-knob" aria-hidden="true" /><span className="switch-label">{active ? 'Active' : 'Inactive'}</span>
                  </button>;
                })()}</td>
                <td data-label="Cửa sổ"><input type="checkbox" aria-label="Mở cửa sổ theo dõi session trên desktop của máy" checked={seat.showWindow !== false} onChange={event => edit(index, { showWindow: event.target.checked })} /></td>
                <td data-label="Sau task">{leadLike(seat.seatId)
                  ? <span className="muted" title="Lead và deputy giữ nguyên context">Lead — không áp dụng</span>
                  : <select aria-label={`Sau khi @${seat.seatId} xong task`} value={orgSeats.find(candidate => candidate.id === seat.seatId)?.afterTask ?? ''} onChange={event => setSeatAfterTask(seat.seatId, (event.target.value || null) as AfterTask | null)}>
                      <option value="">Mặc định{afterTaskDefault ? ` (${afterTaskLabel(afterTaskDefault)})` : ''}</option>
                      {AFTER_TASK.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>}</td>
                <td data-label="Trạng thái" className={`runner-state state-${live?.state ?? 'stopped'}`}>{live ? STATE_LABEL[live.state] ?? live.state : '—'}{live?.state === 'failed' && live.detail ? <span className="machine-detail muted">{live.detail}</span> : null}</td>
                <td data-label="Điều khiển">{changed ? <span className="machine-actions">
                  <button type="button" className="btn btn-small btn-primary" disabled={saving} title="Lưu riêng ghế này và khởi động lại nó trên session đang chạy với cấu hình mới" onClick={() => applyRow(seat)}>Áp dụng</button>
                  <span className="machine-warn">Chưa lưu</span>
                </span> : <span className="machine-actions">
                  {live && ACTIVE(live.state)
                    ? <ConfirmButton label="Dừng" confirm="Xác nhận dừng" title="Dừng Claude ở ghế này; session được giữ, bấm Chạy để tiếp tục" disabled={!runner.online} onConfirm={() => run(seat.seatId, 'stop')} />
                    : <button type="button" className="btn btn-small btn-primary" title="Chạy ghế này (tiếp tục session cũ)" disabled={!runner.online || !live} onClick={() => run(seat.seatId, 'start')}>Chạy</button>}
                  <ConfirmButton label="Restart" confirm="Xác nhận restart" title="Dừng rồi chạy lại Claude, tiếp tục đúng session hiện tại (giữ context)" disabled={!runner.online || !live} onConfirm={() => run(seat.seatId, 'restart')} />
                  <ConfirmButton label="Session mới" confirm="Xác nhận session mới" title="Dừng session hiện tại và mở một session Claude mới cho ghế này (mất context cũ; ghi chú bàn giao và task vẫn còn)" disabled={!runner.online || !live} onConfirm={() => run(seat.seatId, 'fresh')} />
                </span>}</td>
                <td><button type="button" className="icon-btn" aria-label={`Bỏ ghế ${seat.seatId} khỏi máy này`} onClick={() => { setDraft(draft.filter((_, at) => at !== index)); setDirty(true); }}>✕</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="runner-models">{MODELS.map(model => <option key={model} value={model} />)}</datalist>
      <datalist id={`sessions-${runner.id}`}>{sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{shortPath(session.project)}{session.seatId ? ` · @${session.seatId}` : ''}{session.ended ? ' · đã đóng' : ' · đang mở'}</option>)}</datalist>
      <datalist id={`cwd-${runner.id}`}>{[...new Set(sessions.map(session => session.project))].map(project => <option key={project} value={project} />)}</datalist>
      <div className="row-actions">
        <button type="button" className="btn btn-small" onClick={addSeat}>+ Thêm ghế</button>
        <span className="spacer" />
        {dirty && <button type="button" className="btn btn-small" onClick={() => { setDraft(runner.config.seats); setDirty(false); }}>Huỷ thay đổi</button>}
        <button type="button" className="btn btn-small btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Đang lưu…' : dirty ? 'Lưu & áp dụng' : 'Đã lưu'}</button>
      </div>
    </section>
  );
}
