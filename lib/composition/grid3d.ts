/**
 * World-space grid for the 3D stage.
 *
 * The lot grid is the shared language between the human UI, the WebMCP agent,
 * and the composer — a lot id like "M13" is the only positional truth a piece
 * carries. This module maps that logical grid into stage world units:
 * col → +x, row → +z, elevation levels → +y. Nothing here touches the store.
 */

/** World units per lot. Every scale in the stage derives from this. */
export const TILE = 2;
/** World units per elevation level — one terrace step, about knee-to-hip height. */
export const ELEV = 0.7;
/** How far below y=0 platform plinths extend, so the island reads solid. */
export const PLINTH_DEPTH = 0.6;
/** Height of the voxel deck cubes pieces stand on. */
export const DECK_BLOCK = 0.12;

/** Center of lot (col, row) on the ground plane. */
export function worldOf(col: number, row: number): { x: number; z: number } {
  return { x: col * TILE, z: row * TILE };
}

/** Inverse of worldOf — fractional (col, row) under a world point. */
export function gridOf(x: number, z: number): { col: number; row: number } {
  return { col: x / TILE, row: z / TILE };
}

/** Rect of whole lots: cols [c0, c0+w), rows [r0, r0+d). */
export type LotRect = { c0: number; r0: number; w: number; d: number };

export function rectContains(rect: LotRect, col: number, row: number): boolean {
  return col >= rect.c0 && col < rect.c0 + rect.w && row >= rect.r0 && row < rect.r0 + rect.d;
}

export function rectCenter(rect: LotRect): { col: number; row: number } {
  return { col: rect.c0 + (rect.w - 1) / 2, row: rect.r0 + (rect.d - 1) / 2 };
}

/** World-space bounds of a lot rect (lot centers sit on the grid, so the
 * rect extends half a tile beyond the outermost centers). */
export function rectWorld(rect: LotRect): { x: number; z: number; w: number; d: number } {
  return {
    x: (rect.c0 + (rect.w - 1) / 2) * TILE,
    z: (rect.r0 + (rect.d - 1) / 2) * TILE,
    w: rect.w * TILE,
    d: rect.d * TILE,
  };
}

export function eachCell(rect: LotRect, fn: (col: number, row: number) => void) {
  for (let r = rect.r0; r < rect.r0 + rect.d; r += 1) {
    for (let c = rect.c0; c < rect.c0 + rect.w; c += 1) {
      fn(c, r);
    }
  }
}

// ---------------------------------------------------------------------------
// Lot id helpers — same grammar as lib/town.ts (A1-style, C{c}R{r} fallback),
// duplicated here so composition stays import-cycle-free from the store side.
// ---------------------------------------------------------------------------

function colLetters(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function lotIdOf(col: number, row: number): string {
  if (Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0) {
    return `${colLetters(col)}${row + 1}`;
  }
  return `C${col}R${row}`;
}

export function parseLotId(value: string): { col: number; row: number } | null {
  const text = value.trim().toUpperCase();
  const cr = /^C(-?\d+(?:\.5)?)R(-?\d+(?:\.5)?)$/.exec(text);
  if (cr) return { col: Number(cr[1]), row: Number(cr[2]) };
  const m = /^([A-Z]+)(\d+)$/.exec(text);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]) - 1;
  if (row < 0) return null;
  return { col: col - 1, row };
}
