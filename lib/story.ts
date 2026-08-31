import type { CatalogKind } from "./catalog";
import type { Owner, Piece, StoryEvent } from "./types";

/**
 * Turns the build log into an actual narrated recap — deterministic,
 * template-based prose, not a bullet log and not an LLM call (this app has
 * no server/LLM in the loop; `tell_story` and the Notch both call this
 * directly in the browser). Called "when called upon": a person clicking the
 * Notch, or a connected WebMCP host calling the `tell_story` tool to relay a
 * recap to the human in its own chat.
 *
 * Design notes (why it works this way):
 * - A goal commit is a hard chapter cut. Each chapter replays its own events
 *   into a local registry, so a chapter that's since been wiped by a new
 *   Nudge can still be narrated correctly — nothing here depends on live
 *   `pieces` except for the final (current) chapter's closing summary.
 * - Selection is a seeded shuffle-and-cursor per template pool, not
 *   Math.random(): the same log always renders the same story, and no
 *   variant repeats until the whole pool has been used once.
 * - Catalog labels are raw, sentence-cased filenames ("Ship pirate large")
 *   and are not prose-ready. A curated table covers the ids the agent
 *   actually reaches for (plan_scene's pools); anything else falls back to a
 *   naive but safe reordering.
 */

export type Story = { title: string; paragraphs: string[] };

// ---------------------------------------------------------------------------
// Lot decoding — self-contained copy of town.ts's parseLot/lotId, so this
// module has no dependency on the placement engine.
// ---------------------------------------------------------------------------

function decodeLot(lot: string | undefined): { col: number; row: number } | null {
  if (!lot) return null;
  const text = lot.trim().toUpperCase();
  const cr = /^C(-?\d+)R(-?\d+)$/.exec(text);
  if (cr) return { col: Number(cr[1]), row: Number(cr[2]) };
  const m = /^([A-Z]+)(\d+)$/.exec(text);
  if (!m) return null;
  let col = 0;
  for (let i = 0; i < m[1].length; i += 1) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

// ---------------------------------------------------------------------------
// Deterministic, no-repeat-until-exhausted template selection.
// ---------------------------------------------------------------------------

function seedFrom(events: StoryEvent[]): number {
  const raw = `${events.length}:${events[0]?.t ?? 0}:${events.at(-1)?.t ?? 0}`;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return h >>> 0;
}

function seededShuffle<T>(pool: readonly T[], seed: number): T[] {
  const arr = [...pool];
  let s = seed || 1;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makePicker<T>(pool: readonly T[], seed: number) {
  let order = seededShuffle(pool, seed);
  let i = 0;
  return (): T => {
    if (i >= order.length) {
      order = seededShuffle(pool, seed + order.length + i);
      i = 0;
    }
    return order[i++];
  };
}

/** One picker per named pool, all seeded off the same log so re-rendering an
 * unchanged log is byte-identical and a changed log reliably reshuffles.
 * Pickers are CACHED per name — a fresh picker per call would reset the
 * cursor to 0 and repeat one variant forever instead of cycling the pool. */
function makePickers(baseSeed: number) {
  const cache = new Map<string, () => unknown>();
  let saltCounter = 0;
  const of = <T>(name: string, pool: readonly T[]) => {
    let picker = cache.get(name);
    if (!picker) {
      saltCounter += 97;
      picker = makePicker(pool, baseSeed + saltCounter) as () => unknown;
      cache.set(name, picker);
    }
    return picker as () => T;
  };
  return { of };
}

// ---------------------------------------------------------------------------
// Humanization — catalog id/label -> narrative noun.
// ---------------------------------------------------------------------------

const NOUN_OVERRIDES: Record<string, string> = {
  "arcade-air-hockey": "an air hockey table",
  "arcade-arcade-machine": "an arcade machine",
  "arcade-character-gamer": "a gamer",
  "arcade-claw-machine": "a claw machine",
  "arcade-pinball": "a pinball machine",
  "arcade-prize-wheel": "a prize wheel",
  "arena-banner": "a banner",
  "arena-character-soldier": "a soldier",
  "arena-statue": "a statue",
  "arena-trophy": "a trophy",
  "arena-wall-gate": "an arena gate",
  "arena-weapon-rack": "a weapon rack",
  "car-delivery": "a delivery van",
  "car-police": "a police car",
  "car-sedan": "a sedan",
  "car-suv": "an SUV",
  "car-taxi": "a taxi",
  "car-van": "a van",
  "characters-wheelchair": "a wheelchair",
  "dungeon-banner": "a banner",
  "dungeon-barrel": "a barrel",
  "dungeon-character-orc": "an orc",
  "dungeon-chest": "a chest",
  "dungeon-column": "a column",
  "dungeon-gate": "a gate",
  "forest-character-archer": "an archer",
  "forest-plant": "a plant",
  "forest-rocks-high": "a rock formation",
  "forest-tent": "a tent",
  "forest-tree": "a tree",
  "forest-tree-high": "a tall tree",
  "market-cash-register": "a cash register",
  "market-character-employee": "a shopkeeper",
  "market-display-bread": "a bread display",
  "market-display-fruit": "a fruit display",
  "market-shelf-bags": "a shelf of bags",
  "market-shopping-cart": "a shopping cart",
  "pirate-barrel": "a barrel",
  "pirate-boat-row-small": "a rowboat",
  "pirate-chest": "a treasure chest",
  "pirate-palm-straight": "a palm tree",
  "pirate-ship-pirate-large": "a large pirate ship",
  "pirate-ship-pirate-small": "a small pirate ship",
  "pirate-structure-platform-dock": "a dock platform",
  "pirate-tower-watch": "a watchtower",
  "skate-bowl-side": "a skate bowl",
  "skate-character-skate-boy": "a skater",
  "skate-half-pipe": "a half-pipe",
  "skate-obstacle-box": "a skate box",
  "skate-rail-low": "a low rail",
  "watercraft-boat-fishing-small": "a fishing boat",
  "watercraft-boat-row-small": "a rowboat",
  "watercraft-boat-sail-a": "a sailboat",
  "watercraft-boat-tug-a": "a tugboat",
  "watercraft-buoy": "a buoy",
  "watercraft-ship-small": "a small ship",
  // New kits — the iconic ids the planner reaches for most.
  "buildings-building-sample-house-a": "a gabled house",
  "buildings-building-sample-house-b": "a narrow two-story house",
  "buildings-building-sample-house-c": "a big family house",
  "buildings-building-sample-tower-a": "a small apartment block",
  "buildings-building-sample-tower-d": "a tall apartment tower",
  "cave-gate-metal-bars": "a barred cave gate",
  "cave-ladder": "a cave ladder",
  "cave-room-large": "a big cavern",
  "coaster-coaster-steel-looping": "a steel coaster loop",
  "coaster-coaster-train": "a coaster train",
  "coaster-park-entrance": "a park entrance gate",
  "coaster-ride-entrance": "a ride entrance",
  "coaster-station": "a ride station",
  "coaster-train-monorail": "a monorail train",
  "food-burger-cheese-double": "a double cheeseburger",
  "food-cake-birthday": "a birthday cake",
  "food-chinese": "a takeout box",
  "food-cup-coffee": "a cup of coffee",
  "food-donut-sprinkles": "a sprinkled donut",
  "food-hot-dog": "a hot dog",
  "food-ice-cream-cne": "an ice cream cone",
  "food-pizza": "a pizza",
  "food-sundae": "an ice cream sundae",
  "food-turkey": "a roast turkey",
  "furniture-bear": "a teddy bear",
  "furniture-bed-double": "a double bed",
  "furniture-kitchen-fridge-built-in": "a built-in fridge",
  "furniture-lamp-round-floor": "a round floor lamp",
  "furniture-lounge-sofa": "a lounge sofa",
  "furniture-table-coffee": "a coffee table",
  "furniture-television-vintage": "a vintage TV",
  "nature-bridge-wood": "a wooden bridge",
  "nature-campfire-logs": "a log campfire",
  "nature-canoe": "a canoe",
  "nature-cliff-waterfall-rock": "a waterfall cliff",
  "nature-cliff-waterfall-stone": "a waterfall cliff",
  "nature-statue-head": "a giant stone head",
  "nature-statue-obelisk": "an obelisk",
  "nature-statue-ring": "a stone ring monument",
  "nature-tent-detailed-open": "an open camp tent",
  "nature-tree-oak": "an oak tree",
  "pets-animal-cat": "a cat",
  "pets-animal-dog": "a dog",
  "pets-animal-fox": "a fox",
  "pets-animal-panda": "a panda",
  "pets-animal-penguin": "a penguin",
  "pets-animal-polar": "a polar bear",
  "prototype-animal-horse": "a horse",
  "prototype-crate-color": "a colored crate",
  "space-cables": "a bundle of cables",
  "space-corridor": "a station corridor",
  "space-gate-lasers": "a laser gate",
  "space-room-large": "a big station module",
  "survival-campfire-pit": "a fire pit",
  "survival-chest": "a supply chest",
  "survival-tent": "a bare tent frame",
  "survival-tent-canvas": "a canvas tent",
  "survival-workbench-anvil": "an anvil workbench",
  "toycar-gate-finish": "a finish-line gate",
  "toycar-track-narrow-looping": "a loop of toy track",
  "toycar-vehicle-monster-truck": "a monster truck",
  "toycar-vehicle-suv": "an SUV",
};

const GENERIC_CHARACTER = ["a character", "a passerby", "a figure", "a newcomer", "a second character"];

// ---------------------------------------------------------------------------
// fallbackNoun v2 — deterministic label -> prose-ready noun for any of the
// 1813 catalog ids outside the curated table. Ordered pipeline: normalize
// typos, strip variant tokens, apply family rules (tracks, animals, trees,
// themed modules, terrain, buildings, boats...), then a generic core that
// sorts adjectives ahead of the head noun. Pure string functions throughout.
// ---------------------------------------------------------------------------

const NORMALIZE: Record<string, string> = {
  advocado: "avocado", musterd: "mustard", chopstic: "chopstick", cne: "cone",
  rond: "round", darkh: "dark", wholer: "whole", lollypop: "lollipop",
  relax: "reclining", toilets: "toilet", television: "TV",
  vegetables: "vegetable", freezers: "freezer",
};

const VARIANT_TAIL = new Set(["variation", "detailed", "detail"]);

const ADJ_RANK: Record<string, number> = {};
for (const w of "small large low high tall short wide narrow long half double single medium thick thin upper deep".split(" ")) ADJ_RANK[w] = 0;
for (const w of "round rounded square flat diagonal open closed modern vintage old striped raw cooked broken crushed upgraded reclining standing sliding barred hanging stacked cushioned garage hot whipped sports luxury racing blue red purple yellow tan brown white bronze gold silver chocolate mint japanese built-in hollow triangular cutout whole decorative colored rectangular sprinkled futuristic damaged fortified packed cracked".split(" ")) ADJ_RANK[w] = 1;
ADJ_RANK.corner = 2;
for (const w of "wooden stone metal glass canvas cardboard steel sandy plank".split(" ")) ADJ_RANK[w] = 3;

const ADJECTIVIZE: Record<string, string> = {
  cushion: "cushioned", wood: "wooden", sand: "sandy", triangle: "triangular",
  planks: "plank", sprinkles: "sprinkled", color: "colored",
  rectangle: "rectangular", future: "futuristic", grind: "grinding",
};

const DROP_ANY = new Set("center middle side sides top bottom back front left right inner outer end edges default simple group section segment piece slide frame doors drawer drawers screws foliage complete beginning cross power deluxe basic rotate design chopping detailed detail variation grass ropes".split(" "));

const CONTEXT_HEADS = new Set(["item", "vehicle", "tool", "utensil", "shape", "kitchen", "bathroom", "plant", "weapon"]);
const OF_HEADS = new Set(["crate", "shelf", "stack"]);
const PAIR_SWAP: Record<string, string> = { stool: "bar", table: "coffee", cabinet: "TV" };
const FLIP_SECOND = new Set("ketchup mustard oil broth cereal soup stew coffee tea birthday baguette roe salmon vegetable sauerkraut pepper salt bread fruit cheese finish police anvil grinding".split(" "));
const FLIP_PAIRS: Record<string, string> = { wheel: "truck", plate: "dinner" };

const HEAD_NORMALIZE: Record<string, string> = {
  stairs: "staircase", books: "stack of books", cherries: "bunch of cherries",
  grapes: "bunch of grapes", fries: "serving of fries", pancakes: "stack of pancakes",
  cables: "bundle of cables", flowers: "clump of flowers", smoke: "puff of smoke",
  trash: "trash bin", paneling: "panel", chinese: "takeout box", honey: "honey jar",
  moss: "curtain of moss", styrofoam: "styrofoam box", soy: "soy bottle",
};

const COASTER_STYLE: Record<string, string> = {
  flume: "log flume track", monorail: "monorail track", mouse: "wild mouse coaster track",
  steel: "steel coaster track", wood: "wooden coaster track", hanging: "hanging coaster track",
};

const CROP_NOUN: Record<string, string> = {
  corn: "corn", wheat: "wheat", bamboo: "bamboo", carrot: "carrots", carrots: "carrots",
  melon: "melons", melons: "melons", pumpkin: "pumpkins", pumpkins: "pumpkins",
  turnip: "turnips", turnips: "turnips", leafs: "leafy greens", leaf: "leafy greens",
};

const BOAT_COMPOUND: Record<string, string> = { row: "rowboat", sail: "sailboat", tug: "tugboat", wreck: "shipwreck" };

function articleFor(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

function geomPhrase(ts: Set<string>, trackNoun: string): string {
  if (ts.has("looping")) return articleFor(`loop of ${trackNoun}`);
  if (ts.has("corner") || ts.has("curve") || ts.has("bend")) return articleFor(`curving stretch of ${trackNoun}`);
  if (ts.has("cap")) return articleFor(`end cap of ${trackNoun}`);
  return articleFor(`stretch of ${trackNoun}`);
}

const SIZE_ADJ = (w: string) => ADJ_RANK[w] === 0;

/** Fallback for any id outside the curated table — never idiomatic, never a crash. */
function fallbackNoun(rawLabel: string, kind?: CatalogKind): string {
  let t = rawLabel.toLowerCase().split(" ").filter(Boolean).map((w) => NORMALIZE[w] ?? w);
  const keepDigits = t[0] === "number";
  const trimmed = t.filter((w) => !(w.length === 1 && /[a-z]/.test(w)) && !(/^\d+$/.test(w) && !keepDigits));
  if (trimmed.length) t = trimmed;
  while (t.length > 1 && VARIANT_TAIL.has(t[t.length - 1])) t.pop();
  const ts = new Set(t);

  // Coaster tracks and trains.
  if (t[0] === "coaster" && t[1] && COASTER_STYLE[t[1]]) return geomPhrase(ts, COASTER_STYLE[t[1]]);
  if (t[0] === "coaster" && t[1] === "train") return "a coaster train";
  if (t[0] === "train" && t[1]) return articleFor(`${t[1]} train`);
  // Toy-car tracks and their supports.
  if (t[0] === "track") {
    const noun = ts.has("striped") ? "striped track" : ts.has("road") ? "road track" : "toy track";
    return geomPhrase(ts, noun);
  }
  if (t[0] === "support" || t[0] === "supports") return "a support pillar";
  // Animals.
  if (t[0] === "animal" && t[1]) return articleFor(t[1] === "polar" ? "polar bear" : t.slice(1).join(" "));
  // Trees.
  if (kind === "tree") {
    const rest = t.filter((w) => w !== "tree");
    if (rest.includes("trunk")) return "a tree trunk";
    if (rest.includes("log")) return rest.includes("small") ? "a small log" : "a fallen log";
    const species = rest.find((w) => w === "pine" || w === "oak" || w === "palm");
    const TREE_ADJ: Record<string, string> = { fall: "autumn", fat: "squat", cone: "conical", blocks: "blocky", plateau: "flat-topped", bend: "bent", dark: "dark", tall: "tall", small: "small", short: "short", thin: "thin", round: "round" };
    const adjs = rest.filter((w) => w !== species && TREE_ADJ[w]).map((w) => TREE_ADJ[w]);
    const sized = [...adjs.filter((w) => ["small", "tall", "short", "thin"].includes(w)), ...adjs.filter((w) => !["small", "tall", "short", "thin"].includes(w))];
    return articleFor([...sized, species ? `${species} tree` : "tree"].join(" "));
  }
  // Themed interior modules — cave, space station, dungeon.
  if (kind === "cave" || kind === "space" || kind === "dungeon") {
    const theme = kind === "cave" ? "cave" : kind === "space" ? "station" : "dungeon";
    if (t[0] === "corridor") return articleFor(`${theme} corridor`);
    if (t[0] === "room") return articleFor(`${theme} room`);
    if (t[0] === "gate") return articleFor(`${theme} gate`);
    if (t[0] === "stairs") return `a flight of ${theme} stairs`;
    if (t[0] === "template") {
      if (ts.has("floor")) return `a slab of ${theme} floor`;
      if (ts.has("wall")) return articleFor(`${theme} wall`);
      return articleFor(`${theme} block`);
    }
  }
  // Terrain.
  if (kind === "nature") {
    if (t[0] === "cliff") {
      if (ts.has("waterfall")) return "a cliff waterfall";
      if (ts.has("steps")) return "a flight of cliff steps";
      return articleFor(`${ts.has("stone") ? "stone" : "rock"} cliff`);
    }
    if (t[0] === "ground") {
      if (ts.has("path")) return "a stretch of path";
      if (ts.has("river")) return "a stretch of river";
      if (ts.has("grass")) return "a patch of grass";
    }
    if (t[0] === "crop" || t[0] === "crops") {
      if (ts.has("dirt")) return "a row of tilled dirt";
      const crop = t.slice(1).map((w) => CROP_NOUN[w]).find(Boolean);
      return `a patch of ${crop ?? "crops"}`;
    }
    if (t[0] === "path") {
      if (ts.has("stone")) return "a stone path piece";
      if (ts.has("wood")) return "a wooden path piece";
      return "a stretch of park path";
    }
    if (t[0] === "patch" && t[1]) return `a patch of ${t[1]}`;
    if (t[0] === "grass") return "a tuft of grass";
    if (t[0] === "rocks") return articleFor(`cluster of ${ts.has("sand") || ts.has("sandy") ? "sandy " : ""}rocks`);
    if (t[0] === "mushroom") {
      const color = ts.has("red") ? "red" : ts.has("tan") ? "tan" : "";
      if (ts.has("group")) return `a cluster of ${color ? `${color} ` : ""}mushrooms`;
      if (ts.has("tall")) return `a tall ${color ? `${color} ` : ""}mushroom`;
      return articleFor(`${color ? `${color} ` : ""}mushroom`);
    }
    if (t[0] === "campfire") return "a campfire";
  }
  // Building facades and roofs.
  if (kind === "building") {
    if (t[0] === "building") {
      if (t[1] === "sample") return ts.has("house") ? "a small house" : "a small tower";
      if (ts.has("door")) return "a building front with a door";
      if (ts.has("window") || ts.has("windows")) return "a windowed building wall";
      if (ts.has("corner")) return "a building corner";
      if (ts.has("steps")) return "a set of building steps";
      return "a building block";
    }
    if (t[0] === "roof") {
      if (ts.has("gable") || ts.has("gables")) return "a gabled roof piece";
      if (ts.has("slanted")) return "a slanted roof piece";
      return "a flat roof piece";
    }
    if ((t[0] === "window" || t[0] === "door") && t[1]) {
      const color = t.find((w) => w === "brown" || w === "white");
      return articleFor(`${color ? `${color} ` : ""}${t[0]}`);
    }
    if (ts.has("ac")) return "an AC unit";
  }
  // Park props.
  if (t[0] === "queue") return "a stretch of queue line";
  if (t[0] === "stall" && t[1]) return articleFor(`${t[1]} stall`);
  // Small closed families.
  if (t[0] === "resource" && t[1]) return `a pile of ${t.slice(1).filter((w) => w !== "small" && w !== "large").join(" ") || t[1]}`;
  if (t[0] === "number") return `a number ${t.find((w) => /^\d+$/.test(w)) ?? ""}`.trim();
  if (t[0] === "indicator") return "a floor marker";
  if (t[0] === "button") return "a floor button";
  if (t[0] === "figurine") return "a figurine";
  if (t[0] === "aid" && t[1]) {
    if (t[1] === "glasses" || t[1] === "sunglasses") return `a pair of ${t[1]}`;
    if (t[1] === "hearing") return "a hearing aid";
  }
  if ((t[0] === "boat" || t[0] === "ship") && t.length > 1) {
    const rest = t.slice(1);
    const adjs = rest.filter(SIZE_ADJ);
    const core = rest.filter((w) => !SIZE_ADJ(w));
    let noun: string;
    if (core[0] === "ocean" && core[1] === "liner") noun = "ocean liner";
    else if (core[0] && BOAT_COMPOUND[core[0]]) noun = BOAT_COMPOUND[core[0]];
    else if (core.length) noun = `${core.join(" ")} ${t[0]}`;
    else noun = t[0];
    return articleFor([...adjs, noun].join(" "));
  }
  if (t[0] === "flag") {
    if (ts.has("pirate")) return "a pirate flag";
    if (ts.has("pennant")) return "a pennant";
    return "a flag";
  }
  if (t[0] === "structure") {
    if (ts.has("dock")) return "a dock platform";
    if (ts.has("platform")) return "a raised platform";
    if (ts.has("fence")) return "a rough fence";
    if (ts.has("metal")) {
      const part = t.find((w) => ["doorway", "floor", "roof", "wall"].includes(w));
      return part ? `a metal ${part}` : "a metal shelter";
    }
    if (ts.has("canvas")) return "a canvas shelter";
    if (ts.has("roof")) return "a shelter roof";
    if (ts.has("floor")) return "a shelter floor";
    return "a rough shelter";
  }
  if (t[0] === "tower" && t[1]) {
    if (t[1] === "complete") return "a whole tower";
    if (t[1] === "middle") return "a tower midsection";
    return articleFor(`tower ${t[1]}`);
  }
  if (t[0] === "lamp") {
    const shape = t.find((w) => w === "round" || w === "square");
    const mount = t.find((w) => ["floor", "table", "ceiling", "wall"].includes(w));
    return articleFor([shape, mount, "lamp"].filter(Boolean).join(" "));
  }
  if (t[0] === "hat") return ts.has("hard") ? "a hard hat" : "a cap";
  if (t[0] === "kart") return "a go-kart";
  if (t[0] === "debris") return "a piece of debris";

  // Generic core.
  if (t.length > 1 && CONTEXT_HEADS.has(t[0]) && t.slice(1).some((w) => !((ADJECTIVIZE[w] ?? w) in ADJ_RANK))) t = t.slice(1);
  t = t.join(" ").replace("built in", "built-in").replace("ginger bread", "gingerbread").split(" ");
  t = t.map((w) => ADJECTIVIZE[w] ?? w);
  if (t.length >= 2 && PAIR_SWAP[t[0]] === t[1]) t = [t[1], t[0], ...t.slice(2)];
  if (t.length === 2 && t[0] === "cup" && t[1] === "saucer") return "a cup and saucer";
  if (t.length === 2 && OF_HEADS.has(t[0]) && /s$/.test(t[1]) && !(t[1] in ADJ_RANK)) return `a ${t[0]} of ${t[1]}`;
  if (t.length === 2 && (FLIP_SECOND.has(t[1]) || FLIP_PAIRS[t[0]] === t[1])) t = [t[1], t[0]];
  const adjs = t.slice(1).filter((w) => w in ADJ_RANK).sort((a, b) => ADJ_RANK[a] - ADJ_RANK[b]);
  let others = [t[0], ...t.slice(1).filter((w) => !(w in ADJ_RANK) && !DROP_ANY.has(w))];
  if (DROP_ANY.has(t[0]) && others.length > 1) others = others.slice(1);
  if (others.length === 1) others = [HEAD_NORMALIZE[others[0]] ?? others[0]];
  return articleFor([...adjs, ...others].join(" ") || "piece");
}

const COLOR_NAMES: Record<string, string> = {
  "#ff005c": "hot pink",
  "#4db8ff": "sky blue",
  "#7c5cff": "violet",
  "#00c2a8": "teal",
};

function colorWord(hex: string | undefined): string | null {
  if (!hex) return null;
  return COLOR_NAMES[hex] ?? null;
}

// ---------------------------------------------------------------------------
// Chapter grouping.
// ---------------------------------------------------------------------------

type Chapter = { goal: string | null; wipedCount: number | null; events: StoryEvent[] };

function splitChapters(events: StoryEvent[]): Chapter[] {
  const chapters: Chapter[] = [{ goal: null, wipedCount: null, events: [] }];
  for (const e of events) {
    if (e.verb === "goal") {
      const cleared = e.detail ? /cleared (\d+)/.exec(e.detail) : null;
      chapters.push({
        goal: e.goal ?? null,
        wipedCount: cleared ? Number(cleared[1]) || null : null,
        events: [],
      });
      continue;
    }
    chapters[chapters.length - 1].events.push(e);
  }
  return chapters.filter((c) => c.goal !== null || c.events.length > 0);
}

// ---------------------------------------------------------------------------
// Per-chapter replay registry — a wiped chapter still narrates itself
// correctly, since nothing here touches the live `pieces` map except for
// resolving the final chapter's closing summary.
// ---------------------------------------------------------------------------

type Ghost = { catalogId: string; kind: CatalogKind; lot: string; label: string; color?: string; owner: Owner; zone?: string };

function replayChapter(events: StoryEvent[]): Map<string, Ghost> {
  const reg = new Map<string, Ghost>();
  for (const e of events) {
    if (!e.pieceId) continue;
    switch (e.verb) {
      case "place":
        if (e.catalogId && e.kind && e.lot) {
          reg.set(e.pieceId, {
            catalogId: e.catalogId,
            kind: e.kind,
            lot: e.lot,
            label: "",
            owner: e.actor,
            // Zone reason (planner's "the centerpiece"...) rides `detail`.
            ...(e.detail ? { zone: e.detail } : {}),
          });
        }
        break;
      case "move": {
        const g = reg.get(e.pieceId);
        if (g && e.lot) g.lot = e.lot;
        break;
      }
      case "label": {
        const g = reg.get(e.pieceId);
        if (g) g.label = e.label ?? "";
        break;
      }
      case "paint": {
        const g = reg.get(e.pieceId);
        if (g) g.color = e.color;
        break;
      }
      case "remove":
        reg.delete(e.pieceId);
        break;
      default:
        break;
    }
  }
  return reg;
}

type CharacterNouns = { count: number; assigned: Map<Ghost, string> };

/**
 * A generic noun for an unnamed piece. Characters get a rotating pool so ten
 * unnamed characters don't all read as "a character" — but the SAME piece
 * must keep the SAME noun every time it's mentioned (as an anchor, a
 * blocker, etc.), not re-roll a new one per reference. Assignment is cached
 * per Ghost object identity, which is stable within one chapter's replay.
 */
function nounFor(g: Ghost, seen: CharacterNouns): string {
  if (g.kind !== "character") {
    // The kind reaches the fallback so family rules (animals, trees, themed
    // modules, terrain, buildings) can fire; "animal fox" -> "a fox".
    return NOUN_OVERRIDES[g.catalogId] ?? fallbackNoun(g.catalogId.split("-").slice(1).join(" "), g.kind);
  }
  const cached = seen.assigned.get(g);
  if (cached) return cached;
  const noun = GENERIC_CHARACTER[seen.count % GENERIC_CHARACTER.length];
  seen.count += 1;
  seen.assigned.set(g, noun);
  return noun;
}

/** The label a piece is called by right now — its name if it has one. */
function itemPhrase(g: Ghost, seen: CharacterNouns): string {
  return g.label ? g.label : nounFor(g, seen);
}

// ---------------------------------------------------------------------------
// Spatial language — hedged, relative only, never a coordinate.
// ---------------------------------------------------------------------------

function relate(dc: number, dr: number): string {
  if (dc !== 0 && dr !== 0) {
    return Math.abs(dc) + Math.abs(dr) <= 2 ? "right beside" : "off to the side of";
  }
  const axis = dc !== 0 ? (dc > 0 ? "east" : "west") : dr > 0 ? "south" : "north";
  const mag = Math.abs(dc || dr);
  if (mag <= 1) return `just ${axis} of`;
  if (mag <= 3) return `a couple lots ${axis} of`;
  return `well off to the ${axis}, relative to`;
}

function spreadPhrase(lots: string[], pick: <T>(name: string, pool: readonly T[]) => T): string {
  const pts = lots.map(decodeLot).filter((p): p is { col: number; row: number } => Boolean(p));
  if (pts.length < 2) return "";
  const cols = pts.map((p) => p.col);
  const rows = pts.map((p) => p.row);
  const w = Math.max(...cols) - Math.min(...cols);
  const h = Math.max(...rows) - Math.min(...rows);
  if (w <= 1 && h <= 1) return pick("spread-tight", ["clustered together", "shoulder to shoulder", "tucked into one corner"]);
  if (w <= 3 && h <= 3) return pick("spread-loose", ["gathered in one part of the board", "kept close", "grouped without crowding"]);
  return pick("spread-wide", ["spread out a bit", "given some room to breathe", "spread across the plot"]);
}

// ---------------------------------------------------------------------------
// Template pools (section numbers refer to the design spec).
// ---------------------------------------------------------------------------

/**
 * Every pool below shares one rule: all variants take the exact same
 * parameter list, and — where casing depends on sentence position — the
 * template receives the raw `actor: Owner` and calls `who()` itself, rather
 * than the caller pre-deciding "Who" vs "whoLower". That's what keeps every
 * variant grammatically correct regardless of which one the picker lands on.
 */

const COLD_OPEN = [
  (actor: Owner, item: string) => `Nothing here at first — then ${who(actor, false)} set down ${item}, and the scene had a start.`,
  (actor: Owner, item: string) => `It began with an open lot and one move: ${who(actor, true)} placed ${item}.`,
  (_actor: Owner, item: string) => `The board was empty right up until ${item} appeared.`,
  (actor: Owner, item: string) => `No plan yet, just ${who(actor, false)} and ${item} to start things off.`,
  (actor: Owner, item: string) => `Before anything else, ${who(actor, false)} placed ${item}, and the rest followed from there.`,
];

const PIVOT_OPEN = [
  (goal: string, wipe: string) => `Then the goal changed: ${goal}.${wipe}`,
  (goal: string, wipe: string) => `A new idea took over — ${goal}${wipe ? ` — and${wipe.replace(/^\.\s*/, " ")}` : "."}`,
  (goal: string, wipe: string) => `The plan shifted to ${goal}${wipe ? `, and${wipe.replace(/^\.\s*/, " ")}` : "."}`,
  (goal: string, wipe: string) => `Everything pointed one direction now: ${goal}.${wipe}`,
  (goal: string, wipe: string) => `There was a new brief: ${goal}.${wipe}`,
];

const WIPE_CLAUSE = [
  (n: number) => ` The old scene — ${n} piece${n === 1 ? "" : "s"} — cleared out to make room for it.`,
  (n: number) => ` ${n} piece${n === 1 ? "" : "s"} came down to make space for it.`,
  (n: number) => ` Everything that was there before, ${n} piece${n === 1 ? "" : "s"} worth, made way for it.`,
];

const PLACE_ONE = [
  (actor: Owner, item: string) => `${who(actor, true)} set down ${item}.`,
  (actor: Owner, item: string) => `${who(actor, true)} added ${item} to the scene.`,
  (actor: Owner, item: string) => `${who(actor, true)} dropped ${item} in.`,
  (actor: Owner, item: string) => `${who(actor, true)} planted ${item}.`,
];

const PLACE_ONE_ANCHORED = [
  (actor: Owner, item: string, rel: string, anchor: string) => `${who(actor, true)} placed ${item}, ${rel} ${anchor}.`,
  (actor: Owner, item: string, rel: string, anchor: string) => `${who(actor, true)} set ${item} down, ${rel} ${anchor}.`,
];

const PLACE_SAME_KIND = [
  (actor: Owner, n: number, kind: string, spread: string) => `${who(actor, true)} brought in ${n} more ${kind}, ${spread}.`,
  (actor: Owner, n: number, kind: string, spread: string) => `${who(actor, true)} filled the space with ${n} ${kind}, ${spread}.`,
  (actor: Owner, n: number, kind: string, spread: string) => `${who(actor, true)} lined up ${n} ${kind}, ${spread}.`,
  (actor: Owner, n: number, kind: string, spread: string) => `${who(actor, true)} added ${n} ${kind} in one go, ${spread}.`,
  (actor: Owner, n: number, kind: string, spread: string) => `${who(actor, true)} kept going with ${n} more ${kind}, ${spread}.`,
];

const PLACE_MIXED = [
  (actor: Owner, list: string, spread: string) => `${who(actor, true)} put down ${list}, ${spread}.`,
  (actor: Owner, list: string, spread: string) => `${who(actor, true)} built out ${list}, ${spread}.`,
  (actor: Owner, list: string, spread: string) => `${who(actor, true)} filled in ${list}, ${spread}.`,
  (actor: Owner, list: string, spread: string) => `In one stretch, ${who(actor, false)} added ${list}, ${spread}.`,
  (actor: Owner, list: string, spread: string) => `${who(actor, true)} moved fast: ${list}, ${spread}.`,
];

const MOVE_BEAT = [
  (actor: Owner, item: string, axis: string) => `${who(actor, true)} moved ${item} a little further ${axis}.`,
  (actor: Owner, item: string, axis: string) => `${capFirst(item)} ended up ${axis}, ${who(actor, false)} having moved it there.`,
  (actor: Owner, item: string, axis: string) => `${who(actor, true)} slid ${item} over, toward the ${axis}.`,
];

const PAINT_BEAT_KNOWN = [
  (actor: Owner, item: string, color: string) => `${who(actor, true)} gave ${item} a coat of ${color}.`,
  (actor: Owner, item: string, color: string) => `${capFirst(item)} got painted ${color}.`,
  (actor: Owner, item: string, color: string) => `${who(actor, true)} marked ${item} ${color} — claimed.`,
];

const PAINT_BEAT_UNKNOWN = [
  (actor: Owner, item: string) => `${who(actor, true)} painted ${item}, making it theirs.`,
  (_actor: Owner, item: string) => `${capFirst(item)} got a fresh coat of color.`,
];

const CUSTOMIZE_KNOWN = [
  (actor: Owner, item: string, color: string, name: string) => `${who(actor, true)} gave ${item} a coat of ${color} and a name: ${name}.`,
  (_actor: Owner, item: string, color: string, name: string) => `${capFirst(item)} came away ${color} and newly named ${name}.`,
  (actor: Owner, item: string, color: string, name: string) => `${who(actor, true)} claimed ${item} — ${color}, and called it ${name} from then on.`,
];

const CUSTOMIZE_UNKNOWN = [
  (actor: Owner, item: string, _color: string, name: string) => `${who(actor, true)} gave ${item} a name, ${name}, and made it theirs.`,
];

const REMOVE_BEAT = [
  (actor: Owner, item: string) => `${who(actor, true)} took ${item} back out.`,
  (actor: Owner, item: string) => `${capFirst(item)} didn't last — ${who(actor, false)} pulled it.`,
  (actor: Owner, item: string) => `${who(actor, true)} changed course and removed ${item}.`,
  (_actor: Owner, item: string) => `${capFirst(item)} came back off the board.`,
];

const RESPECT_NAMED = [
  (actor: Owner, blocker: string, lot: string, newLot: string) =>
    `${capFirst(blocker)} was already sitting at ${lot}, so ${who(actor, false)} left it alone and set the next piece down at ${newLot} instead.`,
  (actor: Owner, blocker: string, lot: string) => `There was no getting past ${blocker} at ${lot} — ${who(actor, false)} built around it instead.`,
  (actor: Owner, blocker: string, lot: string) => `${capFirst(blocker)} had already claimed ${lot}. ${who(actor, true)} noticed, and worked around it rather than through it.`,
  (actor: Owner, blocker: string, lot: string) => `${who(actor, true)} reached toward ${lot} and found ${blocker} there first, so it went elsewhere.`,
];

const RESPECT_AMBIENT = [
  (actor: Owner, n: number) => `${n} of your pieces stood untouched through all of this — ${who(actor, false)} built the rest around them without needing to be told.`,
  (actor: Owner) => `Whatever you'd placed stayed exactly where you put it; ${who(actor, false)} worked the rest of the plan around it.`,
  (actor: Owner, n: number) => `${n} human-placed piece${n === 1 ? "" : "s"} never got so much as nudged — ${who(actor, false)} simply built elsewhere.`,
  (actor: Owner) => `Your corner of the board stayed off-limits, and ${who(actor, false)} respected that without a fuss.`,
];

const EMPTY_FALLBACK = [
  "Nothing's been placed yet. Drop in a piece, or hand the agent a Nudge, and this is where the story starts.",
  "The board's empty and waiting — pick something from the kit, or set a goal, and there'll be something to tell.",
  "No pieces yet, no story yet. Both start the same way: place something.",
  "Empty for now — which just means anything could happen next.",
  "Nothing here yet. Just an open lot, waiting for the first move.",
];

const CLOSE_EMPTY = [
  "Right now the board's empty again — a blank slate, whenever you're ready.",
  "Back to an open lot for the moment.",
  "Nothing standing right now, but the story isn't over.",
];

const CLOSE_ALL_AGENT = [
  (n: number) => `${n} piece${n === 1 ? "" : "s"} on the board right now, all the agent's doing so far — plenty of room for you to jump in.`,
  (n: number) => `${n} piece${n === 1 ? "" : "s"} so far, entirely the agent's — your turn whenever.`,
  (n: number) => `${n} up, none of it yours yet.`,
];

const CLOSE_ALL_HUMAN = [
  (n: number) => `${n} piece${n === 1 ? "" : "s"} so far, all yours — the agent's still waiting for a cue.`,
  (n: number) => `${n} piece${n === 1 ? "" : "s"} on the board, every one placed by you.`,
];

const CLOSE_MIXED = [
  (n: number, h: number, a: number, spread: string) => `${n} piece${n === 1 ? "" : "s"} on the board right now — ${h} from you, ${a} from the agent${spread ? `, ${spread}` : ""}.`,
  (n: number, h: number, a: number) => `That's ${n} pieces total: ${h} yours, ${a} the agent's.`,
  (n: number) => `${n} pieces and counting — a real mix of yours and the agent's.`,
];

// ---------------------------------------------------------------------------
// Kind-flavored placement pools — the new kits narrate like what they ARE:
// pets act, food gets laid out, buildings go up, track gets laid, terrain
// grounds the scene, furniture moves in. Same uniform-signature rule as
// every other pool; dispatch tables below pick the pool by catalog kind and
// fall through to the generic pools for everything else.
// ---------------------------------------------------------------------------

type PlaceOneTpl = (actor: Owner, item: string) => string;
type PlaceRunTpl = (actor: Owner, n: number, kind: string, spread: string) => string;
type PlaceAnchoredTpl = (actor: Owner, item: string, rel: string, anchor: string) => string;

const PLACE_ONE_PET: readonly PlaceOneTpl[] = [
  (actor, item) => `${who(actor, true)} let ${item} loose, and it wandered over to have a look around.`,
  (_actor, item) => `${capFirst(item)} padded in and settled like it had always lived here.`,
  (actor, item) => `${who(actor, true)} brought in ${item}, who immediately picked a favorite spot.`,
  (_actor, item) => `${capFirst(item)} wandered in, sniffed around, and stayed.`,
];

const PLACE_ONE_ANCHORED_PET: readonly PlaceAnchoredTpl[] = [
  (actor, item, rel, anchor) => `${who(actor, true)} set ${item} down ${rel} ${anchor}, and it curled up there like that was the plan.`,
  (_actor, item, rel, anchor) => `${capFirst(item)} padded over and settled in, ${rel} ${anchor}.`,
  (actor, item, rel, anchor) => `${who(actor, true)} brought ${item} over to keep ${anchor} company, ${rel} it.`,
];

const PLACE_RUN_PET: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} let ${n} ${kind} loose, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} wandered in one after another, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} brought in ${n} ${kind}, and they sorted out their own spots, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} showed up in a little parade, ${spread}.`,
];

const PLACE_ONE_FOOD: readonly PlaceOneTpl[] = [
  (actor, item) => `${who(actor, true)} set out ${item}, ready to eat.`,
  (actor, item) => `${who(actor, true)} added ${item} to the spread.`,
  (actor, item) => `${who(actor, true)} plated up ${item}.`,
  (actor, item) => `${who(actor, true)} put out ${item} where anyone could grab it.`,
];

const PLACE_RUN_FOOD: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} laid out a spread: ${n} ${kind}, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} set the table with ${n} ${kind}, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} went out like a buffet, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} kept the kitchen busy, plating ${n} ${kind}, ${spread}.`,
];

const PLACE_ONE_BUILDING: readonly PlaceOneTpl[] = [
  (actor, item) => `${who(actor, true)} raised ${item}.`,
  (_actor, item) => `${capFirst(item)} went up, another notch in the skyline.`,
  (actor, item) => `${who(actor, true)} put up ${item}, and the lot felt more like a street.`,
  (actor, item) => `${who(actor, true)} raised ${item} where there had been nothing but ground.`,
];

const PLACE_RUN_BUILDING: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} raised ${n} ${kind}, and a skyline started to form, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} went up one after another, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} built upward: ${n} ${kind}, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} put up ${n} ${kind}, and the block turned into a proper street, ${spread}.`,
];

const PLACE_ONE_COASTER: readonly PlaceOneTpl[] = [
  (actor, item) => `${who(actor, true)} laid down ${item}, the ride taking shape one segment at a time.`,
  (_actor, item) => `${capFirst(item)} clicked into place along the line.`,
  (actor, item) => `${who(actor, true)} extended the track with ${item}.`,
  (actor, item) => `${who(actor, true)} laid ${item} where the ride would run.`,
];

const PLACE_RUN_COASTER: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} laid ${n} ${kind} end to end, ${spread}.`,
  (_actor, n, kind, spread) => `The track grew by ${n} ${kind}, loop by loop, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} kept the line going, ${n} ${kind} at a stretch, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} went down piece by piece, until you could trace where the ride would run, ${spread}.`,
];

const PLACE_ONE_NATURE: readonly PlaceOneTpl[] = [
  (actor, item) => `${who(actor, true)} put down ${item}, giving the scene some ground to stand on.`,
  (_actor, item) => `${capFirst(item)} settled into the landscape like it had grown there.`,
  (actor, item) => `${who(actor, true)} worked ${item} into the terrain.`,
  (actor, item) => `${who(actor, true)} added ${item}, and the ground felt a little more real.`,
];

const PLACE_RUN_NATURE: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} shaped the land with ${n} ${kind}, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} went in, and the terrain came together, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} laid down ${n} ${kind}, ground first, everything else later, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} roughed in the landscape: ${n} ${kind}, ${spread}.`,
];

const COLD_OPEN_NATURE: readonly PlaceOneTpl[] = [
  (actor, item) => `Terrain came first: ${who(actor, false)} set down ${item}, and the scene had somewhere to stand.`,
  (actor, item) => `Before anything could happen here, there had to be ground. ${who(actor, true)} started with ${item}.`,
  (actor, item) => `It started with the land itself: ${who(actor, false)} put in ${item}, and everything after would sit on top of it.`,
];

const PLACE_ONE_FURNITURE: readonly PlaceOneTpl[] = [
  (actor, item) => `${who(actor, true)} moved ${item} in.`,
  (_actor, item) => `${capFirst(item)} found its spot, and the place felt a bit more lived-in.`,
  (actor, item) => `${who(actor, true)} set ${item} where it made the lot feel like a room.`,
  (actor, item) => `${who(actor, true)} brought ${item} in, the way you furnish a place one piece at a time.`,
];

const PLACE_RUN_FURNITURE: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} moved in ${n} ${kind}, and the place started to feel furnished, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} arranged ${n} ${kind}, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} came in like moving day, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} furnished the place with ${n} ${kind}, ${spread}.`,
];

const PLACE_RUN_CAVE: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} tunneled onward, ${n} ${kind} deep, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} carved the way forward, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} dug in ${n} ${kind}, and the underground took shape, ${spread}.`,
];

const PLACE_RUN_SPACE: readonly PlaceRunTpl[] = [
  (actor, n, kind, spread) => `${who(actor, true)} bolted on ${n} ${kind}, and the station grew, ${spread}.`,
  (_actor, n, kind, spread) => `${n} ${kind} docked into place, one after the next, ${spread}.`,
  (actor, n, kind, spread) => `${who(actor, true)} extended the station with ${n} ${kind}, ${spread}.`,
];

const PLACE_ONE_BY_KIND: Partial<Record<CatalogKind, readonly PlaceOneTpl[]>> = {
  pet: PLACE_ONE_PET, food: PLACE_ONE_FOOD, building: PLACE_ONE_BUILDING,
  coaster: PLACE_ONE_COASTER, nature: PLACE_ONE_NATURE, furniture: PLACE_ONE_FURNITURE,
};
const PLACE_RUN_BY_KIND: Partial<Record<CatalogKind, readonly PlaceRunTpl[]>> = {
  pet: PLACE_RUN_PET, food: PLACE_RUN_FOOD, building: PLACE_RUN_BUILDING,
  coaster: PLACE_RUN_COASTER, nature: PLACE_RUN_NATURE, furniture: PLACE_RUN_FURNITURE,
  cave: PLACE_RUN_CAVE, space: PLACE_RUN_SPACE,
};
const PLACE_ONE_ANCHORED_BY_KIND: Partial<Record<CatalogKind, readonly PlaceAnchoredTpl[]>> = {
  pet: PLACE_ONE_ANCHORED_PET,
};
const COLD_OPEN_BY_KIND: Partial<Record<CatalogKind, readonly PlaceOneTpl[]>> = {
  nature: COLD_OPEN_NATURE,
};

// Zone narration — a planned scene narrates as a built place, zone by zone.

// The zone slot is always appositive (after a dash or comma) because planner
// reasons come in every grammatical shape — "the centerpiece" but also "laid
// out on the table" — and an appositive reads right for both.
const ZONE_OPEN = [
  (actor: Owner, what: string, zone: string) => `It started with ${who(actor, false)} setting down ${what} — ${zone}.`,
  (actor: Owner, what: string, zone: string) => `First move: ${who(actor, false)} put down ${what}, ${zone}.`,
  (actor: Owner, what: string, zone: string) => `${who(actor, true)} laid the first piece where it mattered — ${what}, ${zone}.`,
  (actor: Owner, what: string, zone: string) => `The scene had a shape before it had anything else: ${what}, ${zone}, placed by ${who(actor, false)}.`,
];

const ZONE_BEAT = [
  (actor: Owner, what: string, zone: string) => `${who(actor, true)} set down ${what} — ${zone}.`,
  (actor: Owner, what: string, zone: string) => `Next, ${who(actor, false)} added ${what} — ${zone}.`,
  (_actor: Owner, what: string, zone: string) => `${capFirst(what)} went in next — ${zone}.`,
  (actor: Owner, what: string, zone: string) => `${who(actor, true)} kept building: ${what}, ${zone}.`,
  (actor: Owner, what: string, zone: string) => `${who(actor, true)} filled in the next part of the place — ${what}, ${zone}.`,
];

const CLOSE_DISTRICTS = [
  (n: number, h: number, a: number, districts: string) =>
    `What's standing now reads like a place: ${districts}. ${n} piece${n === 1 ? "" : "s"} in all${h && a ? ` — ${h} yours, ${a} the agent's` : ""}.`,
  (n: number, h: number, _a: number, districts: string) =>
    `${n} piece${n === 1 ? "" : "s"} on the board, laid out in real districts — ${districts} — ${h ? `${h} of them yours` : "all the agent's so far"}.`,
  (n: number, h: number, _a: number, districts: string) =>
    `The board holds an actual scene now: ${districts}. ${n} piece${n === 1 ? "" : "s"} standing${h ? ", built by both of you" : ""}.`,
];

/** Planner reason -> district key. Unknown reasons key as themselves. */
const ZONE_KEY: Record<string, string> = {
  "the centerpiece": "center",
  "around the centerpiece": "center",
  "taking it in": "people",
  "together in the middle of it": "people",
  "the ground underfoot": "ground",
  "the back edge": "edge",
  "out over the water": "water",
  "flagship off the shore": "water",
  "riding at anchor": "water",
  "bumper to bumper": "road",
  "backed up in the jam": "road",
  "framing the scene": "frame",
  "laid out on the table": "table",
  "raising the skyline": "skyline",
  "laying the circuit": "circuit",
};

/** District key -> closing-summary noun phrase. null = not worth naming. */
const DISTRICT_NOUN: Record<string, string | null> = {
  center: "a centerpiece with builds around it",
  people: "people in the middle of it",
  ground: null,
  edge: "a walled back edge",
  water: "a waterfront",
  road: "a road out front",
  frame: "scenery framing the whole thing",
  table: "a table laid out",
  skyline: "a rising skyline",
  circuit: "a track circuit",
};

const zoneKey = (reason: string): string => ZONE_KEY[reason] ?? reason;

// ---------------------------------------------------------------------------
// Beat description.
// ---------------------------------------------------------------------------

function who(actor: Owner, cap: boolean): string {
  if (actor === "human") return cap ? "You" : "you";
  return cap ? "The agent" : "the agent";
}

/** Item/blocker phrases (nounFor/itemPhrase) come back lowercase ("a newcomer")
 * for mid-sentence use; templates that open with one call this to capitalize
 * it. A no-op on already-capitalized proper names ("Sam"). */
function capFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

type PickFn = <T>(name: string, pool: readonly T[]) => T;

function naturalJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function pluralNoun(g: Pick<Ghost, "kind" | "catalogId">): string {
  if (g.kind === "character") return "characters";
  if (g.kind === "pet") return "animals";
  // Countable phrasings — these always appear after a number ("11 dishes"),
  // where the bare mass noun ("11 food") reads wrong.
  if (g.kind === "food") return "dishes";
  if (g.kind === "furniture") return "pieces of furniture";
  if (g.kind === "building") return "buildings";
  const singular = NOUN_OVERRIDES[g.catalogId] ?? fallbackNoun(g.catalogId.split("-").slice(1).join(" "), g.kind);
  const bare = singular.replace(/^an? /, "");
  // Measure phrases pluralize on the measure word: "stretches of track",
  // never "stretch of tracks".
  const m = /^(stretch|patch|loop|flight|pile|pair|row|slab|chunk|bundle|set|cluster|tuft|stack|serving|bunch|curtain|puff|cup) of (.+)$/.exec(bare);
  if (m) return `${pluralizeWord(m[1])} of ${m[2]}`;
  if (/s$/.test(bare)) return bare;
  return pluralizeWord(bare);
}

function pluralizeWord(w: string): string {
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/** A run of placements with no cold-open framing — the plain "what got added" sentence. */
function describeGroup(
  actor: Owner,
  ghosts: Ghost[],
  seenCharacters: CharacterNouns,
  pick: PickFn,
  anchor: Ghost | null,
): string {
  if (ghosts.length === 1) {
    const g = ghosts[0];
    const item = nounFor(g, seenCharacters);
    if (anchor) {
      const a = decodeLot(anchor.lot);
      const b = decodeLot(g.lot);
      if (a && b) {
        const rel = relate(b.col - a.col, b.row - a.row);
        const anchoredPool = PLACE_ONE_ANCHORED_BY_KIND[g.kind];
        if (anchoredPool) return pick(`place-one-anchored:${g.kind}`, anchoredPool)(actor, item, rel, itemPhrase(anchor, seenCharacters));
        return pick("place-one-anchored", PLACE_ONE_ANCHORED)(actor, item, rel, itemPhrase(anchor, seenCharacters));
      }
    }
    const onePool = PLACE_ONE_BY_KIND[g.kind];
    if (onePool) return pick(`place-one:${g.kind}`, onePool)(actor, item);
    return pick("place-one", PLACE_ONE)(actor, item);
  }

  const kinds = new Set(ghosts.map((g) => g.kind));
  const spread = spreadPhrase(ghosts.map((g) => g.lot), pick);
  if (kinds.size === 1) {
    const runPool = PLACE_RUN_BY_KIND[ghosts[0].kind];
    if (runPool) return pick(`place-run:${ghosts[0].kind}`, runPool)(actor, ghosts.length, pluralNoun(ghosts[0]), spread);
    return pick("place-same-kind", PLACE_SAME_KIND)(actor, ghosts.length, pluralNoun(ghosts[0]), spread);
  }
  const labels = ghosts.map((g) => nounFor(g, seenCharacters));
  const list = labels.length > 3 ? `${labels.slice(0, 3).join(", ")}, and ${labels.length - 3} more` : naturalJoin(labels);
  return pick("place-mixed", PLACE_MIXED)(actor, list, spread);
}

/**
 * A run of placements, optionally opening with cold-open framing for the
 * very first piece the whole story ever mentions. The opened-with item is
 * described once, by itself — never repeated in the follow-up group, which
 * only covers the rest of the run.
 */
function describePlacementBeat(
  actor: Owner,
  ghosts: Ghost[],
  seenCharacters: CharacterNouns,
  pick: PickFn,
  isFirstEver: boolean,
  anchor: Ghost | null,
): string {
  if (!isFirstEver) return describeGroup(actor, ghosts, seenCharacters, pick, anchor);

  const [first, ...rest] = ghosts;
  const coldPool = COLD_OPEN_BY_KIND[first.kind];
  const opener = coldPool
    ? pick(`cold-open:${first.kind}`, coldPool)(actor, nounFor(first, seenCharacters))
    : pick("cold-open", COLD_OPEN)(actor, nounFor(first, seenCharacters));
  if (!rest.length) return opener;
  return `${opener} ${describeGroup(actor, rest, seenCharacters, pick, first)}`;
}

/** "a station wall, a station wall" reads like a stutter — tally duplicate
 * nouns into "2 station walls" before joining a mixed list. */
function tallyNouns(labels: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()].map(([l, n]) => {
    if (n === 1) return l;
    const bare = l.replace(/^an? /, "");
    const words = bare.split(" ");
    words[words.length - 1] = pluralizeWord(words[words.length - 1]);
    return `${n} ${words.join(" ")}`;
  });
}

/** What a zone's pieces read as, without spending any picker draws — stable
 * regardless of how the surrounding sentence is chosen. */
function zoneWhat(ghosts: Ghost[], seen: CharacterNouns): string {
  if (ghosts.length === 1) return nounFor(ghosts[0], seen);
  const kinds = new Set(ghosts.map((g) => g.kind));
  if (kinds.size === 1) return `${ghosts.length} ${pluralNoun(ghosts[0])}`;
  const labels = tallyNouns(ghosts.map((g) => nounFor(g, seen)));
  return labels.length > 3 ? `${labels.slice(0, 3).join(", ")}, and ${labels.length - 3} more` : naturalJoin(labels);
}

/**
 * A planned scene narrates as a built place: pieces group by the planner's
 * zone reason in first-appearance order ("first came the centerpiece... then
 * the skyline...") instead of pure chronology. Ghosts without a zone fold
 * into a trailing plain group so every piece is accounted for.
 */
function describeZonedRun(
  actor: Owner,
  ghosts: Ghost[],
  seenCharacters: CharacterNouns,
  pick: PickFn,
  isChapterFirst: boolean,
): string {
  const order: string[] = [];
  const groups = new Map<string, Ghost[]>();
  const loose: Ghost[] = [];
  for (const g of ghosts) {
    if (!g.zone) {
      loose.push(g);
      continue;
    }
    if (!groups.has(g.zone)) {
      groups.set(g.zone, []);
      order.push(g.zone);
    }
    groups.get(g.zone)!.push(g);
  }
  const sentences: string[] = [];
  order.forEach((zone, i) => {
    const what = zoneWhat(groups.get(zone)!, seenCharacters);
    if (i === 0 && isChapterFirst) sentences.push(pick("zone-open", ZONE_OPEN)(actor, what, zone));
    else sentences.push(pick("zone-beat", ZONE_BEAT)(actor, what, zone));
  });
  if (loose.length) sentences.push(describeGroup(actor, loose, seenCharacters, pick, null));
  return sentences.join(" ");
}

function describeCustomizeBeat(g: Ghost, actor: Owner, seenCharacters: CharacterNouns, pick: PickFn): string {
  const item = nounFor(g, seenCharacters);
  const color = colorWord(g.color);
  if (g.label && color) return pick("customize-known", CUSTOMIZE_KNOWN)(actor, item, color, g.label);
  if (g.label) return pick("customize-unknown", CUSTOMIZE_UNKNOWN)(actor, item, color ?? "", g.label);
  if (color) return pick("paint-known", PAINT_BEAT_KNOWN)(actor, item, color);
  return pick("paint-unknown", PAINT_BEAT_UNKNOWN)(actor, item);
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

function chapterLine(chapter: Chapter, isFirstChapter: boolean, pick: PickFn): { line: string; ghosts: Map<string, Ghost> } {
  const reg = replayChapter(chapter.events);
  const seenCharacters: CharacterNouns = { count: 0, assigned: new Map() };
  const parts: string[] = [];
  let placedAny = false;
  let lastAnchor: Ghost | null = null;

  if (chapter.goal) {
    const wipe = chapter.wipedCount ? pick("wipe-clause", WIPE_CLAUSE)(chapter.wipedCount) : "";
    parts.push(pick("pivot-open", PIVOT_OPEN)(chapter.goal, wipe));
  }

  // Group paint/label by pieceId first (a "customize" beat), tracking the
  // earliest event index each piece's customization should render at.
  const customizeAt = new Map<string, number>();
  chapter.events.forEach((e, i) => {
    if ((e.verb === "paint" || e.verb === "label") && e.pieceId && !customizeAt.has(e.pieceId)) {
      customizeAt.set(e.pieceId, i);
    }
  });

  // Blocked events: resolve against the registry at each event's own lot.
  const blockedNamed: { blockerId: string; lots: string[] }[] = [];
  const ambientBlocks: StoryEvent[] = [];
  for (const e of chapter.events) {
    if (e.verb !== "blocked") continue;
    const blockerId = e.lot ? [...reg.entries()].find(([, g]) => g.lot === e.lot)?.[0] : undefined;
    if (blockerId) {
      const existing = blockedNamed.find((b) => b.blockerId === blockerId);
      if (existing) existing.lots.push(e.lot!);
      else blockedNamed.push({ blockerId, lots: [e.lot!] });
    } else {
      ambientBlocks.push(e);
    }
  }

  const doneCustomize = new Set<string>();
  const doneBlocked = new Set<string>();
  let runActor: Owner | null = null;
  let runGhosts: Ghost[] = [];

  const flushRun = () => {
    if (!runGhosts.length) return;
    const isFirstEver = isFirstChapter && !placedAny;
    // A run carrying planner zones narrates as a built place; anything else
    // keeps the chronological beat.
    const zoned = runGhosts.some((g) => g.zone);
    parts.push(
      zoned
        ? describeZonedRun(runActor as Owner, runGhosts, seenCharacters, pick, !placedAny)
        : describePlacementBeat(runActor as Owner, runGhosts, seenCharacters, pick, isFirstEver, lastAnchor),
    );
    placedAny = true;
    lastAnchor = runGhosts[runGhosts.length - 1];
    runGhosts = [];
    runActor = null;
  };

  chapter.events.forEach((e, i) => {
    if (e.verb === "goal") return;

    if ((e.verb === "paint" || e.verb === "label") && e.pieceId) {
      if (customizeAt.get(e.pieceId) === i && !doneCustomize.has(e.pieceId)) {
        doneCustomize.add(e.pieceId);
        flushRun();
        const g = reg.get(e.pieceId);
        if (g) parts.push(describeCustomizeBeat(g, e.actor, seenCharacters, pick));
      }
      return;
    }

    if (e.verb === "place" && e.pieceId) {
      const g = reg.get(e.pieceId);
      if (!g) return;
      if (runActor !== null && runActor !== e.actor) flushRun();
      runActor = e.actor;
      runGhosts.push(g);
      return;
    }

    if (e.verb === "move" && e.pieceId) {
      flushRun();
      const g = reg.get(e.pieceId);
      if (g && e.lot) {
        const from = decodeLot(g.lot);
        const to = decodeLot(e.lot);
        const axis = from && to ? relate(to.col - from.col, to.row - from.row).replace(/^(just|a couple lots|well off to the)\s*/, "") : "over";
        parts.push(pick("move", MOVE_BEAT)(e.actor, itemPhrase(g, seenCharacters), axis));
      }
      return;
    }

    if (e.verb === "remove" && e.pieceId) {
      flushRun();
      const g = reg.get(e.pieceId);
      if (g) parts.push(pick("remove", REMOVE_BEAT)(e.actor, itemPhrase(g, seenCharacters)));
      return;
    }

    if (e.verb === "blocked") {
      const entry = blockedNamed.find((b) => b.lots.includes(e.lot ?? ""));
      if (entry && !doneBlocked.has(entry.blockerId)) {
        doneBlocked.add(entry.blockerId);
        flushRun();
        const blocker = reg.get(entry.blockerId);
        if (blocker) {
          const rerouteLot = runGhosts[0]?.lot ?? lastAnchor?.lot ?? "nearby";
          parts.push(
            pick("respect-named", RESPECT_NAMED)(e.actor, itemPhrase(blocker, seenCharacters), entry.lots[0], rerouteLot),
          );
        }
      }
    }
  });
  flushRun();

  if (ambientBlocks.length) {
    const first = ambientBlocks[0];
    const n = Number(/^(\d+)/.exec(first.detail ?? "")?.[1] ?? 1);
    parts.push(pick("respect-ambient", RESPECT_AMBIENT)(first.actor, n));
  }

  return { line: parts.filter(Boolean).join(" "), ghosts: reg };
}

function closingSummary(pieces: Record<string, Piece>, pick: PickFn, districts: string[]): string {
  const list = Object.values(pieces);
  if (!list.length) return pick("close-empty", CLOSE_EMPTY);
  const human = list.filter((p) => p.owner === "human").length;
  const agent = list.length - human;
  if (districts.length >= 2) {
    return pick("close-districts", CLOSE_DISTRICTS)(list.length, human, agent, naturalJoin(districts));
  }
  if (human && agent) {
    const spread = spreadPhrase(list.map((p) => p.lot), pick);
    return pick("close-mixed", CLOSE_MIXED)(list.length, human, agent, spread);
  }
  if (human) return pick("close-all-human", CLOSE_ALL_HUMAN)(list.length);
  return pick("close-all-agent", CLOSE_ALL_AGENT)(list.length);
}

export function buildStory(events: StoryEvent[], pieces: Record<string, Piece>): Story {
  const seed = seedFrom(events);
  const pickers = makePickers(seed);
  const pick: PickFn = (name, pool) => pickers.of(name, pool)();

  if (!events.length) {
    return { title: "An Empty Canvas", paragraphs: [pick("empty", EMPTY_FALLBACK)] };
  }

  const chapters = splitChapters(events);
  const totalEvents = events.length;

  // Micro mode: 1-3 events, no chapter framing at all.
  if (totalEvents <= 3 && chapters.length === 1) {
    const { line } = chapterLine(chapters[0], true, pick);
    const paragraphs = [line || pick("empty", EMPTY_FALLBACK), closingSummary(pieces, pick, [])];
    return { title: "Early Days", paragraphs };
  }

  // Chapter budget: only the last chapter gets full treatment; compress the rest.
  const last = chapters[chapters.length - 1];
  const earlier = chapters.slice(0, -1);
  const paragraphs: string[] = [];

  if (earlier.length === 1 || earlier.length === 2) {
    for (const c of earlier) {
      const count = new Set(c.events.filter((e) => e.pieceId).map((e) => e.pieceId)).size;
      const human = c.events.filter((e) => e.actor === "human" && e.verb === "place").length;
      const label = c.goal ? titleCase(c.goal) : "the first sketch";
      paragraphs.push(`Before that: ${label}, ${count} piece${count === 1 ? "" : "s"}, ${human} of them yours.`);
    }
  } else if (earlier.length >= 3) {
    const names = earlier.filter((c) => c.goal).map((c) => titleCase(c.goal as string));
    const shown = names.slice(0, 2);
    const rest = names.length - shown.length;
    paragraphs.push(
      `A few other ideas came and went before this one — ${naturalJoin(shown)}${rest > 0 ? `, and ${rest} more` : ""}.`,
    );
  }

  const { line, ghosts } = chapterLine(last, chapters.length === 1, pick);
  if (line) paragraphs.push(line);
  // Districts the final chapter actually built, in first-appearance order —
  // the closing line can then describe the scene as a laid-out place.
  const seenKeys: string[] = [];
  for (const g of ghosts.values()) {
    if (!g.zone) continue;
    const k = zoneKey(g.zone);
    if (!seenKeys.includes(k)) seenKeys.push(k);
  }
  const districts = seenKeys
    .map((k) => (k in DISTRICT_NOUN ? DISTRICT_NOUN[k] : k))
    .filter((d): d is string => Boolean(d))
    .slice(0, 3);
  paragraphs.push(closingSummary(pieces, pick, districts));

  const title = last.goal ? titleCase(last.goal) : chapters.length > 1 ? "A Shared Scene" : "Early Days";
  return { title, paragraphs: paragraphs.filter(Boolean) };
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter(Boolean)
    .map((w, i) => (i === 0 || w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
