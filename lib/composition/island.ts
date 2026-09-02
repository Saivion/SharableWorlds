import type { LotRect } from "./grid3d";

/**
 * Organic island footprints — every seed gets its own silhouette.
 *
 * A footprint is a MASK of lots, not a rectangle: a radial blob whose coast
 * is shaped by low-frequency harmonics (bean, pear, crescent-ish outlines),
 * unioned with seeded lobes (peninsulas) and cleaned to one connected,
 * hole-free landmass. The mask is then decomposed into non-overlapping
 * rectangular strips so every rect-based consumer downstream — the voxel
 * deck renderer, surface grounding, placement fencing, zone math — works
 * untouched while the world stops being a slab.
 */

export type IslandMask = {
  cells: Set<string>;
  bbox: LotRect;
};

export function cellKey(col: number, row: number): string {
  return `${col}:${row}`;
}

export function maskHas(mask: IslandMask, col: number, row: number): boolean {
  return mask.cells.has(cellKey(col, row));
}

function bboxOf(cells: Set<string>): LotRect {
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (const key of cells) {
    const [c, r] = key.split(":").map(Number);
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  if (!Number.isFinite(c0)) return { c0: 0, r0: 0, w: 0, d: 0 };
  return { c0, r0, w: c1 - c0 + 1, d: r1 - r0 + 1 };
}

/** Largest connected component under 4-neighbor adjacency. */
function largestComponent(cells: Set<string>): Set<string> {
  const seen = new Set<string>();
  let best: Set<string> = new Set();
  for (const start of cells) {
    if (seen.has(start)) continue;
    const comp = new Set<string>();
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const key = queue.pop()!;
      comp.add(key);
      const [c, r] = key.split(":").map(Number);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nk = cellKey(c + dc, r + dr);
        if (cells.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          queue.push(nk);
        }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

/** Fill enclosed holes: any void not reachable from outside the bbox becomes land. */
function fillHoles(cells: Set<string>): Set<string> {
  const bbox = bboxOf(cells);
  if (!bbox.w) return cells;
  const outside = new Set<string>();
  const queue: [number, number][] = [];
  const inBounds = (c: number, r: number) =>
    c >= bbox.c0 - 1 && c <= bbox.c0 + bbox.w && r >= bbox.r0 - 1 && r <= bbox.r0 + bbox.d;
  const push = (c: number, r: number) => {
    const key = cellKey(c, r);
    if (!inBounds(c, r) || cells.has(key) || outside.has(key)) return;
    outside.add(key);
    queue.push([c, r]);
  };
  push(bbox.c0 - 1, bbox.r0 - 1);
  while (queue.length) {
    const [c, r] = queue.pop()!;
    push(c + 1, r);
    push(c - 1, r);
    push(c, r + 1);
    push(c, r - 1);
  }
  const filled = new Set(cells);
  for (let r = bbox.r0; r < bbox.r0 + bbox.d; r += 1) {
    for (let c = bbox.c0; c < bbox.c0 + bbox.w; c += 1) {
      const key = cellKey(c, r);
      if (!cells.has(key) && !outside.has(key)) filled.add(key);
    }
  }
  return filled;
}

/** Shave 1-cell spikes — cells clinging to the coast by a single neighbor. */
function shaveSpikes(cells: Set<string>): Set<string> {
  const out = new Set(cells);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const key of [...out]) {
      const [c, r] = key.split(":").map(Number);
      let n = 0;
      if (out.has(cellKey(c + 1, r))) n += 1;
      if (out.has(cellKey(c - 1, r))) n += 1;
      if (out.has(cellKey(c, r + 1))) n += 1;
      if (out.has(cellKey(c, r - 1))) n += 1;
      if (n <= 1) out.delete(key);
    }
  }
  return out;
}

function neighbors4(key: string): string[] {
  const [c, r] = key.split(":").map(Number);
  return [cellKey(c + 1, r), cellKey(c - 1, r), cellKey(c, r + 1), cellKey(c, r - 1)];
}

/** Keep only water reachable from the shoreline — no stray offshore squares. */
function coastConnectedWater(water: Set<string>, land: Set<string>): Set<string> {
  const seeds: string[] = [];
  for (const key of water) {
    for (const nk of neighbors4(key)) {
      if (land.has(nk)) {
        seeds.push(key);
        break;
      }
    }
  }
  const out = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const key = queue.pop()!;
    for (const nk of neighbors4(key)) {
      if (water.has(nk) && !out.has(nk)) {
        out.add(nk);
        queue.push(nk);
      }
    }
  }
  return out;
}

/** Seeded harmonic blob — shared by islands and offshore water bodies. */
function organicBlobCells(
  rng: () => number,
  center: { col: number; row: number },
  rx: number,
  rz: number,
): Set<string> {
  const a1 = 0.10 + rng() * 0.16;
  const a2 = 0.10 + rng() * 0.20;
  const a3 = 0.06 + rng() * 0.14;
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const p3 = rng() * Math.PI * 2;
  const squish = 0.85 + rng() * 0.3;
  const rot = rng() * Math.PI;

  const cells = new Set<string>();
  const margin = 4;
  for (let row = Math.floor(center.row - rz - margin); row <= Math.ceil(center.row + rz + margin); row += 1) {
    for (let col = Math.floor(center.col - rx - margin); col <= Math.ceil(center.col + rx + margin); col += 1) {
      const ux = (col - center.col) / rx;
      const uz = ((row - center.row) / rz) * squish;
      const x = ux * Math.cos(rot) - uz * Math.sin(rot);
      const z = ux * Math.sin(rot) + uz * Math.cos(rot);
      const r = Math.hypot(x, z);
      if (r < 0.001) {
        cells.add(cellKey(col, row));
        continue;
      }
      const theta = Math.atan2(z, x);
      const coast =
        1 +
        a1 * Math.sin(theta + p1) +
        a2 * Math.sin(2 * theta + p2) +
        a3 * Math.sin(3 * theta + p3);
      if (r <= coast) cells.add(cellKey(col, row));
    }
  }

  const lobes = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < lobes; i += 1) {
    const ang = rng() * Math.PI * 2;
    const dist = 0.75 + rng() * 0.45;
    const lc = center.col + Math.round(Math.cos(ang) * rx * dist);
    const lr = center.row + Math.round(Math.sin(ang) * rz * dist);
    const lrx = Math.max(2, rx * (0.28 + rng() * 0.22));
    const lrz = Math.max(2, rz * (0.28 + rng() * 0.22));
    for (let row = Math.floor(lr - lrz); row <= Math.ceil(lr + lrz); row += 1) {
      for (let col = Math.floor(lc - lrx); col <= Math.ceil(lc + lrx); col += 1) {
        const r = Math.hypot((col - lc) / lrx, (row - lr) / lrz);
        if (r <= 1) cells.add(cellKey(col, row));
      }
    }
  }
  return cells;
}

export type HarborSide = "e" | "s" | "w";

/**
 * Organic harbor water — floods outward from the island's actual coastline
 * with seeded depth variation, then unions an offshore blob for bays. Never
 * a plain rectangle; decompose with maskToRects for rendering.
 */
export function generateHarborWaterMask(
  island: IslandMask,
  side: HarborSide,
  rng: () => number,
  depth: number,
): IslandMask {
  const land = island.cells;
  const water = new Set<string>();
  const { c0, r0, w, d } = island.bbox;
  const a1 = 0.12 + rng() * 0.18;
  const a2 = 0.08 + rng() * 0.14;
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;

  const reachAt = (t: number) => {
    const wobble = 1 + a1 * Math.sin(t + p1) + a2 * Math.sin(2 * t + p2);
    return Math.max(2, Math.round(depth * 0.5 * wobble));
  };

  if (side === "s") {
    for (let col = c0 - 1; col < c0 + w + 1; col += 1) {
      const coastRow = southCoastRow(island, col);
      if (coastRow == null) continue;
      const t = ((col - c0) / Math.max(1, w)) * Math.PI * 2;
      const reach = reachAt(t);
      for (let dr = 1; dr <= reach; dr += 1) {
        const key = cellKey(col, coastRow + dr);
        if (!land.has(key)) water.add(key);
        if (dr <= reach - 1 && rng() < 0.28) {
          for (const dc of [-1, 1]) {
            const sideKey = cellKey(col + dc, coastRow + dr);
            if (!land.has(sideKey)) water.add(sideKey);
          }
        }
      }
    }
  } else if (side === "w") {
    for (let row = r0 - 1; row < r0 + d + 1; row += 1) {
      const coastCol = coastColInRow(island, row, "w");
      if (coastCol == null) continue;
      const t = ((row - r0) / Math.max(1, d)) * Math.PI * 2;
      const reach = reachAt(t);
      for (let dc = 1; dc <= reach; dc += 1) {
        const key = cellKey(coastCol - dc, row);
        if (!land.has(key)) water.add(key);
        if (dc <= reach - 1 && rng() < 0.28) {
          for (const dr of [-1, 1]) {
            const sideKey = cellKey(coastCol - dc, row + dr);
            if (!land.has(sideKey)) water.add(sideKey);
          }
        }
      }
    }
  } else {
    for (let row = r0 - 1; row < r0 + d + 1; row += 1) {
      const coastCol = coastColInRow(island, row, "e");
      if (coastCol == null) continue;
      const t = ((row - r0) / Math.max(1, d)) * Math.PI * 2;
      const reach = reachAt(t);
      for (let dc = 1; dc <= reach; dc += 1) {
        const key = cellKey(coastCol + dc, row);
        if (!land.has(key)) water.add(key);
        if (dc <= reach - 1 && rng() < 0.28) {
          for (const dr of [-1, 1]) {
            const sideKey = cellKey(coastCol + dc, row + dr);
            if (!land.has(sideKey)) water.add(sideKey);
          }
        }
      }
    }
  }

  const margin = 2 + rng() * 2;
  let center: { col: number; row: number };
  let rx: number;
  let rz: number;
  if (side === "s") {
    center = { col: c0 + w / 2, row: r0 + d + depth * (0.42 + rng() * 0.12) };
    rx = w / 2 + margin;
    rz = depth * (0.5 + rng() * 0.28);
  } else if (side === "w") {
    center = { col: c0 - depth * (0.42 + rng() * 0.12), row: r0 + d / 2 };
    rx = depth * (0.5 + rng() * 0.28);
    rz = d / 2 + margin;
  } else {
    center = { col: c0 + w + depth * (0.42 + rng() * 0.12), row: r0 + d / 2 };
    rx = depth * (0.5 + rng() * 0.28);
    rz = d / 2 + margin;
  }
  for (const key of organicBlobCells(rng, center, rx, rz)) {
    if (!land.has(key)) water.add(key);
  }

  let cells = coastConnectedWater(water, land);
  cells = shaveSpikes(cells);
  return { cells, bbox: bboxOf(cells) };
}

/** Push one or more water specs from an organic mask (rect union === mask). */
export function pushWaterMask(
  water: { id: string; rect: LotRect; level: number }[],
  mask: IslandMask,
  idPrefix: string,
  level = 0,
) {
  maskToRects(mask).forEach((rect, i) => {
    water.push({ id: i === 0 ? idPrefix : `${idPrefix}-${i}`, rect, level });
  });
}

/**
 * Generate a seeded organic island around (cx, rz) with half-extents rx/rz.
 * All shape decisions come from `rng` — the same rng stream always draws the
 * same coastline, and different streams draw genuinely different silhouettes:
 * lobed, bean-shaped, crescent-leaning, peninsula'd — never a plain slab.
 */
export function generateIslandMask(
  rng: () => number,
  center: { col: number; row: number },
  rx: number,
  rz: number,
): IslandMask {
  let cells = organicBlobCells(rng, center, rx, rz);
  cells = shaveSpikes(fillHoles(largestComponent(cells)));
  cells = fillHoles(largestComponent(cells));
  return { cells, bbox: bboxOf(cells) };
}

/**
 * Decompose the mask into non-overlapping rectangles: per-row runs, greedily
 * merged with the row above when they line up exactly. Their union IS the
 * mask, so rect-based consumers stay exact.
 */
export function maskToRects(mask: IslandMask): LotRect[] {
  const runsByRow = new Map<number, { c0: number; w: number }[]>();
  for (let row = mask.bbox.r0; row < mask.bbox.r0 + mask.bbox.d; row += 1) {
    const runs: { c0: number; w: number }[] = [];
    let start: number | null = null;
    for (let col = mask.bbox.c0; col <= mask.bbox.c0 + mask.bbox.w; col += 1) {
      const on = maskHas(mask, col, row);
      if (on && start == null) start = col;
      if (!on && start != null) {
        runs.push({ c0: start, w: col - start });
        start = null;
      }
    }
    runsByRow.set(row, runs);
  }
  const rects: (LotRect & { open: boolean })[] = [];
  for (let row = mask.bbox.r0; row < mask.bbox.r0 + mask.bbox.d; row += 1) {
    for (const run of runsByRow.get(row) ?? []) {
      const above = rects.find((r) => r.open && r.c0 === run.c0 && r.w === run.w && r.r0 + r.d === row);
      if (above) above.d += 1;
      else rects.push({ c0: run.c0, r0: row, w: run.w, d: 1, open: true });
    }
    for (const r of rects) {
      if (r.open && r.r0 + r.d <= row) r.open = false;
    }
  }
  return rects.map(({ c0, r0, w, d }) => ({ c0, r0, w, d }));
}

/** Largest axis-aligned rectangle fully inside the mask (histogram method). */
export function largestRectInMask(mask: IslandMask): LotRect {
  const { c0, r0, w, d } = mask.bbox;
  if (!w) return mask.bbox;
  const heights = new Array<number>(w).fill(0);
  let best: LotRect = { c0, r0, w: 0, d: 0 };
  let bestArea = 0;
  for (let row = r0; row < r0 + d; row += 1) {
    for (let i = 0; i < w; i += 1) {
      heights[i] = maskHas(mask, c0 + i, row) ? heights[i] + 1 : 0;
    }
    const stack: number[] = [];
    for (let i = 0; i <= w; i += 1) {
      const h = i === w ? 0 : heights[i];
      let start = i;
      while (stack.length && heights[stack[stack.length - 1]] > h) {
        const top = stack.pop()!;
        const height = heights[top];
        const width = i - (stack.length ? stack[stack.length - 1] + 1 : 0);
        if (height * width > bestArea) {
          bestArea = height * width;
          start = stack.length ? stack[stack.length - 1] + 1 : 0;
          best = { c0: c0 + start, r0: row - height + 1, w: width, d: height };
        }
      }
      stack.push(i);
    }
  }
  return bestArea ? best : mask.bbox;
}

function rectsIntersect(a: LotRect, b: LotRect): boolean {
  return a.c0 < b.c0 + b.w && b.c0 < a.c0 + a.w && a.r0 < b.r0 + b.d && b.r0 < a.r0 + a.d;
}

/**
 * Find a w×d rect fully on the mask, clear of `taken`, nearest to `bias`.
 * Shrinks (never below 3×2) when the requested size doesn't fit anywhere.
 */
export function findZoneRect(
  mask: IslandMask,
  taken: LotRect[],
  w: number,
  d: number,
  bias: { col: number; row: number },
): LotRect | null {
  for (let shrink = 0; shrink < 4; shrink += 1) {
    const cw = Math.max(3, w - shrink);
    const cd = Math.max(2, d - shrink);
    let best: LotRect | null = null;
    let bestDist = Infinity;
    for (let r0 = mask.bbox.r0; r0 <= mask.bbox.r0 + mask.bbox.d - cd; r0 += 1) {
      for (let c0 = mask.bbox.c0; c0 <= mask.bbox.c0 + mask.bbox.w - cw; c0 += 1) {
        const rect = { c0, r0, w: cw, d: cd };
        if (taken.some((t) => rectsIntersect(rect, t))) continue;
        let onMask = true;
        for (let r = r0; r < r0 + cd && onMask; r += 1) {
          for (let c = c0; c < c0 + cw; c += 1) {
            if (!maskHas(mask, c, r)) {
              onMask = false;
              break;
            }
          }
        }
        if (!onMask) continue;
        const dist = Math.hypot(c0 + cw / 2 - bias.col, r0 + cd / 2 - bias.row);
        if (dist < bestDist) {
          bestDist = dist;
          best = rect;
        }
      }
    }
    if (best) return best;
    if (cw === 3 && cd === 2) break;
  }
  return null;
}

/** Southernmost land row in a column, or null when the column misses the island. */
export function southCoastRow(mask: IslandMask, col: number): number | null {
  for (let row = mask.bbox.r0 + mask.bbox.d - 1; row >= mask.bbox.r0; row -= 1) {
    if (maskHas(mask, col, row)) return row;
  }
  return null;
}

/** Outermost land column in a row toward one side, for piers and jetties. */
export function coastColInRow(mask: IslandMask, row: number, side: "e" | "w"): number | null {
  if (side === "e") {
    for (let col = mask.bbox.c0 + mask.bbox.w - 1; col >= mask.bbox.c0; col -= 1) {
      if (maskHas(mask, col, row)) return col;
    }
  } else {
    for (let col = mask.bbox.c0; col < mask.bbox.c0 + mask.bbox.w; col += 1) {
      if (maskHas(mask, col, row)) return col;
    }
  }
  return null;
}
