import type { CatalogKind } from "../catalog";
import type { PickSpec } from "./pick";
import type { ZoneType } from "./types";

/**
 * Scene archetypes — COMPOSITION RULES, not hard-coded scenes.
 *
 * An archetype says what a kind of place is made of: the zones it needs and
 * where they sit, the element that anchors it, the required and supporting
 * elements each zone holds and HOW they are arranged (around the table,
 * facing the aisle, along the back wall, in rows, scattered under the
 * trees), who lives there, how it is framed, and how you walk through it.
 * The composer turns these rules into a seeded layout; the seed decides
 * which valid variation is built, never whether the rules hold. The
 * validator reads the same rules back to score intent coverage.
 */

export type ZoneLocation = "center" | "north" | "south" | "east" | "west";
export type ZoneSize = "small" | "medium" | "large";

export type ZoneRole = {
  /** Archetype-local id ("picnic", "cooking", "lawn"). */
  role: string;
  /** Engine zone type — decides the architecture the zone brings. */
  type: ZoneType;
  label: string;
  location: ZoneLocation;
  size: ZoneSize;
  purpose: string;
};

/**
 * How an element's pieces are arranged inside its zone.
 *  focal       — the single anchor at the zone focal
 *  on_focal    — tabletop goods packed tight around the anchor (radius 1)
 *  ring_focal  — a loose ring around the anchor at distance 1–2, facing it
 *  beside      — beside pieces of another element (`anchor`), tight
 *  behind      — the cell behind an anchor piece (opposite its facing)
 *  rows_facing — two columns down the zone's long axis, facing the aisle
 *  along_wall  — heavy pieces on the zone's back (north, then west) edge
 *  interior    — inner cells of the zone, off the walls
 *  corners     — the zone's corner cells
 *  lane        — nose-to-tail lanes down the zone's long axis
 *  row         — one line along the zone's long axis, spaced
 *  grid        — a regular grid inside the zone (graves, crops)
 *  scatter     — seeded scatter inside the zone with clearance
 *  perimeter   — the zone's outer edge cells (fences, walls)
 *  path_side   — cells beside the entrance path (lanterns, banners)
 *  entrance    — the first cell of the entrance path (a gate)
 *  pier        — on the harbor pier
 *  cluster     — a loose clump near the zone focal
 */
export type ArrangeKind =
  | "focal"
  | "on_focal"
  | "ring_focal"
  | "beside"
  | "behind"
  | "rows_facing"
  | "along_wall"
  | "interior"
  | "corners"
  | "lane"
  | "row"
  | "grid"
  | "scatter"
  | "perimeter"
  | "path_side"
  | "entrance"
  | "pier"
  | "cluster";

export type Facing = "focal" | "aisle" | "anchor" | "away_wall" | "lane" | "south" | "vary";

export type ElementSpec = {
  role: string;
  label: string;
  pick: PickSpec;
  /** Zone role this element lives in. */
  zone: string;
  arrange: ArrangeKind;
  /** Inclusive count range; the seed picks inside it. */
  count: [number, number];
  /** Element role this one hangs off (beside/behind). */
  anchor?: string;
  face?: Facing;
  /** Intent coverage: the scene is incomplete without it. */
  required?: boolean;
  /** Counted toward supporting-element coverage. */
  supporting?: boolean;
  /** Pack tight (tabletop goods, fences, cones) — flat or thin pieces that may sit shoulder to shoulder. */
  tight?: boolean;
  /** ring_focal: the ring distance to start at (1 = right beside the anchor, 2 = a step back). */
  distance?: 1 | 2 | 3;
  /** Boats: allowed on water. */
  surface?: "water";
  /** Max distinct catalog items (default: count max). */
  variety?: number;
  /** Story reason carried onto every piece. */
  reason: string;
};

export type PeopleSpec = {
  count: [number, number];
  pick: PickSpec;
  /** Zone roles people gather in, in priority order. */
  near: string[];
};

export type Archetype = {
  id: string;
  label: string;
  /** Strong prompt words (weight 2). */
  vocab: string[];
  /** Weak prompt words (weight 1). */
  hints?: string[];
  /** One-line narrative the scene should tell. */
  story: string;
  /** themes.ts id to force; otherwise resolved from the prompt. */
  theme?: string;
  zones: ZoneRole[];
  /** Zone role whose focal holds the scene's anchor. */
  focalZone: string;
  elements: ElementSpec[];
  people: PeopleSpec;
  /** Environmental framing. "theme" defers to the theme's boundary. */
  boundary: "trees" | "stones" | "theme" | "none";
  /** Walks to thread, in order. "entrance" is the coast entrance. */
  paths: { from: string; to: string }[];
  /** Let the selection add harbor/street/skyline zones the prompt implies. */
  extras?: boolean;
  /** Catalog kinds the generic fill may add after the elements (scene texture). */
  fillKinds?: CatalogKind[];
  /** How many generic-fill pieces to allow at most. */
  fillCap?: number;
  /** Ground relief the place wants: flat, seeded, rolling, or mountainous. */
  relief?: "none" | "some" | "hills" | "mountains";
  /** Target pieces per land cell after the density pass (default 0.4). */
  density?: number;
};

const TOWNSFOLK: PickSpec = { kinds: ["character"], packs: ["mini-characters"] };

const FLOWERS: PickSpec = { query: "flower", kinds: ["nature"] };
const BUSHES: PickSpec = {
  ids: ["nature-plant-bush", "nature-plant-bush-detailed", "nature-plant-bush-large", "nature-plant-bush-triangle"],
  query: "bush plant",
  kinds: ["nature"],
};
const FENCE: PickSpec = { ids: ["nature-fence-simple", "nature-fence-simple-high", "nature-fence-simple-low", "nature-fence-planks", "nature-fence-planks-double", "forest-fence"] };
const BENCHES: PickSpec = { ids: ["furniture-bench", "furniture-bench-cushion", "coaster-bench"] };
const ROCKS: PickSpec = { query: "rock small", kinds: ["nature"], exclude: "cliff|flat" };
const MUSHROOMS: PickSpec = { ids: ["nature-mushroom-red-group", "nature-mushroom-tan-group", "nature-mushroom-red", "nature-mushroom-tan"] };
const LAMPS: PickSpec = { ids: ["furniture-lamp-round-floor", "furniture-lamp-square-floor"] };
const HOUSES: PickSpec = {
  ids: [
    "buildings-building-sample-house-a",
    "buildings-building-sample-house-b",
    "buildings-building-sample-house-c",
  ],
};

export const ARCHETYPES: Archetype[] = [
  {
    id: "backyard_picnic",
    relief: "some",
    label: "backyard picnic",
    vocab: ["picnic", "backyard", "barbecue", "bbq", "cookout"],
    hints: ["burger", "burgers", "cake", "lunch", "garden", "party", "yard", "lakeside"],
    story: "Friends gather around a picnic table on the lawn while burgers sizzle on the grill.",
    zones: [
      { role: "picnic", type: "plaza", label: "the picnic lawn", location: "center", size: "large", purpose: "where everyone gathers around the table" },
      { role: "cooking", type: "camp", label: "the grill corner", location: "east", size: "small", purpose: "the grill, kept clear of the seating" },
      { role: "lawn", type: "garden", label: "the garden edge", location: "west", size: "large", purpose: "flowers and shrubs along the fence" },
      { role: "house", type: "skyline", label: "the back of the house", location: "north", size: "medium", purpose: "the house the yard belongs to" },
    ],
    focalZone: "picnic",
    elements: [
      { role: "table", label: "picnic table", zone: "picnic", arrange: "focal", count: [1, 1], required: true, reason: "the picnic table at the heart of it", pick: { ids: ["furniture-table-cloth", "furniture-table-cross-cloth", "furniture-table-round", "furniture-table-cross", "furniture-table"] } },
      { role: "seating", label: "seating around the table", zone: "picnic", arrange: "ring_focal", count: [3, 4], face: "focal", required: true, variety: 2, reason: "seats pulled up to the table", pick: BENCHES },
      { role: "burgers", label: "burgers", zone: "picnic", arrange: "on_focal", count: [2, 3], tight: true, required: true, reason: "burgers on the table", pick: { ids: ["food-burger", "food-burger-cheese", "food-burger-double", "food-burger-cheese-double"] } },
      { role: "cake", label: "cake", zone: "picnic", arrange: "on_focal", count: [1, 1], tight: true, required: true, reason: "the cake, center of attention", pick: { ids: ["food-cake-birthday", "food-cake"] } },
      { role: "drinks", label: "drinks", zone: "picnic", arrange: "on_focal", count: [2, 3], tight: true, supporting: true, reason: "drinks within reach", pick: { ids: ["food-soda", "food-soda-bottle", "food-soda-can", "food-cup", "food-glass", "food-mug"] } },
      { role: "plates", label: "plates", zone: "picnic", arrange: "on_focal", count: [1, 2], tight: true, supporting: true, reason: "plates set out", pick: { ids: ["food-plate", "food-plate-dinner", "food-plate-rectangle"] } },
      { role: "blanket", label: "picnic blanket", zone: "picnic", arrange: "beside", anchor: "table", count: [1, 1], tight: true, supporting: true, reason: "the picnic blanket", pick: { ids: ["furniture-rug-round", "furniture-rug-rectangle", "furniture-rug-square"] } },
      { role: "basket", label: "picnic basket", zone: "picnic", arrange: "beside", anchor: "table", count: [1, 1], supporting: true, reason: "the basket everything came in", pick: { ids: ["market-shopping-basket", "survival-box", "pirate-crate"] } },
      { role: "pets", label: "a pet underfoot", zone: "picnic", arrange: "cluster", count: [1, 2], supporting: true, reason: "the dog hoping for scraps", pick: { ids: ["pets-animal-dog", "pets-animal-cat", "pets-animal-bunny"] } },
      { role: "grill", label: "grill", zone: "cooking", arrange: "focal", count: [1, 1], required: true, reason: "the grill, smoke drifting", pick: { ids: ["nature-campfire-stones", "nature-campfire-bricks", "survival-campfire-stand", "survival-campfire-pit"] } },
      { role: "grill_food", label: "food by the grill", zone: "cooking", arrange: "beside", anchor: "grill", count: [1, 2], tight: true, supporting: true, reason: "waiting for the grill", pick: { ids: ["food-corn-dog", "food-skewer-vegetables", "food-cheese", "food-bread"] } },
      { role: "flowers", label: "flowers", zone: "lawn", arrange: "scatter", count: [4, 7], supporting: true, reason: "flowers along the edge", pick: FLOWERS },
      { role: "bushes", label: "shrubs", zone: "lawn", arrange: "scatter", count: [2, 4], supporting: true, reason: "shrubs by the fence", pick: BUSHES },
      { role: "fence", label: "backyard fence", zone: "lawn", arrange: "perimeter", count: [4, 7], tight: true, supporting: true, variety: 1, reason: "the backyard fence", pick: FENCE },
      { role: "house", label: "the house", zone: "house", arrange: "row", count: [2, 3], supporting: true, reason: "the house the yard belongs to", pick: HOUSES },
    ],
    people: { count: [3, 5], pick: TOWNSFOLK, near: ["picnic", "cooking"] },
    boundary: "trees",
    paths: [
      { from: "entrance", to: "picnic" },
      { from: "picnic", to: "cooking" },
    ],
    extras: true,
    fillKinds: ["nature", "tree", "pet"],
    fillCap: 6,
  },
  {
    id: "graveyard",
    relief: "hills",
    label: "spooky graveyard",
    vocab: ["graveyard", "cemetery", "spooky", "haunted", "halloween", "crypt", "grave", "graves"],
    hints: ["ghost", "dead", "night", "creepy", "tomb", "dark"],
    story: "A crooked path leads through iron gates into rows of graves under dead trees, toward a monument and the crypt beyond.",
    theme: "spooky",
    zones: [
      { role: "cemetery", type: "plaza", label: "the cemetery", location: "center", size: "large", purpose: "rows of graves around the monument" },
      { role: "crypt", type: "keep", label: "the crypt", location: "north", size: "small", purpose: "the raised crypt, reached by its stair" },
      { role: "grove", type: "garden", label: "the dead grove", location: "west", size: "large", purpose: "dead trees and mushrooms at the edge" },
    ],
    focalZone: "cemetery",
    elements: [
      { role: "monument", label: "central monument", zone: "cemetery", arrange: "focal", count: [1, 1], required: true, reason: "the monument at the heart", pick: { ids: ["nature-statue-obelisk", "nature-statue-head", "arena-statue", "nature-statue-ring"] } },
      { role: "graves", label: "graves", zone: "cemetery", arrange: "grid", count: [8, 12], required: true, face: "south", variety: 4, reason: "rows of graves", pick: { ids: ["nature-statue-block", "nature-statue-column-damaged", "nature-stone-tall-a", "nature-stone-tall-b", "nature-stone-tall-c", "nature-rock-tall-a", "nature-rock-tall-b", "nature-stone-tall-d"] } },
      { role: "gate", label: "entrance gate", zone: "cemetery", arrange: "entrance", count: [1, 1], required: true, reason: "the gate you enter through", pick: { ids: ["dungeon-gate", "nature-fence-gate", "market-fence-door-rotate"] } },
      { role: "fence", label: "cemetery fence", zone: "cemetery", arrange: "perimeter", count: [6, 10], tight: true, supporting: true, variety: 1, reason: "the iron fence", pick: FENCE },
      { role: "lanterns", label: "lanterns along the walk", zone: "cemetery", arrange: "path_side", count: [2, 3], tight: true, supporting: true, reason: "lanterns along the walk", pick: LAMPS },
      { role: "pumpkins", label: "pumpkins", zone: "cemetery", arrange: "scatter", count: [2, 4], tight: true, supporting: true, reason: "pumpkins left behind", pick: { ids: ["nature-crop-pumpkin", "food-pumpkin", "food-pumpkin-basic"] } },
      { role: "dead_trees", label: "dead trees", zone: "grove", arrange: "scatter", count: [3, 5], required: true, reason: "the dead grove", pick: { ids: ["nature-tree-oak-dark", "nature-tree-default-dark", "nature-tree-detailed-dark", "nature-tree-blocks-dark", "nature-tree-cone-dark", "nature-tree-fat-darkh"] } },
      { role: "mushrooms", label: "mushrooms", zone: "grove", arrange: "scatter", count: [2, 3], tight: true, supporting: true, reason: "mushrooms in the rot", pick: MUSHROOMS },
      { role: "rocks", label: "loose stones", zone: "grove", arrange: "scatter", count: [2, 4], supporting: true, reason: "old stones", pick: ROCKS },
      { role: "crypt_goods", label: "inside the crypt", zone: "crypt", arrange: "along_wall", count: [3, 5], face: "away_wall", supporting: true, reason: "what the crypt keeps", pick: { ids: ["dungeon-chest", "dungeon-column", "dungeon-pot", "dungeon-table", "dungeon-banner"] } },
    ],
    people: { count: [2, 3], pick: { ids: ["dungeon-character-orc", "dungeon-character-human", "characters-character-female-d", "characters-character-male-e"], kinds: ["character"] }, near: ["cemetery", "crypt"] },
    boundary: "trees",
    paths: [
      { from: "entrance", to: "cemetery" },
      { from: "cemetery", to: "crypt" },
    ],
    fillKinds: ["nature"],
    fillCap: 4,
  },
  {
    id: "market",
    relief: "some",
    label: "market",
    vocab: ["market", "bazaar", "grocery", "shop", "shopping", "bakery", "vendors", "stalls"],
    hints: ["medieval", "food", "fruit", "bread", "farmer", "farmers", "square", "plaza", "fountain"],
    story: "Shoppers wander a square where vendors stand behind their stalls, goods on display, stock stacked in the back lot.",
    zones: [
      { role: "square", type: "plaza", label: "the market square", location: "center", size: "large", purpose: "the open square shoppers cross" },
      { role: "stalls", type: "market", label: "the market row", location: "east", size: "large", purpose: "stalls facing the aisle" },
      { role: "storage", type: "workshop", label: "the back lot", location: "north", size: "medium", purpose: "crates and barrels behind the stalls" },
    ],
    focalZone: "square",
    elements: [
      { role: "fountain", label: "fountain", zone: "square", arrange: "focal", count: [1, 1], required: true, reason: "the fountain in the square", pick: { ids: ["nature-statue-ring", "nature-statue-head", "market-column", "nature-statue-obelisk"] } },
      { role: "stalls", label: "market stalls", zone: "stalls", arrange: "rows_facing", count: [4, 6], face: "aisle", required: true, reason: "among the market stalls", pick: { ids: ["market-display-fruit", "market-display-bread", "market-shelf-bags", "market-shelf-boxes", "market-shelf-end", "coaster-stall-food", "coaster-stall-drinks", "market-freezer"] } },
      { role: "goods", label: "goods on display", zone: "stalls", arrange: "beside", anchor: "stalls", count: [4, 8], tight: true, required: true, reason: "goods on display", pick: { ids: ["food-apple", "food-bread", "food-loaf-baguette", "food-cheese", "food-pumpkin", "food-cabbage", "food-cauliflower", "food-carton"] } },
      { role: "vendors", label: "vendors", zone: "stalls", arrange: "behind", anchor: "stalls", count: [1, 2], face: "anchor", required: true, reason: "the vendor behind the counter", pick: { ids: ["market-character-employee", "characters-character-male-b"], kinds: ["character"] } },
      { role: "carts", label: "shopping carts", zone: "stalls", arrange: "cluster", count: [1, 2], supporting: true, reason: "a cart left in the aisle", pick: { ids: ["market-shopping-cart", "market-shopping-basket"] } },
      { role: "stock", label: "stock in the back", zone: "storage", arrange: "cluster", count: [3, 5], supporting: true, reason: "stock in the back lot", pick: { ids: ["pirate-crate", "dungeon-barrel", "survival-box-large", "survival-box", "survival-barrel"] } },
      { role: "benches", label: "benches", zone: "square", arrange: "ring_focal", count: [2, 2], face: "focal", supporting: true, reason: "a bench by the fountain", pick: BENCHES },
      { role: "banners", label: "banners", zone: "square", arrange: "path_side", count: [2, 3], tight: true, supporting: true, reason: "banners along the way in", pick: { ids: ["arena-banner", "dungeon-banner", "forest-flag"] } },
      { role: "sign", label: "sign at the entrance", zone: "square", arrange: "entrance", count: [1, 1], supporting: true, reason: "the sign at the entrance", pick: { ids: ["nature-sign", "survival-signpost"] } },
      { role: "planters", label: "planters", zone: "square", arrange: "scatter", count: [2, 3], supporting: true, reason: "planters around the square", pick: { ids: ["nature-pot-small", "nature-pot-large", "coaster-flowers"] } },
    ],
    people: { count: [4, 6], pick: TOWNSFOLK, near: ["stalls", "square"] },
    boundary: "theme",
    paths: [
      { from: "entrance", to: "square" },
      { from: "square", to: "stalls" },
      { from: "stalls", to: "storage" },
    ],
    extras: true,
    fillKinds: ["nature", "tree"],
    fillCap: 4,
  },
  {
    id: "house",
    relief: "some",
    label: "house",
    vocab: ["house", "home", "apartment", "cottage", "bedroom", "kitchen", "interior"],
    hints: ["cozy", "living", "room", "lounge", "sofa", "couch", "family"],
    story: "A small house with a kitchen wall, a dining table with chairs, a bed in the corner, and a front yard with flowers.",
    zones: [
      { role: "house", type: "home", label: "the house", location: "north", size: "large", purpose: "one lived-in room: kitchen, table, sofa, bed" },
      { role: "yard", type: "garden", label: "the front yard", location: "south", size: "large", purpose: "the yard you cross to reach the door" },
    ],
    focalZone: "house",
    elements: [
      { role: "table", label: "dining table", zone: "house", arrange: "focal", count: [1, 1], required: true, reason: "the dining table", pick: { ids: ["furniture-table", "furniture-table-cloth", "furniture-table-round"] } },
      { role: "bed", label: "bed", zone: "house", arrange: "along_wall", count: [1, 1], face: "away_wall", required: true, reason: "the bed against the wall", pick: { ids: ["furniture-bed-double", "furniture-bed-single"] } },
      { role: "kitchen", label: "kitchen", zone: "house", arrange: "along_wall", count: [3, 3], face: "away_wall", required: true, reason: "the kitchen wall", pick: { ids: ["furniture-kitchen-fridge", "furniture-kitchen-stove", "furniture-kitchen-sink"] } },
      { role: "chairs", label: "chairs at the table", zone: "house", arrange: "ring_focal", count: [2, 2], face: "focal", required: true, variety: 1, reason: "chairs at the table", pick: { ids: ["furniture-chair", "furniture-chair-cushion", "furniture-chair-rounded"] } },
      { role: "sofa", label: "sofa", zone: "house", arrange: "interior", count: [1, 1], face: "south", required: true, reason: "the sofa", pick: { ids: ["furniture-lounge-sofa", "furniture-lounge-sofa-long"] } },
      { role: "tv", label: "television", zone: "house", arrange: "beside", anchor: "sofa", count: [1, 1], face: "anchor", supporting: true, reason: "the television the sofa faces", pick: { ids: ["furniture-television-vintage", "furniture-cabinet-television"] } },
      { role: "bookcase", label: "bookcase", zone: "house", arrange: "along_wall", count: [1, 1], face: "away_wall", supporting: true, reason: "the bookcase", pick: { ids: ["furniture-bookcase-open", "furniture-bookcase-closed"] } },
      { role: "lamps", label: "lamps", zone: "house", arrange: "corners", count: [1, 2], tight: true, supporting: true, reason: "a lamp in the corner", pick: LAMPS },
      { role: "rug", label: "rug", zone: "house", arrange: "beside", anchor: "table", count: [1, 1], tight: true, supporting: true, reason: "the rug", pick: { ids: ["furniture-rug-rectangle", "furniture-rug-round"] } },
      { role: "plants", label: "house plants", zone: "house", arrange: "corners", count: [1, 2], tight: true, supporting: true, reason: "a plant by the wall", pick: { ids: ["furniture-potted-plant", "furniture-plant-small1", "furniture-plant-small2"] } },
      { role: "yard_trees", label: "trees in the yard", zone: "yard", arrange: "scatter", count: [1, 2], supporting: true, reason: "trees in the yard", pick: { ids: ["nature-tree-oak", "nature-tree-default", "nature-tree-detailed"], query: "tree", kinds: ["tree"] } },
      { role: "flowers", label: "flowers", zone: "yard", arrange: "scatter", count: [3, 5], supporting: true, reason: "flowers by the path", pick: FLOWERS },
      { role: "fence", label: "front fence", zone: "yard", arrange: "perimeter", count: [4, 6], tight: true, supporting: true, variety: 1, reason: "the front fence", pick: FENCE },
      { role: "pet", label: "a pet", zone: "yard", arrange: "cluster", count: [1, 1], supporting: true, reason: "the dog in the yard", pick: { ids: ["pets-animal-dog", "pets-animal-cat"] } },
    ],
    people: { count: [2, 3], pick: TOWNSFOLK, near: ["house", "plaza", "yard"] },
    boundary: "trees",
    paths: [
      { from: "entrance", to: "house" },
      { from: "house", to: "yard" },
    ],
    fillKinds: ["nature", "tree"],
    fillCap: 3,
  },
  {
    id: "castle",
    relief: "mountains",
    label: "castle",
    vocab: ["castle", "keep", "fortress", "dungeon", "lair", "stronghold"],
    hints: ["medieval", "knight", "knights", "orc", "hill", "tower", "towers", "courtyard", "haunted"],
    story: "Through the gatehouse into a walled courtyard with towers at the corners, and up the stair to the great hall.",
    theme: "courtyard",
    zones: [
      { role: "courtyard", type: "plaza", label: "the courtyard", location: "center", size: "large", purpose: "the walled yard inside the gate" },
      { role: "hall", type: "keep", label: "the great hall", location: "north", size: "large", purpose: "the raised hall, throne at the back" },
    ],
    focalZone: "courtyard",
    elements: [
      { role: "well", label: "courtyard well", zone: "courtyard", arrange: "focal", count: [1, 1], required: true, reason: "the well in the courtyard", pick: { ids: ["nature-statue-ring", "arena-statue", "nature-statue-obelisk"] } },
      { role: "gate", label: "gatehouse", zone: "courtyard", arrange: "entrance", count: [1, 1], required: true, reason: "the gatehouse", pick: { ids: ["dungeon-gate", "arena-wall-gate", "pirate-castle-gate"] } },
      { role: "walls", label: "curtain wall", zone: "courtyard", arrange: "perimeter", count: [6, 10], tight: true, required: true, variety: 1, reason: "the curtain wall", pick: { ids: ["arena-wall", "dungeon-wall", "pirate-castle-wall"] } },
      { role: "towers", label: "towers", zone: "courtyard", arrange: "corners", count: [2, 4], required: true, variety: 2, reason: "a tower at the corner", pick: { ids: ["pirate-tower-complete-small", "pirate-tower-watch", "buildings-building-sample-tower-a"] } },
      { role: "banners", label: "banners", zone: "courtyard", arrange: "path_side", count: [2, 4], tight: true, supporting: true, reason: "banners along the approach", pick: { ids: ["arena-banner", "dungeon-banner", "pirate-flag-pennant"] } },
      { role: "barrels", label: "barrels", zone: "courtyard", arrange: "cluster", count: [2, 3], supporting: true, reason: "barrels by the wall", pick: { ids: ["dungeon-barrel", "pirate-barrel", "survival-barrel"] } },
      { role: "throne", label: "throne", zone: "hall", arrange: "along_wall", count: [1, 1], face: "away_wall", supporting: true, reason: "the throne at the back of the hall", pick: { ids: ["dungeon-chair"] } },
      { role: "hall_table", label: "hall table", zone: "hall", arrange: "interior", count: [1, 2], supporting: true, reason: "the long table in the hall", pick: { ids: ["dungeon-table"] } },
      { role: "treasure", label: "treasure", zone: "hall", arrange: "along_wall", count: [1, 2], face: "away_wall", supporting: true, reason: "the treasury", pick: { ids: ["dungeon-chest", "pirate-chest"] } },
      { role: "weapons", label: "weapons", zone: "hall", arrange: "along_wall", count: [1, 2], face: "away_wall", supporting: true, reason: "arms on the wall", pick: { ids: ["arena-weapon-rack", "dungeon-shield-round", "dungeon-weapon-sword"] } },
      { role: "columns", label: "columns", zone: "hall", arrange: "corners", count: [2, 2], supporting: true, variety: 1, reason: "columns holding the roof", pick: { ids: ["dungeon-column", "arena-column"] } },
    ],
    people: { count: [3, 5], pick: { ids: ["arena-character-soldier", "dungeon-character-human", "dungeon-character-orc", "characters-character-male-a", "characters-character-female-c"], kinds: ["character"] }, near: ["courtyard", "hall"] },
    boundary: "theme",
    paths: [
      { from: "entrance", to: "courtyard" },
      { from: "courtyard", to: "hall" },
    ],
    fillKinds: ["nature"],
    fillCap: 3,
  },
  {
    id: "forest_camp",
    relief: "mountains",
    label: "forest camp",
    vocab: ["camp", "camping", "campsite", "forest", "woods", "woodland", "wilderness", "cabin"],
    hints: ["quiet", "campfire", "tent", "tents", "hike", "cave", "survival", "homestead"],
    story: "Tents circle a campfire in a clearing, logs pulled up to the flames, the deep wood pressing in on every side.",
    theme: "forest",
    zones: [
      { role: "campsite", type: "plaza", label: "the campsite", location: "center", size: "medium", purpose: "the clearing around the fire" },
      { role: "wood", type: "garden", label: "the deep wood", location: "east", size: "large", purpose: "dense trees, mushrooms, and what lives there" },
    ],
    focalZone: "campsite",
    elements: [
      { role: "campfire", label: "campfire", zone: "campsite", arrange: "focal", count: [1, 1], required: true, reason: "the campfire", pick: { ids: ["nature-campfire-stones", "nature-campfire-logs", "survival-campfire-pit", "survival-campfire-stand"] } },
      { role: "tents", label: "tents", zone: "campsite", arrange: "ring_focal", distance: 2, count: [2, 3], face: "focal", required: true, variety: 2, reason: "tents around the fire", pick: { ids: ["nature-tent-detailed-open", "nature-tent-small-open", "forest-tent", "survival-tent"] } },
      { role: "logs", label: "logs to sit on", zone: "campsite", arrange: "ring_focal", count: [2, 3], face: "focal", required: true, reason: "logs pulled up to the fire", pick: { ids: ["nature-log", "nature-log-large", "nature-stump-round"] } },
      { role: "supplies", label: "supplies", zone: "campsite", arrange: "cluster", count: [2, 3], supporting: true, reason: "supplies stacked by the tents", pick: { ids: ["survival-box", "survival-barrel", "survival-bucket", "survival-bedroll"] } },
      { role: "trees", label: "the deep wood", zone: "wood", arrange: "scatter", count: [4, 6], required: true, variety: 4, reason: "the deep wood", pick: { query: "tree pine", kinds: ["tree"] } },
      { role: "mushrooms", label: "mushrooms", zone: "wood", arrange: "scatter", count: [2, 4], tight: true, supporting: true, reason: "mushrooms under the trees", pick: MUSHROOMS },
      { role: "rocks", label: "rocks", zone: "wood", arrange: "scatter", count: [2, 4], supporting: true, reason: "rocks among the roots", pick: ROCKS },
      { role: "stumps", label: "stumps", zone: "wood", arrange: "scatter", count: [1, 2], supporting: true, reason: "an old stump", pick: { ids: ["nature-stump-old", "nature-stump-square"] } },
      { role: "wildlife", label: "wildlife", zone: "wood", arrange: "cluster", count: [1, 2], supporting: true, reason: "something watching from the trees", pick: { ids: ["pets-animal-fox", "pets-animal-deer", "pets-animal-bunny"] } },
    ],
    people: { count: [2, 3], pick: { ids: ["forest-character-archer", "characters-character-male-c", "characters-character-female-b"], kinds: ["character"] }, near: ["campsite", "wood"] },
    boundary: "trees",
    paths: [{ from: "entrance", to: "campsite" }],
    extras: true,
    fillKinds: ["nature", "tree"],
    fillCap: 6,
  },
  {
    id: "harbor",
    relief: "hills",
    label: "harbor",
    vocab: ["harbor", "harbour", "dock", "marina", "port", "pier", "shore"],
    hints: ["boat", "boats", "pirate", "fishing", "sail", "sea", "island", "sunset", "ship", "ships"],
    story: "Boats ride at anchor off a pier while cargo stacks up on the quay and gulls wheel over the sheds.",
    zones: [
      { role: "quay", type: "plaza", label: "the quay", location: "center", size: "large", purpose: "cargo and crews on the waterfront" },
      { role: "harbor", type: "harbor", label: "the harbor", location: "east", size: "large", purpose: "the water and the pier" },
      { role: "sheds", type: "workshop", label: "the quay sheds", location: "north", size: "small", purpose: "nets, fish, and tackle" },
    ],
    focalZone: "harbor",
    elements: [
      { role: "flagship", label: "flagship", zone: "harbor", arrange: "focal", count: [1, 1], surface: "water", required: true, reason: "flagship off the shore", pick: { ids: ["pirate-ship-pirate-large", "pirate-ship-pirate-medium", "watercraft-boat-sail-a", "pirate-ship-large", "watercraft-boat-fishing-small"], kinds: ["boat"] } },
      { role: "boats", label: "boats at anchor", zone: "harbor", arrange: "scatter", count: [2, 4], surface: "water", required: true, reason: "riding at anchor", pick: { query: "boat", kinds: ["boat"], exclude: "ship-large|ocean-liner|cargo|tow" } },
      { role: "dock", label: "dock", zone: "harbor", arrange: "pier", count: [1, 2], supporting: true, reason: "out over the water", pick: { ids: ["pirate-structure-platform-dock", "pirate-structure-platform"] } },
      { role: "cargo", label: "cargo on the quay", zone: "quay", arrange: "cluster", count: [3, 5], required: true, reason: "cargo on the quay", pick: { ids: ["pirate-crate", "pirate-barrel", "pirate-crate-bottles", "survival-box-large"] } },
      { role: "cannon", label: "cannon", zone: "quay", arrange: "ring_focal", count: [1, 1], face: "focal", supporting: true, reason: "the cannon guarding the harbor", pick: { ids: ["pirate-cannon", "pirate-cannon-mobile"] } },
      { role: "flags", label: "flags", zone: "quay", arrange: "path_side", count: [1, 2], supporting: true, reason: "flags snapping in the wind", pick: { ids: ["pirate-flag", "pirate-flag-pirate", "pirate-flag-pennant"] } },
      { role: "tackle", label: "nets and fish", zone: "sheds", arrange: "cluster", count: [2, 3], supporting: true, reason: "the day's catch", pick: { ids: ["survival-fish", "survival-campfire-fishing-stand", "pirate-bottle", "survival-bucket"] } },
      { role: "palms", label: "palms", zone: "quay", arrange: "scatter", count: [2, 3], supporting: true, reason: "palms on the waterfront", pick: { ids: ["nature-tree-palm", "nature-tree-palm-bend", "pirate-palm-straight"] } },
    ],
    people: { count: [3, 4], pick: TOWNSFOLK, near: ["quay"] },
    boundary: "theme",
    paths: [{ from: "entrance", to: "quay" }],
    extras: true,
    fillKinds: ["pirate", "crate"],
    fillCap: 4,
  },
  {
    id: "arcade",
    relief: "some",
    label: "arcade",
    vocab: ["arcade", "pinball", "claw", "gaming"],
    hints: ["night", "midnight", "snack", "games", "retro", "machines"],
    story: "Cabinets glow along the walls of the hall while gamers crowd the star machine and a snack stand waits out front.",
    zones: [
      { role: "hall", type: "arcade", label: "the arcade hall", location: "north", size: "large", purpose: "cabinets along the walls" },
      { role: "front", type: "plaza", label: "out front", location: "center", size: "medium", purpose: "the snack stand and the crowd outside" },
    ],
    focalZone: "hall",
    elements: [
      { role: "star", label: "the star cabinet", zone: "hall", arrange: "focal", count: [1, 1], required: true, reason: "the star cabinet", pick: { ids: ["arcade-claw-machine", "arcade-dance-machine", "arcade-pinball"] } },
      { role: "machines", label: "arcade machines", zone: "hall", arrange: "along_wall", count: [4, 6], face: "away_wall", required: true, reason: "cabinets along the wall", pick: { ids: ["arcade-arcade-machine", "arcade-pinball", "arcade-air-hockey", "arcade-basketball-game", "arcade-gambling-machine", "arcade-dance-machine"] } },
      { role: "prizes", label: "prizes", zone: "hall", arrange: "interior", count: [1, 2], supporting: true, reason: "the prize counter", pick: { ids: ["arcade-prizes", "arcade-prize-wheel", "arcade-ticket-machine"] } },
      { role: "register", label: "register", zone: "hall", arrange: "corners", count: [1, 1], supporting: true, reason: "the register", pick: { ids: ["arcade-cash-register", "arcade-vending-machine"] } },
      { role: "snacks", label: "snack stand", zone: "front", arrange: "cluster", count: [1, 2], supporting: true, reason: "the snack stand out front", pick: { ids: ["coaster-stall-food", "coaster-stall-drinks"] } },
      { role: "benches", label: "benches", zone: "front", arrange: "cluster", count: [1, 2], supporting: true, reason: "a bench out front", pick: BENCHES },
      { role: "sign", label: "sign", zone: "front", arrange: "entrance", count: [1, 1], supporting: true, reason: "the sign out front", pick: { ids: ["nature-sign", "survival-signpost"] } },
    ],
    people: { count: [3, 5], pick: { ids: ["arcade-character-gamer", "arcade-character-employee", "characters-character-female-a", "characters-character-male-d"], kinds: ["character"] }, near: ["hall", "front"] },
    boundary: "theme",
    paths: [
      { from: "entrance", to: "front" },
      { from: "front", to: "hall" },
    ],
    fillKinds: ["machine"],
    fillCap: 3,
  },
  {
    id: "village",
    relief: "hills",
    label: "village",
    vocab: ["village", "neighborhood", "neighbourhood", "hamlet", "town"],
    hints: ["houses", "folk", "square", "little", "cottages", "villagers"],
    story: "Houses shoulder together above a square with a well, allotments to one side, villagers about their day.",
    zones: [
      { role: "square", type: "plaza", label: "the village square", location: "center", size: "large", purpose: "the well and the villagers" },
      { role: "homes", type: "skyline", label: "the houses on the rise", location: "north", size: "large", purpose: "the houses" },
      { role: "allotments", type: "garden", label: "the allotments", location: "west", size: "medium", purpose: "crops behind a fence" },
    ],
    focalZone: "square",
    elements: [
      { role: "well", label: "village well", zone: "square", arrange: "focal", count: [1, 1], required: true, reason: "the well in the square", pick: { ids: ["nature-statue-ring", "nature-statue-obelisk", "nature-statue-head"] } },
      { role: "houses", label: "houses", zone: "homes", arrange: "row", count: [3, 4], required: true, reason: "the houses on the rise", pick: HOUSES },
      { role: "benches", label: "benches", zone: "square", arrange: "ring_focal", count: [2, 3], face: "focal", supporting: true, reason: "a bench by the well", pick: BENCHES },
      { role: "stall", label: "a stall", zone: "square", arrange: "cluster", count: [1, 2], face: "focal", supporting: true, reason: "a stall on market day", pick: { ids: ["market-display-fruit", "market-display-bread"] } },
      { role: "crops", label: "crops", zone: "allotments", arrange: "grid", count: [3, 6], supporting: true, reason: "crops in the allotments", pick: { ids: ["nature-crops-wheat-stage-a", "nature-crop-carrot", "nature-crop-melon", "nature-crop-turnip", "nature-crops-corn-stage-a"] } },
      { role: "fence", label: "allotment fence", zone: "allotments", arrange: "perimeter", count: [4, 6], tight: true, supporting: true, variety: 1, reason: "the allotment fence", pick: FENCE },
      { role: "flowers", label: "flowers", zone: "square", arrange: "scatter", count: [2, 3], supporting: true, reason: "flowers in the square", pick: FLOWERS },
      { role: "animals", label: "animals", zone: "allotments", arrange: "cluster", count: [1, 2], supporting: true, reason: "the village animals", pick: { ids: ["pets-animal-dog", "pets-animal-cat", "pets-animal-cow", "pets-animal-chick"] } },
    ],
    people: { count: [4, 6], pick: TOWNSFOLK, near: ["square", "allotments"] },
    boundary: "trees",
    paths: [
      { from: "entrance", to: "square" },
      { from: "square", to: "allotments" },
    ],
    extras: true,
    fillKinds: ["nature", "tree"],
    fillCap: 5,
  },
  {
    id: "street",
    relief: "some",
    label: "city street",
    vocab: ["traffic", "street", "downtown", "avenue", "highway", "city"],
    hints: ["jam", "cars", "parked", "urban", "road", "rush"],
    story: "Traffic backs up along the avenue under the skyline while people wait it out on the sidewalk.",
    zones: [
      { role: "sidewalk", type: "plaza", label: "the sidewalk", location: "center", size: "medium", purpose: "where people wait out the jam" },
      { role: "road", type: "street", label: "the avenue", location: "south", size: "large", purpose: "lanes of stalled traffic" },
      { role: "blocks", type: "skyline", label: "the skyline", location: "north", size: "large", purpose: "the buildings behind it all" },
    ],
    focalZone: "road",
    elements: [
      { role: "truck", label: "the truck", zone: "road", arrange: "focal", count: [1, 1], face: "lane", required: true, reason: "the truck stuck in the jam", pick: { ids: ["car-firetruck", "car-garbage-truck", "car-ambulance"] } },
      { role: "cars", label: "cars", zone: "road", arrange: "lane", count: [6, 9], face: "lane", required: true, variety: 6, reason: "backed up in the jam", pick: { query: "car", kinds: ["car"], packs: ["car"], exclude: "kart|race|tractor" } },
      { role: "cones", label: "traffic cones", zone: "road", arrange: "scatter", count: [2, 3], tight: true, supporting: true, reason: "cones in the road", pick: { ids: ["car-cone", "car-cone-flat"] } },
      { role: "buildings", label: "the skyline", zone: "blocks", arrange: "row", count: [3, 4], required: true, reason: "the skyline", pick: { ids: ["buildings-building-sample-tower-a", "buildings-building-sample-tower-b", "buildings-building-sample-tower-c", "buildings-building-sample-tower-d", "buildings-building-sample-house-a"] } },
      { role: "lamps", label: "street lamps", zone: "sidewalk", arrange: "path_side", count: [2, 3], tight: true, supporting: true, reason: "street lamps", pick: LAMPS },
      { role: "benches", label: "benches", zone: "sidewalk", arrange: "cluster", count: [1, 2], supporting: true, reason: "a bench on the sidewalk", pick: BENCHES },
      { role: "planters", label: "planters", zone: "sidewalk", arrange: "scatter", count: [2, 3], supporting: true, reason: "planters on the sidewalk", pick: { ids: ["nature-pot-large", "coaster-flowers", "nature-pot-small"] } },
    ],
    people: { count: [3, 4], pick: TOWNSFOLK, near: ["sidewalk"] },
    boundary: "none",
    paths: [{ from: "entrance", to: "sidewalk" }],
    fillKinds: ["prop"],
    fillCap: 3,
  },
  {
    id: "skate_park",
    relief: "some",
    label: "skate park",
    vocab: ["skate", "skatepark", "skateboard", "skaters"],
    hints: ["park", "half", "pipe", "ramp", "ramps", "rail"],
    story: "Skaters drop into the half pipe while friends watch from the rails and benches along the fence.",
    zones: [
      { role: "park", type: "plaza", label: "the skate park", location: "center", size: "large", purpose: "ramps and rails" },
      { role: "edge", type: "garden", label: "the grass edge", location: "west", size: "medium", purpose: "a strip of grass to sit on" },
    ],
    focalZone: "park",
    elements: [
      { role: "halfpipe", label: "half pipe", zone: "park", arrange: "focal", count: [1, 1], required: true, reason: "the half pipe", pick: { ids: ["skate-half-pipe", "skate-bowl-side"] } },
      { role: "ramps", label: "ramps and rails", zone: "park", arrange: "scatter", count: [5, 8], required: true, variety: 5, reason: "ramps and rails", pick: { ids: ["skate-bowl-side", "skate-bowl-corner-outer", "skate-rail-high", "skate-rail-low", "skate-rail-slope", "skate-obstacle-box", "skate-obstacle-middle", "skate-obstacle-end", "skate-steps", "skate-structure-platform"] } },
      { role: "boards", label: "skateboards", zone: "park", arrange: "scatter", count: [1, 2], tight: true, supporting: true, reason: "a board left on the ground", pick: { ids: ["skate-skateboard", "skate-pallet"] } },
      { role: "benches", label: "benches", zone: "edge", arrange: "cluster", count: [2, 2], supporting: true, reason: "benches to watch from", pick: BENCHES },
      { role: "fence", label: "park fence", zone: "park", arrange: "perimeter", count: [6, 8], tight: true, supporting: true, variety: 1, reason: "the park fence", pick: FENCE },
      { role: "trees", label: "trees", zone: "edge", arrange: "scatter", count: [2, 3], supporting: true, reason: "shade at the edge", pick: { query: "tree", kinds: ["tree"], exclude: "palm|dark|dead" } },
    ],
    people: { count: [3, 4], pick: { ids: ["skate-character-skate-boy", "skate-character-skate-girl", "characters-character-male-f", "characters-character-female-f"], kinds: ["character"] }, near: ["park", "edge"] },
    boundary: "theme",
    paths: [{ from: "entrance", to: "park" }],
    fillKinds: ["ramp", "prop"],
    fillCap: 3,
  },
  {
    id: "arena",
    relief: "some",
    label: "arena",
    vocab: ["arena", "colosseum", "battle", "gladiator", "tournament"],
    hints: ["after", "fight", "soldiers", "stadium", "war"],
    story: "The arena floor lies quiet after the bout, weapons racked in the armory, banners still up along the wall.",
    theme: "courtyard",
    zones: [
      { role: "floor", type: "plaza", label: "the arena floor", location: "center", size: "large", purpose: "the walled fighting floor" },
      { role: "armory", type: "keep", label: "the armory", location: "north", size: "small", purpose: "weapons racked above the floor" },
    ],
    focalZone: "floor",
    elements: [
      { role: "statue", label: "the victor's statue", zone: "floor", arrange: "focal", count: [1, 1], required: true, reason: "the victor's statue", pick: { ids: ["arena-statue", "arena-trophy", "nature-statue-head"] } },
      { role: "walls", label: "arena wall", zone: "floor", arrange: "perimeter", count: [8, 12], tight: true, required: true, variety: 2, reason: "the arena wall", pick: { ids: ["arena-wall", "arena-border-straight", "arena-wall-gate", "arena-wall-corner"] } },
      { role: "columns", label: "columns", zone: "floor", arrange: "corners", count: [2, 4], supporting: true, reason: "columns at the corners", pick: { ids: ["arena-column", "arena-column-damaged"] } },
      { role: "banners", label: "banners", zone: "floor", arrange: "path_side", count: [2, 4], tight: true, supporting: true, reason: "banners along the way in", pick: { ids: ["arena-banner", "dungeon-banner"] } },
      { role: "rubble", label: "rubble", zone: "floor", arrange: "scatter", count: [2, 3], supporting: true, reason: "rubble of the last bout", pick: { ids: ["arena-bricks", "arena-block", "dungeon-rocks"] } },
      { role: "weapons", label: "weapons", zone: "armory", arrange: "along_wall", count: [2, 4], face: "away_wall", supporting: true, reason: "arms in the armory", pick: { ids: ["arena-weapon-rack", "arena-weapon-sword", "arena-weapon-spear", "dungeon-shield-rectangle"] } },
    ],
    people: { count: [3, 5], pick: { ids: ["arena-character-soldier", "dungeon-character-orc", "dungeon-character-human", "characters-character-male-b"], kinds: ["character"] }, near: ["floor", "armory"] },
    boundary: "theme",
    paths: [
      { from: "entrance", to: "floor" },
      { from: "floor", to: "armory" },
    ],
    fillKinds: ["prop"],
    fillCap: 2,
  },
  {
    id: "farm",
    relief: "hills",
    label: "farm",
    vocab: ["farm", "farmyard", "barnyard", "zoo", "ranch", "pens"],
    hints: ["animals", "pets", "cube", "crops", "cow", "pig", "chick", "petting"],
    story: "Animals in fenced pens beside a field of crops, tools and hay by the farmhouse.",
    theme: "grassland",
    zones: [
      { role: "yard", type: "plaza", label: "the farmyard", location: "center", size: "medium", purpose: "the yard between the pens and the field" },
      { role: "pens", type: "garden", label: "the pens", location: "east", size: "large", purpose: "animals behind a fence" },
      { role: "field", type: "garden", label: "the field", location: "west", size: "medium", purpose: "rows of crops" },
      { role: "barn", type: "skyline", label: "the farmhouse", location: "north", size: "small", purpose: "the farmhouse" },
    ],
    focalZone: "yard",
    elements: [
      { role: "hay", label: "hay and logs", zone: "yard", arrange: "focal", count: [1, 1], required: true, reason: "the woodpile in the yard", pick: { ids: ["nature-log-stack-large", "nature-log-stack", "survival-box-large"] } },
      { role: "animals", label: "animals", zone: "pens", arrange: "scatter", count: [4, 7], required: true, variety: 6, face: "vary", reason: "the animals in their pens", pick: { query: "animal", kinds: ["pet"], exclude: "fish|crab|bee|caterpillar|penguin|polar" } },
      { role: "pen_fence", label: "pen fence", zone: "pens", arrange: "perimeter", count: [6, 9], tight: true, required: true, variety: 1, reason: "the pen fence", pick: FENCE },
      { role: "crops", label: "crops", zone: "field", arrange: "grid", count: [6, 10], required: true, variety: 3, reason: "rows of crops", pick: { ids: ["nature-crops-wheat-stage-a", "nature-crops-corn-stage-a", "nature-crop-carrot", "nature-crop-melon", "nature-crop-turnip", "nature-crop-pumpkin"] } },
      { role: "tools", label: "tools", zone: "yard", arrange: "cluster", count: [2, 3], supporting: true, reason: "tools left by the door", pick: { ids: ["survival-tool-hoe", "survival-tool-shovel", "survival-bucket", "survival-barrel"] } },
      { role: "farmhouse", label: "farmhouse", zone: "barn", arrange: "row", count: [1, 2], supporting: true, reason: "the farmhouse", pick: HOUSES },
      { role: "trees", label: "trees", zone: "field", arrange: "scatter", count: [1, 2], supporting: true, reason: "a tree at the field's edge", pick: { query: "tree oak", kinds: ["tree"] } },
    ],
    people: { count: [2, 3], pick: TOWNSFOLK, near: ["yard", "pens"] },
    boundary: "trees",
    paths: [
      { from: "entrance", to: "yard" },
      { from: "yard", to: "pens" },
    ],
    fillKinds: ["nature", "pet"],
    fillCap: 4,
  },
  {
    id: "park",
    relief: "some",
    label: "park",
    vocab: ["park", "garden", "meadow", "orchard", "gardens"],
    hints: ["trees", "flowers", "crops", "statue", "bench", "benches", "pond"],
    story: "Paths wind through flower beds and trees to a statue at the center, benches turned toward it.",
    theme: "garden",
    zones: [
      { role: "lawn", type: "plaza", label: "the lawn", location: "center", size: "large", purpose: "the open lawn around the statue" },
      { role: "beds", type: "garden", label: "the flower beds", location: "west", size: "large", purpose: "beds of flowers and shrubs" },
      { role: "orchard", type: "garden", label: "the orchard", location: "east", size: "medium", purpose: "trees and crops in rows" },
    ],
    focalZone: "lawn",
    elements: [
      { role: "statue", label: "garden statue", zone: "lawn", arrange: "focal", count: [1, 1], required: true, reason: "the statue at the center", pick: { ids: ["nature-statue-ring", "nature-statue-head", "nature-statue-obelisk", "nature-statue-column"] } },
      { role: "benches", label: "benches", zone: "lawn", arrange: "ring_focal", count: [2, 3], face: "focal", required: true, reason: "benches turned to the statue", pick: BENCHES },
      { role: "flowers", label: "flowers", zone: "beds", arrange: "scatter", count: [6, 10], required: true, variety: 5, reason: "the flower beds", pick: FLOWERS },
      { role: "bushes", label: "shrubs", zone: "beds", arrange: "scatter", count: [2, 4], supporting: true, reason: "shrubs between the beds", pick: BUSHES },
      { role: "trees", label: "trees", zone: "orchard", arrange: "grid", count: [4, 6], required: true, variety: 2, reason: "the orchard", pick: { ids: ["nature-tree-oak", "nature-tree-default", "nature-tree-detailed", "nature-tree-fat"] } },
      { role: "crops", label: "crops", zone: "orchard", arrange: "scatter", count: [2, 4], supporting: true, reason: "crops under the trees", pick: { ids: ["nature-crop-carrot", "nature-crop-melon", "nature-crop-turnip"] } },
      { role: "pots", label: "planters", zone: "lawn", arrange: "path_side", count: [2, 3], supporting: true, reason: "planters along the path", pick: { ids: ["nature-pot-small", "nature-pot-large"] } },
      { role: "fence", label: "garden fence", zone: "beds", arrange: "perimeter", count: [3, 5], tight: true, supporting: true, variety: 1, reason: "the garden fence", pick: FENCE },
      { role: "pets", label: "pets", zone: "lawn", arrange: "cluster", count: [1, 2], supporting: true, reason: "a dog off the leash", pick: { ids: ["pets-animal-dog", "pets-animal-bunny", "pets-animal-cat"] } },
    ],
    people: { count: [2, 4], pick: TOWNSFOLK, near: ["lawn", "beds"] },
    boundary: "trees",
    paths: [
      { from: "entrance", to: "lawn" },
      { from: "lawn", to: "beds" },
    ],
    extras: true,
    fillKinds: ["nature", "tree"],
    fillCap: 6,
  },
];

ARCHETYPES.push({
  id: "space_station",
  relief: "some",
  label: "space station",
  vocab: ["space", "station", "spaceship", "orbit", "orbital", "scifi", "sci", "alien", "galaxy", "cosmic", "moon", "mars", "laboratory"],
  hints: ["lab", "rocket", "launch", "pod", "pods", "module", "astronaut", "astronauts", "nasa", "base", "outpost"],
  story: "Habitat pods sit docked on the landing pad beside an airlock, while the crew works the consoles in the station module and cargo waits in the bay.",
  theme: "station",
  zones: [
    { role: "pad", type: "plaza", label: "the landing pad", location: "center", size: "large", purpose: "pods docked around the hub" },
    { role: "module", type: "lab", label: "the station module", location: "north", size: "large", purpose: "consoles and the crew at work" },
    { role: "cargo", type: "workshop", label: "the cargo bay", location: "east", size: "large", purpose: "crates and pipework" },
  ],
  focalZone: "pad",
  elements: [
    { role: "hub", label: "the hub module", zone: "pad", arrange: "focal", count: [1, 1], required: true, reason: "the hub at the center of the pad", pick: { ids: ["space-room-small-variation", "space-room-small", "space-corridor-wide-corner"] } },
    { role: "pods", label: "habitat pods", zone: "pad", arrange: "cluster", count: [2, 4], required: true, variety: 3, face: "focal", reason: "pods docked on the pad", pick: { ids: ["space-corridor-end", "space-corridor-corner", "space-corridor", "space-corridor-wide-end"] } },
    { role: "airlock", label: "airlock", zone: "pad", arrange: "entrance", count: [1, 1], required: true, reason: "the airlock you enter through", pick: { ids: ["space-gate-door", "space-gate-door-window", "space-gate"] } },
    { role: "cables", label: "cable runs", zone: "pad", arrange: "scatter", count: [1, 3], tight: true, supporting: true, reason: "cable runs across the pad", pick: { ids: ["space-cables"] } },
    { role: "consoles", label: "consoles", zone: "module", arrange: "along_wall", count: [2, 3], face: "away_wall", required: true, variety: 2, reason: "the consoles", pick: { ids: ["furniture-desk", "furniture-desk-corner"] } },
    { role: "screens", label: "screens", zone: "module", arrange: "beside", anchor: "consoles", count: [2, 3], tight: true, supporting: true, reason: "screens on the consoles", pick: { ids: ["furniture-computer-screen", "furniture-laptop", "furniture-computer-keyboard"] } },
    { role: "seats", label: "crew seats", zone: "module", arrange: "beside", anchor: "consoles", count: [1, 2], face: "anchor", supporting: true, reason: "a seat at the console", pick: { ids: ["furniture-chair-desk", "furniture-chair-modern-cushion"] } },
    { role: "lights", label: "lights", zone: "module", arrange: "corners", count: [1, 2], tight: true, supporting: true, reason: "a lamp in the corner", pick: { ids: ["furniture-lamp-round-floor", "furniture-lamp-square-floor"] } },
    { role: "supplies", label: "supplies", zone: "module", arrange: "interior", count: [1, 2], supporting: true, reason: "supplies stacked inside", pick: { ids: ["prototype-crate-color", "survival-box", "prototype-crate"] } },
    { role: "crates", label: "cargo", zone: "cargo", arrange: "cluster", count: [3, 5], required: true, reason: "cargo waiting in the bay", pick: { ids: ["prototype-crate", "prototype-crate-color", "survival-box-large", "survival-metal-panel"] } },
    { role: "pipes", label: "pipework", zone: "cargo", arrange: "perimeter", count: [3, 5], tight: true, supporting: true, variety: 2, reason: "pipework along the bay", pick: { ids: ["prototype-pipe", "prototype-pipe-section", "prototype-pipe-corner", "prototype-column"] } },
    { role: "rover", label: "rover", zone: "cargo", arrange: "corners", count: [0, 1], supporting: true, reason: "the rover parked in the bay", pick: { ids: ["prototype-vehicle", "prototype-vehicle-convertible"] } },
    { role: "markers", label: "pad markers", zone: "pad", arrange: "path_side", count: [2, 3], tight: true, supporting: true, reason: "markers along the walk", pick: { ids: ["prototype-column-low", "prototype-column-rounded-low", "prototype-indicator-round-a"], query: "indicator", packs: ["prototype"] } },
  ],
  people: { count: [3, 4], pick: { ids: ["arcade-character-employee", "characters-character-male-d", "characters-character-female-e", "characters-character-male-a"], kinds: ["character"] }, near: ["module", "pad"] },
  boundary: "theme",
  paths: [
    { from: "entrance", to: "pad" },
    { from: "pad", to: "module" },
    { from: "pad", to: "cargo" },
  ],
  fillKinds: ["crate", "prop"],
  fillCap: 3,
});

export function archetypeById(id: string | undefined): Archetype | null {
  if (!id) return null;
  return ARCHETYPES.find((a) => a.id === id) ?? null;
}

/**
 * Score every archetype against a prompt: vocabulary words count double,
 * hints once; naive plural folding so "burgers" finds "burger". Returns the
 * ranked list (best first) with scores, empty when nothing matched at all.
 */
export function rankArchetypes(prompt: string): { archetype: Archetype; score: number }[] {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tokens = new Set(words.flatMap((w) => (w.length > 3 && w.endsWith("s") ? [w, w.slice(0, -1)] : [w])));
  return ARCHETYPES.map((archetype) => {
    let score = 0;
    for (const v of archetype.vocab) if (tokens.has(v)) score += 2;
    for (const h of archetype.hints ?? []) if (tokens.has(h)) score += 1;
    return { archetype, score };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
