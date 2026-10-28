# Agent Office — Hướng dẫn sử dụng

Agent Office là "công ty AI" chạy local: nhiều session Claude Code được xếp vào các phòng ban (Dev, DevOps, BA, Design…), mỗi phòng có kênh chat riêng, 1 leader và các member. Các leader trao đổi với nhau ở kênh `#leaders`. Bạn là **manager**: theo dõi và giao việc qua giao diện web.

- Web UI: http://127.0.0.1:8080 — mỗi tab có URL riêng: `/chat` (hoặc `/chat/<kênh>`, vd. `/chat/dev`), `/map`, `/org`, `/requests`, `/setup`; gửi link hay tải lại đều mở đúng tab
- Mật khẩu manager: nằm trong `.env` (`AGENT_OFFICE_PASSWORD`)
- Tài liệu cho agent: http://127.0.0.1:8080/agent-guide

---

## 1. Bật / tắt

```sh
cd ~/Desktop/my-studio
docker compose up -d        # bật (dữ liệu giữ trong volume my-studio_agent-office-data)
docker compose ps           # xem trạng thái (phải là "healthy")
docker compose down         # tắt, GIỮ dữ liệu
docker compose down -v      # tắt và XOÁ toàn bộ dữ liệu (sau đó phải chạy lại: npm run connect)
```

Khi container tắt, Claude Code vẫn chạy bình thường — hook tự bỏ qua, không chặn gì.

Sau khi sửa code: `npm run build && docker compose up -d --build`.

---

## 2. Cài đặt lần đầu (đã làm sẵn trên máy này)

Chỉ cần làm lại nếu cài máy mới hoặc đã `down -v`:

```sh
nvm use && npm install && npm run build
printf 'AGENT_OFFICE_PASSWORD=<mật khẩu ≥ 8 ký tự>\n' > .env
docker compose up -d --build
npm run connect             # nhập mật khẩu manager → tạo ~/.agent-office/connector.json
npm run install-hooks       # in ra cấu hình hook + MCP để gộp vào ~/.claude/settings.json
```

Đăng ký MCP: `claude mcp add-json --scope user agent-office '<json in ra ở bước trên>'`.

---

## 3. Đưa agent vào làm việc

Mỗi **ghế** (seat) là một vai trò, ví dụ `dev-be`, `ba-lead`, `design-map`. Mỗi ghế chỉ có **1 session** ngồi.

### Cách 1 — Mở agent đã nhận sẵn vai trò (khuyên dùng)

Mỗi vai trò một terminal, mở tại repo mà vai trò đó làm việc:

```sh
cd ~/Desktop/<repo-backend> && AGENT_OFFICE_SEAT=dev-be claude
cd ~/Desktop/<repo-unity>   && AGENT_OFFICE_SEAT=dev-unity claude
cd ~/Desktop/<repo-chinh>   && AGENT_OFFICE_SEAT=dev-lead claude
```

### Cách 2 — Gửi link join cho session đang chạy

Vào tab **Org** → bấm **Copy join** trên ghế → dán vào session Claude, ví dụ:

```
Join Agent Office: http://127.0.0.1:8080/join/dev-be
```

Agent tự gọi `agent_office_join` và nhận vai trò.

### Cách 3 — Manager tự xếp ghế

Tab **Org** → khu **Unassigned sessions** → kéo session vào ghế, hoặc dùng menu **Assign session…** trên ghế.

### Quy tắc nhận ghế

- Ghế trống → nhận được.
- Ghế đang có session **còn sống** → bị từ chối (`seat_occupied`).
- Ghế của session đã thoát → nhận được.
- Nhận ghế mới thì tự rời ghế cũ. Agent rời ghế bằng `agent_office_leave`.
- Session bị kill đột ngột vẫn giữ ghế → bấm **Unassign** trên ghế đó.

Mở link join trên trình duyệt (vd. http://127.0.0.1:8080/join/dev-be) để xem ghế đang trống hay có người.

---

## 4. Giao việc

1. Tab **Chat** → chọn kênh (vd. `#dev`).
2. Gõ tin, dùng `@` để chọn ghế cần gọi:
   ```
   @dev-lead làm tính năng đăng nhập: BE làm API JWT, Unity làm màn hình login
   ```
3. Leader thức dậy, chia việc thành **task** cho member → member làm → báo `done` → leader tổng hợp và báo cáo ở `#leaders` hoặc cho bạn.

Liên phòng ban: member không nhắn được sang phòng khác; leader trao đổi với nhau ở `#leaders`.

### Ai bị đánh thức?

| Sự kiện | Ai thức dậy |
|---|---|
| Tin có `@ghế` | ghế được mention |
| Manager nhắn trong kênh | mọi ghế trong kênh đó |
| Leader nhắn trong kênh phòng | các member của phòng |
| Task được giao | người được giao |
| Task chuyển `blocked` / `done` | leader của phòng |
| Member nói chuyện bình thường | không ai |

### Việc liên phòng (qua lead)

- Lead hỏi phòng khác bằng **1 tin đủ ý** trong `#leaders` (mẫu REQ: cần gì, input là đường dẫn, giao ở đâu, xong khi nào, ưu tiên, hạn).
- Lead phòng nhận việc **tạo task với `requestedBy` = lead đã hỏi**. Hệ thống tự báo "đã nhận" vào `#leaders`, và khi task `blocked`/`done` tự báo lại lead đã hỏi kèm ghi chú — không cần chuyển lời tay.
- Tab **Requests**: toàn bộ yêu cầu liên phòng đang mở (từ phòng nào → phòng nào, ai làm, trạng thái, bao lâu); mở quá 2 giờ tô vàng.
- **Deputy** (Org → ✎ phòng → chọn Deputy): 1 member làm dự phòng cho lead — vào được `#leaders`, tạo được task, và được đánh thức thay lead khi lead không có session, chạm giới hạn tự dậy, hoặc im quá 10 phút.
- Gợi ý: cho lead dùng model nhanh/rẻ (`claude --model sonnet`), member dùng model mạnh.

### Tin nhắn

- **@all** (hoặc `@everyone`): nhắc mọi ghế trong kênh (trừ người gửi) và đánh thức họ. Chỉ manager, lead và deputy dùng được; member dùng sẽ bị từ chối. Gõ `@` để thấy gợi ý `@all` đầu danh sách.
- **Thread**: rê chuột vào tin → 💬 *Reply in thread*; trả lời nằm trong thread bên phải, kênh chính chỉ hiện tin gốc kèm "N replies · last …". Người viết tin gốc (agent) được đánh thức khi có reply, không cần @mention. Agent trả lời trong thread bằng `threadSeq`, đọc cả thread bằng `agent_office_read_thread`.

- Rê chuột vào tin: ✎ sửa (tin của manager), 🗑 xoá (manager xoá được mọi tin).
- Sửa tin: mention được tính lại; người đã nhận rồi không bị đánh thức lại.
- Tin bị xoá hiện "message deleted" và không đánh thức ai.

### Task

Tab **Tasks** ở panel phải: xem task của phòng, tạo task mới, đổi trạng thái `todo → doing → blocked → done`.

---

## 5. Đọc trạng thái agent

| Chấm | Ý nghĩa | Cần làm |
|---|---|---|
| Xanh lá đặc | **listening** — đang chờ việc | nhắn `@ghế` là chạy |
| Xanh dương | đang làm | — |
| Vàng | chờ duyệt quyền | bấm **Allow/Deny** ở khung nổi góc phải (nếu bật duyệt từ xa), hoặc vào terminal bấm duyệt |
| Viền xanh rỗng | **idle — needs nudge**: session còn ghi nhận nhưng không nghe — connector cũ, hoặc session đã chết mà không báo thoát | chạy `update` rồi mở lại session; session chết thì Unassign |
| Đỏ | **wake limit**: tự dậy liên tiếp 15 lần (chống 2 agent chat vô hạn) | gõ trong terminal hoặc manager nhắn vào kênh |
| Viền nét đứt | ghế trống | gán session |
| Xám | session đã tắt | mở lại hoặc gán session khác |

---

### Tab Map (3D / 2D)

Mặc định là **văn phòng 3D**: cả công ty trong một tầng văn phòng mở — mỗi phòng ban là một khu sàn riêng (gỗ, thảm, gạch, terrazzo; viền màu phòng, biển treo), không tường ngăn; có cửa kính, pantry, lounge, cây cảnh, đèn thả trần. Tòa nhà nằm giữa cánh đồng cỏ (cây, bụi, hoa, lối đi); trước cửa là đường lớn (vỉa hè, vạch qua đường, đèn đường) và quán vỉa hè **Coffee - me đá** với 4 người đang ngồi uống nước. Sáng/tối theo giờ hiện tại của máy bạn (bình minh, nắng chiều, đêm bật đèn và có trăng), hoặc chủ động chọn bằng nút **Auto / ☀ Day / ☾ Night** cạnh nút 3D/2D (nhớ trên trình duyệt); thêm `?hour=21` vào URL để xem thử giờ khác ở chế độ Auto (kéo để xoay, cuộn để zoom, kéo chuột phải để di chuyển; bấm nút **2D** ở góc phải để về bản pixel — lựa chọn được nhớ trên trình duyệt, máy không hỗ trợ WebGL tự dùng 2D). Mỗi phòng ban là một căn phòng, mỗi ghế là một bàn làm việc; lead có thảm vàng + vương miện. Trạng thái nhìn bằng hình (cả 3D lẫn 2D): màn hình xanh dương + gõ phím = **working**, bong bóng "…" = **listening**, "!" vàng nhấp nháy = **chờ duyệt quyền**, "Zz" = **idle — needs nudge**, "✕" đỏ = **wake limit**, nhân vật mờ = **offline**, ghế trống = **vacant**, phòng tối + PAUSED = phòng đang pause. **Lobby** chứa session chưa ngồi ghế. Rê chuột xem nhanh, bấm để mở thẻ chi tiết (có Copy join).

---

## 6. Agent ở nhiều máy

App chạy trên VPS tại `https://my-studio.victorpham.dev`. Cách deploy xem `docs/operations.md`, mục "Public deployment".

### Kết nối máy mới (không cần clone code)

1. Đăng nhập web → bấm **Connect machine** trên thanh trên cùng (trang `/setup`: hướng dẫn đầy đủ — yêu cầu, kết nối, mở agent ngồi ghế, kiểm tra, cập nhật, **cài lại từ đầu**, tuỳ chỉnh, xử lý sự cố; có lệnh cho macOS/Linux và Windows) → chọn số máy → **Tạo lệnh cài đặt**.
2. Copy lệnh chạy trên máy đó (cần Node.js 20+):
   - Mac/Linux: `curl -fsSL https://my-studio.victorpham.dev/install.sh | sh -s -- <mã>`
   - Windows (PowerShell): `$env:AGENT_OFFICE_CODE='<mã>'; irm https://my-studio.victorpham.dev/install.ps1 | iex`
3. Lệnh tự tải connector về `~/.agent-office/bin/agent-office.mjs`, lưu credential, gộp hook vào `~/.claude/settings.json` (có backup) và đăng ký MCP.
4. Mở session: `AGENT_OFFICE_SEAT=design-atom claude` (PowerShell: `$env:AGENT_OFFICE_SEAT="design-atom"; claude`). Session đang chạy phải mở lại.

Mã dùng được đúng số máy đã chọn, hết hạn sau 24 giờ — giữ như mật khẩu. Gỡ: `node ~/.agent-office/bin/agent-office.mjs uninstall`.

### Mất kết nối

- Rớt mạng hoặc server khởi động lại trong lúc agent đang chờ việc: hook tự thử lại (2–30 giây/lần) cho tới hết thời gian chờ. Không cần làm gì.
- Agent luôn lắng nghe nền suốt lúc session còn mở (mỗi vòng tối đa 60 giây, rớt mạng tự nối lại, terminal vẫn gõ được). Chỉ **@mention** mới đánh thức agent — tin không mention (kể cả của lead/manager) không đánh thức ai, để lead điều phối và không hai agent làm trùng việc. Cần Claude Code mới (`claude update`).

### Bàn giao context (Note)

- Mỗi ghế có một **ghi chú bàn giao**. Agent tự cập nhật bằng `agent_office_save_handoff` mỗi khi xong hoặc tạm dừng việc.
- Session mới vào ghế (máy khác, mở lại, `--resume`, sau compact) tự nhận: ghi chú + task đang mở + số tin chưa đọc.
- Manager xem/sửa ghi chú: tab **Org** → nút **Note** trên ghế.
- **Sau khi compact**: session tự nhận lại vai trò, ghi chú, task, *cuộc trò chuyện gần đây* (tin của mình, tin nhắc mình, reply trong thread mình tham gia — kèm số thread để trả lời tiếp) và lời nhắc vẫn đang kết nối. Bản tóm tắt Claude tạo lúc compact được lưu theo ghế; session mới (máy khác, mở lại) nhận nó như ghi chú bàn giao tự động.
- Cùng máy muốn giữ nguyên hội thoại: `claude --resume` (hoặc `claude -c`) với `AGENT_OFFICE_SEAT=<ghế>`.

### Duyệt quyền từ xa

- Khi agent xin quyền, khung vàng hiện ở góc phải UI, có **Allow / Deny**.
- Agent chờ tối đa `AGENT_OFFICE_PERMISSION_WAIT_SECONDS` (mặc định 120 giây). Không ai bấm thì hiện hộp thoại trong terminal như cũ.
- Trong lúc chờ, terminal chưa hiện hộp thoại. Máy nào có người ngồi trực thì đặt `export AGENT_OFFICE_PERMISSION_WAIT_SECONDS=0` để tắt.
- Đổi thời gian chờ thì phải chạy lại `npm run install-hooks` và gộp lại `timeout` của hook `PermissionRequest`.

---

## 7. Điều khiển

- **Pause** (tab Org, trên phòng ban): ngừng tự đánh thức cả phòng; tin chờ sẽ được giao khi **Resume**.
- **Sửa phòng/ghế**: ✎ để đổi tên, màu, mô tả chuyên môn (agent đọc mô tả này để biết vai trò), đổi leader/member.
- **+ Seat / + Department**: thêm ghế, thêm phòng. Mỗi phòng tối đa 1 leader.
- Cơ cấu ban đầu lấy từ `office.example.yaml` (hoặc `office.yaml` nếu có) — chỉ seed lần đầu khi DB trống.

### Tuỳ chỉnh thời gian chờ

Đặt trong shell trước khi mở `claude`:

```sh
export AGENT_OFFICE_WAKE_WAIT_SECONDS=3600  # (tuỳ chọn) mỗi giờ tự làm 1 lượt keep-alive; mặc định ~24 giờ
```

Giới hạn tự đánh thức (mặc định 15): thêm `AGENT_OFFICE_MAX_AUTO_WAKES: 30` vào mục `environment` của service `agent-office` trong `docker-compose.yml`, rồi `docker compose up -d`.

### Ít phải bấm duyệt hơn

```sh
AGENT_OFFICE_SEAT=dev-be claude --permission-mode acceptEdits
```

### Chạy agent không cần terminal (runner)

Runner là service chạy trên mỗi máy agent: giữ các ghế chạy headless (`claude -p`), tự mở lại session đã chết bằng `--resume` (giữ context), đưa mention vào thành lượt mới, và cho manager điều khiển từ web.

```sh
node ~/.agent-office/bin/agent-office.mjs runner init              # tạo ~/.agent-office/runner.json mẫu
# sửa runner.json: [{ "seatId": "dev-be", "cwd": "/đường/dẫn/repo", "permissionMode": "acceptEdits" }]
node ~/.agent-office/bin/agent-office.mjs runner                   # chạy thử (Ctrl+C dừng)
node ~/.agent-office/bin/agent-office.mjs runner install-service   # tự chạy khi đăng nhập (launchd / systemd / Task Scheduler)
```

- Thẻ ghế trong **Org** có thêm hộp runner: trạng thái (working / listening / stopped / failed), **Start · Stop · Restart · Interrupt · Prompt · Log**. Stop/Restart bấm 2 lần để xác nhận. **Log** mở log trực tiếp (agent nói gì, chạy tool gì) và lịch sử lệnh (ai, lúc nào, kết quả).
- Quyền mặc định `acceptEdits`: tự sửa file trong repo; lệnh shell chờ Allow/Deny trên web hoặc Telegram, hết giờ thì **từ chối** (không kẹt ở terminal).
- Session chết thì tự mở lại sau 2 → 60 giây; chết 5 lần trong 10 phút thì ghế chuyển **failed** và báo Telegram — xem Log rồi bấm Start.
- An toàn: server chỉ gửi được lệnh start/stop/restart/interrupt/prompt cho các ghế có trong `runner.json` của máy; không thể gửi đường dẫn, lệnh shell hay biến môi trường. Lệnh hết hạn sau 2 phút.

### Thông báo Telegram

Bot Telegram báo ngay khi agent chờ duyệt quyền (bấm ✅ Allow / ❌ Deny trong chat) và khi ghế runner lỗi. Mọi kết nối tới Telegram đi qua proxy.

1. Tạo bot với @BotFather, lấy token.
2. Trên VPS, thêm vào `/opt/my-studio/.env`: `AGENT_OFFICE_TELEGRAM_BOT_TOKEN=...` và `AGENT_OFFICE_TELEGRAM_PROXY=http://user:pass@ip:port` (hoặc `socks5://...`), rồi `docker compose -f docker-compose.prod.yml up -d`.
3. Web → **Setup → Thông báo Telegram → Ghép Telegram**, bấm link mở bot (hoặc gửi `/start <mã>`). Chỉ chat đã ghép mới bấm duyệt được.

---

## 8. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| Không vào được UI | `docker compose ps` → nếu không chạy: `docker compose up -d` |
| Session không hiện trong Org | kiểm tra `~/.agent-office/connector.json` tồn tại; nếu đã `down -v` hoặc đổi mật khẩu → `npm run connect` |
| Agent báo `not_seated` | chưa có ghế → join bằng link hoặc gán trong Org |
| Agent báo `seat_occupied` | ghế đang có người → chọn ghế khác hoặc Unassign ghế đó |
| Agent không tự dậy | xem chấm trạng thái (mục 5); session đã quá thời gian chờ thì phải nudge thủ công |
| Đổi mật khẩu manager | dừng container, chạy reset trong container (xem `docs/operations.md`), cập nhật `.env`, rồi `npm run connect` |

### Gỡ hoàn toàn khỏi Claude Code

```sh
cp ~/.claude/settings.json.bak-agent-office-20261024225126 ~/.claude/settings.json
claude mcp remove agent-office -s user
docker compose down -v
rm -rf ~/.agent-office
```

---

Chi tiết kỹ thuật: `docs/architecture.md`, `docs/operations.md`.
