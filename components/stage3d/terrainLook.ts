/**
 * Voxel ground look — one biome, one palette. Blocks jitter in shade and
 * height; charcoal rubble sits on top. No grout, no foreign mix-ins.
 */
import * as THREE from "three";
import { DECK_BLOCK } from "@/lib/composition/grid3d";
import type { PlatformMaterial, WaterTone } from "@/lib/composition/types";

export { DECK_BLOCK };

/** Subdivisions per lot. 2×2 cubes so a region reads as voxels, not a spreadsheet. */
export const GROUND_SUB = 2;

const GRASS = ["#8fbf62", "#6fa04a", "#5a8c3e", "#7eb056", "#a8c878", "#4a9038"];
const SAND = ["#e8c878", "#d4b05c", "#c4a050", "#f0d490", "#f4b868", "#b89048"];
const STONE = ["#c4c0ba", "#a8a49e", "#8e8a84", "#d4d0ca", "#989088", "#b8b4ae"];
const WOOD = ["#c49462", "#a87a4c", "#d0a070", "#8e6840", "#b88458", "#d8b080"];
const ROAD = ["#6a686e", "#58565c", "#7c7a80", "#4e4c52", "#747278", "#626068"];
const TILE = ["#a8b0b8", "#8f99a2", "#b4bcc4", "#7e8890", "#c0c8d0", "#9aa4ac"];
const WATER = ["#4a7eaa", "#3f739c", "#5a8cb8", "#35688e"];
const WATER_DEEP = ["#35688e", "#2d5a7a", "#3f739c", "#285878"];
const WATER_MID = ["#4a7eaa", "#4678a0", "#5a8cb8", "#3f739c"];
const WATER_BRIGHT = ["#5a8cb8", "#6a9cc8", "#7aacd0", "#4a8ab0"];
const WATER_DARK = ["#2a5070", "#254a68", "#325e82", "#1e4058"];
const WATER_FAMILIES = [WATER_DEEP, WATER_MID, WATER_BRIGHT, WATER_DARK] as const;
const PATH = ["#d6cdb8", "#cfc4aa", "#ddd4c0"];
const RUBBLE = ["#4a4a4e", "#3a3a3e", "#58565c", "#2e2e32"];

/** Every themed ground material: 4 in-family shades. Patches read as one
 * ecosystem because families are tuned to sit beside each other. */
const PALETTE: Record<PlatformMaterial, string[]> = {
  grass: GRASS,
  sand: SAND,
  stone: STONE,
  wood: WOOD,
  road: ROAD,
  tile: TILE,
  "grass-dark": ["#4c7838", "#3f6830", "#5a8842", "#456f34", "#688850", "#385828"],
  "grass-dry": ["#b8a860", "#a89850", "#c4b470", "#988a48", "#d4b878", "#c89840"],
  dirt: ["#9a7850", "#886844", "#a8865c", "#7a5e3c", "#b89060", "#6e5030"],
  moss: ["#6f9450", "#5f8444", "#7fa45c", "#54783c", "#88a868", "#507838"],
  mud: ["#6e5844", "#5e4a38", "#7e6650", "#52412f", "#907058", "#483828"],
  "stone-dark": ["#6e6a66", "#5e5a56", "#7e7a76", "#524e4a", "#888480", "#4a4642"],
  cobble: ["#98928a", "#867f77", "#a8a29a", "#746e66", "#b0aaa0", "#686058"],
  "stone-mossy": ["#8a9478", "#788466", "#9aa488", "#687456", "#a8b090", "#607048"],
  "sand-dark": ["#c4a050", "#b08e42", "#d4b05c", "#9c7e3a", "#e0b868", "#a87830"],
  "earth-cracked": ["#b89878", "#a68664", "#c8a888", "#947656", "#d8b898", "#886848"],
  ochre: ["#e8a840", "#d49030", "#f0b850", "#c07828", "#f8c868", "#b06820"],
  terracotta: ["#c86048", "#b85038", "#d87058", "#a04030", "#e87860", "#903828"],
  coral: ["#f08878", "#e07060", "#f8a090", "#d05848", "#f89888", "#c84838"],
  snow: ["#f0f4f8", "#e2e8f0", "#f8fbff", "#d6dee8", "#fafcff", "#c8d4e0"],
  ice: ["#c0dcec", "#aed0e4", "#d2e8f4", "#9cc4da", "#dceef8", "#8cb8d0"],
  ash: ["#5a5654", "#4a4644", "#6a6664", "#3e3a38", "#7a7674", "#343030"],
  "rock-dark": ["#4a4442", "#3c3634", "#585250", "#2f2a28", "#686260", "#282422"],
  ember: ["#8a4432", "#a05238", "#743826", "#b8603e", "#c87048", "#903020"],
  "candy-pink": ["#f4a8c4", "#e894b4", "#fabcd4", "#dc80a4", "#ffc0d8", "#d06898"],
  "candy-mint": ["#a8e4c4", "#94d8b4", "#bcf0d4", "#80cca4", "#c8f8e0", "#70c098"],
  "candy-cream": ["#f8ecd0", "#f0e0bc", "#fef6e2", "#e6d4a8", "#fff8e8", "#dcc898"],
  "candy-lilac": ["#ccb4e4", "#bca0d8", "#dcc8f0", "#ac8ccc", "#e8d8f8", "#9878c0"],
  "shadow-purple": ["#5e5470", "#4e4560", "#6e6480", "#423a52", "#807890", "#383048"],
};

/** Warm/cool flashes inside a lot — seeded per sub-voxel, never per-block noise. */
const SPECKLE: Partial<Record<PlatformMaterial, string[]>> = {
  grass: ["#d4a848", "#c87858", "#e8b868", "#b89048", "#f0a878"],
  "grass-dark": ["#8a6840", "#a87850", "#687838", "#c89848"],
  "grass-dry": ["#e87850", "#d86040", "#f0a868", "#c84838", "#f08868"],
  sand: ["#f08860", "#e87048", "#f8b878", "#d85838", "#f0a068"],
  "sand-dark": ["#e87848", "#d06030", "#f09858", "#c04828"],
  dirt: ["#c87848", "#b86038", "#d89058", "#a04828"],
  stone: ["#c8a898", "#b89078", "#d8b8a0", "#a87858"],
  cobble: ["#c89878", "#b88060", "#d8a890", "#a86848"],
  "earth-cracked": ["#e87850", "#d86038", "#f0a070", "#c04828"],
  ember: ["#e87848", "#f09860", "#d04828", "#ff8868"],
  ochre: ["#f8c048", "#e8a030", "#ffd060", "#d08820"],
  terracotta: ["#f07860", "#e06048", "#ff9078", "#c04030"],
  coral: ["#ffa898", "#f08878", "#ffb8a8", "#e06858"],
  moss: ["#a8c860", "#98b850", "#b8d870", "#789838"],
  mud: ["#a87850", "#987040", "#b89060", "#806030"],
  tile: ["#c8b0a0", "#b89888", "#d8c0b0", "#a88070"],
  road: ["#8a7870", "#7a6860", "#9a8880", "#6a5850"],
  "candy-pink": ["#ffe0e8", "#ffc0d0", "#ffb0c8", "#f0a0b8"],
  "candy-cream": ["#fff8e8", "#ffe8c8", "#fff0d8", "#f0d8a8"],
};

export const FLANK: Record<PlatformMaterial, string> = {
  grass: "#5a7040",
  stone: "#7c766c",
  wood: "#8a6844",
  sand: "#b09a6d",
  road: "#45434a",
  tile: "#6f7880",
  "grass-dark": "#3a5228",
  "grass-dry": "#847540",
  dirt: "#6a5138",
  moss: "#4c6438",
  mud: "#463628",
  "stone-dark": "#48443f",
  cobble: "#645e56",
  "stone-mossy": "#5c644c",
  "sand-dark": "#8a6f34",
  "earth-cracked": "#7c6248",
  ochre: "#d49030",
  terracotta: "#b85038",
  coral: "#e07060",
  snow: "#b8c4d4",
  ice: "#84a8c0",
  ash: "#36322f",
  "rock-dark": "#242020",
  ember: "#5c2c1e",
  "candy-pink": "#c06890",
  "candy-mint": "#68b088",
  "candy-cream": "#ccb888",
  "candy-lilac": "#9074b4",
  "shadow-purple": "#342e42",
};

/** Plinth top, peeking in the hairline between voxels. */
export const DECK_FILL: Record<PlatformMaterial, string> = {
  grass: "#6fa04a",
  stone: "#a8a49e",
  wood: "#a87a4c",
  sand: "#d4b05c",
  road: "#58565c",
  tile: "#8f99a2",
  "grass-dark": "#3f6830",
  "grass-dry": "#a89850",
  dirt: "#886844",
  moss: "#5f8444",
  mud: "#5e4a38",
  "stone-dark": "#5e5a56",
  cobble: "#867f77",
  "stone-mossy": "#788466",
  "sand-dark": "#b08e42",
  "earth-cracked": "#a68664",
  ochre: "#e8a840",
  terracotta: "#c86048",
  coral: "#f08878",
  snow: "#e2e8f0",
  ice: "#aed0e4",
  ash: "#4a4644",
  "rock-dark": "#3c3634",
  ember: "#a05238",
  "candy-pink": "#e894b4",
  "candy-mint": "#94d8b4",
  "candy-cream": "#f0e0bc",
  "candy-lilac": "#bca0d8",
  "shadow-purple": "#4e4560",
};

export const WATER_FILL = "#35688e";

export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function pick(palette: string[], h: number): string {
  // Hashes are unsigned but callers shift them; keep the index in range.
  return palette[Math.abs(h) % palette.length];
}

/** Shade inside the region's own palette, with occasional warm speckles. */
export function blockHex(gx: number, gz: number, material: PlatformMaterial): string {
  const h = hash2(gx, gz);
  const speckles = SPECKLE[material];
  // ~14% of sub-voxels flash a warmer accent within the same biome family.
  if (speckles && h % 7 === 0) return pick(speckles, hash2(gx + 11, gz + 17));
  return pick(PALETTE[material] ?? GRASS, h);
}

/** Themed walk color — falls back to the classic pale path. */
export function pathHexFor(col: number, row: number, material?: PlatformMaterial): string {
  if (!material) return pick(PATH, hash2(col, row));
  return pick(PALETTE[material] ?? PATH, hash2(col, row));
}

export function waterHex(gx: number, gz: number, tone?: WaterTone): string {
  const palette = tone != null ? WATER_FAMILIES[tone] : WATER;
  return pick(palette, hash2(gx, gz));
}

export function pathHex(col: number, row: number): string {
  return pick(PATH, hash2(col, row));
}

const RUBBLE_CANDY = ["#f8f4ff", "#e894b4", "#8a5c44", "#fef6e2"];
const RUBBLE_COLD = ["#8ea4b8", "#7a92a8", "#a4b8c8", "#6a8298"];

const PEBBLE_PALE = ["#cfcac0", "#bdb8ae", "#dcd7cc", "#aaa59b"];

/** Darken a hex color by `k` (0..1). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 - k))));
  return `#${((f(n >> 16) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).padStart(6, "0")}`;
}

/** Debris tinted to its ground family — sprinkles on candy, scree on snow,
 * and elsewhere a mix of dark stone, a darker shade of the ground itself,
 * and the odd pale pebble. */
export function rubbleHex(gx: number, gz: number, material?: PlatformMaterial): string {
  const family = material ?? "";
  const h = hash2(gx + 3, gz + 9);
  if (family.startsWith("candy")) return pick(RUBBLE_CANDY, h);
  if (family === "snow" || family === "ice") return pick(RUBBLE_COLD, h);
  const roll = h % 10;
  if (roll < 4) return pick(RUBBLE, h);
  if (roll < 8 && material) return shade(pick(PALETTE[material] ?? GRASS, h >>> 2), 0.32);
  return pick(PEBBLE_PALE, h >>> 3);
}

/** Rubble shape for a sub-lot: 0 a squared rock, 1 a rounded pebble, 2 a flat slab. */
export function rubbleShape(gx: number, gz: number): 0 | 1 | 2 {
  const r = hash2(gx + 21, gz + 5) % 10;
  return r < 4 ? 0 : r < 8 ? 1 : 2;
}

/** Extra pebbles beside the rubble — small, rounded, a little more common. */
export function isPebble(gx: number, gz: number): boolean {
  return hash2(gx + 5, gz + 7) % 12 === 0;
}

/** Extra height on a minority of cubes so the floor is jagged, not a slab. */
export function blockLift(gx: number, gz: number): number {
  const t = hash2(gx, gz) % 8;
  if (t === 0) return 0.18;
  if (t === 1) return 0.1;
  if (t === 2) return 0.05;
  return 0;
}

/** Sparse charcoal cubes clustered like the reference rubble. */
export function isRubble(gx: number, gz: number): boolean {
  const h = hash2(gx, gz);
  if (h % 16 === 0) return true;
  if (hash2(gx - 1, gz) % 16 === 0 && h % 3 === 0) return true;
  if (hash2(gx, gz - 1) % 16 === 0 && h % 3 === 1) return true;
  return false;
}

let grain: THREE.CanvasTexture | null = null;

function hashNoise(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Quiet grain for walls and stairs only — ground cubes stay flat-shaded. */
export function getGrainTexture(): THREE.CanvasTexture | null {
  if (grain) return grain;
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 210 + Math.floor(hashNoise(i * 0.13) * 40);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grain = new THREE.CanvasTexture(canvas);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.colorSpace = THREE.NoColorSpace;
  grain.anisotropy = 4;
  grain.needsUpdate = true;
  return grain;
}
