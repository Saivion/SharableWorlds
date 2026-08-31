import type { CatalogItem } from "../catalog";
import { CLUTTER_KINDS } from "./select";

/**
 * Roles — what job an item does in a composition. Keyed by catalog kind and
 * structural id vocabulary (wall/floor/dock — words about the art itself),
 * never by theme text, so the same rules compose any request.
 */

export type Role =
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

export function roleOf(item: CatalogItem): Role {
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

/** Visual mass — scaled 3D footprint area when a model is known, sprite alpha
 * area otherwise. The biggest thing in a selection becomes the focal landmark. */
export function visualMass(item: CatalogItem): number {
  return item.content[2] * item.content[3];
}
