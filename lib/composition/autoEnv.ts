import type { Piece } from "../types";
import { parseLotId, type LotRect } from "./grid3d";
import { platformAt } from "./surface";
import type { EnvironmentSpec } from "./types";

/**
 * Auto-ground — even a freeform build never floats in the void.
 *
 * When pieces stand outside every authored platform (an agent free-building,
 * a human clicking into open space), a derived ground pad appears underneath
 * their extent. The pad is presentation only: it lives in the render pass,
 * never in the store, and recomputes whenever the pieces change.
 */

export function autoGroundPads(pieces: Record<string, Piece>, env: EnvironmentSpec | null): LotRect[] {
  const stray: { col: number; row: number }[] = [];
  for (const piece of Object.values(pieces)) {
    const parsed = parseLotId(piece.lot);
    if (!parsed) continue;
    if (platformAt(env, parsed.col, parsed.row)) continue;
    if (env?.water.some((w) => within(w.rect, parsed.col, parsed.row))) continue; // boats float on purpose
    stray.push(parsed);
  }
  if (!stray.length) return [];

  // Cluster strays into connected groups (within 2 cells) and pad each group.
  const groups: { col: number; row: number }[][] = [];
  const used = new Array(stray.length).fill(false);
  for (let i = 0; i < stray.length; i += 1) {
    if (used[i]) continue;
    const group = [stray[i]];
    used[i] = true;
    for (let g = 0; g < group.length; g += 1) {
      for (let j = 0; j < stray.length; j += 1) {
        if (used[j]) continue;
        if (Math.max(Math.abs(group[g].col - stray[j].col), Math.abs(group[g].row - stray[j].row)) <= 2) {
          used[j] = true;
          group.push(stray[j]);
        }
      }
    }
    groups.push(group);
  }
  // Sorted so a new piece never reorders the pads that already stand — the
  // stage keys pads by rect and would otherwise re-drop every one of them.
  return groups
    .map((group) => {
      const c0 = Math.floor(Math.min(...group.map((p) => p.col))) - 1;
      const r0 = Math.floor(Math.min(...group.map((p) => p.row))) - 1;
      const c1 = Math.ceil(Math.max(...group.map((p) => p.col))) + 1;
      const r1 = Math.ceil(Math.max(...group.map((p) => p.row))) + 1;
      return { c0, r0, w: c1 - c0 + 1, d: r1 - r0 + 1 };
    })
    .sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0 || a.w - b.w || a.d - b.d);
}

function within(rect: LotRect, col: number, row: number) {
  return col >= rect.c0 && col < rect.c0 + rect.w && row >= rect.r0 && row < rect.r0 + rect.d;
}
