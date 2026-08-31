/**
 * Voxel ground look — one biome, one palette. Blocks jitter in shade and
 * height; charcoal rubble sits on top. No grout, no foreign mix-ins.
 */
import * as THREE from "three";
import { DECK_BLOCK } from "@/lib/composition/grid3d";
import type { PlatformMaterial } from "@/lib/composition/types";

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
const PATH = ["#d6cdb8", "#cfc4aa", "#ddd4c0"];
const RUBBLE = ["#4a4a4e", "#3a3a3e", "#58565c", "#2e2e32"];

const PALETTE: Record<PlatformMaterial, string[]> = {
  grass: GRASS,
  sand: SAND,
  stone: STONE,
  wood: WOOD,
  road: ROAD,
  tile: TILE,
};

export const FLANK: Record<PlatformMaterial, string> = {
  grass: "#5a7040",
  stone: "#7c766c",
  wood: "#8a6844",
  sand: "#b09a6d",
  road: "#45434a",
  tile: "#6f7880",
};

/** Plinth top, peeking in the hairline between voxels. */
export const DECK_FILL: Record<PlatformMaterial, string> = {
  grass: "#6fa04a",
  stone: "#a8a49e",
  wood: "#a87a4c",
  sand: "#d4b05c",
  road: "#58565c",
  tile: "#8f99a2",
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
  return pick(PALETTE[material], hash2(gx, gz));
}

export function waterHex(gx: number, gz: number): string {
  return pick(WATER, hash2(gx, gz));
}

export function pathHex(col: number, row: number): string {
  return pick(PATH, hash2(col, row));
}

export function rubbleHex(gx: number, gz: number): string {
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
