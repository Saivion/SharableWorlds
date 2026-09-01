import { composeScenePlan, type ComposedPlan, type OccupiedBody, type SceneTodo } from "./composition/compose";

/**
 * Scene planning — the public entry the tools call.
 *
 * The heavy lifting lives in lib/composition/: selection (select.ts), roles
 * (roles.ts), and the architecture-first composer (compose.ts). A plan is a
 * proposal made of two halves: the environment (platforms, walls, stairs,
 * paths, water, zones — the place itself) and the todos (catalog pieces that
 * populate it, lot by lot, with a reason each).
 */

export type { ComposedPlan, SceneTodo };

/**
 * Plan a complete, composed scene for any free-text goal: select the catalog
 * items it's actually about, derive the zones the theme needs, lay out
 * platforms/elevation/walls/stairs, then fill each zone with purpose-grouped
 * clusters — landmark first, people last. Human-locked lots are skipped.
 */
export function planCompleteScene(
  theme: string,
  occupied: Iterable<OccupiedBody> = [],
  sceneSeed?: string,
): ComposedPlan {
  return composeScenePlan(theme, occupied, sceneSeed);
}
