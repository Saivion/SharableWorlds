import { DECK_BLOCK, ELEV, lotIdOf, rectContains, type LotRect } from "./grid3d";
import type { EnvironmentSpec, PlatformSpec } from "./types";

/**
 * Surface queries — the grounding layer. Every placed piece asks the
 * environment what it is standing on; nobody guesses Y coordinates.
 */

export type SurfaceInfo = {
  /** Elevation level of the supporting surface (0 = ground). */
  level: number;
  /** World y of the surface the piece stands on. */
  y: number;
  kind: "platform" | "ground" | "water";
  platform?: PlatformSpec;
};

/** Topmost platform covering a cell — higher level wins ties. */
export function platformAt(env: EnvironmentSpec | null, col: number, row: number): PlatformSpec | null {
  if (!env) return null;
  let best: PlatformSpec | null = null;
  for (const p of env.platforms) {
    if (!rectContains(p.rect, col, row)) continue;
    if (!best || p.level > best.level || (p.level === best.level && p.inset && !best.inset)) best = p;
  }
  return best;
}

export function surfaceAt(env: EnvironmentSpec | null, col: number, row: number): SurfaceInfo {
  if (env) {
    const platform = platformAt(env, col, row);
    if (platform) {
      return {
        level: platform.level,
        y: platform.level * ELEV + (platform.inset ? 0.06 : 0) + DECK_BLOCK,
        kind: "platform",
        platform,
      };
    }
    for (const w of env.water) {
      if (rectContains(w.rect, col, row)) {
        return { level: w.level, y: w.level * ELEV - 0.22 + DECK_BLOCK, kind: "water" };
      }
    }
  }
  return { level: 0, y: 0, kind: "ground" };
}

export function zoneAt(env: EnvironmentSpec | null, col: number, row: number) {
  if (!env) return null;
  for (const z of env.zones) {
    if (rectContains(z.rect, col, row)) return z;
  }
  return null;
}

const STAIR_STEPS: Record<string, [number, number]> = {
  n: [0, 1],
  s: [0, -1],
  e: [-1, 0],
  w: [1, 0],
};

/** The step-on (bottom) and step-off (top) cells of every stair — the HARD
 * no-blocking rule: these must stay clear or the stair is decorative. */
export function stairApproachLots(env: EnvironmentSpec | null): Set<string> {
  const out = new Set<string>();
  if (!env) return out;
  for (const s of env.stairs) {
    const [dc, dr] = STAIR_STEPS[s.dir] ?? [0, 1];
    out.add(lotIdOf(s.at.col + dc, s.at.row + dr)); // bottom approach
    out.add(lotIdOf(s.at.col - dc, s.at.row - dr)); // top step-off
  }
  return out;
}

/** Every path cell as a lot id — walkways the realism rules keep clear. */
export function pathLots(env: EnvironmentSpec | null): Set<string> {
  const out = new Set<string>();
  if (!env) return out;
  for (const path of env.paths) {
    for (const cell of path.cells) out.add(lotIdOf(cell.col, cell.row));
  }
  return out;
}

/** Lots the environment itself occupies — stairs are solid, and their
 * approach cells stay clear so every stair remains usable. */
export function reservedLots(env: EnvironmentSpec | null): Set<string> {
  const out = new Set<string>();
  if (!env) return out;
  for (const s of env.stairs) out.add(lotIdOf(s.at.col, s.at.row));
  for (const lot of stairApproachLots(env)) out.add(lot);
  return out;
}

/** Union bounds of all platforms (and water) — for camera framing and lighting. */
export function environmentBounds(env: EnvironmentSpec | null): LotRect | null {
  if (!env) return null;
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  const eat = (rect: LotRect) => {
    c0 = Math.min(c0, rect.c0);
    r0 = Math.min(r0, rect.r0);
    c1 = Math.max(c1, rect.c0 + rect.w - 1);
    r1 = Math.max(r1, rect.r0 + rect.d - 1);
  };
  for (const p of env.platforms) eat(p.rect);
  for (const w of env.water) eat(w.rect);
  if (!Number.isFinite(c0)) return null;
  return { c0, r0, w: c1 - c0 + 1, d: r1 - r0 + 1 };
}
