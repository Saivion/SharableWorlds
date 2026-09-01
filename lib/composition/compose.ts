import type { CatalogItem, CatalogKind } from "../catalog";
import { lotIdOf, rectCenter, rectContains, type LotRect } from "./grid3d";
import { roleOf, visualMass, type Role } from "./roles";
import { bodiesOverlap, clearanceLots } from "./scale3d";
import {
  coastColInRow,
  findZoneRect,
  generateHarborWaterMask,
  generateIslandMask,
  largestRectInMask,
  maskHas,
  maskToRects,
  pushWaterMask,
  southCoastRow,
  type HarborSide,
} from "./island";
import { createSeededRandom, deriveSeed, generateSceneSeed, isValidSeed, normalizeSeed } from "./seed";
import { selectItems } from "./select";
import { paintTerrain, planBoundary, withWaterPaint } from "./terrain";
import { resolveTheme } from "./themes";
import { cellKey } from "./island";
import type { EnvironmentSpec, PathSpec, PlatformMaterial, ZoneSpec, ZoneType } from "./types";

export type OccupiedBody = { col: number; row: number; r: number };

/**
 * The composer — theme in, authored-feeling scene out.
 *
 * The pipeline is architecture first, props second:
 *
 *   1. select catalog items for the theme (select.ts)
 *   2. derive a zone program from what was selected
 *   3. lay out the footprint: platforms, elevation, walls, stairs, water
 *   4. cut the platforms into zones with focal points
 *   5. fill each zone with purpose-grouped clusters, biggest first
 *   6. thread paths, then people, then framing scenery
 *
 * The environment must read as a place even if every prop is removed —
 * that is what separates a diorama from a pile.
 */

export type SceneTodo = {
  id: string;
  place: string;
  kind: string;
  lot: string;
  flip: boolean;
  /** Yaw in quarter turns of degrees (0 | 90 | 180 | 270), clockwise from "facing the camera". */
  rot?: number;
  reason: string;
};

export type ComposedPlan = { env: EnvironmentSpec; todos: SceneTodo[]; seed: string };

const ORIGIN = { col: 12, row: 12 }; // M13 — the home window's center

type Placement = {
  item: CatalogItem;
  col: number;
  row: number;
  flip?: boolean;
  rot?: number;
  reason: string;
};

/** Facing rotation that points a piece from (col,row) toward a target cell. */
function faceToward(col: number, row: number, target: { col: number; row: number }): number {
  const dc = target.col - col;
  const dr = target.row - row;
  if (Math.abs(dc) >= Math.abs(dr)) return dc >= 0 ? 270 : 90; // east : west
  return dr >= 0 ? 0 : 180; // south : north
}

// ---------------------------------------------------------------------------
// Occupancy bookkeeping during composition
// ---------------------------------------------------------------------------

class Board {
  taken = new Set<string>();
  softReserved = new Set<string>(); // paths + breathing room — props avoid, people may stand
  bodies: OccupiedBody[] = [];

  constructor(occupied: Iterable<OccupiedBody>) {
    for (const body of occupied) {
      this.taken.add(key(body.col, body.row));
      this.bodies.push({ col: body.col, row: body.row, r: body.r });
    }
  }

  free(col: number, row: number, allowSoft = false, radius = 0.48): boolean {
    const k = key(col, row);
    if (this.taken.has(k)) return false;
    if (!allowSoft && this.softReserved.has(k)) return false;
    const next = { col, row, r: radius };
    for (const body of this.bodies) {
      if (bodiesOverlap(next, body)) return false;
    }
    return true;
  }

  claim(
    col: number,
    row: number,
    allowSoft = false,
    valid?: (col: number, row: number) => boolean,
    radius = 0.48,
  ): boolean {
    if (valid && !valid(col, row)) return false;
    if (!this.free(col, row, allowSoft, radius)) return false;
    this.taken.add(key(col, row));
    this.bodies.push({ col, row, r: radius });
    return true;
  }

  /**
   * Claim the cell or the nearest free cell within `ring` steps. `valid`
   * fences the search to the scene's own architecture — a fallback cell must
   * never escape the platforms, or the composition leaks into the void.
   */
  claimNear(
    col: number,
    row: number,
    ring = 1,
    allowSoft = false,
    valid?: (col: number, row: number) => boolean,
    radius = 0.48,
  ): { col: number; row: number } | null {
    for (let r = 0; r <= ring; r += 1) {
      for (let dc = -r; dc <= r; dc += 1) {
        for (let dr = -r; dr <= r; dr += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
          if (this.claim(col + dc, row + dr, allowSoft, valid, radius)) {
            return { col: col + dc, row: row + dr };
          }
        }
      }
    }
    return null;
  }
}

function key(col: number, row: number) {
  return `${col}:${row}`;
}

// ---------------------------------------------------------------------------
// Zone program — what places does this theme need?
// ---------------------------------------------------------------------------

type ZonePlan = {
  type: ZoneType;
  label: string;
};

const INTERIOR_BY_KIND: Partial<Record<CatalogKind, { type: ZoneType; label: string }>> = {
  furniture: { type: "home", label: "the house" },
  machine: { type: "arcade", label: "the hall" },
  dungeon: { type: "keep", label: "the keep" },
  cave: { type: "keep", label: "the hollow" },
  space: { type: "lab", label: "the station" },
};

export type ZoneProgram = {
  interior: ZonePlan | null;
  market: boolean;
  garden: boolean;
  harbor: boolean;
  street: boolean;
  skyline: boolean;
};

export function planZones(byRole: Record<Role, CatalogItem[]>): ZoneProgram {
  const interiorCounts = new Map<CatalogKind, number>();
  for (const item of byRole.structure) {
    const plan = INTERIOR_BY_KIND[item.kind];
    if (plan) interiorCounts.set(item.kind, (interiorCounts.get(item.kind) ?? 0) + 1);
  }
  let interior: ZonePlan | null = null;
  let best = 0;
  for (const [kind, count] of interiorCounts) {
    if (count >= 4 && count > best) {
      best = count;
      interior = INTERIOR_BY_KIND[kind] ?? null;
    }
  }
  const stalls = byRole.structure.filter((i) => i.kind === "stall").length;
  return {
    interior,
    market: stalls >= 2 && interior?.type !== "home",
    garden: byRole.scenery.length + byRole.ground.length >= 5,
    harbor: byRole.vessel.length >= 1,
    street: byRole.vehicle.length >= 2,
    skyline: byRole.backdrop.length >= 2,
  };
}

function mainMaterial(items: CatalogItem[]): PlatformMaterial {
  const packs = new Map<string, number>();
  for (const item of items) packs.set(item.pack, (packs.get(item.pack) ?? 0) + 1);
  const top = [...packs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  if (["pirate", "watercraft"].includes(top)) return "sand";
  if (["nature", "mini-forest", "survival", "pets", "toy-car"].includes(top)) return "grass";
  if (["car", "buildings", "mini-market", "mini-arcade", "mini-skate", "coaster"].includes(top)) return "stone";
  if (["cave", "modular-dungeon", "mini-dungeon", "mini-arena"].includes(top)) return "stone";
  if (["space", "prototype"].includes(top)) return "tile";
  return "grass";
}

type Corner = "nw" | "ne" | "sw";
// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export function composeScenePlan(
  theme: string,
  occupied: Iterable<OccupiedBody> = [],
  sceneSeed?: string,
): ComposedPlan {
  // The scene seed is the ONLY source of variation. Same prompt + same seed
  // = same world; a fresh seed is minted when none is given (a new scene).
  const seedStr = sceneSeed && isValidSeed(sceneSeed) ? normalizeSeed(sceneSeed) : generateSceneSeed(theme);
  // One derived seed per subsystem: reselecting decoration must never
  // reshuffle the architecture, and vice versa.
  const items = selectItems(theme, deriveSeed(seedStr, "selection"));
  const propSeed = deriveSeed(seedStr, "props");

  const byRole: Record<Role, CatalogItem[]> = {
    ground: [], wall: [], connector: [], structure: [], backdrop: [],
    track: [], tabletop: [], vessel: [], vehicle: [], person: [], scenery: [],
  };
  for (const item of items) byRole[roleOf(item)].push(item);
  const structures = [...byRole.structure].sort((a, b) => visualMass(b) - visualMass(a));

  const zonePlan = planZones(byRole);
  const rng = createSeededRandom(deriveSeed(seedStr, "layout"));
  const extraZones =
    (zonePlan.interior ? 1 : 0) + (zonePlan.market ? 1 : 0) + (zonePlan.garden ? 1 : 0) +
    (zonePlan.harbor ? 1 : 0) + (zonePlan.street ? 1 : 0);

  // --- Footprint: a seeded ORGANIC island, never a plain slab. -------------
  // Harmonic coastlines, seeded lobes, and a rotation mean every seed owns a
  // silhouette of its own; the mask decomposes into strips so all rect-based
  // consumers (deck voxels, grounding, fencing) stay exact.
  const tall = rng() > 0.45;
  const spanW = Math.min(17, (tall ? 11 : 13) + extraZones + Math.floor(rng() * 3));
  const spanD = Math.min(15, (tall ? 13 : 9) + Math.floor(extraZones / 2) + Math.floor(rng() * 3));
  const center = {
    col: ORIGIN.col + Math.floor(rng() * 5) - 2,
    row: ORIGIN.row + Math.floor(rng() * 3) - 1,
  };
  const island = generateIslandMask(rng, center, spanW / 2, spanD / 2);
  const main = island.bbox;
  const { c0, r0, w: mainW, d: mainD } = main;
  // The prompt summons a THEME — a whole material ecosystem, not a texture.
  const themeSpec = resolveTheme(theme, mainMaterial(items));
  const material = themeSpec.primary;
  const corner: Corner = (["nw", "ne", "sw"] as const)[Math.floor(rng() * 3)];
  const harborSide: HarborSide = (["e", "s", "w"] as const)[Math.floor(rng() * 3)];
  // The biggest rectangle the coastline allows — zones and the focal live here.
  const core = largestRectInMask(island);

  const env: EnvironmentSpec = {
    platforms: maskToRects(island).map((rect, i) => ({ id: `main-${i}`, rect, level: 0, material })),
    walls: [],
    stairs: [],
    paths: [],
    water: [],
    zones: [],
    themeId: themeSpec.id,
    pathMaterial: themeSpec.pathMaterial,
    // Intentional material patches — the ground is an ecosystem, not a tile.
    ground: paintTerrain(island, themeSpec, seedStr),
  };
  const board = new Board(occupied);
  const placements: Placement[] = [];
  const zones: ZoneSpec[] = [];
  const zoneRects: LotRect[] = [];

  const biasFor = (which: Corner | "se") =>
    which === "ne"
      ? { col: c0 + mainW - 2, row: r0 + 1 }
      : which === "sw"
        ? { col: c0 + 1, row: r0 + mainD - 2 }
        : which === "se"
          ? { col: c0 + mainW - 2, row: r0 + mainD - 2 }
          : { col: c0 + 1, row: r0 + 1 };

  // --- Interior: a raised, walled room wherever the coastline allows -------
  let interiorRect: LotRect | null = null;
  if (zonePlan.interior) {
    const w = Math.max(3, Math.min(4 + Math.floor(rng() * 3), core.w - 1));
    const d = Math.max(3, Math.min(3 + Math.floor(rng() * 2), core.d - 1));
    interiorRect = findZoneRect(island, zoneRects, w, d, biasFor(corner));
    if (interiorRect) {
      zoneRects.push(interiorRect);
      env.platforms.push({
        id: "terrace",
        rect: interiorRect,
        level: 1,
        material: zonePlan.interior.type === "home" ? "wood" : "tile",
      });
      env.walls.push(
        { id: "terrace-n", c: interiorRect.c0, r: interiorRect.r0, len: interiorRect.w, dir: "h", side: "n", height: 1.7 },
        { id: "terrace-w", c: interiorRect.c0, r: interiorRect.r0, len: interiorRect.d, dir: "v", side: "w", height: 1.7 },
      );
      // The stair lands on the first coast-approved side: south (open), east
      // (unwalled), then north.
      const midC = interiorRect.c0 + Math.floor(interiorRect.w / 2);
      const midR = interiorRect.r0 + Math.floor(interiorRect.d / 2);
      const stairSpots = [
        { at: { col: midC, row: interiorRect.r0 + interiorRect.d }, dir: "n" as const },
        { at: { col: interiorRect.c0 + interiorRect.w, row: midR }, dir: "w" as const },
        { at: { col: midC, row: interiorRect.r0 - 1 }, dir: "s" as const },
      ];
      const stair = stairSpots.find((s) => maskHas(island, s.at.col, s.at.row));
      if (stair) {
        env.stairs.push({ id: "terrace-stair", at: stair.at, dir: stair.dir, fromLevel: 0, toLevel: 1 });
        board.taken.add(key(stair.at.col, stair.at.row));
      }
      zones.push({
        id: "interior",
        type: zonePlan.interior.type,
        label: zonePlan.interior.label,
        rect: interiorRect,
        level: 1,
        focal: rectCenter(interiorRect),
      });
    }
  }

  // --- Market: an aisle strip seated on the mask ---------------------------
  let marketRect: LotRect | null = null;
  if (zonePlan.market) {
    const west = corner === "ne" || (corner !== "nw" && rng() > 0.5);
    const bias = { col: west ? c0 + 1 : c0 + mainW - 2, row: r0 + Math.floor(mainD / 2) };
    marketRect = findZoneRect(island, zoneRects, 3, Math.min(6, Math.max(4, core.d - 1)), bias);
    if (marketRect) {
      zoneRects.push(marketRect);
      zones.push({
        id: "market",
        type: "market",
        label: "the market row",
        rect: marketRect,
        level: 0,
        focal: rectCenter(marketRect),
      });
    }
  }

  // --- Garden: opposite the interior so the two rooms don't stack ----------
  let gardenRect: LotRect | null = null;
  if (zonePlan.garden) {
    const gw = Math.max(3, Math.min(3 + Math.floor(rng() * 3), core.w - 1));
    const gd = Math.max(3, Math.min(3 + Math.floor(rng() * 2), 5));
    const opposite: Corner | "se" = corner === "nw" ? "se" : corner === "ne" ? "sw" : "ne";
    gardenRect = findZoneRect(island, zoneRects, gw, gd, biasFor(interiorRect ? opposite : "sw"));
    if (gardenRect) {
      zoneRects.push(gardenRect);
      const bedMaterial =
        themeSpec.id === "candy" ? "candy-mint"
        : themeSpec.id === "snow" ? "grass-dark"
        : themeSpec.id === "spooky" ? "grass-dry"
        : themeSpec.id === "volcanic" || themeSpec.id === "dungeon" ? "moss"
        : "grass";
      if (material !== bedMaterial) {
        env.platforms.push({ id: "garden-bed", rect: gardenRect, level: 0, material: bedMaterial, inset: true });
      }
      zones.push({
        id: "garden",
        type: "garden",
        label: "the garden",
        rect: gardenRect,
        level: 0,
        focal: rectCenter(gardenRect),
      });
    }
  }

  // --- Harbor: water hugging the actual coastline, pier from the coast -----
  byRole.vessel = [...byRole.vessel].sort((a, b) => visualMass(b) - visualMass(a)).slice(0, 6);
  if (zonePlan.harbor) {
    const span = 5 + Math.ceil(byRole.vessel.length / 2) * 3;
    const depth = Math.min(8, span) + 2;
    let pier: LotRect;
    let harborFocal: { col: number; row: number };
    if (harborSide === "s") {
      const pierCol = center.col;
      const coastRow = southCoastRow(island, pierCol) ?? r0 + mainD - 1;
      pier = { c0: pierCol, r0: coastRow + 1, w: 1, d: 2 };
      harborFocal = { col: pierCol, row: coastRow + 3 };
    } else if (harborSide === "w") {
      const pierRow = center.row;
      const coastCol = coastColInRow(island, pierRow, "w") ?? c0;
      pier = { c0: coastCol - 2, r0: pierRow, w: 2, d: 1 };
      harborFocal = { col: coastCol - 3, row: pierRow };
    } else {
      const pierRow = center.row;
      const coastCol = coastColInRow(island, pierRow, "e") ?? c0 + mainW - 1;
      pier = { c0: coastCol + 1, r0: pierRow, w: 2, d: 1 };
      harborFocal = { col: coastCol + 4, row: pierRow };
    }
    const waterMask = generateHarborWaterMask(island, harborSide, rng, depth);
    pushWaterMask(env.water, waterMask, "harbor-water", 0);
    env.platforms.push({ id: "pier", rect: pier, level: 0, material: "wood" });
    zones.push({
      id: "harbor",
      type: "harbor",
      label: "the harbor",
      rect: waterMask.bbox,
      level: 0,
      focal: harborFocal,
    });
  }

  // --- Street: a road shoulder hugging the southern coast ------------------
  let streetRect: LotRect | null = null;
  if (zonePlan.street) {
    // Find the deepest southern coastline and the longest run that touches it.
    let anchorRow = -Infinity;
    const southRows = new Map<number, number>();
    for (let col = c0; col < c0 + mainW; col += 1) {
      const row = southCoastRow(island, col);
      if (row != null) {
        southRows.set(col, row);
        if (row > anchorRow) anchorRow = row;
      }
    }
    let runStart = c0;
    let runLen = 0;
    let bestStart = c0;
    let bestLen = 0;
    for (let col = c0; col < c0 + mainW; col += 1) {
      const row = southRows.get(col);
      if (row != null && row >= anchorRow - 1) {
        if (runLen === 0) runStart = col;
        runLen += 1;
        if (runLen > bestLen) {
          bestLen = runLen;
          bestStart = runStart;
        }
      } else {
        runLen = 0;
      }
    }
    if (bestLen >= 4 && Number.isFinite(anchorRow)) {
      streetRect = { c0: bestStart, r0: anchorRow + 1, w: bestLen, d: 2 };
      env.platforms.push({ id: "road", rect: streetRect, level: 0, material: "road" });
      zones.push({
        id: "street",
        type: "street",
        label: "the street",
        rect: streetRect,
        level: 0,
        focal: rectCenter(streetRect),
      });
    }
  }

  // --- Skyline: a raised shelf along the far (north) edge, width varies ----
  let skylineRect: LotRect | null = null;
  if (zonePlan.skyline) {
    const inset = 1 + Math.floor(rng() * 3);
    skylineRect = { c0: c0 + inset, r0: r0 - 2 - Math.floor(rng() * 2), w: Math.max(4, mainW - inset * 2), d: 2 };
    env.platforms.push({ id: "rise", rect: skylineRect, level: 1, material });
    zones.push({
      id: "skyline",
      type: "skyline",
      label: "the rise behind town",
      rect: skylineRect,
      level: 1,
      focal: rectCenter(skylineRect),
    });
  }

  // --- Plaza: the core clearing; focal offset so it's never dead center ----
  const focal = {
    col: Math.min(core.c0 + core.w - 2, Math.max(core.c0 + 1, core.c0 + Math.round(core.w * (0.3 + rng() * 0.4)))),
    row: Math.min(core.r0 + core.d - 2, Math.max(core.r0 + 1, core.r0 + Math.round(core.d * (0.3 + rng() * 0.4)))),
  };
  const plazaRect: LotRect = core;
  zones.push({ id: "plaza", type: "plaza", label: "the square", rect: plazaRect, level: 0, focal });
  env.zones = zones;

  // --- Paths: coast entrance to focal, stair to focal — on land only -------
  const paths: PathSpec[] = [];
  const entranceStart = southCoastRow(island, focal.col) ?? r0 + mainD - 1;
  const pathCells: { col: number; row: number }[] = [];
  for (let r = entranceStart; r >= focal.row; r -= 1) {
    if (maskHas(island, focal.col, r)) pathCells.push({ col: focal.col, row: r });
  }
  paths.push({ id: "entrance", cells: pathCells });
  if (env.stairs.length) {
    const stair = env.stairs[0];
    const cells: { col: number; row: number }[] = [];
    const dir = stair.at.col <= focal.col ? 1 : -1;
    for (let cCur = stair.at.col; cCur !== focal.col; cCur += dir) cells.push({ col: cCur, row: stair.at.row });
    for (let rCur = stair.at.row; rCur !== focal.row; rCur += Math.sign(focal.row - stair.at.row) || 1) {
      cells.push({ col: focal.col, row: rCur });
      if (rCur === focal.row) break;
    }
    paths.push({ id: "stair-walk", cells: cells.filter((cell) => maskHas(island, cell.col, cell.row)) });
  }
  env.paths = paths;
  for (const path of paths) {
    for (const cell of path.cells) board.softReserved.add(key(cell.col, cell.row));
  }

  // Breathing room — a clear ring around the focal keeps the centerpiece
  // readable. Negative space is part of the composition, not leftover.
  for (let dc = -1; dc <= 1; dc += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      if (dc || dr) board.softReserved.add(key(focal.col + dc, focal.row + dr));
    }
  }

  // --- Fill: landmark first, then zone by zone -----------------------------
  // Every placement is fenced to the architecture: decks for everything,
  // water additionally allowed for vessels. A piece that can't find a valid
  // cell is DROPPED — the composition never leaks outside its own scene.
  const onDeck = (col: number, row: number) => env.platforms.some((p) => rectContains(p.rect, col, row));
  const onWater = (col: number, row: number) =>
    env.water.some((w) => rectContains(w.rect, col, row)) || onDeck(col, row);
  const place = (
    item: CatalogItem,
    col: number,
    row: number,
    reason: string,
    opts: {
      flip?: boolean;
      rot?: number;
      ring?: number;
      allowSoft?: boolean;
      surface?: "deck" | "water";
      tight?: boolean;
    } = {},
  ) => {
    const valid = opts.surface === "water" ? onWater : onDeck;
    const radius = opts.tight ? Math.min(0.4, clearanceLots(item) * 0.35) : clearanceLots(item);
    const ring = opts.tight
      ? (opts.ring ?? 0)
      : Math.max(opts.ring ?? 1, Math.ceil(radius * 2) + 3);
    const spot = board.claimNear(col, row, ring, opts.allowSoft ?? false, valid, radius);
    if (!spot) return false;
    placements.push({ item, col: spot.col, row: spot.row, flip: opts.flip, rot: opts.rot, reason });
    return true;
  };

  // --- Environmental framing: the boundary comes BEFORE the props ----------
  // A dense, seeded ring on the actual coastline (forest edge, standing
  // stones) with deliberate gaps: the entrance, the pier, the street, and
  // anywhere the water meets the shore.
  {
    const frameSkip = new Set<string>();
    for (const path of env.paths) {
      for (const cell of path.cells) {
        for (let dc = -1; dc <= 1; dc += 1) {
          for (let dr = -1; dr <= 1; dr += 1) {
            frameSkip.add(cellKey(cell.col + dc, cell.row + dr));
          }
        }
      }
    }
    for (const p of env.platforms) {
      if (p.id === "pier" || p.material === "road") {
        for (let r = p.rect.r0 - 1; r <= p.rect.r0 + p.rect.d; r += 1) {
          for (let c = p.rect.c0 - 1; c <= p.rect.c0 + p.rect.w; c += 1) {
            frameSkip.add(cellKey(c, r));
          }
        }
      }
    }
    for (const w of env.water) {
      for (let r = w.rect.r0 - 1; r <= w.rect.r0 + w.rect.d; r += 1) {
        for (let c = w.rect.c0 - 1; c <= w.rect.c0 + w.rect.w; c += 1) {
          frameSkip.add(cellKey(c, r));
        }
      }
    }
    for (const s of env.stairs) frameSkip.add(cellKey(s.at.col, s.at.row));
    // Functional zones stay grove-free — no tree in the market aisle or on
    // the terrace floor. The plaza and garden may take a little spill.
    const NO_GROVE: ZoneType[] = ["home", "arcade", "keep", "lab", "market"];
    for (const zone of zones) {
      if (!NO_GROVE.includes(zone.type)) continue;
      for (let r = zone.rect.r0; r < zone.rect.r0 + zone.rect.d; r += 1) {
        for (let c = zone.rect.c0; c < zone.rect.c0 + zone.rect.w; c += 1) {
          frameSkip.add(cellKey(c, r));
        }
      }
    }
    for (const p of planBoundary(island, themeSpec, seedStr, frameSkip)) {
      place(p.item, p.col, p.row, p.reason, { ring: 0, tight: true, allowSoft: true, flip: p.flip });
    }
  }

  let landmark: CatalogItem | undefined = structures[0];
  const support = structures.slice(1);
  if (!landmark) {
    // No built structures in this theme — promote the most massive scenery
    // piece (a grand tree, a rock formation) so the center still holds focus.
    const scenery = [...byRole.scenery].sort((a, b) => visualMass(b) - visualMass(a));
    if (scenery[0]) {
      landmark = scenery[0];
      byRole.scenery = byRole.scenery.filter((i) => i !== landmark);
    }
  }
  if (landmark) {
    board.softReserved.delete(key(focal.col, focal.row));
    place(landmark, focal.col, focal.row, "the centerpiece", { ring: 2 });
  }

  // Interior room: heavy pieces along the back walls, one center table, decor corners.
  const interiorItems = zonePlan.interior
    ? support.filter((i) => INTERIOR_BY_KIND[i.kind]?.type === zonePlan.interior?.type)
    : [];
  // Shop fixtures belong in the market row — machines (freezers, registers,
  // vending) read as scattered appliances anywhere else. An arcade interior
  // has first claim on its machines.
  const marketStalls = marketRect
    ? support.filter((i) => !interiorItems.includes(i) && (i.kind === "stall" || i.kind === "machine"))
    : [];
  const plazaSupport = support.filter((i) => !interiorItems.includes(i) && !marketStalls.includes(i)).slice(0, 6);
  if (interiorRect && interiorItems.length) {
    const { c0: ic, r0: ir, w, d } = interiorRect;
    const wallRow = interiorItems.filter((_, i) => i % 2 === 0).slice(0, w);
    const innerRow = interiorItems.filter((_, i) => i % 2 === 1).slice(0, Math.max(1, w - 1));
    wallRow.forEach((item, i) => {
      place(item, ic + (i % w), ir + Math.floor(i / w), `along the back of ${zones[0].label}`, { rot: 0, ring: 1 });
    });
    innerRow.forEach((item, i) => {
      place(item, ic + 1 + (i % Math.max(1, w - 2)), ir + d - 1 - Math.floor(i / Math.max(1, w - 2)), `inside ${zones[0].label}`, {
        rot: i % 2 ? 90 : 0,
        ring: 1,
      });
    });
  }

  // Plaza: a few clusters around the landmark, not a ring of identical houses.
  const arms: { dc: number; dr: number }[] = [
    { dc: -3, dr: 2 },
    { dc: 3, dr: 2 },
    { dc: 0, dr: 4 },
    { dc: -4, dr: -1 },
    { dc: 4, dr: -1 },
    { dc: 2, dr: -3 },
  ];
  const armStart = Math.floor(rng() * arms.length);
  plazaSupport.forEach((item, i) => {
    const cell = arms[(armStart + i) % arms.length];
    const col = focal.col + cell.dc;
    const row = focal.row + cell.dr;
    place(item, col, row, "around the centerpiece", { rot: faceToward(col, row, focal), ring: 2 });
  });

  // Market: stalls in two facing columns with an aisle between.
  if (marketRect) {
    let si = 0;
    for (const item of marketStalls) {
      const side = si % 2; // 0 = west column, 1 = east column
      const row = marketRect.r0 + Math.floor(si / 2);
      if (row >= marketRect.r0 + marketRect.d) break;
      const col = side === 0 ? marketRect.c0 : marketRect.c0 + marketRect.w - 1;
      place(item, col, row, "among the market stalls", { rot: side === 0 ? 270 : 90, ring: 0 });
      si += 1;
    }
  }

  // Tabletop goods: tight spreads beside the stalls or the plaza fixtures.
  const hosts = placements.filter((p) => p.reason === "among the market stalls" || p.reason === "around the centerpiece");
  const TABLE_OFFSETS: [number, number][] = [[1, 0], [0, 1], [1, 1]];
  byRole.tabletop.forEach((item, i) => {
    const host = hosts.length ? hosts[Math.floor(i / 3) % hosts.length] : { col: focal.col + 2, row: focal.row + 2 };
    const [dc, dr] = TABLE_OFFSETS[i % 3];
    place(item, host.col + dc, host.row + dr, "laid out on the table", { ring: 1 });
  });

  // Garden: trees spaced by their canopy, low plants filling the gaps.
  if (gardenRect) {
    const trees = byRole.scenery.filter((i) => i.kind === "tree").slice(0, 8);
    const lowPlants = byRole.scenery.filter((i) => i.kind !== "tree").slice(0, 8);
    trees.forEach((item, i) => {
      const step = Math.max(2, Math.ceil(clearanceLots(item) * 2));
      const cols = Math.max(1, Math.floor(gardenRect.w / step));
      const col = gardenRect.c0 + (i % cols) * step + (propSeed % 2 ? 0 : 1);
      const row = gardenRect.r0 + Math.floor(i / cols) * step;
      place(item, col, row, "keeping the garden", { ring: 6 });
    });
    lowPlants.forEach((item, i) => {
      const step = Math.max(2, Math.ceil(clearanceLots(item) * 2));
      place(
        item,
        gardenRect.c0 + ((i * step + 1) % Math.max(1, gardenRect.w)),
        gardenRect.r0 + (Math.floor((i * step) / Math.max(1, gardenRect.w)) % Math.max(1, gardenRect.d)),
        "keeping the garden",
        { ring: 5 },
      );
    });
    byRole.ground.slice(0, 6).forEach((item, i) => {
      const step = Math.max(2, Math.ceil(clearanceLots(item) * 2));
      place(
        item,
        gardenRect.c0 + ((i * step) % Math.max(1, gardenRect.w)),
        gardenRect.r0 + ((i * step) % Math.max(1, gardenRect.d)),
        "the ground underfoot",
        { ring: 4, allowSoft: false },
      );
    });
  } else {
    // No garden — scenery frames the north and west edges of the platform.
    byRole.scenery.forEach((item, i) => {
      const step = Math.max(2, Math.ceil(clearanceLots(item) * 2));
      const north = i % 2 === 0;
      const n = Math.floor(i / 2);
      const col = north ? c0 + 1 + ((n * step) % Math.max(1, mainW - 2)) : c0 + (n % 2);
      const row = north ? r0 + (n % 2) : r0 + 1 + ((n * step) % Math.max(1, mainD - 2));
      place(item, col, row, "framing the scene", { ring: 5 });
    });
    byRole.ground.forEach((item, i) => {
      place(item, focal.col - 3 + (i % 6) * 2, focal.row - 2 + Math.floor(i / 6) * 2, "the ground underfoot", {
        ring: 4,
      });
    });
  }

  // Walls-as-items (fences etc.) run the north edge outside the built area.
  byRole.wall.forEach((item, i) => {
    place(item, c0 + 1 + i, r0, "the back edge", { ring: 1 });
  });

  // Harbor: connectors on the pier, flotilla staggered offshore.
  if (zonePlan.harbor) {
    const pier = env.platforms.find((p) => p.id === "pier");
    byRole.connector.forEach((item, i) => {
      if (pier) place(item, pier.rect.c0 + (harborSide === "s" ? 0 : i), pier.rect.r0 + (harborSide === "s" ? i : 0), "out over the water", { ring: 0 });
    });
    const baseCol = pier
      ? pier.rect.c0 + (harborSide === "w" ? -2 : harborSide === "s" ? 0 : 2)
      : c0 + mainW + 2;
    const baseRow = pier
      ? pier.rect.r0 + (harborSide === "s" ? 2 : 0)
      : r0 + Math.floor(mainD / 2);
    byRole.vessel.forEach((item, i) => {
      const dc = harborSide === "s" ? (i % 2 === 0 ? -3 : 3) + Math.floor(i / 4) : Math.floor(i / 2) * 4 + (i % 2) * 2;
      const dr = harborSide === "s" ? Math.floor(i / 2) * 3 : (i % 2 === 0 ? -3 : 3) + Math.floor(i / 4);
      place(
        item,
        baseCol + dc,
        baseRow + dr,
        i === 0 ? "flagship off the shore" : "riding at anchor",
        { ring: 1, allowSoft: true, surface: "water" },
      );
    });
  } else {
    // No water — boats beach along the east edge instead of floating nowhere.
    byRole.vessel.forEach((item, i) => {
      place(item, c0 + mainW - 2, r0 + 1 + i * 2, "hauled up on shore", { ring: 1 });
    });
    byRole.connector.forEach((item, i) => {
      place(item, focal.col + 3 + i, focal.row, "bridging the square", { ring: 1 });
    });
  }

  // Street: vehicles nose-to-tail; two facing lanes once there's a jam.
  if (streetRect) {
    const lanes = byRole.vehicle.length > 5 ? 2 : 1;
    const perLane = Math.ceil(byRole.vehicle.length / lanes);
    byRole.vehicle.forEach((item, i) => {
      const lane = Math.floor(i / perLane);
      place(item, streetRect.c0 + 1 + (i % perLane) * 2, streetRect.r0 + lane, lanes > 1 ? "backed up in the jam" : "rolling down the street", {
        rot: lane % 2 === 0 ? 270 : 90,
        ring: 1,
        allowSoft: true,
      });
    });
  } else {
    byRole.vehicle.forEach((item, i) => {
      place(item, c0 + 2 + (i % (mainW - 4)) * 2, r0 + mainD - 1, "parked along the front", { rot: 270, ring: 1 });
    });
  }

  // Skyline: facades shoulder to shoulder on the rise.
  if (skylineRect) {
    let col = skylineRect.c0 + 1 + (propSeed % 2);
    byRole.backdrop.slice(0, 4).forEach((item, i) => {
      place(item, col, skylineRect.r0 + (i % skylineRect.d), "raising the skyline", { ring: 1, allowSoft: true });
      col += 2 + (i % 2);
      if (col >= skylineRect.c0 + skylineRect.w - 1) col = skylineRect.c0 + 1;
    });
  } else {
    let col = c0 + 1 + (propSeed % 3);
    byRole.backdrop.slice(0, 4).forEach((item, i) => {
      place(item, col, r0, "raising the skyline", { ring: 1 });
      col += 2 + (i % 2);
    });
  }

  // Track: a CONTIGUOUS circuit that follows the island's own coastline —
  // consecutive segments walk the shore ring in angular order, so the ride
  // hugs whatever silhouette this seed drew.
  if (byRole.track.length) {
    const walk: { col: number; row: number; ang: number }[] = [];
    for (const cellId of island.cells) {
      const [col, row] = cellId.split(":").map(Number);
      const onCoast =
        !maskHas(island, col + 1, row) ||
        !maskHas(island, col - 1, row) ||
        !maskHas(island, col, row + 1) ||
        !maskHas(island, col, row - 1);
      if (onCoast) walk.push({ col, row, ang: Math.atan2(row - center.row, col - center.col) });
    }
    walk.sort((a, b) => a.ang - b.ang);
    if (walk.length) {
      const start = propSeed % walk.length;
      byRole.track.slice(0, walk.length).forEach((item, i) => {
        place(item, walk[(start + i) % walk.length].col, walk[(start + i) % walk.length].row, "laying the circuit", {
          ring: 0,
          allowSoft: true,
          tight: true,
        });
      });
    }
  }

  // People last — they live near the action. Each zone gets an anchor crowd;
  // pets favor the garden and the square.
  const anchors: { col: number; row: number; label: string; rect: LotRect }[] = [];
  for (const zone of zones) {
    if (zone.focal && zone.type !== "skyline" && zone.type !== "harbor") {
      anchors.push({ col: Math.round(zone.focal.col), row: Math.round(zone.focal.row), label: zone.label, rect: zone.rect });
    }
  }
  if (!anchors.length) anchors.push({ col: focal.col, row: focal.row, label: "the square", rect: plazaRect });
  byRole.person.forEach((item, i) => {
    const anchor = anchors[i % anchors.length];
    const jitter = [(i * 7) % 3 - 1, ((i * 5) % 3) - 1];
    // People belong INSIDE their zone — clamp the jitter to its bounds so a
    // wanderer never drifts past the rect it is meant to inhabit.
    const col = Math.min(anchor.rect.c0 + anchor.rect.w - 1, Math.max(anchor.rect.c0, anchor.col + jitter[0]));
    const row = Math.min(anchor.rect.r0 + anchor.rect.d - 1, Math.max(anchor.rect.r0, anchor.row + 1 + jitter[1]));
    place(item, col, row, i % 3 === 0 ? `taking in ${anchor.label}` : `together in ${anchor.label}`, {
      rot: faceToward(col, row, anchor),
      flip: i % 2 === 1,
      ring: 1,
      allowSoft: true,
    });
  });

  // --- Convert to todos ----------------------------------------------------
  const todos: SceneTodo[] = [];
  let n = 0;
  for (const p of placements) {
    n += 1;
    todos.push({
      id: `t${n}`,
      place: p.item.id,
      kind: p.item.kind,
      lot: lotIdOf(p.col, p.row),
      flip: Boolean(p.flip),
      ...(p.rot ? { rot: p.rot } : {}),
      reason: p.reason,
    });
  }
  return { env: withWaterPaint(env, seedStr), todos, seed: seedStr };
}
