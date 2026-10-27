import * as THREE from 'three';

/** One unit cube scaled per mesh keeps the whole scene on a single geometry. */
export const box = new THREE.BoxGeometry(1, 1, 1);
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

export const shared = (color: number, options: { roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial => {
  const key = `${color}:${options.roughness ?? 0.8}:${options.metalness ?? 0}`;
  let material = materialCache.get(key);
  if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: options.roughness ?? 0.8, metalness: options.metalness ?? 0 }); materialCache.set(key, material); }
  return material;
};

export const cube = (material: THREE.Material, size: [number, number, number], at: [number, number, number], parent: THREE.Object3D, shadow = true): THREE.Mesh => {
  const mesh = new THREE.Mesh(box, material); mesh.scale.set(...size); mesh.position.set(...at);
  mesh.castShadow = shadow; mesh.receiveShadow = true; parent.add(mesh); return mesh;
};

export type FloorKind = 'wood' | 'carpet' | 'tile' | 'terrazzo' | 'concrete';
export const ZONE_FLOORS: FloorKind[] = ['wood', 'carpet', 'tile', 'terrazzo'];

/** Greyscale floor patterns, tinted per zone through the material colour. */
export const floorTexture = (kind: FloorKind): THREE.CanvasTexture => {
  const size = 128; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const context = canvas.getContext('2d')!;
  let seed = kind.length * 977; const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === 'wood') {
    for (let row = 0; row < 8; row++) {
      const offset = (row % 2) * 48;
      for (let x = -offset; x < size; x += 96) {
        const tone = 205 + Math.floor(random() * 40); context.fillStyle = `rgb(${tone},${tone - 6},${tone - 14})`; context.fillRect(x, row * 16, 96, 16);
        context.fillStyle = 'rgba(0,0,0,0.18)'; context.fillRect(x, row * 16, 1, 16);
        for (let grain = 0; grain < 3; grain++) { context.fillStyle = 'rgba(0,0,0,0.06)'; context.fillRect(x + random() * 90, row * 16 + 3 + grain * 4, 24 + random() * 30, 1); }
      }
      context.fillStyle = 'rgba(0,0,0,0.22)'; context.fillRect(0, row * 16 + 15, size, 1);
    }
  } else if (kind === 'carpet') {
    context.fillStyle = '#e7e7e7'; context.fillRect(0, 0, size, size);
    for (let i = 0; i < 2400; i++) { const tone = 200 + Math.floor(random() * 55); context.fillStyle = `rgb(${tone},${tone},${tone})`; context.fillRect(random() * size, random() * size, 2, 2); }
  } else if (kind === 'tile') {
    context.fillStyle = '#f4f4f4'; context.fillRect(0, 0, size, size);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const tone = 236 + Math.floor(random() * 16); context.fillStyle = `rgb(${tone},${tone},${tone})`; context.fillRect(x * 32 + 1, y * 32 + 1, 30, 30); }
    context.fillStyle = '#b8bcc2'; for (let i = 0; i <= 4; i++) { context.fillRect(i * 32 - 1, 0, 2, size); context.fillRect(0, i * 32 - 1, size, 2); }
  } else if (kind === 'terrazzo') {
    context.fillStyle = '#ececec'; context.fillRect(0, 0, size, size);
    const chips = ['#9ca3af', '#6b7280', '#d1d5db', '#78716c', '#a8a29e'];
    for (let i = 0; i < 260; i++) { context.fillStyle = chips[Math.floor(random() * chips.length)]!; const s = 1 + random() * 4; context.fillRect(random() * size, random() * size, s, s * (0.6 + random())); }
  } else {
    context.fillStyle = '#d4d4d4'; context.fillRect(0, 0, size, size);
    for (let i = 0; i < 900; i++) { const tone = 190 + Math.floor(random() * 40); context.fillStyle = `rgba(${tone},${tone},${tone},0.6)`; context.fillRect(random() * size, random() * size, 3, 3); }
    context.fillStyle = 'rgba(0,0,0,0.12)'; context.fillRect(0, 0, size, 1); context.fillRect(0, 0, 1, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
};

/** Potted plant; `tall` makes an indoor tree for corners and windows. */
export const makePlant = (parent: THREE.Object3D, x: number, z: number, tall = false, seed = 0): void => {
  const group = new THREE.Group(); group.position.set(x, 0.06, z); group.rotation.y = seed * 1.3; parent.add(group);
  const pot = shared(tall ? 0xe7e5e4 : 0xb45309, { roughness: 0.6 });
  cube(pot, tall ? [0.75, 0.6, 0.75] : [0.5, 0.42, 0.5], [0, tall ? 0.3 : 0.21, 0], group);
  cube(shared(0x3f2a1d), tall ? [0.62, 0.05, 0.62] : [0.4, 0.05, 0.4], [0, tall ? 0.61 : 0.43, 0], group, false);
  const leaf = [shared(0x15803d, { roughness: 0.9 }), shared(0x16a34a, { roughness: 0.9 }), shared(0x22c55e, { roughness: 0.9 })];
  if (tall) {
    cube(shared(0x6b4423), [0.14, 1.5, 0.14], [0, 1.3, 0], group);
    const crowns: Array<[number, number, number, number]> = [[0, 2.15, 0, 1.25], [0.25, 2.75, 0.1, 0.95], [-0.2, 2.6, -0.2, 0.85], [0.05, 3.2, 0, 0.6]];
    crowns.forEach(([cx, cy, cz, s], index) => { const mesh = cube(leaf[index % leaf.length]!, [s, s * 0.8, s], [cx, cy, cz], group); mesh.rotation.y = index * 0.7; });
  } else {
    const tufts: Array<[number, number, number, number]> = [[0, 0.7, 0, 0.5], [0.15, 0.95, 0.05, 0.35], [-0.12, 0.88, -0.1, 0.3]];
    tufts.forEach(([cx, cy, cz, s], index) => { const mesh = cube(leaf[index % leaf.length]!, [s, s, s], [cx, cy, cz], group); mesh.rotation.y = index * 0.9; });
  }
};

/** Pendant ceiling lamp (a glowing shade on a cord); returns its material so the night can light it up. */
export const makePendantLamp = (parent: THREE.Object3D, x: number, z: number, height = 4.4): THREE.MeshStandardMaterial => {
  const group = new THREE.Group(); group.position.set(x, 0, z); parent.add(group);
  cube(shared(0x9ca3af), [0.025, 1.2, 0.025], [0, height + 0.7, 0], group, false);
  const glow = new THREE.MeshStandardMaterial({ color: 0xf8f4ea, emissive: 0xffd88a, emissiveIntensity: 0.3, roughness: 0.6 });
  const shade = cube(glow, [0.5, 0.18, 0.5], [0, height, 0], group, false); shade.userData.ownMaterial = true;
  return glow;
};

export const makeSofa = (parent: THREE.Object3D, x: number, z: number, rotation: number, color = 0x475569): void => {
  const group = new THREE.Group(); group.position.set(x, 0.06, z); group.rotation.y = rotation; parent.add(group);
  const fabric = shared(color, { roughness: 0.95 }); const cushion = shared(new THREE.Color(color).offsetHSL(0, 0, 0.08).getHex(), { roughness: 0.95 });
  cube(fabric, [2.4, 0.35, 0.9], [0, 0.25, 0], group); cube(fabric, [2.4, 0.6, 0.25], [0, 0.6, -0.33], group);
  cube(fabric, [0.25, 0.5, 0.9], [-1.1, 0.45, 0], group); cube(fabric, [0.25, 0.5, 0.9], [1.1, 0.45, 0], group);
  cube(cushion, [0.95, 0.12, 0.6], [-0.48, 0.48, 0.05], group); cube(cushion, [0.95, 0.12, 0.6], [0.48, 0.48, 0.05], group);
};

export const makeCoffeeTable = (parent: THREE.Object3D, x: number, z: number): void => {
  const wood = shared(0x92400e, { roughness: 0.5 });
  cube(wood, [1.4, 0.08, 0.7], [x, 0.45, z], parent); cube(shared(0x1f2937), [0.08, 0.38, 0.08], [x - 0.6, 0.25, z], parent); cube(shared(0x1f2937), [0.08, 0.38, 0.08], [x + 0.6, 0.25, z], parent);
  cube(shared(0xf5f5f4), [0.18, 0.2, 0.18], [x + 0.3, 0.6, z + 0.1], parent); // mug
};

/** Pantry: counter with coffee machine, fridge and two bistro tables. Occupies about 6 × 5 units from (x, z). */
export const makePantry = (parent: THREE.Object3D, x: number, z: number): void => {
  const counter = shared(0xe7e5e4, { roughness: 0.4 }); const top = shared(0x44403c, { roughness: 0.3 });
  cube(counter, [4.2, 0.9, 0.8], [x + 2.1, 0.5, z + 0.5], parent); cube(top, [4.3, 0.08, 0.85], [x + 2.1, 0.98, z + 0.5], parent);
  cube(shared(0x9ca3af, { roughness: 0.3, metalness: 0.6 }), [0.9, 1.9, 0.8], [x + 4.8, 1.0, z + 0.5], parent); // fridge
  cube(shared(0x111827, { roughness: 0.4 }), [0.45, 0.55, 0.45], [x + 0.6, 1.3, z + 0.45], parent); // coffee machine
  cube(shared(0xdc2626), [0.12, 0.12, 0.05], [x + 0.6, 1.35, z + 0.69], parent, false);
  for (const [tx, tz] of [[x + 1.4, z + 2.8], [x + 3.8, z + 2.8]] as const) {
    cube(shared(0xfafaf9, { roughness: 0.35 }), [0.9, 0.06, 0.9], [tx, 0.8, tz], parent); cube(shared(0x1f2937), [0.08, 0.75, 0.08], [tx, 0.42, tz], parent);
    for (const side of [-1, 1]) cube(shared(0xf59e0b, { roughness: 0.7 }), [0.4, 0.06, 0.4], [tx + side * 0.75, 0.55, tz], parent);
  }
};
