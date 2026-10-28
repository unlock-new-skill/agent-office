import * as THREE from 'three';
import { cube, shared } from './office-3d-props.js';

type Person = { group: THREE.Group; arms: THREE.Object3D[]; head: THREE.Object3D };
type SlabFn = (kind: 'concrete' | 'terrazzo', color: number, x: number, z: number, w: number, d: number, y: number, tile?: number) => void;
/** One customer of the tea stall, animated by the scene: sips from the glass in one hand and chats. */
export type Patron = { arm: THREE.Object3D; head: THREE.Object3D; phase: number };
export type Street = { bulbs: THREE.MeshStandardMaterial[]; lights: Array<{ x: number; z: number; size: number }>; patrons: Patron[] };

const VERGE = 1; const NEAR_WALK = 1.6; const ROAD = 7; const FAR_WALK = 5;
const BRAND = 'Truong AAOOEE';
/** Meshes with a material made here (not from the shared cache) are disposed with the world on rebuild. */
const own = (mesh: THREE.Mesh): THREE.Mesh => { mesh.userData.ownMaterial = true; return mesh; };

/** Z bands of the street in front of the building (near sidewalk, road, far sidewalk), from the building's near edge. */
export const streetBand = (frontZ: number): { near: number; road: number; far: number; end: number } => {
  const near = frontZ + VERGE; const road = near + NEAR_WALK; const far = road + ROAD;
  return { near, road, far, end: far + FAR_WALK };
};

const signTexture = (): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 160; const context = canvas.getContext('2d')!;
  context.fillStyle = '#b91c1c'; context.fillRect(0, 0, 512, 160);
  context.strokeStyle = '#fde047'; context.lineWidth = 8; context.strokeRect(8, 8, 496, 144);
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillStyle = '#fde047'; context.font = 'bold 26px system-ui, sans-serif'; context.fillText('TRÀ ĐÁ · HƯỚNG DƯƠNG', 256, 42);
  context.fillStyle = '#ffffff'; context.font = 'bold 58px system-ui, sans-serif'; context.fillText(BRAND, 256, 104);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
};

/** Short Vietnamese plastic stool. */
const stool = (parent: THREE.Object3D, x: number, z: number, color: number): void => {
  const plastic = shared(color, { roughness: 0.5 });
  cube(plastic, [0.44, 0.06, 0.44], [x, 0.33, z], parent);
  for (const [dx, dz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]] as const) cube(plastic, [0.06, 0.3, 0.06], [x + dx, 0.15, z + dz], parent);
};

/** Parked scooter, facing along x. */
const scooter = (parent: THREE.Object3D, x: number, z: number, color: number): void => {
  const body = shared(color, { roughness: 0.35, metalness: 0.2 }); const tyre = shared(0x111827); const chrome = shared(0x9ca3af, { metalness: 0.7, roughness: 0.3 });
  for (const dx of [-0.62, 0.62]) cube(tyre, [0.42, 0.42, 0.14], [x + dx, 0.21, z], parent);
  cube(body, [1.0, 0.3, 0.32], [x - 0.1, 0.48, z], parent); cube(shared(0x1f2937), [0.62, 0.12, 0.34], [x - 0.25, 0.7, z], parent);
  cube(body, [0.16, 0.7, 0.3], [x + 0.5, 0.6, z], parent); cube(chrome, [0.06, 0.06, 0.6], [x + 0.55, 1.0, z], parent);
};

/**
 * A wide road in front of the office with sidewalks, lane markings, a zebra crossing on the entrance path and street
 * lamps, plus a Vietnamese street tea stall on the far sidewalk: cart with a branded sign, string lights, low plastic
 * table and stools, and four customers drinking tea.
 */
export const buildStreet = (parent: THREE.Object3D, slab: SlabFn, makePerson: (id: string) => Person, x0: number, x1: number, frontZ: number): Street => {
  const band = streetBand(frontZ); const left = x0 - 80; const length = x1 - x0 + 160; const entrance = x0 + (x1 - x0) / 2;
  const street: Street = { bulbs: [], lights: [], patrons: [] };
  // Sidewalks sit a little higher than the asphalt so the kerbs read.
  slab('concrete', 0xb8bec7, left, band.near, length, NEAR_WALK, 0.02, 1);
  slab('concrete', 0x3f434b, left, band.road, length, ROAD, -0.02, 3);
  slab('terrazzo', 0xc9b8a0, left, band.far, length, FAR_WALK, 0.02, 1);
  const kerb = shared(0x9ca3af); const paint = shared(0xf8fafc, { roughness: 0.6 }); const yellow = shared(0xfacc15, { roughness: 0.6 });
  for (const z of [band.road, band.far]) cube(kerb, [length, 0.14, 0.16], [left + length / 2, 0.06, z], parent, false);
  for (const z of [band.road + 0.35, band.far - 0.35]) cube(paint, [length, 0.02, 0.1], [left + length / 2, 0.045, z], parent, false);
  const middle = band.road + ROAD / 2;
  cube(yellow, [length, 0.02, 0.08], [left + length / 2, 0.046, middle - 0.08], parent, false); cube(yellow, [length, 0.02, 0.08], [left + length / 2, 0.046, middle + 0.08], parent, false);
  for (let x = left + 1; x < left + length; x += 4) for (const lane of [band.road + ROAD / 4, band.road + (ROAD * 3) / 4]) cube(paint, [1.8, 0.02, 0.1], [x, 0.045, lane], parent, false);
  // Zebra crossing from the office entrance to the stall.
  for (let i = 0; i < 6; i++) cube(paint, [0.45, 0.02, ROAD - 1], [entrance - 1.4 + i * 0.56, 0.05, middle], parent, false);
  slab('concrete', 0xcbd5e1, entrance - 1, frontZ, 2, VERGE, 0, 2);

  // Street lamps on the office side, arms reaching over the road.
  const lampBulb = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd27a, emissiveIntensity: 0.3 }); street.bulbs.push(lampBulb);
  const pole = shared(0x374151, { metalness: 0.5, roughness: 0.4 });
  for (let x = x0 - 24; x <= x1 + 24; x += 12) {
    const z = band.near + 0.4;
    cube(pole, [0.14, 4.2, 0.14], [x, 2.1, z], parent); cube(pole, [0.1, 0.1, 1.4], [x, 4.15, z + 0.7], parent);
    own(cube(lampBulb, [0.4, 0.12, 0.5], [x, 4.05, z + 1.35], parent, false));
  }
  street.lights.push({ x: entrance - 6, z: band.road + 1.5, size: 9 }, { x: entrance + 6, z: band.road + 1.5, size: 9 });

  // The stall, just right of the crossing.
  const sx = entrance + 2.2; const sz = band.far + 1.2;
  const wood = shared(0x92400e, { roughness: 0.7 }); const dark = shared(0x451a03);
  cube(wood, [2.2, 0.9, 0.9], [sx + 1.1, 0.5, sz + 2.6], parent); cube(dark, [2.3, 0.08, 1.0], [sx + 1.1, 0.98, sz + 2.6], parent);
  for (const dx of [0.2, 2.0]) cube(shared(0x111827), [0.3, 0.3, 0.12], [sx + dx, 0.15, sz + 3.1], parent);
  const thermos = shared(0xdc2626, { roughness: 0.35 }); const lid = shared(0xe5e7eb, { metalness: 0.6, roughness: 0.3 });
  for (const [dx, color] of [[0.35, thermos], [0.75, shared(0x16a34a, { roughness: 0.35 })]] as const) { cube(color, [0.28, 0.6, 0.28], [sx + dx, 1.32, sz + 2.6], parent); cube(lid, [0.2, 0.08, 0.2], [sx + dx, 1.66, sz + 2.6], parent); }
  const jar = new THREE.MeshStandardMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.45, roughness: 0.1 });
  for (const [dx, fill] of [[1.25, 0xfbbf24], [1.6, 0x78350f], [1.95, 0xf472b6]] as const) { own(cube(jar, [0.3, 0.4, 0.3], [sx + dx, 1.22, sz + 2.6], parent, false)); cube(shared(fill), [0.24, 0.22, 0.24], [sx + dx, 1.13, sz + 2.6], parent, false); }
  // Sign board standing on the cart, turned towards the default camera.
  // Lit like a light box so it still reads at night; the floating tag keeps the brand legible when zoomed out.
  const sign = signTexture();
  const board = own(new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.82), new THREE.MeshStandardMaterial({ map: sign, emissiveMap: sign, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.6, side: THREE.DoubleSide })));
  board.position.set(sx + 1.1, 2.15, sz + 2.95); board.rotation.y = Math.PI / 4; parent.add(board);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: signTexture(), depthWrite: false })); tag.position.set(sx + 2.6, 4.1, sz + 1.8); tag.scale.set(3.4, 1.06, 1); parent.add(tag);
  for (const dx of [-0.05, 2.25]) cube(dark, [0.08, 1.3, 0.08], [sx + dx, 1.65, sz + 2.95], parent);
  // String lights from the cart to a pole by the kerb.
  const string = new THREE.MeshStandardMaterial({ color: 0xfff7d6, emissive: 0xffc861, emissiveIntensity: 0.3 }); street.bulbs.push(string);
  const poleX = sx + 5.4; const poleZ = band.far + 0.4;
  cube(pole, [0.1, 2.7, 0.1], [poleX, 1.35, poleZ], parent);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8; const x = sx + 2.2 + (poleX - sx - 2.2) * t; const z = sz + 2.95 + (poleZ - sz - 2.95) * t; const sag = Math.sin(t * Math.PI) * 0.35;
    own(cube(string, [0.13, 0.16, 0.13], [x, 2.6 - sag, z], parent, false));
  }
  street.lights.push({ x: sx + 3.6, z: sz + 1.4, size: 7 });

  // Low table, tea and sunflower seeds, four stools with customers.
  const tx = sx + 3.6; const tz = sz + 1.0;
  const table = shared(0x2563eb, { roughness: 0.5 });
  cube(table, [0.9, 0.05, 0.9], [tx, 0.45, tz], parent); for (const [dx, dz] of [[-0.38, -0.38], [0.38, -0.38], [-0.38, 0.38], [0.38, 0.38]] as const) cube(table, [0.06, 0.42, 0.06], [tx + dx, 0.22, tz + dz], parent);
  const tea = new THREE.MeshStandardMaterial({ color: 0xb45309, transparent: true, opacity: 0.75, roughness: 0.1 });
  cube(shared(0xf5f5f4), [0.36, 0.03, 0.36], [tx, 0.49, tz], parent, false); cube(shared(0x1c1917), [0.26, 0.04, 0.26], [tx, 0.51, tz], parent, false);
  cube(shared(0xd6d3d1, { roughness: 0.3 }), [0.22, 0.2, 0.22], [tx + 0.28, 0.58, tz - 0.26], parent);
  const seats: Array<[number, number, number]> = [[0, 0.95, 0xdc2626], [0.95, 0, 0x2563eb], [0, -0.95, 0xdc2626], [-0.95, 0, 0x16a34a]];
  seats.forEach(([dx, dz, color], index) => {
    stool(parent, tx + dx, tz + dz, color);
    const person = makePerson(`tea-guest-${index}`); person.group.position.set(tx + dx, 0.36, tz + dz); person.group.rotation.y = Math.atan2(dx, dz); parent.add(person.group);
    const arm = person.arms[1]!;
    own(cube(tea, [0.12, 0.16, 0.12], [0, -0.6, -0.04], arm, false));
    street.patrons.push({ arm, head: person.head, phase: index * 2.3 });
  });
  scooter(parent, sx - 1.6, band.far + 0.9, 0xe11d48); scooter(parent, sx + 7, band.far + 0.9, 0x0ea5e9);
  return street;
};
