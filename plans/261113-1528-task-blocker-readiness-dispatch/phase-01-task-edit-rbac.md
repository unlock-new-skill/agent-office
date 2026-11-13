# Phase 01 — Task edit + RBAC (P0-A)

## Files

- Modify: `src/server/collaboration/task-service.ts`, `src/server/office-routes.ts`, `src/server/db/database.ts` (v22), `src/server/config.ts`, `src/server/collaboration/office.ts`, `src/shared/contracts.ts`, `src/connector/mcp-server.ts`, `src/client/components/tasks-panel.tsx`, `src/shared/agent-guide.ts`, `docs/user-guide.md`
- Tests: `tests/unit/task-service.test.ts`, `tests/integration/tasks-api.test.ts`

## A1 — RBAC

- Coordinator = tập seat (theo quyết định câu hỏi mở #2). `isCoordinator` dùng tập.
- Mã lỗi: `forbidden_task_read` (list/get/thread) vs `forbidden_task_change` (update); giữ `forbidden_task` alias 1 bản cho client cũ? → không, đổi hint MCP cùng lúc.
- Member chỉ sửa: status/estimate/note/result của task mình. Lead/deputy: phòng mình. Coordinator/manager: mọi phòng.

## A2 — Migration v22 (non-destructive)

- `ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`
- `ALTER TABLE tasks ADD COLUMN kind TEXT CHECK(kind IN ('execution','tracking'))` — NULL = chưa phân loại (legacy), không tự gán.
- `CREATE TABLE task_changes(id, task_id, revision, actor_kind, actor_id, source CHECK IN ('ui','mcp','api'), field, before_json, after_json, reason, created_at)`.
- Không đụng `task_events`, ID, status cũ.

## A3 — Patch contract

- Body: `{ expectedRevision?, title?, body?, assigneeSeatId?: string|null, estimateMinutes?: number|null, dependsOn?, kind?, status?, note?, reason? }`. Field vắng = giữ nguyên; `dependsOn: []` chỉ xóa khi gửi rõ.
- `expectedRevision` lệch → 409 `stale_revision` + `{ task }` hiện hành. (Bắt buộc với UI/MCP mới; vắng thì chấp nhận để tương thích client cũ.)
- Validate hết (assignee tồn tại + đúng phòng, deps tồn tại/không cycle/self, estimate) rồi mới ghi trong 1 transaction; lỗi = không ghi gì.
- Reassign khi `status='doing'` → 409 `reassign_doing_requires_handoff` trừ khi kèm `handoffNote` (ghi audit + post thread cho cả 2 seat).
- `doing` với `kind='execution'`: estimate null hoặc >240 → 400 `estimate_required_le_240`. Tracking: không bao giờ `doing` qua dispatch, không tính tải.
- Mỗi update: `revision+1`, 1 dòng `task_changes` mỗi field đổi, source từ header `X-Agent-Office-Source` (MCP gửi `mcp`, UI gửi `ui`).
- Notify owner mới đúng 1 lần (dòng thread hiện có, mention assignee mới).

## A4 — MCP + UI

- `agent_office_update_task`: thêm `assigneeSeatId (nullable)`, `title`, `body`, `kind`, `expectedRevision`, `reason`, `handoffNote`. `agent_office_create_task`: thêm `kind`.
- List/get trả `revision`, `kind`.
- UI: nút Edit trên task card → form (title/body/assignee/estimate/deps/kind), gửi revision; 409 → hiện state mới. Nhóm "Tracking" tách riêng, mặc định thu gọn.

## Tests (chạy `npm test`, `npm run lint`, `npm run build`)

- Coordinator list Dev OK; member phòng khác bị `forbidden_task_read`.
- Gán task assignee=null qua REST source=ui và source=mcp → cùng kết quả, ID giữ, audit 2 nguồn, notify 1 lần.
- 2 patch cùng revision → 1 OK, 1 409, dependsOn/owner không mất.
- Cycle / missing dep / invalid assignee → lỗi, không partial write.
- Execution estimate 300 → không doing; tracking estimate 4800 → lưu được, không đổi số.
- Reassign task doing không handoff → 409.

## Rủi ro / rollback

- Migration chỉ ADD COLUMN/CREATE TABLE; rollback = deploy bản cũ (cột thừa bị bỏ qua) — cần kiểm `SCHEMA_VERSION` check của bản cũ: bản cũ thấy v22 sẽ chạy migrate? → kiểm trước khi release, backup DB (`npm run backup`) trước deploy.
