---
phase: 5
title: Pixel world
status: in-progress
priority: P1
dependencies:
  - 1
  - 3
  - 4
---

# Phase 5: Pixel world

## Overview

Add Phaser-based 2D office visualization plus full map editing/free pathfinding without moving business state into the game layer. Map revisions, editor drafts, navigation generations and route invalidation are explicit contracts.

Context: [shared contracts](./plan.md). Red-team amendments: map API completeness, dirty-draft recovery, revision/ETag restore, navigation generation invalidation.

## Requirements

- Map API supports create/list/get/update/revisions/restore, opaque map IDs, `version`/ETag, optimistic concurrency and manager-only writes.
- Map document includes tiles, walls, furniture, zones, desks, object logical types, collision/navigation flags and agent spawn/seat assignments. Initial bounds: 128×128 cells, 1,000 placed objects, 20 seats/visible agents, 2 MiB serialized map. Invalid bounds fail validation before save.
- Editor supports placement/deletion/flags/zones/desk assignment, bounded in-memory undo, dirty draft preservation across reconnect and explicit save conflict choices. No collaborative merge, persistent undo stack, or unlimited revision history; bounded saved revisions below support recovery.
- Free agent movement uses navigation grid + A* with bounded search/cancellation. Every path/grid/movement carries `mapGeneration`.
- Map save/recovery invalidates old routes, pending path results, seat references and visual cache. No route degrades to explained stationary state.
- Visual states show working, blocked, idle, error, suspected stuck, contact-lost/exited/unknown, current tool, and evidence-backed collaboration.
- Kenney CC0 assets separated behind manifest; canvas never sole status source; cosmetic animation cannot block event processing.
<!-- Updated: Validation Session 1 - render performance is a blocking gate, not advisory. -->
- Failed applicable frame-time/resource SLOs block phase completion and release. Low-FPS fallback remains runtime resilience, not permission to mark a failed benchmark passed; optimize/retest or ask before changing workload/thresholds.

## Architecture

`PixelWorld` consumes authorized selectors from control-room store and map API. `MapEditor` owns local draft with `baseRevision`, dirty flag, bounded undo stack and pending operation ID. Server authoritative map uses immutable revision IDs plus a numeric version increasing within each dataset generation; ETag contains dataset/map/revision identity. A save with stale `If-Match` returns conflict and does not overwrite; UI preserves draft and offers reload/discard or manual reapply. No automatic merge.

Keep latest 20 validated committed revisions per map; current revision is never pruned. Bounded in-memory undo holds 100 commands, not cross-reload history. Atomic map save writes current document, retained revision and event in one transaction. ETag includes `(datasetGeneration, mapId, immutableRevisionId)`; stale writes return 412, missing If-Match 428. Send a stable save operation ID: lost response retries return the original result before re-evaluating If-Match; same ID/different content returns 409. Lookup is scoped to manager/session/map, never global.

Restore takes a retained valid revision and creates a new version/revision; it does not rewind counters. Restore rotates map/navigation generation. A dataset restore rotates global generation as well. Dirty drafts retain base generation and never auto-save into a replaced dataset; offer export/discard/manual reapply after user review. Existing backups/history are bounded operational recovery, not collaborative editing.

`NavigationGrid` derives walkability from current map generation. `Pathfinder` returns route tagged `(mapId, mapGeneration, pathRequestId)`. `MovementController` validates generation/target/seat before applying; any map change, restore, destination deletion, or route cancellation invalidates pending/active routes. A stale async result is ignored. Revalidate current position and destination after every map replacement; move visual avatar to a nearest reachable valid cell only if one exists. Invalid/no route or entirely blocked map produces stationary/unplaced status with reason, never a fabricated route. Event updates continue while A* yields within a 5ms per-frame work budget.

Agent avatars are render projections of daemon state. Collaboration lines/routes require evidence type + timestamp + expiry; co-activity is not joint-work proof. Pixel layer can be disabled without affecting control room.

## Related Code Files

Create under `/Users/truongpham/Desktop/my-studio/`:
- `src/client/pixel-world/`, `src/client/map-editor/`, `src/client/pixel-world/navigation/`, `public/assets/pixel/`.
- `tests/unit/pixel-world/`, `tests/e2e/pixel-world/`.
Modify map server routes/repositories, shared map contracts, client state and control-room integration.

## Implementation Steps

1. Use phase-1 compatibility result to pin Phaser/browser; define asset manifest, bounded map/object schema and license metadata.
2. Add map/revision/restore migrations and manager-scoped create/list/get/update/revisions/restore routes with validation, ETag and generation.
3. Implement Phaser scene lifecycle and store-to-scene adapter; duplicate important state in DOM inspector.
4. Implement editor draft/base revision, bounded in-memory undo, save operation-ID reconciliation, dirty reconnect/reset behavior and conflict reload/discard/manual reapply UI. Never replace dirty draft with a stream snapshot; warn on page close. No automatic merge or cross-reload draft guarantee.
5. Build navigation grid from current collision objects; implement bounded A*, cancellation, pathRequest IDs and generation checks.
6. Implement avatar registry, seat assignment, state animations, speech bubbles and markers for all contact/activity states.
7. Invalidate route/cache/seat references on map update/restore; test stale asynchronous results and blocked maps.
8. Derive collaboration lines/routes only from evidence-backed relationships with expiry.
9. Add camera focus, inspector integration, reduced motion, low-FPS fallback and disable-pixel fallback.

## Success Criteria

- [ ] Manager can create/list/load/update a map; stale ETag cannot overwrite and revision list is visible.
- [ ] Restore creates a new revision/version, retains prior valid revision, and invalidates navigation generation.
- [ ] Dirty draft survives reconnect/reset; conflict preserves work and offers explicit choices. Lost save response retries do not create duplicate revisions; old-dataset drafts cannot silently overwrite restored maps.
- [ ] Editor creates wall/desk route; undo is bounded and in-memory only.
- [ ] A* finds route around obstacles; stale route results cannot move avatars through new walls.
- [ ] No-route/fully blocked map stays responsive and explains stationary state.
- [ ] 20 avatars render/update without business-state divergence and maintain frame-rate SLO.
- [ ] Collaboration lines show evidence and expire; unproven co-activity is labeled accordingly.
- [ ] Pixel layer can be disabled while control room remains fully functional.

## Risk Assessment

- Full editor/pathfinding is largest scope risk; bounded undo and no collaborative merge keep contract finite.
- Phaser canvas accessibility: duplicate all important status in DOM; no canvas-only workflow.
- Asset licensing: keep Kenney license/manifest; no untracked third-party art.
- Animation load: bounded entity updates and render tick separate from event reducer.
