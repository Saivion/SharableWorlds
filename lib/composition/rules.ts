import { catalogItem, type CatalogItem, type CatalogKind } from "../catalog";
import type { Piece } from "../types";
import type { ElementSpec } from "./archetypes";
import { planZones, groupByRole } from "./layout";
import type { ComposedPlan } from "./compose";
import { parseLotId, rectContains, type LotRect } from "./grid3d";
import { understandIntent, type SceneIntent } from "./intent";
import { facingVector } from "./layout";
import { pickItems } from "./pick";
import { roleOf } from "./roles";
import { waterCells, waterNeed, WATER_DENSITY } from "./density";
import { clearanceLots } from "./scale3d";
import { deriveSeed } from "./seed";
import { selectItems } from "./select";
import { platformAt, pathLots, stairApproachLots } from "./surface";
import { themeById, type ThemeSpec } from "./themes";
import type { EnvironmentSpec, ZoneSpec, ZoneType } from "./types";

/**
 * The SCENE RULE ENGINE — world-building laws as data, not prompt prose.
 *
 * Families:
 *   INTENT       — does the scene contain what the request asked for?
 *   COMPOSITION  — does it read as a place (zones, focal, people, density)?
 *   SPATIAL      — do things sit where they belong, with room to breathe?
 *   ORIENTATION  — do chairs face tables, people face the action?
 *   NAVIGATION   — can you get in, get around, get up the stairs?
 *   PLACEMENT    — is everything grounded, un-overlapped, and where the plan put it?
 *   ENVIRONMENT  — themed ground, a framed edge.
 *
 * Every rule scores 0..1 and, when it fails, names STRUCTURED repairs — a
 * WebMCP tool plus arguments — so an agent (or repair_scene) can fix the
 * world without guessing. Rules roll up into the completeness model
 * (lib/composition/validate.ts).
 */

export type ScoreDimension = "intentCoverage" | "composition" | "spatialCoherence" | "environment" | "navigation" | "placementValidity";

export type Repair = { tool: string; args: Record<string, unknown>; why: string };

export type RuleContext = {
  env: EnvironmentSpec | null;
  pieces: Record<string, Piece>;
  located: { piece: Piece; at: { col: number; row: number }; item: CatalogItem | undefined }[];
  theme: ThemeSpec | null;
  prompt?: string;
  plan: ComposedPlan | null;
  intent: SceneIntent | null;
  sceneSeed?: string;
};

export type RuleResult = {
  ok: boolean;
  /** Partial credit 0..1 (defaults to ok ? 1 : 0). */
  score?: number;
  note: string;
  /** Human-readable repair hint. */
  fix?: string;
  /** Machine-readable repairs, most important first. */
  repairs?: Repair[];
};

export type SceneRule = {
  id: string;
  law: string;
  kind: "intent" | "composition" | "spatial" | "orientation" | "navigation" | "placement" | "environment";
  dimension: ScoreDimension;
  weight: number;
  /** A failed critical rule keeps the scene incomplete whatever the score says. */
  critical?: boolean;
  when: (ctx: RuleContext) => boolean;
  check: (ctx: RuleContext) => RuleResult;
};

export function buildRuleContext(
  env: EnvironmentSpec | null,
  pieces: Record<string, Piece>,
  prompt?: string,
  plan: ComposedPlan | null = null,
  sceneSeed?: string,
): RuleContext {
  const located = Object.values(pieces).flatMap((p) => {
    const at = parseLotId(p.lot);
    return at ? [{ piece: p, at, item: catalogItem(p.catalogId) }] : [];
  });
  const intent = plan?.intent ?? (prompt?.trim() ? understandIntent(prompt) : null);
  return { env, pieces, located, theme: themeById(env?.themeId), prompt, plan, intent, sceneSeed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const always = () => true;
const hasEnv = (ctx: RuleContext) => Boolean(ctx.env && ctx.env.platforms.length > 0);
const hasArchetype = (ctx: RuleContext) => Boolean(ctx.intent?.archetype && ctx.env);

function landCellCount(env: EnvironmentSpec | null): number {
  return (
    env?.platforms
      .filter((p) => !p.inset && p.level === 0 && p.material !== "road" && p.id !== "pier")
      .reduce((s, p) => s + p.rect.w * p.rect.d, 0) ?? 0
  );
}

function grow(rect: LotRect, by = 1): LotRect {
  return { c0: rect.c0 - by, r0: rect.r0 - by, w: rect.w + by * 2, d: rect.d + by * 2 };
}

function zoneOf(ctx: RuleContext, col: number, row: number): ZoneSpec | null {
  for (const z of ctx.env?.zones ?? []) if (rectContains(z.rect, col, row)) return z;
  return null;
}

function cheb(a: { col: number; row: number }, b: { col: number; row: number }) {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/** Pool of catalog ids an archetype element may be made of. */
const poolCache = new Map<string, Set<string>>();
function elementPool(el: ElementSpec, seed: string): Set<string> {
  const key = `${seed}|${el.role}|${el.zone}`;
  const cached = poolCache.get(key);
  if (cached) return cached;
  const pool = new Set(pickItems(el.pick, deriveSeed(seed, `pick:${el.role}`), 64).map((i) => i.id));
  poolCache.set(key, pool);
  return pool;
}

/** Pieces that satisfy one archetype element: right catalog family, inside
 * (or right beside) the element's zone. */
function piecesFor(ctx: RuleContext, el: ElementSpec): RuleContext["located"] {
  const seed = ctx.plan?.seed ?? ctx.sceneSeed ?? "UNSEEDED";
  const pool = elementPool(el, seed);
  const zone = ctx.env?.zones.find((z) => z.id === el.zone);
  return ctx.located.filter(({ piece, at }) => {
    if (!pool.has(piece.catalogId)) return false;
    if (!zone) return true;
    return rectContains(grow(zone.rect, el.arrange === "entrance" || el.arrange === "path_side" || el.arrange === "behind" ? 3 : 1), at.col, at.row);
  });
}

function requiredElements(ctx: RuleContext): ElementSpec[] {
  return ctx.intent?.archetype?.elements.filter((e) => e.required) ?? [];
}

function supportingElements(ctx: RuleContext): ElementSpec[] {
  return ctx.intent?.archetype?.elements.filter((e) => e.supporting) ?? [];
}

/** Zone-type grammar: what kinds of piece count as "furnishing" a zone. */
const ZONE_GRAMMAR: Partial<Record<ZoneType, CatalogKind[]>> = {
  market: ["stall", "machine", "food", "prop", "crate"],
  garden: ["nature", "tree", "pet", "prop", "food", "furniture"],
  home: ["furniture", "pet", "food", "prop"],
  arcade: ["machine", "prop", "furniture"],
  keep: ["dungeon", "crate", "prop", "furniture", "pirate"],
  lab: ["space", "prop", "machine", "furniture", "crate"],
  harbor: ["boat", "pirate"],
  street: ["car", "prop"],
  skyline: ["building", "tree", "nature"],
  workshop: ["crate", "prop", "furniture", "pirate", "dungeon", "machine", "nature", "car"],
  camp: ["nature", "prop", "crate", "food", "tree", "furniture"],
};

/** Kinds that have no business inside a given zone type. */
const ZONE_FORBIDDEN: Partial<Record<ZoneType, CatalogKind[]>> = {
  home: ["tree", "car", "boat", "building", "stall"],
  arcade: ["tree", "car", "boat", "building", "nature"],
  keep: ["car", "boat", "building"],
  lab: ["tree", "car", "boat", "nature"],
  market: ["car", "boat", "furniture"],
  street: ["furniture", "stall", "boat", "food"],
  harbor: ["furniture", "car", "building"],
};

const SEATING = /\b(chair|bench|stool|sofa|lounge|tent)\b/;

function focalPieceOf(ctx: RuleContext): { piece: Piece; at: { col: number; row: number }; item: CatalogItem | undefined } | null {
  const arch = ctx.intent?.archetype;
  if (arch) {
    const el = arch.elements.find((e) => e.arrange === "focal" && e.zone === arch.focalZone);
    if (el) {
      const zone = ctx.env?.zones.find((z) => z.id === el.zone);
      const hits = piecesFor(ctx, el).filter((h) => !zone?.focal || cheb(h.at, zone.focal) <= 2);
      if (hits[0]) return hits[0];
    }
  }
  const focals = (ctx.env?.zones ?? []).flatMap((z) => (z.focal ? [z.focal] : []));
  return (
    ctx.located.find(({ item, at }) => item && clearanceLots(item) >= 0.6 && (roleOf(item) === "structure" || roleOf(item) === "scenery") && focals.some((f) => cheb(f, at) <= 1)) ?? null
  );
}

/** What a piece near the action should face: the nearest anchor (focal or table-like piece). */
function anchorsOf(ctx: RuleContext): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  const focal = focalPieceOf(ctx);
  if (focal) out.push(focal.at);
  const arch = ctx.intent?.archetype;
  if (arch) {
    for (const el of arch.elements.filter((e) => e.arrange === "focal")) for (const h of piecesFor(ctx, el)) out.push(h.at);
  }
  return out;
}

function faces(rot: number | undefined, from: { col: number; row: number }, to: { col: number; row: number }): boolean {
  const f = facingVector(rot);
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  return f.dc * dc + f.dr * dr > 0;
}

function expectedZonesGeneric(ctx: RuleContext): ZoneType[] {
  const prompt = ctx.prompt?.trim();
  if (!prompt) return [];
  const seed = ctx.sceneSeed ? deriveSeed(ctx.sceneSeed, "selection") : deriveSeed(prompt.toLowerCase(), "selection");
  const program = planZones(groupByRole(selectItems(prompt, seed)));
  const expected: ZoneType[] = [];
  if (program.interior) expected.push(program.interior.type);
  if (program.market) expected.push("market");
  if (program.garden) expected.push("garden");
  if (program.harbor) expected.push("harbor");
  if (program.street) expected.push("street");
  return expected;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export const SCENE_RULES: SceneRule[] = [
  {
    id: "environment",
    law: "A scene stands on architecture — pieces never float on nothing.",
    kind: "composition",
    dimension: "composition",
    weight: 2,
    critical: true,
    when: always,
    check: (ctx) => ({
      ok: hasEnv(ctx),
      note: ctx.env?.platforms.length
        ? `${ctx.env.platforms.length} platform${ctx.env.platforms.length === 1 ? "" : "s"} establish the ground`
        : "no architecture — pieces would float on nothing",
      fix: "compose_scene stages the architecture from a plan",
      repairs: hasEnv(ctx) ? [] : [{ tool: "compose_scene", args: {}, why: "no ground to build on" }],
    }),
  },
  {
    id: "zones",
    law: "A place has the functional areas its kind of place needs.",
    kind: "intent",
    dimension: "intentCoverage",
    weight: 2,
    when: always,
    check: (ctx) => {
      const present = new Set((ctx.env?.zones ?? []).map((z) => z.id));
      const presentTypes = new Set((ctx.env?.zones ?? []).map((z) => z.type));
      const arch = ctx.intent?.archetype;
      if (arch) {
        const want = arch.zones;
        const missing = want.filter((z) => !present.has(z.role) && !(z.type === "plaza" && presentTypes.has("plaza")));
        return {
          ok: missing.length === 0,
          score: want.length ? (want.length - missing.length) / want.length : 1,
          note: missing.length ? `${arch.label} still needs: ${missing.map((z) => z.label).join(", ")}` : `every zone a ${arch.label} needs is here (${want.map((z) => z.label).join(", ")})`,
          fix: missing.length ? `create_zone {type: "${missing[0].type}", location: "${missing[0].location}", label: "${missing[0].label}"}` : undefined,
          repairs: missing.map((z) => ({ tool: "create_zone", args: { type: z.type, location: z.location, size: z.size, label: z.label }, why: `a ${arch.label} needs ${z.label}` })),
        };
      }
      const expected = expectedZonesGeneric(ctx);
      const real = (ctx.env?.zones ?? []).filter((z) => z.type !== "plaza");
      const missing = expected.filter((t) => !presentTypes.has(t));
      const ok = real.length >= 1 && missing.length === 0;
      return {
        ok,
        score: expected.length ? (expected.length - missing.length) / expected.length : real.length ? 1 : 0,
        note: !real.length ? "no functional zones beyond open ground" : missing.length ? `theme wants zones this scene lacks: ${missing.join(", ")}` : `${real.length} functional zone${real.length === 1 ? "" : "s"}: ${real.map((z) => z.type).join(", ")}`,
        fix: missing.length ? `create_zone {type: "${missing[0]}"}` : real.length ? undefined : "create_zone with a type the theme needs",
        repairs: (missing.length ? missing : real.length ? [] : (["garden"] as ZoneType[])).map((t) => ({ tool: "create_zone", args: { type: t }, why: `the theme implies a ${t}` })),
      };
    },
  },
  {
    id: "intent_coverage",
    law: "The things the request asked for exist, in the places built for them.",
    kind: "intent",
    dimension: "intentCoverage",
    weight: 4,
    critical: true,
    when: (ctx) => hasArchetype(ctx) && requiredElements(ctx).length > 0,
    check: (ctx) => {
      const required = requiredElements(ctx);
      const missing = required.filter((el) => piecesFor(ctx, el).length < Math.max(1, Math.ceil(el.count[0] / 2)));
      const byZone = new Map<string, string[]>();
      for (const el of missing) byZone.set(el.zone, [...(byZone.get(el.zone) ?? []), el.role]);
      return {
        ok: missing.length === 0,
        score: (required.length - missing.length) / required.length,
        note: missing.length ? `missing what the scene is about: ${missing.map((e) => e.label).join(", ")}` : `every required element is present (${required.map((e) => e.label).join(", ")})`,
        fix: missing.length ? `populate_zones {zones: [${[...byZone.keys()].map((z) => `"${z}"`).join(", ")}]}` : undefined,
        repairs: [...byZone.entries()].map(([zone, roles]) => ({ tool: "populate_zones", args: { zones: [zone], only: roles }, why: `${roles.join(", ")} missing from ${zone}` })),
      };
    },
  },
  {
    id: "supporting_elements",
    law: "Supporting props reinforce the story — plates by the food, stock behind the stalls.",
    kind: "intent",
    dimension: "intentCoverage",
    weight: 1.5,
    when: (ctx) => hasArchetype(ctx) && supportingElements(ctx).length > 0,
    check: (ctx) => {
      const supporting = supportingElements(ctx);
      const missing = supporting.filter((el) => piecesFor(ctx, el).length === 0);
      const share = (supporting.length - missing.length) / supporting.length;
      const byZone = new Map<string, string[]>();
      for (const el of missing) byZone.set(el.zone, [...(byZone.get(el.zone) ?? []), el.role]);
      return {
        ok: share >= 0.6,
        score: share,
        note: missing.length ? `${supporting.length - missing.length}/${supporting.length} supporting elements present; missing ${missing.map((e) => e.label).slice(0, 5).join(", ")}` : "every supporting element is present",
        fix: missing.length ? `populate_zones {zones: ["${missing[0].zone}"]}` : undefined,
        repairs: [...byZone.entries()].map(([zone, roles]) => ({ tool: "populate_zones", args: { zones: [zone], only: roles }, why: `supporting ${roles.join(", ")} missing from ${zone}` })),
      };
    },
  },
  {
    id: "focal_point",
    law: "Every scene has one visual anchor the eye goes to first — the thing the place is about.",
    kind: "composition",
    dimension: "composition",
    weight: 2,
    critical: true,
    when: hasEnv,
    check: (ctx) => {
      const focal = focalPieceOf(ctx);
      const arch = ctx.intent?.archetype;
      const el = arch?.elements.find((e) => e.arrange === "focal" && e.zone === arch.focalZone);
      return {
        ok: Boolean(focal),
        note: focal ? `${focal.piece.id} anchors the scene${el ? ` (${el.label})` : ""}` : el ? `no ${el.label} at ${arch?.focalZone}'s focal point` : "no landmark at any zone's focal point",
        fix: "create_focal_point",
        repairs: focal ? [] : [{ tool: "create_focal_point", args: el ? { zone: el.zone } : {}, why: "the scene has no anchor" }],
      };
    },
  },
  {
    id: "focal_clearance",
    law: "The landmark breathes — nothing bulky crowds its immediate ring.",
    kind: "spatial",
    dimension: "spatialCoherence",
    weight: 1,
    when: (ctx) => Boolean(focalPieceOf(ctx)),
    check: (ctx) => {
      const focal = focalPieceOf(ctx)!;
      const crowd = ctx.located.filter(({ piece, item, at }) => piece.id !== focal.piece.id && item && clearanceLots(item) >= 0.8 && piece.kind !== "character" && cheb(at, focal.at) <= 1);
      return {
        ok: crowd.length === 0,
        note: crowd.length ? `${crowd.map((c) => c.piece.id).slice(0, 3).join(", ")} crowd the landmark` : "the landmark has room around it",
        fix: crowd.length ? `move_piece ${crowd[0].piece.id} a step away` : undefined,
        repairs: crowd.map((c) => ({ tool: "move_piece", args: { id: c.piece.id, away_from: focal.piece.id }, why: "crowding the landmark" })),
      };
    },
  },
  {
    id: "characters",
    law: "A place without people reads as abandoned.",
    kind: "composition",
    dimension: "composition",
    weight: 1.5,
    when: always,
    check: (ctx) => {
      const n = ctx.located.filter(({ piece }) => piece.kind === "character").length;
      const want = ctx.intent?.archetype?.people.count[0] ?? 2;
      const nearZone = ctx.intent?.archetype?.people.near[0];
      return {
        ok: n >= want,
        score: Math.min(1, n / want),
        note: n >= want ? `${n} character${n === 1 ? "" : "s"} live here` : n ? `only ${n} character${n === 1 ? "" : "s"} — the place reads as empty` : "the place reads as abandoned",
        fix: "populate_zones {only: [\"people\"]}",
        repairs: n >= want ? [] : [{ tool: "populate_zones", args: nearZone ? { zones: [nearZone], only: ["people"] } : { only: ["people"] }, why: `${want - n} more people needed` }],
      };
    },
  },
  {
    id: "characters_in_zones",
    law: "People belong inside the places built for them.",
    kind: "spatial",
    dimension: "spatialCoherence",
    weight: 1,
    when: (ctx) => hasEnv(ctx) && ctx.located.some(({ piece }) => piece.kind === "character"),
    check: (ctx) => {
      const people = ctx.located.filter(({ piece }) => piece.kind === "character");
      const outside = people.filter(({ at }) => !ctx.env?.zones.some((z) => rectContains(z.rect, at.col, at.row)));
      const share = (people.length - outside.length) / people.length;
      return {
        ok: share >= 0.7,
        score: share,
        note: outside.length ? `${outside.length} character${outside.length === 1 ? "" : "s"} outside every zone: ${outside.slice(0, 4).map(({ piece }) => `${piece.id}@${piece.lot}`).join(", ")}` : `all ${people.length} characters are inside zones`,
        fix: outside.length ? `move_piece ${outside[0].piece.id} into a zone` : undefined,
        repairs: outside.map((o) => ({ tool: "move_piece", args: { id: o.piece.id, into_zone: "plaza" }, why: "standing outside every zone" })),
      };
    },
  },
  {
    id: "orientation",
    law: "Things face what they are for — chairs face the table, people face the action.",
    kind: "orientation",
    dimension: "spatialCoherence",
    weight: 1.5,
    when: (ctx) => hasEnv(ctx) && anchorsOf(ctx).length > 0,
    check: (ctx) => {
      const anchors = anchorsOf(ctx);
      const subjects = ctx.located.filter(({ piece, item }) => item && (piece.kind === "character" || SEATING.test(item.id)) && anchors.some((a) => cheb(a, { col: 0, row: 0 }) >= 0));
      const judged = subjects.flatMap((s) => {
        let best: { col: number; row: number } | null = null;
        let bestD = Infinity;
        for (const a of anchors) {
          const d = cheb(a, s.at);
          if (d > 0 && d <= 2 && d < bestD) {
            bestD = d;
            best = a;
          }
        }
        return best ? [{ ...s, anchor: best }] : [];
      });
      if (!judged.length) return { ok: true, score: 1, note: "nothing sits close enough to an anchor to face it" };
      const wrong = judged.filter((s) => !faces(s.piece.rot, s.at, s.anchor));
      const share = (judged.length - wrong.length) / judged.length;
      return {
        ok: share >= 0.75,
        score: share,
        note: wrong.length ? `${wrong.length}/${judged.length} face away from the action: ${wrong.slice(0, 3).map((w) => w.piece.id).join(", ")}` : `all ${judged.length} seats and people face the action`,
        fix: wrong.length ? `orient_piece {id: "${wrong[0].piece.id}", face: <anchor id>}` : undefined,
        repairs: wrong.map((w) => ({ tool: "orient_piece", args: { id: w.piece.id, face_lot: `C${w.anchor.col}R${w.anchor.row}` }, why: "facing away from what it is for" })),
      };
    },
  },
  {
    id: "zones_populated",
    law: "A zone that exists is furnished for its purpose — a market has stalls, a garden has plants.",
    kind: "composition",
    dimension: "composition",
    weight: 2,
    when: (ctx) => (ctx.env?.zones.filter((z) => z.type !== "plaza").length ?? 0) > 0,
    check: (ctx) => {
      const real = ctx.env!.zones.filter((z) => z.type !== "plaza");
      const hollow = real.filter((z) => {
        const grammar = ZONE_GRAMMAR[z.type];
        const inside = ctx.located.filter(({ piece, at }) => rectContains(z.rect, at.col, at.row) && (!grammar || grammar.includes(piece.kind))).length;
        return inside < (z.type === "harbor" || z.type === "skyline" || z.type === "street" ? 1 : 2);
      });
      return {
        ok: hollow.length === 0,
        score: (real.length - hollow.length) / real.length,
        note: hollow.length ? `empty zone${hollow.length === 1 ? "" : "s"}: ${hollow.map((z) => z.id).join(", ")}` : "every zone is furnished for its purpose",
        fix: hollow.length ? `populate_zones {zones: [${hollow.map((z) => `"${z.id}"`).join(", ")}]}` : undefined,
        repairs: hollow.map((z) => ({ tool: "populate_zones", args: { zones: [z.id] }, why: `${z.label} is empty` })),
      };
    },
  },
  {
    id: "zone_coherence",
    law: "What stands in a zone belongs there — no tree in the kitchen, no sofa in the street.",
    kind: "spatial",
    dimension: "spatialCoherence",
    weight: 1.5,
    when: hasEnv,
    check: (ctx) => {
      const strays = ctx.located.filter(({ piece, at }) => {
        const z = zoneOf(ctx, at.col, at.row);
        if (!z) return false;
        if (ZONE_FORBIDDEN[z.type]?.includes(piece.kind)) return true;
        const p = platformAt(ctx.env, at.col, at.row);
        return Boolean(p) && z.level > 0 && p!.level !== z.level && !(piece.kind === "character");
      });
      const n = ctx.located.length || 1;
      return {
        ok: strays.length === 0,
        score: Math.max(0, 1 - strays.length / Math.max(4, n * 0.15)),
        note: strays.length ? `${strays.length} piece${strays.length === 1 ? "" : "s"} in the wrong kind of place: ${strays.slice(0, 3).map((s) => `${s.piece.id}@${s.piece.lot}`).join(", ")}` : "everything stands in a place that suits it",
        fix: strays.length ? `move_piece ${strays[0].piece.id} to a fitting zone (or remove_piece)` : undefined,
        repairs: strays.map((s) => ({ tool: "remove_piece", args: { id: s.piece.id }, why: `${s.piece.kind} does not belong in ${zoneOf(ctx, s.at.col, s.at.row)?.label}` })),
      };
    },
  },
  {
    id: "paths",
    law: "Circulation is visible and connects every place: you can see where to enter and how to reach each zone.",
    kind: "navigation",
    dimension: "navigation",
    weight: 2,
    when: hasEnv,
    check: (ctx) => {
      const env = ctx.env!;
      if (!env.paths.length) {
        return { ok: false, score: 0, note: "no desire lines between areas", fix: "create_path", repairs: [{ tool: "create_path", args: { from: "entrance", to: "plaza" }, why: "no way in" }] };
      }
      const cells = env.paths.flatMap((p) => p.cells);
      const stairFeet = env.stairs.map((s) => s.at);
      const zones = env.zones.filter((z) => z.type !== "plaza" && z.type !== "skyline" && z.type !== "harbor");
      const disconnected = zones.filter((z) => {
        const near = grow(z.rect, 1);
        if (cells.some((c) => rectContains(near, c.col, c.row))) return false;
        if (z.level > 0 && stairFeet.some((s) => rectContains(grow(z.rect, 1), s.col, s.row) && cells.some((c) => cheb(c, s) <= 1))) return false;
        return true;
      });
      return {
        ok: disconnected.length === 0,
        score: zones.length ? (zones.length - disconnected.length) / zones.length : 1,
        note: disconnected.length ? `no walk reaches ${disconnected.map((z) => z.label).join(", ")}` : `${env.paths.length} path${env.paths.length === 1 ? "" : "s"} connect the place`,
        fix: disconnected.length ? `create_path {from: "plaza", to: "${disconnected[0].id}"}` : undefined,
        repairs: disconnected.map((z) => ({ tool: "create_path", args: { from: "plaza", to: z.id }, why: `${z.label} is cut off` })),
      };
    },
  },
  {
    id: "elevation_connected",
    law: "A raised level you can stand on always has a way up.",
    kind: "navigation",
    dimension: "navigation",
    weight: 1,
    when: (ctx) => Boolean(ctx.env?.platforms.some((p) => !p.inset && p.level > 0 && !isBackdrop(ctx.env!, p.id))),
    check: (ctx) => {
      const ok = (ctx.env?.stairs.length ?? 0) > 0;
      return { ok, note: ok ? "stairs join the levels" : "a raised deck has no way up", fix: "create_zone interior types bring their own stair", repairs: ok ? [] : [{ tool: "compose_scene", args: {}, why: "a raised room without a stair — recompose" }] };
    },
  },
  {
    id: "stairs_access",
    law: "Staircases keep a clear step-on and step-off — never blocked.",
    kind: "navigation",
    dimension: "navigation",
    weight: 1.5,
    critical: true,
    when: (ctx) => (ctx.env?.stairs.length ?? 0) > 0,
    check: (ctx) => {
      const approach = stairApproachLots(ctx.env);
      const blockers = ctx.located.filter(({ piece }) => piece.kind !== "character" && piece.kind !== "pet" && approach.has(piece.lot));
      return {
        ok: blockers.length === 0,
        note: blockers.length ? `stair approach blocked by ${blockers.map((b) => b.piece.id).slice(0, 3).join(", ")}` : "every stair has a clear step-on and step-off",
        fix: blockers.length ? `move_piece ${blockers[0].piece.id} away from the stair` : undefined,
        repairs: blockers.map((b) => ({ tool: "move_piece", args: { id: b.piece.id, off: "stairs" }, why: "blocking a stair" })),
      };
    },
  },
  {
    id: "paths_clear",
    law: "Walkways stay walkable — bulky objects never sit on a path.",
    kind: "navigation",
    dimension: "navigation",
    weight: 1.5,
    when: (ctx) => (ctx.env?.paths.length ?? 0) > 0,
    check: (ctx) => {
      const lots = pathLots(ctx.env);
      const blockers = ctx.located.filter(({ piece, item }) => piece.kind !== "character" && piece.kind !== "pet" && piece.kind !== "food" && item && clearanceLots(item) >= 0.6 && lots.has(piece.lot));
      return {
        ok: blockers.length === 0,
        score: Math.max(0, 1 - blockers.length / 3),
        note: blockers.length ? `path blocked by ${blockers.map((b) => `${b.piece.id}@${b.piece.lot}`).slice(0, 3).join(", ")}` : "walkways are clear",
        fix: blockers.length ? `move_piece ${blockers[0].piece.id} off the path` : undefined,
        repairs: blockers.map((b) => ({ tool: "move_piece", args: { id: b.piece.id, off: "path" }, why: "blocking a walkway" })),
      };
    },
  },
  {
    id: "grounded",
    law: "Everything stands ON the scene — nothing floats in the void.",
    kind: "placement",
    dimension: "placementValidity",
    weight: 2,
    critical: true,
    when: hasEnv,
    check: (ctx) => {
      const strays = ctx.located.filter(({ piece, at }) => {
        if (platformAt(ctx.env, at.col, at.row)) return false;
        const onWater = ctx.env!.water.some((w) => rectContains(w.rect, at.col, at.row));
        return !(onWater && (piece.kind === "boat" || piece.kind === "pirate"));
      });
      return {
        ok: strays.length === 0,
        score: Math.max(0, 1 - strays.length / Math.max(3, ctx.located.length * 0.1)),
        note: strays.length ? `${strays.length} piece${strays.length === 1 ? "" : "s"} off the architecture: ${strays.slice(0, 3).map((s) => s.piece.id).join(", ")}` : "everything stands on the scene",
        fix: strays.length ? "move_piece strays onto the platforms (or remove_piece)" : undefined,
        repairs: strays.map((s) => ({ tool: "move_piece", args: { id: s.piece.id, into_zone: "plaza" }, why: "floating off the deck" })),
      };
    },
  },
  {
    id: "no_overlap",
    law: "Meshes do not interpenetrate — every piece keeps its clearance.",
    kind: "placement",
    dimension: "placementValidity",
    weight: 1.5,
    when: (ctx) => ctx.located.length > 1,
    check: (ctx) => {
      const clashes: string[] = [];
      const withR = ctx.located.filter((l) => l.item).map((l) => ({ ...l, r: clearanceLots(l.item!) }));
      for (let i = 0; i < withR.length; i += 1) {
        for (let j = i + 1; j < withR.length; j += 1) {
          const a = withR[i], b = withR[j];
          // Tabletop goods and flat pieces may touch; bulky pairs may not.
          if (a.piece.kind === "food" || b.piece.kind === "food") continue;
          if (Math.hypot(a.at.col - b.at.col, a.at.row - b.at.row) < (a.r + b.r) * 0.7) clashes.push(`${a.piece.id}×${b.piece.id}`);
        }
      }
      return {
        ok: clashes.length === 0,
        score: Math.max(0, 1 - clashes.length / Math.max(3, ctx.located.length * 0.1)),
        note: clashes.length ? `${clashes.length} overlapping pair${clashes.length === 1 ? "" : "s"}: ${clashes.slice(0, 3).join(", ")}` : "nothing interpenetrates",
        fix: clashes.length ? `move_piece ${clashes[0].split("×")[1]} a step away` : undefined,
        repairs: clashes.slice(0, 6).map((c) => ({ tool: "move_piece", args: { id: c.split("×")[1], away_from: c.split("×")[0] }, why: "overlapping" })),
      };
    },
  },
  {
    id: "placement_fidelity",
    law: "What the plan placed is where the plan put it — no silent drift.",
    kind: "placement",
    dimension: "placementValidity",
    weight: 1.5,
    when: (ctx) => Boolean(ctx.plan && ctx.plan.todos.length),
    check: (ctx) => {
      const todos = ctx.plan!.todos.filter((t) => t.phase !== "environment");
      if (!todos.length) return { ok: true, score: 1, note: "no planned placements to check" };
      const byCatalog = new Map<string, { col: number; row: number }[]>();
      for (const l of ctx.located) byCatalog.set(l.piece.catalogId, [...(byCatalog.get(l.piece.catalogId) ?? []), l.at]);
      const lost = todos.filter((t) => {
        const at = parseLotId(t.lot);
        if (!at) return false;
        return !(byCatalog.get(t.place) ?? []).some((p) => cheb(p, at) <= 1);
      });
      const share = (todos.length - lost.length) / todos.length;
      const zones = [...new Set(lost.map((t) => t.zone).filter((z): z is string => Boolean(z) && z !== "edge"))];
      return {
        ok: share >= 0.85,
        score: share,
        note: lost.length ? `${lost.length}/${todos.length} planned pieces are not where the plan put them (${lost.slice(0, 3).map((t) => `${t.place}@${t.lot}`).join(", ")})` : `all ${todos.length} planned pieces stand where the plan put them`,
        fix: lost.length ? `populate_zones {zones: [${zones.map((z) => `"${z}"`).join(", ")}]}` : undefined,
        repairs: zones.map((z) => ({ tool: "populate_zones", args: { zones: [z] }, why: `planned pieces missing from ${z}` })),
      };
    },
  },
  {
    id: "ground_variety",
    law: "Themed ground is an ecosystem — multiple materials in intentional patches, never one tile.",
    kind: "environment",
    dimension: "environment",
    weight: 1,
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
        score: ok ? 1 : Math.min(1, materials.size / 3) * 0.6,
        note: ok ? `${materials.size} ground materials in patches (${patchCells} patched cells)` : `ground too uniform — ${materials.size} material${materials.size === 1 ? "" : "s"}, ${patchCells} patched cells`,
        fix: "apply_theme (or create_ground_patch)",
        repairs: ok ? [] : [{ tool: "apply_theme", args: { theme: ctx.env?.themeId ?? ctx.intent?.theme.id ?? "grassland" }, why: "ground reads as one tile" }],
      };
    },
  },
  {
    id: "environmental_boundary",
    law: "Outdoor scenes are framed — a forest edge or standing boundary, not an infinite board.",
    kind: "environment",
    dimension: "environment",
    weight: 1.5,
    when: (ctx) => Boolean(ctx.theme && ctx.theme.boundary !== "none") && ctx.intent?.archetype?.boundary !== "none",
    check: (ctx) => {
      const framing = ctx.located.filter(({ item, at }) => {
        if (!item) return false;
        const role = roleOf(item);
        if (role !== "scenery" && role !== "ground" && item.kind !== "tree") return false;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
          if (!platformAt(ctx.env, at.col + dc, at.row + dr)) return true;
        }
        return false;
      });
      const need = Math.max(6, Math.round(landCellCount(ctx.env) * 0.06));
      return {
        ok: framing.length >= need,
        score: Math.min(1, framing.length / need),
        note: framing.length >= need ? `${framing.length} framing pieces ring the scene` : `boundary too thin — ${framing.length}/${need} framing pieces at the edge`,
        fix: 'create_environment (or create_vegetation {area: "edge"})',
        repairs: framing.length >= need ? [] : [{ tool: "create_environment", args: { density: "medium" }, why: "the edge is bare" }],
      };
    },
  },
  {
    id: "density",
    law: "Density leaves intentional negative space — composed, not packed, not barren.",
    kind: "composition",
    dimension: "composition",
    weight: 1,
    when: hasEnv,
    check: (ctx) => {
      const land = landCellCount(ctx.env);
      // Boats and buoys ride on the water; they neither crowd nor fill the ground.
      const ashore = ctx.located.filter((l) => platformAt(ctx.env, l.at.col, l.at.row)).length;
      const density = land ? ashore / land : 0;
      const ok = density >= 0.28 && density <= 0.75;
      return {
        ok,
        score: ok ? 1 : density < 0.28 ? density / 0.28 : Math.max(0, 1 - (density - 0.75)),
        note: !land ? "no deck to measure" : density < 0.28 ? `sparse (${ashore} pieces on ${land} cells) — bare ground shows` : density > 0.75 ? `crowded (${ashore} pieces on ${land} cells) — remove clutter, keep breathing room` : "the ground is full without being packed",
        fix: density < 0.28 ? "create_environment (texture fills the open ground)" : density > 0.75 ? "remove_piece the least purposeful clutter" : undefined,
        repairs: !ok && density < 0.28 ? [{ tool: "create_environment", args: {}, why: "the scene is sparse" }] : [],
      };
    },
  },
];

export const COVERAGE_TARGET = 0.72;

/** Share of land cells that have a piece within one cell — "no white space". */
export function coverageOf(env: EnvironmentSpec | null, located: RuleContext["located"]): number {
  if (!env) return 0;
  const occupied = new Set(located.map((l) => `${l.at.col}:${l.at.row}`));
  let land = 0;
  let covered = 0;
  const seen = new Set<string>();
  for (const p of env.platforms) {
    if (p.inset || p.material === "road" || p.id === "pier") continue;
    for (let r = p.rect.r0; r < p.rect.r0 + p.rect.d; r += 1) {
      for (let c = p.rect.c0; c < p.rect.c0 + p.rect.w; c += 1) {
        const k = `${c}:${r}`;
        if (seen.has(k)) continue;
        seen.add(k);
        land += 1;
        let near = false;
        for (let dr = -1; dr <= 1 && !near; dr += 1) for (let dc = -1; dc <= 1; dc += 1) if (occupied.has(`${c + dc}:${r + dr}`)) { near = true; break; }
        if (near) covered += 1;
      }
    }
  }
  return land ? covered / land : 0;
}

SCENE_RULES.push({
  id: "water_dressed",
  law: "Water is a place too — buoys, rocks and boats at anchor, never an empty blue field.",
  kind: "environment",
  dimension: "environment",
  weight: 1,
  when: (ctx) => hasEnv(ctx) && waterCells(ctx.env!).length >= 12,
  check: (ctx) => {
    const need = waterNeed(ctx.env!, ctx.located.map((l) => l.at));
    const want = Math.max(3, Math.round(waterCells(ctx.env!).length * WATER_DENSITY));
    const have = want - need;
    return {
      ok: need === 0,
      score: Math.min(1, have / want),
      note: need === 0 ? `the water is dressed (${have} afloat)` : `bare water — ${have} of ${want} pieces afloat`,
      fix: need === 0 ? undefined : "create_environment (moors boats, buoys and rocks on the open water)",
      repairs: need === 0 ? [] : [{ tool: "create_environment", args: {}, why: "the water is empty" }],
    };
  },
});

SCENE_RULES.push({
  id: "coverage",
  law: "The ground is full — no stretch of bare land reads as white space.",
  kind: "composition",
  dimension: "composition",
  weight: 2,
  when: hasEnv,
  check: (ctx) => {
    const share = coverageOf(ctx.env, ctx.located);
    return {
      ok: share >= COVERAGE_TARGET,
      score: Math.min(1, share / COVERAGE_TARGET),
      note: share >= COVERAGE_TARGET ? `${Math.round(share * 100)}% of the ground has something on or beside it` : `bare ground shows — only ${Math.round(share * 100)}% of the land has anything near it`,
      fix: share >= COVERAGE_TARGET ? undefined : "create_environment (fills open ground with texture)",
      repairs: share >= COVERAGE_TARGET ? [] : [{ tool: "create_environment", args: {}, why: "open ground shows" }],
    };
  },
});

function isBackdrop(env: EnvironmentSpec, platformId: string): boolean {
  // Hills and mountains are scenery you look at, not rooms you enter.
  if (platformId.startsWith("hill-")) return true;
  const p = env.platforms.find((x) => x.id === platformId);
  if (!p) return false;
  return env.zones.some((z) => z.type === "skyline" && z.rect.c0 === p.rect.c0 && z.rect.r0 === p.rect.r0);
}
