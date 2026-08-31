import type { CatalogItem, CatalogKind } from "../catalog";
import { lotIdOf, rectCenter, rectContains, type LotRect } from "./grid3d";
import { roleOf, visualMass, type Role } from "./roles";
import { bodiesOverlap, clearanceLots } from "./scale3d";
import { hashTheme, selectItems } from "./select";
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

export type ComposedPlan = { env: EnvironmentSpec; todos: SceneTodo[] };

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

function planZones(byRole: Record<Role, CatalogItem[]>): {
  interior: ZonePlan | null;
  market: boolean;
  garden: boolean;
  harbor: boolean;
  street: boolean;
  skyline: boolean;
} {
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

function makeRng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Corner = "nw" | "ne" | "sw";
type HarborSide = "e" | "s" | "w";

function interiorSpot(corner: Corner, main: LotRect, w: number, d: number): LotRect {
  const c0 = corner === "ne" ? main.c0 + main.w - w - 1 : main.c0 + 1;
  const r0 = corner === "sw" ? main.r0 + main.d - d - 1 : main.r0 + 1;
  return { c0, r0, w, d };
}

function gardenSpot(corner: Corner, main: LotRect, w: number, d: number): LotRect {
  if (corner === "ne") return { c0: main.c0 + 1, r0: main.r0 + main.d - d - 1, w, d };
  if (corner === "sw") return { c0: main.c0 + main.w - w - 1, r0: main.r0 + 1, w, d };
  return { c0: main.c0 + 1, r0: main.r0 + main.d - d - 1, w, d };
}

function harborLayout(side: HarborSide, main: LotRect, vessels: number) {
  const span = 5 + Math.ceil(vessels / 2) * 3;
  if (side === "s") {
    const d = Math.min(8, span);
    const pierC = main.c0 + Math.floor(main.w / 2);
    return {
      water: { c0: main.c0 - 1, r0: main.r0 + main.d, w: main.w + 2, d } satisfies LotRect,
      pier: { c0: pierC, r0: main.r0 + main.d, w: 1, d: 2 } satisfies LotRect,
      focal: { col: pierC, row: main.r0 + main.d + 3 },
    };
  }
  if (side === "w") {
    const pierR = main.r0 + Math.floor(main.d / 2);
    return {
      water: { c0: main.c0 - span, r0: main.r0 - 1, w: span, d: main.d + 2 } satisfies LotRect,
      pier: { c0: main.c0 - 2, r0: pierR, w: 2, d: 1 } satisfies LotRect,
      focal: { col: main.c0 - 3, row: pierR },
    };
  }
  const pierR = main.r0 + Math.floor(main.d / 2);
  return {
    water: { c0: main.c0 + main.w, r0: main.r0 - 1, w: span, d: main.d + 2 } satisfies LotRect,
    pier: { c0: main.c0 + main.w, r0: pierR, w: 2, d: 1 } satisfies LotRect,
    focal: { col: main.c0 + main.w + 3, row: pierR },
  };
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export function composeScenePlan(theme: string, occupied: Iterable<OccupiedBody> = []): ComposedPlan {
  const seed = hashTheme(theme.trim().toLowerCase() || "scene");
  const items = selectItems(theme, seed);

  const byRole: Record<Role, CatalogItem[]> = {
    ground: [], wall: [], connector: [], structure: [], backdrop: [],
    track: [], tabletop: [], vessel: [], vehicle: [], person: [], scenery: [],
  };
  for (const item of items) byRole[roleOf(item)].push(item);
  const structures = [...byRole.structure].sort((a, b) => visualMass(b) - visualMass(a));

  const zonePlan = planZones(byRole);
  const rng = makeRng(seed);
  const extraZones =
    (zonePlan.interior ? 1 : 0) + (zonePlan.market ? 1 : 0) + (zonePlan.garden ? 1 : 0) +
    (zonePlan.harbor ? 1 : 0) + (zonePlan.street ? 1 : 0);

  // --- Footprint: size, aspect, and wings vary with the seed so two
  // living-room themes don't stamp the same rectangle. -------------------
  const tall = rng() > 0.45;
  const mainW = Math.min(16, (tall ? 10 : 12) + extraZones + Math.floor(rng() * 3));
  const mainD = Math.min(14, (tall ? 12 : 8) + Math.floor(extraZones / 2) + Math.floor(rng() * 3));
  const shiftC = Math.floor(rng() * 5) - 2;
  const shiftR = Math.floor(rng() * 3) - 1;
  const c0 = ORIGIN.col - Math.floor(mainW / 2) + shiftC;
  const r0 = ORIGIN.row - Math.floor(mainD / 2) + shiftR;
  const main: LotRect = { c0, r0, w: mainW, d: mainD };
  const material = mainMaterial(items);
  const shape = Math.floor(rng() * 4); // 0 rect, 1 east wing, 2 south apron, 3 pocket
  const corner: Corner = (["nw", "ne", "sw"] as const)[Math.floor(rng() * 3)];
  const harborSide: HarborSide = (["e", "s", "w"] as const)[Math.floor(rng() * 3)];

  const env: EnvironmentSpec = {
    platforms: [{ id: "main", rect: main, level: 0, material }],
    walls: [],
    stairs: [],
    paths: [],
    water: [],
    zones: [],
  };
  const board = new Board(occupied);
  const placements: Placement[] = [];
  const zones: ZoneSpec[] = [];

  if (shape === 1 && !zonePlan.harbor) {
    env.platforms.push({
      id: "wing",
      rect: { c0: c0 + mainW, r0: r0 + Math.floor(mainD * 0.25), w: 3 + Math.floor(rng() * 3), d: Math.max(4, Math.floor(mainD * 0.55)) },
      level: 0,
      material,
    });
  }
  if (shape === 2 && !zonePlan.street) {
    env.platforms.push({
      id: "apron",
      rect: { c0: c0 + 1, r0: r0 + mainD, w: mainW - 2, d: 2 + Math.floor(rng() * 2) },
      level: 0,
      material,
    });
  }

  // --- Interior: a raised, walled room — corner chosen by seed -------------
  let interiorRect: LotRect | null = null;
  if (zonePlan.interior) {
    const w = Math.min(4 + Math.floor(rng() * 3), mainW - 5);
    const d = Math.min(3 + Math.floor(rng() * 2), mainD - 4);
    interiorRect = interiorSpot(corner, main, Math.max(3, w), Math.max(3, d));
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
    if (corner === "sw") {
      const stairCol = interiorRect.c0 + Math.floor(interiorRect.w / 2);
      const stairRow = interiorRect.r0 - 1;
      env.stairs.push({ id: "terrace-stair", at: { col: stairCol, row: stairRow }, dir: "s", fromLevel: 0, toLevel: 1 });
      board.taken.add(key(stairCol, stairRow));
    } else {
      const stairCol = interiorRect.c0 + Math.floor(interiorRect.w / 2);
      const stairRow = interiorRect.r0 + interiorRect.d;
      env.stairs.push({ id: "terrace-stair", at: { col: stairCol, row: stairRow }, dir: "n", fromLevel: 0, toLevel: 1 });
      board.taken.add(key(stairCol, stairRow));
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

  // --- Market: a strip on the east or west, not always the same aisle ------
  let marketRect: LotRect | null = null;
  if (zonePlan.market) {
    const west = corner === "ne" || (corner !== "nw" && rng() > 0.5);
    marketRect = west
      ? { c0: c0 + 1, r0: r0 + 2, w: 3, d: Math.min(6, mainD - 4) }
      : { c0: c0 + mainW - 4, r0: r0 + 2, w: 3, d: Math.min(6, mainD - 4) };
    zones.push({
      id: "market",
      type: "market",
      label: "the market row",
      rect: marketRect,
      level: 0,
      focal: rectCenter(marketRect),
    });
  }

  // --- Garden: opposite the interior so the two rooms don't stack ----------
  let gardenRect: LotRect | null = null;
  if (zonePlan.garden) {
    const gw = Math.min(3 + Math.floor(rng() * 3), mainW - 6);
    const gd = Math.min(3 + Math.floor(rng() * 2), 5);
    gardenRect = gardenSpot(interiorRect ? corner : "nw", main, Math.max(3, gw), Math.max(3, gd));
    if (material !== "grass") {
      env.platforms.push({ id: "garden-bed", rect: gardenRect, level: 0, material: "grass", inset: true });
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

  if (shape === 3 && !gardenRect) {
    env.platforms.push({
      id: "pocket",
      rect: { c0: c0 + mainW - 5, r0: r0 + mainD - 4, w: 4, d: 3 },
      level: 0,
      material: material === "grass" ? "sand" : "grass",
    });
  }

  // --- Harbor: water on a seeded shore, not always east --------------------
  byRole.vessel = [...byRole.vessel].sort((a, b) => visualMass(b) - visualMass(a)).slice(0, 6);
  if (zonePlan.harbor) {
    const harbor = harborLayout(harborSide, main, byRole.vessel.length);
    env.water.push({ id: "harbor-water", rect: harbor.water, level: 0 });
    env.platforms.push({ id: "pier", rect: harbor.pier, level: 0, material: "wood" });
    zones.push({
      id: "harbor",
      type: "harbor",
      label: "the harbor",
      rect: harbor.water,
      level: 0,
      focal: harbor.focal,
    });
  }

  // --- Street: south apron, or an east slip when the seed says so ----------
  let streetRect: LotRect | null = null;
  if (zonePlan.street) {
    const eastSlip = rng() > 0.55 && harborSide !== "e";
    streetRect = eastSlip
      ? { c0: c0 + mainW, r0, w: 2, d: mainD }
      : { c0, r0: r0 + mainD, w: mainW, d: 2 };
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

  // --- Skyline: a raised shelf along the far (north) edge, width varies ----
  let skylineRect: LotRect | null = null;
  if (zonePlan.skyline) {
    const inset = 1 + Math.floor(rng() * 3);
    skylineRect = { c0: c0 + inset, r0: r0 - 2 - Math.floor(rng() * 2), w: Math.max(4, mainW - inset * 2), d: 2 };
    env.platforms.push({ id: "rise", rect: skylineRect, level: 1, material: material === "sand" ? "sand" : "grass" });
    zones.push({
      id: "skyline",
      type: "skyline",
      label: "the rise behind town",
      rect: skylineRect,
      level: 1,
      focal: rectCenter(skylineRect),
    });
  }

  // --- Plaza: leftover, focal offset so the landmark isn't always dead center
  const focal = {
    col: Math.round(c0 + mainW * (0.35 + rng() * 0.3)),
    row: Math.round(r0 + mainD * (0.35 + rng() * 0.3)),
  };
  const plazaRect: LotRect = { c0: c0 + 1, r0: r0 + 1, w: mainW - 2, d: mainD - 2 };
  zones.push({ id: "plaza", type: "plaza", label: "the square", rect: plazaRect, level: 0, focal });
  env.zones = zones;

  // --- Paths: entrance to focal, stair to focal ----------------------------
  const paths: PathSpec[] = [];
  const pathCells: { col: number; row: number }[] = [];
  for (let r = r0 + mainD - 1; r >= focal.row; r -= 1) pathCells.push({ col: focal.col, row: r });
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
    paths.push({ id: "stair-walk", cells });
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
  const marketStalls = marketRect ? support.filter((i) => i.kind === "stall") : [];
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
      const col = gardenRect.c0 + (i % cols) * step + (seed % 2 ? 0 : 1);
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
    let col = skylineRect.c0 + 1 + (seed % 2);
    byRole.backdrop.slice(0, 4).forEach((item, i) => {
      place(item, col, skylineRect.r0 + (i % skylineRect.d), "raising the skyline", { ring: 1, allowSoft: true });
      col += 2 + (i % 2);
      if (col >= skylineRect.c0 + skylineRect.w - 1) col = skylineRect.c0 + 1;
    });
  } else {
    let col = c0 + 1 + (seed % 3);
    byRole.backdrop.slice(0, 4).forEach((item, i) => {
      place(item, col, r0, "raising the skyline", { ring: 1 });
      col += 2 + (i % 2);
    });
  }

  // Track: a CONTIGUOUS circuit walked cell by cell around the platform's
  // inner edge, so consecutive segments read as one continuous ride — a
  // sparse ring of scattered barriers is exactly the pile we're replacing.
  if (byRole.track.length) {
    const walk: { col: number; row: number }[] = [];
    const [l, r, t, b] = [c0, c0 + mainW - 1, r0, r0 + mainD - 1];
    for (let cCur = l; cCur <= r; cCur += 1) walk.push({ col: cCur, row: t });
    for (let rCur = t + 1; rCur <= b; rCur += 1) walk.push({ col: r, row: rCur });
    for (let cCur = r - 1; cCur >= l; cCur -= 1) walk.push({ col: cCur, row: b });
    for (let rCur = b - 1; rCur > t; rCur -= 1) walk.push({ col: l, row: rCur });
    const start = seed % walk.length;
    byRole.track.slice(0, walk.length).forEach((item, i) => {
      place(item, walk[(start + i) % walk.length].col, walk[(start + i) % walk.length].row, "laying the circuit", {
        ring: 0,
        allowSoft: true,
        tight: true,
      });
    });
  }

  // People last — they live near the action. Each zone gets an anchor crowd;
  // pets favor the garden and the square.
  const anchors: { col: number; row: number; label: string }[] = [];
  for (const zone of zones) {
    if (zone.focal && zone.type !== "skyline" && zone.type !== "harbor") {
      anchors.push({ col: Math.round(zone.focal.col), row: Math.round(zone.focal.row), label: zone.label });
    }
  }
  if (!anchors.length) anchors.push({ col: focal.col, row: focal.row, label: "the square" });
  byRole.person.forEach((item, i) => {
    const anchor = anchors[i % anchors.length];
    const jitter = [(i * 7) % 3 - 1, ((i * 5) % 3) - 1];
    const col = anchor.col + jitter[0];
    const row = anchor.row + 1 + jitter[1];
    place(item, col, row, i % 3 === 0 ? `taking in ${anchor.label}` : `together in ${anchor.label}`, {
      rot: faceToward(col, row, anchor),
      flip: i % 2 === 1,
      ring: 2,
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
  return { env, todos };
}
