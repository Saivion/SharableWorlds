"use client";

import { CATALOG, catalogItem, defaultForKind, FEATURED, type CatalogItem } from "./catalog";
import { ARCHETYPES } from "./composition/archetypes";
import type { ComposedPlan, SceneTodo } from "./composition/compose";
import { understandIntent } from "./composition/intent";
import { facingVector } from "./composition/layout";
import {
  addZone,
  clusterForZone,
  focalCandidate,
  pathBetweenPoints,
  resolvePoint,
  type ZoneLocation,
  type ZoneSize,
} from "./composition/ops";
import { programTexture, programZone } from "./composition/program";
import { coverageOf, COVERAGE_TARGET, buildRuleContext } from "./composition/rules";
import { bodiesCollide, clearanceLots } from "./composition/scale3d";
import {
  GENERATOR_VERSION,
  createSeededRandom,
  deriveSeed,
  fingerprint,
  generateSceneSeed,
  isValidSeed,
  normalizeSeed,
  shareUrl,
} from "./composition/seed";
import { pathLots, platformAt, reservedLots, surfaceAt, zoneAt } from "./composition/surface";
import { rectContains } from "./composition/grid3d";
import { cellKey } from "./composition/island";
import { SCENE_RULES } from "./composition/rules";
import {
  boundaryPool,
  buildFrameSkip,
  landMaskFromEnv,
  paintTerrain,
  planBoundary,
  withWaterPaint,
} from "./composition/terrain";
import { THEMES, resolveTheme, themeById } from "./composition/themes";
import { GROUND_MATERIALS, type GroundCell, type PlatformMaterial, type ZoneType } from "./composition/types";
import { validateScene, type ValidationReport } from "./composition/validate";
import { snapLotCoord } from "./iso";
import { clampLabel, useTown, type BuildPhase, type TraceCaller } from "./store";
import { buildStory, phraseForCatalog } from "./story";
import { planCompleteScene } from "./scenePlan";
import type { Owner, Piece, Side } from "./types";
import { isSide, SIDES } from "./types";

/**
 * The lot map: occupancy, the Kenney catalog, the placement engine, and the
 * WebMCP tools. One module on purpose — the page UI and the agent tools call
 * the same functions, so the two writers can never drift apart.
 *
 * The agent never sends pixel coordinates. It speaks in catalog ids
 * ("pirate-ship-pirate-large"), lots ("C3"), and relationships ("east of
 * market-display-fruit-1"). The page owns all geometry and rendering.
 */

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** Home window for the starting camera — placement itself is unbounded. */
export const GRID = { cols: 26, rows: 26 } as const;
/** Abstract cell size for distance math (not render geometry). */
export const CELL = 10;
const METRIC_ORIGIN = { x: 10, y: 10 } as const;

function colLetters(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseColLetters(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    const c = letters.charCodeAt(i) - 64;
    if (c < 1 || c > 26) return Number.NaN;
    n = n * 26 + c;
  }
  return n - 1;
}

export function lotId(col: number, row: number) {
  const c = snapLotCoord(col);
  const r = snapLotCoord(row);
  if (Number.isInteger(c) && Number.isInteger(r) && c >= 0 && r >= 0) {
    return `${colLetters(c)}${r + 1}`;
  }
  return `C${c}R${r}`;
}

/** Lot parser — A1 / M13 / AA2, or C{col}R{row} (halves and negatives). */
export function parseLot(value: unknown): { col: number; row: number } | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toUpperCase();
  const cr = /^C(-?\d+(?:\.5)?)R(-?\d+(?:\.5)?)$/.exec(text);
  if (cr) return { col: snapLotCoord(Number(cr[1])), row: snapLotCoord(Number(cr[2])) };
  const m = /^([A-Z]+)(\d+)$/.exec(text);
  if (!m) return null;
  const col = parseColLetters(m[1]);
  const row = Number(m[2]) - 1;
  if (!Number.isFinite(col) || row < 0) return null;
  return { col, row };
}

function lotCenter(lot: string) {
  const parsed = parseLot(lot);
  if (!parsed) return { x: 50, y: 50 };
  return {
    x: METRIC_ORIGIN.x + parsed.col * CELL + CELL / 2,
    y: METRIC_ORIGIN.y + parsed.row * CELL + CELL / 2,
  };
}

/** Growth preference: east, then south, then west, then north. */
const SIDE_ORDER: Side[] = ["east", "south", "west", "north"];
const SIDE_DELTA: Record<Side, { dc: number; dr: number }> = {
  east: { dc: 1, dr: 0 },
  south: { dc: 0, dr: 1 },
  west: { dc: -1, dr: 0 },
  north: { dc: 0, dr: -1 },
};

function stepLot(lot: string, side: Side, gap: number): string | null {
  const parsed = parseLot(lot);
  if (!parsed) return null;
  const { dc, dr } = SIDE_DELTA[side];
  return lotId(parsed.col + dc * gap, parsed.row + dr * gap);
}

/** Nearby empty lots around occupied cells (or the home center if empty). */
export function nearbyEmpties(occ = occupancyMap(), count = 24): string[] {
  const seeds: { col: number; row: number }[] = [];
  for (const lot of occ.keys()) {
    const parsed = parseLot(lot);
    if (parsed) seeds.push(parsed);
  }
  if (!seeds.length) {
    for (const lot of CENTER_LOTS) {
      const parsed = parseLot(lot);
      if (parsed) seeds.push(parsed);
    }
  }
  const seen = new Set<string>(occ.keys());
  const out: string[] = [];
  const reserved = reservedLots(useTown.getState().environment);
  const walkways = pathLots(useTown.getState().environment);
  for (let ring = 1; out.length < count && ring < 16; ring += 1) {
    for (const seed of seeds) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        for (let dr = -ring; dr <= ring; dr += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          const lot = lotId(seed.col + dc, seed.row + dr);
          if (seen.has(lot)) continue;
          seen.add(lot);
          // Empty means standable: on the architecture, not a stair, not a walk.
          if (!lotOnScene(lot) || reserved.has(lot) || walkways.has(lot)) continue;
          out.push(lot);
          if (out.length >= count) return out;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

function piecesList(): Piece[] {
  return Object.values(useTown.getState().pieces).sort((a, b) => a.bornAt - b.bornAt);
}

/** lot -> piece for every occupied lot. */
export function occupancyMap(): Map<string, Piece> {
  const map = new Map<string, Piece>();
  for (const piece of piecesList()) map.set(piece.lot, piece);
  return map;
}

/**
 * Another piece whose mesh would occupy the same floor as `item` on `lot`.
 * Same-lot occupancy is a special case of this (distance 0).
 */
export function lotCollision(lot: string, item: CatalogItem, ignoreId?: string): Piece | null {
  const at = parseLot(lot);
  if (!at) return null;
  const r = clearanceLots(item);
  for (const piece of piecesList()) {
    if (piece.id === ignoreId) continue;
    const other = catalogItem(piece.catalogId);
    if (!other) continue;
    const otherAt = parseLot(piece.lot);
    if (!otherAt) continue;
    // One rule for planner, engine, and validator (scale3d.bodiesCollide).
    if (bodiesCollide({ col: at.col, row: at.row, r, kind: item.kind }, { col: otherAt.col, row: otherAt.row, r: clearanceLots(other), kind: other.kind })) {
      return piece;
    }
  }
  return null;
}

function lotOnScene(lot: string): boolean {
  const env = useTown.getState().environment;
  if (!env) return true;
  const at = parseLot(lot);
  if (!at) return false;
  if (platformAt(env, at.col, at.row)) return true;
  return env.water.some((w) => rectContains(w.rect, at.col, at.row));
}

/** The nearest standable lot within `ring` steps — never on a stair, never
 * off the architecture, and (for bulky pieces) never on a walkway. `accept`
 * narrows the search further (inside a zone, away from a piece). */
function searchClearLot(
  from: { col: number; row: number },
  item: CatalogItem,
  occ: Map<string, Piece>,
  ignoreId?: string,
  ring = 2,
  accept?: (lot: string, col: number, row: number) => boolean,
): string | null {
  const env = useTown.getState().environment;
  const reserved = reservedLots(env);
  const walkways = pathLots(env);
  const bulky = item.kind !== "character" && item.kind !== "pet" && item.kind !== "food" && clearanceLots(item) >= 0.6;
  for (let r = 0; r <= ring; r += 1) {
    for (let dc = -r; dc <= r; dc += 1) {
      for (let dr = -r; dr <= r; dr += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const col = from.col + dc;
        const row = from.row + dr;
        const lot = lotId(col, row);
        if (occ.has(lot) && occ.get(lot)?.id !== ignoreId) continue;
        if (reserved.has(lot)) continue;
        if (!lotOnScene(lot)) continue;
        if (bulky && walkways.has(lot)) continue;
        if (lotCollision(lot, item, ignoreId)) continue;
        if (accept && !accept(lot, col, row)) continue;
        return lot;
      }
    }
  }
  return null;
}

export function emptyLots(occ = occupancyMap()): string[] {
  return nearbyEmpties(occ, 24);
}

function humanLockLots(occ = occupancyMap()): string[] {
  return [...occ.entries()].filter(([, p]) => p.locked).map(([lot]) => lot);
}

function centroidOf(lots: string[]) {
  if (!lots.length) return { x: 50, y: 50 };
  const pts = lots.map(lotCenter);
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

const CENTER_LOTS = ["M13", "N13", "M14", "N14"];

/**
 * Auto-pick a lot when the caller gave neither `lot` nor `relative_to`.
 * Empty board: the center 2x2 — never a corner. Otherwise: empty lots
 * adjacent to existing pieces, nearest the scene's centroid, so the scene
 * grows instead of scattering.
 */
export function chooseAutoLot(occ = occupancyMap(), item?: CatalogItem, ignoreId?: string): string | null {
  const reserved = reservedLots(useTown.getState().environment);
  const open = (lot: string) =>
    !occ.has(lot) && !reserved.has(lot) && (!item || !lotCollision(lot, item, ignoreId));
  if (occ.size === 0) {
    return CENTER_LOTS.find((lot) => open(lot)) ?? CENTER_LOTS[0] ?? null;
  }
  const seen = new Set<string>();
  const candidates: string[] = [];
  const occupied = [...occ.keys()];
  for (const lot of occupied) {
    for (const gap of [2, 3, 4, 1]) {
      for (const side of SIDE_ORDER) {
        const next = stepLot(lot, side, gap);
        if (next && open(next) && !seen.has(next)) {
          seen.add(next);
          candidates.push(next);
        }
      }
    }
  }
  let pool = candidates.length ? candidates : emptyLots(occ).filter(open);
  if (!pool.length) return null;
  // When the scene has authored architecture, auto-growth stays ON it — the
  // agent should fill the place it was given, not sprawl into the void.
  const env = useTown.getState().environment;
  if (env) {
    const onDeck = pool.filter((lot) => {
      const p = parseLot(lot);
      return p != null && platformAt(env, p.col, p.row) != null;
    });
    if (onDeck.length) pool = onDeck;
  }
  const center = centroidOf(occupied);
  let best = pool[0];
  let bestDist = Infinity;
  for (const lot of pool) {
    const p = lotCenter(lot);
    const d = (p.x - center.x) ** 2 + (p.y - center.y) ** 2;
    if (d < bestDist - 1e-9) {
      bestDist = d;
      best = lot;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Snapshot — the world model every tool result carries. Stays under ~1.4K
// chars so Chrome's site-tool output cap never truncates it mid-JSON.
// ---------------------------------------------------------------------------

const RESULT_BUDGET = 1400;

export function occupancySnapshot() {
  const state = useTown.getState();
  const occ = occupancyMap();
  const env = state.environment;
  return {
    grid: { infinite: true },
    catalog_pieces: CATALOG.length,
    catalog_packs: FEATURED.length,
    goal: state.nudgeGoal,
    // Compact zone map when architecture exists — "id:type@ColRow WxD".
    ...(env?.zones.length
      ? {
          zones: env.zones.map(
            (z) => `${z.id}:${z.type}@${lotId(z.rect.c0, z.rect.r0)} ${z.rect.w}x${z.rect.d}${z.level ? ` up${z.level}` : ""}`,
          ),
        }
      : {}),
    filled: [...occ.entries()].map(([lot, p]) => `${lot}:${p.id}:${p.owner}`),
    empty: nearbyEmpties(occ, 24),
    human_locks: humanLockLots(occ),
    selection: state.selection.slice(0, 8),
    last_human_actions: state.humanActions.slice(-3).map((a) => a.slice(0, 48)),
  };
}

/** Serialize, shrinking the least important fields first if over budget. */
function fitJson(payload: Record<string, unknown>): string {
  let text = JSON.stringify(payload);
  if (text.length <= RESULT_BUDGET) return text;
  const trimmed = { ...payload } as Record<string, unknown>;
  trimmed.last_human_actions = (trimmed.last_human_actions as string[] | undefined)?.slice(-1);
  text = JSON.stringify(trimmed);
  if (text.length <= RESULT_BUDGET) return text;
  const occ = trimmed.occupancy as Record<string, unknown> | undefined;
  const target = occ ?? trimmed;
  if (Array.isArray(target.filled)) {
    const byPack: Record<string, number> = {};
    for (const entry of target.filled as string[]) {
      const pack = entry.split(":")[1]?.split("-")[0] ?? "?";
      byPack[pack] = (byPack[pack] ?? 0) + 1;
    }
    target.filled = byPack;
    target.note = "filled compressed to counts; use get_scene or lookup_object";
  }
  return JSON.stringify(trimmed);
}

function ok(payload: Record<string, unknown>): ModelContextToolResult {
  return { content: [{ type: "text", text: fitJson(payload) }] };
}

/** Full JSON for tools whose payload is the point (plans, catalog browse). */
function okWide(payload: Record<string, unknown>): ModelContextToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(why: string, extra: Record<string, unknown> = {}): ModelContextToolResult {
  return {
    content: [{ type: "text", text: fitJson({ error: why, ...extra }) }],
    isError: true,
  };
}

/** Recovery hint for a refused write: who is in the way, where is free. */
function occupiedHint(lot: string, occ = occupancyMap(), item?: CatalogItem) {
  const holder = occ.get(lot);
  const empties = nearestEmpties(lot, occ, 4, item);
  return {
    error: holder
      ? `Lot ${lot} occupied by ${holder.id} (${holder.owner}${holder.locked ? ", locked" : ""}).`
      : `Lot ${lot} unavailable.`,
    empty_nearby: empties,
  };
}

function nearestEmpties(fromLot: string, occ = occupancyMap(), count = 4, item?: CatalogItem): string[] {
  const from = lotCenter(fromLot);
  return emptyLots(occ)
    .filter((lot) => !item || !lotCollision(lot, item))
    .map((lot) => {
      const p = lotCenter(lot);
      return { lot, d: (p.x - from.x) ** 2 + (p.y - from.y) ** 2 };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((e) => e.lot);
}

/**
 * Resolve after the store change has painted, so the human watches pieces
 * appear while the agent is still looping.
 */
function afterRender(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  // A hidden tab never paints — waiting would only hit throttled timers.
  if (document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    // rAF does not fire in hidden tabs — the timeout keeps tools from hanging
    // when the host backgrounds the page mid-loop.
    const timer = window.setTimeout(resolve, 120);
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          window.clearTimeout(timer);
          resolve();
        }),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Placement engine — the single write path for both writers.
// ---------------------------------------------------------------------------

export type PlaceSpec = {
  item: CatalogItem;
  lot?: string;
  relativeTo?: string;
  side?: Side;
  gap?: number;
  flip?: boolean;
  /** Yaw in quarter turns of degrees (0|90|180|270) — which way the piece faces. */
  rot?: number;
  /** The planner's zone reason ("the centerpiece"), carried into the story log. */
  reason?: string;
  /** Lots a nudge must leave free — the cells later todos in the same batch still need. */
  avoidLots?: Set<string>;
};

/** Valid quarter-turn rotations; anything else is normalized to the nearest. */
export function clampRot(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const snapped = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return snapped === 0 ? undefined : snapped;
}

export type PlaceOutcome =
  | { ok: true; piece: Piece; requested?: string }
  | { ok: false; why: string; empty_nearby?: string[]; lot?: string };

/**
 * Place one catalog object. The page picks and validates the cell; raw x,y
 * never enters this function. Refuses occupied lots, overlapping footprints,
 * and never touches locked ones.
 */
export function placePiece(spec: PlaceSpec, owner: Owner): PlaceOutcome {
  const occ = occupancyMap();
  let lot: string | null = null;
  const reserved = reservedLots(useTown.getState().environment);

  let requested: string | undefined;
  if (spec.lot != null) {
    const parsed = parseLot(spec.lot);
    if (!parsed) {
      return { ok: false, why: `"${String(spec.lot)}" is not a lot. Use A1-style ids (C4, M13).` };
    }
    lot = lotId(parsed.col, parsed.row);
    requested = lot;
    const holder = occ.get(lot);
    const env = useTown.getState().environment;
    const bulky = spec.item.kind !== "character" && spec.item.kind !== "pet" && spec.item.kind !== "food" && clearanceLots(spec.item) >= 0.6;
    const blockedBy = holder
      ? `Lot ${lot} occupied by ${holder.id} (${holder.owner}${holder.locked ? ", locked" : ""})`
      : reserved.has(lot)
        ? `Lot ${lot} holds the stairs`
        : env && !lotOnScene(lot)
          ? `Lot ${lot} is off the scene`
          : owner === "agent" && bulky && pathLots(env).has(lot)
            ? `Lot ${lot} is a walkway`
            : lotCollision(lot, spec.item)
              ? `Too close to ${lotCollision(lot, spec.item)!.id}`
              : null;
    if (blockedBy) {
      if (owner === "human") {
        return { ok: false, why: `${blockedBy} — pick a clearer spot.`, empty_nearby: nearestEmpties(lot, occ, 4, spec.item), lot };
      }
      // The agent asked for a place, not a cell: the nearest standable lot
      // within two cells is taken and REPORTED (requested_lot + drift) —
      // never a silent relocation blocks away, never a lot a later piece of
      // the same batch still needs.
      const alt = searchClearLot(parsed, spec.item, occ, undefined, 2, spec.avoidLots ? (l) => !spec.avoidLots!.has(l) : undefined);
      if (!alt) {
        return { ok: false, why: `${blockedBy} and nothing clear within 2 cells.`, empty_nearby: nearestEmpties(lot, occ, 4, spec.item), lot };
      }
      lot = alt;
    }
  } else if (spec.relativeTo != null) {
    const anchor = useTown.getState().pieces[String(spec.relativeTo).trim()];
    if (!anchor) {
      return { ok: false, why: `No piece "${String(spec.relativeTo)}". Use ids from get_occupancy.` };
    }
    const side = spec.side ?? "east";
    let gap = Math.min(4, Math.max(0.5, Math.round(Number(spec.gap ?? 1) * 2) / 2 || 1));
    lot = stepLot(anchor.lot, side, gap);
    requested = lot ?? undefined;
    while (lot && (occ.has(lot) || reserved.has(lot) || lotCollision(lot, spec.item) || !lotOnScene(lot))) {
      gap += 1;
      if (gap > 4) {
        const at = parseLot(anchor.lot);
        lot = at ? searchClearLot(at, spec.item, occ, undefined, 2) : null;
        break;
      }
      lot = stepLot(anchor.lot, side, gap);
    }
    if (!lot) {
      return {
        ok: false,
        why: `${side} of ${anchor.id} (${anchor.lot}) has no clear lot.`,
        empty_nearby: nearestEmpties(anchor.lot, occ, 4, spec.item),
      };
    }
  } else {
    lot = chooseAutoLot(occ, spec.item);
    if (!lot) return { ok: false, why: "No empty lots left that fit this piece." };
  }

  const holder = occ.get(lot);
  if (holder) {
    const hint = occupiedHint(lot, occ, spec.item);
    return { ok: false, why: hint.error, empty_nearby: hint.empty_nearby, lot };
  }
  if (reserved.has(lot)) {
    return {
      ok: false,
      why: `Lot ${lot} holds the stairs — nothing can stand there.`,
      empty_nearby: nearestEmpties(lot, occ, 4, spec.item),
      lot,
    };
  }
  const blocker = lotCollision(lot, spec.item);
  if (blocker) {
    return {
      ok: false,
      why: `Too close to ${blocker.id}.`,
      empty_nearby: nearestEmpties(lot, occ, 4, spec.item),
      lot,
    };
  }
  // HARD walkway rule for the agent: bulky pieces never block a path.
  // Characters, pets, and tabletop food may stand on one — a walkway with
  // people on it is alive; a walkway with a wardrobe on it is blocked.
  if (
    owner === "agent" &&
    spec.item.kind !== "character" &&
    spec.item.kind !== "pet" &&
    spec.item.kind !== "food" &&
    clearanceLots(spec.item) >= 0.6 &&
    pathLots(useTown.getState().environment).has(lot)
  ) {
    return {
      ok: false,
      why: `Lot ${lot} is a walkway — paths stay walkable. Place beside it.`,
      empty_nearby: nearestEmpties(lot, occ, 4, spec.item),
      lot,
    };
  }

  const store = useTown.getState();
  const id = `${spec.item.id}-${store.bumpCounter(spec.item.id)}`;
  const piece: Piece = {
    id,
    catalogId: spec.item.id,
    kind: spec.item.kind,
    lot,
    owner,
    locked: owner === "human",
    label: "",
    color: "",
    flip: Boolean(spec.flip),
    ...(spec.rot ? { rot: spec.rot } : {}),
    bornAt: Date.now(),
  };
  store.addPiece(piece);
  return { ok: true, piece, ...(requested ? { requested } : {}) };
}

/**
 * The placement record every write returns — enough for an agent to reason
 * about the world: where it asked, where the piece stands, how far it was
 * nudged, what it stands on, which zone and level, which way it faces.
 */
export function describePiece(piece: Piece, requested?: string) {
  const env = useTown.getState().environment;
  const at = parseLot(piece.lot);
  const req = requested ? parseLot(requested) : null;
  const drift = at && req ? Math.max(Math.abs(at.col - req.col), Math.abs(at.row - req.row)) : 0;
  const surface = at ? surfaceAt(env, at.col, at.row) : null;
  const zone = at ? zoneAt(env, at.col, at.row) : null;
  const item = catalogItem(piece.catalogId);
  const facing = { 0: "south", 90: "west", 180: "north", 270: "east" }[piece.rot ?? 0] ?? "south";
  return {
    id: piece.id,
    catalog_id: piece.catalogId,
    kind: piece.kind,
    lot: piece.lot,
    ...(requested && requested !== piece.lot ? { requested_lot: requested, drift } : {}),
    zone: zone ? zone.id : "open",
    level: surface?.level ?? 0,
    surface: surface ? (surface.kind === "platform" ? surface.platform?.material ?? "deck" : surface.kind) : "void",
    facing,
    ...(piece.flip ? { flip: true } : {}),
    clearance: item ? Math.round(clearanceLots(item) * 100) / 100 : undefined,
    on_path: pathLots(env).has(piece.lot),
    owner: piece.owner,
    ...(piece.locked ? { locked: true } : {}),
    ...(piece.label ? { label: piece.label } : {}),
  };
}

// --- Human write path (same engine, plus undo + activity log) --------------

export function humanPlace(catalogId: string, lot: string): PlaceOutcome {
  const item = catalogItem(catalogId);
  if (!item) return { ok: false, why: `Unknown catalog id "${catalogId}".` };
  const outcome = placePiece({ item, lot }, "human");
  const store = useTown.getState();
  if (outcome.ok) {
    store.pushUndo({ t: "place", id: outcome.piece.id });
    store.recordHumanAction(`placed ${item.label} at ${outcome.piece.lot}`);
    store.setSelection([outcome.piece.id]);
    store.pushEvent({
      actor: "human",
      verb: "place",
      pieceId: outcome.piece.id,
      catalogId: item.id,
      kind: item.kind,
      lot: outcome.piece.lot,
      label: item.label,
    });
  }
  return outcome;
}

export function humanMove(id: string, lot: string): PlaceOutcome {
  const store = useTown.getState();
  const piece = store.pieces[id];
  if (!piece) return { ok: false, why: `No piece "${id}".` };
  const parsed = parseLot(lot);
  if (!parsed) return { ok: false, why: `"${lot}" is not a lot.` };
  const target = lotId(parsed.col, parsed.row);
  if (target === piece.lot) return { ok: true, piece };
  const holder = occupancyMap().get(target);
  if (holder && holder.id !== piece.id) {
    return { ok: false, why: `Lot ${target} is occupied by ${holder.id}.` };
  }
  if (reservedLots(store.environment).has(target)) {
    return { ok: false, why: `Lot ${target} holds the stairs.` };
  }
  const item = catalogItem(piece.catalogId);
  if (item) {
    const blocker = lotCollision(target, item, piece.id);
    if (blocker) return { ok: false, why: `Too close to ${blocker.id} — pick a clearer spot.` };
  }
  store.pushUndo({ t: "move", id, prevLot: piece.lot });
  store.patchPiece(id, { lot: target });
  store.recordHumanAction(`moved ${piece.id} to ${target}`);
  store.pushEvent({
    actor: "human",
    verb: "move",
    pieceId: piece.id,
    catalogId: piece.catalogId,
    kind: piece.kind,
    lot: target,
  });
  store.setSelection([id]);
  return { ok: true, piece: { ...piece, lot: target } };
}

export function humanFlip(id: string, flip?: boolean) {
  const store = useTown.getState();
  const piece = store.pieces[id];
  if (!piece) return;
  const next = flip ?? !piece.flip;
  if (next === Boolean(piece.flip)) return;
  store.pushUndo({ t: "flip", id, prev: Boolean(piece.flip) });
  store.patchPiece(id, { flip: next });
  store.recordHumanAction(`${next ? "flipped" : "unflipped"} ${piece.id}`);
  store.pushEvent({
    actor: "human",
    verb: "flip",
    pieceId: piece.id,
    catalogId: piece.catalogId,
    kind: piece.kind,
    lot: piece.lot,
    flip: next,
  });
}

export function humanLabel(id: string, text: string) {
  const store = useTown.getState();
  const piece = store.pieces[id];
  if (!piece) return;
  store.pushUndo({ t: "label", id, prev: piece.label });
  store.patchPiece(id, { label: text });
  store.recordHumanAction(`renamed ${piece.id} to "${clampLabel(text)}"`);
  store.pushEvent({ actor: "human", verb: "label", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot, label: clampLabel(text) });
}

export function humanRemove(id: string) {
  const store = useTown.getState();
  const piece = store.pieces[id];
  if (!piece) return;
  store.pushUndo({ t: "remove", piece });
  store.deletePiece(id);
  store.recordHumanAction(`removed ${piece.id} from ${piece.lot}`);
  store.pushEvent({ actor: "human", verb: "remove", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot });
}

// ---------------------------------------------------------------------------
// Agent input parsing + write narration
// ---------------------------------------------------------------------------

const ID_EXAMPLES =
  "market-display-fruit, pirate-ship-pirate-large, pets-animal-cat, food-burger-cheese, furniture-lounge-sofa, nature-tree-oak, coaster-station, toycar-vehicle-racer, space-room-large";

function resolveItem(input: Record<string, unknown>): CatalogItem | { error: string } {
  if (input.id != null) {
    const item = catalogItem(String(input.id));
    if (item) return item;
    return { error: `Unknown catalog id "${String(input.id)}". Examples: ${ID_EXAMPLES}. Full list in /assets/kenney/catalog.json.` };
  }
  if (input.kind != null) {
    const item = defaultForKind(String(input.kind));
    if (item) return item;
    return { error: `No catalog item of kind "${String(input.kind)}". Pass a catalog id instead. Examples: ${ID_EXAMPLES}.` };
  }
  return { error: `Pass id (catalog id, preferred) or kind. Examples: ${ID_EXAMPLES}.` };
}

function parsePlaceSpec(input: Record<string, unknown>): PlaceSpec | { error: string } {
  if (input.x != null || input.y != null) {
    return { error: "This canvas has no x,y. Target a lot (like C4) or relative_to + side." };
  }
  const item = resolveItem(input);
  if ("error" in item) return item;
  const spec: PlaceSpec = { item };
  if (input.lot != null) spec.lot = String(input.lot);
  if (input.relative_to != null) spec.relativeTo = String(input.relative_to);
  if (input.side != null) {
    if (!isSide(input.side)) return { error: `side must be ${SIDES.join("|")}.` };
    spec.side = input.side;
  }
  if (input.gap != null) spec.gap = Number(input.gap);
  if (input.flip != null) spec.flip = Boolean(input.flip);
  if (input.rot != null) spec.rot = clampRot(input.rot);
  if (input.reason != null) spec.reason = String(input.reason).slice(0, 60);
  return spec;
}

function agentPlaceOne(spec: PlaceSpec): PlaceOutcome {
  const outcome = placePiece(spec, "agent");
  if (outcome.ok) {
    const store = useTown.getState();
    store.setAgentLastMove(`placed ${phraseForCatalog(outcome.piece.catalogId, outcome.piece.kind)}`);
    store.pushEvent({
      actor: "agent",
      verb: "place",
      pieceId: outcome.piece.id,
      catalogId: spec.item.id,
      kind: spec.item.kind,
      lot: outcome.piece.lot,
      label: spec.item.label,
      // Zone reason rides `detail` so the story can narrate the scene as a
      // built place ("first came the centerpiece...") instead of a sequence.
      ...(spec.reason ? { detail: spec.reason } : {}),
    });
  }
  return outcome;
}

/** Clamp a model-provided narration line for the status chip. */
function chipText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, 90);
  return text.length ? text : null;
}

/** Show the model's stated intent on the canvas the moment a write starts.
 * During a local Surprise-Me build loop the runner owns the chip (it sets the
 * line before travel so the text matches the cursor), so skip it here. */
function beginWrite(intent: string | null, ghost: { lot: string; catalogId: string } | null) {
  const store = useTown.getState();
  if (intent && !store.agentLoop) store.setAgentStatus(intent);
  store.setAgentGhost(ghost);
  store.setAgentBusy(true);
}

/** Swap the chip to what actually happened; drop the ghost. Canvas-facing — never a catalog id. */
function endWrite(chip: string | null) {
  const store = useTown.getState();
  // During a multi-piece loop the in-flight intent ("placing a stump") is the
  // better live line; don't flash "placed …" after every write.
  if (chip && !store.agentLoop) store.setAgentStatus(chip);
  store.setAgentGhost(null);
  if (!store.agentLoop) store.setAgentBusy(false);
}

function chipPlace(piece: { catalogId: string; kind: Piece["kind"] }): string {
  return `placed ${phraseForCatalog(piece.catalogId, piece.kind)}`;
}

/** One line about the human context, for `noticed` and the status chip. */
function humanNotice(skips: string[]): string | null {
  const occ = occupancyMap();
  const locks = humanLockLots(occ);
  if (skips.length) return `${skips.length} lot${skips.length === 1 ? "" : "s"} skipped (${skips.slice(0, 3).join(", ")})`;
  if (locks.length) {
    const kinds = locks.map((lot) => occ.get(lot)?.kind ?? "piece");
    return `${locks.length} human ${kinds[0]}${locks.length === 1 ? "" : "s"} at ${locks.slice(0, 4).join(" ")} — untouched`;
  }
  return null;
}

/** Ease the camera to frame the scene the first time the agent builds. */
function focusCameraIfFirstBuild(hadPiecesBefore: boolean) {
  if (!hadPiecesBefore && occupancyMap().size > 0 && !useTown.getState().environment) {
    useTown.getState().bumpFocus();
  }
}

// ---------------------------------------------------------------------------
// Plans — UNDERSTAND + PLAN + COMPOSE, deterministically, never a mutation.
// The plan for (prompt, seed) is cached on the store so the staged tools
// (compose_scene → populate_zones → create_environment) all read the same
// composition, and so validation can score the world against it.
// ---------------------------------------------------------------------------

function occupiedBodies(keepHumanLots: boolean) {
  return piecesList().flatMap((piece) => {
    if (!keepHumanLots && piece.owner !== "human") return [];
    if (keepHumanLots && piece.owner !== "human") return [];
    const at = parseLot(piece.lot);
    if (!at) return [];
    const item = catalogItem(piece.catalogId);
    return [{ col: at.col, row: at.row, r: item ? clearanceLots(item) : 0.7, kind: item?.kind }];
  });
}

/** Plan a scene: the human's pieces are obstacles; the agent's are not (a
 * new plan replaces the agent's previous build). */
function planFor(theme: string, sceneSeed?: string): ComposedPlan {
  return planCompleteScene(theme, occupiedBodies(true), sceneSeed);
}

/** The cached plan when it matches; otherwise a fresh one, cached. */
function ensurePlan(theme: string, sceneSeed?: string): ComposedPlan {
  const cached = useTown.getState().scenePlan;
  if (cached && cached.intent.prompt === theme.trim() && (!sceneSeed || cached.seed === normalizeSeed(sceneSeed))) return cached;
  const plan = planFor(theme, sceneSeed);
  useTown.getState().setScenePlan(plan);
  return plan;
}

/** The plan behind the current scene, if any (plan_id = its seed). */
function currentPlan(planId?: unknown): ComposedPlan | null {
  const plan = useTown.getState().scenePlan;
  if (!plan) return null;
  if (planId != null && normalizeSeed(String(planId)) !== plan.seed) return null;
  return plan;
}

/** Adopt a plan's seed as the board's scene identity. */
function rememberScene(seed: string, prompt: string, sceneType?: string) {
  useTown.getState().setSceneMeta({
    seed,
    prompt,
    sceneType: sceneType ?? seed.split("-")[0]?.toLowerCase(),
    version: GENERATOR_VERSION,
    createdAt: Date.now(),
  });
}

function sceneShareUrl(): string | undefined {
  const meta = useTown.getState().sceneMeta;
  if (!meta || typeof window === "undefined") return undefined;
  return shareUrl(window.location.origin, meta);
}

function sweepAgentPieces(): number {
  const store = useTown.getState();
  let swept = 0;
  for (const piece of Object.values(store.pieces)) {
    if (piece.owner === "agent" && !piece.locked) {
      store.deletePiece(piece.id);
      swept += 1;
    }
  }
  return swept;
}

/** A todo is realized when a piece of its catalog id stands within a cell. */
function isRealized(todo: SceneTodo): boolean {
  const at = parseLot(todo.lot);
  if (!at) return false;
  for (const piece of Object.values(useTown.getState().pieces)) {
    if (piece.catalogId !== todo.place) continue;
    const p = parseLot(piece.lot);
    if (p && Math.max(Math.abs(p.col - at.col), Math.abs(p.row - at.row)) <= 1) return true;
  }
  return false;
}

function zoneSummary(plan: ComposedPlan) {
  return plan.env.zones.map((z) => {
    const role = plan.intent.archetype?.zones.find((r) => r.role === z.id);
    const todos = plan.todos.filter((t) => t.zone === z.id && t.phase !== "environment");
    return {
      id: z.id,
      type: z.type,
      label: z.label,
      at: lotId(z.rect.c0, z.rect.r0),
      size: `${z.rect.w}x${z.rect.d}`,
      ...(z.level ? { level: z.level } : {}),
      ...(role ? { location: role.location, purpose: role.purpose } : {}),
      ...(z.focal ? { focal: lotId(z.focal.col, z.focal.row) } : {}),
      elements: [...new Set(todos.map((t) => t.role).filter(Boolean))],
      pieces: todos.length,
    };
  });
}

function zoneLine(z: { id: string; type: string; rect: { c0: number; r0: number; w: number; d: number }; level: number }) {
  return `${z.id}:${z.type}@${lotId(z.rect.c0, z.rect.r0)} ${z.rect.w}x${z.rect.d}${z.level ? ` up${z.level}` : ""}`;
}

// ---------------------------------------------------------------------------
// Choreography — bulk tools place many pieces; the page decides the tempo.
// A pacer (installed by the local Surprise Me runner) walks the agent cursor
// to every drop; without one, drops land on a quick beat while the tab is
// visible and instantly while it is hidden. WebMCP stays the interface either
// way — the pacer never places anything itself.
// ---------------------------------------------------------------------------

export type PlacementStep = { catalogId: string; lot: string; reason: string; index: number; total: number };
export type PlacementPacer = (step: PlacementStep) => Promise<void>;
/** Told what happened to each paced drop — where it landed, or why it didn't. */
export type PlacementOutcomeHook = (step: PlacementStep, outcome: { ok: true; lot: string; drift: number } | { ok: false; why: string }) => Promise<void> | void;

let pacer: PlacementPacer | null = null;
let outcomeHook: PlacementOutcomeHook | null = null;

export function setPlacementPacer(fn: PlacementPacer | null, onOutcome: PlacementOutcomeHook | null = null) {
  pacer = fn;
  outcomeHook = onOutcome;
}

type ApplyReport = {
  placed: number;
  skipped: { place: string; lot: string; why: string }[];
  placements: ReturnType<typeof describePiece>[];
};

/** Place a list of todos through the single write path, paced. */
async function applyTodos(todos: SceneTodo[], label: string): Promise<ApplyReport> {
  const report: ApplyReport = { placed: 0, skipped: [], placements: [] };
  const total = todos.length;
  const visible = typeof document !== "undefined" && !document.hidden;
  // Cells later todos still need: a nudge never lands on one of them.
  const pending = new Set(todos.map((t) => t.lot.trim().toUpperCase()));
  for (let i = 0; i < todos.length; i += 1) {
    const todo = todos[i];
    pending.delete(todo.lot.trim().toUpperCase());
    const item = catalogItem(todo.place);
    if (!item) {
      report.skipped.push({ place: todo.place, lot: todo.lot, why: "unknown catalog id" });
      continue;
    }
    const step: PlacementStep = { catalogId: todo.place, lot: todo.lot, reason: todo.reason, index: i, total };
    if (pacer) await pacer(step);
    else if (visible) useTown.getState().setAgentGhost({ lot: todo.lot, catalogId: todo.place });
    const outcome = agentPlaceOne({
      item,
      lot: todo.lot,
      flip: todo.flip,
      ...(todo.rot ? { rot: todo.rot } : {}),
      reason: todo.reason,
      avoidLots: pending,
    });
    if (outcome.ok) {
      report.placed += 1;
      const record = describePiece(outcome.piece, outcome.requested);
      if (report.placements.length < 16) report.placements.push(record);
      if (outcomeHook) await outcomeHook(step, { ok: true, lot: outcome.piece.lot, drift: record.drift ?? 0 });
    } else {
      report.skipped.push({ place: todo.place, lot: todo.lot, why: outcome.why.slice(0, 70) });
      if (outcomeHook) await outcomeHook(step, { ok: false, why: outcome.why });
    }
    if (!pacer && visible && total > 1 && total <= 48) {
      // A readable beat: the human watches the place come together.
      await afterRender();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 70));
    }
  }
  useTown.getState().setAgentGhost(null);
  if (report.placed) useTown.getState().setAgentLastMove(`${label}: placed ${report.placed}`);
  return report;
}

// ---------------------------------------------------------------------------
// Lifecycle instrumentation — every WebMCP call becomes a trace entry with
// its phase, args, timing, outcome, and parent (bulk tools nest the calls
// they dispatch). The Agent Build panel renders the trace; dev consoles get
// the same line indented by depth.
// ---------------------------------------------------------------------------

const PHASE_OF: Record<string, BuildPhase> = {
  get_scene_rules: "understand",
  list_catalog: "understand",
  plan_scene: "plan",
  generate_scene_seed: "plan",
  compose_scene: "compose",
  create_zone: "compose",
  create_path: "compose",
  apply_theme: "compose",
  create_ground_patch: "compose",
  populate_zones: "execute",
  create_environment: "execute",
  create_prop_cluster: "execute",
  create_focal_point: "execute",
  create_vegetation: "execute",
  place_piece: "execute",
  place_batch: "execute",
  build_scene: "execute",
  set_scene_seed: "execute",
  regenerate_scene: "execute",
  get_occupancy: "inspect",
  get_scene: "inspect",
  inspect_region: "inspect",
  lookup_object: "inspect",
  get_selection: "inspect",
  get_scene_seed: "inspect",
  tell_story: "inspect",
  validate_scene: "validate",
  repair_scene: "repair",
  move_piece: "repair",
  orient_piece: "repair",
  remove_piece: "repair",
  label_piece: "repair",
};

const traceStack: number[] = [];
let currentCaller: TraceCaller = "host";

function parseResult(result: ModelContextToolResult): Record<string, unknown> {
  try {
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function summarize(result: ModelContextToolResult): string {
  const body = parseResult(result);
  const line = body.noticed ?? body.error ?? body.verdict ?? body.note;
  const text = typeof line === "string" ? line : (result.content[0]?.text ?? "");
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function logToolCall(name: string, input: Record<string, unknown>, ms: number, depth: number, result?: ModelContextToolResult, err?: unknown) {
  if (process.env.NODE_ENV === "production") return;
  const pad = "  ".repeat(depth);
  const args = JSON.stringify(input ?? {});
  const argLine = args.length > 160 ? `${args.slice(0, 160)}…` : args;
  if (err) {
    console.warn(`[webmcp] ${pad}${name} ✗ ${ms.toFixed(0)}ms`, argLine, err);
    return;
  }
  console.debug(`[webmcp] ${pad}${PHASE_OF[name] ?? "?"} · ${name} ${result?.isError ? "✗" : "✓"} ${ms.toFixed(0)}ms`, argLine, summarize(result!));
}

async function runInstrumented(tool: ModelContextTool, input: Record<string, unknown>, caller?: TraceCaller): Promise<ModelContextToolResult> {
  const store = useTown.getState();
  const depth = traceStack.length;
  if (caller) currentCaller = caller;
  // Only top-level calls count toward the tally: a bulk tool that dispatches
  // twenty placements is one decision, not twenty.
  if (depth === 0) store.recordToolCall(tool.name);
  const args = JSON.stringify(input ?? {});
  const id = store.beginTrace({
    parent: traceStack[traceStack.length - 1],
    phase: PHASE_OF[tool.name] ?? "execute",
    tool: tool.name,
    caller: currentCaller,
    args: args.length > 160 ? `${args.slice(0, 160)}…` : args,
  });
  traceStack.push(id);
  const t0 = performance.now();
  try {
    const result = await tool.execute(input);
    const ms = performance.now() - t0;
    const body = parseResult(result);
    useTown.getState().endTrace(id, {
      ms,
      ok: !result.isError,
      summary: summarize(result),
      ...(typeof body.placed === "number" ? { placed: body.placed } : {}),
      ...(typeof body.skipped === "number" ? { skipped: body.skipped } : Array.isArray(body.skipped) ? { skipped: body.skipped.length } : {}),
    });
    logToolCall(tool.name, input, ms, depth, result);
    return result;
  } catch (err) {
    const ms = performance.now() - t0;
    useTown.getState().endTrace(id, { ms, ok: false, summary: err instanceof Error ? err.message : String(err) });
    logToolCall(tool.name, input, ms, depth, undefined, err);
    throw err;
  } finally {
    traceStack.pop();
    if (depth === 0) currentCaller = "host";
  }
}

/** A tool calling another tool — the orchestration path. Same executes, same
 * trace (nested), same rules. */
async function dispatch(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = TOWN_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `No tool named "${name}".` };
  const result = await runInstrumented(tool, input);
  return parseResult(result);
}

// ---------------------------------------------------------------------------
// Repair strategies — the agent says WHAT is wrong ("off the path", "away
// from the landmark", "into the plaza"); the page finds the lot.
// ---------------------------------------------------------------------------

function resolveMoveTarget(piece: Piece, item: CatalogItem, input: Record<string, unknown>): string | { error: string; empty_nearby?: string[] } {
  const store = useTown.getState();
  const occ = occupancyMap();
  const env = store.environment;
  const at = parseLot(piece.lot);
  if (!at) return { error: `${piece.id} has no lot.` };
  if (input.lot != null) {
    const parsed = parseLot(input.lot);
    if (!parsed) return { error: `"${String(input.lot)}" is off-grid.` };
    return lotId(parsed.col, parsed.row);
  }
  if (input.relative_to != null) {
    const anchor = store.pieces[String(input.relative_to).trim()];
    if (!anchor) return { error: `No piece "${String(input.relative_to)}".` };
    const side = isSide(input.side) ? input.side : "east";
    const gap = Math.min(3, Math.max(1, Math.round(Number(input.gap ?? 1)) || 1));
    const target = stepLot(anchor.lot, side, gap);
    if (!target) return { error: `${side} of ${anchor.id} is off-grid.` };
    return target;
  }
  if (input.away_from != null) {
    const other = store.pieces[String(input.away_from).trim()];
    if (!other) return { error: `No piece "${String(input.away_from)}".` };
    const otherAt = parseLot(other.lot)!;
    const otherItem = catalogItem(other.catalogId);
    const need = clearanceLots(item) + (otherItem ? clearanceLots(otherItem) : 0.6);
    const zone = zoneAt(env, at.col, at.row);
    const lot = searchClearLot(at, item, occ, piece.id, 3, (_l, c, r) => Math.hypot(c - otherAt.col, r - otherAt.row) >= need && (!zone || rectContains(zone.rect, c, r)));
    return lot ?? searchClearLot(at, item, occ, piece.id, 3, (_l, c, r) => Math.hypot(c - otherAt.col, r - otherAt.row) >= need) ?? { error: `No clear lot away from ${other.id} within 3 cells.`, empty_nearby: nearestEmpties(piece.lot, occ, 4, item) };
  }
  if (input.off === "path" || input.off === "stairs" || input.off === "walkway") {
    const walk = pathLots(env);
    const reserved = reservedLots(env);
    const zone = zoneAt(env, at.col, at.row);
    const lot = searchClearLot(at, item, occ, piece.id, 3, (l, c, r) => !walk.has(l) && !reserved.has(l) && (!zone || rectContains(zone.rect, c, r))) ?? searchClearLot(at, item, occ, piece.id, 4, (l) => !walk.has(l) && !reserved.has(l));
    return lot ?? { error: "No clear lot off the walkway nearby.", empty_nearby: nearestEmpties(piece.lot, occ, 4, item) };
  }
  if (input.into_zone != null) {
    const ref = String(input.into_zone).trim().toLowerCase();
    const zone = env?.zones.find((z) => z.id === ref) ?? env?.zones.find((z) => z.type === ref);
    if (!zone) return { error: `No zone "${ref}".` };
    const center = zone.focal ?? { col: zone.rect.c0 + Math.floor(zone.rect.w / 2), row: zone.rect.r0 + Math.floor(zone.rect.d / 2) };
    const lot = searchClearLot(center, item, occ, piece.id, Math.max(zone.rect.w, zone.rect.d), (_l, c, r) => rectContains(zone.rect, c, r) && (platformAt(env, c, r)?.level ?? 0) === zone.level);
    return lot ?? { error: `No clear lot inside ${zone.label}.` };
  }
  return { error: "Pass lot, relative_to, away_from, off:\"path\", or into_zone." };
}

// ---------------------------------------------------------------------------
// Phases as functions — the tools below and the build_scene orchestrator
// share them, so a one-call build and a staged build do exactly the same
// work through exactly the same code.
// ---------------------------------------------------------------------------

function stageArchitecture(plan: ComposedPlan, theme: string): { swept: number } {
  const swept = sweepAgentPieces();
  useTown.getState().setEnvironment(plan.env);
  useTown.getState().setScenePlan(plan);
  rememberScene(plan.seed, theme, plan.intent.sceneType);
  useTown.getState().setValidation(null);
  useTown.getState().bumpFocus();
  return { swept };
}

function planTodosFor(plan: ComposedPlan, zones: string[] | null, only: string[] | null, phases: SceneTodo["phase"][]): SceneTodo[] {
  return plan.todos.filter((t) => {
    if (!phases.includes(t.phase ?? "populate")) return false;
    if (zones && !zones.includes(t.zone ?? "")) return false;
    if (only && !only.includes(t.role ?? "")) return false;
    return !isRealized(t);
  });
}

function runValidation(theme?: string): ValidationReport {
  const state = useTown.getState();
  const prompt = (theme && theme.trim()) || state.sceneMeta?.prompt || state.nudgeGoal || undefined;
  const plan = state.scenePlan && (!prompt || state.scenePlan.intent.prompt === prompt.trim()) ? state.scenePlan : null;
  const report = validateScene(state.environment, state.pieces, prompt, plan, state.sceneMeta?.seed);
  state.setValidation(report);
  if (report.complete) state.setPhase("complete");
  return report;
}

function validationPayload(report: ValidationReport) {
  return {
    complete: report.complete,
    completion: report.completion,
    verdict: report.verdict,
    score: report.score,
    checks: report.checks.map((c) => ({
      id: c.id,
      ok: c.ok,
      score: Math.round(c.score * 100) / 100,
      ...(c.critical ? { critical: true } : {}),
      note: c.note,
      ...(c.fix ? { fix: c.fix } : {}),
      ...(c.repairs.length ? { repairs: c.repairs.slice(0, 3) } : {}),
    })),
    ...(report.repairs.length ? { repairs: report.repairs.slice(0, 8) } : {}),
    next: report.complete
      ? "Complete — small additions only (place_piece / create_*), then validate_scene again."
      : "repair_scene applies these repairs for you; or apply them yourself, then validate_scene again.",
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const WRITE_RULES =
  "Lots are A1-style ids (M13 is the home center); there are no x,y. Never target human_locks. Every write returns the placement record (lot, requested_lot, drift, zone, level, surface, facing) — read it. Pass intent (a short phrase) so the canvas can narrate.";

const LIFECYCLE =
  "THE LIFECYCLE for a scene request: plan_scene (understand + plan, no mutation) → compose_scene (architecture: footprint, zones, walls, stairs, water, paths, terrain) → populate_zones (the story objects, zone by zone) → create_environment (the framing boundary) → get_scene / inspect_region (look) → validate_scene (the completeness score) → repair_scene or targeted repairs → validate_scene again until complete. build_scene runs that whole loop in one call when you cannot steer. A SMALL request ('add a tree beside the house') is ONE targeted call (place_piece / create_vegetation / move_piece), never a rebuild.";

export const TOWN_TOOLS: ModelContextTool[] = [
  {
    name: "get_occupancy",
    description:
      `READ — call first, every session. The map of the scene: goal (the board's standing goal — build toward it when set), scene (type, story, seed, phase), zones, filled lots as lot:id:owner, empty lots you can actually stand on, human_locks (never write there), the human's selection and last actions, and next_step — what the lifecycle wants from you now. ${LIFECYCLE}`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const state = useTown.getState();
      const plan = state.scenePlan;
      const hasEnv = Boolean(state.environment?.platforms.length);
      const pieces = Object.keys(state.pieces).length;
      const v = state.validation;
      const next =
        !hasEnv
          ? "plan_scene {theme} → compose_scene {plan_id}"
          : pieces === 0
            ? "populate_zones (then create_environment)"
            : !v
              ? "validate_scene"
              : v.complete
                ? "complete — small additions only"
                : `repair_scene (${v.completion}% — ${v.repairs[0]?.why ?? v.verdict})`;
      return ok({
        ...occupancySnapshot(),
        phase: state.phase ?? "understand",
        ...(plan
          ? { scene: { type: plan.intent.sceneType, story: plan.intent.story, seed: plan.seed, focal: plan.intent.focal } }
          : state.sceneMeta
            ? { scene: { seed: state.sceneMeta.seed, prompt: state.sceneMeta.prompt } }
            : {}),
        ...(v ? { completion: v.completion, complete: v.complete } : {}),
        next_step: next,
      });
    },
  },
  {
    name: "get_scene_rules",
    description:
      "READ — the world-building LAWS this application enforces, the completeness model (six scored dimensions), the scene archetypes it knows (backyard picnic, graveyard, market, house, castle, forest camp, harbor, arcade, village, street, skate park, arena, farm, park), the theme roster, and the ground palette. validate_scene runs every applicable law; the hard ones (stairs, walkways, off-scene lots) refuse violating writes at placement time. Read once before building.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () =>
      okWide({
        rules: SCENE_RULES.map((r) => `[${r.kind}/${r.dimension}${r.critical ? "/critical" : ""}] ${r.id} — ${r.law}`),
        completeness: "overall = 0.3 intentCoverage + 0.2 composition + 0.15 spatialCoherence + 0.15 navigation + 0.1 environment + 0.1 placementValidity; complete when ≥ 0.85 and no critical rule fails",
        archetypes: ARCHETYPES.map((a) => `${a.id}: ${a.story}`),
        themes: THEMES.map((t) => `${t.id}: ${t.label}`),
        ground_materials: GROUND_MATERIALS,
        note: "AI = intent, archetypes = composition rules, rules = validity, seed = variation, WebMCP = the only interface.",
      }),
  },
  {
    name: "list_catalog",
    description:
      "READ — the Kenney catalog (1,813 pieces, 22 packs). Filter with pack (furniture, pets, food, nature, coaster, toy-car, …), kind (pet|food|furniture|building|cave|space|nature|coaster|character|car|boat|stall|machine|tree|prop|crate|dungeon|pirate|ramp), or query (substring of id/label). Use ids in place_piece / place_batch. You rarely need this — the archetype composer and populate_zones choose pieces themselves.",
    inputSchema: {
      type: "object",
      properties: {
        pack: { type: "string", description: "Pack slug, e.g. furniture, pets, mini-arcade, toy-car." },
        kind: { type: "string", description: "Catalog kind, e.g. pet, food, furniture, building, nature, coaster." },
        query: { type: "string", description: "Case-insensitive substring of id or label." },
        limit: { type: "number", description: "Max ids per pack (default 40)." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const pack = typeof input.pack === "string" ? input.pack.trim().toLowerCase() : "";
      const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const limit = Math.max(1, Math.min(200, Number(input.limit) || 40));
      const items = CATALOG.filter((item) => {
        if (pack && item.pack !== pack && !item.pack.startsWith(pack) && !item.id.startsWith(pack)) return false;
        if (kind && item.kind !== kind) return false;
        if (query && !item.id.includes(query) && !item.label.toLowerCase().includes(query)) return false;
        return true;
      });
      const groups = FEATURED.map((group) => {
        const ids = items.filter((item) => item.pack === group.pack).map((item) => item.id);
        return { pack: group.pack, title: group.title, count: ids.length, ids: ids.slice(0, limit), ...(ids.length > limit ? { truncated: ids.length - limit } : {}) };
      }).filter((group) => group.count > 0);
      return okWide({ total: items.length, catalog_total: CATALOG.length, packs: groups });
    },
  },
  {
    name: "get_scene",
    description:
      "READ — the inspect step: every placed piece as id:lot:kind:zone:facing:owner, paginated (limit 40, page 0…). Filter by zone id/type or kind. Call after every significant build phase to see what actually landed before deciding the next move; use inspect_region for one zone in depth and lookup_object for one piece.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "0-based page (default 0)." },
        limit: { type: "number", description: "Pieces per page, max 80 (default 40)." },
        zone: { type: "string", description: "Only pieces inside this zone id or type." },
        kind: { type: "string", description: "Only pieces of this catalog kind." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const env = useTown.getState().environment;
      const page = Math.max(0, Math.floor(Number(input.page) || 0));
      const limit = Math.max(1, Math.min(80, Math.floor(Number(input.limit) || 40)));
      const zoneRef = typeof input.zone === "string" ? input.zone.trim().toLowerCase() : "";
      const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
      const zone = zoneRef ? (env?.zones.find((z) => z.id === zoneRef) ?? env?.zones.find((z) => z.type === zoneRef)) : null;
      const all = piecesList().filter((p) => {
        if (kind && p.kind !== kind) return false;
        if (zone) {
          const at = parseLot(p.lot);
          return Boolean(at && rectContains(zone.rect, at.col, at.row));
        }
        return true;
      });
      const rows = all.slice(page * limit, page * limit + limit).map((p) => {
        const at = parseLot(p.lot);
        const z = at ? zoneAt(env, at.col, at.row) : null;
        const facing = { 0: "S", 90: "W", 180: "N", 270: "E" }[p.rot ?? 0] ?? "S";
        return `${p.id}:${p.lot}:${p.kind}:${z?.id ?? "open"}:${facing}:${p.owner}${p.locked ? ":L" : ""}${p.label ? `:${p.label}` : ""}`;
      });
      return okWide({
        format: "id:lot:kind:zone:facing:owner[:L][:label]",
        total: all.length,
        page,
        pages: Math.max(1, Math.ceil(all.length / limit)),
        pieces: rows,
        ...(env?.zones.length ? { zones: env.zones.map(zoneLine) } : {}),
      });
    },
  },
  {
    name: "inspect_region",
    description:
      "READ — look closely at one zone (zone id/type) or the area around a lot (lot + radius): its purpose, the pieces inside with their placement records (lot, zone, level, surface, facing, on_path), path and stair cells, and empty standable lots. The inspect step for a zone you just built or are about to repair.",
    inputSchema: {
      type: "object",
      properties: {
        zone: { type: "string", description: "Zone id or type from get_occupancy." },
        lot: { type: "string", description: "Center lot (A1-style) when not inspecting a zone." },
        radius: { type: "number", description: "Cells around lot (default 2, max 5)." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const state = useTown.getState();
      const env = state.environment;
      let rect: { c0: number; r0: number; w: number; d: number } | null = null;
      let label = "";
      let purpose: string | undefined;
      if (input.zone != null) {
        const ref = String(input.zone).trim().toLowerCase();
        const zone = env?.zones.find((z) => z.id === ref) ?? env?.zones.find((z) => z.type === ref);
        if (!zone) return fail(`No zone "${ref}".`, { zones: env?.zones.map((z) => `${z.id}:${z.type}`) ?? [] });
        rect = zone.rect;
        label = `${zone.id} (${zone.label})`;
        purpose = state.scenePlan?.intent.archetype?.zones.find((r) => r.role === zone.id)?.purpose;
      } else if (input.lot != null) {
        const at = parseLot(input.lot);
        if (!at) return fail(`"${String(input.lot)}" is not a lot.`);
        const r = Math.max(1, Math.min(5, Math.floor(Number(input.radius) || 2)));
        rect = { c0: at.col - r, r0: at.row - r, w: r * 2 + 1, d: r * 2 + 1 };
        label = `around ${lotId(at.col, at.row)}`;
      } else {
        return fail("Pass zone or lot.");
      }
      const inside = piecesList().filter((p) => {
        const at = parseLot(p.lot);
        return Boolean(at && rectContains(rect!, at.col, at.row));
      });
      const walk = pathLots(env);
      const reserved = reservedLots(env);
      const empties: string[] = [];
      const pathCells: string[] = [];
      const occ = occupancyMap();
      for (let r = rect.r0; r < rect.r0 + rect.d; r += 1) {
        for (let c = rect.c0; c < rect.c0 + rect.w; c += 1) {
          const lot = lotId(c, r);
          if (walk.has(lot)) pathCells.push(lot);
          if (!occ.has(lot) && !reserved.has(lot) && !walk.has(lot) && lotOnScene(lot) && empties.length < 16) empties.push(lot);
        }
      }
      return okWide({
        region: label,
        ...(purpose ? { purpose } : {}),
        rect: `${lotId(rect.c0, rect.r0)} ${rect.w}x${rect.d}`,
        pieces: inside.slice(0, 40).map((p) => describePiece(p)),
        ...(inside.length > 40 ? { more: inside.length - 40 } : {}),
        path_cells: pathCells.slice(0, 24),
        stairs: (env?.stairs ?? []).filter((s) => rectContains(rect!, s.at.col, s.at.row)).map((s) => lotId(s.at.col, s.at.row)),
        empty: empties,
      });
    },
  },
  {
    name: "lookup_object",
    description:
      "READ — the full placement record for one piece id: catalog id, kind, lot, zone, level, surface, facing, clearance, whether it stands on a path, owner/locked/label, plus its nearest neighbours. Use it to check a single piece before moving or removing it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Piece id, e.g. pirate-barrel-2." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const piece = useTown.getState().pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`, { known_ids: piecesList().slice(-12).map((p) => p.id) });
      const at = parseLot(piece.lot)!;
      const neighbours = piecesList()
        .filter((p) => p.id !== piece.id)
        .map((p) => ({ p, d: Math.max(Math.abs(parseLot(p.lot)!.col - at.col), Math.abs(parseLot(p.lot)!.row - at.row)) }))
        .filter((n) => n.d <= 2)
        .sort((a, b) => a.d - b.d)
        .slice(0, 6)
        .map((n) => `${n.p.id}@${n.p.lot} (${n.d})`);
      return ok({ ...describePiece(piece), src: catalogItem(piece.catalogId)?.src, neighbours });
    },
  },
  {
    name: "get_selection",
    description:
      "READ — what the human has selected right now plus their recent edits. Build around the human's focus instead of guessing.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const state = useTown.getState();
      const selected = state.selection
        .map((id) => state.pieces[id])
        .filter(Boolean)
        .map((p) => ({ id: p.id, kind: p.kind, lot: p.lot, locked: p.locked }));
      return ok({ selection: selected, last_human_actions: state.humanActions.slice(-5) });
    },
  },
  {
    name: "tell_story",
    description:
      "READ — a short narrated recap of everything built so far (a few paragraphs of prose) to relay to the human when they ask what happened or for a summary.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const state = useTown.getState();
      const story = buildStory(state.events, state.pieces);
      return ok({ title: story.title, story: story.paragraphs.join("\n\n") });
    },
  },

  // -------------------------------------------------------------------------
  // PLAN — understand the request and propose a composition. No mutation.
  // -------------------------------------------------------------------------
  {
    name: "plan_scene",
    description:
      "PLAN (read-only, no mutation) — the UNDERSTAND + PLAN step for any medium or complex request. Pass theme (free text, e.g. 'a backyard picnic with burgers and cake'), optional type (an archetype id: backyard_picnic|graveyard|market|house|castle|forest_camp|harbor|arcade|village|street|skate_park|arena|farm|park), optional seed (same theme + same seed = the same plan; omit to mint a fresh world). Returns the intent (scene type, story, focal point, required and supporting elements, complexity), the zone program (which places, where, why), the environment (theme, ground, boundary), circulation, the seeded composition summary per zone, and next — the exact call sequence to build it. Nothing is placed and nothing on the canvas changes: read the plan, adjust if you must (create_zone, apply_theme after composing), then call compose_scene with the plan_id. Do NOT call this for a small addition.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "What to build. Defaults to the board's standing goal when omitted." },
        type: { type: "string", description: "Optional archetype id to force, e.g. graveyard." },
        requirements: { type: "array", items: { type: "string" }, description: "Short phrases the scene must include; folded into the theme." },
        seed: { type: "string", description: "Scene seed like PICNIC-8F42KQ. Omit to mint a fresh one." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const parts = [
        typeof input.theme === "string" ? input.theme : "",
        Array.isArray(input.requirements) ? input.requirements.filter((r) => typeof r === "string").join(" ") : "",
      ];
      let theme = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160) || (useTown.getState().nudgeGoal ?? "");
      if (typeof input.type === "string" && input.type.trim() && !understandIntent(theme).archetype) theme = `${input.type.trim().replace(/_/g, " ")} ${theme}`.trim();
      if (!theme) return fail("Pass theme — what to build.");
      if (input.seed != null && !isValidSeed(input.seed)) return fail(`"${String(input.seed)}" is not a valid seed. Seeds look like PICNIC-8F42KQ.`);
      const plan = ensurePlan(theme, input.seed != null ? normalizeSeed(String(input.seed)) : undefined);
      const intent = plan.intent;
      useTown.getState().setPhase("plan");
      const byPhase = (phase: SceneTodo["phase"]) => plan.todos.filter((t) => t.phase === phase).length;
      return okWide({
        plan_id: plan.seed,
        seed: plan.seed,
        generator_version: GENERATOR_VERSION,
        fingerprint: fingerprint({ env: plan.env, todos: plan.todos }),
        intent: {
          prompt: intent.prompt,
          scene_type: intent.sceneType,
          story: intent.story,
          focal: intent.focal,
          complexity: intent.complexity,
          required: intent.required.map((r) => `${r.label} (${r.zone})`),
          supporting: intent.supporting.map((r) => `${r.label} (${r.zone})`),
        },
        environment: { theme: intent.environment.theme, ground: intent.environment.ground, boundary: intent.environment.boundary },
        zones: zoneSummary(plan),
        circulation: plan.env.paths.map((p) => `${p.id} (${p.cells.length} cells)`),
        composition: { focal: byPhase("focal"), populate: byPhase("populate"), people: byPhase("people"), environment: byPhase("environment"), total: plan.todos.length },
        ...(plan.missing.length ? { could_not_fit: plan.missing } : {}),
        note: "No pieces placed; the canvas is unchanged. This plan is a composition, not a list of objects.",
        next: [
          `compose_scene {plan_id: "${plan.seed}"}`,
          "populate_zones {}",
          "create_environment {}",
          "get_scene {}",
          "validate_scene {}",
          "repair_scene {} (if not complete)",
          "validate_scene {}",
        ],
      });
    },
  },

  // -------------------------------------------------------------------------
  // COMPOSE + EXECUTE — the staged lifecycle. Each stage is one WebMCP call
  // that does one kind of work through the single write path.
  // -------------------------------------------------------------------------
  {
    name: "compose_scene",
    description:
      "COMPOSE (mutation, architecture only) — stage a plan's composition onto the canvas: the footprint, themed ground, zones with their walls/stairs/water/road/rise, and the paths between them. NO props are placed. Pass plan_id from plan_scene (or theme/type/seed to plan and compose in one step). The agent's previous build is swept; human pieces are preserved. Returns the zones and circulation and what to call next: populate_zones, then create_environment, then validate_scene. For a small change to an existing scene do NOT call this (it replaces the architecture); use create_zone / create_path / place_piece instead.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "The plan_id (seed) returned by plan_scene." },
        theme: { type: "string", description: "Free text when you skipped plan_scene." },
        type: { type: "string", description: "Optional archetype id." },
        requirements: { type: "array", items: { type: "string" } },
        seed: { type: "string", description: "Scene seed to reproduce a world." },
      },
    },
    execute: async (input) => {
      let plan = input.plan_id != null ? currentPlan(input.plan_id) : null;
      if (!plan) {
        if (input.plan_id != null && !input.theme) {
          const cached = useTown.getState().scenePlan;
          return fail(`No plan "${String(input.plan_id)}" is cached.`, { hint: cached ? `The current plan is ${cached.seed}. Call plan_scene again or pass theme.` : "Call plan_scene first." });
        }
        const parts = [
          typeof input.theme === "string" ? input.theme : "",
          Array.isArray(input.requirements) ? input.requirements.filter((r) => typeof r === "string").join(" ") : "",
        ];
        let theme = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160) || (useTown.getState().nudgeGoal ?? "");
        if (typeof input.type === "string" && input.type.trim() && !understandIntent(theme).archetype) theme = `${input.type.trim().replace(/_/g, " ")} ${theme}`.trim();
        if (!theme) return fail("Pass plan_id (from plan_scene) or theme.");
        if (input.seed != null && !isValidSeed(input.seed)) return fail(`"${String(input.seed)}" is not a valid seed.`);
        plan = ensurePlan(theme, input.seed != null ? normalizeSeed(String(input.seed)) : undefined);
      }
      beginWrite(`laying out ${plan.intent.archetype?.label ?? plan.intent.prompt}`, null);
      const { swept } = stageArchitecture(plan, plan.intent.prompt);
      await afterRender();
      endWrite(`laid out ${plan.env.zones.length} zones`);
      return okWide({
        noticed: `composed ${plan.intent.sceneType}: ${plan.env.zones.length} zones, ${plan.env.paths.length} paths, ${plan.env.stairs.length} stairs on ${plan.env.platforms.length} platforms${swept ? ` (swept ${swept} old pieces)` : ""} — no props yet`,
        plan_id: plan.seed,
        seed: plan.seed,
        share_url: sceneShareUrl(),
        story: plan.intent.story,
        zones: zoneSummary(plan),
        circulation: plan.env.paths.map((p) => `${p.id} (${p.cells.length} cells)`),
        next: ["populate_zones {}", "create_environment {}", "validate_scene {}"],
      });
    },
  },
  {
    name: "populate_zones",
    description:
      "EXECUTE (bulk, semantic) — build the story objects of the composed scene: the focal anchor of every zone first, then each zone's required and supporting elements arranged by their own grammar (seats ring the table facing it, food beside it, stalls face the aisle, furniture backs the walls, graves in rows), then the people, facing the action. Pass zones (ids from compose_scene; default all) and/or only (element roles such as 'seating', 'burgers', or 'people') to fill part of a scene or repair a gap validate_scene named. Already-realized pieces are skipped, so it is safe to call again. Returns per-zone placed/skipped with reasons and the first placement records. Follow with create_environment, then validate_scene.",
    inputSchema: {
      type: "object",
      properties: {
        zones: { type: "array", items: { type: "string" }, description: "Zone ids to fill (default: every zone)." },
        only: { type: "array", items: { type: "string" }, description: "Element roles to place (default: all), e.g. ['seating', 'people']." },
        intent: { type: "string", description: "Short phrase shown live on the canvas." },
      },
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No architecture yet. plan_scene → compose_scene first.");
      const zones = Array.isArray(input.zones) ? input.zones.filter((z): z is string => typeof z === "string").map((z) => z.trim().toLowerCase()) : null;
      const only = Array.isArray(input.only) ? input.only.filter((z): z is string => typeof z === "string").map((z) => z.trim().toLowerCase()) : null;
      const plan = state.scenePlan;
      const unknown = (zones ?? []).filter((z) => !env.zones.some((zz) => zz.id === z || zz.type === z));
      if (unknown.length) return fail(`No zone ${unknown.map((z) => `"${z}"`).join(", ")}.`, { zones: env.zones.map((z) => `${z.id}:${z.type}`) });
      const zoneIds = zones?.map((z) => env.zones.find((zz) => zz.id === z)?.id ?? env.zones.find((zz) => zz.type === z)!.id) ?? null;
      beginWrite(chipText(input.intent) ?? `furnishing ${zoneIds ? zoneIds.join(", ") : "every zone"}`, null);
      const perZone: Record<string, { placed: number; skipped: number }> = {};
      let placed = 0;
      const skipped: ApplyReport["skipped"] = [];
      const placements: ApplyReport["placements"] = [];
      // 1. Planned todos that have not landed yet — the plan is the source
      //    of truth for every zone it composed, and they land FIRST so the
      //    board is current before anything is filled live.
      const planned: SceneTodo[] = plan ? planTodosFor(plan, zoneIds, only, ["focal", "populate", "people"]) : [];
      const plannedReport = planned.length ? await applyTodos(planned, "populate") : null;
      // 2. Zones the plan does not know (added with create_zone), a scene
      //    with no plan, or an explicit `only` request: run the archetype
      //    program live against the board as it now stands.
      const knownToPlan = new Set(plan?.env.zones.map((z) => z.id) ?? []);
      const targets = (zoneIds ?? env.zones.map((z) => z.id)).filter((z) => !knownToPlan.has(z) || only);
      const liveTodos: SceneTodo[] = [];
      const intent = plan?.intent ?? understandIntent(state.sceneMeta?.prompt ?? state.nudgeGoal ?? "");
      const seed = state.sceneMeta?.seed ?? plan?.seed ?? "UNSEEDED";
      for (const zoneId of targets) {
        const zone = env.zones.find((z) => z.id === zoneId)!;
        const already = piecesList().filter((p) => {
          const at = parseLot(p.lot);
          return Boolean(at && rectContains(zone.rect, at.col, at.row));
        }).length;
        if (already >= 2 && !only) continue;
        if (only && plan && knownToPlan.has(zoneId) && plannedReport && plannedReport.placed > 0) continue;
        const occupied = piecesList().flatMap((p) => {
          const at = parseLot(p.lot);
          const item = catalogItem(p.catalogId);
          return at ? [{ col: at.col, row: at.row, r: item ? clearanceLots(item) : 0.6, kind: item?.kind, catalogId: p.catalogId }] : [];
        });
        if (intent.archetype && (intent.archetype.zones.some((r) => r.role === zone.id || r.type === zone.type) || only?.includes("people"))) {
          const result = programZone(intent, intent.archetype, env, zone.id, occupied, seed, only ?? undefined);
          for (const p of result.placements) liveTodos.push({ id: `live-${liveTodos.length}`, place: p.item.id, kind: p.item.kind, lot: lotId(p.col, p.row), flip: Boolean(p.flip), ...(p.rot ? { rot: p.rot } : {}), reason: p.reason, zone: zone.id, role: p.role, phase: p.phase });
        } else if (!only) {
          for (const spec of clusterForZone(env, zone, state.sceneMeta?.prompt, seed)) {
            const item = catalogItem(spec.id);
            if (item) liveTodos.push({ id: `live-${liveTodos.length}`, place: spec.id, kind: item.kind, lot: spec.lot, flip: Boolean(spec.flip), ...(spec.rot ? { rot: spec.rot } : {}), reason: spec.reason, zone: zone.id, role: "cluster", phase: "populate" });
          }
        }
      }
      const liveReport = liveTodos.length ? await applyTodos(liveTodos, "populate") : null;
      const todos = [...planned, ...liveTodos];
      if (!todos.length) {
        endWrite("nothing left to place");
        return ok({ noticed: "every requested element already stands — nothing to place", placed: 0, skipped: [], next: ["create_environment {}", "validate_scene {}"] });
      }
      const reports = [plannedReport, liveReport].filter((r): r is ApplyReport => Boolean(r));
      const allSkipped = reports.flatMap((r) => r.skipped);
      for (const t of todos) perZone[t.zone ?? "open"] = perZone[t.zone ?? "open"] ?? { placed: 0, skipped: 0 };
      for (const t of todos) {
        const bucket = perZone[t.zone ?? "open"];
        if (allSkipped.some((s) => s.place === t.place && s.lot === t.lot)) bucket.skipped += 1;
        else bucket.placed += 1;
      }
      placed = reports.reduce((n, r) => n + r.placed, 0);
      skipped.push(...allSkipped);
      placements.push(...reports.flatMap((r) => r.placements));
      await afterRender();
      useTown.getState().setValidation(null);
      endWrite(`populated ${Object.keys(perZone).length} zone${Object.keys(perZone).length === 1 ? "" : "s"} — ${placed} pieces`);
      return okWide({
        noticed: `populated ${Object.keys(perZone).join(", ")}: ${placed}/${todos.length} pieces landed${skipped.length ? ` (${skipped.length} skipped)` : ""}`,
        placed,
        skipped: skipped.slice(0, 12),
        by_zone: perZone,
        placements: placements.slice(0, 12),
        next: ["create_environment {}", "get_scene {}", "validate_scene {}"],
      });
    },
  },
  {
    name: "create_environment",
    description:
      "EXECUTE (bulk, semantic) — the environmental framing in one call: the seeded boundary along the coast (a forest edge, standing stones — whatever the theme says), undergrowth, and a little scene texture, with deliberate gaps at the entrance, piers, roads, and functional zones. Placements go through the same collision/lock/walkway rules as everything else. Optional density (low|medium|high) and style (catalog flavor, e.g. 'dead trees'). The repair for a bare or thin boundary. Call after populate_zones; follow with validate_scene.",
    inputSchema: {
      type: "object",
      properties: {
        density: { type: "string", enum: ["low", "medium", "high"] },
        style: { type: "string", description: "Optional catalog flavor for the boundary." },
      },
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No architecture yet. plan_scene → compose_scene first.");
      const plan = state.scenePlan;
      beginWrite("raising the boundary", null);
      let todos: SceneTodo[] = plan && !input.style && !input.density ? planTodosFor(plan, null, null, ["environment"]) : [];
      if (!todos.length) {
        // No plan (or a restyle): plan the frame live from the theme.
        const themeSpec = themeById(env.themeId) ?? resolveTheme(state.sceneMeta?.prompt ?? "", "grass");
        const seed = state.sceneMeta?.seed ?? "UNSEEDED";
        const call = state.toolCalls.create_environment ?? 0;
        const densityMap = { low: 0.3, medium: 0.5, high: 0.75 } as const;
        const density = densityMap[String(input.density) as keyof typeof densityMap];
        const style = typeof input.style === "string" ? input.style.slice(0, 60) : undefined;
        const frame = planBoundary(landMaskFromEnv(env), themeSpec, `${seed}-env-${call}`, buildFrameSkip(env), { density, query: style });
        todos = frame.map((p, i) => ({ id: `env-${i}`, place: p.item.id, kind: p.item.kind, lot: lotId(p.col, p.row), flip: p.flip, ...(p.rot ? { rot: p.rot } : {}), reason: p.reason, zone: "edge", role: "boundary", phase: "environment" as const }));
      }
      // Texture: whatever the plan's frame left open gets filled live toward
      // the scene's density — the repair for bare ground.
      {
        const ctxNow = buildRuleContext(env, useTown.getState().pieces);
        if (coverageOf(env, ctxNow.located) < COVERAGE_TARGET || !todos.length) {
          const intent = plan?.intent ?? understandIntent(state.sceneMeta?.prompt ?? state.nudgeGoal ?? "");
          const occupied = piecesList().flatMap((p) => {
            const at = parseLot(p.lot);
            const item = catalogItem(p.catalogId);
            return at ? [{ col: at.col, row: at.row, r: item ? clearanceLots(item) : 0.6, kind: item?.kind }] : [];
          });
          // Planned-but-unplaced todos count as standing so texture leaves them room.
          const pendingBodies = todos.flatMap((t) => {
            const at = parseLot(t.lot);
            const item = catalogItem(t.place);
            return at && item ? [{ col: at.col, row: at.row, r: clearanceLots(item), kind: item.kind }] : [];
          });
          const seed = state.sceneMeta?.seed ?? plan?.seed ?? "UNSEEDED";
          const live = programTexture(intent, env, [...occupied, ...pendingBodies], `${seed}-${state.toolCalls.create_environment ?? 0}`);
          todos = [...todos, ...live.map((p, i) => ({ id: `tex-${i}`, place: p.item.id, kind: p.item.kind, lot: lotId(p.col, p.row), flip: false, ...(p.rot ? { rot: p.rot } : {}), reason: p.reason, zone: p.zone, role: "texture", phase: "environment" as const }))];
        }
      }
      if (!todos.length) {
        endWrite("the ground is already full");
        return ok({ noticed: "the frame stands and the ground is full — nothing to add", placed: 0, next: ["validate_scene {}"] });
      }
      const report = await applyTodos(todos, "environment");
      await afterRender();
      useTown.getState().setValidation(null);
      endWrite(`framed the scene — ${report.placed} pieces`);
      return ok({
        noticed: `environment: ${report.placed}/${todos.length} framing pieces landed${report.skipped.length ? ` (${report.skipped.length} skipped)` : ""}`,
        placed: report.placed,
        skipped: report.skipped.slice(0, 8),
        next: ["get_scene {}", "validate_scene {}"],
      });
    },
  },
  {
    name: "build_scene",
    description:
      "ORCHESTRATOR — the complete lifecycle in ONE call, for hosts that cannot steer step by step: plan_scene → compose_scene → populate_zones → create_environment → get_scene → validate_scene → repair_scene → validate_scene, all dispatched through the same WebMCP tools (they appear nested in the trace). Pass theme (and optional seed to reproduce a world). Prefer the staged calls when you want to read the plan or steer the composition; never use this for a small addition.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "What to build." },
        seed: { type: "string", description: "Scene seed to reproduce a world; omit to mint a fresh one." },
        max_repairs: { type: "number", description: "Repair budget (default 6)." },
      },
    },
    execute: async (input) => {
      const theme = (typeof input.theme === "string" && input.theme.trim().slice(0, 160)) || useTown.getState().nudgeGoal || "";
      if (!theme) return fail("Pass theme — what to build.");
      if (input.seed != null && !isValidSeed(input.seed)) return fail(`"${String(input.seed)}" is not a valid seed.`);
      const plan = await dispatch("plan_scene", { theme, ...(input.seed != null ? { seed: normalizeSeed(String(input.seed)) } : {}) });
      if (plan.error) return fail(String(plan.error));
      const composed = await dispatch("compose_scene", { plan_id: plan.plan_id });
      if (composed.error) return fail(String(composed.error));
      const populated = await dispatch("populate_zones", {});
      const framed = await dispatch("create_environment", {});
      await dispatch("get_scene", { limit: 10 });
      let report = await dispatch("validate_scene", { theme });
      let repaired: Record<string, unknown> | null = null;
      if (report.complete !== true) {
        repaired = await dispatch("repair_scene", { max: Math.max(1, Math.min(12, Number(input.max_repairs) || 6)), theme });
        report = await dispatch("validate_scene", { theme });
      }
      return okWide({
        noticed: `built ${String(plan.plan_id)}: ${String(populated.placed ?? 0)} story pieces + ${String(framed.placed ?? 0)} framing — ${String(report.completion)}% ${report.complete ? "complete" : "not yet complete"}`,
        seed: plan.seed,
        share_url: sceneShareUrl(),
        story: (plan.intent as { story?: string } | undefined)?.story,
        placed: Number(populated.placed ?? 0) + Number(framed.placed ?? 0),
        ...(repaired ? { repairs_applied: repaired.applied } : {}),
        validation: { complete: report.complete, completion: report.completion, verdict: report.verdict, score: report.score },
      });
    },
  },

  // -------------------------------------------------------------------------
  // Incremental semantic operations — grow or restyle the CURRENT scene.
  // -------------------------------------------------------------------------
  {
    name: "create_zone",
    description:
      "SEMANTIC — add ONE functional zone to the current environment (architecture only, no props). The usual repair when validate_scene says a zone is missing, or the way to grow a scene ('add a garden to the west'). Pass type (plaza|home|market|garden|harbor|street|arcade|workshop|keep|lab|camp|skyline), optional location (north|south|east|west|center), size (small|medium|large), label. Interior types raise a walled terrace with a stair; garden lays a bed; harbor digs water and builds a pier; street pours road. A walk to the plaza is threaded automatically. On an empty board this also creates the starter footprint. Fill it afterwards with populate_zones {zones: [id]}.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "plaza|home|market|garden|harbor|street|arcade|workshop|keep|lab|camp|skyline" },
        location: { type: "string", enum: ["north", "south", "east", "west", "center"] },
        size: { type: "string", enum: ["small", "medium", "large"] },
        label: { type: "string", description: "Display name, e.g. 'the fish market'. Max 40 chars." },
      },
      required: ["type"],
    },
    execute: async (input) => {
      const type = String(input.type ?? "").trim().toLowerCase() as ZoneType;
      const VALID: ZoneType[] = ["plaza", "home", "market", "garden", "harbor", "street", "arcade", "workshop", "keep", "lab", "camp", "skyline"];
      if (!VALID.includes(type)) return fail(`Unknown zone type "${type}". Use one of: ${VALID.join("|")}.`);
      const location = typeof input.location === "string" ? (input.location as ZoneLocation) : undefined;
      const size = typeof input.size === "string" ? (input.size as ZoneSize) : undefined;
      const label = typeof input.label === "string" ? input.label : undefined;
      beginWrite(`laying out ${label ?? type}`, null);
      const result = addZone(useTown.getState().environment, type, { location, size, label, sceneSeed: useTown.getState().sceneMeta?.seed });
      const seed = useTown.getState().sceneMeta?.seed ?? "UNSEEDED";
      useTown.getState().setEnvironment(withWaterPaint(result.env, seed));
      useTown.getState().setValidation(null);
      useTown.getState().bumpFocus();
      await afterRender();
      endWrite(`laid out ${result.zone.label}`);
      return ok({
        noticed: `created ${result.zone.id} (${result.zone.type}) at ${lotId(result.zone.rect.c0, result.zone.rect.r0)} ${result.zone.rect.w}x${result.zone.rect.d}${result.zone.level ? ` up${result.zone.level}` : ""} — ${result.note}`,
        zone: { id: result.zone.id, type: result.zone.type, at: lotId(result.zone.rect.c0, result.zone.rect.r0), size: `${result.zone.rect.w}x${result.zone.rect.d}`, focal: result.zone.focal ? lotId(result.zone.focal.col, result.zone.focal.row) : undefined },
        next: [`populate_zones {zones: ["${result.zone.id}"]}`, "validate_scene {}"],
      });
    },
  },
  {
    name: "create_path",
    description:
      "SEMANTIC — thread a walking path between two points; the repair for a zone validate_scene says is cut off. Pass from and to as zone ids ('market'), zone types, lot ids ('M13'), or 'entrance' (the south coast). Clipped to the decks; ends one cell short of a zone's focal so the landmark stays a pedestal.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Zone id/type, lot id, or 'entrance'." },
        to: { type: "string", description: "Zone id/type or lot id." },
      },
      required: ["from", "to"],
    },
    execute: async (input) => {
      const env = useTown.getState().environment;
      if (!env) return fail("No environment yet. plan_scene → compose_scene first.");
      const b = resolvePoint(env, String(input.to ?? ""));
      if (!b) return fail(`Could not resolve "${String(input.to)}". Use a zone id from get_occupancy or a lot id.`);
      let a = String(input.from ?? "").trim().toLowerCase() === "entrance" ? null : resolvePoint(env, String(input.from ?? ""));
      if (!a) {
        // Entrance: the southern coast below the target.
        let row = b.row;
        while (platformAt(env, b.col, row + 1)) row += 1;
        a = { col: b.col, row, label: "the entrance" };
      }
      const path = pathBetweenPoints(env, a, b, `walk-${env.paths.length + 1}`);
      // The destination focal is a pedestal, never a walk cell.
      const cells = path.cells.filter((c) => !(c.col === b.col && c.row === b.row));
      if (cells.length < 2) return fail("Those points share no walkable deck between them.");
      useTown.getState().setEnvironment({ ...env, paths: [...env.paths, { id: path.id, cells }] });
      useTown.getState().setValidation(null);
      await afterRender();
      endWrite(`connected ${a.label} to ${b.label}`);
      return ok({ noticed: `path threaded: ${a.label} → ${b.label} (${cells.length} cells)`, path: path.id, next: ["validate_scene {}"] });
    },
  },
  {
    name: "create_prop_cluster",
    description:
      "SEMANTIC (bulk) — furnish ONE zone by its own grammar in one call; the single-zone form of populate_zones (which is preferred for a composed scene). Pass zone (id or type) and optional theme to flavor the picks. Never furnish a zone piece by piece.",
    inputSchema: {
      type: "object",
      properties: {
        zone: { type: "string", description: "Zone id or type, e.g. 'market' or 'garden-2'." },
        theme: { type: "string", description: "Optional flavor, e.g. 'fresh fruit and bread'." },
      },
      required: ["zone"],
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No environment yet. plan_scene → compose_scene first.");
      const ref = String(input.zone ?? "").trim().toLowerCase();
      const zone = env.zones.find((z) => z.id === ref) ?? env.zones.find((z) => z.type === ref);
      if (!zone) return fail(`No zone "${ref}".`, { zones: env.zones.map((z) => `${z.id}:${z.type}`) });
      const theme = typeof input.theme === "string" ? input.theme.slice(0, 80) : undefined;
      const intent = state.scenePlan?.intent ?? understandIntent(state.sceneMeta?.prompt ?? state.nudgeGoal ?? "");
      if (!theme && intent.archetype && intent.archetype.zones.some((r) => r.role === zone.id || r.type === zone.type)) {
        return okWide(parseResult(await runInstrumented(TOWN_TOOLS.find((t) => t.name === "populate_zones")!, { zones: [zone.id] })));
      }
      beginWrite(`furnishing ${zone.label}`, null);
      const specs = clusterForZone(env, zone, theme, state.sceneMeta?.seed);
      const todos: SceneTodo[] = specs.flatMap((spec) => {
        const item = catalogItem(spec.id);
        return item ? [{ id: spec.id, place: spec.id, kind: item.kind, lot: spec.lot, flip: Boolean(spec.flip), ...(spec.rot ? { rot: spec.rot } : {}), reason: spec.reason, zone: zone.id, role: "cluster", phase: "populate" as const }] : [];
      });
      const report = await applyTodos(todos, `furnish ${zone.id}`);
      await afterRender();
      useTown.getState().setValidation(null);
      endWrite(`furnished ${zone.label} — ${report.placed} pieces`);
      return ok({ noticed: `${zone.label}: placed ${report.placed}/${todos.length} cluster pieces`, placed: report.placed, skipped: report.skipped.slice(0, 6), placements: report.placements.slice(0, 8), next: ["validate_scene {}"] });
    },
  },
  {
    name: "create_focal_point",
    description:
      "SEMANTIC — give a zone its visual anchor: the archetype's focal element (a picnic table, a monument, a fountain, a campfire) or, without one, the most massive themed landmark — or a specific catalog id. Stands it at the zone's focal lot, nudging at most a cell. Pass zone (id or type; default the scene's focal zone) and optional theme or id. The repair for a missing-focal-point validation failure.",
    inputSchema: {
      type: "object",
      properties: {
        zone: { type: "string", description: "Zone id or type." },
        theme: { type: "string", description: "Optional flavor for choosing the landmark, e.g. 'fountain'." },
        id: { type: "string", description: "Exact catalog id to use instead of letting the page choose." },
      },
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No environment yet. plan_scene → compose_scene first.");
      const intent = state.scenePlan?.intent ?? understandIntent(state.sceneMeta?.prompt ?? state.nudgeGoal ?? "");
      const ref = String(input.zone ?? intent.archetype?.focalZone ?? "plaza").trim().toLowerCase();
      const zone = env.zones.find((z) => z.id === ref) ?? env.zones.find((z) => z.type === ref) ?? env.zones.find((z) => z.type === "plaza") ?? env.zones[0];
      if (!zone?.focal) return fail("No zone with a focal point. create_zone first.");
      const theme = typeof input.theme === "string" ? input.theme.slice(0, 80) : undefined;
      let item: CatalogItem | null = input.id != null ? (catalogItem(String(input.id)) ?? null) : null;
      if (!item && !theme && intent.archetype) {
        const el = intent.archetype.elements.find((e) => e.arrange === "focal" && e.zone === zone.id);
        if (el) {
          const { pickItems } = await import("./composition/pick");
          item = pickItems(el.pick, deriveSeed(state.sceneMeta?.seed ?? "UNSEEDED", `pick:${el.role}`), 1)[0] ?? null;
        }
      }
      if (!item) item = focalCandidate(theme, zone, state.sceneMeta?.seed);
      if (!item) return fail(input.id != null ? `Unknown catalog id "${String(input.id)}".` : "No landmark candidate found — pass id or a richer theme.");
      const lot = searchClearLot({ col: zone.focal.col, row: zone.focal.row }, item, occupancyMap(), undefined, 1);
      if (!lot) return fail(`No clear ground at ${zone.label}'s focal point. remove_piece something first.`, { focal: lotId(zone.focal.col, zone.focal.row) });
      beginWrite(`raising a landmark in ${zone.label}`, { lot, catalogId: item.id });
      const outcome = agentPlaceOne({ item, lot, reason: "the centerpiece" });
      await afterRender();
      if (!outcome.ok) {
        endWrite("couldn't raise the landmark");
        return fail(outcome.why, { empty_nearby: outcome.empty_nearby });
      }
      useTown.getState().setValidation(null);
      endWrite(`raised ${phraseForCatalog(item.id, item.kind)} in ${zone.label}`);
      return ok({ noticed: `focal point: ${outcome.piece.id} at ${outcome.piece.lot} in ${zone.label}`, created: describePiece(outcome.piece, lotId(zone.focal.col, zone.focal.row)), next: ["validate_scene {}"] });
    },
  },
  {
    name: "create_vegetation",
    description:
      "SEMANTIC (bulk) — plant a group in one call; never place trees one at a time. area: 'edge' rings the coastline (the same framing create_environment lays, for when you want a specific style or density), or a zone id/type plants inside that zone. Optional style (e.g. 'pine trees rocks', 'dead trees') and density (low|medium|high). Placements obey collision, lock, and walkway rules.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", description: "'edge' for the coastline boundary, or a zone id/type from get_occupancy." },
        style: { type: "string", description: "Optional catalog flavor, e.g. 'dead trees', 'palm trees rocks'." },
        density: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["area"],
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No environment yet. compose_scene or create_zone first.");
      const themeSpec = themeById(env.themeId) ?? resolveTheme(state.sceneMeta?.prompt ?? "", "grass");
      const area = String(input.area ?? "").trim().toLowerCase();
      const style = typeof input.style === "string" ? input.style.slice(0, 60) : undefined;
      const densityMap = { low: 0.3, medium: 0.5, high: 0.75 } as const;
      const density = densityMap[String(input.density) as keyof typeof densityMap];
      // Seed-pure: the scene seed, the inputs, and how many times this tool
      // ran this chapter — never the board's piece count.
      const call = state.toolCalls.create_vegetation ?? 0;
      const seedBase = `${state.sceneMeta?.seed ?? "UNSEEDED"}-veg-${area}-${style ?? ""}-${input.density ?? ""}-${call}`;
      let todos: SceneTodo[] = [];
      if (area === "edge") {
        todos = planBoundary(landMaskFromEnv(env), themeSpec, seedBase, buildFrameSkip(env), { density, query: style }).map((p, i) => ({ id: `veg-${i}`, place: p.item.id, kind: p.item.kind, lot: lotId(p.col, p.row), flip: p.flip, ...(p.rot ? { rot: p.rot } : {}), reason: p.reason, zone: "edge", role: "boundary", phase: "environment" as const }));
      } else {
        const zone = env.zones.find((z) => z.id === area) ?? env.zones.find((z) => z.type === area);
        if (!zone) return fail(`No zone "${area}". Use 'edge' or a zone from get_occupancy.`, { zones: env.zones.map((z) => `${z.id}:${z.type}`) });
        const pool = boundaryPool(themeSpec, seedBase, style);
        if (!pool.length) return fail("No vegetation matched that style. Try a broader style.");
        const rng = createSeededRandom(deriveSeed(seedBase, `veg:${zone.id}`));
        const target = density ?? 0.4;
        for (let r = zone.rect.r0; r < zone.rect.r0 + zone.rect.d; r += 1) {
          for (let c = zone.rect.c0; c < zone.rect.c0 + zone.rect.w; c += 1) {
            if (rng() < target * 0.6) {
              const item = pool[Math.floor(rng() * pool.length)];
              const rot = [0, 90, 180, 270][Math.floor(rng() * 4)];
              todos.push({ id: `veg-${todos.length}`, place: item.id, kind: item.kind, lot: lotId(c, r), flip: false, ...(rot ? { rot } : {}), reason: `growing in ${zone.label}`, zone: zone.id, role: "vegetation", phase: "environment" });
            }
          }
        }
      }
      if (!todos.length) return fail("Nothing to plant there — the area may be fully framed already.");
      beginWrite(area === "edge" ? "raising the boundary" : `planting ${area}`, null);
      const report = await applyTodos(todos, "vegetation");
      await afterRender();
      useTown.getState().setValidation(null);
      endWrite(`planted ${report.placed} pieces`);
      return ok({ noticed: `${area === "edge" ? "boundary raised" : `planted ${area}`}: ${report.placed}/${todos.length} placed`, placed: report.placed, skipped: report.skipped.slice(0, 6), next: ["validate_scene {}"] });
    },
  },
  {
    name: "create_ground_patch",
    description:
      "SEMANTIC — paint one themed ground patch: an intentional region of a different material, not noise. Pass material (see get_scene_rules), optional near (zone id/type or lot id — defaults to the island center), and size (small|medium|large).",
    inputSchema: {
      type: "object",
      properties: {
        material: { type: "string", description: "A ground material, e.g. moss, dirt, cobble, snow, candy-pink." },
        near: { type: "string", description: "Zone id/type or lot id to center the patch on." },
        size: { type: "string", enum: ["small", "medium", "large"] },
      },
      required: ["material"],
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No environment yet. compose_scene or create_zone first.");
      const material = String(input.material ?? "").trim() as PlatformMaterial;
      if (!GROUND_MATERIALS.includes(material)) return fail(`Unknown material "${material}".`, { materials: GROUND_MATERIALS });
      const island = landMaskFromEnv(env);
      if (!island.cells.size) return fail("No ground to paint.");
      const center =
        (input.near != null ? resolvePoint(env, String(input.near)) : null) ?? {
          col: island.bbox.c0 + Math.floor(island.bbox.w / 2),
          row: island.bbox.r0 + Math.floor(island.bbox.d / 2),
          label: "the center",
        };
      const radius = { small: 1.6, medium: 2.6, large: 3.6 }[String(input.size) as "small" | "medium" | "large"] ?? 2.6;
      const call = state.toolCalls.create_ground_patch ?? 0;
      const rng = createSeededRandom(deriveSeed(`${state.sceneMeta?.seed ?? "UNSEEDED"}`, `patch:${material}:${center.col}:${center.row}:${call}`));
      const wobble = rng() * Math.PI * 2;
      const merged = new Map<string, GroundCell>();
      for (const g of env.ground ?? []) merged.set(cellKey(g.col, g.row), g);
      let painted = 0;
      for (let dr = -Math.ceil(radius); dr <= Math.ceil(radius); dr += 1) {
        for (let dc = -Math.ceil(radius); dc <= Math.ceil(radius); dc += 1) {
          const col = center.col + dc;
          const row = center.row + dr;
          if (!island.cells.has(cellKey(col, row))) continue;
          const edge = radius * (0.8 + 0.25 * Math.sin(Math.atan2(dr, dc) * 2 + wobble));
          if (Math.hypot(dc, dr) <= edge) {
            merged.set(cellKey(col, row), { col, row, m: material });
            painted += 1;
          }
        }
      }
      if (!painted) return fail("That patch would land entirely off the ground.");
      useTown.getState().setEnvironment({ ...env, ground: [...merged.values()] });
      await afterRender();
      endWrite(`painted ${material} near ${center.label}`);
      return ok({ noticed: `ground patch painted: ${painted} cells of ${material} near ${center.label}` });
    },
  },
  {
    name: "apply_theme",
    description:
      "SEMANTIC — restyle the whole environment with a theme's material ecosystem: repaints the ground to the theme's primary, lays fresh seeded patches, sets the walk material. Pass theme (an id from get_scene_rules or free text, e.g. 'spooky graveyard'). Pieces are untouched — follow with create_environment if the boundary should change too.",
    inputSchema: {
      type: "object",
      properties: { theme: { type: "string", description: "Theme id (e.g. spooky, candy, snow) or free text." } },
      required: ["theme"],
    },
    execute: async (input) => {
      const state = useTown.getState();
      const env = state.environment;
      if (!env) return fail("No environment yet. compose_scene or create_zone first.");
      const text = String(input.theme ?? "").trim();
      const themeSpec = themeById(text.toLowerCase()) ?? resolveTheme(text, "grass");
      const island = landMaskFromEnv(env);
      if (!island.cells.size) return fail("No ground to restyle.");
      const platforms = env.platforms.map((p) => (p.inset || p.level !== 0 || p.material === "road" || p.id === "pier" ? p : { ...p, material: themeSpec.primary }));
      useTown.getState().setEnvironment(
        withWaterPaint({ ...env, platforms, ground: paintTerrain(island, themeSpec, state.sceneMeta?.seed ?? "UNSEEDED"), themeId: themeSpec.id, pathMaterial: themeSpec.pathMaterial }, state.sceneMeta?.seed ?? "UNSEEDED"),
      );
      useTown.getState().setValidation(null);
      await afterRender();
      endWrite(`restyled as ${themeSpec.label}`);
      return ok({ noticed: `theme applied: ${themeSpec.label} (${themeSpec.primary} ground, patches of ${[...themeSpec.secondary, ...themeSpec.accent].map((l) => l.m).join(", ")})`, theme: themeSpec.id });
    },
  },

  // -------------------------------------------------------------------------
  // PRIMITIVES — one object. Targeted additions, corrections, repairs.
  // -------------------------------------------------------------------------
  {
    name: "place_piece",
    description:
      `PRIMITIVE — ONE object. Use for a single targeted addition ('a tree beside the house': relative_to the house id, side), a unique landmark, or a correction after validate_scene. NEVER build a scene or a group with repeated calls: plan_scene → compose_scene → populate_zones builds worlds; create_vegetation plants groups; place_batch places an explicit list in one call. Pass id (catalog id, preferred — e.g. ${ID_EXAMPLES}) or kind. Target lot (A1-style) OR relative_to (piece id) + side (north|south|east|west) + gap (1-4); with no target the page grows the scene. rot (0|90|180|270: 0 faces camera-south, 90 west, 180 north, 270 east) sets facing. Refuses occupied, off-scene, stair, walkway (bulky pieces), and human-locked lots; a collision nudges at most 2 cells and the record says so (requested_lot, drift). Returns the placement record and the map. ${WRITE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Any catalog id from list_catalog, e.g. pirate-ship-pirate-large or furniture-lounge-sofa." },
        kind: { type: "string", description: "Fallback when no id: stall|prop|character|tree|crate|machine|ramp|dungeon|boat|pirate|car|pet|food|furniture|building|cave|space|nature|coaster." },
        intent: { type: "string", description: "Short phrase shown live on the canvas, e.g. 'docking the pirate ship'." },
        lot: { type: "string", description: "Lot id like C4. Omit to place relative or auto." },
        relative_to: { type: "string", description: "Existing piece id, e.g. pirate-barrel-1." },
        side: { type: "string", enum: [...SIDES] },
        gap: { type: "number", description: "Cells away from relative_to, 1-4. Default 1." },
        flip: { type: "boolean", description: "Mirror horizontally." },
        rot: { type: "number", description: "Facing: 0|90|180|270." },
        reason: { type: "string", description: "Story reason ('the centerpiece', 'out over the water') for the narrator." },
      },
    },
    execute: async (input) => {
      const spec = parsePlaceSpec(input);
      if ("error" in spec) return fail(spec.error);
      const intent = chipText(input.intent);
      const hadPieces = occupancyMap().size > 0;
      const ghostLot = spec.lot && parseLot(spec.lot) ? spec.lot.trim().toUpperCase() : null;
      beginWrite(intent ?? `placing ${phraseForCatalog(spec.item.id, spec.item.kind)}`, ghostLot ? { lot: ghostLot, catalogId: spec.item.id } : null);
      const outcome = agentPlaceOne(spec);
      await afterRender();
      if (!outcome.ok) {
        endWrite("couldn't place that");
        if (outcome.why.includes("locked")) {
          useTown.getState().pushEvent({ actor: "agent", verb: "blocked", catalogId: spec.item.id, kind: spec.item.kind, lot: outcome.lot });
        }
        return fail(outcome.why, { empty_nearby: outcome.empty_nearby, occupancy: occupancySnapshot() });
      }
      focusCameraIfFirstBuild(hadPieces);
      useTown.getState().setValidation(null);
      const noticed = humanNotice([]) ?? `placed ${outcome.piece.id} on ${outcome.piece.lot}`;
      endWrite(chipPlace(outcome.piece));
      return ok({ noticed, intent: intent ?? undefined, created: describePiece(outcome.piece, outcome.requested), occupancy: occupancySnapshot() });
    },
  },
  {
    name: "place_batch",
    description:
      `PRIMITIVE (bulk) — an explicit list of placements in ONE call, for an arrangement you designed yourself (a row of lanterns, three characters around a fire). For a composed scene prefer populate_zones; for vegetation prefer create_vegetation. Pass intent (what you noticed + what you will build) and items: place_piece specs ({id|kind, lot? or relative_to+side+gap?, flip?, rot?, reason?}), max 48, applied in order. Locks and collisions are skipped, not fatal. Returns per-item records (lot, requested_lot, drift, zone) and the map. ${WRITE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "One line: what you noticed + what you will build. Shown live on the canvas." },
        items: {
          type: "array",
          maxItems: 48,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              lot: { type: "string" },
              relative_to: { type: "string" },
              side: { type: "string", enum: [...SIDES] },
              gap: { type: "number" },
              flip: { type: "boolean" },
              rot: { type: "number" },
              reason: { type: "string" },
            },
          },
        },
      },
      required: ["items"],
    },
    execute: async (input) => {
      const items = input.items;
      if (!Array.isArray(items) || !items.length) return fail("items must be a non-empty array.");
      if (items.length > 48) return fail("Max 48 items per batch — or use populate_zones for a composed scene.");
      const intent = chipText(input.intent);
      const hadPieces = occupancyMap().size > 0;
      beginWrite(intent ?? `placing ${items.length} pieces`, null);
      const report: Record<string, unknown>[] = [];
      const skippedLots: string[] = [];
      let placed = 0;
      const visible = typeof document !== "undefined" && !document.hidden;
      for (let i = 0; i < items.length; i += 1) {
        const spec = parsePlaceSpec((items[i] ?? {}) as Record<string, unknown>);
        if ("error" in spec) {
          report.push({ ok: false, skip: spec.error });
          continue;
        }
        const ghostLot = spec.lot && parseLot(spec.lot) ? spec.lot.trim().toUpperCase() : null;
        if (pacer) await pacer({ catalogId: spec.item.id, lot: ghostLot ?? "", reason: spec.reason ?? "", index: i, total: items.length });
        else if (ghostLot) useTown.getState().setAgentGhost({ lot: ghostLot, catalogId: spec.item.id });
        const outcome = agentPlaceOne(spec);
        if (outcome.ok) {
          placed += 1;
          report.push({ ok: true, ...describePiece(outcome.piece, outcome.requested) });
        } else {
          if (spec.lot) skippedLots.push(spec.lot.trim().toUpperCase());
          report.push({ ok: false, skip: outcome.why.slice(0, 80) });
        }
        if (!pacer && visible && items.length > 1) {
          await afterRender();
          await new Promise<void>((resolve) => window.setTimeout(resolve, 110));
        }
      }
      useTown.getState().setAgentGhost(null);
      useTown.getState().setAgentLastMove(`placed ${placed} piece${placed === 1 ? "" : "s"} (batch)`);
      useTown.getState().setValidation(null);
      focusCameraIfFirstBuild(hadPieces);
      const humanLine = humanNotice(skippedLots);
      if (humanLine) useTown.getState().pushEvent({ actor: "agent", verb: "blocked", detail: humanLine });
      endWrite(placed ? `placed ${placed} piece${placed === 1 ? "" : "s"}` : "nothing landed");
      return okWide({ noticed: humanLine ?? `placed ${placed}/${items.length} pieces`, intent: intent ?? undefined, placed, items: report, occupancy: occupancySnapshot() });
    },
  },
  {
    name: "move_piece",
    description:
      `REPAIR primitive — relocate one piece. Say WHAT is wrong and the page finds the lot: off:"path" (a walkway blocker), away_from:<piece id> (overlap or crowding the landmark), into_zone:<zone id> (a stray outside every zone), or give lot / relative_to + side + gap explicitly. Refuses human-locked pieces, occupied, off-scene, stair, and (for bulky pieces) walkway targets. Returns the new placement record. ${WRITE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        intent: { type: "string", description: "Short phrase shown live on the canvas." },
        lot: { type: "string" },
        relative_to: { type: "string" },
        side: { type: "string", enum: [...SIDES] },
        gap: { type: "number" },
        away_from: { type: "string", description: "Piece id to get clear of." },
        off: { type: "string", enum: ["path", "stairs"], description: "Step off a walkway or a stair approach." },
        into_zone: { type: "string", description: "Zone id/type to move into." },
      },
      required: ["id"],
    },
    execute: async (input) => {
      const store = useTown.getState();
      const piece = store.pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`);
      if (piece.locked) return fail(`${piece.id} is human-locked. Build around it instead.`, { empty_nearby: nearestEmpties(piece.lot) });
      const item = catalogItem(piece.catalogId);
      if (!item) return fail(`${piece.id} has no catalog entry.`);
      const resolved = resolveMoveTarget(piece, item, input);
      if (typeof resolved !== "string") return fail(resolved.error, resolved.empty_nearby ? { empty_nearby: resolved.empty_nearby } : {});
      const target = resolved;
      const occ = occupancyMap();
      const holder = occ.get(target);
      if (holder && holder.id !== piece.id) return fail(occupiedHint(target, occ).error, { empty_nearby: nearestEmpties(target, occ) });
      if (reservedLots(store.environment).has(target)) return fail(`Lot ${target} holds the stairs.`, { empty_nearby: nearestEmpties(target, occ) });
      if (store.environment && !lotOnScene(target)) return fail(`Lot ${target} is off the scene.`, { empty_nearby: nearestEmpties(target, occ, 4, item) });
      if (piece.kind !== "character" && piece.kind !== "pet" && piece.kind !== "food" && clearanceLots(item) >= 0.6 && pathLots(store.environment).has(target)) {
        return fail(`Lot ${target} is a walkway — paths stay walkable.`, { empty_nearby: nearestEmpties(target, occ, 4, item) });
      }
      const blocker = lotCollision(target, item, piece.id);
      if (blocker) return fail(`Too close to ${blocker.id}.`, { empty_nearby: nearestEmpties(target, occ, 4, item) });
      const intent = chipText(input.intent);
      const phrase = phraseForCatalog(piece.catalogId, piece.kind);
      beginWrite(intent ?? `moving ${phrase}`, { lot: target, catalogId: piece.catalogId });
      const from = piece.lot;
      store.patchPiece(piece.id, { lot: target });
      store.setAgentLastMove(`moved ${phrase}`);
      store.pushEvent({ actor: "agent", verb: "move", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: target });
      useTown.getState().setValidation(null);
      await afterRender();
      endWrite(`moved ${phrase}`);
      return ok({ noticed: `moved ${piece.id} ${from} → ${target}`, intent: intent ?? undefined, moved: describePiece({ ...piece, lot: target }), next: ["validate_scene {}"] });
    },
  },
  {
    name: "orient_piece",
    description:
      "REPAIR primitive — turn one piece to face something: pass face (a piece id) or face_lot (a lot) and the page picks the quarter turn, or rot (0|90|180|270) explicitly, or flip. The fix when validate_scene says a chair or character faces away from the action. Refuses human-locked pieces.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        face: { type: "string", description: "Piece id to face." },
        face_lot: { type: "string", description: "Lot to face." },
        rot: { type: "number", description: "Explicit facing 0|90|180|270." },
        flip: { type: "boolean" },
      },
      required: ["id"],
    },
    execute: async (input) => {
      const store = useTown.getState();
      const piece = store.pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`);
      if (piece.locked) return fail(`${piece.id} is human-locked.`);
      const at = parseLot(piece.lot)!;
      let rot: number | undefined;
      if (input.rot != null) rot = clampRot(input.rot);
      else {
        const target = input.face != null ? parseLot(store.pieces[String(input.face).trim()]?.lot ?? "") : input.face_lot != null ? parseLot(input.face_lot) : null;
        if (!target) return fail("Pass face (piece id), face_lot, or rot.");
        const dc = target.col - at.col;
        const dr = target.row - at.row;
        rot = Math.abs(dc) >= Math.abs(dr) ? (dc >= 0 ? 270 : 90) : dr >= 0 ? 0 : 180;
        if (rot === 0) rot = undefined;
      }
      const patch: Partial<Piece> = { rot };
      if (input.flip != null) patch.flip = Boolean(input.flip);
      store.patchPiece(piece.id, patch);
      useTown.getState().setValidation(null);
      await afterRender();
      const f = facingVector(rot);
      const word = f.dr > 0 ? "south" : f.dr < 0 ? "north" : f.dc > 0 ? "east" : "west";
      endWrite(`turned ${phraseForCatalog(piece.catalogId, piece.kind)} to face ${word}`);
      return ok({ noticed: `${piece.id} now faces ${word}`, oriented: describePiece({ ...piece, ...patch }) });
    },
  },
  {
    name: "label_piece",
    description: "PRIMITIVE — set the text label on one piece: id, text (40 chars max). Labels only. Refuses human-locked pieces.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string", description: "Max 40 chars. Empty string clears." } },
      required: ["id", "text"],
    },
    execute: async (input) => {
      const store = useTown.getState();
      const piece = store.pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`);
      if (piece.locked) return fail(`${piece.id} is human-locked. Leave its label to the human.`);
      const text = clampLabel(String(input.text ?? ""));
      store.patchPiece(piece.id, { label: text });
      const phrase = phraseForCatalog(piece.catalogId, piece.kind);
      store.setAgentLastMove(text ? `named ${phrase} ${text}` : `cleared the name on ${phrase}`);
      store.pushEvent({ actor: "agent", verb: "label", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot, label: text });
      await afterRender();
      endWrite(text ? `named ${phrase} ${text}` : `cleared a name`);
      return ok({ noticed: `labeled ${piece.id}`, labeled: { id: piece.id, label: text } });
    },
  },
  {
    name: "remove_piece",
    description:
      "REPAIR primitive — remove one agent-owned piece by id when validate_scene flags clutter, an overlap, or a piece in the wrong kind of place. Never to restart a scene (compose_scene sweeps and rebuilds). Human-owned pieces are refused unless the human has that piece selected AND force:true is passed. There is no clear-all.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, force: { type: "boolean", description: "Only for a human-owned piece the human has selected." } },
      required: ["id"],
    },
    execute: async (input) => {
      const store = useTown.getState();
      const piece = store.pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`);
      if (piece.owner === "human" && (!store.selection.includes(piece.id) || input.force !== true)) {
        return fail(`${piece.id} is human-owned. Removable only while the human has it selected and force:true is passed.`);
      }
      store.deletePiece(piece.id);
      const phrase = phraseForCatalog(piece.catalogId, piece.kind);
      store.setAgentLastMove(`removed ${phrase}`);
      store.pushEvent({ actor: "agent", verb: "remove", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot });
      useTown.getState().setValidation(null);
      await afterRender();
      endWrite(`removed ${phrase}`);
      return ok({ noticed: `removed ${piece.id} from ${piece.lot}`, removed: piece.id, occupancy: occupancySnapshot() });
    },
  },

  // -------------------------------------------------------------------------
  // VALIDATE + REPAIR — the only arbiter of done.
  // -------------------------------------------------------------------------
  {
    name: "validate_scene",
    description:
      "VALIDATE (read-only) — the scene completeness score and the ONLY arbiter of done. Tool success ≠ scene success. Scores six dimensions (intentCoverage, composition, spatialCoherence, environment, navigation, placementValidity) from the world-building laws — does the scene contain what was asked for, in the right zones; is there a landmark with room around it; do seats and people face the action; are zones furnished for their purpose; can you enter, walk, and climb; is everything grounded, un-overlapped, and where the plan put it; is the edge framed. Returns complete, completion %, verdict, per-check notes, and STRUCTURED repairs (tool + args) — apply them with repair_scene or by hand, then validate again. Never declare a scene finished without complete:true.",
    inputSchema: {
      type: "object",
      properties: { theme: { type: "string", description: "What the scene is supposed to be. Defaults to the current scene's prompt / the standing goal." } },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const report = runValidation(typeof input.theme === "string" ? input.theme : undefined);
      return okWide(validationPayload(report));
    },
  },
  {
    name: "repair_scene",
    description:
      "REPAIR (semantic) — validate, then apply the prescribed repairs THROUGH the other WebMCP tools (populate_zones for missing elements, create_path for cut-off zones, move_piece off paths / away from overlaps / into zones, orient_piece for wrong facings, create_environment for a bare edge, create_focal_point, remove_piece for misplaced kinds), most important first, up to max (default 6), then validate again. Never rebuilds the scene. Returns before/after scores, what was applied, and what remains. Loop validate_scene → repair_scene until complete.",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "number", description: "Repair budget this call (default 6, max 12)." },
        only: { type: "array", items: { type: "string" }, description: "Restrict to these rule ids, e.g. ['paths_clear', 'orientation']." },
        theme: { type: "string", description: "What the scene is supposed to be (defaults to the current prompt)." },
      },
    },
    execute: async (input) => {
      const theme = typeof input.theme === "string" ? input.theme : undefined;
      const before = runValidation(theme);
      if (before.complete) return ok({ noticed: `already complete (${before.completion}%) — nothing to repair`, before: before.completion, after: before.completion, applied: [], complete: true });
      const max = Math.max(1, Math.min(12, Number(input.max) || 6));
      const only = Array.isArray(input.only) ? new Set(input.only.filter((x): x is string => typeof x === "string")) : null;
      const queue = before.checks.filter((c) => !c.ok && (!only || only.has(c.id))).sort((a, b) => Number(b.critical) - Number(a.critical)).flatMap((c) => c.repairs.map((r) => ({ ...r, rule: c.id })));
      useTown.getState().setPhase("repair");
      beginWrite("repairing what validation found", null);
      const applied: { rule: string; tool: string; args: Record<string, unknown>; ok: boolean; result: string }[] = [];
      const seen = new Set<string>();
      for (const repair of queue) {
        if (applied.length >= max) break;
        const key = `${repair.tool}:${JSON.stringify(repair.args)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = await dispatch(repair.tool, repair.args);
        const okResult = !result.error;
        applied.push({ rule: repair.rule, tool: repair.tool, args: repair.args, ok: okResult, result: String(result.noticed ?? result.error ?? "").slice(0, 100) });
      }
      const after = runValidation(theme);
      endWrite(after.complete ? `repaired — complete (${after.completion}%)` : `repaired ${applied.filter((a) => a.ok).length} — ${after.completion}%`);
      return okWide({
        noticed: `repair: ${before.completion}% → ${after.completion}% (${applied.filter((a) => a.ok).length}/${applied.length} repairs landed)${after.complete ? " — complete" : ""}`,
        before: before.completion,
        after: after.completion,
        complete: after.complete,
        applied,
        remaining: after.repairs.slice(0, 6),
        verdict: after.verdict,
        next: after.complete ? "done" : queue.length > applied.length ? "repair_scene again" : "the remaining checks need a judgment call: inspect_region, then place_piece / move_piece / remove_piece",
      });
    },
  },

  // -------------------------------------------------------------------------
  // SEEDS — every generated scene is a seeded procedural world.
  // -------------------------------------------------------------------------
  {
    name: "get_scene_seed",
    description:
      "READ — the current scene's identity: seed, prompt, scene type, generator version, and the share_url that reproduces this world (prompt + seed, never coordinates). has_seed:false for freeform boards.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const meta = useTown.getState().sceneMeta;
      if (!meta) return ok({ has_seed: false, note: "This board is freeform — no procedural seed. compose_scene mints one." });
      return ok({ has_seed: true, seed: meta.seed, prompt: meta.prompt, scene_type: meta.sceneType, generator_version: meta.version, created_at: meta.createdAt, share_url: sceneShareUrl(), note: "Same prompt + same seed = the same base world; repairs after the build are not encoded in the link." });
    },
  },
  {
    name: "generate_scene_seed",
    description: "SEED — mint a fresh unique seed (like PICNIC-8F42KQ) WITHOUT building anything, to pass to plan_scene / build_scene or offer the human a choice of worlds.",
    inputSchema: { type: "object", properties: { concept: { type: "string", description: "Optional concept word for the prefix." } } },
    annotations: { readOnlyHint: true },
    execute: (input) => ok({ seed: generateSceneSeed(typeof input.concept === "string" ? input.concept : undefined), note: "Pass this to plan_scene or build_scene as {seed}." }),
  },
  {
    name: "set_scene_seed",
    description:
      "SEED — import a specific seed (e.g. from a shared scene) as the board's identity and, by default, REBUILD its world deterministically through build_scene (pass rebuild:false to only stamp the identity). Pass seed and optional prompt (defaults to the current prompt / standing goal).",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string" },
        prompt: { type: "string" },
        rebuild: { type: "boolean", description: "Default true." },
      },
      required: ["seed"],
    },
    execute: async (input) => {
      if (!isValidSeed(input.seed)) return fail(`"${String(input.seed)}" is not a valid seed.`);
      const seed = normalizeSeed(String(input.seed));
      const state = useTown.getState();
      const prompt = (typeof input.prompt === "string" && input.prompt.trim().slice(0, 160)) || state.sceneMeta?.prompt || state.nudgeGoal || "";
      if (!prompt) return fail("No prompt to pair with this seed. Pass prompt.");
      if (input.rebuild === false) {
        rememberScene(seed, prompt);
        return ok({ noticed: `scene identity set: ${seed} (“${prompt}”) — not rebuilt`, seed, share_url: sceneShareUrl() });
      }
      const built = await dispatch("build_scene", { theme: prompt, seed });
      if (built.error) return fail(String(built.error));
      return okWide({ noticed: `rebuilt “${prompt}” from ${seed}: ${String(built.noticed)}`, seed, share_url: sceneShareUrl(), validation: built.validation });
    },
  },
  {
    name: "regenerate_scene",
    description:
      "SEED — remix: mint a NEW seed and rebuild the same concept as a meaningfully different composition (different footprint, zone arrangement, picks) through build_scene. Human pieces are preserved. Returns the new seed and share_url.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "Optional new prompt; defaults to the current scene's." } } },
    execute: async (input) => {
      const state = useTown.getState();
      const prompt = (typeof input.prompt === "string" && input.prompt.trim().slice(0, 160)) || state.sceneMeta?.prompt || state.nudgeGoal || "";
      if (!prompt) return fail("Nothing to regenerate — no current scene prompt. build_scene first.");
      const previous = state.sceneMeta?.seed;
      const seed = generateSceneSeed(prompt);
      const built = await dispatch("build_scene", { theme: prompt, seed });
      if (built.error) return fail(String(built.error));
      return okWide({ noticed: `remixed “${prompt}”: ${previous ?? "unseeded"} → ${seed} — ${String(built.noticed)}`, seed, previous_seed: previous, share_url: sceneShareUrl(), validation: built.validation });
    },
  },
];

// ---------------------------------------------------------------------------
// Registration — top-level document only.
// ---------------------------------------------------------------------------

export type WebMcpSurface = "document.modelContext" | "navigator.modelContext" | null;

export async function registerTownTools(signal: AbortSignal): Promise<WebMcpSurface> {
  if (typeof window === "undefined") return null;
  let framed = false;
  try {
    framed = window.top !== window.self;
  } catch {
    framed = true;
  }
  if (framed) return null;

  const tools = instrumentedTools();

  if (document.modelContext?.registerTool) {
    for (const { name, description, inputSchema, execute, annotations } of tools) {
      await document.modelContext.registerTool({ name, description, inputSchema, execute, annotations }, { signal });
    }
    await document.modelContext.provideContext?.({ tools });
    signal.addEventListener("abort", () => {
      void document.modelContext?.provideContext?.({ tools: [] });
    });
    return "document.modelContext";
  }
  if (navigator.modelContext?.registerTool) {
    for (const { name, description, inputSchema, execute, annotations } of tools) {
      await navigator.modelContext.registerTool({ name, description, inputSchema, execute, annotations }, { signal });
    }
    await navigator.modelContext.provideContext?.({ tools });
    return "navigator.modelContext";
  }
  if (document.modelContext?.provideContext) {
    await document.modelContext.provideContext({ tools });
    return "document.modelContext";
  }
  return null;
}

/** Same tool list the host sees, with the lifecycle trace. */
function instrumentedTools() {
  return TOWN_TOOLS.map((tool) => ({
    ...tool,
    execute: (input: Record<string, unknown>) => runInstrumented(tool, input, "host"),
  }));
}

/** The page's own callers (the Surprise Me runner, share-URL boot, the seed
 * chip, the dev console) — same executes, same trace, tagged by caller. */
export async function callTownTool(
  name: string,
  input: Record<string, unknown> = {},
  caller: TraceCaller = "runner",
): Promise<ModelContextToolResult> {
  const tool = TOWN_TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`No tool named "${name}".`);
  return runInstrumented(tool, input, caller);
}

export { CATALOG, FEATURED };
