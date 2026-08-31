/** Goals the planner can actually build — one per featured pack, plus a few mixes. */
export const SURPRISE_GOALS = [
  "arcade night with pinball and claw machines",
  "an arena after the battle",
  "village folk in the square",
  "a haunted dungeon with an orc",
  "a quiet forest camp",
  "a busy market with fruit and bread",
  "skate park with a half pipe",
  "a harbor full of fishing boats",
  "a pirate dock with boats",
  "downtown traffic jam",
  "a pirate island with a watch tower",
  "a midnight arcade and a snack stand",
  "a backyard picnic with burgers and cake",
  "a cozy living room",
  "a neighborhood of little houses",
  "a cube pet zoo",
  "an amusement park with a roller coaster",
  "a toy car racetrack",
  "a space station",
  "a cave camp with a fire",
  "a survival homestead",
  "a garden with trees and crops",
] as const;

let lastSurprise = "";

export function pickSurpriseGoal(avoid?: string | null): string {
  const skip = new Set([lastSurprise, avoid?.trim() ?? ""].filter(Boolean));
  const pool = SURPRISE_GOALS.filter((goal) => !skip.has(goal));
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? SURPRISE_GOALS[0];
  lastSurprise = pick;
  return pick;
}
