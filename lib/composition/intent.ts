import { archetypeById, rankArchetypes, type Archetype, type ElementSpec, type ZoneRole } from "./archetypes";
import { resolveTheme, themeById, type ThemeSpec } from "./themes";

/**
 * Intent — UNDERSTAND before PLAN.
 *
 * A request is not a shopping list. "A backyard picnic with burgers and
 * cake" names a kind of place (backyard picnic), a purpose (a gathering), a
 * focal point (the table), things that must exist (burgers, cake, seating,
 * a grill), things that should (plates, drinks, a blanket), an environment
 * (lawn, trees, fence, the house), and a way in. This module resolves the
 * prompt to an archetype and states all of that explicitly — for the
 * planner, for the validator (intent coverage), and for the agent, which
 * reads it back from plan_scene.
 */

export type Complexity = "simple" | "medium" | "complex";

export type SceneIntent = {
  prompt: string;
  /** Archetype id, or "generic" when the prompt matched none. */
  sceneType: string;
  archetype: Archetype | null;
  /** 0 when generic, otherwise the archetype match score. */
  confidence: number;
  story: string;
  theme: ThemeSpec;
  focal: string;
  required: { role: string; label: string; zone: string }[];
  supporting: { role: string; label: string; zone: string }[];
  zones: ZoneRole[];
  environment: { theme: string; boundary: Archetype["boundary"]; ground: string };
  navigation: string[];
  complexity: Complexity;
};

const SMALL_REQUEST = /\b(add|another|one more|beside|next to|near|move|remove|delete|replace|swap|rotate|flip|rename|label)\b/i;

/** How much orchestration a request deserves — proportional, never maximal. */
export function complexityOf(prompt: string, archetype: Archetype | null): Complexity {
  const text = prompt.trim();
  if (SMALL_REQUEST.test(text) && text.split(/\s+/).length <= 9) return "simple";
  const zones = archetype?.zones.length ?? 2;
  const wants = text.split(/\b(?:and|with|,|\+)\b/).length;
  if (zones >= 3 || wants >= 3) return "complex";
  return "medium";
}

/**
 * Resolve a prompt (and an optional explicit type) to a SceneIntent. The
 * explicit type wins when it names an archetype; otherwise the best
 * vocabulary match; otherwise a generic intent the selection-driven
 * composer handles.
 */
export function understandIntent(prompt: string, explicitType?: string): SceneIntent {
  const text = prompt.trim();
  const forced = archetypeById(explicitType?.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const ranked = forced ? [] : rankArchetypes(text);
  const archetype = forced ?? ranked[0]?.archetype ?? null;
  const confidence = forced ? 3 : ranked[0]?.score ?? 0;
  const theme = (archetype?.theme ? themeById(archetype.theme) : null) ?? resolveTheme(text, "grass");
  const focalElement = archetype?.elements.find((e) => e.arrange === "focal" && e.zone === archetype.focalZone);
  const pickList = (pred: (e: ElementSpec) => boolean) =>
    (archetype?.elements ?? []).filter(pred).map((e) => ({ role: e.role, label: e.label, zone: e.zone }));
  const zones = archetype?.zones ?? [];
  const labelOf = (role: string) => (role === "entrance" ? "the entrance" : zones.find((z) => z.role === role)?.label ?? role);
  return {
    prompt: text,
    sceneType: archetype?.id ?? "generic",
    archetype,
    confidence,
    story: archetype?.story ?? `A place that reads as "${text}" at a glance: a footprint, functional areas, a landmark, and people with reasons to be there.`,
    theme,
    focal: focalElement?.label ?? "the landmark at the plaza focal",
    required: pickList((e) => Boolean(e.required)),
    supporting: pickList((e) => Boolean(e.supporting)),
    zones,
    environment: { theme: theme.id, boundary: archetype?.boundary ?? "theme", ground: theme.primary },
    navigation: (archetype?.paths ?? [{ from: "entrance", to: "plaza" }]).map((p) => `${labelOf(p.from)} → ${labelOf(p.to)}`),
    complexity: complexityOf(text, archetype),
  };
}
