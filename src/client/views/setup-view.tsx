import { useState, type FormEvent, type ReactNode } from 'react';
import { errorText, type Api } from '../api/http.js';
import { joinUrl } from '../../shared/join.js';
import type { OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState; api: Api; notify: (text: string) => void };
type Os = 'unix' | 'windows';
type Created = { code: string; expiresAt: number; uses: number; commands: { unix: string; windows: string } };

const CONNECTOR = { unix: '~/.agent-office/bin/agent-office.mjs', windows: '"$env:USERPROFILE\\.agent-office\\bin\\agent-office.mjs"' };
const connector = (os: Os, mode: string): string => `node ${CONNECTOR[os]} ${mode}`;

function Command({ text, notify }: { text: string; notify: (text: string) => void }): ReactNode {
  const copy = (): void => { navigator.clipboard.writeText(text).then(() => notify('Copied.')).catch(() => window.prompt('Copy this command:', text)); };
  return <span className="command-row"><code>{text}</code><button type="button" className="btn btn-small" onClick={copy}>Copy</button></span>;
}

/**
 * Complete machine setup guide: prerequisites, connecting (install code minted here), starting seated sessions,
 * verifying, updating, reinstalling from scratch, options and troubleshooting — with macOS/Linux and Windows commands.
 */
export function SetupView({ state, api, notify }: Props): ReactNode {
  const [os, setOs] = useState<Os>(() => navigator.userAgent.includes('Windows') ? 'windows' : 'unix');
  const [uses, setUses] = useState(1); const [created, setCreated] = useState<Created | null>(null);
  const seats = state.org?.seats ?? [];
  const [seatId, setSeatId] = useState('');
  const seat = seats.find(candidate => candidate.id === seatId) ?? seats[0];
  const createCode = (event: FormEvent): void => {
    event.preventDefault();
    api.send<Created>('POST', '/v1/install-codes', { uses, hours: 24 }).then(setCreated).catch(error => notify(errorText(error)));
  };
  const cmd = (text: string): ReactNode => <Command text={text} notify={notify} />;
  const seatCommand = seat ? (os === 'windows' ? `$env:AGENT_OFFICE_SEAT="${seat.id}"; claude` : `AGENT_OFFICE_SEAT=${seat.id} claude`) : '';

  return (
    <div className="setup-view">
      <header className="setup-head">
        <div><h1>Setup</h1><p className="muted">Kết nối một máy chạy Claude Code vào Agent Office — làm lần đầu, cập nhật, hoặc cài lại từ đầu.</p></div>
        <span className="map-mode" role="group" aria-label="Operating system">
          <button type="button" className={os === 'unix' ? 'active' : ''} aria-pressed={os === 'unix'} onClick={() => setOs('unix')}>macOS / Linux</button>
          <button type="button" className={os === 'windows' ? 'active' : ''} aria-pressed={os === 'windows'} onClick={() => setOs('windows')}>Windows</button>
        </span>
      </header>

      <section className="setup-step">
        <h2><span>1</span>Yêu cầu</h2>
        <p>Máy cần <strong>Node.js 20+</strong> và <strong>Claude Code</strong> đã đăng nhập. Không cần clone code. {os === 'windows' ? 'Chạy các lệnh trong PowerShell.' : 'Chạy các lệnh trong Terminal.'}</p>
        {cmd('node -v')}{cmd('claude --version')}
      </section>

      <section className="setup-step">
        <h2><span>2</span>Kết nối máy</h2>
        <p>Tạo mã cài đặt (dùng cho số máy chọn, hết hạn sau 24 giờ — giữ như mật khẩu), rồi chạy lệnh trên máy đó. Lệnh tải connector về <code>~/.agent-office/bin/</code>, lưu credential, gộp hook vào <code>~/.claude/settings.json</code> (có backup) và đăng ký MCP <code>agent-office</code>.</p>
        {created
          ? <>
              {cmd(os === 'windows' ? created.commands.windows : created.commands.unix)}
              <p className="muted">Dùng được cho {created.uses} máy, đến {new Date(created.expiresAt).toLocaleString()}. <button type="button" className="link-btn" onClick={() => setCreated(null)}>Tạo mã khác</button></p>
            </>
          : <form className="row-actions" onSubmit={createCode}>
              <label className="inline-label">Số máy<input type="number" min={1} max={50} value={uses} onChange={event => setUses(Math.min(50, Math.max(1, Number(event.target.value) || 1)))} /></label>
              <button type="submit" className="btn btn-primary btn-small">Tạo lệnh cài đặt</button>
            </form>}
        <p className="muted">Nếu installer báo không chạy được <code>claude mcp</code>, chạy lệnh đăng ký MCP mà nó in ra.</p>
      </section>

      <section className="setup-step">
        <h2><span>3</span>Mở agent ngồi vào ghế</h2>
        <p>Mở Claude Code tại repo mà vai trò đó làm việc, kèm ghế muốn ngồi:</p>
        {seats.length > 0 && <label className="inline-label">Ghế<select value={seat?.id ?? ''} onChange={event => setSeatId(event.target.value)}>{seats.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title} (@{candidate.id}){candidate.agentId ? ' — đang có người' : ''}</option>)}</select></label>}
        {seat && cmd(seatCommand)}
        <p>Hoặc với session đang chạy: dán link join vào khung chat của Claude — hook tự nhận ghế:</p>
        {seat && cmd(joinUrl(location.origin, seat.id))}
        <p className="muted">Ghế đang có session sống thì bị từ chối (<code>seat_occupied</code>) — chọn ghế khác hoặc Unassign trong Org.</p>
      </section>

      <section className="setup-step">
        <h2><span>4</span>Kiểm tra</h2>
        <ul>
          <li>Session hiện trong <strong>Org</strong> (Unassigned hoặc đúng ghế) và trong <strong>Map</strong>.</li>
          <li>Sau khi agent trả lời xong 1 lượt, chấm ghế chuyển <strong>xanh lá — listening</strong> và giữ nguyên suốt lúc session mở (terminal vẫn gõ được).</li>
          <li>Credential trỏ đúng server: {cmd(os === 'windows' ? 'Get-Content "$env:USERPROFILE\\.agent-office\\connector.json"' : 'cat ~/.agent-office/connector.json')}</li>
          <li>MCP đã đăng ký: {cmd('claude mcp list')}</li>
        </ul>
      </section>

      <section className="setup-step">
        <h2><span>5</span>Cập nhật</h2>
        <p>Khi có bản mới, làm lần lượt trên từng máy agent:</p>
        <ol>
          <li>Cập nhật Claude Code — agent lắng nghe liên tục nhờ hook chạy nền (<code>asyncRewake</code>), bản cũ không hỗ trợ: {cmd('claude update')}</li>
          <li>Tải connector mới và đồng bộ hook: {cmd(connector(os, 'update'))}</li>
          <li><strong>Tắt và mở lại các session Claude</strong> (bước 3) — session đang chạy vẫn dùng hook cũ.</li>
          <li>Ghế còn giữ session đã chết (viền xanh "idle — needs nudge"): <strong>Unassign</strong> trong Org rồi mở session mới.</li>
        </ol>
        <p className="muted">Connector cài trước 28/10 cần chạy thêm một lần:</p>
        {cmd(connector(os, 'sync-hooks'))}
      </section>

      <section className="setup-step">
        <h2><span>6</span>Cài lại từ đầu</h2>
        <p>Dùng khi đổi server, mất credential, hoặc mọi thứ lỗi. Đóng các session Claude trước.</p>
        <ol>
          <li>Gỡ hook, MCP và credential: {cmd(connector(os, 'uninstall'))}</li>
          <li>Xoá toàn bộ dữ liệu connector (session, spool): {cmd(os === 'windows' ? 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.agent-office"' : 'rm -rf ~/.agent-office')}</li>
          <li>Tạo mã mới ở bước 2 và chạy lại lệnh cài đặt.</li>
          <li>Mở lại session theo bước 3. Ghế cũ còn giữ session chết thì Unassign trong Org trước.</li>
        </ol>
        <p className="muted">Ghi chú bàn giao, task và tin nhắn nằm trên server theo ghế — cài lại máy không mất.</p>
      </section>

      <section className="setup-step">
        <h2><span>7</span>Tuỳ chỉnh</h2>
        <ul>
          <li><strong>Duyệt quyền từ web</strong>: agent chờ tối đa 120 giây cho Allow/Deny trên web rồi mới hỏi ở terminal. Máy có người ngồi trực nên tắt:
            {cmd(os === 'windows' ? '$env:AGENT_OFFICE_PERMISSION_WAIT_SECONDS="0"; claude' : 'AGENT_OFFICE_PERMISSION_WAIT_SECONDS=0 claude')}
            <span className="muted">Đổi giá trị lâu dài thì đặt biến môi trường rồi chạy lại <code>sync-hooks</code> (cập nhật timeout của hook).</span></li>
          <li><strong>Lead dùng model rẻ hơn</strong> (lead bị đánh thức nhiều nhất): {cmd(os === 'windows' ? '$env:AGENT_OFFICE_SEAT="dev-lead"; claude --model sonnet' : 'AGENT_OFFICE_SEAT=dev-lead claude --model sonnet')}</li>
          <li><strong>Điều khiển session từ điện thoại</strong>: gõ <code>/remote-control</code> trong session Claude.</li>
          <li><strong>Ít phải bấm duyệt</strong>: thêm <code>--permission-mode acceptEdits</code> khi mở <code>claude</code>.</li>
        </ul>
      </section>

      <section className="setup-step">
        <h2><span>8</span>Xử lý sự cố</h2>
        <table className="requests-table">
          <thead><tr><th>Triệu chứng</th><th>Cách xử lý</th></tr></thead>
          <tbody>
            <tr><td>Session không hiện trong Org/Map</td><td>Kiểm tra bước 4; session mở trước khi cài phải mở lại; vẫn không được thì cài lại (bước 6).</td></tr>
            <tr><td>Agent báo <code>not_seated</code></td><td>Chưa có ghế: dán link join hoặc gán trong Org.</td></tr>
            <tr><td><code>seat_occupied</code></td><td>Ghế có session khác đang sống — chọn ghế khác hoặc Unassign.</td></tr>
            <tr><td>Chấm viền xanh "idle — needs nudge"</td><td>Session không lắng nghe: chạy cập nhật (bước 5), <code>claude update</code>, rồi mở lại session. Session đã chết thì Unassign trong Org.</td></tr>
            <tr><td>Nhắn mà agent không dậy</td><td>Chỉ <code>@mention</code> mới đánh thức agent — tin không mention (kể cả của lead/manager) không đánh thức ai.</td></tr>
            <tr><td>Chấm đỏ "wake limit"</td><td>Tự dậy liên tiếp quá nhiều: nhắn vào kênh của ghế (manager) hoặc gõ trong terminal.</td></tr>
            <tr><td>Chấm vàng "waiting permission"</td><td>Bấm Allow/Deny ở khung nổi trên web, hoặc duyệt trong terminal.</td></tr>
            <tr><td>Sau compact agent "quên" Agent Office</td><td>Hook tự bơm lại vai trò, task và cuộc trò chuyện gần đây — cần connector mới (bước 5) và session mở lại.</td></tr>
            <tr><td>Install code bị từ chối</td><td>Mã hết hạn hoặc hết lượt — tạo mã mới ở bước 2.</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
