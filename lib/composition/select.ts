import { CATALOG, type CatalogItem } from "../catalog";

/**
 * Selection — turn a free-text theme into a real subset of the catalog.
 * Moved verbatim from lib/scenePlan.ts; selection was already good — the
 * composition refactor changed how items are ARRANGED, not how they're chosen.
 */

// Short filler words carry no theme signal and are prone to false substring
// hits inside unrelated catalog text (e.g. "and" inside "standing").
const STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "into", "near", "over",
  "some", "very", "just", "like", "are", "was", "were", "has", "have", "had",
  "not", "but", "all", "out", "off", "own", "too", "can", "will", "its", "our",
  "your", "their",
]);

export function tokensOf(theme: string) {
  const words = theme
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  // Naive plural fold ("cars" -> "car") so vocab and catalog matches aren't
  // sensitive to singular vs plural phrasing in the theme text.
  const singulars = words.filter((w) => w.length > 3 && w.endsWith("s")).map((w) => w.slice(0, -1));
  return [...new Set([...words, ...singulars])];
}

export function hashTheme(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Everyday words for what a pack is "about" that never appear in its own item
 * ids or labels (nobody names a sprite "traffic-jam.png"). This is the only
 * theme-flavored content in selection — it only steers which catalog items get
 * pulled in, never how they're arranged, so it scales to any wording without
 * needing a recipe per phrase.
 */
const PACK_VOCAB: Record<string, string[]> = {
  car: ["traffic", "jam", "road", "street", "downtown", "urban", "city", "drive", "parking", "commute", "rush", "highway", "vehicle", "garage"],
  watercraft: ["harbor", "harbour", "marina", "dock", "shore", "sea", "lake", "ocean", "fish", "sail", "cruise", "port", "water"],
  pirate: ["treasure", "island", "cannon", "plunder", "buccaneer", "cove", "loot"],
  "mini-arcade": ["game", "gaming", "pixel", "retro", "token", "night"],
  "mini-arena": ["battle", "war", "soldier", "fight", "gladiator", "tournament", "stadium"],
  "mini-dungeon": ["cave", "dark", "haunted", "goblin", "quest", "adventure"],
  "mini-forest": ["camp", "camping", "hike", "nature", "woods", "outdoor", "wilderness", "quiet"],
  "mini-market": ["shop", "shopping", "store", "grocery", "grocer", "cafe", "coffee", "bakery", "food"],
  "mini-skate": ["skateboard", "skater", "trick", "grind", "board"],
  "mini-characters": ["people", "crowd", "gathering", "meeting", "chat", "chatting", "town", "village", "folk", "square", "friends"],
  pets: ["zoo", "pet", "animal", "cute", "farmyard", "farm", "barnyard", "puppy", "kitten", "safari"],
  food: ["kitchen", "meal", "picnic", "feast", "snack", "diner", "restaurant", "lunch", "breakfast", "dinner", "cook", "barbecue"],
  furniture: ["house", "home", "room", "apartment", "living", "bedroom", "interior", "lounge", "sofa", "couch", "den"],
  buildings: ["skyline", "neighborhood", "block", "architecture", "suburb", "city", "street", "downtown", "apartment", "tower"],
  cave: ["cave", "cavern", "underground", "grotto", "hollow", "mine", "tunnel"],
  space: ["space", "spaceship", "station", "scifi", "alien", "orbit", "moon", "nasa", "galaxy", "cosmic"],
  nature: ["garden", "meadow", "orchard", "landscape", "farmland", "farm", "valley", "hillside", "countryside", "park", "picnic", "trail"],
  coaster: ["amusement", "carnival", "fairground", "roller", "themepark", "fair", "ride", "coaster"],
  "toy-car": ["racetrack", "raceway", "kart", "toycar", "race", "racing", "track"],
  survival: ["homestead", "cabin", "wilderness", "outpost"],
  prototype: ["lab", "workshop", "testbed"],
  "modular-dungeon": ["dungeon", "lair", "keep", "crypt", "castle", "fortress"],
};

export const CLUTTER_KINDS = new Set(["prop", "crate", "other"]);

/**
 * Tileset pieces that only make sense assembled — floor slabs, stair
 * modules, wall templates, corridor junctions, ladders, cable runs. Placed
 * loose they read as stairs to nowhere and slabs sunk in the floor, so
 * selection never hands them to a composer. (Lamps keep their "floor".)
 */
const TILESET_JUNK = /(^|-)(template|stairs|stair|ladder|cables|floor|floors|platform|border|corridor-(intersection|junction|transition)|patch)(-|$)/;
export function isTilesetJunk(item: CatalogItem): boolean {
  if (/lamp/.test(item.id)) return false;
  return TILESET_JUNK.test(item.id);
}

/** How many pieces a matching pack may contribute. Rich kits are the whole
 * point of a theme — a picnic should look like a picnic, not six snacks. */
const PACK_QUOTA: Record<string, number> = {
  nature: 36,
  food: 32,
  furniture: 32,
  coaster: 36,
  "toy-car": 32,
  pirate: 28,
  prototype: 24,
  buildings: 24,
  watercraft: 22,
  car: 22,
  survival: 22,
  "mini-arcade": 20,
  "mini-skate": 20,
  "mini-dungeon": 20,
  "mini-market": 20,
  "mini-forest": 20,
  "mini-arena": 18,
  pets: 20,
  cave: 20,
  space: 20,
  "modular-dungeon": 20,
};

const SCENE_LIMIT = 48;

/**
 * Kits whose sprites are generic modules named with everyday structural words
 * ("room", "stairs", "door", "shape"). Left open, they gate-crash unrelated
 * themes — a "cozy living room" full of cave-room slabs. They only join a
 * scene through their own vocabulary (cave, space, dungeon, lab...).
 */
const VOCAB_GATED_PACKS = new Set(["prototype", "cave", "space", "modular-dungeon"]);

function selectionScore(item: CatalogItem, tokens: string[], hayWords: Map<string, Set<string>>): number {
  let score = 0;
  if (!VOCAB_GATED_PACKS.has(item.pack)) {
    const words = hayWords.get(item.id);
    for (const token of tokens) {
      // Whole-word matching (plus long-prefix for stems): substring matching
      // let "car" hit "cargo" and "town" hit "downtown".
      if (words?.has(token)) score += 4;
      else if (token.length >= 5 && words && [...words].some((w) => w.startsWith(token))) score += 3;
    }
  }
  const vocab = PACK_VOCAB[item.pack];
  if (vocab) {
    // Vocabulary is curated intent — it outranks a filename word so that
    // "living room" means sofas (furniture vocab), not cave-room modules.
    const bonus = CLUTTER_KINDS.has(item.kind) ? 2 : 5;
    for (const token of tokens) {
      if (vocab.includes(token)) score += bonus;
    }
  }
  if (score > 0) {
    // Iconic pieces beat trinkets on equal relevance: a whole pack matching
    // "pirate" shouldn't lead with a bottle when there are ships and towers.
    const mass = item.content[2] * item.content[3];
    if (mass > 22000) score += 2;
    else if (mass > 12000) score += 1;
  }
  return score;
}

/** Word sets per item, built once per plan call: id, pack, label, kind split
 * on non-letters, so matching is whole-word instead of substring. */
function buildHayWords(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const item of CATALOG) {
    const words = `${item.id} ${item.pack} ${item.label} ${item.kind}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    map.set(item.id, new Set(words));
  }
  return map;
}

function quotaFor(pack: string, primaryPack: string | null): number {
  const rich = PACK_QUOTA[pack] ?? 18;
  return pack === primaryPack ? rich : Math.min(16, rich);
}

/** Cap per pack and per kind-within-pack so one prolific sprite family (five
 * kart colors, ten speedboat variants) can't crowd out everything else —
 * but a matched theme still gets a complete set, not a handful. */
function diversify(items: CatalogItem[], limit: number, primaryPack: string | null): CatalogItem[] {
  const perPack = new Map<string, number>();
  const perPackKind = new Map<string, number>();
  const picked: CatalogItem[] = [];
  for (const item of items) {
    if ((perPack.get(item.pack) ?? 0) >= quotaFor(item.pack, primaryPack)) continue;
    const kindKey = `${item.pack}:${item.kind}`;
    const kindCap =
      item.kind === "coaster" || item.id.startsWith("toycar-track")
        ? 22
        : item.kind === "food" || item.kind === "nature" || item.kind === "furniture"
          ? 24
          : item.kind === "pet" || item.kind === "space" || item.kind === "cave" || item.kind === "dungeon"
            ? 16
            : 12;
    if ((perPackKind.get(kindKey) ?? 0) >= kindCap) continue;
    perPack.set(item.pack, (perPack.get(item.pack) ?? 0) + 1);
    perPackKind.set(kindKey, (perPackKind.get(kindKey) ?? 0) + 1);
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * A place without people reads as abandoned. Every composition gets at least
 * a couple of characters: the theme's own first (the skaters for the skate
 * park, the gamers for the arcade — same packs as the selection), and generic
 * townsfolk when the matched packs simply have no people (cars, boats).
 */
function ensureCharacters(picked: CatalogItem[], seed: number): CatalogItem[] {
  const want = Math.min(6, Math.max(2, Math.floor(picked.length / 8)));
  let have = picked.filter((i) => i.kind === "character").length;
  if (have >= want) return picked;
  const packs = new Set(picked.map((i) => i.pack));
  const taken = new Set(picked.map((i) => i.id));
  const locals = CATALOG.filter((i) => i.kind === "character" && packs.has(i.pack) && !taken.has(i.id));
  const townsfolk = CATALOG.filter((i) => i.kind === "character" && i.pack === "mini-characters" && !taken.has(i.id));
  const out = [...picked];
  for (const c of [...seededShuffle(locals, seed), ...seededShuffle(townsfolk, seed)]) {
    if (have >= want) break;
    out.push(c);
    have += 1;
  }
  return out;
}

export function selectItems(theme: string, seed: number): CatalogItem[] {
  const tokens = tokensOf(theme);
  if (tokens.length) {
    const hayWords = buildHayWords();
    const scored = CATALOG.filter((item) => !isTilesetJunk(item)).map((item) => ({ item, score: selectionScore(item, tokens, hayWords) })).filter((r) => r.score > 0);
    if (scored.length) {
      // Seeded shuffle before a stable sort = deterministic tie-breaking, so
      // equal-score items vary by theme instead of following catalog order.
      const ranked = seededShuffle(scored, seed).sort((a, b) => b.score - a.score);
      const packScore = new Map<string, number>();
      for (const row of ranked) {
        packScore.set(row.item.pack, (packScore.get(row.item.pack) ?? 0) + row.score);
      }
      let primaryPack: string | null = null;
      let best = 0;
      for (const [pack, total] of packScore) {
        if (total > best) {
          best = total;
          primaryPack = pack;
        }
      }
      return ensureCharacters(diversify(ranked.map((r) => r.item), SCENE_LIMIT, primaryPack), seed);
    }
  }
  // Nothing matched any vocabulary — still give a real scene, not nothing.
  const packs = [...new Set(CATALOG.map((i) => i.pack))];
  const first = packs[seed % packs.length];
  const secondPick = packs[(seed >>> 8) % packs.length];
  const second = secondPick === first ? packs[(packs.indexOf(first) + 1) % packs.length] : secondPick;
  return ensureCharacters(
    diversify(seededShuffle(CATALOG.filter((i) => (i.pack === first || i.pack === second) && !isTilesetJunk(i)), seed), SCENE_LIMIT, first),
    seed,
  );
}
