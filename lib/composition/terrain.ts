import type { CatalogItem } from "../catalog";
import { cellKey, maskHas, type IslandMask } from "./island";
import { roleOf } from "./roles";
import { clearanceLots } from "./scale3d";
import { createSeededRandom, deriveSeed } from "./seed";
import { selectItems } from "./select";
import type { ThemeSpec } from "./themes";
import type { GroundCell, EnvironmentSpec, WaterCell, WaterTone } from "./types";

/**
 * Terrain painting + environmental framing — both fully seeded.
 *
 * Ground variation forms PATCHES: seeded blobs of secondary/accent/rare
 * materials whose total shares come from the theme's configured ranges.
 * Never independent per-block randomness — that is visual noise, not
 * composition. The boundary planner rings the island's actual coastline
 * with dense, varied framing (a forest edge, standing stones) so scenes
 * stop feeling like objects floating on an infinite board.
 */

/** Rebuild the land mask from a live environment's ground platforms — the
 * bridge that lets tools repaint/refame a scene that already exists. */
export function landMaskFromEnv(env: { platforms: { rect: { c0: number; r0: number; w: number; d: number }; inset?: boolean; level: number; material: string; id: string }[] }): IslandMask {
  const cells = new Set<string>();
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (const p of env.platforms) {
    if (p.inset || p.level !== 0 || p.material === "road" || p.id === "pier") continue;
    for (let r = p.rect.r0; r < p.rect.r0 + p.rect.d; r += 1) {
      for (let c = p.rect.c0; c < p.rect.c0 + p.rect.w; c += 1) cells.add(cellKey(c, r));
    }
    c0 = Math.min(c0, p.rect.c0);
    r0 = Math.min(r0, p.rect.r0);
    c1 = Math.max(c1, p.rect.c0 + p.rect.w - 1);
    r1 = Math.max(r1, p.rect.r0 + p.rect.d - 1);
  }
  if (!Number.isFinite(c0)) return { cells, bbox: { c0: 0, r0: 0, w: 0, d: 0 } };
  return { cells, bbox: { c0, r0, w: c1 - c0 + 1, d: r1 - r0 + 1 } };
}

/** The cells a boundary must leave open on a live environment: entrances
 * (paths), piers, roads, waterline, and stairs. */
export function buildFrameSkip(env: {
  paths: { cells: { col: number; row: number }[] }[];
  platforms: { rect: { c0: number; r0: number; w: number; d: number }; material: string; id: string }[];
  water: { rect: { c0: number; r0: number; w: number; d: number } }[];
  stairs: { at: { col: number; row: number } }[];
  zones?: { rect: { c0: number; r0: number; w: number; d: number }; type: string }[];
}): Set<string> {
  const skip = new Set<string>();
  for (const path of env.paths) {
    for (const cell of path.cells) {
      for (let dc = -1; dc <= 1; dc += 1) {
        for (let dr = -1; dr <= 1; dr += 1) skip.add(cellKey(cell.col + dc, cell.row + dr));
      }
    }
  }
  for (const p of env.platforms) {
    if (p.id.startsWith("pier") || p.material === "road") {
      for (let r = p.rect.r0 - 1; r <= p.rect.r0 + p.rect.d; r += 1) {
        for (let c = p.rect.c0 - 1; c <= p.rect.c0 + p.rect.w; c += 1) skip.add(cellKey(c, r));
      }
    }
  }
  for (const w of env.water) {
    for (let r = w.rect.r0 - 1; r <= w.rect.r0 + w.rect.d; r += 1) {
      for (let c = w.rect.c0 - 1; c <= w.rect.c0 + w.rect.w; c += 1) skip.add(cellKey(c, r));
    }
  }
  for (const s of env.stairs) skip.add(cellKey(s.at.col, s.at.row));
  for (const zone of env.zones ?? []) {
    if (!["home", "arcade", "keep", "lab", "market"].includes(zone.type)) continue;
    for (let r = zone.rect.r0; r < zone.rect.r0 + zone.rect.d; r += 1) {
      for (let c = zone.rect.c0; c < zone.rect.c0 + zone.rect.w; c += 1) {
        skip.add(cellKey(c, r));
      }
    }
  }
  return skip;
}

function sortedLand(island: IslandMask): { col: number; row: number }[] {
  return [...island.cells]
    .map((k) => {
      const [col, row] = k.split(":").map(Number);
      return { col, row };
    })
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

export function coastCells(island: IslandMask): { col: number; row: number }[] {
  return sortedLand(island).filter(
    ({ col, row }) =>
      !maskHas(island, col + 1, row) ||
      !maskHas(island, col - 1, row) ||
      !maskHas(island, col, row + 1) ||
      !maskHas(island, col, row - 1),
  );
}

/**
 * Paint the theme's material patches over the island. Deterministic through
 * the scene seed's "terrain" stream; every layer's share is drawn from the
 * theme's configured range, so two seeds of the same theme differ in both
 * layout AND mix.
 */
export function paintTerrain(island: IslandMask, theme: ThemeSpec, sceneSeed: string): GroundCell[] {
  const rng = createSeededRandom(deriveSeed(sceneSeed, "terrain"));
  const land = sortedLand(island);
  if (!land.length) return [];
  const assigned = new Map<string, GroundCell>();

  const paintLayer = (m: GroundCell["m"], share: [number, number], blobRadius: [number, number]) => {
    const target = Math.round(land.length * (share[0] + rng() * (share[1] - share[0])));
    let painted = 0;
    let attempts = 0;
    while (painted < target && attempts < 40) {
      attempts += 1;
      const seedCell = land[Math.floor(rng() * land.length)];
      const r = blobRadius[0] + rng() * (blobRadius[1] - blobRadius[0]);
      const wobble = rng() * Math.PI * 2;
      for (let dr = -Math.ceil(r); dr <= Math.ceil(r); dr += 1) {
        for (let dc = -Math.ceil(r); dc <= Math.ceil(r); dc += 1) {
          const col = seedCell.col + dc;
          const row = seedCell.row + dr;
          const k = cellKey(col, row);
          if (!island.cells.has(k) || assigned.has(k)) continue;
          // A wobbled radius keeps blob edges organic without per-cell noise.
          const edge = r * (0.8 + 0.25 * Math.sin(Math.atan2(dr, dc) * 2 + wobble));
          if (Math.hypot(dc, dr) <= edge) {
            assigned.set(k, { col, row, m });
            painted += 1;
            if (painted >= target) return;
          }
        }
      }
    }
  };

  for (const layer of theme.secondary) paintLayer(layer.m, layer.share, [1.8, 3.4]);
  for (const layer of theme.accent) paintLayer(layer.m, layer.share, [1.2, 2.4]);
  for (const layer of theme.rare) paintLayer(layer.m, layer.share, [0.8, 1.4]);

  // Warm color flecks — small seeded blobs of ochre, coral, terracotta so
  // every biome gets desert-sunset pinks/oranges/reds, not just sand themes.
  for (const m of themeSpeckleMaterials(theme)) {
    paintLayer(m, [0.025, 0.06], [0.55, 1.1]);
  }

  // Coast fringe — a beach lip, a mud shore — where the theme wants one.
  if (theme.edgeMaterial) {
    for (const cell of coastCells(island)) {
      const k = cellKey(cell.col, cell.row);
      if (!assigned.has(k) && rng() < 0.6) {
        assigned.set(k, { col: cell.col, row: cell.row, m: theme.edgeMaterial });
      }
    }
  }

  return [...assigned.values()];
}

/** Per-theme warm accent materials for tiny color flecks on the foundation. */
function themeSpeckleMaterials(theme: ThemeSpec): GroundCell["m"][] {
  switch (theme.id) {
    case "desert":
    case "beach":
    case "pirate-isle":
      return ["ochre", "terracotta", "coral", "ember"];
    case "volcanic":
      return ["ember", "ochre", "terracotta"];
    case "candy":
    case "toybox":
    case "garden":
      return ["candy-pink", "coral", "ochre"];
    case "autumn":
      return ["ember", "ochre", "terracotta", "coral"];
    case "industrial":
      return ["ochre", "terracotta", "ember", "coral"];
    case "snow":
      return ["ice", "stone"];
    case "spooky":
    case "dungeon":
      return ["shadow-purple", "ember"];
    default:
      return ["ochre", "terracotta", "ember", "sand-dark", "coral"];
  }
}

/** All water lots in the live environment — for repainting after edits. */
export function waterMaskFromEnv(env: { water: { rect: { c0: number; r0: number; w: number; d: number } }[] }): Set<string> {
  const cells = new Set<string>();
  for (const w of env.water) {
    for (let r = w.rect.r0; r < w.rect.r0 + w.rect.d; r += 1) {
      for (let c = w.rect.c0; c < w.rect.c0 + w.rect.w; c += 1) cells.add(cellKey(c, r));
    }
  }
  return cells;
}

function sortedWater(cells: Set<string>): { col: number; row: number }[] {
  return [...cells]
    .map((k) => {
      const [col, row] = k.split(":").map(Number);
      return { col, row };
    })
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

/**
 * Paint seeded tone patches over water — deep basins, brighter shallows, dark
 * pockets. Deterministic through the scene seed's "water" stream; same seed
 * always paints the same ocean, different seeds get different currents.
 */
export function paintWater(cells: Set<string>, sceneSeed: string): WaterCell[] {
  const rng = createSeededRandom(deriveSeed(sceneSeed, "water"));
  const water = sortedWater(cells);
  if (!water.length) return [];
  const assigned = new Map<string, WaterCell>();

  const paintLayer = (t: WaterTone, share: [number, number], blobRadius: [number, number]) => {
    const target = Math.round(water.length * (share[0] + rng() * (share[1] - share[0])));
    let painted = 0;
    let attempts = 0;
    while (painted < target && attempts < 40) {
      attempts += 1;
      const seedCell = water[Math.floor(rng() * water.length)];
      const r = blobRadius[0] + rng() * (blobRadius[1] - blobRadius[0]);
      const wobble = rng() * Math.PI * 2;
      for (let dr = -Math.ceil(r); dr <= Math.ceil(r); dr += 1) {
        for (let dc = -Math.ceil(r); dc <= Math.ceil(r); dc += 1) {
          const col = seedCell.col + dc;
          const row = seedCell.row + dr;
          const k = cellKey(col, row);
          if (!cells.has(k) || assigned.has(k)) continue;
          const edge = r * (0.8 + 0.25 * Math.sin(Math.atan2(dr, dc) * 2 + wobble));
          if (Math.hypot(dc, dr) <= edge) {
            assigned.set(k, { col, row, t });
            painted += 1;
            if (painted >= target) return;
          }
        }
      }
    }
  };

  paintLayer(0, [0.32, 0.48], [2.4, 4.2]);
  paintLayer(1, [0.22, 0.34], [1.6, 3.0]);
  paintLayer(2, [0.08, 0.16], [1.2, 2.2]);
  paintLayer(3, [0.04, 0.1], [0.8, 1.6]);

  return [...assigned.values()];
}

/** Repaint water cells from the current environment rects + scene seed. */
export function withWaterPaint(env: EnvironmentSpec, sceneSeed: string): EnvironmentSpec {
  if (!env.water.length) return { ...env, waterCells: [] };
  return { ...env, waterCells: paintWater(waterMaskFromEnv(env), sceneSeed) };
}

export type FramePlacement = {
  item: CatalogItem;
  col: number;
  row: number;
  flip: boolean;
  reason: string;
};

/** Framing items the theme's boundary draws from — varied but coherent. */
export function boundaryPool(theme: ThemeSpec, sceneSeed: string, query?: string): CatalogItem[] {
  const items = selectItems(query?.trim() || theme.boundaryQuery, deriveSeed(sceneSeed, "boundary"));
  return items
    .filter((i) => {
      const role = roleOf(i);
      // Tabletop joins the pool so candy boundaries can be made of sweets.
      return role === "scenery" || role === "structure" || role === "ground" || role === "tabletop" || i.kind === "tree";
    })
    .slice(0, 12);
}

/**
 * Plan the environmental frame as GROVES, not a picket line: seeded anchor
 * points spread along the coast, each growing an organic clump of one
 * species that may spill a couple of cells inland, with natural gaps
 * between groves. Everything stays on the island mask, honors the live
 * clearance metric (nothing relocates or stacks), and skips the cells the
 * scene needs open — entrance, pier, street, waterline, zones.
 */
export function planBoundary(
  island: IslandMask,
  theme: ThemeSpec,
  sceneSeed: string,
  skip: Set<string>,
  opts: { density?: number; query?: string } = {},
): FramePlacement[] {
  if (theme.boundary === "none") return [];
  const rng = createSeededRandom(deriveSeed(sceneSeed, "frame"));
  const pool = boundaryPool(theme, sceneSeed, opts.query);
  if (!pool.length) return [];
  const density = opts.density ?? theme.boundaryDensity[0] + rng() * (theme.boundaryDensity[1] - theme.boundaryDensity[0]);
  const centerCol = island.bbox.c0 + island.bbox.w / 2;
  const centerRow = island.bbox.r0 + island.bbox.d / 2;
  const ring = coastCells(island)
    .map((c) => ({ ...c, ang: Math.atan2(c.row - centerRow, c.col - centerCol) }))
    .sort((a, b) => a.ang - b.ang);
  if (!ring.length) return [];

  const out: FramePlacement[] = [];
  const placedPts: { col: number; row: number; r: number }[] = [];
  const reason = theme.boundary === "trees" ? "the wood at the edge" : "standing at the boundary";

  // Grove anchors: spread around the coast by arc with jitter, so clumps
  // land all over the rim but never march in even single file.
  const groveCount = Math.max(3, Math.round((ring.length * density) / 4));
  const GROVE_REACH = 2.6; // how far a grove spreads from its anchor (lots)

  for (let g = 0; g < groveCount; g += 1) {
    const idx = Math.floor((((g + 0.1 + rng() * 0.8) / groveCount) * ring.length) % ring.length);
    const anchor = ring[idx];
    const species = pool[Math.floor(rng() * pool.length)];
    const r = clearanceLots(species);
    const size = 3 + Math.floor(rng() * 4); // 3–6 per grove

    // Candidate cells: everything on the island within reach of the anchor,
    // shuffled by the seed — clumped, jittered, never a row.
    const candidates: { col: number; row: number; key: number }[] = [];
    for (let dr = -Math.ceil(GROVE_REACH); dr <= Math.ceil(GROVE_REACH); dr += 1) {
      for (let dc = -Math.ceil(GROVE_REACH); dc <= Math.ceil(GROVE_REACH); dc += 1) {
        const col = anchor.col + dc;
        const row = anchor.row + dr;
        const dist = Math.hypot(dc, dr);
        if (dist > GROVE_REACH) continue;
        const k = cellKey(col, row);
        if (!island.cells.has(k) || skip.has(k)) continue;
        // Bias toward the anchor with seeded jitter — dense hearts, loose fringes.
        candidates.push({ col, row, key: dist * 0.55 + rng() });
      }
    }
    candidates.sort((a, b) => a.key - b.key);

    let planted = 0;
    for (const cell of candidates) {
      if (planted >= size) break;
      if (placedPts.some((p) => Math.hypot(p.col - cell.col, p.row - cell.row) < p.r + r)) continue;
      placedPts.push({ col: cell.col, row: cell.row, r });
      out.push({ item: species, col: cell.col, row: cell.row, flip: rng() > 0.5, reason });
      planted += 1;
    }
  }

  // Undergrowth: sparse small growth around the grove hearts.
  if (theme.undergrowthQuery && out.length) {
    const under = selectItems(theme.undergrowthQuery, deriveSeed(sceneSeed, "undergrowth"))
      .filter((i) => roleOf(i) === "scenery" || roleOf(i) === "ground")
      .slice(0, 8);
    if (under.length) {
      const trees = [...out];
      for (const tree of trees) {
        if (rng() > 0.3) continue;
        const dc = Math.floor(rng() * 3) - 1;
        const dr = Math.floor(rng() * 3) - 1;
        const col = tree.col + dc;
        const row = tree.row + dr;
        const k = cellKey(col, row);
        if (!island.cells.has(k) || skip.has(k)) continue;
        const item = under[Math.floor(rng() * under.length)];
        const r = clearanceLots(item);
        if (placedPts.some((p) => Math.hypot(p.col - col, p.row - row) < p.r + r)) continue;
        placedPts.push({ col, row, r });
        out.push({ item, col, row, flip: rng() > 0.5, reason: "undergrowth" });
      }
    }
  }
  return out;
}
