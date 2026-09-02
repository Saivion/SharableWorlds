/**
 * Goals the Surprise Me button hands the agent. Every line names a kind of
 * place the composer has real composition rules for (lib/composition/
 * archetypes.ts) plus a detail or two the story can hang on, so a surprise
 * is always a full, complete scene — never a themed pile.
 */
export const SURPRISE_GOALS = [
  "a backyard picnic with burgers and cake",
  "a lakeside picnic with boats on the water",
  "a spooky graveyard at midnight",
  "a haunted cemetery with a crypt on the hill",
  "a small medieval market with a fountain",
  "a busy farmers market with fruit and bread",
  "a cozy cottage with a fenced front yard",
  "a house with a garden and a dog",
  "a castle courtyard with towers on the hill",
  "a mountain keep with a great hall",
  "a quiet forest camp under the mountains",
  "a campsite with tents around the fire",
  "a fishing harbor with boats at anchor",
  "a pirate dock with a flagship offshore",
  "arcade night with pinball and claw machines",
  "a midnight arcade and a snack stand",
  "a hillside village with allotments",
  "a neighborhood of little houses around a well",
  "downtown traffic jam under the skyline",
  "cars backed up along a city avenue",
  "a skate park with a half pipe",
  "an arena after the battle",
  "a farm with animal pens and crops",
  "a petting zoo with pens and a barn",
  "a park with flower beds and an orchard",
  "a garden with a statue and benches",
  "a space station on the moon",
  "an orbital outpost with docked pods",
] as const;

let lastSurprise = "";

export function pickSurpriseGoal(avoid?: string | null): string {
  const skip = new Set([lastSurprise, avoid?.trim() ?? ""].filter(Boolean));
  const pool = SURPRISE_GOALS.filter((goal) => !skip.has(goal));
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? SURPRISE_GOALS[0];
  lastSurprise = pick;
  return pick;
}
