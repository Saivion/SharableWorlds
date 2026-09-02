import type { CatalogItem } from "../catalog";
import { rectContains } from "./grid3d";
import { cellKey } from "./island";
import { Board, key, type Placement } from "./layout";
import { pickItems } from "./pick";
import { clearanceLots, modelScale } from "./scale3d";
import { createSeededRandom, deriveSeed } from "./seed";
import { isTilesetJunk } from "./select";
import { platformAt } from "./surface";
import type { ThemeSpec } from "./themes";
import type { EnvironmentSpec, ZoneSpec, ZoneType } from "./types";

/**
 * The density pass — a scene is FULL, never a story on bare ground.
 *
 * After the story objects, the people, the frame, and the relief, every
 * remaining cell that isn't a walk, a stair approach, or the landmark's
 * ring is a candidate for TEXTURE: the small things that make ground read
 * as a place. What goes where follows the zone under the cell and the
 * theme — undergrowth and flowers on lawns, crates and planters around
 * markets and streets, cargo and pipework on a station pad, trees and rocks
 * on hillsides and at the coast, a plant or a lamp inside a room (never
 * more than a couple). Placement obeys the engine's own clearance, so
 * texture never crowds the story; it fills up to a target share of the
 * land, densest at the edges, and stops.
 */

export const DEFAULT_DENSITY = 0.4;

type Pool = { small: CatalogItem[]; tall: CatalogItem[] };

const MARKET_TEXTURE = ["market-shopping-basket", "pirate-crate", "dungeon-barrel", "survival-box", "survival-barrel", "nature-pot-small", "nature-pot-large", "coaster-flowers", "coaster-trash", "nature-sign", "survival-signpost", "survival-box-large"];
const STREET_TEXTURE = ["car-cone", "car-cone-flat", "coaster-trash", "nature-pot-large", "furniture-lamp-round-floor", "survival-box", "market-shopping-cart", "coaster-flowers"];
const ROOM_TEXTURE = ["furniture-plant-small1", "furniture-plant-small2", "furniture-potted-plant", "furniture-lamp-round-floor", "furniture-cardboard-box-open", "survival-box", "dungeon-pot", "dungeon-barrel", "prototype-crate"];
const ARENA_TEXTURE = ["arena-bricks", "arena-block", "dungeon-rocks", "arena-banner", "dungeon-barrel", "dungeon-pot"];

const LAWN_TYPES = new Set<ZoneType>(["plaza", "garden", "camp"]);
const INTERIOR_TYPES = new Set<ZoneType>(["home", "arcade", "keep", "lab"]);

/** Texture is the small stuff: pieces that sit a lot apart without
 * crowding (clearance about half a lot), never people, vehicles, or boats. */
function small(items: CatalogItem[], max = 0.8): CatalogItem[] {
  return items.filter(
    (i) => i.model && !isTilesetJunk(i) && modelScale(i).footprint <= max && clearanceLots(i) <= 0.56 && i.kind !== "character" && i.kind !== "pet" && i.kind !== "car" && i.kind !== "boat",
  );
}

function poolsFor(theme: ThemeSpec, seed: number): { lawn: Pool; market: Pool; street: Pool; room: Pool; arena: Pool; hill: Pool } {
  const under = pickItems({ query: theme.undergrowthQuery ?? "plant bush flower rock nature" }, seed, 18);
  const trees = pickItems(theme.boundaryIds?.length ? { ids: theme.boundaryIds } : { query: theme.boundaryQuery }, seed + 1, 10).filter((i) => i.model && !isTilesetJunk(i));
  const lawn: Pool = { small: small(under), tall: trees.filter((i) => i.kind === "tree" || modelScale(i).footprint > 0.6) };
  if (!lawn.small.length) lawn.small = small(pickItems({ query: "plant bush flower rock nature", kinds: ["nature"] }, seed, 16));
  return {
    lawn,
    market: { small: small(pickItems({ ids: MARKET_TEXTURE }, seed, 12)), tall: [] },
    street: { small: small(pickItems({ ids: STREET_TEXTURE }, seed, 10)), tall: [] },
    room: { small: small(pickItems({ ids: ROOM_TEXTURE }, seed, 9), 0.6), tall: [] },
    arena: { small: small(pickItems({ ids: ARENA_TEXTURE }, seed, 8)), tall: [] },
    hill: { small: small(under.filter((i) => i.kind === "nature" || i.kind === "prop")), tall: trees },
  };
}

export type DensityOptions = {
  env: EnvironmentSpec;
  board: Board;
  theme: ThemeSpec;
  seed: string;
  /** Pieces already standing (story + frame). */
  placed: number;
  /** Target pieces per level-0 land cell (default DEFAULT_DENSITY). */
  target?: number;
  /** Cells that must stay open: walks, stair approaches, the landmark ring, the entrance. */
  keepClear: Set<string>;
  /** Hard cap on pieces this pass may add. */
  max?: number;
};

function landCells(env: EnvironmentSpec): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  for (const p of env.platforms) {
    if (p.inset || p.material === "road" || p.id === "pier") continue;
    for (let r = p.rect.r0; r < p.rect.r0 + p.rect.d; r += 1) {
      for (let c = p.rect.c0; c < p.rect.c0 + p.rect.w; c += 1) {
        const k = cellKey(c, r);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ col: c, row: r });
      }
    }
  }
  return out;
}

function zoneAt(env: EnvironmentSpec, col: number, row: number): ZoneSpec | null {
  // A harbor's rect is its water; land cells under that bbox belong to
  // whatever land zone holds them (or the open ground), not to the sea.
  for (const z of env.zones) if (z.type !== "harbor" && rectContains(z.rect, col, row)) return z;
  return null;
}

/** Fill the scene toward `target` density. Returns the placements added. */
export function fillToDensity(opts: DensityOptions): Placement[] {
  const { env, board, theme, seed, keepClear } = opts;
  const rng = createSeededRandom(deriveSeed(seed, "density"));
  const pools = poolsFor(theme, deriveSeed(seed, "density:pools"));
  const land = landCells(env);
  // Every standable cell counts — hillsides included — so a stacked ridge
  // never shrinks the target below the story that already stands.
  const target = Math.round((opts.target ?? DEFAULT_DENSITY) * land.length);
  let count = opts.placed;
  const out: Placement[] = [];
  if (count >= target || !land.length) return out;
  const budget = Math.min(opts.max ?? 110, target - count);

  const isEdge = (col: number, row: number) => {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (!platformAt(env, col + dc, row + dr)) return true;
    return false;
  };
  const isHill = (col: number, row: number) => platformAt(env, col, row)?.id.startsWith("hill-") ?? false;
  // Edge and hillside cells first (that is where fullness reads from the
  // camera), then the open middle; seeded order inside each band.
  const shuffle = <T,>(list: T[]) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const candidates = land.filter((c) => !keepClear.has(cellKey(c.col, c.row)) && !board.taken.has(key(c.col, c.row)));
  const outer = shuffle(candidates.filter((c) => isEdge(c.col, c.row) || isHill(c.col, c.row)));
  const inner = shuffle(candidates.filter((c) => !isEdge(c.col, c.row) && !isHill(c.col, c.row)));
  const roomAdds = new Map<string, number>();

  for (const cell of [...outer, ...inner]) {
    if (out.length >= budget) break;
    const zone = zoneAt(env, cell.col, cell.row);
    const hill = isHill(cell.col, cell.row);
    let pool: Pool;
    let reason: string;
    if (hill) {
      pool = pools.hill;
      reason = "on the hillside";
    } else if (!zone || LAWN_TYPES.has(zone.type) || zone.type === "skyline") {
      pool = pools.lawn;
      reason = zone ? `texture in ${zone.label}` : "at the edge";
    } else if (zone.type === "market" || zone.type === "workshop") {
      pool = pools.market;
      reason = `around ${zone.label}`;
    } else if (zone.type === "street") {
      pool = pools.street;
      reason = `along ${zone.label}`;
    } else if (INTERIOR_TYPES.has(zone.type)) {
      if ((roomAdds.get(zone.id) ?? 0) >= 2) continue;
      pool = pools.room;
      reason = `inside ${zone.label}`;
    } else {
      continue; // harbor water, piers
    }
    if (!pool.small.length && !pool.tall.length) continue;
    // Edges and hills grow tall things a third of the time; the middle stays low.
    const wantTall = pool.tall.length > 0 && (hill || isEdge(cell.col, cell.row)) && rng() < 0.35;
    const list = wantTall ? pool.tall : pool.small.length ? pool.small : pool.tall;
    const item = list[Math.floor(rng() * list.length)];
    const ok = board.claim(cell.col, cell.row, false, undefined, clearanceLots(item), item.kind);
    if (!ok) continue;
    const rot = [0, 90, 180, 270][Math.floor(rng() * 4)];
    out.push({ item, col: cell.col, row: cell.row, ...(rot ? { rot } : {}), reason, zone: zone?.id ?? "edge", role: "texture", phase: "environment" });
    if (zone && INTERIOR_TYPES.has(zone.type)) roomAdds.set(zone.id, (roomAdds.get(zone.id) ?? 0) + 1);
    count += 1;
  }
  return out;
}

/** The cells the story needs open: walks and their shoulders' worth of
 * breathing room only where the walk is, stair approaches, focal rings, the entrance. */
export function keepClearFor(env: EnvironmentSpec, focals: { col: number; row: number }[], entrance: { col: number; row: number } | null): Set<string> {
  const clear = new Set<string>();
  for (const p of env.paths) for (const c of p.cells) clear.add(cellKey(c.col, c.row));
  for (const s of env.stairs) {
    const [dc, dr] = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[s.dir] ?? [0, 1];
    for (const c of [s.at, { col: s.at.col + dc, row: s.at.row + dr }, { col: s.at.col - dc, row: s.at.row - dr }]) clear.add(cellKey(c.col, c.row));
  }
  for (const f of focals) for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) clear.add(cellKey(f.col + dc, f.row + dr));
  if (entrance) clear.add(cellKey(entrance.col, entrance.row));
  return clear;
}

// ---------------------------------------------------------------------------
// The water pass — the sea is dressed the way the land is.
// ---------------------------------------------------------------------------

/** Target pieces per open water cell. Water should still read as water:
 * sparser than land, densest along the shore, one big vessel at most. */
export const WATER_DENSITY = 0.12;

// Plain buoys twice as often as the tall flagged one — a shoreline of red
// posts reads as a fence, not a channel.
const WATER_MARKS = ["watercraft-buoy", "watercraft-buoy", "watercraft-buoy-flag"];
const WATER_ROCKS = ["pirate-rocks-a", "pirate-rocks-b", "pirate-rocks-c"];
const WATER_SMALL = [
  "watercraft-boat-row-small",
  "watercraft-boat-row-large",
  "pirate-boat-row-small",
  "pirate-boat-row-large",
  "watercraft-boat-fishing-small",
  "watercraft-boat-sail-a",
  "watercraft-boat-speed-a",
  "watercraft-boat-speed-b",
  "watercraft-boat-speed-c",
];
const WATER_BIG = ["watercraft-boat-sail-b", "watercraft-boat-tug-a", "watercraft-boat-house-a", "watercraft-boat-house-b", "watercraft-ship-small"];

/** Every water cell with nothing built over it (piers and decks excluded). */
export function waterCells(env: EnvironmentSpec): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  const seen = new Set<string>();
  for (const w of env.water) {
    for (let r = w.rect.r0; r < w.rect.r0 + w.rect.d; r += 1) {
      for (let c = w.rect.c0; c < w.rect.c0 + w.rect.w; c += 1) {
        const k = cellKey(c, r);
        if (seen.has(k) || platformAt(env, c, r)) continue;
        seen.add(k);
        out.push({ col: c, row: r });
      }
    }
  }
  return out;
}

/** How many more pieces the water wants, given what already floats on it. */
export function waterNeed(env: EnvironmentSpec, occupied: Iterable<{ col: number; row: number }>): number {
  const water = waterCells(env);
  if (water.length < 6) return 0;
  const cells = new Set(water.map((c) => cellKey(c.col, c.row)));
  let afloat = 0;
  for (const b of occupied) if (cells.has(cellKey(b.col, b.row))) afloat += 1;
  return Math.max(0, Math.max(3, Math.round(water.length * WATER_DENSITY)) - afloat);
}

export type WaterOptions = {
  env: EnvironmentSpec;
  board: Board;
  seed: string;
  /** Cells that stay open — the flagship's ring, the dock approach. */
  keepClear: Set<string>;
  /** Hard cap on pieces this pass may add. */
  max?: number;
};

/**
 * Dress the water: buoys marking the channel and rocks off the shore, small
 * boats riding at anchor further out, and — on a big enough sea — one larger
 * vessel. Everything claims the engine's own clearance, keeps off the pier
 * approach, and stops at WATER_DENSITY so the sea keeps its negative space.
 */
export function fillWater(opts: WaterOptions): Placement[] {
  const { env, board, seed, keepClear } = opts;
  const water = waterCells(env);
  const out: Placement[] = [];
  const need = Math.min(opts.max ?? 28, waterNeed(env, board.bodies));
  if (!need) return out;
  const rng = createSeededRandom(deriveSeed(seed, "water"));
  const ps = deriveSeed(seed, "water:pools");
  // pickItems dedupes, so weight by repeating ids here rather than there.
  const usable = (ids: string[]) => ids.flatMap((id) => pickItems({ ids: [id] }, ps, 1)).filter((i) => i.model && !isTilesetJunk(i));
  const pools = { marks: usable(WATER_MARKS), rocks: usable(WATER_ROCKS), small: usable(WATER_SMALL), big: usable(WATER_BIG) };
  if (!pools.small.length && !pools.marks.length) return out;

  const isWater = (col: number, row: number) => env.water.some((w) => rectContains(w.rect, col, row)) && !platformAt(env, col, row);
  const nearLand = (col: number, row: number) => {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (platformAt(env, col + dc, row + dr)) return true;
    return false;
  };
  // The dock stays reachable: nothing moors on the cells touching the pier.
  const pier = env.platforms.find((p) => p.id === "pier");
  const pierSide = (col: number, row: number) => {
    if (!pier) return false;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const)
      if (rectContains(pier.rect, col + dc, row + dr)) return true;
    return false;
  };
  const shuffle = <T,>(list: T[]) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const open = water.filter((c) => !keepClear.has(cellKey(c.col, c.row)) && !board.taken.has(key(c.col, c.row)) && !pierSide(c.col, c.row));
  const shore = shuffle(open.filter((c) => nearLand(c.col, c.row)));
  const deep = shuffle(open.filter((c) => !nearLand(c.col, c.row)));
  // Interleave so the fill spreads: shore, deep, shore, deep…
  const order: { col: number; row: number; shore: boolean }[] = [];
  for (let i = 0; i < Math.max(shore.length, deep.length); i += 1) {
    if (shore[i]) order.push({ ...shore[i], shore: true });
    if (deep[i]) order.push({ ...deep[i], shore: false });
  }
  const harborZone = (col: number, row: number) => env.zones.find((z) => z.type === "harbor" && rectContains(z.rect, col, row));
  let bigPlaced = false;
  const wantBig = water.length >= 24 && pools.big.length > 0;

  for (const cell of order) {
    if (out.length >= need) break;
    const roll = rng();
    let list: CatalogItem[];
    let reason: string;
    if (cell.shore) {
      if (roll < 0.3 && pools.marks.length) {
        list = pools.marks;
        reason = "marking the channel";
      } else if (roll < 0.6 && pools.rocks.length) {
        list = pools.rocks;
        reason = "a rock off the shore";
      } else {
        list = pools.small;
        reason = "pulled up by the shore";
      }
    } else if (wantBig && !bigPlaced && roll < 0.12) {
      list = pools.big;
      reason = "standing out to sea";
    } else if (roll < 0.25 && pools.marks.length) {
      list = pools.marks;
      reason = "a buoy on the swell";
    } else if (roll < 0.38 && pools.rocks.length) {
      list = pools.rocks;
      reason = "a rock breaking the surface";
    } else {
      list = pools.small;
      reason = "riding at anchor";
    }
    if (!list.length) continue;
    const item = list[Math.floor(rng() * list.length)];
    if (!board.claim(cell.col, cell.row, false, isWater, clearanceLots(item), item.kind)) continue;
    if (list === pools.big) bigPlaced = true;
    const rot = [0, 90, 180, 270][Math.floor(rng() * 4)];
    out.push({ item, col: cell.col, row: cell.row, ...(rot ? { rot } : {}), reason, zone: harborZone(cell.col, cell.row)?.id ?? "sea", role: "texture", phase: "environment" });
  }
  return out;
}
