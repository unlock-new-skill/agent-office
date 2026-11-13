# Task edit, blockers, readiness & dispatch

Status: P0-A, P0-B, P0-C, P0-D done on branch feat/task-edit-rbac (dispatch default `suggest`); P1 done (alerts digest, window expiry, status check uses flagged coordinator) · Source: /Users/truongpham/Desktop/requiremtn.md (PM pm-live, 13/11/2026) · Order: P0-A → P0-B/C → P0-D → P1

## Dev Office xác nhận (từ code, commit b4ce79a)

- Repo `my-studio` = Agent Office. Stack: Node 24, Hono server, SQLite (`src/server/db/database.ts`, migration `PRAGMA user_version`, đang v21), React+Vite UI, MCP stdio (`src/connector/mcp-server.ts`) gọi cùng REST `/v1/tasks`.
- Không có entity "project": 1 Office instance = 1 project. Department = `departments`. Cross-project = instance khác → tự nhiên bị chặn.
- Coordinator = **1 seat id** từ env `AGENT_OFFICE_COORDINATOR_SEAT` (mặc định `pm`, `.env` local không set). `TaskService.list` chỉ cho coordinator xem phòng khác.
- **Nguyên nhân 403 (giả thuyết mạnh, chưa thấy env production):** PM chạy seat `pm-live` ≠ `pm` → không phải coordinator → `GET /v1/tasks?departmentId=dev` ném `forbidden_task`. MCP map `forbidden_task` thành hint "Only the assignee or the department leader can change this task" → đúng lỗi "read bị báo là change".
- Task update đã có: status, estimate, dependsOn (validate tồn tại/cycle/self), assigneeSeatId ở REST **nhưng MCP `agent_office_update_task` không có assignee** → agent phải tạo task bản sao. Không sửa được title/body. Không bỏ assignee (null). Không revision → last-write-wins.
- Lịch sử: `task_events` chỉ ghi status from/to + note; không ghi field nào đổi, không nguồn UI/MCP.
- Dependency: `depends_on` JSON string[]; nghĩa = predecessor `done`. Không có result PASS/FAIL. Chặn `doing` khi dep mở; `releaseDependents` báo "ready" khi dep cuối DONE.
- Notification: system message trong thread task + `mentions` → `WakeService` đánh thức seat qua read cursor (`seat_reads`). Bền qua restart (DB + cursor), nhưng không có dedupe key → recompute nhiều lần sẽ gửi trùng.
- Event bus: `emit` → websocket broadcast (không bền). `events` table chỉ cho hook events (idempotent bằng producer/event_id). `runner_commands` là queue bền cho runner. Không có scheduler/outbox riêng cho task; `status-check.ts` có timer định kỳ sẵn.
- Không có claim nguyên tử, không owner queue, không cờ dispatch.

## Lát cắt (ước lượng của dev, assignee xác nhận lại; >240' phải tách tiếp)

| # | Lát | Est | Phụ thuộc |
|---|---|---|---|
| A1 | RBAC: coordinator theo role cấu hình (nhiều seat), mã lỗi tách read/change, hint MCP đúng | 2h | — |
| A2 | Migration v22: `revision`, `kind` (execution/tracking/NULL=chưa phân loại), bảng `task_changes` (audit field-level, source, reason) | 2.5h | — |
| A3 | Patch contract chung: title/body/assignee(null)/estimate/dependsOn/kind + `expectedRevision` → 409 kèm state mới; validate toàn bộ trước ghi; reassign task doing → 409 cần handoff; START execution chặn estimate thiếu/>240 | 3.5h | A2 |
| A4 | MCP update/create schema + UI form sửa task + tách nhóm tracking | 3h | A3 |
| C1 | Result (`not-applicable/pass/fail/inconclusive/unknown`, actor, at) + dependency `{id, condition: completed|passed}`; legacy string = completed | 3h | A2 |
| C2 | Hàm readiness thuần (reasons[]), recompute downstream khi reopen/result/blocker đổi; cảnh báo owner task doing | 3h | C1, B1 |
| B1 | Bảng `blockers` + `task_blockers` (kind, mô tả, resolver seat/role, next step, opened/updated/due, refs, resolve evidence) + REST/MCP | 3.5h | A2 |
| B2 | Màn PM/manager: Cần xử lý / Chờ dependency / Sẵn sàng / Đang làm / Xong, gom theo blocker, đếm unique, filter, nhãn snapshot | 3.5h | B1, C2 |
| B3 | Preview phân loại legacy BLOCKED (read-only), không đổi status | 1.5h | B1 |
| D1 | `readiness_generation` + bảng `task_notifications` UNIQUE(task, generation, recipient); gửi qua postSystem hiện có | 2.5h | C2 |
| D2 | START nguyên tử (kiểm lại readiness + revision + owner không có execution doing khác), `actual_start`, owner queue | 3h | D1 |
| D3 | Reconcile lúc boot, cờ dispatch `off/suggest/on` trong `app_settings` (rollback = off) | 2h | D2 |
| T | 16 case nghiệm thu (unit+integration), test report, demo trên task test riêng | 3.5h | all |

Grant/window (permission/environment) mô hình hóa bằng blocker kind `permission`/`environment` có ref quyết định + validity; thiếu → fail closed (trong B1/C2). Không DSL.

## Ranh giới

Office chỉ tính readiness, notify, queue, ghi START. Không chạy shell/test/deploy/restore/login, không kill process, không đổi hàng loạt status/result legacy, không SQL tay vào task thật (391 chỉ gán sau khi A1–A4 xong và verify).

## Phase files

- [phase-01-task-edit-rbac.md](phase-01-task-edit-rbac.md) — A1–A4 (làm trước)

## Quyết định

- Coordinator = cờ `seats.coordinator` (manager bật ở form sửa ghế) OR seat trong env `AGENT_OFFICE_COORDINATOR_SEAT` (giữ tương thích).
- Nguồn audit: cookie manager = `ui`, bearer agent = `mcp`.
- Thêm ngoài PM spec (user yêu cầu): lead + coordinator join kênh phòng khác (`channel_visitors`), `@all` phòng chỉ gọi người trong phòng.
- Blocker = bảng `blockers` + `task_blockers`; grant/window = blocker kind permission/environment, revoke = reopen.
- Readiness bền ở `task_readiness` (generation), ledger `task_notifications` PK (task, kind, generation, recipient), ghi cùng transaction (savepoint) với dòng chat → không trùng, không mất; reconcile khi khởi động.
- Dispatch mặc định `suggest`; manager bật `on` ở Tasks → By blocker. Task execution luôn qua gate (readiness + owner không có execution doing khác).
- Rollback: bản cũ gặp DB v22 sẽ từ chối khởi động → backup DB (`npm run backup`) trước deploy, rollback = restore backup.
