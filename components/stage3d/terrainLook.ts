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

const GRASS = ["#8fbf62", "#6fa04a", "#5a8c3e", "#7eb056"];
const SAND = ["#e8c878", "#d4b05c", "#c4a050", "#f0d490"];
const STONE = ["#c4c0ba", "#a8a49e", "#8e8a84", "#d4d0ca"];
const WOOD = ["#c49462", "#a87a4c", "#d0a070", "#8e6840"];
const ROAD = ["#6a686e", "#58565c", "#7c7a80", "#4e4c52"];
const TILE = ["#a8b0b8", "#8f99a2", "#b4bcc4", "#7e8890"];
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
  "grass-dark": ["#4c7838", "#3f6830", "#5a8842", "#456f34"],
  "grass-dry": ["#b8a860", "#a89850", "#c4b470", "#988a48"],
  dirt: ["#9a7850", "#886844", "#a8865c", "#7a5e3c"],
  moss: ["#6f9450", "#5f8444", "#7fa45c", "#54783c"],
  mud: ["#6e5844", "#5e4a38", "#7e6650", "#52412f"],
  "stone-dark": ["#6e6a66", "#5e5a56", "#7e7a76", "#524e4a"],
  cobble: ["#98928a", "#867f77", "#a8a29a", "#746e66"],
  "stone-mossy": ["#8a9478", "#788466", "#9aa488", "#687456"],
  "sand-dark": ["#c4a050", "#b08e42", "#d4b05c", "#9c7e3a"],
  "earth-cracked": ["#b89878", "#a68664", "#c8a888", "#947656"],
  snow: ["#f0f4f8", "#e2e8f0", "#f8fbff", "#d6dee8"],
  ice: ["#c0dcec", "#aed0e4", "#d2e8f4", "#9cc4da"],
  ash: ["#5a5654", "#4a4644", "#6a6664", "#3e3a38"],
  "rock-dark": ["#4a4442", "#3c3634", "#585250", "#2f2a28"],
  ember: ["#8a4432", "#a05238", "#743826", "#b8603e"],
  "candy-pink": ["#f4a8c4", "#e894b4", "#fabcd4", "#dc80a4"],
  "candy-mint": ["#a8e4c4", "#94d8b4", "#bcf0d4", "#80cca4"],
  "candy-cream": ["#f8ecd0", "#f0e0bc", "#fef6e2", "#e6d4a8"],
  "candy-lilac": ["#ccb4e4", "#bca0d8", "#dcc8f0", "#ac8ccc"],
  "shadow-purple": ["#5e5470", "#4e4560", "#6e6480", "#423a52"],
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
  return palette[h % palette.length];
}

/** Shade inside the region's own palette. Never a foreign material. */
export function blockHex(gx: number, gz: number, material: PlatformMaterial): string {
  return pick(PALETTE[material] ?? GRASS, hash2(gx, gz));
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

/** Debris tinted to its ground family — sprinkles on candy, scree on snow. */
export function rubbleHex(gx: number, gz: number, material?: PlatformMaterial): string {
  const family = material ?? "";
  if (family.startsWith("candy")) return pick(RUBBLE_CANDY, hash2(gx + 3, gz + 9));
  if (family === "snow" || family === "ice") return pick(RUBBLE_COLD, hash2(gx + 3, gz + 9));
  return pick(RUBBLE, hash2(gx + 3, gz + 9));
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
