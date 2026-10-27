---
phase: 6
title: E2E smoke and cleanup
status: completed
priority: P2
dependencies:
  - 5
---

# Phase 6: E2E smoke and cleanup

## Overview
Prove full scenario with real Claude Code sessions, update docs/Postman, retire old plan.

## Requirements
- Scripted integration test (no real Claude): simulate 3 seats via bearer tokens + hook stdin fixtures: manager → `@dev-lead` → dev-lead creates task for `dev-be` → dev-be wake → done → dev-lead wake → posts `@ba-lead` in `#leaders` → ba-lead wake.
- Manual real run: 3 Claude Code sessions (Dev Lead, Dev BE, BA Lead), same scenario, observe UI.
- Docs: rewrite `docs/architecture.md` (departments/seats/wake), `docs/operations.md` (reset+setup, connect, install hooks, office.yaml).
- Postman: update `postman/collections/agent-office-core` for new endpoints; `postman collection lint` passes.
- Old plan `plans/261023-2211-agent-office-control-room/plan.md` → status `cancelled`, note superseded by this plan.

## Related Code Files
- Create: `tests/integration/department-flow.test.ts`
- Modify: `docs/architecture.md`, `docs/operations.md`, `postman/collections/agent-office-core/*`, old plan frontmatter

## Implementation Steps
1. Write `department-flow` test first; make green.
2. Manual real-session run; record findings in `plans/reports/`.
3. Update docs + Postman.
4. Final gates: `npm run build && npm run lint && npm test`, postman lint.

## Success Criteria
- [ ] department-flow test green.
- [ ] Real 3-session run completes scenario without manual copy-paste between agents.
- [ ] Docs + Postman updated; all gates pass.

## Risk Assessment
- Real-model behavior varies (may ignore wake reason) — record, tune reason text/tool descriptions, not code paths.
