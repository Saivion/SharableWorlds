import type { CatalogItem } from "../catalog";
import type { Archetype, ElementSpec, ZoneRole } from "./archetypes";
import { planBuilding, walledSides } from "./buildings";
import { rectCenter, rectContains, lotIdOf, type LotRect } from "./grid3d";
import type { SceneIntent } from "./intent";
import {
  cellKey,
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
  type IslandMask,
} from "./island";
import { Board, faceToward, facingVector, groupByRole, key, planZones, type OccupiedBody, type Placement, type PlanPhase } from "./layout";
import { fillToDensity, fillWater, keepClearFor } from "./density";
import { cycleItems, pickItems } from "./pick";
import { roleOf } from "./roles";
import { clearanceLots } from "./scale3d";
import { createSeededRandom, deriveSeed } from "./seed";
import { selectItems } from "./select";
import { platformAt, stairApproachLots } from "./surface";
import { planRelief, reliefIntensity } from "./relief";
import { paintTerrain, planBoundary, withWaterPaint } from "./terrain";
import type { ThemeSpec } from "./themes";
import type { EnvironmentSpec, PathSpec, PlatformMaterial, WallSide, ZoneSpec, ZoneType } from "./types";

/**
 * The archetype program — INTENT → PLAN → COMPOSITION, deterministically.
 *
 *   1. footprint: a seeded organic island sized for the zone count
 *   2. zones: every ZoneRole seated where the archetype wants it (interiors
 *      raise walled terraces with a stair, markets cut aisles, harbors dig
 *      water and build a pier, streets pour road, skylines raise a rise)
 *   3. circulation: the entrance from the coast and the walks between zones,
 *      ending one cell short of every focal so the landmark is a pedestal,
 *      never a blocker
 *   4. elements: each archetype element arranged by its own grammar and
 *      FENCED to its zone and level — a piece that finds no room in its zone
 *      is dropped and reported, never nudged into the void or the next zone
 *   5. people: actors at the story objects, facing them
 *   6. environment: the framing boundary, then a little seeded texture
 *
 * The seed decides which valid variation is built. The ledger records what
 * the composition wanted versus what it could place, so validation can score
 * intent coverage and fidelity instead of counting things.
 */

export type LedgerEntry = {
  role: string;
  label: string;
  zone: string;
  required: boolean;
  supporting: boolean;
  wanted: number;
  placed: number;
  /** Lots the program placed for this element. */
  lots: string[];
};

export type ProgramPlan = {
  env: EnvironmentSpec;
  placements: Placement[];
  ledger: LedgerEntry[];
  /** Required elements the program could not seat at all. */
  missing: string[];
};

const ORIGIN = { col: 12, row: 12 }; // M13 — the home window's center

const INTERIOR_TYPES = new Set<ZoneType>(["home", "arcade", "keep", "lab"]);

const ZONE_DIMS: Record<"small" | "medium" | "large", Record<string, { w: number; d: number }>> = {
  small: { interior: { w: 4, d: 3 }, market: { w: 3, d: 4 }, garden: { w: 3, d: 3 }, deck: { w: 3, d: 2 }, skyline: { w: 5, d: 2 } },
  medium: { interior: { w: 5, d: 4 }, market: { w: 3, d: 5 }, garden: { w: 4, d: 3 }, deck: { w: 4, d: 3 }, skyline: { w: 8, d: 2 } },
  large: { interior: { w: 7, d: 5 }, market: { w: 3, d: 6 }, garden: { w: 5, d: 4 }, deck: { w: 5, d: 4 }, skyline: { w: 11, d: 2 } },
};

function dimsFor(zone: ZoneRole, core: LotRect): { w: number; d: number } {
  const family = INTERIOR_TYPES.has(zone.type) ? "interior" : zone.type === "market" ? "market" : zone.type === "garden" ? "garden" : zone.type === "skyline" ? "skyline" : "deck";
  const base = ZONE_DIMS[zone.size][family];
  return { w: Math.max(3, Math.min(base.w, core.w - 1)), d: Math.max(2, Math.min(base.d, core.d - 1)) };
}

function biasFor(location: ZoneRole["location"], m: LotRect) {
  switch (location) {
    case "north":
      return { col: m.c0 + m.w / 2, row: m.r0 + 1 };
    case "south":
      return { col: m.c0 + m.w / 2, row: m.r0 + m.d - 2 };
    case "east":
      return { col: m.c0 + m.w - 2, row: m.r0 + m.d / 2 };
    case "west":
      return { col: m.c0 + 1, row: m.r0 + m.d / 2 };
    default:
      return { col: m.c0 + m.w / 2, row: m.r0 + m.d / 2 };
  }
}

function bedMaterialFor(theme: ThemeSpec): PlatformMaterial {
  return theme.id === "candy" ? "candy-mint"
    : theme.id === "snow" ? "grass-dark"
    : theme.id === "spooky" ? "grass-dry"
    : theme.id === "volcanic" || theme.id === "dungeon" ? "moss"
    : "grass";
}

type Seated = { zone: ZoneSpec; role: ZoneRole };

type Ctx = {
  env: EnvironmentSpec;
  island: IslandMask;
  board: Board;
  zones: Seated[];
  byRole: Map<string, Seated>;
  placements: Placement[];
  placedByRole: Map<string, Placement[]>;
  entrance: { col: number; row: number } | null;
  pathCells: { col: number; row: number }[];
  rng: () => number;
  seed: string;
};

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

function seatInterior(ctx: Ctx, role: ZoneRole, rect: LotRect, theme: ThemeSpec): ZoneSpec {
  const { env, island } = ctx;
  // Every building is its own seeded design: walls, parapets, doorway,
  // height, palette, floor — the stair always on an open side.
  const building = planBuilding({
    id: role.role,
    type: role.type,
    rect,
    onDeck: (c, r) => maskHas(island, c, r),
    theme,
    rng: createSeededRandom(deriveSeed(ctx.seed, `building:${role.role}`)),
  });
  env.platforms.push(...building.platforms);
  env.walls.push(...building.walls);
  const stair = building.stair;
  env.stairs.push(stair);
  ctx.board.taken.add(key(stair.at.col, stair.at.row));
  const c = rectCenter(rect);
  return { id: role.role, type: role.type, label: role.label, rect, level: 1, focal: { col: Math.round(c.col), row: Math.round(c.row) } };
}

function seatHarbor(ctx: Ctx, role: ZoneRole, side: HarborSide, vesselCount: number): ZoneSpec {
  const { env, island, rng } = ctx;
  const m = island.bbox;
  const center = { col: m.c0 + Math.floor(m.w / 2), row: m.r0 + Math.floor(m.d / 2) };
  const span = 5 + Math.ceil(Math.max(2, vesselCount) / 2) * 3;
  const depth = Math.min(8, span) + 2;
  let pier: LotRect;
  let focal: { col: number; row: number };
  if (side === "s") {
    const coastRow = southCoastRow(island, center.col) ?? m.r0 + m.d - 1;
    pier = { c0: center.col, r0: coastRow + 1, w: 1, d: 2 };
    focal = { col: center.col, row: coastRow + 4 };
  } else if (side === "w") {
    const coastCol = coastColInRow(island, center.row, "w") ?? m.c0;
    pier = { c0: coastCol - 2, r0: center.row, w: 2, d: 1 };
    focal = { col: coastCol - 4, row: center.row };
  } else {
    const coastCol = coastColInRow(island, center.row, "e") ?? m.c0 + m.w - 1;
    pier = { c0: coastCol + 1, r0: center.row, w: 2, d: 1 };
    focal = { col: coastCol + 4, row: center.row };
  }
  const water = generateHarborWaterMask(island, side, rng, depth);
  pushWaterMask(env.water, water, `${role.role}-water`, 0);
  env.platforms.push({ id: "pier", rect: pier, level: 0, material: "wood" });
  return { id: role.role, type: "harbor", label: role.label, rect: water.bbox, level: 0, focal };
}

function seatStreet(ctx: Ctx, role: ZoneRole): ZoneSpec | null {
  const { env, island } = ctx;
  const m = island.bbox;
  let anchorRow = -Infinity;
  const southRows = new Map<number, number>();
  for (let col = m.c0; col < m.c0 + m.w; col += 1) {
    const row = southCoastRow(island, col);
    if (row != null) {
      southRows.set(col, row);
      if (row > anchorRow) anchorRow = row;
    }
  }
  let runStart = m.c0, runLen = 0, bestStart = m.c0, bestLen = 0;
  for (let col = m.c0; col < m.c0 + m.w; col += 1) {
    const row = southRows.get(col);
    if (row != null && row >= anchorRow - 1) {
      if (runLen === 0) runStart = col;
      runLen += 1;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else runLen = 0;
  }
  if (bestLen < 4 || !Number.isFinite(anchorRow)) return null;
  // Three lots deep: two lanes of cars need a lot between them.
  const rect = { c0: bestStart, r0: anchorRow + 1, w: bestLen, d: 3 };
  env.platforms.push({ id: `${role.role}-road`, rect, level: 0, material: "road" });
  const c = rectCenter(rect);
  return { id: role.role, type: "street", label: role.label, rect, level: 0, focal: { col: Math.round(c.col), row: Math.round(c.row) } };
}

function seatSkyline(ctx: Ctx, role: ZoneRole, material: PlatformMaterial): ZoneSpec {
  const { env, island, rng } = ctx;
  const m = island.bbox;
  const want = ZONE_DIMS[role.size].skyline.w;
  const inset = Math.max(1, Math.floor((m.w - want) / 2));
  const rect = { c0: m.c0 + inset, r0: m.r0 - 2 - Math.floor(rng() * 2), w: Math.max(4, Math.min(want, m.w - 2)), d: 2 };
  env.platforms.push({ id: `${role.role}-rise`, rect, level: 1, material });
  const c = rectCenter(rect);
  return { id: role.role, type: "skyline", label: role.label, rect, level: 1, focal: { col: Math.round(c.col), row: Math.round(c.row) } };
}

function seatZones(ctx: Ctx, archetype: Archetype, theme: ThemeSpec, material: PlatformMaterial, extras: ReturnType<typeof planZones> | null, vesselCount: number) {
  const { env, island, rng } = ctx;
  const core = largestRectInMask(island);
  const taken: LotRect[] = [];
  const seated: Seated[] = [];
  const roles: ZoneRole[] = archetype.zones.filter((z) => z.type !== "plaza");
  const plazaRole = archetype.zones.find((z) => z.type === "plaza") ?? {
    role: "plaza", type: "plaza" as const, label: "the square", location: "center" as const, size: "large" as const, purpose: "the open ground at the center",
  };
  const extraRoles: ZoneRole[] = [];
  if (extras) {
    const has = (t: ZoneType) => roles.some((r) => r.type === t);
    if (extras.harbor && !has("harbor")) extraRoles.push({ role: "harbor", type: "harbor", label: "the harbor", location: (["east", "south", "west"] as const)[Math.floor(rng() * 3)], size: "medium", purpose: "boats off the shore" });
    if (extras.street && !has("street")) extraRoles.push({ role: "street", type: "street", label: "the street", location: "south", size: "medium", purpose: "the road along the shore" });
    if (extras.skyline && !has("skyline")) extraRoles.push({ role: "skyline", type: "skyline", label: "the rise behind town", location: "north", size: "medium", purpose: "the buildings behind" });
  }
  for (const role of [...roles, ...extraRoles]) {
    let zone: ZoneSpec | null = null;
    if (role.type === "harbor") {
      const side: HarborSide = role.location === "south" ? "s" : role.location === "west" ? "w" : "e";
      zone = seatHarbor(ctx, role, side, vesselCount);
    } else if (role.type === "street") {
      zone = seatStreet(ctx, role);
    } else if (role.type === "skyline") {
      zone = seatSkyline(ctx, role, material);
    } else {
      const { w, d } = dimsFor(role, core);
      const rect = findZoneRect(island, taken, w, d, biasFor(role.location, island.bbox));
      if (!rect) continue;
      taken.push(rect);
      if (INTERIOR_TYPES.has(role.type)) {
        zone = seatInterior(ctx, role, rect, theme);
      } else {
        if (role.type === "garden") {
          const bed = bedMaterialFor(theme);
          if (bed !== material) env.platforms.push({ id: `${role.role}-bed`, rect, level: 0, material: bed, inset: true });
        }
        const c = rectCenter(rect);
        zone = { id: role.role, type: role.type, label: role.label, rect, level: 0, focal: { col: Math.round(c.col), row: Math.round(c.row) } };
      }
    }
    if (zone) seated.push({ zone, role });
  }
  // The plaza is the core clearing; its focal sits off-center and outside
  // every other zone's rect so the landmark never lands inside a room.
  const inOther = (col: number, row: number) => seated.some((s) => s.zone.type !== "harbor" && rectContains(s.zone.rect, col, row));
  const target = {
    col: core.c0 + core.w * (0.3 + rng() * 0.4),
    row: core.r0 + core.d * (0.3 + rng() * 0.4),
  };
  let focal = { col: Math.round(target.col), row: Math.round(target.row) };
  let best = Infinity;
  for (let r = core.r0 + 1; r < core.r0 + core.d - 1; r += 1) {
    for (let c = core.c0 + 1; c < core.c0 + core.w - 1; c += 1) {
      if (inOther(c, r)) continue;
      const d = Math.hypot(c - target.col, r - target.row);
      if (d < best) {
        best = d;
        focal = { col: c, row: r };
      }
    }
  }
  const plaza: ZoneSpec = { id: plazaRole.role, type: "plaza", label: plazaRole.label, rect: core, level: 0, focal };
  seated.push({ zone: plaza, role: plazaRole });
  ctx.zones = seated;
  ctx.byRole = new Map(seated.map((s) => [s.role.role, s]));
  env.zones = seated.map((s) => s.zone);
}

// ---------------------------------------------------------------------------
// Circulation
// ---------------------------------------------------------------------------

/** Where a walk to a zone should END: the stair bottom for a raised room,
 * otherwise the cell just outside the focal ring on the approach side. */
function approachOf(ctx: Ctx, seated: Seated): { col: number; row: number } {
  const stair = ctx.env.stairs.find((s) => s.id === `${seated.role.role}-stair`);
  if (stair) {
    const [dc, dr] = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[stair.dir] ?? [0, 1];
    return { col: stair.at.col + dc, row: stair.at.row + dr };
  }
  const f = seated.zone.focal ?? rectCenter(seated.zone.rect);
  return { col: Math.round(f.col), row: Math.round(f.row) };
}

function lPath(ctx: Ctx, a: { col: number; row: number }, b: { col: number; row: number }, avoid: Set<string>): { col: number; row: number }[] {
  const cells: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  const push = (col: number, row: number) => {
    const k = key(col, row);
    if (seen.has(k) || avoid.has(k)) return;
    if (!platformAt(ctx.env, col, row)) return;
    seen.add(k);
    cells.push({ col, row });
  };
  const dc = Math.sign(b.col - a.col);
  for (let c = a.col; c !== b.col; c += dc || 1) {
    push(c, a.row);
    if (!dc) break;
  }
  const dr = Math.sign(b.row - a.row);
  for (let r = a.row; ; r += dr || 1) {
    push(b.col, r);
    if (r === b.row || !dr) break;
  }
  return cells;
}

function threadPaths(ctx: Ctx, archetype: Archetype) {
  const { env, island } = ctx;
  const paths: PathSpec[] = [];
  // Focal cells are pedestals: no walk may end on one.
  const pedestals = new Set<string>();
  for (const s of ctx.zones) if (s.zone.focal) pedestals.add(key(s.zone.focal.col, s.zone.focal.row));
  for (const s of env.stairs) pedestals.add(key(s.at.col, s.at.row));
  for (const spec of archetype.paths) {
    const to = ctx.byRole.get(spec.to);
    if (!to) continue;
    const end = approachOf(ctx, to);
    if (spec.from === "entrance") {
      let coastRow = southCoastRow(island, end.col);
      if (coastRow == null) continue;
      // A zone that already touches the coast has no approach to thread —
      // route the entrance to the plaza instead so the scene still reads
      // "in here, then over there".
      if (coastRow - end.row < 2 && to.zone.level === 0) {
        const plaza = ctx.zones.find((s) => s.zone.type === "plaza");
        if (plaza?.zone.focal) {
          end.col = plaza.zone.focal.col;
          end.row = plaza.zone.focal.row;
          coastRow = southCoastRow(island, end.col) ?? coastRow;
        }
      }
      // The gate stands on the coast cell; the walk starts one cell in and
      // stops one short of the focal.
      ctx.entrance = { col: end.col, row: coastRow };
      const cells: { col: number; row: number }[] = [];
      for (let r = coastRow - 1; r > end.row; r -= 1) if (maskHas(island, end.col, r)) cells.push({ col: end.col, row: r });
      if (to.zone.level > 0) cells.push(end); // walk all the way to the stair foot
      if (cells.length) paths.push({ id: "entrance", cells });
      continue;
    }
    const from = ctx.byRole.get(spec.from);
    if (!from) continue;
    const a = approachOf(ctx, from);
    const cells = lPath(ctx, a, end, pedestals);
    if (cells.length >= 2) paths.push({ id: `walk-${spec.from}-${spec.to}`, cells });
  }
  // Every walkable zone gets a way in: any zone no archetype walk reaches is
  // threaded from the plaza, so circulation is complete before props land.
  const plaza = ctx.zones.find((s) => s.zone.type === "plaza");
  if (plaza) {
    const reached = (s: Seated) => {
      const near = { c0: s.zone.rect.c0 - 1, r0: s.zone.rect.r0 - 1, w: s.zone.rect.w + 2, d: s.zone.rect.d + 2 };
      return paths.some((p) => p.cells.some((c) => rectContains(near, c.col, c.row)));
    };
    for (const s of ctx.zones) {
      if (s === plaza || s.zone.type === "skyline" || s.zone.type === "harbor" || reached(s)) continue;
      const cells = lPath(ctx, approachOf(ctx, plaza), approachOf(ctx, s), pedestals);
      if (cells.length >= 1) paths.push({ id: `walk-${plaza.role.role}-${s.role.role}`, cells });
    }
  }
  env.paths = paths;
  ctx.pathCells = paths.flatMap((p) => p.cells);
  for (const cell of ctx.pathCells) ctx.board.softReserved.add(key(cell.col, cell.row));
  for (const lot of stairApproachLots(env)) {
    const m = /^C(-?\d+)R(-?\d+)$/.exec(lot);
    if (m) ctx.board.taken.add(key(Number(m[1]), Number(m[2])));
  }
  // A1-style approach lots: parse through lotIdOf's inverse.
  for (const s of env.stairs) {
    const [dc, dr] = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[s.dir] ?? [0, 1];
    ctx.board.taken.add(key(s.at.col + dc, s.at.row + dr));
    ctx.board.taken.add(key(s.at.col - dc, s.at.row - dr));
  }
}

// ---------------------------------------------------------------------------
// Relief — hills and mountains rise where nothing functional lives.
// ---------------------------------------------------------------------------

function raiseRelief(ctx: Ctx, prompt: string, hint: Archetype["relief"], theme: ThemeSpec) {
  const avoid = new Set<string>();
  for (const cell of ctx.pathCells) for (const c of [cell, ...ring(cell, 1)]) avoid.add(cellKey(c.col, c.row));
  if (ctx.entrance) for (const c of [ctx.entrance, ...ring(ctx.entrance, 1)]) avoid.add(cellKey(c.col, c.row));
  for (const s of ctx.env.stairs) for (const c of [s.at, ...ring(s.at, 1)]) avoid.add(cellKey(c.col, c.row));
  for (const p of ctx.env.platforms) {
    if (p.id === "pier" || p.material === "road") {
      for (let r = p.rect.r0 - 1; r <= p.rect.r0 + p.rect.d; r += 1) for (let c = p.rect.c0 - 1; c <= p.rect.c0 + p.rect.w; c += 1) avoid.add(cellKey(c, r));
    }
  }
  const relief = planRelief(ctx.island, ctx.env, theme, createSeededRandom(deriveSeed(ctx.seed, "relief")), reliefIntensity(prompt, hint, createSeededRandom(deriveSeed(ctx.seed, "relief:roll"))), avoid);
  ctx.env.platforms.push(...relief.platforms);
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

type Cell = { col: number; row: number };

function zoneCells(rect: LotRect): Cell[] {
  const out: Cell[] = [];
  for (let r = rect.r0; r < rect.r0 + rect.d; r += 1) for (let c = rect.c0; c < rect.c0 + rect.w; c += 1) out.push({ col: c, row: r });
  return out;
}

function ring(center: Cell, dist: number): Cell[] {
  const out: Cell[] = [];
  for (let dc = -dist; dc <= dist; dc += 1) {
    for (let dr = -dist; dr <= dist; dr += 1) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== dist) continue;
      out.push({ col: center.col + dc, row: center.row + dr });
    }
  }
  return out;
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function rotateStart<T>(items: T[], rng: () => number): T[] {
  if (!items.length) return items;
  const k = Math.floor(rng() * items.length);
  return [...items.slice(k), ...items.slice(0, k)];
}

const diagonalsFirst = (cells: Cell[], center: Cell) =>
  [...cells].sort((a, b) => {
    const da = Math.abs(a.col - center.col) + Math.abs(a.row - center.row);
    const db = Math.abs(b.col - center.col) + Math.abs(b.row - center.row);
    return db - da; // Manhattan 2 (diagonal) before 1 (orthogonal) on the same ring
  });

/** Candidate cells for one element, best first. */
function candidates(ctx: Ctx, el: ElementSpec, seated: Seated, anchorCells: Cell[], rng: () => number): { cells: Cell[]; facing?: (cell: Cell, i: number) => number | undefined } {
  const { zone } = seated;
  const rect = zone.rect;
  const focal = zone.focal ?? { col: Math.round(rectCenter(rect).col), row: Math.round(rectCenter(rect).row) };
  const focalPiece = anchorCells[0] ?? focal;
  const vertical = rect.d >= rect.w;
  switch (el.arrange) {
    case "focal":
      return { cells: [focal, ...ring(focal, 1)] };
    case "on_focal": {
      const near = [...ring(focalPiece, 1)].sort((a, b) => manhattan(a, focalPiece) - manhattan(b, focalPiece));
      return { cells: [...rotateStart(near, rng), ...rotateStart(ring(focalPiece, 2), rng)] };
    }
    case "ring_focal": {
      const start = el.distance ?? 1;
      const cells: Cell[] = [];
      for (let d = start; d <= Math.max(2, start); d += 1) {
        cells.push(...rotateStart(d === 1 ? diagonalsFirst(ring(focalPiece, 1), focalPiece) : ring(focalPiece, d), rng));
      }
      return { cells, facing: (c) => faceToward(c.col, c.row, focalPiece) };
    }
    case "cluster": {
      // Everywhere in the zone, nearest the anchor first but never on top of
      // it — small zones fill up, large zones keep the clump close.
      const cells = shuffled(zoneCells(rect), rng)
        .filter((c) => c.col !== focalPiece.col || c.row !== focalPiece.row)
        .sort((a, b) => Math.hypot(a.col - focalPiece.col, a.row - focalPiece.row) - Math.hypot(b.col - focalPiece.col, b.row - focalPiece.row));
      return { cells, facing: el.face === "focal" ? (c) => faceToward(c.col, c.row, focalPiece) : undefined };
    }
    case "beside": {
      const cells: Cell[] = [];
      const anchors = anchorCells.length ? anchorCells : [focal];
      for (let d = 1; d <= 2; d += 1) for (const a of anchors) cells.push(...(d === 1 ? [...ring(a, 1)].sort((x, y) => Math.abs(x.col - a.col) + Math.abs(x.row - a.row) - (Math.abs(y.col - a.col) + Math.abs(y.row - a.row))) : ring(a, 2)));
      return { cells, facing: el.face === "anchor" ? (c) => faceToward(c.col, c.row, nearest(anchors, c)) : undefined };
    }
    case "behind": {
      const cells: Cell[] = [];
      for (const a of anchorCells) {
        const rot = ctx.placements.find((p) => p.col === a.col && p.row === a.row)?.rot;
        const f = facingVector(rot);
        cells.push({ col: a.col - f.dc, row: a.row - f.dr });
        cells.push({ col: a.col - f.dc + f.dr, row: a.row - f.dr + f.dc }, { col: a.col - f.dc - f.dr, row: a.row - f.dr - f.dc });
      }
      return { cells, facing: (c) => faceToward(c.col, c.row, nearest(anchorCells, c)) };
    }
    case "rows_facing": {
      const cells: (Cell & { rot: number })[] = [];
      const n = vertical ? rect.d : rect.w;
      for (let i = 0; i < n; i += 1) {
        if (vertical) {
          cells.push({ col: rect.c0, row: rect.r0 + i, rot: 270 }, { col: rect.c0 + rect.w - 1, row: rect.r0 + i, rot: 90 });
        } else {
          cells.push({ col: rect.c0 + i, row: rect.r0, rot: 0 }, { col: rect.c0 + i, row: rect.r0 + rect.d - 1, rot: 180 });
        }
      }
      const rots = new Map(cells.map((c) => [key(c.col, c.row), c.rot]));
      return { cells, facing: (c) => rots.get(key(c.col, c.row)) };
    }
    case "along_wall": {
      // Heavy pieces back the walls this building actually has, facing
      // into the room; a wall-less room falls back to its north/west edges.
      const sides = walledSides(ctx.env, rect);
      const use: WallSide[] = sides.length ? sides : ["n", "w"];
      const cells: (Cell & { rot: number })[] = [];
      const seen = new Set<string>();
      const push = (col: number, row: number, rot: number) => {
        const k = key(col, row);
        if (seen.has(k)) return;
        seen.add(k);
        cells.push({ col, row, rot });
      };
      for (const side of use) {
        if (side === "n") for (let i = 1; i < rect.w - 1; i += 1) push(rect.c0 + i, rect.r0, 0);
        if (side === "s") for (let i = 1; i < rect.w - 1; i += 1) push(rect.c0 + i, rect.r0 + rect.d - 1, 180);
        if (side === "w") for (let i = 1; i < rect.d - 1; i += 1) push(rect.c0, rect.r0 + i, 270);
        if (side === "e") for (let i = 1; i < rect.d - 1; i += 1) push(rect.c0 + rect.w - 1, rect.r0 + i, 90);
      }
      const rots = new Map(cells.map((c) => [key(c.col, c.row), c.rot]));
      return { cells, facing: (c) => rots.get(key(c.col, c.row)) };
    }
    case "interior": {
      const sides = walledSides(ctx.env, rect);
      const use: WallSide[] = sides.length ? sides : ["n", "w"];
      const onWall = (c: Cell) =>
        (use.includes("n") && c.row === rect.r0) || (use.includes("s") && c.row === rect.r0 + rect.d - 1) || (use.includes("w") && c.col === rect.c0) || (use.includes("e") && c.col === rect.c0 + rect.w - 1);
      const inner = zoneCells(rect).filter((c) => !onWall(c));
      const center = rectCenter(rect);
      const byCenter = (a: Cell, b: Cell) => Math.hypot(a.col - center.col, a.row - center.row) - Math.hypot(b.col - center.col, b.row - center.row);
      inner.sort(byCenter);
      // A full room falls back to the wall line (a sofa against the wall is a sofa).
      const edge = zoneCells(rect).filter((c) => onWall(c)).sort(byCenter);
      return { cells: [...inner, ...edge], facing: el.face === "south" ? () => 0 : undefined };
    }
    case "corners":
      return { cells: rotateStart([{ col: rect.c0, row: rect.r0 }, { col: rect.c0 + rect.w - 1, row: rect.r0 }, { col: rect.c0, row: rect.r0 + rect.d - 1 }, { col: rect.c0 + rect.w - 1, row: rect.r0 + rect.d - 1 }], rng) };
    case "lane": {
      const horizontal = rect.w >= rect.d;
      const lanes = horizontal ? Math.min(2, rect.d) : Math.min(2, rect.w);
      const len = horizontal ? rect.w : rect.d;
      const cells: (Cell & { rot: number })[] = [];
      for (let i = 1; i < len - 1; i += 2) {
        for (let lane = 0; lane < lanes; lane += 1) {
          // Lanes take the two outer rows (cols), leaving a lot between.
          const off = lane === 0 ? 0 : (horizontal ? rect.d : rect.w) - 1;
          cells.push(
            horizontal
              ? { col: rect.c0 + i, row: rect.r0 + off, rot: lane === 0 ? 270 : 90 }
              : { col: rect.c0 + off, row: rect.r0 + i, rot: lane === 0 ? 0 : 180 },
          );
        }
      }
      const rots = new Map(cells.map((c) => [key(c.col, c.row), c.rot]));
      return { cells, facing: (c) => rots.get(key(c.col, c.row)) };
    }
    case "row": {
      const horizontal = rect.w >= rect.d;
      const len = horizontal ? rect.w : rect.d;
      const mid = horizontal ? rect.r0 + Math.floor(rect.d / 2) : rect.c0 + Math.floor(rect.w / 2);
      const off = Math.floor(rng() * 2);
      const cells: Cell[] = [];
      for (let i = off; i < len; i += 2) cells.push(horizontal ? { col: rect.c0 + i, row: mid } : { col: mid, row: rect.r0 + i });
      return { cells, facing: () => 0 };
    }
    case "grid": {
      const ox = Math.floor(rng() * 2), oy = Math.floor(rng() * 2);
      const cells: Cell[] = [];
      for (let r = rect.r0 + oy; r < rect.r0 + rect.d; r += 2) for (let c = rect.c0 + ox; c < rect.c0 + rect.w; c += 2) cells.push({ col: c, row: r });
      return { cells, facing: el.face === "south" ? () => 0 : el.face === "vary" ? () => [0, 90, 180, 270][Math.floor(rng() * 4)] : undefined };
    }
    case "scatter":
      return { cells: shuffled(zoneCells(rect), rng), facing: el.face === "vary" ? () => [0, 90, 180, 270][Math.floor(rng() * 4)] : el.face === "focal" ? (c) => faceToward(c.col, c.row, focalPiece) : undefined };
    case "perimeter": {
      const edge: (Cell & { rot: number })[] = [];
      for (let c = rect.c0; c < rect.c0 + rect.w; c += 1) edge.push({ col: c, row: rect.r0, rot: 0 }, { col: c, row: rect.r0 + rect.d - 1, rot: 0 });
      for (let r = rect.r0 + 1; r < rect.r0 + rect.d - 1; r += 1) edge.push({ col: rect.c0, row: r, rot: 90 }, { col: rect.c0 + rect.w - 1, row: r, rot: 90 });
      const near = new Set(ctx.pathCells.flatMap((p) => ring(p, 1).concat([p]).map((c) => key(c.col, c.row))));
      const cells = rotateStart(edge.filter((c) => !near.has(key(c.col, c.row))), rng);
      const rots = new Map(cells.map((c) => [key(c.col, c.row), c.rot]));
      return { cells, facing: (c) => rots.get(key(c.col, c.row)) };
    }
    case "path_side": {
      const cells: Cell[] = [];
      const walk = ctx.env.paths.find((p) => p.id === "entrance")?.cells ?? ctx.pathCells;
      walk.forEach((p, i) => {
        if (i % 2) return;
        const side = i % 4 === 0 ? 1 : -1;
        cells.push({ col: p.col + side, row: p.row }, { col: p.col - side, row: p.row });
      });
      return { cells, facing: () => 0 };
    }
    case "entrance": {
      const e = ctx.entrance;
      if (!e) return { cells: [] };
      return { cells: [e, { col: e.col + 1, row: e.row }, { col: e.col - 1, row: e.row }], facing: () => 0 };
    }
    case "pier": {
      const pier = ctx.env.platforms.find((p) => p.id === "pier");
      return { cells: pier ? zoneCells(pier.rect) : [] };
    }
  }
}

function manhattan(a: Cell, b: Cell) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

function nearest(cells: Cell[], from: Cell): Cell {
  let best = cells[0] ?? from;
  let d = Infinity;
  for (const c of cells) {
    const dd = Math.hypot(c.col - from.col, c.row - from.row);
    if (dd < d) {
      d = dd;
      best = c;
    }
  }
  return best;
}

/** The fence every placement must satisfy: inside its zone, on its level. */
function fenceFor(ctx: Ctx, seated: Seated, el: Pick<ElementSpec, "arrange" | "surface">): (col: number, row: number) => boolean {
  const { zone } = seated;
  const others = ctx.zones.filter((s) => s !== seated && s.zone.type !== "harbor" && s.zone.type !== "plaza").map((s) => s.zone.rect);
  return (col, row) => {
    if (el.arrange === "entrance" || el.arrange === "path_side" || el.arrange === "pier") {
      const p = platformAt(ctx.env, col, row);
      return Boolean(p) && (el.arrange !== "pier" || p?.id === "pier");
    }
    if (zone.type === "harbor") {
      if (el.surface === "water") return ctx.env.water.some((w) => rectContains(w.rect, col, row)) && !platformAt(ctx.env, col, row);
      return platformAt(ctx.env, col, row)?.id === "pier";
    }
    const p = platformAt(ctx.env, col, row);
    if (!p || p.level !== zone.level) return false;
    if (el.arrange === "behind") {
      const grown = { c0: zone.rect.c0 - 1, r0: zone.rect.r0 - 1, w: zone.rect.w + 2, d: zone.rect.d + 2 };
      return rectContains(grown, col, row) && !others.some((r) => rectContains(r, col, row));
    }
    if (!rectContains(zone.rect, col, row)) return false;
    if (zone.type === "plaza" && others.some((r) => rectContains(r, col, row))) return false;
    return true;
  };
}

/** Plan with EXACTLY the radius the live engine will check (clearanceLots
 * + bodiesCollide) — a placement the plan accepts is one the engine places. */
function place(ctx: Ctx, item: CatalogItem, cell: Cell, opts: { tight?: boolean; allowSoft?: boolean; valid: (c: number, r: number) => boolean; ring: number }): Cell | null {
  return ctx.board.claimNear(cell.col, cell.row, opts.ring, opts.allowSoft ?? false, opts.valid, clearanceLots(item), item.kind);
}

function arrangeElement(ctx: Ctx, el: ElementSpec, phase: PlanPhase, ledger: LedgerEntry[], missing: string[]) {
  const seated = ctx.byRole.get(el.zone);
  const entry: LedgerEntry = { role: el.role, label: el.label, zone: el.zone, required: Boolean(el.required), supporting: Boolean(el.supporting), wanted: 0, placed: 0, lots: [] };
  ledger.push(entry);
  if (!seated) {
    if (el.required) missing.push(el.label);
    return;
  }
  const rng = createSeededRandom(deriveSeed(ctx.seed, `el:${el.zone}:${el.role}`));
  const n = el.count[0] + Math.floor(rng() * (el.count[1] - el.count[0] + 1));
  entry.wanted = n;
  const pool = pickItems(el.pick, deriveSeed(ctx.seed, `pick:${el.role}`), el.variety ?? Math.max(1, n));
  if (!pool.length) {
    if (el.required) missing.push(el.label);
    return;
  }
  const items = cycleItems(pool, n, Math.floor(rng() * 1000));
  const anchorCells = (el.anchor ? ctx.placedByRole.get(el.anchor) : ctx.placedByRole.get(`${el.zone}:focal`))?.map((p) => ({ col: p.col, row: p.row })) ?? [];
  const { cells, facing } = candidates(ctx, el, seated, anchorCells, rng);
  const valid = fenceFor(ctx, seated, el);
  // Only things that belong on or beside a walk may take a path cell; a
  // tight scatter (mushrooms, pumpkins) still keeps the walkways clear.
  const softOk = el.arrange === "on_focal" || el.arrange === "entrance" || el.arrange === "path_side" || el.arrange === "pier";
  const used = new Set<string>();
  let i = 0;
  for (const item of items) {
    let landed: Cell | null = null;
    let intended: Cell | null = null;
    for (const cell of cells) {
      const k = key(cell.col, cell.row);
      if (used.has(k)) continue;
      const spot = place(ctx, item, cell, { tight: el.tight, allowSoft: softOk, valid, ring: 0 });
      if (spot) {
        used.add(k);
        landed = spot;
        intended = spot;
        break;
      }
    }
    if (!landed && cells.length && el.arrange !== "entrance") {
      // One nudge from the best candidate, still fenced to the zone —
      // recorded as drift, never walked blocks away.
      const first = cells.find((c) => !used.has(key(c.col, c.row))) ?? cells[0];
      landed = place(ctx, item, first, { tight: el.tight, allowSoft: softOk, valid, ring: 1 });
      intended = first;
    }
    if (!landed) continue;
    const rot = facing?.(landed, i);
    const p: Placement = {
      item,
      col: landed.col,
      row: landed.row,
      ...(rot ? { rot } : {}),
      reason: el.reason,
      zone: seated.zone.id,
      role: el.role,
      phase,
      ...(intended && (intended.col !== landed.col || intended.row !== landed.row) ? { intended } : {}),
    };
    ctx.placements.push(p);
    const list = ctx.placedByRole.get(el.role) ?? [];
    list.push(p);
    ctx.placedByRole.set(el.role, list);
    if (el.arrange === "focal") ctx.placedByRole.set(`${el.zone}:focal`, [p]);
    entry.placed += 1;
    entry.lots.push(lotIdOf(landed.col, landed.row));
    i += 1;
  }
  if (el.required && entry.placed === 0) missing.push(el.label);
}

/**
 * Structure before texture: things that define a zone's edges and rows
 * (walls, fences, stall rows, lanes, gates) go down first, then what hangs
 * off the anchor, then the loose scatter that fills whatever is left. Ties
 * keep archetype order, so "flowers before trees" holds within a tier.
 */
const ARRANGE_TIER: Record<ElementSpec["arrange"], number> = {
  focal: 0,
  perimeter: 1, entrance: 1, rows_facing: 1, along_wall: 1, lane: 1, row: 1, grid: 1, pier: 1,
  ring_focal: 2, on_focal: 2, beside: 2, behind: 2,
  interior: 3, corners: 3, path_side: 3,
  cluster: 4, scatter: 4,
};

function orderedElements(elements: ElementSpec[]): ElementSpec[] {
  const ordered = elements.map((el, i) => ({ el, i })).sort((a, b) => ARRANGE_TIER[a.el.arrange] - ARRANGE_TIER[b.el.arrange] || a.i - b.i).map((x) => x.el);
  // A piece that hangs off another (the TV beside the sofa) must come after
  // its anchor, whatever tier the tiers would put it in.
  for (let pass = 0; pass < ordered.length; pass += 1) {
    let moved = false;
    for (let i = 0; i < ordered.length; i += 1) {
      const el = ordered[i];
      if (!el.anchor) continue;
      const j = ordered.findIndex((o) => o.role === el.anchor);
      if (j > i) {
        ordered.splice(i, 1);
        ordered.splice(j, 0, el);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return ordered;
}

function placePeople(ctx: Ctx, archetype: Archetype, ledger: LedgerEntry[]) {
  const rng = createSeededRandom(deriveSeed(ctx.seed, "people"));
  const spec = archetype.people;
  const n = spec.count[0] + Math.floor(rng() * (spec.count[1] - spec.count[0] + 1));
  const pool = pickItems(spec.pick, deriveSeed(ctx.seed, "pick:people"), Math.max(2, n));
  const entry: LedgerEntry = { role: "people", label: "people", zone: spec.near[0] ?? "plaza", required: true, supporting: false, wanted: n, placed: 0, lots: [] };
  ledger.push(entry);
  const zones = spec.near.map((r) => ctx.byRole.get(r)).filter((s): s is Seated => Boolean(s));
  if (!zones.length || !pool.length) return;
  const fallback = ctx.zones.filter((s) => !zones.includes(s) && s.zone.type !== "harbor" && s.zone.type !== "skyline" && s.zone.type !== "street");
  const items = cycleItems(pool, n, Math.floor(rng() * 1000));
  items.forEach((item, i) => {
    const preferred = zones[i % zones.length];
    // A full campsite still gets its people — they wander into the next zone.
    const order = [preferred, ...zones.filter((z) => z !== preferred), ...fallback];
    for (const seated of order) {
      if (tryPerson(ctx, item, seated, i, entry, rng)) break;
    }
  });
}

function tryPerson(ctx: Ctx, item: CatalogItem, seated: Seated, i: number, entry: LedgerEntry, rng: () => number): boolean {
  {
    const anchor = ctx.placedByRole.get(`${seated.role.role}:focal`)?.[0];
    const target: Cell = anchor ? { col: anchor.col, row: anchor.row } : seated.zone.focal ?? { col: Math.round(rectCenter(seated.zone.rect).col), row: Math.round(rectCenter(seated.zone.rect).row) };
    const cells = [...rotateStart(diagonalsFirst(ring(target, 1), target), rng), ...rotateStart(ring(target, 2), rng), ...rotateStart(ring(target, 3), rng)];
    const valid = fenceFor(ctx, seated, { arrange: "cluster" });
    for (const cell of cells) {
      const spot = place(ctx, item, cell, { allowSoft: true, valid, ring: 0 });
      if (!spot) continue;
      ctx.placements.push({
        item,
        col: spot.col,
        row: spot.row,
        rot: faceToward(spot.col, spot.row, target),
        flip: i % 2 === 1,
        reason: i % 3 === 0 ? `taking in ${seated.zone.label}` : `together in ${seated.zone.label}`,
        zone: seated.zone.id,
        role: "people",
        phase: "people",
      });
      entry.placed += 1;
      entry.lots.push(lotIdOf(spot.col, spot.row));
      return true;
    }
    return false;
  }
}

function frameScene(ctx: Ctx, archetype: Archetype, theme: ThemeSpec) {
  if (archetype.boundary === "none") return;
  const spec: ThemeSpec =
    archetype.boundary === "trees" && theme.boundary === "none"
      ? { ...theme, boundary: "trees", boundaryQuery: "tree oak birch pine nature", boundaryDensity: [0.35, 0.55] }
      : archetype.boundary === "stones" && theme.boundary === "none"
        ? { ...theme, boundary: "stones", boundaryQuery: "rock stone column nature", boundaryDensity: [0.3, 0.5] }
        : theme;
  const skip = new Set<string>();
  for (const cell of ctx.pathCells) for (const c of [cell, ...ring(cell, 1)]) skip.add(cellKey(c.col, c.row));
  if (ctx.entrance) for (const c of [ctx.entrance, ...ring(ctx.entrance, 1)]) skip.add(cellKey(c.col, c.row));
  for (const p of ctx.env.platforms) {
    if (p.id === "pier" || p.material === "road") {
      for (let r = p.rect.r0 - 1; r <= p.rect.r0 + p.rect.d; r += 1) for (let c = p.rect.c0 - 1; c <= p.rect.c0 + p.rect.w; c += 1) skip.add(cellKey(c, r));
    }
  }
  for (const w of ctx.env.water) for (let r = w.rect.r0 - 1; r <= w.rect.r0 + w.rect.d; r += 1) for (let c = w.rect.c0 - 1; c <= w.rect.c0 + w.rect.w; c += 1) skip.add(cellKey(c, r));
  for (const s of ctx.env.stairs) for (const c of [s.at, ...ring(s.at, 1)]) skip.add(cellKey(c.col, c.row));
  for (const s of ctx.zones) {
    // Functional zones stay grove-free; the plaza keeps a clear story ring.
    if (s.zone.type === "plaza") {
      if (s.zone.focal) for (const c of [s.zone.focal, ...ring(s.zone.focal, 1), ...ring(s.zone.focal, 2)]) skip.add(cellKey(c.col, c.row));
      continue;
    }
    if (s.zone.type === "garden") continue;
    for (const c of zoneCells(s.zone.rect)) skip.add(cellKey(c.col, c.row));
  }
  for (const p of planBoundary(ctx.island, spec, ctx.seed, skip)) {
    // The engine's exact clearance against everything standing; when the
    // anchor cell is taken, the neighbouring coast cell keeps the grove
    // dense — still outside the functional zones and off the walks.
    const spot = ctx.board.claimNear(p.col, p.row, 1, true, (c, r) => Boolean(platformAt(ctx.env, c, r)) && !skip.has(cellKey(c, r)), clearanceLots(p.item), p.item.kind);
    if (!spot) continue;
    ctx.placements.push({ item: p.item, col: spot.col, row: spot.row, ...(p.rot ? { rot: p.rot } : {}), flip: p.flip, reason: p.reason, zone: "edge", role: "boundary", phase: "environment" });
  }
}

/** Fill the world toward the archetype's density with zone-appropriate texture. */
function fillTexture(ctx: Ctx, archetype: Archetype, theme: ThemeSpec) {
  const focals = ctx.zones.flatMap((s) => (s.zone.focal ? [s.zone.focal] : []));
  const added = fillToDensity({
    env: ctx.env,
    board: ctx.board,
    theme,
    seed: ctx.seed,
    placed: ctx.placements.length,
    target: archetype.density,
    keepClear: keepClearFor(ctx.env, focals, ctx.entrance),
  });
  ctx.placements.push(...added);
  // The water gets the same treatment: buoys, rocks, boats at anchor.
  ctx.placements.push(...fillWater({ env: ctx.env, board: ctx.board, seed: ctx.seed, keepClear: keepClearFor(ctx.env, focals, ctx.entrance) }));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const HARBOR_WORDS = /\b(boat|boats|harbou?r|dock|docks|ship|ships|marina|lake|lakeside|sea|seaside|pier|shore|sail|sailing|river)\b/i;
const STREET_WORDS = /\b(car|cars|traffic|road|street|streets|parking|parked|highway|avenue)\b/i;
const SKYLINE_WORDS = /\b(city|skyline|buildings|downtown|towers|houses|neighborhood|neighbourhood|village|town)\b/i;

function extrasFromPrompt(prompt: string, implied: ReturnType<typeof planZones>): ReturnType<typeof planZones> {
  return {
    ...implied,
    harbor: implied.harbor && HARBOR_WORDS.test(prompt),
    street: implied.street && STREET_WORDS.test(prompt),
    skyline: implied.skyline && SKYLINE_WORDS.test(prompt),
  };
}

/**
 * Compose a scene from an archetype. `occupied` are bodies already on the
 * board (human pieces) the program must build around.
 */
export function composeProgram(intent: SceneIntent, archetype: Archetype, occupied: Iterable<OccupiedBody>, seed: string): ProgramPlan {
  const theme = intent.theme;
  const rng = createSeededRandom(deriveSeed(seed, "layout"));
  const selection = archetype.extras ? selectItems(intent.prompt, deriveSeed(seed, "selection")) : [];
  // Extra places the PROMPT asks for by name ("lakeside picnic with boats"),
  // never places a stray catalog word implies ("small" is not a boat).
  const extras = archetype.extras ? extrasFromPrompt(intent.prompt, planZones(groupByRole(selection))) : null;
  const zoneCount = archetype.zones.length + (extras ? Number(extras.harbor) + Number(extras.street) : 0);
  const tall = rng() > 0.45;
  const spanW = Math.min(17, (tall ? 11 : 13) + Math.max(0, zoneCount - 2) + Math.floor(rng() * 3));
  const spanD = Math.min(15, (tall ? 13 : 9) + Math.floor(Math.max(0, zoneCount - 2) / 2) + Math.floor(rng() * 3));
  const center = { col: ORIGIN.col + Math.floor(rng() * 5) - 2, row: ORIGIN.row + Math.floor(rng() * 3) - 1 };
  const island = generateIslandMask(rng, center, spanW / 2, spanD / 2);
  const material = theme.primary;
  const env: EnvironmentSpec = {
    platforms: maskToRects(island).map((rect, i) => ({ id: `main-${i}`, rect, level: 0, material })),
    walls: [],
    stairs: [],
    paths: [],
    water: [],
    zones: [],
    themeId: theme.id,
    pathMaterial: theme.pathMaterial,
    ground: paintTerrain(island, theme, seed),
  };
  const ctx: Ctx = {
    env,
    island,
    board: new Board(occupied),
    zones: [],
    byRole: new Map(),
    placements: [],
    placedByRole: new Map(),
    entrance: null,
    pathCells: [],
    rng,
    seed,
  };
  const vessels = selection.filter((i) => i.kind === "boat").length;
  seatZones(ctx, archetype, theme, material, extras, vessels);
  threadPaths(ctx, archetype);
  raiseRelief(ctx, intent.prompt, archetype.relief, theme);

  const ledger: LedgerEntry[] = [];
  const missing: string[] = [];
  const elements = archetype.elements;
  // Focal anchors first (every zone), then everything else zone by zone in
  // archetype order, so `beside`/`behind`/`on_focal` find their anchors.
  for (const el of elements.filter((e) => e.arrange === "focal")) arrangeElement(ctx, el, "focal", ledger, missing);
  for (const el of orderedElements(elements.filter((e) => e.arrange !== "focal"))) arrangeElement(ctx, el, "populate", ledger, missing);
  // Extra zones the prompt implied get a generic fill from the selection.
  if (extras) {
    const byRole = groupByRole(selection);
    const extraEls: ElementSpec[] = [];
    if (ctx.byRole.has("harbor") && !archetype.zones.some((z) => z.type === "harbor") && byRole.vessel.length) {
      extraEls.push({ role: "boats", label: "boats", zone: "harbor", arrange: "scatter", count: [Math.min(2, byRole.vessel.length), Math.min(4, byRole.vessel.length)], surface: "water", reason: "riding at anchor", pick: { ids: byRole.vessel.map((i) => i.id) } });
    }
    if (ctx.byRole.has("street") && !archetype.zones.some((z) => z.type === "street") && byRole.vehicle.length) {
      extraEls.push({ role: "vehicles", label: "vehicles", zone: "street", arrange: "lane", count: [Math.min(2, byRole.vehicle.length), Math.min(6, byRole.vehicle.length)], face: "lane", reason: "rolling down the street", pick: { ids: byRole.vehicle.map((i) => i.id) } });
    }
    if (ctx.byRole.has("skyline") && !archetype.zones.some((z) => z.type === "skyline") && byRole.backdrop.length) {
      extraEls.push({ role: "backdrop", label: "skyline", zone: "skyline", arrange: "row", count: [Math.min(2, byRole.backdrop.length), Math.min(4, byRole.backdrop.length)], reason: "raising the skyline", pick: { ids: byRole.backdrop.map((i) => i.id) } });
    }
    for (const el of extraEls) arrangeElement(ctx, el, "populate", ledger, missing);
  }
  placePeople(ctx, archetype, ledger);
  frameScene(ctx, archetype, theme);
  fillTexture(ctx, archetype, theme);

  return { env: withWaterPaint(env, seed), placements: ctx.placements, ledger, missing };
}

// ---------------------------------------------------------------------------
// Live zone program — the REPAIR path. Re-runs one zone's element rules
// against the board as it stands (whatever the agent and the human have
// placed since), so populate_zones can refill an empty or half-built zone
// without recomposing the world.
// ---------------------------------------------------------------------------

export type ZoneProgramResult = { placements: Placement[]; ledger: LedgerEntry[]; missing: string[] };

/**
 * Compose the archetype elements that belong to `zoneId` (and/or people)
 * on top of `occupied` bodies. `only` limits to element roles (or "people").
 */
export function programZone(
  intent: SceneIntent,
  archetype: Archetype,
  env: EnvironmentSpec,
  zoneId: string,
  occupied: Iterable<OccupiedBody>,
  seed: string,
  only?: string[],
  /** The archetype role to program into the zone, when the zone's own name
   * or type would be ambiguous (two garden roles, one garden zone). */
  roleId?: string,
): ZoneProgramResult {
  const zone = env.zones.find((z) => z.id === zoneId) ?? env.zones.find((z) => z.type === zoneId);
  if (!zone) return { placements: [], ledger: [], missing: [] };
  const role: ZoneRole =
    (roleId ? archetype.zones.find((z) => z.role === roleId) : undefined) ??
    archetype.zones.find((z) => z.role === zone.id) ??
    archetype.zones.find((z) => z.type === zone.type) ?? {
      role: zone.id,
      type: zone.type,
      label: zone.label,
      location: "center",
      size: "medium",
      purpose: zone.label,
    };
  const island = {
    cells: new Set<string>(),
    bbox: env.platforms.reduce(
      (b, p) => ({ c0: Math.min(b.c0, p.rect.c0), r0: Math.min(b.r0, p.rect.r0), w: 0, d: 0 }),
      { c0: Infinity, r0: Infinity, w: 0, d: 0 },
    ),
  };
  const seated: Seated = { zone, role };
  const ctx: Ctx = {
    env,
    island,
    board: new Board(occupied),
    zones: env.zones.map((z) => ({ zone: z, role: archetype.zones.find((r) => r.role === z.id) ?? { role: z.id, type: z.type, label: z.label, location: "center", size: "medium", purpose: z.label } })),
    byRole: new Map(),
    placements: [],
    placedByRole: new Map(),
    entrance: env.paths.find((p) => p.id === "entrance")?.cells[0] ?? null,
    pathCells: env.paths.flatMap((p) => p.cells),
    rng: createSeededRandom(deriveSeed(seed, `zone:${zone.id}`)),
    seed,
  };
  for (const s of ctx.zones) ctx.byRole.set(s.role.role, s);
  ctx.byRole.set(role.role, seated);
  for (const cell of ctx.pathCells) ctx.board.softReserved.add(key(cell.col, cell.row));
  for (const s of env.stairs) {
    ctx.board.taken.add(key(s.at.col, s.at.row));
    const [dc, dr] = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[s.dir] ?? [0, 1];
    ctx.board.taken.add(key(s.at.col + dc, s.at.row + dr));
    ctx.board.taken.add(key(s.at.col - dc, s.at.row - dr));
  }
  // Existing anchors on the board count: a table already standing at the
  // focal is the anchor the seating rings.
  const focalEl = archetype.elements.find((e) => e.arrange === "focal" && e.zone === role.role);
  if (focalEl && zone.focal) {
    const pool = new Set(pickItems(focalEl.pick, deriveSeed(seed, `pick:${focalEl.role}`), 64).map((i) => i.id));
    const standing = [...occupied].find((b) => Math.max(Math.abs(b.col - zone.focal!.col), Math.abs(b.row - zone.focal!.row)) <= 1 && (b as OccupiedBody & { catalogId?: string }).catalogId && pool.has((b as OccupiedBody & { catalogId?: string }).catalogId!));
    if (standing) {
      const p: Placement = { item: pickItems(focalEl.pick, 1, 1)[0], col: standing.col, row: standing.row, reason: focalEl.reason, zone: zone.id, role: focalEl.role, phase: "focal" };
      ctx.placedByRole.set(`${role.role}:focal`, [p]);
      ctx.placedByRole.set(focalEl.role, [p]);
    }
  }
  const ledger: LedgerEntry[] = [];
  const missing: string[] = [];
  const wanted = (r: string) => !only || only.includes(r);
  const elements = archetype.elements.filter((e) => e.zone === role.role && wanted(e.role));
  for (const el of elements.filter((e) => e.arrange === "focal")) {
    if (ctx.placedByRole.has(`${role.role}:focal`)) continue;
    arrangeElement(ctx, el, "focal", ledger, missing);
  }
  for (const el of orderedElements(elements.filter((e) => e.arrange !== "focal"))) arrangeElement(ctx, el, "populate", ledger, missing);
  if (wanted("people") && archetype.people.near.includes(role.role)) {
    placePeople(ctx, { ...archetype, people: { ...archetype.people, near: [role.role] } }, ledger);
  }
  return { placements: ctx.placements, ledger, missing };
}

/**
 * Live density pass — the REPAIR for a scene that validates as sparse: fill
 * the board as it stands toward the archetype's density with texture.
 */
export function programTexture(
  intent: SceneIntent,
  env: EnvironmentSpec,
  occupied: Iterable<OccupiedBody>,
  seed: string,
  max = 60,
): Placement[] {
  const board = new Board(occupied);
  for (const s of env.stairs) board.taken.add(key(s.at.col, s.at.row));
  const focals = env.zones.flatMap((z) => (z.focal ? [z.focal] : []));
  const entrance = env.paths.find((p) => p.id === "entrance")?.cells[0] ?? null;
  const keepClear = keepClearFor(env, focals, entrance);
  const water = fillWater({ env, board, seed: `${seed}-live`, keepClear, max: Math.min(max, 20) });
  const land = fillToDensity({
    env,
    board,
    theme: intent.theme,
    seed: `${seed}-live`,
    placed: [...occupied].length,
    target: intent.archetype?.density,
    keepClear,
    max,
  });
  return [...land, ...water];
}
