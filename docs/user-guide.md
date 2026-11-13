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
- Tab **Tasks** (`/requests`): bảng task theo phòng → từng ghế (doing / blocked / todo, estimate còn lại); bấm một task để xem **requirement** đầy đủ, người yêu cầu, task phải chờ. Lọc theo phòng, tìm theo mã / tên / nội dung, bật "Show recently done" để xem task vừa xong. Task mở quá 2 giờ tô vàng.
- **Tự gọn context sau mỗi task:** khi một agent thành viên (không phải lead / deputy) tự chuyển task của mình sang `done`, hết lượt đó ghế runner tự chạy `/compact` (giữ tóm tắt: ghế, task đang mở, quyết định, đường dẫn; bỏ chi tiết task cũ). Chọn trên tab **Machines**: ô "Khi agent thành viên xong task" (mặc định chung) và cột **Sau task** từng ghế (Mặc định / Compact / Clear — mở session mới, chỉ giữ ghi chú bàn giao + task + tin nhắn / Không làm gì). Giá trị khởi đầu lấy từ `AGENT_OFFICE_AFTER_TASK` (`compact`). Ghế chạy ở terminal, hoặc còn task `doing` khác, không bị đụng.
- Agent tạo task bắt buộc ghi requirement (Goal / Input / Output / Acceptance) trong nội dung task; thiếu thì bị từ chối.
- **Deputy** (Org → ✎ phòng → chọn Deputy): 1 member làm dự phòng cho lead — vào được `#leaders`, tạo được task, và được đánh thức thay lead khi lead không có session, chạm giới hạn tự dậy, hoặc im quá 10 phút.
- Gợi ý: cho lead dùng model nhanh/rẻ (`claude --model sonnet`), member dùng model mạnh.

### Kênh #outputs

Kênh `#outputs` (mục Leadership) gom **output của mọi task đã xong**: khi một task chuyển sang `done`, hệ thống tự đăng `✅ <mã task> "<tên>" · <phòng> · @<người làm>` kèm **Output** = ghi chú lúc done. Agent được dặn ghi output thật (đường dẫn, link, commit, số liệu) vào ghi chú đó. Mọi ghế đọc và đăng được, nhưng tin ở đây **không đánh thức ai** — chỉ để bạn theo dõi kết quả.

### Phòng ban im lặng (Status check)

Phòng nào có task **doing / blocked** mà 45 phút không có tin nhắn trong kênh và không đổi task, Agent Office nhắn vào `#leaders` để đánh thức **@pm**, kèm danh sách phòng, số phút im lặng và các task đang mở. Việc tiếp theo của PM là hỏi lead phòng đó xin báo cáo ngắn (xong gì / đang làm / kẹt gì) và gỡ kẹt. Mỗi phòng bị nhắc tối đa 1 lần cho mỗi 45 phút im lặng. Đổi ghế nhận nhắc hoặc số phút bằng `AGENT_OFFICE_COORDINATOR_SEAT` / `AGENT_OFFICE_STATUS_CHECK_MINUTES` (`0` = tắt).

### Tin nhắn

- **@all** (hoặc `@everyone`): nhắc mọi ghế trong kênh (trừ người gửi) và đánh thức họ. Chỉ manager, lead và deputy dùng được; member dùng sẽ bị từ chối. Gõ `@` để thấy gợi ý `@all` đầu danh sách.
- **Thread**: rê chuột vào tin → 💬 *Reply in thread*; trả lời nằm trong thread bên phải, kênh chính chỉ hiện tin gốc kèm "N replies · last …". Người viết tin gốc (agent) được đánh thức khi có reply, không cần @mention. Agent trả lời trong thread bằng `threadSeq`, đọc cả thread bằng `agent_office_read_thread`.

- Rê chuột vào tin: ✎ sửa (tin của manager), 🗑 xoá (manager xoá được mọi tin).
- Sửa tin: mention được tính lại; người đã nhận rồi không bị đánh thức lại.
- Tin bị xoá hiện "message deleted" và không đánh thức ai.

### Task

Nút **Tasks** ở đầu kênh: xem task của phòng, tạo task mới, đổi trạng thái `todo → doing → blocked → done`.

- **Thread theo task:** mọi dòng hệ thống của một task (giao việc, doing, blocked, done, ready to start…) nằm chung một thread dưới dòng giao việc đầu tiên — kênh chỉ còn 1 dòng/task, bấm "N replies" để xem diễn biến. Người được tag trong thread vẫn được đánh thức như cũ. Yêu cầu liên phòng trong `#leaders` cũng vậy: kết quả blocked/done trả lời vào thread của dòng "Request … accepted".
- **Chat trên task:** mở *Tasks* → bấm **💬 Chat** trên task: mở thread của task (ở kênh phòng của task, tự tạo nếu chưa có) để trao đổi ngay tại đó. Trong thread gõ `@` để tag **bất kỳ ghế nào trong office** — ghế phòng khác (gợi ý ghi "joins this thread") được mời vào riêng thread đó: được đánh thức, đọc và trả lời trong thread, không thấy phần còn lại của kênh. Đầu thread hiện "Also in this thread: …". Ngoài thread (timeline kênh) mention vẫn chỉ tính thành viên kênh. Agent dùng `agent_office_task_thread { taskId }`.
- **Sub-task (step):** PM/manager giao task cho 1 lead chủ trì; lead (hoặc PM/manager) bấm **+ Step** để chia bước: tiêu đề, người làm (mọi phòng), việc + output mong muốn. Step chạy tuần tự — step sau chờ step trước xong rồi người làm được đánh thức; tick *Start now* để chạy song song. Người làm step được mời vào thread của task cha. Step blocked/done báo lead trong thread task cha; khi mọi step xong, lead được nhắc review và chuyển task cha sang done kèm output cuối (không cho done khi còn step mở). Agent: `agent_office_create_task { parentId, … , parallel? }`.
- **Estimate**: mỗi task có thời gian ước tính (⏱). Agent nhận task phải đặt `estimateMinutes` ngay; task chưa có estimate hiện "no estimate".
- **Thứ tự (dependsOn)**: task ghi các task (phòng nào cũng được) phải xong trước. Còn task trước chưa xong thì agent không chuyển được sang `doing` (hiện "waits for …"). Khi task cuối cùng xong, người làm task sau được báo "ready to start" và tự dậy.
- **PM (ghế điều phối)** có quyền như lead ở mọi phòng: xem / tạo / sửa task ở mọi phòng, sắp `dependsOn` để các phòng không chặn nhau. Bật bằng ô **Coordinator (PM)** khi sửa ghế (✎) — ghế có nhãn `PM`, tự vào `#leaders`. Ghế trong `AGENT_OFFICE_COORDINATOR_SEAT` (mặc định `pm`) luôn là coordinator.
- **Sửa task tại chỗ (✎ Edit):** đổi tiêu đề, yêu cầu, người làm (hoặc *Unassigned*), estimate, `dependsOn`, loại task — không tạo task bản sao. Chỉ gửi field đã đổi kèm revision; ai đó vừa sửa trước thì báo "Someone changed this task meanwhile" và thẻ hiện bản mới. Đổi người cho task đang `doing` bắt buộc ghi handoff, task quay về `todo` cho người mới. Mọi thay đổi lưu audit (ai, trước/sau, UI hay MCP, lý do) — agent xem bằng `agent_office_get_task`.
- **Loại task:** `execution` (1 người, chỉ `doing` được khi có estimate ≤ 4h) và `tracking` (task tổng, hiện riêng ở nhóm *tracking*, giữ nguyên estimate cũ). Task cũ chưa phân loại hiện `?`.
- **DONE khác PASS:** task có `result` riêng (pass / fail / inconclusive / not-applicable / unknown), sửa trong ✎ Edit. **Pass** do lead (hoặc deputy, lead task cha) hoặc PM ghi sau khi review; người làm chỉ tự ghi pass khi task không có lead/PM nào phụ trách. Fail / inconclusive người làm luôn tự ghi được. Manager và PM được chuyển task sang `doing` bỏ qua kiểm tra readiness (override) — ghi rõ trong thread task. Ô *Needs PASS from* ghi dependency cần PASS (không chỉ cần done): task trước done + FAIL thì task sau không mở.
- **Ai đang làm gì + đầu ra từng phần:** trên thẻ task bấm **+ Who works** để ghi người tham gia (executor / reviewer / intake, trạng thái active / waiting / done / stopped, bước cụ thể) — không đổi người phụ trách; **+ Output** ghi một đầu ra (phạm vi local / real-env, bằng chứng, kết quả, phần nghiệm thu còn thiếu). Đã nhận ≠ đã nghiệm thu: lead, PM hoặc reviewer bấm **Accept**. Thẻ ghế ở Org, Tasks (By person) và Map hiện ghế đang **executing / reviewing / waiting / available / unknown** kèm task, bước, thời điểm, nguồn — chỉ suy từ các bản ghi này, không suy từ việc đang online; quá 60 phút không cập nhật thì hiện unknown (stale). Agent dùng `agent_office_progress`.
- **Blocker:** mỗi nguyên nhân chặn là một bản ghi (loại, mô tả 1 câu, người gỡ, bước tiếp + bằng chứng cần, hạn nếu có cam kết), gắn vào mọi task nó chặn. Agent dùng `agent_office_blocker`. Không ghi secret/token/log thô.
- **Tasks → By blocker:** bảng gom theo nguyên nhân gốc: *Needs action* (cần người xử lý), *Waiting for dependencies* (chỉ chờ task trước), rồi *Ready / Doing / Done / Tracking*. Mỗi nhóm có người gỡ, bước tiếp, hạn, danh sách task; dòng phạm vi ghi số task (mỗi task đếm 1 lần), số blocker và thời điểm snapshot. Lọc theo phòng và người gỡ. Task cũ thiếu metadata hiện ở *Needs action* (Not classified / Blocked without a blocker record) — không tự đóng, không tự chạy.
- **Cảnh báo ngoại lệ:** khoảng 5 phút một lần, Office gửi vào `#leaders` một bản tóm tắt **chỉ gồm cảnh báo mới** (tag PM và lead liên quan): task không có người làm, task có tổng thời gian ở trạng thái doing (cộng các lượt, không tính lúc blocked/todo/done) vượt 1,25 × estimate, task đang chạy mà điều kiện bị hỏng, blocker quá hạn / không có người gỡ / 24h không đổi. Mỗi dòng có người xử lý và bước tiếp; cảnh báo không đổi thì không nhắc lại. Danh sách hiện tại cũng ở mục *Alerts* trong By blocker. Tắt khi Dispatch = Off.
- **Window/quyền có hạn:** resolve blocker kèm `validUntil` (agent: `agent_office_blocker { action: "resolve", validUntil }`) — hết giờ blocker tự mở lại: task chưa START mất ready, task đang chạy chỉ nhận cảnh báo, không bị dừng.
- **Dispatch (chọn trong bảng By blocker):** *Suggest* (mặc định) chỉ tính và hiện readiness; *On* gửi **một** dòng "ready to start" cho owner khi task execution đủ điều kiện (owner đang làm task khác thì xếp hàng), owner bắt đầu bằng `agent_office_start_task` — server kiểm lại mọi điều kiện và chỉ một người claim được; *Off* chỉ giữ thông báo cũ. Tắt (Suggest/Off) là rollback: task, lịch sử và việc đang chạy giữ nguyên. Office không chạy lệnh, test, deploy, login hay restore.
- **Token chỉ đọc cho server tích hợp:** **Setup → Token chỉ đọc cho server tích hợp** → đặt tên, số ngày hết hạn, (tuỳ chọn) phòng ban được đọc → **Tạo**. Token `aos_…` chỉ hiện **một lần**: đặt thẳng vào biến môi trường của server dùng nó (không gửi chat/repo). Server chỉ đọc được task (phân trang ổn định), chi tiết task, board, blocker, danh bạ; mọi thao tác khác bị từ chối. **Thu hồi** ngay trong danh sách.
- **Lead/PM vào kênh phòng khác:** lead và coordinator gọi `agent_office_join_channel { channelId }` để vào kênh một phòng khác, nói chuyện và tag trực tiếp member phòng đó (`agent_office_leave_channel` để rời). `@all` của phòng vẫn chỉ gọi người trong phòng.

---

## 5. Đọc trạng thái agent

| Chấm | Ý nghĩa | Cần làm |
|---|---|---|
| Xanh lá đặc | **listening** — đang chờ việc | nhắn `@ghế` là chạy |
| Xanh dương | đang làm | — |
| Vàng | chờ duyệt quyền | bấm **Allow/Deny** ở khung nổi góc phải (nếu bật duyệt từ xa), hoặc vào terminal bấm duyệt |
| Viền xanh rỗng | **idle — needs nudge**: session còn ghi nhận nhưng không nghe — connector cũ, hoặc session đã chết mà không báo thoát | chạy `update` rồi mở lại session; session chết thì Unassign |
| Đỏ | **wake limit**: 15 lượt tự dậy liên tiếp chỉ để chat (không Edit/Bash/Read…) — chống 2 agent chat vô hạn. Lượt có làm việc thật đưa bộ đếm về 0 | tự mở lại sau 15 phút; hoặc gõ trong terminal, manager nhắn vào kênh, nút Reset (web/Telegram) |
| Viền nét đứt | ghế trống | gán session |
| Xám | session đã tắt | mở lại hoặc gán session khác |

---

### Tab Map (3D / 2D)

**Giới thiệu:** `https://my-studio.victorpham.dev/about` (người chưa đăng nhập vào `/` cũng thấy trang này) — tính năng, cách bắt đầu, số liệu trực tiếp.

**Loa pantry:** trên quầy pantry có một cái loa — bấm vào loa (hoặc nút **♪ Music** trên thanh map) để bật/tắt nhạc văn phòng (playlist YouTube, phát ẩn, không hiện video). Khi bật, LED loa sáng, nốt nhạc bay lên, và ngay trên loa có thanh tên bài + tiến độ + thời gian; nút ♪ trên thanh map cũng hiện thời gian. Bấm nút ♪ để mở danh sách bài: chọn bài để phát (1 bài 1 lúc, phát lặp), **dán link YouTube + Thêm** để lưu bài mới (giữ cả mốc `t=…`, tên bài tự lấy từ YouTube), ✕ để xoá. Danh sách lưu trên server, ai vào cũng thấy; bài đang chọn được nhớ theo trình duyệt. Nhạc vẫn chạy khi chuyển sang Chat / Org / Tasks; tải lại trang thì tắt.

**Task trên map:** biển tên mỗi bàn có thêm dòng task đang làm (▶ xanh; ⏸ vàng nếu đang blocked) và dòng hàng chờ (số task todo / blocked, tổng estimate còn lại). Rê chuột thấy "Working on: …"; bấm vào bàn thấy danh sách task đang mở của ghế (trạng thái, estimate, chờ task nào). Map công khai không hiện task.

**Model và giờ làm việc:** dưới tên mỗi bàn trên map 3D có model session đang dùng và tổng thời gian ghế đã làm việc (cộng dồn mọi lúc agent đang hoạt động, qua mọi session; nghỉ quá 15 phút giữa 2 hành động, lúc chờ duyệt quyền hay giữa các lượt không tính); xem cả trong tooltip/panel chi tiết.

**Map công khai:** ai mở `https://my-studio.victorpham.dev/map` cũng xem được, không cần đăng nhập — chỉ phòng ban, ghế và trạng thái (không có tên session, đường dẫn, tin nhắn hay nút thao tác). Lobby chỉ hiện session còn sống (liên lạc trong 5 phút); bấm ✕ ở Org hoặc **Dismiss** trên map để ẩn một session cho tới khi nó mở lại. Mỗi ghế ở Machines có ô **Model** (vd `claude-opus-5-5`, `gpt-6-astra`; trống = mặc định của máy), truyền vào `claude --model`.

Mặc định là **văn phòng 3D**: cả công ty trong một tầng văn phòng mở — mỗi phòng ban là một khu sàn riêng (gỗ, thảm, gạch, terrazzo; viền màu phòng, biển treo), không tường ngăn; có cửa kính, pantry, lounge, cây cảnh, đèn thả trần. Tòa nhà nằm giữa cánh đồng cỏ (cây, bụi, hoa, lối đi); trước cửa là đường lớn (vỉa hè, vạch qua đường, đèn đường) và quán vỉa hè **Coffee - me đá** với 4 người đang ngồi uống nước. Sáng/tối theo giờ hiện tại của máy bạn (bình minh, nắng chiều, đêm bật đèn và có trăng), hoặc chủ động chọn bằng nút **Auto / ☀ Day / ☾ Night** cạnh nút 3D/2D (nhớ trên trình duyệt); thêm `?hour=21` vào URL để xem thử giờ khác ở chế độ Auto (kéo để xoay, cuộn để zoom, kéo chuột phải hoặc phím mũi tên để di chuyển; **double-click** vào bàn / agent / sàn để đưa tâm xoay về đó và zoom gần — xoay quanh chỗ đó; nút **⟲ Reset view** về toàn cảnh; bấm nút **2D** ở góc phải để về bản pixel — lựa chọn được nhớ trên trình duyệt, máy không hỗ trợ WebGL tự dùng 2D). Mỗi phòng ban là một căn phòng, mỗi ghế là một bàn làm việc; lead có thảm vàng + vương miện. Trạng thái nhìn bằng hình (cả 3D lẫn 2D): màn hình xanh dương + gõ phím = **working**, bong bóng "…" = **listening**, "!" vàng nhấp nháy = **chờ duyệt quyền**, "Zz" = **idle — needs nudge**, "✕" đỏ = **wake limit**, nhân vật mờ = **offline**, ghế trống = **vacant**, phòng tối + PAUSED = phòng đang pause. **Lobby** chứa session chưa ngồi ghế. Rê chuột xem nhanh, bấm để mở thẻ chi tiết (có Copy join).

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

**Cách nhanh nhất — tab Machines:** Thêm máy → thêm ghế (chọn ghế, thư mục repo, quyền, session muốn tiếp tục — danh sách gợi ý các session Claude đã thấy trên chính máy đó) → **Lưu** → **Lệnh cài** → chạy lệnh trên máy (cần Node.js 20+ và Claude Code đã đăng nhập). Lệnh cài connector, gắn máy vào thẻ và cài runner tự chạy khi đăng nhập. Sau đó mọi thay đổi trên web (thêm/bớt ghế, đổi repo, đổi session) máy áp dụng trong vài giây. Mặc định ghế chạy với `--dangerously-skip-permissions` (không hỏi quyền; chọn chế độ khác ở cột Quyền nếu muốn duyệt lệnh shell). Mỗi ghế mở một cửa sổ Terminal trên desktop của máy để theo dõi session trực tiếp — chỉ xem (tắt ở cột **Cửa sổ**; mở tay bằng `agent-office.mjs runner watch <seat>`). Muốn tự gõ vào session: Stop trên web → `claude --resume <session-id>` → thoát → Start. Chọn ở cột Session một session **đang mở** ở terminal rồi Lưu thì hệ thống tự đóng Claude ở terminal đó (sau lượt đang chạy) và runner chạy tiếp đúng session đó. Ghế đang bị session khác giữ thì runner chờ và hiện lý do trên web, không tạo session mới. Thư mục repo phải nằm trong vùng máy cho phép (mặc định: thư mục home; mở rộng bằng `"allowedRoots": ["/data/projects"]` trong `~/.agent-office/runner.json` trên máy). Chọn session đang mở ở terminal thì đóng terminal đó trước khi lưu. Xoá máy trên web thì thu hồi luôn quyền kết nối của máy. Cột **Model** nhận tên model bất kỳ (gõ tay, vd model custom qua proxy; chỉ chữ, số và `. _ : @ - / [ ]`). Sửa một ghế thì dòng đó tô vàng "Chưa lưu" — bấm **Áp dụng** trên dòng để lưu riêng ghế đó và khởi động lại nó trên đúng session đang chạy với model / repo / quyền mới; hoặc **Lưu & áp dụng** cho cả máy. Restart khi chưa lưu vẫn chạy cấu hình cũ. Công tắc **Active / Inactive** mỗi ghế: Inactive = ghế nghỉ (dừng Claude, giữ session) và **vẫn nghỉ kể cả khi runner/máy khởi động lại**; Active = chạy lại đúng session đó. Runner trên máy vẫn chạy; mention gửi tới ghế nghỉ được giữ chờ đến khi Active lại. Hợp lúc ít việc: chỉ bật 1 ghế, các ghế khác nghỉ. Dừng agent: **⏹ Dừng mọi agent** (đầu trang) dừng Claude ở mọi ghế đang chạy bằng runner; **Dừng cả máy** / **Chạy cả máy** trên từng thẻ máy; **Dừng** / **Chạy** trên từng ghế. Dừng giữ nguyên session — Chạy là tiếp tục đúng session đó; ghế có "Tự chạy" sẽ tự chạy lại nếu runner trên máy khởi động lại. Ghế mở trong terminal phải tự tắt ở máy đó (hoặc Pause phòng ban để không bị đánh thức). Cột **Điều khiển** mỗi ghế: **Restart** (dừng rồi chạy lại Claude, tiếp tục đúng session — giữ context) và **Session mới** (bỏ session hiện tại, mở session Claude mới; ghi chú bàn giao và task vẫn còn); nút **Restart tất cả** ở đầu thẻ máy restart mọi ghế của máy. Các nút cần bấm 2 lần để xác nhận và chỉ bật khi máy online.

**Cách thủ công** (máy không quản lý trên web):

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
