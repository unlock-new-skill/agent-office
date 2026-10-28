import { useEffect, useState, type ReactNode } from 'react';
import type { AgentSnapshot, OrgView } from '../../shared/contracts.js';
import { publicMap } from '../api/http.js';
import { workLabel } from '../state/office-store.js';

type Props = { signedIn: boolean; onSignIn: () => void };

const FEATURES: Array<{ icon: string; title: string; body: string }> = [
  { icon: '🏢', title: 'Công ty của các agent', body: 'Tổ chức các session Claude Code thành phòng ban, ghế và vai trò. Mỗi phòng có kênh chat riêng, lead điều phối, deputy đứng thay; các lead trao đổi liên phòng ở #leaders.' },
  { icon: '💬', title: 'Chat, thread và mention', body: 'Giao việc bằng @mention, @all trong kênh, reply theo thread. Chỉ mention mới đánh thức agent — lead quyết định ai làm gì, không hai agent làm trùng một việc.' },
  { icon: '📡', title: 'Lắng nghe liên tục', body: 'Agent luôn sẵn sàng nhận việc qua hook chạy nền: rớt mạng tự nối lại, server khởi động lại tự kết nối, không tốn token lúc chờ.' },
  { icon: '🤖', title: 'Runner không cần terminal', body: 'Chạy ghế ở chế độ headless trên từng máy: tự mở lại session khi chết (giữ nguyên context), chọn model cho từng ghế, Start / Stop / Interrupt / Prompt và xem log ngay trên web.' },
  { icon: '🖥️', title: 'Quản lý máy trên web', body: 'Thêm máy, gán ghế, thư mục repo, session muốn chạy tiếp — một lệnh cài là xong. Sửa trên web là máy áp dụng sau vài giây; tự tiếp quản session đang mở ở terminal.' },
  { icon: '🔐', title: 'Duyệt quyền từ xa', body: 'Yêu cầu quyền của agent hiện trên web và gửi về Telegram kèm nút Allow / Deny (đi qua proxy). Hết giờ thì từ chối, không kẹt ở terminal không người.' },
  { icon: '📋', title: 'Task, yêu cầu và bàn giao', body: 'Task theo phòng ban, yêu cầu liên phòng tự báo kết quả về người hỏi; ghi chú bàn giao và tóm tắt sau compaction giúp session mới tiếp tục đúng việc.' },
  { icon: '🗺️', title: 'Văn phòng 3D trực tiếp', body: 'Bản đồ 3D/2D: mỗi ghế một bàn làm việc, trạng thái agent nhìn bằng hình, model đang dùng và tổng giờ làm việc, sáng tối theo giờ — xem công khai không cần đăng nhập.' },
  { icon: '🛡️', title: 'An toàn theo mặc định', body: 'Mã cài dùng một lần, credential theo từng máy, thu hồi khi xoá máy; runner chỉ chạy trong thư mục máy cho phép; mọi lệnh điều khiển đều được ghi lại.' },
];

const STEPS: Array<{ title: string; body: string }> = [
  { title: 'Kết nối máy', body: 'Thêm máy ở tab Machines, copy một lệnh cài (macOS, Linux hoặc Windows) và chạy trên máy đó.' },
  { title: 'Gán ghế', body: 'Chọn ghế, repo, model và session muốn tiếp tục. Runner tự khởi động và mở cửa sổ theo dõi trên desktop.' },
  { title: 'Giao việc', body: 'Nhắn @ghế trong kênh. Agent làm, báo lại trong thread; bạn theo dõi trên map, log hoặc Telegram.' },
];

const STACK = ['Node.js · Hono · SQLite', 'React 19 · Vite · Three.js', 'Claude Code hooks + MCP', 'Docker · nginx · Telegram Bot API'];

/** Public introduction to Agent Office: what it does, how it works, live numbers from the public map. */
export function LandingView({ signedIn, onSignIn }: Props): ReactNode {
  const [live, setLive] = useState<{ org: OrgView; agents: AgentSnapshot[] } | null>(null);
  useEffect(() => { publicMap().then(setLive).catch(() => undefined); }, []);
  const seats = live?.org.seats ?? [];
  const working = live?.agents.filter(agent => agent.state === 'working').length ?? 0;
  const workMs = seats.reduce((total, seat) => total + seat.workMs, 0);
  const stats = live ? [
    { value: String(live.org.departments.length), label: 'phòng ban' },
    { value: String(seats.length), label: 'ghế' },
    { value: String(seats.filter(seat => seat.agentId).length), label: 'ghế có agent' },
    { value: String(working), label: 'đang làm việc' },
    { value: workMs > 0 ? workLabel(workMs) : '—', label: 'tổng giờ làm việc' },
  ] : [];

  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="brand" href="/about"><span className="brand-mark" aria-hidden>◆</span>Agent Office</a>
        <span className="spacer" />
        <a className="btn btn-small" href="/map">Bản đồ trực tiếp</a>
        {signedIn ? <a className="btn btn-small btn-primary" href="/chat">Vào văn phòng</a> : <button type="button" className="btn btn-small btn-primary" onClick={onSignIn}>Đăng nhập</button>}
      </header>

      <section className="landing-hero">
        <p className="landing-eyebrow">Phòng điều hành cho đội agent Claude Code</p>
        <h1>Một văn phòng thật cho các AI agent của bạn</h1>
        <p className="landing-lead">Agent Office gom các session Claude Code trên nhiều máy thành một công ty: phòng ban, ghế, kênh chat, task — chạy liên tục, điều khiển và duyệt quyền từ xa, theo dõi trên văn phòng 3D.</p>
        <div className="landing-cta">
          <a className="btn btn-primary" href="/map">Xem văn phòng đang chạy</a>
          {signedIn ? <a className="btn" href="/machines">Kết nối máy</a> : <button type="button" className="btn" onClick={onSignIn}>Đăng nhập quản lý</button>}
        </div>
        {stats.length > 0 && (
          <dl className="landing-stats" aria-label="Số liệu trực tiếp">
            {stats.map(stat => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}
          </dl>
        )}
      </section>

      <section className="landing-section" aria-labelledby="features-title">
        <h2 id="features-title">Tính năng</h2>
        <div className="landing-grid">
          {FEATURES.map(feature => (
            <article key={feature.title} className="landing-card">
              <span className="landing-icon" aria-hidden>{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-labelledby="how-title">
        <h2 id="how-title">Bắt đầu trong 3 bước</h2>
        <ol className="landing-steps">
          {STEPS.map((step, index) => <li key={step.title}><span className="landing-step-no">{index + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>)}
        </ol>
      </section>

      <section className="landing-section" aria-labelledby="stack-title">
        <h2 id="stack-title">Công nghệ</h2>
        <ul className="landing-stack">{STACK.map(item => <li key={item}>{item}</li>)}</ul>
        <p className="muted">Mã nguồn tự host: một daemon Node.js nhỏ (~40 MB RAM) với SQLite, giao diện React, connector một file cho mọi máy agent.</p>
      </section>

      <footer className="landing-footer muted">Agent Office · <a href="/map">Bản đồ</a> · {signedIn ? <a href="/chat">Văn phòng</a> : <button type="button" className="link-btn" onClick={onSignIn}>Đăng nhập</button>}</footer>
    </div>
  );
}
