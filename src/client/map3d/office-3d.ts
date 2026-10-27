import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatStatus } from '../state/office-store.js';
import { CELL_H, CELL_W, TILE, seatHash, type MapLayout } from '../map/office-map-layout.js';
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
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR = [0x2b1d14, 0x5a3825, 0xa0522d, 0xd8b04c, 0x1f2937, 0x7c2d12];
const SHIRT = [0x3b82f6, 0xef4444, 0x10b981, 0x8b5cf6, 0xf59e0b, 0xec4899, 0x14b8a6, 0x6366f1];
const SCREEN: Record<SeatStatus, number> = { working: 0x60a5fa, listening: 0x22c55e, blocked: 0xf59e0b, wake_limited: 0xf87171, idle: 0x334155, offline: 0x05070a, vacant: 0x05070a };
const ICON: Partial<Record<SeatStatus, { text: string; bg: string; fg: string }>> = {
  blocked: { text: '!', bg: '#f59e0b', fg: '#1f1300' }, wake_limited: { text: '✕', bg: '#f87171', fg: '#2a0a0a' },
  idle: { text: 'Zz', bg: '#cbd5e1', fg: '#1e293b' }, listening: { text: '…', bg: '#e2e8f0', fg: '#16a34a' },
};

const box = new THREE.BoxGeometry(1, 1, 1);
const materialCache = new Map<string, THREE.MeshStandardMaterial>();
const shared = (color: number, options: { roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial => {
  const key = `${color}:${options.roughness ?? 0.8}:${options.metalness ?? 0}`;
  let material = materialCache.get(key);
  if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: options.roughness ?? 0.8, metalness: options.metalness ?? 0 }); materialCache.set(key, material); }
  return material;
};
const cube = (material: THREE.Material, size: [number, number, number], at: [number, number, number], parent: THREE.Object3D): THREE.Mesh => {
  const mesh = new THREE.Mesh(box, material); mesh.scale.set(...size); mesh.position.set(...at); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
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
const floorTexture = (): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const context = canvas.getContext('2d')!;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { context.fillStyle = (x + y) % 2 ? '#d9dde3' : '#ffffff'; context.fillRect(x * 32, y * 32, 32, 32); }
  const texture = new THREE.CanvasTexture(canvas); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.NearestFilter;
  return texture;
};

/**
 * Low-poly isometric office: rooms per department, a desk per seat and voxel agents whose screen glow, pose and
 * floating icon show their live status. Rebuilds geometry only when the org layout changes; status changes just
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
  private readonly floorMap = floorTexture();
  private downAt: { x: number; y: number } | null = null;

  constructor(private readonly host: HTMLElement, private readonly handlers: Handlers) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0e1116);
    this.scene.fog = new THREE.Fog(0x0e1116, 80, 160);
    this.scene.add(new THREE.HemisphereLight(0xdbe7ff, 0x2a2f38, 1.9));
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0005; this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.world);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x11151b, roughness: 1 }));
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
    this.clearWorld(); this.floorMap.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
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
    this.world.clear(); this.actors.clear(); this.hitBoxes = []; this.signs = [];
  }

  private rebuild(model: Office3DModel): void {
    this.clearWorld();
    const { layout } = model;
    for (const room of layout.rooms) {
      const x0 = room.x * U; const z0 = room.y * U; const w = room.w * U; const d = room.h * U;
      const tint = new THREE.Color(room.color).lerp(new THREE.Color(0x3a404a), room.paused ? 0.9 : 0.72);
      const floorMaterial = new THREE.MeshStandardMaterial({ color: tint, map: this.floorMap.clone(), roughness: 0.9 });
      floorMaterial.map!.repeat.set(w / 2, d / 2); floorMaterial.map!.needsUpdate = true;
      const floor = cube(floorMaterial, [w, 0.12, d], [x0 + w / 2, 0, z0 + d / 2], this.world); floor.castShadow = false; floor.userData.ownMaterial = true;
      const wall = shared(new THREE.Color(room.color).lerp(new THREE.Color(0x111827), 0.55).getHex());
      const trim = shared(new THREE.Color(room.color).getHex(), { roughness: 0.4 });
      cube(wall, [w, 1.3, 0.25], [x0 + w / 2, 0.65, z0 + 0.125], this.world);
      cube(wall, [0.25, 1.3, d], [x0 + 0.125, 0.65, z0 + d / 2], this.world);
      cube(trim, [w, 0.1, 0.3], [x0 + w / 2, 1.33, z0 + 0.125], this.world);
      cube(trim, [0.3, 0.1, d], [x0 + 0.125, 1.33, z0 + d / 2], this.world);
      const sign = label(room.name); sign.position.set(x0 + w / 2, 2.1, z0 + 0.4); sign.scale.set(Math.min(w * 0.8, 6), 0.75, 1); this.world.add(sign);
      this.signs.push({ sprite: sign, roomId: room.departmentId, name: room.name, color: room.color, paused: room.paused });
      for (const desk of room.desks) this.addDesk(desk.seatId, desk.x, desk.y, desk.leader, model);
    }
    if (layout.lobby) {
      const lobby = layout.lobby; const x0 = lobby.x * U; const z0 = lobby.y * U; const w = lobby.w * U; const d = lobby.h * U;
      const floor = cube(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 }), [w, 0.12, d], [x0 + w / 2, 0, z0 + d / 2], this.world); floor.castShadow = false; floor.userData.ownMaterial = true;
      cube(shared(0x475569), [w, 0.5, 0.2], [x0 + w / 2, 0.25, z0 + 0.1], this.world);
      const sign = label('Lobby'); sign.position.set(x0 + w / 2, 1.3, z0 + 0.5); sign.scale.set(3, 0.6, 1); this.world.add(sign);
      // Two potted plants make the lobby read as a waiting area.
      for (const corner of [x0 + 0.6, x0 + w - 0.6]) { cube(shared(0x7c4a2d), [0.5, 0.45, 0.5], [corner, 0.28, z0 + 0.7], this.world); cube(shared(0x16a34a), [0.7, 0.7, 0.7], [corner, 0.85, z0 + 0.7], this.world); }
      for (const spot of lobby.spots) this.addLobbyAgent(spot.agentId, (spot.x + 20) * U, (spot.y + 30) * U, model.lobbyLabels.get(spot.agentId) ?? spot.agentId);
    }
    this.frameScene(layout);
  }

  private frameScene(layout: MapLayout): void {
    const width = layout.width * U; const depth = layout.height * U; const center = new THREE.Vector3(width / 2, 0, depth / 2);
    // Seen diagonally, the floor's on-screen height is about a third of width + depth; keep a margin for walls and signs.
    this.span = (width + depth) * 0.36 + 4;
    this.controls.target.copy(center);
    this.camera.position.set(center.x + 40, 42, center.z + 40); this.camera.zoom = 1; this.camera.lookAt(center);
    const reach = Math.max(width, depth);
    this.sun.position.set(center.x - reach * 0.35, 40, center.z - reach * 0.1); this.sun.target.position.copy(center);
    const shadow = this.sun.shadow.camera; shadow.left = -reach; shadow.right = reach; shadow.top = reach; shadow.bottom = -reach; shadow.near = 1; shadow.far = 140; shadow.updateProjectionMatrix();
    this.resize(); this.controls.update();
  }

  private addDesk(seatId: string, px: number, py: number, leader: boolean, model: Office3DModel): void {
    const root = new THREE.Group(); root.position.set((px + CELL_W / 2) * U, 0.06, (py + 22) * U); this.world.add(root);
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
    const root = new THREE.Group(); root.position.set(x, 0.06, z); this.world.add(root);
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
