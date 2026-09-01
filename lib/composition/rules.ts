import { catalogItem } from "../catalog";
import type { Piece } from "../types";
import { planZones, type ZoneProgram } from "./compose";
import { parseLotId, rectContains } from "./grid3d";
import { roleOf, type Role } from "./roles";
import { clearanceLots } from "./scale3d";
import { hashTheme, selectItems } from "./select";
import { platformAt, pathLots, stairApproachLots } from "./surface";
import { themeById, type ThemeSpec } from "./themes";
import type { EnvironmentSpec, ZoneType } from "./types";

/**
 * The SCENE RULE ENGINE — world-building laws as data, not prompt prose.
 *
 * Two families:
 *   COMPOSITION — what a scene must contain (zones, focal, characters,
 *   ground variety, environmental boundary, density rhythm)
 *   REALISM — what placements must respect (grounding, stair access,
 *   clear paths, populated zones)
 *
 * The agent's prompt teaches it how to think; this engine enforces reality:
 * validate_scene runs every applicable rule, the placement engine enforces
 * the hard ones at write time, and `get_scene_rules` lets an agent read the
 * laws of the world it is building in.
 */

export type RuleContext = {
  env: EnvironmentSpec | null;
  pieces: Record<string, Piece>;
  located: { piece: Piece; at: { col: number; row: number } }[];
  theme: ThemeSpec | null;
  prompt?: string;
};

export type RuleResult = { ok: boolean; note: string; fix?: string };

export type SceneRule = {
  id: string;
  /** The law, stated for agents and humans. */
  law: string;
  kind: "composition" | "realism";
  when: (ctx: RuleContext) => boolean;
  check: (ctx: RuleContext) => RuleResult;
};

export function buildRuleContext(
  env: EnvironmentSpec | null,
  pieces: Record<string, Piece>,
  prompt?: string,
): RuleContext {
  const located = Object.values(pieces).flatMap((p) => {
    const at = parseLotId(p.lot);
    return at ? [{ piece: p, at }] : [];
  });
  return { env, pieces, located, theme: themeById(env?.themeId), prompt };
}

function landCellCount(env: EnvironmentSpec | null): number {
  return (
    env?.platforms
      .filter((p) => !p.inset && p.level === 0 && p.material !== "road" && p.id !== "pier")
      .reduce((s, p) => s + p.rect.w * p.rect.d, 0) ?? 0
  );
}

function zoneTypesExpected(prompt: string): ZoneType[] {
  const items = selectItems(prompt, hashTheme(prompt.trim().toLowerCase() || "scene"));
  const byRole: Record<Role, ReturnType<typeof selectItems>> = {
    ground: [], wall: [], connector: [], structure: [], backdrop: [],
    track: [], tabletop: [], vessel: [], vehicle: [], person: [], scenery: [],
  };
  for (const item of items) byRole[roleOf(item)].push(item);
  const program: ZoneProgram = planZones(byRole);
  const expected: ZoneType[] = [];
  if (program.interior) expected.push(program.interior.type);
  if (program.market) expected.push("market");
  if (program.garden) expected.push("garden");
  if (program.harbor) expected.push("harbor");
  if (program.street) expected.push("street");
  return expected;
}

const always = () => true;
const hasEnv = (ctx: RuleContext) => Boolean(ctx.env && ctx.env.platforms.length > 0);

export const SCENE_RULES: SceneRule[] = [
  {
    id: "environment",
    law: "A scene stands on architecture — pieces never float on nothing.",
    kind: "composition",
    when: always,
    check: (ctx) => ({
      ok: hasEnv(ctx),
      note: ctx.env?.platforms.length
        ? `${ctx.env.platforms.length} platform${ctx.env.platforms.length === 1 ? "" : "s"} establish the ground`
        : "no architecture — pieces would float on nothing",
      fix: "plan_scene (stages architecture) or create_zone to start a footprint",
    }),
  },
  {
    id: "zones",
    law: "A place has recognizable functional areas, not just open ground.",
    kind: "composition",
    when: always,
    check: (ctx) => {
      const real = ctx.env?.zones.filter((z) => z.type !== "plaza") ?? [];
      return {
        ok: real.length >= 1,
        note: real.length
          ? `${real.length} functional zone${real.length === 1 ? "" : "s"}: ${real.map((z) => z.type).join(", ")}`
          : "no functional zones beyond open ground",
        fix: "create_zone with a type the theme needs",
      };
    },
  },
  {
    id: "focal_point",
    law: "Every scene has at least one visual anchor the eye goes to first.",
    kind: "composition",
    when: hasEnv,
    check: (ctx) => {
      const focals = (ctx.env?.zones ?? []).flatMap((z) => (z.focal ? [z.focal] : []));
      const ok = ctx.located.some(({ piece, at }) => {
        const item = catalogItem(piece.catalogId);
        if (!item || clearanceLots(item) < 0.6) return false;
        return focals.some((f) => Math.hypot(f.col - at.col, f.row - at.row) <= 2.2);
      });
      return {
        ok,
        note: ok ? "a landmark holds a focal point" : "no landmark at any zone's focal point",
        fix: "create_focal_point",
      };
    },
  },
  {
    id: "characters",
    law: "A place without people reads as abandoned.",
    kind: "composition",
    when: always,
    check: (ctx) => {
      const n = ctx.located.filter(({ piece }) => piece.kind === "character").length;
      return {
        ok: n >= 2,
        note: n ? `${n} character${n === 1 ? "" : "s"} live here` : "the place reads as abandoned",
        fix: "place characters near zone focals (place_batch with rot facing the action)",
      };
    },
  },
  {
    id: "characters_in_zones",
    law: "People belong inside the places built for them.",
    kind: "realism",
    when: (ctx) => ctx.located.some(({ piece }) => piece.kind === "character"),
    check: (ctx) => {
      const people = ctx.located.filter(({ piece }) => piece.kind === "character");
      const outside = people.filter(({ at }) => !ctx.env?.zones.some((z) => rectContains(z.rect, at.col, at.row)));
      const ok = people.length - outside.length >= Math.ceil(people.length * 0.7);
      return {
        ok,
        note: outside.length
          ? `${outside.length} character${outside.length === 1 ? "" : "s"} outside every zone: ${outside
              .slice(0, 4)
              .map(({ piece }) => `${piece.id}@${piece.lot}`)
              .join(", ")}`
          : `all ${people.length} characters are inside zones`,
        fix: outside.length ? `move_piece ${outside[0].piece.id} to a lot inside a zone rect` : undefined,
      };
    },
  },
  {
    id: "zones_populated",
    law: "A zone that exists must be furnished for its purpose.",
    kind: "composition",
    when: (ctx) => (ctx.env?.zones.filter((z) => z.type !== "plaza").length ?? 0) > 0,
    check: (ctx) => {
      const real = ctx.env!.zones.filter((z) => z.type !== "plaza");
      const hollow = real.filter((z) => {
        if (z.type === "skyline" || z.type === "street") return false;
        const inside = ctx.located.filter(({ at }) => rectContains(z.rect, at.col, at.row)).length;
        return inside < (z.type === "harbor" ? 1 : 2);
      });
      return {
        ok: hollow.length === 0,
        note: hollow.length
          ? `empty zone${hollow.length === 1 ? "" : "s"}: ${hollow.map((z) => z.id).join(", ")}`
          : "every zone is furnished",
        fix: hollow.length ? `create_prop_cluster for ${hollow[0].id}` : undefined,
      };
    },
  },
  {
    id: "paths",
    law: "Circulation is visible: you can see where to enter and where to walk.",
    kind: "composition",
    when: hasEnv,
    check: (ctx) => ({
      ok: (ctx.env?.paths.length ?? 0) >= 1,
      note: ctx.env?.paths.length
        ? `${ctx.env.paths.length} path${ctx.env.paths.length === 1 ? "" : "s"} connect the place`
        : "no desire lines between areas",
      fix: "create_path between two zones",
    }),
  },
  {
    id: "elevation_connected",
    law: "A raised level always has a way up.",
    kind: "realism",
    when: (ctx) => Boolean(ctx.env?.platforms.some((p) => !p.inset && p.level > 0)),
    check: (ctx) => {
      const ok = (ctx.env?.stairs.length ?? 0) > 0;
      return {
        ok,
        note: ok ? "stairs join the levels" : "a raised deck has no way up",
        fix: "create_zone interior types add their own stair; or replan with plan_scene",
      };
    },
  },
  {
    id: "stairs_access",
    law: "Staircases keep a clear step-on and step-off — never blocked.",
    kind: "realism",
    when: (ctx) => (ctx.env?.stairs.length ?? 0) > 0,
    check: (ctx) => {
      const approach = stairApproachLots(ctx.env);
      const blockers = ctx.located.filter(({ piece }) => {
        if (piece.kind === "character" || piece.kind === "pet") return false;
        return approach.has(piece.lot);
      });
      return {
        ok: blockers.length === 0,
        note: blockers.length
          ? `stair approach blocked by ${blockers.map((b) => b.piece.id).slice(0, 3).join(", ")}`
          : "every stair has a clear step-on and step-off",
        fix: blockers.length ? `move_piece ${blockers[0].piece.id} away from the stair` : undefined,
      };
    },
  },
  {
    id: "paths_clear",
    law: "Walkways stay walkable — bulky objects never sit on a path.",
    kind: "realism",
    when: (ctx) => (ctx.env?.paths.length ?? 0) > 0,
    check: (ctx) => {
      const lots = pathLots(ctx.env);
      const blockers = ctx.located.filter(({ piece }) => {
        if (piece.kind === "character" || piece.kind === "pet" || piece.kind === "food") return false;
        const item = catalogItem(piece.catalogId);
        return Boolean(item && clearanceLots(item) >= 0.6 && lots.has(piece.lot));
      });
      return {
        ok: blockers.length === 0,
        note: blockers.length
          ? `path blocked by ${blockers.map((b) => `${b.piece.id}@${b.piece.lot}`).slice(0, 3).join(", ")}`
          : "walkways are clear",
        fix: blockers.length ? `move_piece ${blockers[0].piece.id} off the path` : undefined,
      };
    },
  },
  {
    id: "grounded",
    law: "Everything stands ON the scene — nothing floats in the void.",
    kind: "realism",
    when: hasEnv,
    check: (ctx) => {
      const strays = ctx.located.filter(({ piece, at }) => {
        if (platformAt(ctx.env, at.col, at.row)) return false;
        const onWater = ctx.env!.water.some((w) => rectContains(w.rect, at.col, at.row));
        return !(onWater && (piece.kind === "boat" || piece.kind === "pirate"));
      });
      return {
        ok: strays.length === 0,
        note: strays.length
          ? `${strays.length} piece${strays.length === 1 ? "" : "s"} off the architecture: ${strays.slice(0, 3).map((s) => s.piece.id).join(", ")}`
          : "everything stands on the scene",
        fix: strays.length ? "move_piece strays onto the platforms (or remove_piece)" : undefined,
      };
    },
  },
  {
    id: "ground_variety",
    law: "Themed ground is an ecosystem — multiple materials in intentional patches, never one tile.",
    kind: "composition",
    when: (ctx) => Boolean(ctx.env?.themeId),
    check: (ctx) => {
      const land = landCellCount(ctx.env);
      const patchCells = ctx.env?.ground?.length ?? 0;
      const materials = new Set<string>([
        ...(ctx.env?.platforms.filter((p) => !p.inset && p.level === 0).map((p) => p.material) ?? []),
        ...(ctx.env?.ground?.map((g) => g.m) ?? []),
      ]);
      const ok = materials.size >= 3 && land > 0 && patchCells >= land * 0.12;
      return {
        ok,
        note: ok
          ? `${materials.size} ground materials in patches (${patchCells} patched cells)`
          : `ground too uniform — ${materials.size} material${materials.size === 1 ? "" : "s"}, ${patchCells} patched cells`,
        fix: "create_ground_patch (or apply_theme to repaint the whole ecosystem)",
      };
    },
  },
  {
    id: "environmental_boundary",
    law: "Outdoor scenes are framed — a forest edge or standing boundary, not an infinite board.",
    kind: "composition",
    when: (ctx) => Boolean(ctx.theme && ctx.theme.boundary !== "none"),
    check: (ctx) => {
      // Framing pieces: scenery/tree items standing near the deck's edge.
      const framing = ctx.located.filter(({ piece, at }) => {
        const item = catalogItem(piece.catalogId);
        if (!item) return false;
        const role = roleOf(item);
        if (role !== "scenery" && role !== "ground" && item.kind !== "tree") return false;
        // Edge = within 1 lot of a cell that is off the platforms.
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
          if (!platformAt(ctx.env, at.col + dc, at.row + dr)) return true;
        }
        return false;
      });
      const need = Math.max(6, Math.round(landCellCount(ctx.env) * 0.06));
      return {
        ok: framing.length >= need,
        note:
          framing.length >= need
            ? `${framing.length} framing pieces ring the scene`
            : `boundary too thin — ${framing.length}/${need} framing pieces at the edge`,
        fix: 'create_vegetation {area: "edge"}',
      };
    },
  },
  {
    id: "density",
    law: "Density leaves intentional negative space — composed, not packed, not barren.",
    kind: "composition",
    when: hasEnv,
    check: (ctx) => {
      const land = landCellCount(ctx.env);
      const density = land ? ctx.located.length / land : 0;
      const ok = density >= 0.06 && density <= 0.6;
      return {
        ok,
        note: !land
          ? "no deck to measure"
          : density < 0.06
            ? `sparse (${ctx.located.length} pieces on ${land} cells) — zones need furnishing`
            : density > 0.6
              ? `crowded (${ctx.located.length} pieces on ${land} cells) — remove clutter, keep breathing room`
              : "density leaves intentional negative space",
        fix: density < 0.06 ? "create_prop_cluster in the emptiest zone" : "remove_piece the least purposeful clutter",
      };
    },
  },
  {
    id: "theme_zones",
    law: "The zones the prompt implies must exist.",
    kind: "composition",
    when: (ctx) => Boolean(ctx.prompt?.trim()),
    check: (ctx) => {
      const expected = zoneTypesExpected(ctx.prompt!);
      const present = new Set((ctx.env?.zones ?? []).map((z) => z.type));
      const missing = expected.filter((t) => !present.has(t));
      return {
        ok: missing.length === 0,
        note: expected.length
          ? missing.length
            ? `theme wants zones this scene lacks: ${missing.join(", ")}`
            : `every zone the theme implies is present (${expected.join(", ") || "none"})`
          : "theme implies no specific zones",
        fix: missing.length ? `create_zone {type: "${missing[0]}"}` : undefined,
      };
    },
  },
];
