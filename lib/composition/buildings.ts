import type { LotRect } from "./grid3d";
import type { ThemeSpec } from "./themes";
import type { EnvironmentSpec, PlatformMaterial, PlatformSpec, StairSpec, WallSpec, WallSide, ZoneType } from "./types";

/**
 * Buildings — every raised room is a seeded DESIGN, not the same terrace.
 *
 * A building is a level-one floor with walls on some of its four sides: two
 * back walls (the classic open corner), three walls with the stair side
 * open, a hall with a doorway cut into its back wall, a walled floor with
 * low parapets on the camera side, or a single wall with a parapet. Wall
 * height, the wall palette (plaster, stone, timber, whitewash, brick, dark
 * stone, candy, steel — filtered by theme), the floor material, and an
 * inset inner floor all come from the seed. The stair always lands on an
 * open (or parapet-with-gap) side, so every room stays reachable, and the
 * furnishing rules read the walls back to put heavy pieces against them.
 */

export type BuildingStyle = "corner" | "three" | "hall" | "parapet" | "open";

export type BuildingPlan = {
  style: BuildingStyle;
  platforms: PlatformSpec[];
  walls: WallSpec[];
  stair: StairSpec;
  /** Sides that carry a full-height wall. */
  walled: WallSide[];
  height: number;
  palette: string;
};

type Palette = { id: string; body: string; cap: string; themes?: string[] };

const PALETTES: Palette[] = [
  { id: "plaster", body: "#e4dccb", cap: "#b9a98d" },
  { id: "whitewash", body: "#f0ece2", cap: "#c9c2b0" },
  { id: "timber", body: "#c9a674", cap: "#8d6b3f" },
  { id: "stone", body: "#b8b4aa", cap: "#8d877a" },
  { id: "brick", body: "#b8705c", cap: "#7f4a3a" },
  { id: "dark-stone", body: "#6f6d72", cap: "#4a484d", themes: ["spooky", "dungeon", "volcanic", "courtyard"] },
  { id: "steel", body: "#9aa4ad", cap: "#6f7a84", themes: ["station", "industrial"] },
  { id: "candy", body: "#f6c8dc", cap: "#d891b3", themes: ["candy", "toybox"] },
  { id: "sandstone", body: "#e2c9a0", cap: "#b8945f", themes: ["desert", "beach", "pirate-isle"] },
  { id: "snowcap", body: "#dfe6ec", cap: "#a9b6c2", themes: ["snow"] },
];

const THEME_PALETTES: Record<string, string[]> = {
  spooky: ["dark-stone", "stone", "brick"],
  dungeon: ["dark-stone", "stone"],
  courtyard: ["stone", "dark-stone", "brick", "plaster"],
  station: ["steel", "whitewash"],
  industrial: ["steel", "brick", "stone"],
  candy: ["candy", "whitewash"],
  toybox: ["candy", "whitewash", "brick"],
  desert: ["sandstone", "plaster", "whitewash"],
  beach: ["sandstone", "whitewash", "timber"],
  "pirate-isle": ["timber", "sandstone", "stone"],
  snow: ["snowcap", "timber", "stone"],
  forest: ["timber", "stone", "plaster"],
  autumn: ["timber", "brick", "plaster"],
  swamp: ["timber", "dark-stone", "stone"],
  volcanic: ["dark-stone", "stone"],
};

const FLOORS: Partial<Record<ZoneType, PlatformMaterial[]>> = {
  home: ["wood", "tile", "wood", "terracotta", "candy-cream"],
  arcade: ["tile", "stone-dark", "tile", "candy-lilac"],
  keep: ["stone", "cobble", "stone-dark", "stone-mossy"],
  lab: ["tile", "ice", "stone-dark", "tile"],
};

const TRIMS: Partial<Record<ZoneType, PlatformMaterial[]>> = {
  home: ["terracotta", "moss", "candy-pink", "ochre", "grass-dry"],
  arcade: ["candy-pink", "shadow-purple", "candy-lilac", "ember"],
  keep: ["stone-dark", "ember", "moss", "shadow-purple"],
  lab: ["ice", "stone", "candy-mint"],
};

const STYLES: BuildingStyle[] = ["corner", "three", "hall", "parapet", "open", "corner", "three"];

const PARAPET_HEIGHT = 0.62;

function pick<T>(list: T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

/** WallSpec for one side of a rect. */
function wallOn(id: string, rect: LotRect, side: WallSide, height: number, palette: Palette, openings?: number[]): WallSpec {
  const base = { id, height, color: palette.body, cap: palette.cap, ...(openings?.length ? { openings } : {}) };
  switch (side) {
    case "n":
      return { ...base, c: rect.c0, r: rect.r0, len: rect.w, dir: "h", side: "n" };
    case "s":
      return { ...base, c: rect.c0, r: rect.r0 + rect.d - 1, len: rect.w, dir: "h", side: "s" };
    case "w":
      return { ...base, c: rect.c0, r: rect.r0, len: rect.d, dir: "v", side: "w" };
    default:
      return { ...base, c: rect.c0 + rect.w - 1, r: rect.r0, len: rect.d, dir: "v", side: "e" };
  }
}

const OPPOSITE: Record<WallSide, WallSide> = { n: "s", s: "n", e: "w", w: "e" };

/**
 * Design one building on `rect`. `onDeck` says which cells outside the rect
 * are ground the stair may land on. Deterministic in `rng`.
 */
export function planBuilding(opts: {
  id: string;
  type: ZoneType;
  rect: LotRect;
  onDeck: (col: number, row: number) => boolean;
  theme: ThemeSpec;
  rng: () => number;
}): BuildingPlan {
  const { id, type, rect, onDeck, theme, rng } = opts;
  const midC = rect.c0 + Math.floor(rect.w / 2);
  const midR = rect.r0 + Math.floor(rect.d / 2);
  // The stair prefers the camera-facing sides (south, east) so the room's
  // open face reads; a seeded coin decides which of the two comes first.
  const spots: { side: WallSide; at: { col: number; row: number }; dir: WallSide }[] = [
    { side: "s", at: { col: midC, row: rect.r0 + rect.d }, dir: "n" },
    { side: "e", at: { col: rect.c0 + rect.w, row: midR }, dir: "w" },
    { side: "n", at: { col: midC, row: rect.r0 - 1 }, dir: "s" },
    { side: "w", at: { col: rect.c0 - 1, row: midR }, dir: "e" },
  ];
  if (rng() < 0.5) [spots[0], spots[1]] = [spots[1], spots[0]];
  const stairSpot = spots.find((s) => onDeck(s.at.col, s.at.row)) ?? spots[0];
  const stairSide = stairSpot.side;
  const stair: StairSpec = { id: `${id}-stair`, at: stairSpot.at, dir: stairSpot.dir, fromLevel: 0, toLevel: 1 };

  const style = pick(STYLES, rng);
  const names = THEME_PALETTES[theme.id] ?? ["plaster", "whitewash", "timber", "stone", "brick"];
  const palette = PALETTES.find((p) => p.id === pick(names, rng)) ?? PALETTES[0];
  const baseHeight = { corner: 1.9, three: 2.0, hall: 2.45, parapet: 1.8, open: 1.7 }[style];
  const height = Math.round(baseHeight * (0.92 + rng() * 0.2) * 100) / 100;

  // Back sides: the two sides away from the stair, north/west favoured so
  // the open corner faces the camera; never the stair side itself.
  const back: WallSide[] = (["n", "w", "s", "e"] as WallSide[]).filter((s) => s !== stairSide);
  const opposite = OPPOSITE[stairSide];
  const walled: WallSide[] = [];
  const parapets: WallSide[] = [];
  if (style === "corner") {
    walled.push(opposite, back.find((s) => s !== opposite && (s === "n" || s === "w")) ?? back.find((s) => s !== opposite)!);
  } else if (style === "three" || style === "hall") {
    walled.push(...back);
  } else if (style === "parapet") {
    walled.push(opposite, back.find((s) => s !== opposite && (s === "n" || s === "w")) ?? back.find((s) => s !== opposite)!);
    parapets.push(...(["n", "w", "s", "e"] as WallSide[]).filter((s) => !walled.includes(s)));
  } else {
    walled.push(opposite);
    parapets.push(...back.filter((s) => s !== opposite));
  }

  const walls: WallSpec[] = [];
  for (const side of walled) {
    let openings: number[] | undefined;
    if (style === "hall" && side === opposite) {
      const len = side === "n" || side === "s" ? rect.w : rect.d;
      if (len >= 3) openings = [1 + Math.floor(rng() * (len - 2))];
    }
    walls.push(wallOn(`${id}-wall-${side}`, rect, side, height, palette, openings));
  }
  for (const side of parapets) {
    let openings: number[] | undefined;
    if (side === stairSide) {
      openings = [side === "n" || side === "s" ? stair.at.col - rect.c0 : stair.at.row - rect.r0];
    }
    walls.push(wallOn(`${id}-parapet-${side}`, rect, side, PARAPET_HEIGHT, palette, openings));
  }

  const floors = FLOORS[type] ?? ["tile", "stone", "wood"];
  const floor = pick(floors, rng);
  const platforms: PlatformSpec[] = [{ id: `${id}-terrace`, rect, level: 1, material: floor }];
  if (rect.w >= 4 && rect.d >= 3 && rng() < 0.55) {
    const trims = (TRIMS[type] ?? ["moss", "terracotta"]).filter((m) => m !== floor);
    platforms.push({ id: `${id}-floor-inner`, rect: { c0: rect.c0 + 1, r0: rect.r0 + 1, w: rect.w - 2, d: rect.d - 2 }, level: 1, material: pick(trims, rng), inset: true });
  }
  // Walls rise in the same blocks as the terrace they stand on.
  return { style, platforms, walls: walls.map((w) => ({ ...w, material: floor })), stair, walled, height, palette: palette.id };
}

/** Which sides of `rect` carry a full-height wall in `env` (parapets don't count). */
export function walledSides(env: EnvironmentSpec, rect: LotRect): WallSide[] {
  const out: WallSide[] = [];
  for (const w of env.walls) {
    if (w.height < 1) continue;
    const horizontal = w.dir === "h";
    const matches = horizontal
      ? w.c === rect.c0 && w.len === rect.w && (w.side === "n" ? w.r === rect.r0 : w.r === rect.r0 + rect.d - 1)
      : w.r === rect.r0 && w.len === rect.d && (w.side === "w" ? w.c === rect.c0 : w.c === rect.c0 + rect.w - 1);
    if (matches && !out.includes(w.side)) out.push(w.side);
  }
  return out;
}
