import { CATALOG, catalogItem, type CatalogItem } from "./catalog";

function colLetters(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function lotId(col: number, row: number) {
  if (Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0) {
    return `${colLetters(col)}${row + 1}`;
  }
  return `C${col}R${row}`;
}

/** One planned placement in a scene that should read as a real place, not a pile. */
export type SceneTodo = {
  id: string;
  place: string;
  kind: string;
  lot: string;
  flip: boolean;
  reason: string;
};

type Slot = {
  id: string;
  dc: number;
  dr: number;
  flip?: boolean;
  reason: string;
};

const ORIGIN = { col: 12, row: 12 }; // M13

// Short filler words carry no theme signal and are prone to false substring
// hits inside unrelated catalog text (e.g. "and" inside "standing").
const STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "into", "near", "over",
  "some", "very", "just", "like", "are", "was", "were", "has", "have", "had",
  "not", "but", "all", "out", "off", "own", "too", "can", "will", "its", "our",
  "your", "their",
]);

function tokensOf(theme: string) {
  const words = theme
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  // Naive plural fold ("cars" -> "car") so vocab and catalog matches aren't
  // sensitive to singular vs plural phrasing in the theme text.
  const singulars = words.filter((w) => w.length > 3 && w.endsWith("s")).map((w) => w.slice(0, -1));
  return [...new Set([...words, ...singulars])];
}

function hashTheme(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection — turn free-text theme into a real subset of the catalog.
// ---------------------------------------------------------------------------

/**
 * Everyday words for what a pack is "about" that never appear in its own item
 * ids or labels (nobody names a sprite "traffic-jam.png"). This is the only
 * theme-flavored content in the file — it only steers which catalog items get
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

const CLUTTER_KINDS = new Set(["prop", "crate", "other"]);

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

function selectItems(theme: string, seed: number): CatalogItem[] {
  const tokens = tokensOf(theme);
  if (tokens.length) {
    const hayWords = buildHayWords();
    const scored = CATALOG.map((item) => ({ item, score: selectionScore(item, tokens, hayWords) })).filter((r) => r.score > 0);
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
    diversify(seededShuffle(CATALOG.filter((i) => i.pack === first || i.pack === second), seed), SCENE_LIMIT, first),
    seed,
  );
}

// ---------------------------------------------------------------------------
// Roles — what job an item does in a composition. Keyed by catalog kind and
// structural id vocabulary (wall/floor/dock — words about the art itself),
// never by theme text, so the same rules compose any request.
// ---------------------------------------------------------------------------

type Role =
  | "ground"     // floor tiles, grass/sand patches, terrain — the land itself
  | "wall"       // walls and fences — the back edges of the place
  | "connector"  // docks, bridges — seams between zones
  | "structure"  // fixed builds: stalls, machines, towers, furniture
  | "backdrop"   // building facades — the skyline behind everything
  | "track"      // coaster and racetrack segments — a circuit around it all
  | "tabletop"   // food and small table goods — laid out beside the fixtures
  | "vessel"     // boats and ships — offshore
  | "vehicle"    // cars — on the road
  | "person"     // characters and pets — near the action, alive
  | "scenery";   // trees, rocks, clutter — framing

function roleOf(item: CatalogItem): Role {
  if (item.kind === "character" || item.kind === "pet") return "person";
  if (item.kind === "car") return "vehicle";
  if (item.kind === "boat") return "vessel";
  if (item.kind === "building") return "backdrop";
  if (item.kind === "food") return "tabletop";
  // Linear circuit pieces: the coaster kit's track segments, and the toy-car
  // kit's track ramps. Other ramps (skate, watercraft launch) stay structures.
  if (item.kind === "coaster") return "track";
  if (item.kind === "ramp" && item.id.startsWith("toycar-track")) return "track";
  // Terrain chunks read as ground; loose plants and stones frame the scene.
  if (item.kind === "nature") {
    return /cliff|ground|path|river/.test(item.id) ? "ground" : "scenery";
  }
  if (/-(patch|floor)|patch-|floor-|-grass$|-sand$|-dirt$/.test(item.id)) return "ground";
  if (/wall|fence|doorway/.test(item.id)) return "wall";
  if (/dock|bridge/.test(item.id)) return "connector";
  if (item.kind === "tree") return "scenery";
  if (item.kind === "pirate") {
    return /rock|bottle|hole|tool|grass|ball$/.test(item.id) ? "scenery" : "structure";
  }
  // Camp fixtures in the survival kit are builds, not clutter.
  if (/tent|workbench|campfire|structure-/.test(item.id)) return "structure";
  if (CLUTTER_KINDS.has(item.kind)) return "scenery";
  return "structure"; // stall, machine, ramp, dungeon, furniture, cave, space
}

/** Visual mass from the sprite's alpha content box — the biggest thing in the
 * selection becomes the focal landmark, whatever the theme was. */
function visualMass(item: CatalogItem): number {
  return item.content[2] * item.content[3];
}

// ---------------------------------------------------------------------------
// Composition — one radial model for every scene:
//
//        walls / treeline          (north — background in iso)
//   ┌────────────────────────┐
//   │  ring of structures    │
//   │    FOCAL LANDMARK      │──pier──~ flotilla ~   (east — water)
//   │  people by the action  │
//   └────────────────────────┘
//        road with lanes           (south — foreground)
//
// Zones only render when their role has members, so a traffic jam is all
// road, an island is pad + flotilla, a market is walls + aisles + shoppers.
// ---------------------------------------------------------------------------

function ringCells(r: number): { dc: number; dr: number }[] {
  if (r === 0) return [{ dc: 0, dr: 0 }];
  const cells: { dc: number; dr: number }[] = [];
  for (let dc = -r; dc <= r; dc += 1) {
    for (let dr = -r; dr <= r; dr += 1) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) === r) cells.push({ dc, dr });
    }
  }
  return cells;
}

const HUDDLE_SHAPES: [number, number][][] = [
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [1, 0], [0, 1]],
];

function composeScene(items: CatalogItem[], seed: number): Slot[] {
  const byRole: Record<Role, CatalogItem[]> = {
    ground: [], wall: [], connector: [], structure: [], backdrop: [],
    track: [], tabletop: [], vessel: [], vehicle: [], person: [], scenery: [],
  };
  for (const item of items) byRole[roleOf(item)].push(item);

  const slots: Slot[] = [];
  const structures = [...byRole.structure].sort((a, b) => visualMass(b) - visualMass(a));
  const padR = structures.length > 16 || byRole.ground.length > 14 ? 5 : structures.length > 8 || byRole.ground.length > 10 ? 4 : 3;

  // Focal landmark — the visually heaviest structure anchors the center.
  const [landmark, ...support] = structures;
  if (landmark) slots.push({ id: landmark.id, dc: 0, dr: 0, reason: "the centerpiece" });

  // Supporting structures ring the landmark on alternating cells, mirrored
  // to face inward, so the middle reads as a built place with breathing room.
  const around = [...ringCells(2), ...ringCells(3), ...ringCells(padR)]
    .filter((c) => (c.dc + c.dr) % 2 === 0);
  support.forEach((item, i) => {
    const cell = around[i % around.length];
    slots.push({ id: item.id, dc: cell.dc, dr: cell.dr, flip: cell.dc > 0, reason: "around the centerpiece" });
  });

  // Food and table goods lay out in tight spreads right beside the fixtures —
  // a meal is ON a table, not floating in a field. No fixtures? A picnic
  // blanket's worth of it clusters at the center instead.
  const structureSlots = slots.length ? [...slots] : [];
  const TABLE_OFFSETS: [number, number][] = [[1, 0], [0, 1], [1, 1]];
  byRole.tabletop.forEach((item, i) => {
    const host = structureSlots.length
      ? structureSlots[Math.floor(i / 3) % structureSlots.length]
      : { dc: Math.floor(i / 3) * 2 - 1, dr: 0 };
    const [dc, dr] = TABLE_OFFSETS[i % 3];
    slots.push({ id: item.id, dc: host.dc + dc, dr: host.dr + dr, reason: "laid out on the table" });
  });

  // People gather in small huddles beside the structures — or around the
  // center when there's nothing built — facing what they're next to.
  const supportSlots = slots.filter((s) => s.reason === "around the centerpiece");
  const anchors = supportSlots.length ? supportSlots : slots.slice(0, 1);
  let personIdx = 0;
  let huddleIdx = 0;
  while (personIdx < byRole.person.length) {
    const size = Math.min(byRole.person.length - personIdx, 1 + ((seed + huddleIdx) % 3));
    const anchor = anchors.length
      ? anchors[huddleIdx % anchors.length]
      : { dc: (huddleIdx - 1) * 3, dr: 0 };
    HUDDLE_SHAPES[size - 1].forEach(([dc, dr], j) => {
      const item = byRole.person[personIdx + j];
      slots.push({
        id: item.id,
        dc: anchor.dc + dc,
        dr: anchor.dr + 1 + dr,
        flip: j === 1,
        reason: size === 1 ? "taking it in" : "together in the middle of it",
      });
    });
    personIdx += size;
    huddleIdx += 1;
  }

  // Ground fills the leftover holes inside the pad last, so floor shows
  // between the builds — the scene sits ON something instead of floating.
  const padCells: { dc: number; dr: number }[] = [];
  for (let r = 0; r <= padR; r += 1) padCells.push(...ringCells(r));
  byRole.ground.forEach((item, i) => {
    const cell = padCells[i % padCells.length];
    slots.push({ id: item.id, dc: cell.dc, dr: cell.dr, reason: "the ground underfoot" });
  });

  // Walls and fences run the north and west edges — the back-left L that
  // closes a room or yard in isometric view without hiding anything.
  byRole.wall.forEach((item, i) => {
    const north = i % 2 === 0;
    const step = Math.floor(i / 2) * 2 - padR;
    slots.push({
      id: item.id,
      dc: north ? step : -padR - 1,
      dr: north ? -padR - 1 : step,
      reason: "the back edge",
    });
  });

  // Building facades stand shoulder to shoulder along the north edge — a
  // contiguous skyline behind the walls, the way a street reads in iso.
  // Two rows once there are enough for a real block.
  const skylineRow = -padR - (byRole.wall.length ? 3 : 2);
  const perSkyline = byRole.backdrop.length > 8 ? Math.ceil(byRole.backdrop.length / 2) : byRole.backdrop.length;
  byRole.backdrop.forEach((item, i) => {
    const row = Math.floor(i / Math.max(1, perSkyline));
    const pos = i % Math.max(1, perSkyline);
    slots.push({
      id: item.id,
      dc: pos - Math.floor(perSkyline / 2),
      dr: skylineRow - row,
      reason: "raising the skyline",
    });
  });

  // Connectors pier out east from the pad toward the water.
  byRole.connector.forEach((item, i) => {
    slots.push({ id: item.id, dc: padR + 1 + i, dr: 0, reason: "out over the water" });
  });

  // Vessels float in a staggered flotilla east of the pier, biggest nearest
  // shore — columns of three so it reads as a fleet, not a line of dots.
  const vessels = [...byRole.vessel].sort((a, b) => visualMass(b) - visualMass(a));
  const waterBase = padR + 2 + byRole.connector.length;
  vessels.forEach((item, i) => {
    slots.push({
      id: item.id,
      dc: waterBase + Math.floor(i / 3) * 3 + (i % 3 === 1 ? 1 : 0),
      dr: ((i % 3) - 1) * 2,
      reason: i === 0 ? "flagship off the shore" : "riding at anchor",
    });
  });

  // Vehicles queue on the road south of everything: nose-to-tail, and a
  // second facing lane once there are enough to jam up.
  const lanes = byRole.vehicle.length > 5 ? 2 : 1;
  const perLane = Math.ceil(byRole.vehicle.length / lanes);
  byRole.vehicle.forEach((item, i) => {
    const lane = Math.floor(i / perLane);
    slots.push({
      id: item.id,
      dc: -2 + (i % perLane) * 2,
      dr: padR + 2 + lane * 2,
      flip: lane % 2 === 1,
      reason: lanes > 1 ? "backed up in the jam" : "bumper to bumper",
    });
  });

  // Track segments run a CIRCUIT around everything built so far — a coaster
  // wrapping the fair, a racetrack around the infield. Consecutive segments
  // walk the perimeter in order, so the pieces read as one continuous ride.
  if (byRole.track.length) {
    let minC = -2, maxC = 2, minR = -2, maxR = 2;
    for (const s of slots) {
      minC = Math.min(minC, s.dc);
      maxC = Math.max(maxC, s.dc);
      minR = Math.min(minR, s.dr);
      maxR = Math.max(maxR, s.dr);
    }
    const walk: { dc: number; dr: number }[] = [];
    const [l, r, t, b] = [minC - 2, maxC + 2, minR - 2, maxR + 2];
    for (let dc = l; dc <= r; dc += 2) walk.push({ dc, dr: t });
    for (let dr = t + 2; dr <= b; dr += 2) walk.push({ dc: r, dr });
    for (let dc = r - 2; dc >= l; dc -= 2) walk.push({ dc, dr: b });
    for (let dr = b - 2; dr > t; dr -= 2) walk.push({ dc: l, dr });
    const start = seed % walk.length;
    byRole.track.forEach((item, i) => {
      const cell = walk[(start + i) % walk.length];
      slots.push({ id: item.id, dc: cell.dc, dr: cell.dr, reason: "laying the circuit" });
    });
  }

  // Scenery frames the back of wherever the action actually landed — the
  // north and west edges of its bounding box — in clumps of two, leaving the
  // water and road sides open so the deliberate space stays readable.
  if (byRole.scenery.length) {
    let minC = 0, maxC = 0, minR = 0;
    for (const s of slots) {
      minC = Math.min(minC, s.dc);
      maxC = Math.max(maxC, s.dc);
      minR = Math.min(minR, s.dr);
    }
    const frame: { dc: number; dr: number }[] = [];
    for (let dc = minC - 1; dc <= maxC + 1; dc += 2) frame.push({ dc, dr: minR - 2 });
    for (let dr = minR; dr <= minR + 6; dr += 2) frame.push({ dc: minC - 2, dr });
    const shuffled = slots.length ? seededShuffle(frame, seed) : frame;
    byRole.scenery.forEach((item, i) => {
      const cell = shuffled[Math.floor(i / 2) % Math.max(1, shuffled.length)];
      slots.push({
        id: item.id,
        dc: cell.dc + (i % 2),
        dr: cell.dr,
        reason: "framing the scene",
      });
    });
  }

  return cohere(slots);
}

/**
 * Nothing gets left stranded — including stranded PAIRS, which per-slot
 * nearest-neighbor checks miss because the pair members vouch for each
 * other. Group slots into connected clusters (neighbors within 2 cells),
 * then walk every minor cluster in toward the largest one, step by step,
 * until the whole plan reads as one place.
 */
function cohere(slots: Slot[]): Slot[] {
  const dist = (a: Slot, b: Slot) => Math.max(Math.abs(a.dc - b.dc), Math.abs(a.dr - b.dr));

  for (let pass = 0; pass < slots.length; pass += 1) {
    // Connected components under "within 2 cells of each other".
    const comp = new Array<number>(slots.length).fill(-1);
    let nComp = 0;
    for (let i = 0; i < slots.length; i += 1) {
      if (comp[i] !== -1) continue;
      const queue = [i];
      comp[i] = nComp;
      while (queue.length) {
        const cur = queue.pop()!;
        for (let j = 0; j < slots.length; j += 1) {
          if (comp[j] === -1 && dist(slots[cur], slots[j]) <= 2) {
            comp[j] = nComp;
            queue.push(j);
          }
        }
      }
      nComp += 1;
    }
    if (nComp <= 1) break;

    const sizes = new Array<number>(nComp).fill(0);
    for (const c of comp) sizes[c] += 1;
    const main = sizes.indexOf(Math.max(...sizes));

    // Find the closest (straggler, main) pair and step the straggler's whole
    // cluster toward the main one — as a unit, so huddles and rows keep
    // their internal shape while they close the gap.
    let bestD = Infinity;
    let from: Slot | null = null;
    let to: Slot | null = null;
    let cluster = -1;
    for (let i = 0; i < slots.length; i += 1) {
      if (comp[i] === main) continue;
      for (let j = 0; j < slots.length; j += 1) {
        if (comp[j] !== main) continue;
        const d = dist(slots[i], slots[j]);
        if (d < bestD) {
          bestD = d;
          from = slots[i];
          to = slots[j];
          cluster = comp[i];
        }
      }
    }
    if (!from || !to) break;
    const stepC = Math.sign(to.dc - from.dc) * Math.max(0, Math.min(bestD - 2, Math.abs(to.dc - from.dc)));
    const stepR = Math.sign(to.dr - from.dr) * Math.max(0, Math.min(bestD - 2, Math.abs(to.dr - from.dr)));
    if (stepC === 0 && stepR === 0) break;
    for (let i = 0; i < slots.length; i += 1) {
      if (comp[i] === cluster) {
        slots[i].dc += stepC;
        slots[i].dr += stepR;
      }
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Layout — claim real lots for planned slots, dodging what's taken.
// ---------------------------------------------------------------------------

function claimLot(col: number, row: number, taken: Set<string>): string | null {
  for (let ring = 0; ring < 18; ring += 1) {
    for (let dc = -ring; dc <= ring; dc += 1) {
      for (let dr = -ring; dr <= ring; dr += 1) {
        if (ring > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        const lot = lotId(col + dc, row + dr);
        if (taken.has(lot)) continue;
        taken.add(lot);
        return lot;
      }
    }
  }
  return null;
}

function slotsToTodos(slots: Slot[], origin: { col: number; row: number }, taken: Set<string>): SceneTodo[] {
  const todos: SceneTodo[] = [];
  let n = 0;
  for (const slot of slots) {
    const item = catalogItem(slot.id);
    if (!item) continue;
    const lot = claimLot(origin.col + slot.dc, origin.row + slot.dr, taken);
    if (!lot) continue;
    n += 1;
    todos.push({
      id: `t${n}`,
      place: slot.id,
      kind: item.kind,
      lot,
      flip: Boolean(slot.flip),
      reason: slot.reason,
    });
  }
  return todos;
}

/**
 * Plan a complete, composed scene for any free-text goal: select the catalog
 * items it's actually about, give each a role (ground, wall, structure,
 * backdrop, track, tabletop, vessel, vehicle, person, scenery), and compose
 * them radially around a focal landmark — people and pets beside the action,
 * food on the tables, a skyline behind, boats offshore, cars on the road,
 * track circling it all, scenery framing the back. Human-locked lots are
 * skipped.
 */
export function planCompleteScene(theme: string, occupiedLots: Iterable<string>): SceneTodo[] {
  const taken = new Set(occupiedLots);
  const seed = hashTheme(theme.trim().toLowerCase() || "scene");
  const items = selectItems(theme, seed);
  return slotsToTodos(composeScene(items, seed), ORIGIN, taken);
}
