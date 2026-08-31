"use client";

import type { CatalogItem, CatalogKind } from "./catalog";

/**
 * Isometric lot projection and sprite anchoring.
 *
 * Lots project to screen diamonds through isoOf/isoToGrid only. Sprites
 * anchor to their lot through their alpha content box (never their
 * transparent padding), and every kind maps to one canonical world scale.
 */

/** Diamond footprint of one lot in board units (2:1 isometric). */
export const TILE_W = 10;
export const TILE_H = 5;
/** Placement snaps to half-lots so pieces can stand next to each other. */
export const LOT_STEP = 0.5;

export function snapLotCoord(n: number) {
  return Math.round(n / LOT_STEP) * LOT_STEP;
}

/** Source sprites are normalized to this square (64px previews upscaled 4x). */
const BASE_PX = 256;

/** Center of lot (col,row)'s top face in board space. */
export function isoOf(col: number, row: number) {
  return {
    x: ((col - row) * TILE_W) / 2,
    y: ((col + row) * TILE_H) / 2,
  };
}

/** Ground contact under a sprite — the pivot for flip. */
export function groundOf(col: number, row: number) {
  const { x, y } = isoOf(col, row);
  return { x, y: y + TILE_H * 0.36 };
}

/** Inverse of isoOf — board point to fractional (col,row). */
export function isoToGrid(x: number, y: number) {
  return {
    col: x / TILE_W + y / TILE_H,
    row: y / TILE_H - x / TILE_W,
  };
}

/** The four corners of a lot's top face, for grid/hover/selection diamonds. */
export function diamondPoints(col: number, row: number, scale = 1): string {
  const { x, y } = isoOf(col, row);
  const hw = (TILE_W / 2) * scale;
  const hh = (TILE_H / 2) * scale;
  return [`${x},${y - hh}`, `${x + hw},${y}`, `${x},${y + hh}`, `${x - hw},${y}`].join(" ");
}

/**
 * Canonical world scale per kind, as a fraction of tile width. The preview
 * renders frame every object at roughly the same size regardless of what it
 * is, so relative scale is restored here — one table, never per-object
 * tweaks. A character should not dwarf a car; a ship should outsize both.
 */
const KIND_SCALE: Record<CatalogKind, number> = {
  character: 0.92,
  prop: 0.82,
  crate: 0.68,
  stall: 0.88,
  machine: 0.86,
  tree: 0.95,
  ramp: 0.95,
  dungeon: 0.86,
  boat: 1.0,
  pirate: 0.95,
  car: 0.88,
  other: 0.86,
  pet: 0.78,
  food: 0.62,
  furniture: 0.88,
  building: 1.05,
  cave: 0.95,
  space: 0.95,
  nature: 0.92,
  coaster: 0.95,
};

/**
 * Render box for a catalog sprite standing on lot (col,row).
 *
 * The alpha content box anchors the object's base to the tile (bottom-center
 * anchor); transparent padding never affects world position. Aspect ratio is
 * preserved — sprites are scaled, never stretched.
 */
export function catalogBox(item: CatalogItem, col: number, row: number) {
  const scale = (TILE_W * (KIND_SCALE[item.kind] ?? 0.8)) / BASE_PX;
  const w = item.px[0] * scale;
  const h = item.px[1] * scale;
  const { x, y } = isoOf(col, row);
  const contentBottom = (item.content[1] + item.content[3]) * scale;
  const feetY = y + TILE_H * 0.34;
  return { x: x - w / 2, y: feetY - contentBottom, w, h };
}

/** Tight alpha box of a sprite — use for hover/select pads, not the full frame. */
export function catalogContentBox(item: CatalogItem, col: number, row: number) {
  const box = catalogBox(item, col, row);
  const sx = box.w / item.px[0];
  const sy = box.h / item.px[1];
  return {
    x: box.x + item.content[0] * sx,
    y: box.y + item.content[1] * sy,
    w: item.content[2] * sx,
    h: item.content[3] * sy,
  };
}
