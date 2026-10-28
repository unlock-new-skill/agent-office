import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatStatus } from '../state/office-store.js';
import { CELL_H, CELL_W, TILE, seatHash, type MapLayout } from '../map/office-map-layout.js';
import { currentHour, lightingAt } from './day-night.js';
import { buildStreet, streetBand, type Patron } from './office-3d-street.js';
import { box, cube, floorTexture, grassTexture, makeBush, makeCoffeeTable, makeFlowers, makeMoon, makeOutdoorTree, makePantry, makePendantLamp, makePlant, makeSofa, shared, ZONE_FLOORS, type FloorKind } from './office-3d-props.js';
import type { SeatSprite } from '../map/office-map-painter.js';

export type Target3D = { seatId: string } | { agentId: string };
export type Office3DModel = { layout: MapLayout; seats: Map<string, SeatSprite>; leaders: Set<string>; lobbyLabels: Map<string, string> };
type Handlers = { onHover: (target: Target3D | null, x: number, y: number) => void; onSelect: (target: Target3D | null) => void };
type Actor = {
  key: string; status: SeatStatus; root: THREE.Group; person: THREE.Group | null; arms: THREE.Object3D[]; head: THREE.Object3D | null;
  screen: THREE.MeshStandardMaterial | null; icon: THREE.Sprite; ring: THREE.Mesh; phase: number; standing: boolean; base: THREE.Vector3; personMaterials: THREE.MeshStandardMaterial[];
};

/** Layout pixels → world units: one floor tile is one unit. */
const U = 1 / TILE;
/** Stone walkway along the building's near sides. */
const WALKWAY = 1.6;
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR = [0x2b1d14, 0x5a3825, 0xa0522d, 0xd8b04c, 0x1f2937, 0x7c2d12];
const SHIRT = [0x3b82f6, 0xef4444, 0x10b981, 0x8b5cf6, 0xf59e0b, 0xec4899, 0x14b8a6, 0x6366f1];
const SCREEN: Record<SeatStatus, number> = { working: 0x60a5fa, listening: 0x22c55e, blocked: 0xf59e0b, wake_limited: 0xf87171, idle: 0x334155, offline: 0x05070a, vacant: 0x05070a };
const ICON: Partial<Record<SeatStatus, { text: string; bg: string; fg: string }>> = {
  blocked: { text: '!', bg: '#f59e0b', fg: '#1f1300' }, wake_limited: { text: '✕', bg: '#f87171', fg: '#2a0a0a' },
  idle: { text: 'Zz', bg: '#cbd5e1', fg: '#1e293b' }, listening: { text: '…', bg: '#e2e8f0', fg: '#16a34a' },
};

const textTexture = (lines: Array<{ text: string; font: string; color: string }>, width: number, height: number, background: string | null, radius = 18): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  if (background) { context.fillStyle = background; context.beginPath(); context.roundRect(2, 2, width - 4, height - 4, radius); context.fill(); }
  context.textAlign = 'center'; context.textBaseline = 'middle';
  lines.forEach((line, index) => { context.font = line.font; context.fillStyle = line.color; context.fillText(line.text, width / 2, (height / (lines.length + 1)) * (index + 1)); });
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
};
const iconTextures = new Map<string, THREE.CanvasTexture>();
const iconTexture = (status: SeatStatus): THREE.CanvasTexture | null => {
  const icon = ICON[status]; if (!icon) return null;
  let texture = iconTextures.get(status);
  if (!texture) { texture = textTexture([{ text: icon.text, font: 'bold 76px system-ui, sans-serif', color: icon.fg }], 128, 128, icon.bg, 40); iconTextures.set(status, texture); }
  return texture;
};
const label = (text: string, color = '#e2e8f0'): THREE.Sprite => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture([{ text: text.length > 22 ? `${text.slice(0, 21)}…` : text, font: '600 34px system-ui, sans-serif', color }], 384, 64, 'rgba(15,23,42,0.72)', 26), depthWrite: false }));
  sprite.scale.set(2.4, 0.4, 1); return sprite;
};
/**
 * Low-poly isometric open-plan office floor: departments are zones with their own flooring (no walls between them),
 * inside a building with windowed outer walls, pillars, a pantry, a lounge, plants and pendant lamps. Daylight follows
 * the local clock (sun path, sky through the windows, lamps at night). Voxel agents show their live status through
 * screen glow, pose and a floating icon. Rebuilds geometry only when the org layout changes; status changes just
 * restyle existing actors. Orbit (drag), zoom (wheel) and pan (right drag); hover/click pick seats and lobby agents.
 */
export class Office3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
  private readonly controls: OrbitControls;
  private readonly world = new THREE.Group();
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  private readonly observer: ResizeObserver;
  private actors = new Map<string, Actor>();
  private hitBoxes: THREE.Mesh[] = [];
  private signs: Array<{ sprite: THREE.Sprite; roomId: string; name: string; color: string; paused: boolean }> = [];
  private structure = '';
  private span = 20;
  private frame = 0;
  private hovered: string | null = null;
  private selected: string | null = null;
  private model: Office3DModel | null = null;
  private readonly floors = new Map<FloorKind, THREE.CanvasTexture>();
  private readonly hemisphere = new THREE.HemisphereLight(0xdbe7ff, 0x2a2f38, 1.9);
  private readonly grass = grassTexture();
  private readonly ground = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.grass, roughness: 1 });
  private readonly moon = makeMoon();
  private glass: THREE.MeshStandardMaterial | null = null;
  private bulbs: THREE.MeshStandardMaterial[] = [];
  private lamps: THREE.PointLight[] = [];
  private patrons: Patron[] = [];
  private center = new THREE.Vector3();
  private reach = 20;
  private lightingCheckedAt = -Infinity;
  private downAt: { x: number; y: number } | null = null;

  constructor(private readonly host: HTMLElement, private readonly handlers: Handlers) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0e1116);
    this.scene.fog = new THREE.Fog(0x0e1116, 90, 200);
    this.scene.add(this.hemisphere);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0005; this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.world);
    this.grass.repeat.set(400 / 6, 400 / 6);
    this.scene.add(this.moon.group);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.ground);
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true; this.scene.add(ground);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.minPolarAngle = 0.35; this.controls.maxPolarAngle = 1.25; this.controls.minZoom = 0.5; this.controls.maxZoom = 4; this.controls.screenSpacePanning = true;
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('click', this.onClick);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  setModel(model: Office3DModel): void {
    this.model = model;
    const structure = JSON.stringify({
      rooms: model.layout.rooms.map(room => [room.departmentId, room.name, room.color, room.paused, room.x, room.y, room.w, room.h, room.desks.map(desk => [desk.seatId, desk.leader, model.seats.get(desk.seatId)?.title])]),
      lobby: model.layout.lobby?.spots.map(spot => [spot.agentId, model.lobbyLabels.get(spot.agentId)]),
    });
    if (structure !== this.structure) { this.structure = structure; this.rebuild(model); }
    for (const [key, actor] of this.actors) {
      const status = actor.standing ? 'listening' : model.seats.get(key)?.status ?? 'vacant';
      if (status !== actor.status) this.restyle(actor, status);
    }
    this.refreshSigns();
  }

  setHighlight(hovered: string | null, selected: string | null): void {
    this.hovered = hovered; this.selected = selected;
    for (const [key, actor] of this.actors) {
      actor.ring.visible = key === hovered || key === selected;
      (actor.ring.material as THREE.MeshBasicMaterial).color.set(key === selected ? 0xa5b4fc : 0x64748b);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame); this.observer.disconnect(); this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('click', this.onClick);
    this.clearWorld(); for (const texture of this.floors.values()) texture.dispose(); this.ground.dispose(); this.grass.dispose();
    this.moon.group.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); for (const material of this.moon.materials) { if ('map' in material) material.map?.dispose(); material.dispose(); } this.renderer.dispose(); this.renderer.domElement.remove();
  }

  private resize(): void {
    const width = Math.max(this.host.clientWidth, 1); const height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(width, height);
    const aspect = width / height; const half = this.span / 2;
    this.camera.left = -half * aspect; this.camera.right = half * aspect; this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  private clearWorld(): void {
    this.world.traverse(object => {
      if (object instanceof THREE.Sprite) { if (!object.userData.sharedMap) object.material.map?.dispose(); object.material.dispose(); }
      if (object instanceof THREE.Mesh && object.geometry !== box) object.geometry.dispose();
      if (object instanceof THREE.Mesh && object.userData.ownMaterial) { const material = object.material as THREE.MeshStandardMaterial; material.map?.dispose(); material.dispose(); }
    });
    // Icon textures are shared across rebuilds; sprites above only disposed their own label maps.
    for (const lamp of this.lamps) lamp.dispose();
    this.world.clear(); this.actors.clear(); this.hitBoxes = []; this.signs = []; this.bulbs = []; this.lamps = []; this.patrons = []; this.glass = null;
  }

  private floorFor(kind: FloorKind): THREE.CanvasTexture {
    let texture = this.floors.get(kind);
    if (!texture) { texture = floorTexture(kind); this.floors.set(kind, texture); }
    return texture;
  }

  /** Floor slab with a tiled pattern; each slab owns a texture clone so its repeat matches its size. */
  private slab(kind: FloorKind, color: number, x: number, z: number, w: number, d: number, y: number, tile = 2): THREE.Mesh {
    const map = this.floorFor(kind).clone(); map.repeat.set(w / tile, d / tile); map.needsUpdate = true;
    const mesh = cube(new THREE.MeshStandardMaterial({ color, map, roughness: kind === 'tile' || kind === 'terrazzo' ? 0.45 : 0.9 }), [w, 0.1, d], [x + w / 2, y, z + d / 2], this.world, false);
    mesh.userData.ownMaterial = true; return mesh;
  }

  private rebuild(model: Office3DModel): void {
    this.clearWorld();
    const { layout } = model;
    // Building footprint: the layout plus a strip on the right for the pantry, with a margin all round.
    const contentDepth = Math.max(...layout.rooms.map(room => (room.y + room.h) * U), layout.lobby ? (layout.lobby.y + layout.lobby.h) * U : 0, 12.5);
    const x0 = -1; const z0 = -1; const x1 = layout.width * U + 8; const z1 = contentDepth + 1.5;
    this.buildShell(x0, z0, x1, z1);
    this.buildGrounds(x0, z0, x1, z1);
    const front = z1 + 0.4 + WALKWAY;
    const street = buildStreet(this.world, (kind, color, x, z, w, d, y, tile) => { this.slab(kind, color, x, z, w, d, y, tile); }, id => this.makePerson(id, false, false), x0, x1, front);
    this.bulbs.push(...street.bulbs); this.patrons = street.patrons;
    for (const light of street.lights) this.addLampLight(light.x, light.z, light.size);
    layout.rooms.forEach((room, index) => {
      const rx = room.x * U; const rz = room.y * U; const w = room.w * U; const d = room.h * U;
      const kind = ZONE_FLOORS[index % ZONE_FLOORS.length]!;
      const tint = new THREE.Color(0xffffff).lerp(new THREE.Color(room.color), kind === 'carpet' ? 0.55 : 0.28);
      if (room.paused) tint.lerp(new THREE.Color(0x4b5563), 0.5);
      this.slab(kind, tint.getHex(), rx, rz, w, d, 0.06);
      // Zone outline in the department colour instead of walls.
      const edge = shared(new THREE.Color(room.color).getHex(), { roughness: 0.4 });
      cube(edge, [w, 0.04, 0.12], [rx + w / 2, 0.13, rz + 0.06], this.world, false); cube(edge, [w, 0.04, 0.12], [rx + w / 2, 0.13, rz + d - 0.06], this.world, false);
      cube(edge, [0.12, 0.04, d], [rx + 0.06, 0.13, rz + d / 2], this.world, false); cube(edge, [0.12, 0.04, d], [rx + w - 0.06, 0.13, rz + d / 2], this.world, false);
      const sign = label(room.name); sign.position.set(rx + w / 2, 3.4, rz + 0.6); sign.scale.set(Math.min(w * 0.8, 6), 0.75, 1); this.world.add(sign);
      cube(shared(0x111827), [0.03, 1.2, 0.03], [rx + w / 2, 4.3, rz + 0.6], this.world, false);
      this.signs.push({ sprite: sign, roomId: room.departmentId, name: room.name, color: room.color, paused: room.paused });
      const rows = Math.max(1, Math.ceil(room.desks.length / 3));
      for (let row = 0; row < rows; row++) this.bulbs.push(makePendantLamp(this.world, rx + w / 2, (room.desks[row * 3]?.y ?? room.y) * U + 1.6));
      this.addLampLight(rx + w / 2, rz + d / 2, Math.max(w, d));
      makePlant(this.world, rx + w - 0.5, rz + d - 0.5, false, index);
      for (const desk of room.desks) this.addDesk(desk.seatId, desk.x, desk.y, desk.leader, model);
    });
    if (layout.lobby) {
      const lobby = layout.lobby; const lx = lobby.x * U; const lz = lobby.y * U; const w = lobby.w * U; const d = lobby.h * U;
      this.slab('carpet', 0x8b9bb4, lx, lz, w, d, 0.06, 3);
      const sign = label('Lobby'); sign.position.set(lx + w / 2, 3.2, lz + 0.6); sign.scale.set(3, 0.6, 1); this.world.add(sign);
      makeSofa(this.world, lx + w / 2, lz + 0.9, 0, 0x64748b);
      makePlant(this.world, lx + 0.5, lz + 0.5, false, 3); makePlant(this.world, lx + w - 0.5, lz + 0.5, false, 5);
      this.bulbs.push(makePendantLamp(this.world, lx + w / 2, lz + d / 2));
      this.addLampLight(lx + w / 2, lz + d / 2, Math.max(w, d));
      for (const spot of lobby.spots) this.addLobbyAgent(spot.agentId, (spot.x + 20) * U, (spot.y + 30) * U, model.lobbyLabels.get(spot.agentId) ?? spot.agentId);
    }
    // Pantry and lounge in the strip to the right of the departments.
    const px = layout.width * U + 0.5;
    this.slab('tile', 0xf1f5f9, px, z0 + 1, 7, 6, 0.06);
    makePantry(this.world, px + 0.6, z0 + 1.2);
    const pantrySign = label('Pantry'); pantrySign.position.set(px + 3.5, 3.2, z0 + 1.6); pantrySign.scale.set(2.6, 0.55, 1); this.world.add(pantrySign);
    this.bulbs.push(makePendantLamp(this.world, px + 2.2, z0 + 3.8), makePendantLamp(this.world, px + 4.8, z0 + 3.8));
    this.addLampLight(px + 3.5, z0 + 4, 8);
    makeSofa(this.world, px + 3.5, z0 + 9.5, Math.PI / 2, 0x0f766e); makeCoffeeTable(this.world, px + 5, z0 + 9.5); makePlant(this.world, px + 3.5, z0 + 11.6, false, 7);
    this.bulbs.push(makePendantLamp(this.world, px + 4.4, z0 + 9.5)); this.addLampLight(px + 4.4, z0 + 9.5, 6);
    // Trees at the corners and plants along the windows.
    makePlant(this.world, x0 + 1.1, z0 + 1.1, true, 1); makePlant(this.world, x1 - 1.1, z0 + 7.5, true, 2); makePlant(this.world, x0 + 1.1, z1 - 1.1, true, 4);
    for (let x = x0 + 6; x < x1 - 9; x += 9) makePlant(this.world, x, z0 + 0.7, false, x);
    this.frameScene(x0, z0, x1, streetBand(front).end);
    this.lightingCheckedAt = -Infinity;
  }

  /** Outer shell: floor slab, windowed walls on the two far sides, low parapets on the near sides, pillars. */
  private buildShell(x0: number, z0: number, x1: number, z1: number): void {
    const w = x1 - x0; const d = z1 - z0; const H = 3.8;
    this.slab('concrete', 0xd6d3d1, x0, z0, w, d, 0, 3);
    const wall = shared(0xe7e5e4, { roughness: 0.9 }); const frame = shared(0x334155, { roughness: 0.4, metalness: 0.5 });
    this.glass = new THREE.MeshStandardMaterial({ color: 0x9ec9f5, emissive: 0x9ec9f5, emissiveIntensity: 0.35, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1 });
    const glassMesh = (size: [number, number, number], at: [number, number, number]): void => { const mesh = cube(this.glass!, size, at, this.world, false); mesh.receiveShadow = false; };
    // Back wall (along x at z0) and left wall (along z at x0): solid base and lintel, glass between mullions.
    cube(wall, [w, 0.9, 0.3], [x0 + w / 2, 0.45, z0], this.world); cube(wall, [w, 0.6, 0.3], [x0 + w / 2, H - 0.3, z0], this.world);
    cube(wall, [0.3, 0.9, d], [x0, 0.45, z0 + d / 2], this.world); cube(wall, [0.3, 0.6, d], [x0, H - 0.3, z0 + d / 2], this.world);
    glassMesh([w, H - 1.5, 0.08], [x0 + w / 2, 0.9 + (H - 1.5) / 2, z0]); glassMesh([0.08, H - 1.5, d], [x0, 0.9 + (H - 1.5) / 2, z0 + d / 2]);
    for (let x = x0; x <= x1 + 0.01; x += 3) cube(frame, [0.14, H - 1.5, 0.36], [x, 0.9 + (H - 1.5) / 2, z0], this.world);
    for (let z = z0; z <= z1 + 0.01; z += 3) cube(frame, [0.36, H - 1.5, 0.14], [x0, 0.9 + (H - 1.5) / 2, z], this.world);
    // Near sides stay low so the camera can look in.
    cube(wall, [w, 0.45, 0.3], [x0 + w / 2, 0.22, z1], this.world); cube(wall, [0.3, 0.45, d], [x1, 0.22, z0 + d / 2], this.world);
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) cube(shared(0xd6d3d1), [0.7, px === x0 || pz === z0 ? H : 0.6, 0.7], [px, (px === x0 || pz === z0 ? H : 0.6) / 2, pz], this.world);
  }

  /**
   * Meadow around the building: a stone walkway on the near sides, then trees, bushes and flowers scattered with a
   * fixed seed. Nothing tall is placed close in front of the building, where it would block the isometric view, and
   * nothing grows on the street in front of it.
   */
  private buildGrounds(x0: number, z0: number, x1: number, z1: number): void {
    const walk = WALKWAY; const street = streetBand(z1 + 0.4 + walk);
    this.slab('concrete', 0xcbd5e1, x0 - 0.4, z1 + 0.4, x1 - x0 + walk + 0.4, walk, 0.0, 2);
    this.slab('concrete', 0xcbd5e1, x1 + 0.4, z0 - 0.4, walk, z1 - z0 + 0.8, 0.0, 2);
    let seed = 7919; const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const margin = 26; const inBuilding = (x: number, z: number, pad: number): boolean => (x > x0 - pad && x < x1 + walk + pad && z > z0 - pad && z < z1 + walk + pad) || (z > street.near - pad && z < street.end + pad);
    const blocksView = (x: number, z: number): boolean => (z > z1 && z < street.end + 8 && x > x0 - 16) || (x > x1 && x < x1 + 16 && z > z0 - 16);
    const spot = (pad: number, avoidView: boolean): [number, number] | null => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const x = x0 - margin + random() * (x1 - x0 + margin * 2); const z = z0 - margin + random() * (z1 - z0 + margin * 2);
        if (!inBuilding(x, z, pad) && !(avoidView && blocksView(x, z))) return [x, z];
      }
      return null;
    };
    for (let i = 0; i < 46; i++) { const at = spot(3, true); if (at) makeOutdoorTree(this.world, at[0], at[1], 0.8 + random() * 0.7, i); }
    for (let i = 0; i < 34; i++) { const at = spot(2, true); if (at) makeBush(this.world, at[0], at[1], i); }
    for (let i = 0; i < 70; i++) { const at = spot(1.5, false); if (at) makeFlowers(this.world, at[0], at[1], i); }
  }

  private addLampLight(x: number, z: number, size: number): void {
    const light = new THREE.PointLight(0xffd9a0, 0, size * 1.6, 1.4); light.position.set(x, 3.6, z); this.world.add(light); this.lamps.push(light);
  }

  /** Sun, sky, ambient and interior lamps for the current local hour; re-evaluated once a minute. */
  private applyLighting(): void {
    const light = lightingAt(currentHour());
    const sky = new THREE.Color(light.skyColor);
    (this.scene.background as THREE.Color).copy(sky).multiplyScalar(0.55 + light.daylight * 0.25);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
    this.hemisphere.intensity = light.ambientIntensity; this.hemisphere.color.copy(sky).lerp(new THREE.Color(0xffffff), 0.6);
    this.sun.color.setHex(light.sunColor); this.sun.intensity = light.sunIntensity;
    const distance = this.reach * 1.5 + 30; const night = 1 - light.daylight;
    this.sun.position.set(this.center.x + Math.sin(light.sunAzimuth) * distance * Math.cos(light.sunElevation), Math.sin(light.sunElevation) * distance, this.center.z - Math.cos(light.sunAzimuth) * distance * Math.cos(light.sunElevation) * 0.6);
    // At night the directional light becomes cool moonlight coming from the moon.
    this.moon.group.visible = night > 0.02;
    for (const material of this.moon.materials) material.opacity = Math.min(1, night * 1.2);
    if (night > 0.5) {
      const fromMoon = this.moon.group.position.clone().sub(this.center); fromMoon.y = Math.max(fromMoon.y, 8); fromMoon.normalize();
      this.sun.position.copy(this.center).addScaledVector(fromMoon, distance);
      this.sun.color.setHex(0xbfd4ff); this.sun.intensity = 0.3 + night * 0.55;
    }
    this.sun.target.position.copy(this.center);
    this.ground.color.setHex(0xffffff).multiplyScalar(0.3 + light.daylight * 0.7).lerp(new THREE.Color(0x6f83bd), night * 0.35);
    if (this.glass) { this.glass.color.copy(sky); this.glass.emissive.copy(sky); this.glass.emissiveIntensity = 0.25 + light.daylight * 0.35; }
    for (const bulb of this.bulbs) bulb.emissiveIntensity = 0.3 + light.lampIntensity * 2.6;
    for (const lamp of this.lamps) lamp.intensity = light.lampIntensity * 18;
  }

  private frameScene(x0: number, z0: number, x1: number, z1: number): void {
    const width = x1 - x0; const depth = z1 - z0; const center = new THREE.Vector3(x0 + width / 2, 0, z0 + depth / 2);
    this.center.copy(center); this.reach = Math.max(width, depth);
    // Seen diagonally, the floor's on-screen height is about a third of width + depth; keep a margin for walls and signs.
    this.span = (width + depth) * 0.35 + 6;
    center.y = 1.2; this.controls.target.copy(center);
    this.camera.position.set(center.x + 40, center.y + 42, center.z + 40); this.camera.zoom = 1; this.camera.lookAt(center);
    const reach = this.reach;
    const shadow = this.sun.shadow.camera; shadow.left = -reach; shadow.right = reach; shadow.top = reach; shadow.bottom = -reach; shadow.near = 1; shadow.far = reach * 4 + 80; shadow.updateProjectionMatrix();
    this.resize(); this.controls.update();
    // Put the moon high in the upper-right of the default view: walk down the view ray from that screen point.
    this.camera.updateMatrixWorld();
    const origin = new THREE.Vector3(0.62, 0.74, -1).unproject(this.camera); const direction = new THREE.Vector3(); this.camera.getWorldDirection(direction);
    const height = 24; const along = (origin.y - height) / -direction.y;
    this.moon.group.position.copy(origin).addScaledVector(direction, Math.max(along, 5));
    this.lightingCheckedAt = -Infinity;
  }

  private addDesk(seatId: string, px: number, py: number, leader: boolean, model: Office3DModel): void {
    const root = new THREE.Group(); root.position.set((px + CELL_W / 2) * U, 0.11, (py + 22) * U); this.world.add(root);
    if (leader) { const rug = cube(shared(0x9a3412, { roughness: 1 }), [2.7, 0.02, 3.1], [0, 0.01, 0.35], root); rug.castShadow = false; }
    const wood = shared(0xa16207, { roughness: 0.6 }); const dark = shared(0x713f12); const metal = shared(0x1f2937, { roughness: 0.4, metalness: 0.3 });
    cube(wood, [2.3, 0.12, 0.95], [0, 0.78, -0.35], root);
    for (const [x, z] of [[-1.05, -0.75], [1.05, -0.75], [-1.05, 0.05], [1.05, 0.05]] as const) cube(dark, [0.1, 0.72, 0.1], [x, 0.38, z], root);
    cube(metal, [0.12, 0.3, 0.12], [0, 0.98, -0.6], root);
    cube(metal, [1.05, 0.66, 0.08], [0, 1.42, -0.62], root);
    const screen = new THREE.MeshStandardMaterial({ color: 0x05070a, emissive: 0x05070a, emissiveIntensity: 1.6, roughness: 0.3 });
    const face = cube(screen, [0.92, 0.54, 0.02], [0, 1.42, -0.57], root); face.userData.ownMaterial = true; face.castShadow = false;
    cube(shared(0xd4d4d8), [0.7, 0.04, 0.22], [0, 0.86, -0.15], root);
    const chair = shared(0x374151);
    cube(chair, [0.7, 0.1, 0.65], [0, 0.48, 0.55], root); cube(chair, [0.7, 0.7, 0.1], [0, 0.85, 0.9], root); cube(metal, [0.08, 0.42, 0.08], [0, 0.24, 0.55], root);
    const label3d = label(model.seats.get(seatId)?.title ?? seatId); label3d.position.set(0, 0.3, 1.5); label3d.scale.set(2.7, 0.45, 1); root.add(label3d);
    const person = this.makePerson(seatId, leader, false); person.group.position.set(0, 0.52, 0.55); root.add(person.group);
    this.registerActor(seatId, root, person, screen, false);
  }

  private addLobbyAgent(agentId: string, x: number, z: number, text: string): void {
    const root = new THREE.Group(); root.position.set(x, 0.11, z); this.world.add(root);
    const person = this.makePerson(agentId, false, true); root.add(person.group);
    const tag = label(text, '#94a3b8'); tag.position.set(0, 0.2, 0.9); tag.scale.set(2.2, 0.36, 1); root.add(tag);
    this.registerActor(agentId, root, person, null, true);
  }

  private registerActor(key: string, root: THREE.Group, person: { group: THREE.Group; arms: THREE.Object3D[]; head: THREE.Object3D; materials: THREE.MeshStandardMaterial[] }, screen: THREE.MeshStandardMaterial | null, standing: boolean): void {
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false, transparent: true })); icon.scale.set(0.7, 0.7, 1); icon.position.set(0, 2.45, 0.55); icon.visible = false; icon.userData.sharedMap = true; root.add(icon);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.32, 40), new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.03, standing ? 0 : 0.2); ring.visible = false; ring.userData.ownMaterial = true; root.add(ring);
    const hit = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ visible: false })); hit.scale.set(standing ? 1.6 : CELL_W * U, 2.6, standing ? 1.6 : CELL_H * U); hit.position.set(0, 1.3, standing ? 0 : 0.2);
    hit.userData = standing ? { agentId: key, ownMaterial: true } : { seatId: key, ownMaterial: true }; root.add(hit); this.hitBoxes.push(hit);
    const actor: Actor = { key, status: 'vacant', root, person: person.group, arms: person.arms, head: person.head, screen, icon, ring, phase: (seatHash(key) % 1000) / 159, standing, base: person.group.position.clone(), personMaterials: person.materials };
    this.actors.set(key, actor);
    this.restyle(actor, standing ? 'listening' : this.model?.seats.get(key)?.status ?? 'vacant');
  }

  private makePerson(id: string, leader: boolean, standing: boolean): { group: THREE.Group; arms: THREE.Object3D[]; head: THREE.Object3D; materials: THREE.MeshStandardMaterial[] } {
    const hash = seatHash(id); const group = new THREE.Group();
    const own = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.7, transparent: true });
    const skin = own(SKIN[hash % SKIN.length]!); const hair = own(HAIR[(hash >>> 3) % HAIR.length]!); const shirt = own(SHIRT[(hash >>> 6) % SHIRT.length]!); const pants = own(0x1e293b);
    const materials = [skin, hair, shirt, pants];
    const mark = (mesh: THREE.Mesh): THREE.Mesh => { mesh.userData.ownMaterial = true; return mesh; };
    const torsoY = standing ? 1.05 : 0.5;
    mark(cube(shirt, [0.55, 0.6, 0.34], [0, torsoY, 0], group));
    const head = new THREE.Group(); head.position.set(0, torsoY + 0.55, 0); group.add(head);
    mark(cube(skin, [0.46, 0.44, 0.42], [0, 0, 0], head)); mark(cube(hair, [0.5, 0.14, 0.46], [0, 0.24, 0], head)); mark(cube(hair, [0.5, 0.3, 0.1], [0, 0.08, 0.2], head));
    mark(cube(own(0x0f172a), [0.07, 0.07, 0.02], [-0.11, 0.02, -0.215], head)); mark(cube(own(0x0f172a), [0.07, 0.07, 0.02], [0.11, 0.02, -0.215], head));
    if (leader) { const gold = own(0xfacc15); materials.push(gold); mark(cube(gold, [0.42, 0.1, 0.42], [0, 0.36, 0], head)); for (const x of [-0.15, 0, 0.15]) mark(cube(gold, [0.08, 0.14, 0.08], [x, 0.46, 0], head)); }
    const arms: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.position.set(side * 0.36, torsoY + 0.24, 0); group.add(pivot);
      mark(cube(shirt, [0.16, 0.5, 0.16], [0, -0.24, 0], pivot)); mark(cube(skin, [0.15, 0.1, 0.15], [0, -0.52, 0], pivot)); arms.push(pivot);
      // Seated agents reach forward (−z, towards the monitor) to the keyboard; standing ones let their arms hang.
      if (!standing) pivot.rotation.x = 1.15;
    }
    for (const side of [-1, 1]) {
      if (standing) mark(cube(pants, [0.2, 0.6, 0.22], [side * 0.14, 0.42, 0], group));
      else { mark(cube(pants, [0.2, 0.18, 0.5], [side * 0.14, torsoY - 0.36, -0.2], group)); mark(cube(pants, [0.18, 0.45, 0.18], [side * 0.14, torsoY - 0.62, -0.42], group)); }
    }
    return { group, arms, head, materials };
  }

  private restyle(actor: Actor, status: SeatStatus): void {
    actor.status = status;
    if (actor.person) actor.person.visible = status !== 'vacant';
    for (const material of actor.personMaterials) { material.opacity = status === 'offline' ? 0.28 : 1; material.depthWrite = status !== 'offline'; }
    if (actor.screen) { actor.screen.color.setHex(SCREEN[status]); actor.screen.emissive.setHex(SCREEN[status]); }
    const texture = actor.standing ? null : iconTexture(status);
    actor.icon.visible = Boolean(texture); if (texture) { actor.icon.material.map = texture; actor.icon.material.needsUpdate = true; }
  }

  private refreshSigns(): void {
    if (!this.model) return;
    for (const sign of this.signs) {
      const room = this.model.layout.rooms.find(candidate => candidate.departmentId === sign.roomId); if (!room) continue;
      const online = room.desks.filter(desk => { const status = this.model!.seats.get(desk.seatId)?.status; return status && status !== 'vacant' && status !== 'offline'; }).length;
      const text = `${sign.name}${sign.paused ? '  ·  PAUSED' : ''}  ·  ${online}/${room.desks.length}`;
      if (sign.sprite.userData.text === text) continue;
      sign.sprite.userData.text = text; sign.sprite.material.map?.dispose();
      sign.sprite.material.map = textTexture([{ text, font: 'bold 40px system-ui, sans-serif', color: '#0b0f14' }], 512, 80, sign.paused ? '#f59e0b' : sign.color, 30);
      sign.sprite.material.needsUpdate = true;
    }
  }

  private readonly tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    const t = this.clock.getElapsedTime();
    for (const actor of this.actors.values()) {
      if (!actor.person || !actor.person.visible) continue;
      const phase = t + actor.phase;
      if (actor.standing) {
        actor.person.position.set(actor.base.x + Math.sin(phase * 0.5) * 0.35, actor.base.y + Math.abs(Math.sin(phase * 2.2)) * 0.03, actor.base.z + Math.cos(phase * 0.4) * 0.2);
        actor.person.rotation.y = Math.sin(phase * 0.5) * 0.6;
      } else {
        const typing = actor.status === 'working';
        actor.arms.forEach((arm, index) => { arm.rotation.x = 1.15 + (typing ? Math.sin(phase * 14 + index * Math.PI) * 0.18 : 0); });
        if (actor.head) {
          actor.head.rotation.x = actor.status === 'idle' ? 0.35 + Math.sin(phase) * 0.05 : actor.status === 'blocked' ? Math.sin(phase * 3) * 0.08 : 0;
          actor.head.rotation.y = actor.status === 'listening' ? Math.sin(phase * 0.8) * 0.35 : 0;
        }
        actor.person.position.y = actor.base.y + Math.sin(phase * 1.6) * 0.012;
      }
      if (actor.screen && actor.status === 'working') actor.screen.emissiveIntensity = 1.4 + Math.sin(phase * 9) * 0.3;
      if (actor.icon.visible) {
        actor.icon.position.y = 2.45 + Math.sin(phase * 3) * 0.08;
        actor.icon.material.opacity = actor.status === 'blocked' ? 0.55 + Math.abs(Math.sin(phase * 4)) * 0.45 : 1;
      }
    }
    for (const patron of this.patrons) {
      // Every ~9 s each customer sips (arm up, head back); otherwise they chat, turning to their neighbours.
      const cycle = (t + patron.phase) % 9; const sip = cycle < 1.6 ? Math.sin((Math.PI * cycle) / 1.6) : 0;
      patron.arm.rotation.x = 1.15 + sip * 1.3;
      patron.head.rotation.x = -sip * 0.3;
      patron.head.rotation.y = sip > 0 ? 0 : Math.sin((t + patron.phase) * 0.9) * 0.55;
    }
    if (t - this.lightingCheckedAt > 60) { this.lightingCheckedAt = t; this.applyLighting(); }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private pick(event: MouseEvent): Target3D | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.hitBoxes, false)[0];
    if (!hit) return null;
    const data = hit.object.userData as { seatId?: string; agentId?: string };
    return data.seatId ? { seatId: data.seatId } : data.agentId ? { agentId: data.agentId } : null;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const rect = this.host.getBoundingClientRect();
    this.handlers.onHover(this.pick(event), event.clientX - rect.left, event.clientY - rect.top);
  };
  private readonly onPointerLeave = (): void => { this.handlers.onHover(null, 0, 0); };
  private readonly onPointerDown = (event: PointerEvent): void => { this.downAt = { x: event.clientX, y: event.clientY }; };
  private readonly onClick = (event: MouseEvent): void => {
    // A click that ends a camera drag is not a selection.
    if (this.downAt && Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y) > 5) return;
    this.handlers.onSelect(this.pick(event));
  };
}

/** True when the browser can create a WebGL context; otherwise the map stays 2D. */
export const webglAvailable = (): boolean => {
  try { const canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl')); } catch { return false; }
};
