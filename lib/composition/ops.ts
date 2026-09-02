import type { CatalogItem } from "../catalog";
import { lotIdOf, parseLotId, rectCenter, rectContains, type LotRect } from "./grid3d";
import { roleOf, visualMass, type Role } from "./roles";
import { clearanceLots } from "./scale3d";
import { cellKey, findZoneRect, generateHarborWaterMask, generateIslandMask, largestRectInMask, maskToRects, pushWaterMask, type HarborSide, type IslandMask } from "./island";
import { createSeededRandom, deriveSeed } from "./seed";
import { planBuilding } from "./buildings";
import { resolveTheme, themeById } from "./themes";
import { selectItems } from "./select";
import { platformAt } from "./surface";
import { emptyEnvironment, type EnvironmentSpec, type PlatformMaterial, type ZoneSpec, type ZoneType } from "./types";

/**
 * Incremental environment intent — the semantic verbs behind the WebMCP
 * tools create_zone / create_path / create_prop_cluster / create_focal_point.
 *
 * Where compose.ts builds a whole scene from a theme in one pass, these ops
 * grow the CURRENT environment one intention at a time: "add a market on the
 * east side", "connect the garden to the square", "fill the terrace". The
 * agent describes intent; this module owns the exact geometry.
 */

export type ZoneLocation = "north" | "south" | "east" | "west" | "center";
export type ZoneSize = "small" | "medium" | "large";

export type ClusterSpec = {
  id: string;
  lot: string;
  flip?: boolean;
  rot?: number;
  reason: string;
};

const ZONE_LABEL: Record<ZoneType, string> = {
  plaza: "the square",
  home: "the house",
  market: "the market row",
  garden: "the garden",
  harbor: "the harbor",
  street: "the street",
  arcade: "the arcade hall",
  workshop: "the workshop",
  keep: "the keep",
  lab: "the lab",
  camp: "the camp",
  skyline: "the rise behind town",
};

/** Theme used to pull catalog items when the agent gives none. */
const ZONE_THEME: Record<ZoneType, string> = {
  plaza: "town square people statue monument",
  home: "cozy home living room furniture",
  market: "market stalls grocery food shop",
  garden: "garden trees flowers nature park",
  harbor: "harbor boats dock sea sail",
  street: "street cars traffic road",
  arcade: "arcade games machines retro",
  workshop: "workshop workbench tools survival",
  keep: "dungeon keep castle chest banner",
  lab: "space lab station scifi",
  camp: "camp tent campfire wilderness",
  skyline: "city buildings skyline houses",
};

/** Interior zone types get a raised, walled room; the rest live on the deck. */
const INTERIOR_TYPES = new Set<ZoneType>(["home", "arcade", "keep", "lab"]);

function sizeDims(type: ZoneType, size: ZoneSize): { w: number; d: number } {
  const factor = size === "small" ? 0.75 : size === "large" ? 1.35 : 1;
  const base =
    type === "market" ? { w: 3, d: 6 }
    : type === "street" ? { w: 10, d: 2 }
    : type === "skyline" ? { w: 9, d: 2 }
    : type === "harbor" ? { w: 6, d: 8 }
    : INTERIOR_TYPES.has(type) ? { w: 5, d: 4 }
    : { w: 4, d: 4 };
  return {
    w: Math.max(3, Math.round(base.w * factor)),
    d: Math.max(2, Math.round(base.d * factor)),
  };
}

function cloneEnv(env: EnvironmentSpec | null): EnvironmentSpec {
  if (!env) return emptyEnvironment();
  return {
    platforms: [...env.platforms],
    walls: [...env.walls],
    stairs: [...env.stairs],
    paths: [...env.paths],
    water: [...env.water],
    zones: [...env.zones],
    themeId: env.themeId,
    pathMaterial: env.pathMaterial,
    ground: env.ground ? [...env.ground] : undefined,
    waterCells: env.waterCells ? [...env.waterCells] : undefined,
  };
}

/**
 * The walkable deck as a mask — the union of every non-inset ground platform.
 * Footprints are organic (strip-decomposed island blobs), so "the main
 * platform" is a shape, not a rectangle.
 */
function deckInfo(env: EnvironmentSpec): { mask: IslandMask; material: PlatformMaterial } | null {
  const ground = env.platforms.filter((p) => !p.inset && p.level === 0 && p.material !== "road" && p.id !== "pier");
  if (!ground.length) return null;
  const cells = new Set<string>();
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (const p of ground) {
    for (let r = p.rect.r0; r < p.rect.r0 + p.rect.d; r += 1) {
      for (let c = p.rect.c0; c < p.rect.c0 + p.rect.w; c += 1) {
        cells.add(cellKey(c, r));
      }
    }
    c0 = Math.min(c0, p.rect.c0);
    r0 = Math.min(r0, p.rect.r0);
    c1 = Math.max(c1, p.rect.c0 + p.rect.w - 1);
    r1 = Math.max(r1, p.rect.r0 + p.rect.d - 1);
  }
  return {
    mask: { cells, bbox: { c0, r0, w: c1 - c0 + 1, d: r1 - r0 + 1 } },
    material: ground[0].material,
  };
}

function uniqueId(env: EnvironmentSpec, base: string): string {
  const taken = new Set([
    ...env.zones.map((z) => z.id),
    ...env.platforms.map((p) => p.id),
    ...env.paths.map((p) => p.id),
  ]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** An empty board gets a starter island — an organic one — before its first
 * zone lands. Deterministic: the same starter blob every time. */
function ensureFooting(env: EnvironmentSpec): EnvironmentSpec {
  if (deckInfo(env)) return env;
  const rng = createSeededRandom(deriveSeed("STARTER", "footing"));
  const island = generateIslandMask(rng, { col: 12, row: 12 }, 6.5, 5.5);
  maskToRects(island).forEach((rect, i) => {
    env.platforms.push({ id: `main-${i}`, rect, level: 0, material: "grass" });
  });
  const core = largestRectInMask(island);
  const focal = rectCenter(core);
  env.zones.push({
    id: "plaza",
    type: "plaza",
    label: ZONE_LABEL.plaza,
    rect: core,
    level: 0,
    focal: { col: Math.round(focal.col), row: Math.round(focal.row) },
  });
  return env;
}

/** Find a w×d rect fully on the deck near one side, clear of other zones
 * and stairs (the plaza doesn't count — it's the leftover). */
function freeInsideRect(env: EnvironmentSpec, w: number, d: number, location: ZoneLocation): LotRect | null {
  const deck = deckInfo(env);
  if (!deck) return null;
  const m = deck.mask.bbox;
  const taken = [
    ...env.zones.filter((z) => z.type !== "plaza").map((z) => z.rect),
    ...env.stairs.map((s) => ({ c0: s.at.col, r0: s.at.row, w: 1, d: 1 })),
  ];
  const bias =
    location === "north"
      ? { col: m.c0 + m.w / 2, row: m.r0 + 1 }
      : location === "south"
        ? { col: m.c0 + m.w / 2, row: m.r0 + m.d - 2 }
        : location === "west"
          ? { col: m.c0 + 1, row: m.r0 + m.d / 2 }
          : location === "east"
            ? { col: m.c0 + m.w - 2, row: m.r0 + m.d / 2 }
            : { col: m.c0 + m.w / 2, row: m.r0 + m.d / 2 };
  return findZoneRect(deck.mask, taken, w, d, bias);
}

/** Annex a new deck outside one side of the current footprint. */
function annexRect(env: EnvironmentSpec, w: number, d: number, location: ZoneLocation): LotRect {
  const m = deckInfo(env)!.mask.bbox;
  if (location === "north") return { c0: m.c0 + Math.floor((m.w - w) / 2), r0: m.r0 - d, w, d };
  if (location === "south") return { c0: m.c0 + Math.floor((m.w - w) / 2), r0: m.r0 + m.d, w, d };
  if (location === "west") return { c0: m.c0 - w, r0: m.r0 + Math.floor((m.d - d) / 2), w, d };
  return { c0: m.c0 + m.w, r0: m.r0 + Math.floor((m.d - d) / 2), w, d };
}

const DEFAULT_LOCATION: Partial<Record<ZoneType, ZoneLocation>> = {
  home: "north",
  arcade: "north",
  keep: "north",
  lab: "north",
  garden: "west",
  market: "east",
  harbor: "east",
  street: "south",
  skyline: "north",
  camp: "west",
  workshop: "east",
};

export type AddZoneResult = { env: EnvironmentSpec; zone: ZoneSpec; note: string };

/**
 * Add one functional zone to the current environment. Interior types raise a
 * walled terrace with a stair; a garden lays an inset bed; a harbor digs
 * water and builds a pier; a street pours a road apron; anything that can't
 * fit inside the main platform annexes new deck on its side. A connecting
 * path to the plaza is threaded automatically.
 */
export function addZone(
  current: EnvironmentSpec | null,
  type: ZoneType,
  opts: { location?: ZoneLocation; size?: ZoneSize; label?: string; sceneSeed?: string } = {},
): AddZoneResult {
  const env = ensureFooting(cloneEnv(current));
  const deck = deckInfo(env)!;
  const location = opts.location ?? DEFAULT_LOCATION[type] ?? "center";
  const { w, d } = sizeDims(type, opts.size ?? "medium");
  const label = opts.label?.slice(0, 40) || ZONE_LABEL[type];
  const zoneId = uniqueId(env, type);
  let note = "";

  let rect: LotRect;
  let level = 0;

  if (type === "harbor") {
    const m = deck.mask.bbox;
    const side: HarborSide = location === "south" ? "s" : location === "west" ? "w" : "e";
    const depth = Math.min(8, d + 2);
    const rng = createSeededRandom(deriveSeed(opts.sceneSeed ?? "UNSEEDED", `harbor:${zoneId}`));
    const waterMask = generateHarborWaterMask(deck.mask, side, rng, depth);
    pushWaterMask(env.water, waterMask, uniqueId(env, "water"), 0);
    rect = waterMask.bbox;
    const pier =
      location === "south"
        ? { c0: m.c0 + Math.floor(m.w / 2), r0: m.r0 + m.d, w: 1, d: 2 }
        : location === "west"
          ? { c0: m.c0 - 2, r0: m.r0 + Math.floor(m.d / 2), w: 2, d: 1 }
          : { c0: m.c0 + m.w, r0: m.r0 + Math.floor(m.d / 2), w: 2, d: 1 };
    env.platforms.push({ id: uniqueId(env, "pier"), rect: pier, level: 0, material: "wood" });
    note = "water dug and pier built";
  } else if (type === "street") {
    rect = annexRect(env, Math.max(w, deck.mask.bbox.w), 2, location === "center" ? "south" : location);
    env.platforms.push({ id: uniqueId(env, "road"), rect, level: 0, material: "road" });
    note = "road apron poured";
  } else if (type === "skyline") {
    rect = annexRect(env, w, 2, "north");
    level = 1;
    env.platforms.push({ id: uniqueId(env, "rise"), rect, level: 1, material: "grass" });
    note = "backdrop rise raised";
  } else {
    const inside = freeInsideRect(env, w, d, location);
    if (inside) {
      rect = inside;
      note = "placed on the main platform";
    } else {
      rect = annexRect(env, w, d, location === "center" ? "east" : location);
      env.platforms.push({ id: uniqueId(env, `${type}-deck`), rect, level: 0, material: deck.material });
      note = "no room inside — new deck annexed";
    }
    if (INTERIOR_TYPES.has(type)) {
      level = 1;
      // The same seeded building designer the composers use.
      const theme = themeById(env.themeId) ?? resolveTheme(label, deck.material);
      const building = planBuilding({
        id: uniqueId(env, zoneId),
        type,
        rect,
        onDeck: (c, r) => deck.mask.cells.has(cellKey(c, r)),
        theme,
        rng: createSeededRandom(deriveSeed(opts.sceneSeed ?? "UNSEEDED", `building:${zoneId}:${env.zones.length}`)),
      });
      env.platforms.push(...building.platforms);
      env.walls.push(...building.walls);
      env.stairs.push(building.stair);
      note += `; ${building.style} building (${building.palette}) with stair added`;
    } else if (type === "garden" && deck.material !== "grass") {
      env.platforms.push({ id: uniqueId(env, "garden-bed"), rect, level: 0, material: "grass", inset: true });
      note += "; grass bed laid";
    }
  }

  const focalPt = rectCenter(rect);
  const zone: ZoneSpec = {
    id: zoneId,
    type,
    label,
    rect,
    level,
    focal: { col: Math.round(focalPt.col), row: Math.round(focalPt.row) },
  };
  // Specific zones must sit BEFORE the plaza — zoneAt answers first match.
  const plazaIdx = env.zones.findIndex((z) => z.type === "plaza");
  if (plazaIdx >= 0) env.zones.splice(plazaIdx, 0, zone);
  else env.zones.push(zone);

  // Thread a walk from the new zone toward the plaza focal.
  const plaza = env.zones.find((z) => z.type === "plaza");
  if (plaza?.focal && type !== "skyline" && type !== "harbor") {
    env.paths = [...env.paths, pathBetweenPoints(env, zone.focal!, plaza.focal, uniqueId(env, `walk-${zoneId}`))];
  }

  return { env, zone, note };
}

/** L-shaped walk between two lot points, clipped to the decks. */
export function pathBetweenPoints(
  env: EnvironmentSpec,
  a: { col: number; row: number },
  b: { col: number; row: number },
  id = "walk",
) {
  const cells: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  const push = (col: number, row: number) => {
    const k = `${col}:${row}`;
    if (seen.has(k)) return;
    if (!platformAt(env, col, row)) return;
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
  return { id, cells };
}

/** Resolve a zone id, zone type, or lot id to a point on the board. */
export function resolvePoint(env: EnvironmentSpec | null, ref: string): { col: number; row: number; label: string } | null {
  const zone = env?.zones.find((z) => z.id === ref.trim() || z.type === ref.trim());
  if (zone?.focal) return { col: zone.focal.col, row: zone.focal.row, label: zone.label };
  const lot = parseLotId(ref);
  if (lot) return { col: lot.col, row: lot.row, label: ref.trim().toUpperCase() };
  return null;
}

// ---------------------------------------------------------------------------
// Cluster fills — one purposeful arrangement per zone type.
// ---------------------------------------------------------------------------

function groupRoles(items: CatalogItem[]): Record<Role, CatalogItem[]> {
  const byRole: Record<Role, CatalogItem[]> = {
    ground: [], wall: [], connector: [], structure: [], backdrop: [],
    track: [], tabletop: [], vessel: [], vehicle: [], person: [], scenery: [],
  };
  for (const item of items) byRole[roleOf(item)].push(item);
  return byRole;
}

/**
 * A purpose-grouped cluster for one zone: primary pieces arranged by the
 * zone's own grammar (stalls face the aisle, furniture backs the walls,
 * trees keep canopy spacing), a couple of characters facing the action.
 * Exact collision/lock handling belongs to the live placement engine — these
 * are intents, one per lot.
 */
export function clusterForZone(
  env: EnvironmentSpec,
  zone: ZoneSpec,
  theme: string | undefined,
  sceneSeed?: string,
): ClusterSpec[] {
  // Cluster variation hangs off the scene seed (per zone, per flavor) so the
  // same seeded scene refurnishes identically — and a remix differs.
  const seed = deriveSeed(sceneSeed ?? "UNSEEDED", `cluster:${zone.id}:${theme ?? ""}`);
  let pool = selectItems(theme?.trim() || ZONE_THEME[zone.type], seed);
  if (theme?.trim() && pool.length < 10) {
    // A narrow theme ("cozy reading nook") starves the cluster — blend in the
    // zone's own vocabulary so the room still gets fully furnished.
    pool = selectItems(`${theme} ${ZONE_THEME[zone.type]}`, seed);
  }
  const byRole = groupRoles(pool);
  const { c0, r0, w, d } = zone.rect;
  const cap = Math.max(3, Math.floor((w * d) / 2));
  const out: ClusterSpec[] = [];
  const used = new Set<string>();
  const add = (item: CatalogItem, col: number, row: number, reason: string, opts: { flip?: boolean; rot?: number } = {}) => {
    if (out.length >= cap) return;
    if (!rectContains(zone.rect, col, row) && zone.type !== "harbor") return;
    // One lot, one piece: a second spec for the same cell would only be
    // refused at placement time.
    const lot = lotIdOf(col, row);
    if (used.has(lot)) return;
    used.add(lot);
    out.push({ id: item.id, lot, flip: opts.flip, rot: opts.rot, reason });
  };
  const focal = zone.focal ?? rectCenter(zone.rect);

  if (zone.type === "market") {
    const stalls = byRole.structure.filter((i) => i.kind === "stall");
    const vertical = d >= w;
    stalls.slice(0, Math.max(2, Math.floor((vertical ? d : w) / 1))).forEach((item, i) => {
      const side = i % 2;
      if (vertical) add(item, side === 0 ? c0 : c0 + w - 1, r0 + Math.floor(i / 2), "among the market stalls", { rot: side === 0 ? 270 : 90 });
      else add(item, c0 + Math.floor(i / 2), side === 0 ? r0 : r0 + d - 1, "among the market stalls", { rot: side === 0 ? 0 : 180 });
    });
    byRole.tabletop.slice(0, 4).forEach((item, i) => {
      add(item, c0 + 1 + (i % Math.max(1, w - 2)), r0 + 1 + Math.floor(i / Math.max(1, w - 2)), "laid out on the table");
    });
  } else if (zone.type === "garden" || zone.type === "camp") {
    const trees = byRole.scenery.filter((i) => i.kind === "tree").slice(0, 6);
    const plants = byRole.scenery.filter((i) => i.kind !== "tree").slice(0, 6);
    trees.forEach((item, i) => {
      const step = Math.max(2, Math.ceil(clearanceLots(item) * 2));
      const cols = Math.max(1, Math.floor(w / step));
      add(item, c0 + (i % cols) * step, r0 + Math.floor(i / cols) * step, `keeping ${zone.label}`);
    });
    plants.forEach((item, i) => {
      add(item, c0 + ((i * 2 + 1) % Math.max(1, w)), r0 + ((i + 1) % Math.max(1, d)), `keeping ${zone.label}`);
    });
    byRole.structure.slice(0, 2).forEach((item, i) => {
      add(item, Math.round(focal.col) + i, Math.round(focal.row), `the heart of ${zone.label}`);
    });
  } else if (zone.type === "street") {
    const horizontal = w >= d;
    byRole.vehicle.slice(0, 8).forEach((item, i) => {
      const lane = i % Math.min(2, horizontal ? d : w);
      if (horizontal) add(item, c0 + 1 + Math.floor(i / 2) * 2, r0 + lane, "rolling down the street", { rot: lane === 0 ? 270 : 90 });
      else add(item, c0 + lane, r0 + 1 + Math.floor(i / 2) * 2, "rolling down the street", { rot: lane === 0 ? 0 : 180 });
    });
  } else if (zone.type === "harbor") {
    byRole.vessel
      .sort((a, b) => visualMass(b) - visualMass(a))
      .slice(0, 5)
      .forEach((item, i) => {
        const col = c0 + 1 + (i % 2) * 3 + Math.floor(i / 2);
        const row = r0 + 1 + Math.floor(i / 2) * 3;
        if (rectContains(zone.rect, col, row)) {
          out.push({ id: item.id, lot: lotIdOf(col, row), reason: i === 0 ? "flagship off the shore" : "riding at anchor" });
        }
      });
  } else if (zone.type === "skyline") {
    byRole.backdrop.slice(0, 4).forEach((item, i) => {
      add(item, c0 + 1 + i * 2, r0 + (i % Math.max(1, d)), "raising the skyline");
    });
  } else if (INTERIOR_TYPES.has(zone.type)) {
    const fixtures = byRole.structure.slice(0, cap);
    const wallRow = fixtures.filter((_, i) => i % 2 === 0).slice(0, w);
    const inner = fixtures.filter((_, i) => i % 2 === 1).slice(0, Math.max(1, w - 1));
    wallRow.forEach((item, i) => add(item, c0 + i, r0, `along the back of ${zone.label}`, { rot: 0 }));
    inner.forEach((item, i) => add(item, c0 + 1 + (i % Math.max(1, w - 2)), r0 + d - 1 - Math.floor(i / Math.max(1, w - 2)), `inside ${zone.label}`, { rot: i % 2 ? 90 : 0 }));
    byRole.tabletop.slice(0, 2).forEach((item, i) => add(item, c0 + 1 + i, r0 + 1, `set out in ${zone.label}`));
  } else {
    // plaza / workshop / generic: a loose arc of structures around the focal.
    const arms: [number, number][] = [[-2, 1], [2, 1], [0, 3], [-3, -1], [3, -1]];
    byRole.structure.slice(0, 5).forEach((item, i) => {
      const [dc, dr] = arms[i % arms.length];
      const col = Math.round(focal.col) + dc;
      const row = Math.round(focal.row) + dr;
      add(item, col, row, `around ${zone.label}`, { rot: 0 });
    });
    byRole.scenery.slice(0, 3).forEach((item, i) => {
      add(item, c0 + (i * 2) % Math.max(1, w), r0, `framing ${zone.label}`);
    });
  }

  // Life: a couple of characters near the focal, facing it — clamped inside
  // the zone so its inhabitants never stand just past its bounds.
  byRole.person.slice(0, 2).forEach((item, i) => {
    const col = Math.min(c0 + w - 1, Math.max(c0, Math.round(focal.col) + (i === 0 ? -1 : 1)));
    const row = Math.min(r0 + d - 1, Math.max(r0, Math.round(focal.row) + 1));
    add(item, col, row, `together in ${zone.label}`, { rot: i === 0 ? 270 : 90, flip: i === 1 });
  });

  return out;
}

/** The most massive themed structure — the landmark a focal point deserves. */
export function focalCandidate(theme: string | undefined, zone: ZoneSpec, sceneSeed?: string): CatalogItem | null {
  const seed = deriveSeed(sceneSeed ?? "UNSEEDED", `focal:${zone.id}:${theme ?? ""}`);
  const pool = selectItems(theme?.trim() || ZONE_THEME[zone.type], seed);
  const byRole = groupRoles(pool);
  const ranked = [...byRole.structure, ...byRole.scenery].sort((a, b) => visualMass(b) - visualMass(a));
  return ranked[0] ?? null;
}
