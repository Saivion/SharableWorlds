/**
 * Prompts the Build On dialog offers for growing the CURRENT world. Every
 * line names a place the composer has real rules for (an archetype) or a
 * texture pass it knows, so a suggestion always lands as a full addition —
 * never a themed pile. Tuned per scene type so a harbor is offered a fish
 * market, not another harbor.
 */

const BY_SCENE: Record<string, string[]> = {
  harbor: ["a fish market on the quay", "a lighthouse keeper's cottage", "a forest camp up the shore", "more boats and buoys in the water"],
  castle: ["a fishing harbor below the walls", "a market in the outer bailey", "a garden with a statue and benches", "a village of little houses outside"],
  house: ["a garden with flower beds and a bench", "a market down the street", "a park with an orchard", "a lakeside pier with boats"],
  market: ["a house with a fenced yard", "a fountain plaza with benches", "a harbor with fishing boats", "more stalls, bread and fruit"],
  backyard_picnic: ["a garden with flower beds", "a lakeside pier with rowboats", "a forest camp at the edge", "more food and more people"],
  graveyard: ["a haunted keep on the hill", "a dead forest at the edge", "a crypt garden with statues", "more graves and lanterns"],
  forest_camp: ["a lake with rowboats", "a ranger's cabin", "a park path with benches", "more tents around the fire"],
  arcade: ["a snack stand and picnic tables outside", "a skate park next door", "a street with parked cars", "more machines and more players"],
  village: ["a market square with a well", "a farm with animal pens", "a castle keep above the village", "a harbor at the shore"],
  street: ["a park with benches", "an arcade on the corner", "a market along the sidewalk", "more cars and more traffic"],
  skate_park: ["a snack stand and benches", "an arcade next door", "a park with an orchard", "more ramps and rails"],
  arena: ["a market outside the gates", "a keep for the champions", "a camp for the crowd", "more banners and more fighters"],
  farm: ["a farmhouse with a garden", "a market for the harvest", "a pond with rowboats", "more animals and more crops"],
  park: ["a garden with a statue", "a picnic lawn with food", "a pond with a pier", "more trees and more benches"],
  space_station: ["a cargo bay with containers", "a second habitat module", "a landing pad with more pods", "more crew at the consoles"],
};

const GENERIC = [
  "a fishing harbor with boats at anchor",
  "a market square with stalls",
  "a garden with a statue and benches",
  "a house with a fenced front yard",
  "a forest camp at the edge",
  "more people and a food stand",
];

/**
 * Up to six suggestions: a goal built around the human's own pieces first
 * (when they placed any), then the scene's tailored ideas, then generic ones.
 * Anything the world was already grown with is left out.
 */
export function buildOnSuggestions(sceneType: string | undefined, humanGoal: string | null, already: string[] = []): string[] {
  const out: string[] = [];
  const done = new Set(already.map((a) => a.trim().toLowerCase()));
  const add = (s: string) => {
    if (s && !done.has(s.trim().toLowerCase()) && !out.includes(s) && out.length < 6) out.push(s);
  };
  if (humanGoal) add(humanGoal);
  for (const s of BY_SCENE[sceneType ?? ""] ?? []) add(s);
  for (const s of GENERIC) add(s);
  return out;
}
