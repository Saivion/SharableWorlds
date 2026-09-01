import type { PlatformMaterial } from "./types";

/**
 * Themes — material ecosystems, not textures.
 *
 * A theme declares what the WORLD is made of: a primary ground the island is
 * cut from, secondary/accent/rare patch materials with seeded distribution
 * ranges, a walk material, and the environmental boundary that frames the
 * scene (dense trees, standing stones…). The composer resolves a theme from
 * the prompt, the seed picks the exact shares and patch layout, and the
 * terrain painter turns it into intentional regions — never per-block noise.
 */

export type ThemeLayer = {
  m: PlatformMaterial;
  /** Fraction range of land cells this material may claim — seed picks. */
  share: [number, number];
};

export type BoundaryKind = "trees" | "stones" | "none";

export type ThemeSpec = {
  id: string;
  label: string;
  /** Prompt words that summon this theme. */
  vocab: string[];
  primary: PlatformMaterial;
  secondary: ThemeLayer[];
  accent: ThemeLayer[];
  rare: ThemeLayer[];
  pathMaterial: PlatformMaterial;
  /** Optional coast fringe material (a beach lip, a mud shore). */
  edgeMaterial?: PlatformMaterial;
  boundary: BoundaryKind;
  /** Catalog query the framing ring draws from. */
  boundaryQuery: string;
  /** Fraction of coast cells the boundary occupies — seed picks. */
  boundaryDensity: [number, number];
  /** Sparse inner-ring scatter (undergrowth, small rocks). */
  undergrowthQuery?: string;
};

export const THEMES: ThemeSpec[] = [
  {
    id: "grassland",
    label: "grassland",
    vocab: ["grassland", "meadow", "plains", "field", "village", "town", "farm"],
    primary: "grass",
    secondary: [
      { m: "grass-dark", share: [0.1, 0.2] },
      { m: "moss", share: [0.05, 0.12] },
    ],
    accent: [{ m: "dirt", share: [0.04, 0.1] }],
    rare: [{ m: "stone", share: [0.01, 0.04] }],
    pathMaterial: "dirt",
    boundary: "trees",
    boundaryQuery: "tree oak birch nature",
    boundaryDensity: [0.3, 0.5],
    undergrowthQuery: "plant bush flowers grass nature",
  },
  {
    id: "forest",
    label: "deep forest",
    vocab: ["forest", "woods", "woodland", "grove", "wilderness", "camp", "camping"],
    primary: "grass-dark",
    secondary: [
      { m: "moss", share: [0.14, 0.24] },
      { m: "dirt", share: [0.08, 0.16] },
    ],
    accent: [{ m: "grass", share: [0.05, 0.12] }],
    rare: [{ m: "stone-mossy", share: [0.01, 0.04] }],
    pathMaterial: "dirt",
    boundary: "trees",
    boundaryQuery: "tree pine oak forest nature",
    boundaryDensity: [0.6, 0.85],
    undergrowthQuery: "plant bush mushroom stump log rock nature",
  },
  {
    id: "autumn",
    label: "autumn forest",
    vocab: ["autumn", "fall", "harvest", "orchard"],
    primary: "grass-dry",
    secondary: [
      { m: "dirt", share: [0.12, 0.2] },
      { m: "grass", share: [0.06, 0.12] },
    ],
    accent: [{ m: "ember", share: [0.03, 0.08] }],
    rare: [{ m: "mud", share: [0.01, 0.04] }],
    pathMaterial: "dirt",
    boundary: "trees",
    boundaryQuery: "tree oak birch nature crops pumpkin",
    boundaryDensity: [0.5, 0.75],
    undergrowthQuery: "plant bush pumpkin crops nature",
  },
  {
    id: "spooky",
    label: "haunted ground",
    vocab: ["graveyard", "spooky", "haunted", "cemetery", "grave", "ghost", "halloween", "crypt"],
    primary: "stone-dark",
    secondary: [
      { m: "grass-dry", share: [0.12, 0.22] },
      { m: "dirt", share: [0.08, 0.15] },
    ],
    accent: [{ m: "shadow-purple", share: [0.05, 0.12] }],
    rare: [{ m: "stone-mossy", share: [0.02, 0.05] }],
    pathMaterial: "cobble",
    boundary: "trees",
    boundaryQuery: "tree dead pine forest nature",
    boundaryDensity: [0.45, 0.7],
    undergrowthQuery: "rock stone banner column dungeon",
  },
  {
    id: "garden",
    label: "spring garden",
    vocab: ["spring", "garden", "park", "bloom", "flower", "fairy", "picnic"],
    primary: "grass",
    secondary: [
      { m: "moss", share: [0.1, 0.18] },
      { m: "grass-dark", share: [0.06, 0.12] },
    ],
    accent: [{ m: "candy-cream", share: [0.02, 0.06] }],
    rare: [{ m: "dirt", share: [0.02, 0.05] }],
    pathMaterial: "cobble",
    boundary: "trees",
    boundaryQuery: "tree flowers nature plant",
    boundaryDensity: [0.35, 0.55],
    undergrowthQuery: "flowers plant bush nature",
  },
  {
    id: "swamp",
    label: "swamp",
    vocab: ["swamp", "marsh", "bog", "bayou", "murky"],
    primary: "mud",
    secondary: [
      { m: "moss", share: [0.15, 0.25] },
      { m: "grass-dark", share: [0.08, 0.16] },
    ],
    accent: [{ m: "grass-dry", share: [0.04, 0.1] }],
    rare: [{ m: "stone-mossy", share: [0.01, 0.04] }],
    pathMaterial: "wood",
    boundary: "trees",
    boundaryQuery: "tree willow dead nature log stump",
    boundaryDensity: [0.5, 0.75],
    undergrowthQuery: "mushroom plant log rock nature",
  },
  {
    id: "desert",
    label: "desert",
    vocab: ["desert", "dune", "oasis", "canyon", "wasteland", "arid"],
    primary: "sand",
    secondary: [
      { m: "sand-dark", share: [0.12, 0.22] },
      { m: "earth-cracked", share: [0.08, 0.16] },
    ],
    accent: [{ m: "stone", share: [0.04, 0.1] }],
    rare: [{ m: "dirt", share: [0.01, 0.04] }],
    pathMaterial: "earth-cracked",
    boundary: "stones",
    boundaryQuery: "rock stone cactus nature",
    boundaryDensity: [0.25, 0.45],
    undergrowthQuery: "rock cactus nature",
  },
  {
    id: "beach",
    label: "beach",
    vocab: ["beach", "shore", "coast", "tropical", "lagoon"],
    primary: "sand",
    secondary: [
      { m: "grass", share: [0.1, 0.18] },
      { m: "sand-dark", share: [0.06, 0.12] },
    ],
    accent: [{ m: "wood", share: [0.03, 0.08] }],
    rare: [{ m: "stone", share: [0.01, 0.03] }],
    pathMaterial: "wood",
    edgeMaterial: "sand-dark",
    boundary: "trees",
    boundaryQuery: "palm tree nature",
    boundaryDensity: [0.25, 0.45],
    undergrowthQuery: "rock plant nature",
  },
  {
    id: "pirate-isle",
    label: "pirate island",
    vocab: ["pirate", "treasure", "buccaneer", "cove", "island"],
    primary: "sand",
    secondary: [
      { m: "grass", share: [0.12, 0.2] },
      { m: "sand-dark", share: [0.08, 0.14] },
    ],
    accent: [{ m: "dirt", share: [0.03, 0.08] }],
    rare: [{ m: "stone-mossy", share: [0.01, 0.04] }],
    pathMaterial: "wood",
    edgeMaterial: "sand-dark",
    boundary: "trees",
    boundaryQuery: "palm tree pirate nature rock",
    boundaryDensity: [0.3, 0.5],
    undergrowthQuery: "rock barrel crate pirate",
  },
  {
    id: "snow",
    label: "snowfield",
    vocab: ["snow", "winter", "ice", "frozen", "arctic", "tundra", "christmas"],
    primary: "snow",
    secondary: [
      { m: "ice", share: [0.1, 0.2] },
      { m: "stone", share: [0.05, 0.12] },
    ],
    accent: [{ m: "grass-dark", share: [0.02, 0.06] }],
    rare: [{ m: "stone-dark", share: [0.01, 0.03] }],
    pathMaterial: "stone",
    boundary: "trees",
    boundaryQuery: "tree pine nature",
    boundaryDensity: [0.4, 0.65],
    undergrowthQuery: "rock tree pine nature",
  },
  {
    id: "volcanic",
    label: "volcanic ground",
    vocab: ["volcano", "volcanic", "lava", "magma", "inferno", "scorched"],
    primary: "rock-dark",
    secondary: [
      { m: "ash", share: [0.15, 0.25] },
      { m: "stone-dark", share: [0.08, 0.15] },
    ],
    accent: [{ m: "ember", share: [0.05, 0.12] }],
    rare: [{ m: "earth-cracked", share: [0.01, 0.04] }],
    pathMaterial: "ash",
    boundary: "stones",
    boundaryQuery: "rock stone cave nature",
    boundaryDensity: [0.35, 0.55],
    undergrowthQuery: "rock cave stone",
  },
  {
    id: "candy",
    label: "candy land",
    vocab: ["candy", "sweet", "dessert", "sugar", "cake", "gingerbread", "chocolate"],
    primary: "candy-cream",
    secondary: [
      { m: "candy-pink", share: [0.14, 0.24] },
      { m: "candy-mint", share: [0.08, 0.16] },
    ],
    accent: [{ m: "candy-lilac", share: [0.05, 0.12] }],
    rare: [{ m: "snow", share: [0.01, 0.04] }],
    pathMaterial: "candy-pink",
    boundary: "trees",
    boundaryQuery: "food cake donut cupcake candy dessert",
    boundaryDensity: [0.3, 0.5],
    undergrowthQuery: "food candy donut cupcake",
  },
  {
    id: "courtyard",
    label: "castle courtyard",
    vocab: ["castle", "courtyard", "medieval", "kingdom", "fortress", "keep", "knight"],
    primary: "cobble",
    secondary: [
      { m: "stone", share: [0.12, 0.22] },
      { m: "stone-dark", share: [0.06, 0.12] },
    ],
    accent: [{ m: "stone-mossy", share: [0.04, 0.1] }],
    rare: [{ m: "grass", share: [0.02, 0.05] }],
    pathMaterial: "stone",
    boundary: "stones",
    boundaryQuery: "column statue banner arena wall dungeon",
    boundaryDensity: [0.3, 0.5],
    undergrowthQuery: "barrel crate banner torch dungeon",
  },
  {
    id: "dungeon",
    label: "dungeon floor",
    vocab: ["dungeon", "lair", "cavern", "underground", "cave", "crypt", "mine"],
    primary: "stone-dark",
    secondary: [
      { m: "rock-dark", share: [0.12, 0.2] },
      { m: "cobble", share: [0.06, 0.14] },
    ],
    accent: [{ m: "stone-mossy", share: [0.04, 0.1] }],
    rare: [{ m: "shadow-purple", share: [0.01, 0.05] }],
    pathMaterial: "cobble",
    boundary: "stones",
    boundaryQuery: "rock stone cave column dungeon",
    boundaryDensity: [0.4, 0.6],
    undergrowthQuery: "barrel chest pot rock dungeon",
  },
  {
    id: "station",
    label: "off-world station",
    vocab: ["space", "alien", "scifi", "station", "moon", "mars", "galaxy", "futuristic", "cyber"],
    primary: "tile",
    secondary: [
      { m: "stone-dark", share: [0.1, 0.18] },
      { m: "ice", share: [0.05, 0.12] },
    ],
    accent: [{ m: "shadow-purple", share: [0.04, 0.1] }],
    rare: [{ m: "ember", share: [0.01, 0.03] }],
    pathMaterial: "stone",
    boundary: "stones",
    boundaryQuery: "rock crater space cave stone",
    boundaryDensity: [0.25, 0.45],
    undergrowthQuery: "rock space crate machine",
  },
  {
    id: "toybox",
    label: "toy world",
    vocab: ["toy", "playroom", "arcade", "game", "racetrack", "playground"],
    primary: "tile",
    secondary: [
      { m: "candy-mint", share: [0.1, 0.18] },
      { m: "candy-cream", share: [0.06, 0.12] },
    ],
    accent: [{ m: "candy-pink", share: [0.03, 0.08] }],
    rare: [{ m: "candy-lilac", share: [0.01, 0.04] }],
    pathMaterial: "road",
    boundary: "stones",
    boundaryQuery: "cone block target flag prototype toycar",
    boundaryDensity: [0.25, 0.4],
    undergrowthQuery: "cone item block toycar prototype",
  },
  {
    id: "mycel",
    label: "mushroom forest",
    vocab: ["mushroom", "fungus", "spore", "toadstool", "enchanted"],
    primary: "grass-dark",
    secondary: [
      { m: "moss", share: [0.14, 0.24] },
      { m: "shadow-purple", share: [0.06, 0.12] },
    ],
    accent: [{ m: "candy-lilac", share: [0.03, 0.08] }],
    rare: [{ m: "mud", share: [0.01, 0.04] }],
    pathMaterial: "dirt",
    boundary: "trees",
    boundaryQuery: "mushroom tree nature plant",
    boundaryDensity: [0.5, 0.75],
    undergrowthQuery: "mushroom plant bush nature",
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function themeById(id: string | undefined): ThemeSpec | null {
  return (id && BY_ID.get(id)) || null;
}

/** Fallback theme per structural base material, when the prompt names none. */
const MATERIAL_FALLBACK: Partial<Record<PlatformMaterial, string>> = {
  grass: "grassland",
  sand: "beach",
  stone: "courtyard",
  tile: "station",
  wood: "grassland",
  road: "toybox",
};

/**
 * Resolve the theme a prompt is asking for: strongest vocabulary match wins;
 * otherwise fall back from the structural base material the selection implied.
 */
export function resolveTheme(prompt: string, fallbackMaterial: PlatformMaterial): ThemeSpec {
  const tokens = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .flatMap((w) => (w.length > 3 && w.endsWith("s") ? [w, w.slice(0, -1)] : [w])),
  );
  let best: ThemeSpec | null = null;
  let bestScore = 0;
  for (const theme of THEMES) {
    let score = 0;
    for (const word of theme.vocab) {
      if (tokens.has(word)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  if (best) return best;
  return BY_ID.get(MATERIAL_FALLBACK[fallbackMaterial] ?? "grassland") ?? THEMES[0];
}
