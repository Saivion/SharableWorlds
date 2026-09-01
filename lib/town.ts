"use client";

import { CATALOG, catalogItem, defaultForKind, FEATURED, type CatalogItem } from "./catalog";
import {
  addZone,
  clusterForZone,
  focalCandidate,
  pathBetweenPoints,
  resolvePoint,
  type ZoneLocation,
  type ZoneSize,
} from "./composition/ops";
import { clearanceLots } from "./composition/scale3d";
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
import { pathLots, platformAt, reservedLots } from "./composition/surface";
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
import { validateScene } from "./composition/validate";
import { snapLotCoord } from "./iso";
import { clampLabel, useTown } from "./store";
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
  for (let ring = 1; out.length < count && ring < 16; ring += 1) {
    for (const seed of seeds) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        for (let dr = -ring; dr <= ring; dr += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          const lot = lotId(seed.col + dc, seed.row + dr);
          if (seen.has(lot)) continue;
          seen.add(lot);
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
    if (Math.hypot(at.col - otherAt.col, at.row - otherAt.row) < r + clearanceLots(other)) {
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

function searchClearLot(
  from: { col: number; row: number },
  item: CatalogItem,
  occ: Map<string, Piece>,
  ignoreId?: string,
  ring = 8,
): string | null {
  const reserved = reservedLots(useTown.getState().environment);
  for (let r = 0; r <= ring; r += 1) {
    for (let dc = -r; dc <= r; dc += 1) {
      for (let dr = -r; dr <= r; dr += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const lot = lotId(from.col + dc, from.row + dr);
        if (occ.has(lot) && occ.get(lot)?.id !== ignoreId) continue;
        if (reserved.has(lot)) continue;
        if (!lotOnScene(lot)) continue;
        if (lotCollision(lot, item, ignoreId)) continue;
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
};

/** Valid quarter-turn rotations; anything else is normalized to the nearest. */
export function clampRot(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const snapped = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return snapped === 0 ? undefined : snapped;
}

export type PlaceOutcome =
  | { ok: true; piece: Piece }
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

  if (spec.lot != null) {
    const parsed = parseLot(spec.lot);
    if (!parsed) {
      return { ok: false, why: `"${String(spec.lot)}" is not a lot. Use A1-style ids (C4, M13).` };
    }
    lot = lotId(parsed.col, parsed.row);
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
      if (owner === "human") {
        return {
          ok: false,
          why: `Too close to ${blocker.id} — pick a clearer spot.`,
          empty_nearby: nearestEmpties(lot, occ, 4, spec.item),
          lot,
        };
      }
      const alt = searchClearLot(parsed, spec.item, occ);
      if (!alt) {
        return {
          ok: false,
          why: `Too close to ${blocker.id}.`,
          empty_nearby: nearestEmpties(lot, occ, 4, spec.item),
          lot,
        };
      }
      lot = alt;
    }
  } else if (spec.relativeTo != null) {
    const anchor = useTown.getState().pieces[String(spec.relativeTo).trim()];
    if (!anchor) {
      return { ok: false, why: `No piece "${String(spec.relativeTo)}". Use ids from get_occupancy.` };
    }
    const side = spec.side ?? "east";
    let gap = Math.min(8, Math.max(0.5, Math.round(Number(spec.gap ?? 1) * 2) / 2 || 1));
    lot = stepLot(anchor.lot, side, gap);
    while (lot && (occ.has(lot) || reserved.has(lot) || lotCollision(lot, spec.item))) {
      gap += 1;
      if (gap > 8) {
        const at = parseLot(anchor.lot);
        lot = at ? searchClearLot(at, spec.item, occ) : null;
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
  return { ok: true, piece };
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
// plan_scene — a proposal, never a mutation.
// ---------------------------------------------------------------------------

function planScene(theme: string, keepHumanLots: boolean, sceneSeed?: string) {
  const occ = occupancyMap();
  const occupied = piecesList().flatMap((piece) => {
    if (!keepHumanLots && piece.owner !== "human") return [];
    const at = parseLot(piece.lot);
    if (!at) return [];
    const item = catalogItem(piece.catalogId);
    return [{ col: at.col, row: at.row, r: item ? clearanceLots(item) : 0.7 }];
  });
  const { env, todos, seed } = planCompleteScene(theme, occupied, sceneSeed);
  const skip = keepHumanLots
    ? humanLockLots(occ).map((lot) => ({ lot, why: `human-owned ${occ.get(lot)?.id ?? ""}`.trim() }))
    : [];

  return {
    env,
    todos,
    seed,
    skip,
    note: `No pieces placed. ${todos.length} pieces planned across ${env.zones.length} zones. Place ALL todos with ONE place_batch call as {id: place, lot, flip, rot, reason} — copy reason through verbatim — then validate_scene.`,
  };
}

/** Adopt a plan's seed as the board's scene identity. */
function rememberScene(seed: string, prompt: string) {
  useTown.getState().setSceneMeta({
    seed,
    prompt,
    sceneType: seed.split("-")[0]?.toLowerCase(),
    version: GENERATOR_VERSION,
    createdAt: Date.now(),
  });
}

function sceneShareUrl(): string | undefined {
  const meta = useTown.getState().sceneMeta;
  if (!meta || typeof window === "undefined") return undefined;
  return shareUrl(window.location.origin, meta);
}

/**
 * The full deterministic build: sweep the agent's previous scene, plan
 * `theme` under `seed`, stage the architecture, place every todo, validate.
 * Shared by compose_scene, regenerate_scene, and set_scene_seed(rebuild) —
 * and by the share-URL boot path, so an imported seed reproduces its world.
 */
async function buildScene(theme: string, sceneSeed: string | undefined) {
  const store = useTown.getState();
  let swept = 0;
  for (const piece of Object.values(store.pieces)) {
    if (piece.owner === "agent" && !piece.locked) {
      store.deletePiece(piece.id);
      swept += 1;
    }
  }
  const plan = planScene(theme, true, sceneSeed);
  useTown.getState().setEnvironment(plan.env);
  rememberScene(plan.seed, theme);
  useTown.getState().bumpFocus();
  const results: Record<string, unknown>[] = [];
  let placed = 0;
  for (const todo of plan.todos) {
    const item = catalogItem(todo.place);
    if (!item) continue;
    const outcome = agentPlaceOne({
      item,
      lot: todo.lot,
      flip: todo.flip,
      ...(todo.rot ? { rot: todo.rot } : {}),
      reason: todo.reason,
    });
    if (outcome.ok) {
      placed += 1;
      results.push({ ok: true, id: outcome.piece.id, lot: outcome.piece.lot });
    } else {
      results.push({ ok: false, skip: `${todo.place}: ${outcome.why.slice(0, 60)}` });
    }
  }
  await afterRender();
  const state = useTown.getState();
  const validation = validateScene(state.environment, state.pieces, theme);
  return { plan, swept, placed, results, validation };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const AGENT_WRITE_RULES =
  "Call get_occupancy first if you have not this turn. Never target human-locked lots. Grow adjacent to existing pieces. Never restamp an occupied lot. Pass intent (short phrase) so the canvas can show what you are doing.";

export const TOWN_TOOLS: ModelContextTool[] = [
  {
    name: "get_occupancy",
    description:
      "READ — call first, every session. The map of the scene: grid size, catalog_pieces (full Kenney catalog size — every id is placeable), goal (the board's standing goal, set when the human taps Surprise Me — build toward it when set), filled lots as lot:id:owner (owner is human|agent), empty lots, human_locks (must not be written), the human's selection, and last_human_actions (what the person just did). Empty lots are the only legal targets. THE LIFECYCLE: get_occupancy → compose_scene for a full scene (or a targeted create_*/place_piece for a small addition) → validate_scene → repair failed checks → validate_scene again. Browse ids with list_catalog.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => ok(occupancySnapshot()),
  },
  {
    name: "list_catalog",
    description:
      "READ. The complete Kenney catalog — every pack, every id, not a featured subset. Filter with pack (e.g. furniture, pets, food, nature, coaster, toy-car), kind (pet|food|furniture|building|cave|space|nature|coaster|character|car|boat|...), or query (substring of id/label). Omit filters to list every pack with all ids. Use these ids in place_piece / place_batch / plan_scene. You rarely need this before compose_scene — the composer selects items itself.",
    inputSchema: {
      type: "object",
      properties: {
        pack: { type: "string", description: "Pack slug, e.g. furniture, pets, mini-arcade, toy-car." },
        kind: { type: "string", description: "Catalog kind, e.g. pet, food, furniture, building, nature, coaster." },
        query: { type: "string", description: "Case-insensitive substring of id or label." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const pack = typeof input.pack === "string" ? input.pack.trim().toLowerCase() : "";
      const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const items = CATALOG.filter((item) => {
        if (pack && item.pack !== pack && !item.pack.startsWith(pack) && !item.id.startsWith(pack)) return false;
        if (kind && item.kind !== kind) return false;
        if (query && !item.id.includes(query) && !item.label.toLowerCase().includes(query)) return false;
        return true;
      });
      const groups = FEATURED.map((group) => {
        const ids = items.filter((item) => item.pack === group.pack).map((item) => item.id);
        return { pack: group.pack, title: group.title, count: ids.length, ids };
      }).filter((group) => group.count > 0);
      return okWide({
        total: items.length,
        catalog_total: CATALOG.length,
        packs: groups,
      });
    },
  },
  {
    name: "get_scene",
    description:
      "READ — the inspect step. Compact list of every placed piece: id:lot:kind:owner:locked-flag:label. Ids embed their catalog id (e.g. pirate-barrel-2). Call after a significant build phase to see what actually landed before deciding the next move. If the list is long you get a count instead — then use get_occupancy plus lookup_object.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const pieces = piecesList();
      const rows = pieces.map(
        (p) => `${p.id}:${p.lot}:${p.kind}:${p.owner}:${p.locked ? "L" : "-"}:${p.label}`,
      );
      const full = { format: "id:lot:kind:owner:locked:label", pieces: rows };
      if (JSON.stringify(full).length <= RESULT_BUDGET) return ok(full);
      return ok({
        count: pieces.length,
        note: "Too many to list. Use get_occupancy for lots and lookup_object(id) for detail.",
        ids: pieces.slice(-20).map((p) => p.id),
      });
    },
  },
  {
    name: "lookup_object",
    description:
      "READ. Full record for one piece id (from get_occupancy or get_scene): catalog id, kind, lot, sprite src, owner, locked, label.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Piece id, e.g. pirate-barrel-2." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const piece = useTown.getState().pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`, { known_ids: piecesList().slice(-12).map((p) => p.id) });
      const item = catalogItem(piece.catalogId);
      return ok({
        id: piece.id,
        catalog_id: piece.catalogId,
        kind: piece.kind,
        lot: piece.lot,
        src: item?.src,
        owner: piece.owner,
        locked: piece.locked,
        label: piece.label,
      });
    },
  },
  {
    name: "get_selection",
    description:
      "READ. What the human has selected right now plus their recent edits. Check this to build around the human's current focus instead of guessing.",
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
      "READ. Turns everything placed so far into a short narrated recap — a few paragraphs of actual prose, not a log — that you can relay to the human in your own words or verbatim. Covers what got built, roughly in what order, and moments where the agent worked around the human's locked pieces. Call this when the human asks what happened, what you built, or for a summary/recap/story of the session.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const state = useTown.getState();
      const story = buildStory(state.events, state.pieces);
      return ok({ title: story.title, story: story.paragraphs.join("\n\n") });
    },
  },
  {
    name: "plan_scene",
    description:
      "ADVANCED planner — most requests do NOT need this: compose_scene plans, builds, AND validates in one call, so start there. Use plan_scene only when you want to see or customize the plan before building (pass stage_environment:false for a pure dry run). Pass theme (e.g. 'pirate dock with boats and cars'), optional seed (same theme + same seed = the same plan; omit to mint a fresh world), optional keep_human_lots (default true). Plans architecture first — platforms, elevation, walls, stairs, zones — then todos [{id, place: catalog-id, lot, flip, rot, reason}] clustered by zone. By default the architecture is STAGED onto the canvas and the seed becomes the board's scene identity; pieces are NOT placed. If you build from the plan, place ALL its todos with ONE place_batch call (copy reason and rot through verbatim) — never a loop of place_piece — then validate_scene.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "What to build, e.g. 'pirate dock', 'market street', 'skate park'. Defaults to the board's standing goal (the human's Surprise Me pick) when omitted." },
        seed: { type: "string", description: "Scene seed like MARKET-8F42KQ. Omit to mint a fresh one." },
        keep_human_lots: { type: "boolean", description: "Default true. Never plan over human lots." },
        stage_environment: { type: "boolean", description: "Default true: adopt the planned platforms/walls/stairs as the canvas architecture so placed pieces stand on it." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const theme = String(input.theme ?? "").slice(0, 120) || (useTown.getState().nudgeGoal ?? "");
      if (input.seed != null && !isValidSeed(input.seed)) {
        return fail(`"${String(input.seed)}" is not a valid seed. Seeds look like MARKET-8F42KQ.`);
      }
      const keep = input.keep_human_lots !== false;
      const plan = planScene(theme, keep, input.seed != null ? normalizeSeed(String(input.seed)) : undefined);
      if (input.stage_environment !== false) {
        useTown.getState().setEnvironment(plan.env);
        rememberScene(plan.seed, theme);
        useTown.getState().bumpFocus();
      }
      // The env spec itself stays out of the payload — the zones summary is
      // what an agent needs, and hosts cap tool output sizes.
      const { env, ...rest } = plan;
      return okWide({
        ...rest,
        generator_version: GENERATOR_VERSION,
        fingerprint: fingerprint({ env, todos: plan.todos }),
        zones: env.zones.map((z) => `${z.id}:${z.type}@${lotId(z.rect.c0, z.rect.r0)} ${z.rect.w}x${z.rect.d}${z.level ? ` up${z.level}` : ""}`),
        environment_staged: input.stage_environment !== false,
      });
    },
  },
  {
    name: "place_piece",
    description:
      `PRIMITIVE — one object. Use for a single targeted addition ('a tree beside the house'), a correction, or a repair after validate_scene. NEVER build a scene or a group with repeated calls: compose_scene builds whole worlds, create_vegetation plants groups, create_prop_cluster furnishes zones, place_batch places an explicit list in one call. Pass id (catalog id, preferred — e.g. ${ID_EXAMPLES}) or kind (stall|prop|character|tree|crate|machine|ramp|dungeon|boat|pirate|car|pet|food|furniture|building|cave|space|nature|coaster). Target a lot (A1-style) OR relative_to (piece id) + side (north|south|east|west) + optional gap. No x,y — the page picks the cell; with no target it grows the scene. Refuses occupied lots, overlapping footprints, and human-locked lots; returns the new id plus empty lots. ${AGENT_WRITE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Any catalog id from list_catalog, e.g. pirate-ship-pirate-large or furniture-lounge-sofa." },
        kind: { type: "string", description: "Fallback when no id: stall|prop|character|tree|crate|machine|ramp|dungeon|boat|pirate|car|pet|food|furniture|building|cave|space|nature|coaster." },
        intent: { type: "string", description: "Short phrase shown live on the canvas, e.g. 'docking the pirate ship'." },
        lot: { type: "string", description: "Lot id like C4. Omit to place relative or auto." },
        relative_to: { type: "string", description: "Existing piece id, e.g. pirate-barrel-1." },
        side: { type: "string", enum: [...SIDES] },
        gap: { type: "number", description: "Cells away from relative_to, 1-3. Default 1." },
        flip: { type: "boolean", description: "Mirror horizontally so the piece faces the opposite isometric direction." },
        rot: { type: "number", description: "Optional facing: 0|90|180|270 degrees of yaw. 0 faces the camera-south; 90 faces west; 180 north; 270 east." },
        reason: { type: "string", description: "Copy this todo's reason from plan_scene verbatim (e.g. 'the centerpiece', 'out over the water') so the story can narrate the scene by zone." },
      },
    },
    execute: async (input) => {
      const spec = parsePlaceSpec(input);
      if ("error" in spec) return fail(spec.error);
      const intent = chipText(input.intent);
      const hadPieces = occupancyMap().size > 0;
      const ghostLot = spec.lot && parseLot(spec.lot) ? spec.lot.trim().toUpperCase() : null;
      beginWrite(
        intent ?? `placing ${phraseForCatalog(spec.item.id, spec.item.kind)}`,
        ghostLot ? { lot: ghostLot, catalogId: spec.item.id } : null,
      );
      const outcome = agentPlaceOne(spec);
      await afterRender();
      if (!outcome.ok) {
        endWrite("couldn't place that");
        if (outcome.why.includes("locked")) {
          // `lot` is the exact target the agent was refused — structured, so
          // the narrator resolves the blocker from its own chapter registry
          // rather than parsing a raw system error string out of `detail`.
          useTown.getState().pushEvent({ actor: "agent", verb: "blocked", catalogId: spec.item.id, kind: spec.item.kind, lot: outcome.lot });
        }
        return fail(outcome.why, { empty_nearby: outcome.empty_nearby, occupancy: occupancySnapshot() });
      }
      focusCameraIfFirstBuild(hadPieces);
      const noticed = humanNotice([]) ?? `placed ${outcome.piece.id} on ${outcome.piece.lot}`;
      endWrite(chipPlace(outcome.piece));
      return ok({
        noticed,
        intent: intent ?? undefined,
        created: { id: outcome.piece.id, lot: outcome.piece.lot },
        occupancy: occupancySnapshot(),
      });
    },
  },
  {
    name: "place_batch",
    description:
      `PRIMITIVE (bulk) — an explicit list of placements in ONE call. Right for plan_scene todos (place EVERY todo, copy reason and rot through verbatim) or an arrangement you designed yourself. For whole scenes prefer compose_scene; for vegetation and zone furnishing prefer create_vegetation / create_prop_cluster — they do the arranging for you. Before placing, say what you noticed and what you will build — pass it as intent. items: array of place_piece specs ({id or kind, lot? or relative_to+side+gap?, flip?, rot?, reason?}), applied in order. Human locks and collisions are skipped, not fatal. Returns per-item ok/skip, occupancy, and a one-line noticed: string. ${AGENT_WRITE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "One line: what you noticed + what you will build. Shown live on the canvas." },
        items: {
          type: "array",
          maxItems: 96,
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
      if (items.length > 96) return fail("Max 96 items per batch. Send another batch after reading the result.");
      const intent = chipText(input.intent);
      const hadPieces = occupancyMap().size > 0;
      beginWrite(intent ?? `placing ${items.length} pieces`, null);
      const report: Record<string, unknown>[] = [];
      const skippedLots: string[] = [];
      let placed = 0;
      for (const raw of items) {
        const spec = parsePlaceSpec((raw ?? {}) as Record<string, unknown>);
        if ("error" in spec) {
          report.push({ ok: false, skip: spec.error });
          continue;
        }
        // Ghost each drop so the canvas tracks the piece about to land —
        // never flash the whole batch as one sudden dump.
        const ghostLot = spec.lot && parseLot(spec.lot) ? spec.lot.trim().toUpperCase() : null;
        if (ghostLot) useTown.getState().setAgentGhost({ lot: ghostLot, catalogId: spec.item.id });
        const outcome = agentPlaceOne(spec);
        if (outcome.ok) {
          placed += 1;
          report.push({ ok: true, id: outcome.piece.id, lot: outcome.piece.lot });
        } else {
          if (spec.lot) skippedLots.push(spec.lot.trim().toUpperCase());
          report.push({ ok: false, skip: outcome.why });
        }
        await afterRender();
        // Beat between drops so PieceArrive can play before the next lands.
        if (items.length > 1 && typeof window !== "undefined" && !document.hidden) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
        }
      }
      useTown.getState().setAgentLastMove(`placed ${placed} piece${placed === 1 ? "" : "s"} (batch)`);
      focusCameraIfFirstBuild(hadPieces);
      const humanLine = humanNotice(skippedLots);
      const noticed = humanLine ?? `placed ${placed} pieces`;
      // humanNotice only speaks up when there were human locks to route around
      // or lots skipped outright — both are real story material.
      if (humanLine) {
        useTown.getState().pushEvent({ actor: "agent", verb: "blocked", detail: humanLine });
      }
      endWrite(placed ? `placed ${placed} piece${placed === 1 ? "" : "s"}` : "nothing landed");
      return ok({ noticed, intent: intent ?? undefined, items: report, occupancy: occupancySnapshot() });
    },
  },
  {
    name: "move_piece",
    description:
      `PRIMITIVE — the repair verb for misplacements. The fix when validate_scene flags a blocked walkway, a stray character, or a piece in the wrong zone: move it, don't rebuild the scene. Pass id plus lot OR relative_to + side + gap. Refuses human-locked pieces, occupied targets, and off-grid lots. ${AGENT_WRITE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        intent: { type: "string", description: "Short phrase shown live on the canvas." },
        lot: { type: "string" },
        relative_to: { type: "string" },
        side: { type: "string", enum: [...SIDES] },
        gap: { type: "number" },
      },
      required: ["id"],
    },
    execute: async (input) => {
      const store = useTown.getState();
      const piece = store.pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`);
      if (piece.locked) {
        return fail(`${piece.id} is human-locked. Build around it instead.`, {
          empty_nearby: nearestEmpties(piece.lot),
        });
      }
      const occ = occupancyMap();
      let target: string | null = null;
      if (input.lot != null) {
        const parsed = parseLot(input.lot);
        if (!parsed) return fail(`"${String(input.lot)}" is off-grid.`);
        target = lotId(parsed.col, parsed.row);
      } else if (input.relative_to != null) {
        const anchor = store.pieces[String(input.relative_to).trim()];
        if (!anchor) return fail(`No piece "${String(input.relative_to)}".`);
        const side = isSide(input.side) ? input.side : "east";
        const gap = Math.min(3, Math.max(1, Math.round(Number(input.gap ?? 1)) || 1));
        target = stepLot(anchor.lot, side, gap);
        if (!target) return fail(`${side} of ${anchor.id} is off-grid.`);
      } else {
        return fail("Pass lot or relative_to.");
      }
      const holder = occ.get(target);
      if (holder && holder.id !== piece.id) {
        return fail(occupiedHint(target, occ).error, { empty_nearby: nearestEmpties(target, occ) });
      }
      if (reservedLots(store.environment).has(target)) {
        return fail(`Lot ${target} holds the stairs.`, { empty_nearby: nearestEmpties(target, occ) });
      }
      const item = catalogItem(piece.catalogId);
      if (item) {
        const blocker = lotCollision(target, item, piece.id);
        if (blocker) {
          return fail(`Too close to ${blocker.id}.`, { empty_nearby: nearestEmpties(target, occ, 4, item) });
        }
      }
      const intent = chipText(input.intent);
      const phrase = phraseForCatalog(piece.catalogId, piece.kind);
      beginWrite(intent ?? `moving ${phrase}`, { lot: target, catalogId: piece.catalogId });
      store.patchPiece(piece.id, { lot: target });
      store.setAgentLastMove(`moved ${phrase}`);
      store.pushEvent({ actor: "agent", verb: "move", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: target });
      await afterRender();
      endWrite(`moved ${phrase}`);
      return ok({ noticed: `moved ${piece.id} to ${target}`, intent: intent ?? undefined, moved: { id: piece.id, lot: target }, occupancy: occupancySnapshot() });
    },
  },
  {
    name: "label_piece",
    description:
      "PRIMITIVE. Set the text label on one piece: id, text (40 chars max). Labels only. Refuses human-locked pieces.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string", description: "Max 40 chars. Empty string clears." },
      },
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
      "PRIMITIVE — the repair verb for excess. Remove one agent-owned piece by id when validate_scene flags clutter or a blocker; never to restart a scene (compose_scene sweeps and rebuilds in one call). Human-owned pieces are refused unless the human currently has that piece selected AND force:true is passed. There is no clear-all.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        force: { type: "boolean", description: "Only for a human-owned piece the human has selected." },
      },
      required: ["id"],
    },
    execute: async (input) => {
      const store = useTown.getState();
      const piece = store.pieces[String(input.id ?? "").trim()];
      if (!piece) return fail(`No piece "${String(input.id)}".`);
      if (piece.owner === "human") {
        const selected = store.selection.includes(piece.id);
        if (!selected || input.force !== true) {
          return fail(
            `${piece.id} is human-owned. Removable only while the human has it selected and force:true is passed.`,
          );
        }
      }
      store.deletePiece(piece.id);
      const phrase = phraseForCatalog(piece.catalogId, piece.kind);
      store.setAgentLastMove(`removed ${phrase}`);
      store.pushEvent({ actor: "agent", verb: "remove", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot });
      await afterRender();
      endWrite(`removed ${phrase}`);
      return ok({ noticed: `removed ${piece.id} from ${piece.lot}`, removed: piece.id, occupancy: occupancySnapshot() });
    },
  },

  // -------------------------------------------------------------------------
  // Semantic composition tools — the agent describes ENVIRONMENT INTENT and
  // the page owns the geometry. These are the preferred surface for building
  // places; raw place_piece is the low-level escape hatch.
  // -------------------------------------------------------------------------
  {
    name: "compose_scene",
    description:
      "SEMANTIC — START HERE for any full scene request ('backyard picnic with burgers and cake', 'spooky graveyard', 'medieval market'). One call: the PAGE composes and constructs the whole environment — architecture first (platforms, elevation, walls, stairs, zones, paths), then clustered props, characters, and a focal point — then validates its own work. Input: theme (free text) and/or type ('market'|'village'|'forest'|'harbor'|...) plus requirements (short phrases like 'central plaza', 'food vendors', 'fountain'), and optional seed (same theme + same seed = the same world; omit to mint a fresh unique one). The agent's previous build is swept first; human pieces are preserved and built around. Returns the seed, fingerprint, share_url, zones, per-piece results, and the validation checklist with completion %. Read the validation: if complete:false, repair the named checks with create_zone / create_prop_cluster / create_focal_point / create_path / create_vegetation / move_piece, then validate_scene again — the scene is done when validation passes, not when this call returns. For a SMALL addition to an existing scene, do NOT call this (it rebuilds the world) — use place_piece or a create_* tool.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "Free-text description, e.g. 'small shopping market with a fountain'." },
        type: { type: "string", description: "Environment type keyword, e.g. market, village, forest, harbor, dungeon, arcade." },
        requirements: {
          type: "array",
          items: { type: "string" },
          description: "Short phrases the scene must include, e.g. ['central plaza', 'food vendors', 'storage'].",
        },
        seed: { type: "string", description: "Scene seed like MARKET-8F42KQ. Omit to mint a fresh one (a new unique world); pass one to reproduce that exact world." },
      },
    },
    execute: async (input) => {
      const parts = [
        typeof input.theme === "string" ? input.theme : "",
        typeof input.type === "string" ? input.type : "",
        Array.isArray(input.requirements) ? input.requirements.filter((r) => typeof r === "string").join(" ") : "",
      ];
      const theme = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!theme) return fail("Pass theme, type, or requirements — something to compose.");
      if (input.seed != null && !isValidSeed(input.seed)) {
        return fail(`"${String(input.seed)}" is not a valid seed. Seeds look like MARKET-8F42KQ.`);
      }
      beginWrite(`composing ${theme}`, null);
      const { plan, swept, placed, results, validation } = await buildScene(
        theme,
        input.seed != null ? normalizeSeed(String(input.seed)) : undefined,
      );
      endWrite(`composed ${theme} — ${placed} pieces, ${validation.completion}% complete`);
      return okWide({
        noticed: `composed ${theme}: ${placed}/${plan.todos.length} pieces across ${plan.env.zones.length} zones${swept ? ` (swept ${swept} old pieces)` : ""} — ${validation.completion}% complete`,
        seed: plan.seed,
        generator_version: GENERATOR_VERSION,
        fingerprint: fingerprint({ env: plan.env, todos: plan.todos }),
        share_url: sceneShareUrl(),
        zones: plan.env.zones.map(
          (z) => `${z.id}:${z.type}@${lotId(z.rect.c0, z.rect.r0)} ${z.rect.w}x${z.rect.d}${z.level ? ` up${z.level}` : ""}`,
        ),
        placed,
        skipped: results.filter((r) => !r.ok).length,
        validation,
      });
    },
  },
  {
    name: "create_zone",
    description:
      "SEMANTIC — add ONE functional zone to the current environment; architecture only, no props. The usual repair when validate_scene says a themed zone is missing. Pass type (plaza|home|market|garden|harbor|street|arcade|workshop|keep|lab|camp|skyline), optional location (north|south|east|west|center), size (small|medium|large), label. Interior types (home/arcade/keep/lab) raise a walled terrace with a stair; garden lays a grass bed; harbor digs water and builds a pier; street pours a road. If nothing fits inside the main platform, a new deck is annexed on that side. A walking path to the plaza is threaded automatically. On an empty board this also creates the starter footprint. Fill the zone afterwards with create_prop_cluster.",
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
      const result = addZone(useTown.getState().environment, type, {
        location,
        size,
        label,
        sceneSeed: useTown.getState().sceneMeta?.seed,
      });
      const seed = useTown.getState().sceneMeta?.seed ?? "UNSEEDED";
      useTown.getState().setEnvironment(withWaterPaint(result.env, seed));
      useTown.getState().bumpFocus();
      await afterRender();
      endWrite(`laid out ${result.zone.label}`);
      return ok({
        noticed: `created ${result.zone.id} (${result.zone.type}) at ${lotId(result.zone.rect.c0, result.zone.rect.r0)} ${result.zone.rect.w}x${result.zone.rect.d}${result.zone.level ? ` up${result.zone.level}` : ""} — ${result.note}`,
        zone: {
          id: result.zone.id,
          type: result.zone.type,
          at: lotId(result.zone.rect.c0, result.zone.rect.r0),
          size: `${result.zone.rect.w}x${result.zone.rect.d}`,
          focal: result.zone.focal ? lotId(result.zone.focal.col, result.zone.focal.row) : undefined,
        },
        note: "Architecture only — fill it with create_prop_cluster, then add people.",
      });
    },
  },
  {
    name: "create_path",
    description:
      "SEMANTIC — thread a walking path between two points; the repair for a disconnected-zones validation failure. Pass from and to as zone ids ('market'), zone types, or lot ids ('M13'). The path is clipped to the decks — it never crosses the void.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Zone id/type or lot id." },
        to: { type: "string", description: "Zone id/type or lot id." },
      },
      required: ["from", "to"],
    },
    execute: async (input) => {
      const env = useTown.getState().environment;
      if (!env) return fail("No environment yet. plan_scene or create_zone first.");
      const a = resolvePoint(env, String(input.from ?? ""));
      const b = resolvePoint(env, String(input.to ?? ""));
      if (!a || !b) return fail(`Could not resolve ${!a ? `"${String(input.from)}"` : `"${String(input.to)}"`}. Use a zone id from get_occupancy or a lot id.`);
      const path = pathBetweenPoints(env, a, b, `walk-${env.paths.length + 1}`);
      if (path.cells.length < 2) return fail("Those points share no walkable deck between them.");
      useTown.getState().setEnvironment({ ...env, paths: [...env.paths, path] });
      await afterRender();
      endWrite(`connected ${a.label} to ${b.label}`);
      return ok({ noticed: `path threaded: ${a.label} → ${b.label} (${path.cells.length} cells)`, path: path.id });
    },
  },
  {
    name: "create_prop_cluster",
    description:
      "SEMANTIC (bulk) — furnish one zone with a purpose-grouped cluster in one call; never furnish a zone piece-by-piece. The page arranges it by the zone's own grammar (stalls face the aisle, furniture backs the walls, trees keep canopy spacing, vehicles queue in lanes) and adds a couple of characters facing the action. Pass zone (id or type from get_occupancy) and optional theme to steer which catalog items are chosen. Collisions and human locks are skipped, not fatal. The repair for an empty or sparse zone.",
    inputSchema: {
      type: "object",
      properties: {
        zone: { type: "string", description: "Zone id or type, e.g. 'market' or 'garden-2'." },
        theme: { type: "string", description: "Optional flavor, e.g. 'fresh fruit and bread'." },
      },
      required: ["zone"],
    },
    execute: async (input) => {
      const env = useTown.getState().environment;
      if (!env) return fail("No environment yet. plan_scene or create_zone first.");
      const ref = String(input.zone ?? "").trim().toLowerCase();
      const zone = env.zones.find((z) => z.id === ref) ?? env.zones.find((z) => z.type === ref);
      if (!zone) {
        return fail(`No zone "${ref}".`, { zones: env.zones.map((z) => `${z.id}:${z.type}`) });
      }
      const theme = typeof input.theme === "string" ? input.theme.slice(0, 80) : undefined;
      beginWrite(`furnishing ${zone.label}`, null);
      const specs = clusterForZone(env, zone, theme, useTown.getState().sceneMeta?.seed);
      const results: Record<string, unknown>[] = [];
      let placed = 0;
      for (const spec of specs) {
        const item = catalogItem(spec.id);
        if (!item) continue;
        const outcome = agentPlaceOne({
          item,
          lot: spec.lot,
          flip: spec.flip,
          ...(spec.rot ? { rot: spec.rot } : {}),
          reason: spec.reason,
        });
        if (outcome.ok) {
          placed += 1;
          results.push({ ok: true, id: outcome.piece.id, lot: outcome.piece.lot });
        } else {
          results.push({ ok: false, skip: outcome.why.slice(0, 50) });
        }
      }
      await afterRender();
      endWrite(`furnished ${zone.label} — ${placed} pieces`);
      return ok({
        noticed: `${zone.label}: placed ${placed}/${specs.length} cluster pieces`,
        items: results.slice(0, 24),
        occupancy: occupancySnapshot(),
      });
    },
  },
  {
    name: "create_focal_point",
    description:
      "SEMANTIC — give a zone its visual anchor: the page picks the most massive themed landmark (or use id for a specific catalog piece) and stands it at the zone's focal lot, nudging to clear ground nearby if needed. Pass zone (id or type, default plaza) and optional theme or id. The repair for a missing-focal-point validation failure.",
    inputSchema: {
      type: "object",
      properties: {
        zone: { type: "string", description: "Zone id or type. Defaults to the plaza." },
        theme: { type: "string", description: "Optional flavor for choosing the landmark, e.g. 'fountain'." },
        id: { type: "string", description: "Exact catalog id to use instead of letting the page choose." },
      },
    },
    execute: async (input) => {
      const env = useTown.getState().environment;
      if (!env) return fail("No environment yet. plan_scene or create_zone first.");
      const ref = String(input.zone ?? "plaza").trim().toLowerCase();
      const zone = env.zones.find((z) => z.id === ref) ?? env.zones.find((z) => z.type === ref) ?? env.zones[env.zones.length - 1];
      if (!zone?.focal) return fail("No zone with a focal point. create_zone first.");
      const theme = typeof input.theme === "string" ? input.theme.slice(0, 80) : undefined;
      const item = input.id != null ? catalogItem(String(input.id)) : focalCandidate(theme, zone, useTown.getState().sceneMeta?.seed);
      if (!item) return fail(input.id != null ? `Unknown catalog id "${String(input.id)}".` : "No landmark candidate found — pass id or a richer theme.");
      const lot = searchClearLot({ col: zone.focal.col, row: zone.focal.row }, item, occupancyMap(), undefined, 3);
      if (!lot) return fail(`No clear ground near ${zone.label}'s focal point. remove_piece something first.`);
      beginWrite(`raising a landmark in ${zone.label}`, { lot, catalogId: item.id });
      const outcome = agentPlaceOne({ item, lot, reason: "the centerpiece" });
      await afterRender();
      if (!outcome.ok) {
        endWrite("couldn't raise the landmark");
        return fail(outcome.why, { empty_nearby: outcome.empty_nearby });
      }
      endWrite(`raised ${phraseForCatalog(item.id, item.kind)} in ${zone.label}`);
      return ok({
        noticed: `focal point: ${outcome.piece.id} at ${outcome.piece.lot} in ${zone.label}`,
        created: { id: outcome.piece.id, lot: outcome.piece.lot },
      });
    },
  },
  {
    name: "validate_scene",
    description:
      "READ — the scene completeness score and the ONLY arbiter of done. Tool success ≠ scene success: a build is finished when this returns complete:true, not when your calls stop erroring. Runs the composition grammar as a checklist — architecture, zones, focal point, characters, populated zones, paths, connected elevation, grounding, density, and (when a theme is given) the zones that theme implies — and every failed check names the repair tool. Call after every significant build phase. Loop INSPECT (get_occupancy/get_scene) → validate_scene → repair (create_* / move_piece / remove_piece / place_piece) → validate_scene until complete. Never declare a scene finished without this passing.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "What the scene is supposed to be. Defaults to the board's standing goal." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const state = useTown.getState();
      const theme = (typeof input.theme === "string" && input.theme.trim()) || state.nudgeGoal || undefined;
      const report = validateScene(state.environment, state.pieces, theme ?? undefined);
      return okWide({
        complete: report.complete,
        completion: `${report.completion}%`,
        checks: report.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.id}: ${c.note}${!c.ok && c.fix ? ` → ${c.fix}` : ""}`),
        ...(report.missing.length ? { missing: report.missing } : {}),
      });
    },
  },

  // -------------------------------------------------------------------------
  // Seed tools — every generated scene is a seeded procedural world. The AI
  // never touches seed state directly; these are the only seed verbs.
  // -------------------------------------------------------------------------
  {
    name: "get_scene_seed",
    description:
      "READ. The current scene's seed identity: seed, prompt, sceneType, generator version, createdAt, and the share_url that reproduces this exact world on any board (the URL encodes prompt + seed, never coordinates). Returns has_seed:false for authored/freeform boards — compose_scene mints one.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const meta = useTown.getState().sceneMeta;
      if (!meta) {
        return ok({
          has_seed: false,
          note: "This board is authored/freeform — no procedural seed. compose_scene or plan_scene mints one.",
        });
      }
      return ok({
        has_seed: true,
        seed: meta.seed,
        prompt: meta.prompt,
        scene_type: meta.sceneType,
        generator_version: meta.version,
        created_at: meta.createdAt,
        share_url: sceneShareUrl(),
        note: "Same prompt + same seed = the same world, reproducibly.",
      });
    },
  },
  {
    name: "generate_scene_seed",
    description:
      "SEED. Mint a fresh unique scene seed (like MARKET-8F42KQ) WITHOUT building anything — use it in a later compose_scene/plan_scene call, or to offer the human a choice of worlds. Pass concept to flavor the prefix (e.g. 'market'). Seeds belong to scenes, never to users, and are never predictable.",
    inputSchema: {
      type: "object",
      properties: {
        concept: { type: "string", description: "Optional concept word for the seed prefix, e.g. 'market' → MARKET-…" },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const seed = generateSceneSeed(typeof input.concept === "string" ? input.concept : undefined);
      return ok({ seed, note: "Pass this to compose_scene or plan_scene as {seed}." });
    },
  },
  {
    name: "set_scene_seed",
    description:
      "SEED. Import a specific seed (e.g. from a shared scene) as the board's scene identity. Pass seed and optional prompt (defaults to the current scene's prompt or the board's standing goal — required if neither exists). By default the world is REBUILT deterministically from that seed (pass rebuild:false to only stamp the identity). Same prompt + same seed = the same world another user shared.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "The seed to import, e.g. MARKET-8F42KQ." },
        prompt: { type: "string", description: "The scene prompt the seed belongs to. Defaults to the current prompt / standing goal." },
        rebuild: { type: "boolean", description: "Default true: rebuild the scene from this seed now." },
      },
      required: ["seed"],
    },
    execute: async (input) => {
      if (!isValidSeed(input.seed)) {
        return fail(`"${String(input.seed)}" is not a valid seed. Seeds look like MARKET-8F42KQ.`);
      }
      const seed = normalizeSeed(String(input.seed));
      const state = useTown.getState();
      const prompt =
        (typeof input.prompt === "string" && input.prompt.trim().slice(0, 160)) ||
        state.sceneMeta?.prompt ||
        state.nudgeGoal ||
        "";
      if (!prompt) return fail("No prompt to pair with this seed. Pass prompt (the seed's scene description).");
      if (input.rebuild === false) {
        rememberScene(seed, prompt);
        return ok({ noticed: `scene identity set: ${seed} (“${prompt}”) — not rebuilt`, seed, share_url: sceneShareUrl() });
      }
      beginWrite(`rebuilding from seed ${seed}`, null);
      const { plan, placed, validation } = await buildScene(prompt, seed);
      endWrite(`rebuilt ${seed} — ${placed} pieces`);
      return okWide({
        noticed: `rebuilt “${prompt}” from ${seed}: ${placed} pieces, ${validation.completion}% complete`,
        seed: plan.seed,
        fingerprint: fingerprint({ env: plan.env, todos: plan.todos }),
        share_url: sceneShareUrl(),
        validation: { completion: validation.completion, complete: validation.complete },
      });
    },
  },
  {
    name: "regenerate_scene",
    description:
      "SEED — remix: mint a NEW seed and rebuild the same scene concept as a meaningfully different composition — different footprint, zone arrangement, asset picks, and detail; not the same world shuffled. Uses the current scene's prompt (or the board's standing goal). Human pieces are preserved. Returns the new seed and share_url; the old seed still reproduces the old world if anyone kept it.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Optional new prompt; defaults to the current scene's prompt." },
      },
    },
    execute: async (input) => {
      const state = useTown.getState();
      const prompt =
        (typeof input.prompt === "string" && input.prompt.trim().slice(0, 160)) ||
        state.sceneMeta?.prompt ||
        state.nudgeGoal ||
        "";
      if (!prompt) return fail("Nothing to regenerate — no current scene prompt. Use compose_scene first.");
      const previous = state.sceneMeta?.seed;
      const seed = generateSceneSeed(prompt);
      beginWrite(`remixing ${prompt}`, null);
      const { plan, placed, validation } = await buildScene(prompt, seed);
      endWrite(`remixed — ${seed}`);
      return okWide({
        noticed: `remixed “${prompt}”: ${previous ?? "unseeded"} → ${plan.seed} (${placed} pieces, ${validation.completion}% complete)`,
        seed: plan.seed,
        previous_seed: previous,
        fingerprint: fingerprint({ env: plan.env, todos: plan.todos }),
        share_url: sceneShareUrl(),
        validation: { completion: validation.completion, complete: validation.complete },
      });
    },
  },

  // -------------------------------------------------------------------------
  // World rules + themed terrain + bulk environment — the rule engine and
  // material ecosystem, exposed as semantic verbs.
  // -------------------------------------------------------------------------
  {
    name: "get_scene_rules",
    description:
      "READ. The world-building LAWS this application enforces — composition rules (what a scene must contain) and realism rules (what placements must respect) — plus the theme roster and the ground-material palette. validate_scene runs every applicable rule; the hard rules (stair approaches, walkways) are enforced at placement time and will refuse violating writes. Read this before building to operate inside the laws instead of discovering them by refusal.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () =>
      okWide({
        rules: SCENE_RULES.map((r) => `[${r.kind}] ${r.id} — ${r.law}`),
        themes: THEMES.map((t) => `${t.id}: ${t.label}`),
        ground_materials: GROUND_MATERIALS,
        note: "AI = intent, rules = validity, seed = variation, WebMCP = interface.",
      }),
  },
  {
    name: "create_vegetation",
    description:
      "SEMANTIC (bulk) — environmental planting in one call; never place trees one at a time. area: 'edge' rings the island's actual coastline with a dense seeded boundary (species, flips, and gaps varied; entrances/piers/roads left open) — THE tool for forest edges and environmental framing, and the repair for a bare-boundary validation failure. Or pass a zone id/type to plant inside that zone. Optional style (catalog flavor, e.g. 'pine trees rocks') and density (low|medium|high). Placements go through the same collision/lock/walkway rules as everything else.",
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
      const seedBase = `${state.sceneMeta?.seed ?? "UNSEEDED"}-${Object.keys(state.pieces).length}`;
      const style = typeof input.style === "string" ? input.style.slice(0, 60) : undefined;
      const densityMap = { low: 0.3, medium: 0.5, high: 0.75 } as const;
      const density = densityMap[String(input.density) as keyof typeof densityMap];
      const area = String(input.area ?? "").trim().toLowerCase();
      let specs: { item: CatalogItem; col: number; row: number; flip: boolean; reason: string }[] = [];
      if (area === "edge") {
        specs = planBoundary(landMaskFromEnv(env), themeSpec, seedBase, buildFrameSkip(env), {
          density,
          query: style,
        });
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
              specs.push({
                item: pool[Math.floor(rng() * pool.length)],
                col: c,
                row: r,
                flip: rng() > 0.5,
                reason: `growing in ${zone.label}`,
              });
            }
          }
        }
      }
      if (!specs.length) return fail("Nothing to plant there — the area may be fully framed already.");
      beginWrite(area === "edge" ? "raising the boundary" : `planting ${area}`, null);
      let placed = 0;
      for (const spec of specs) {
        const outcome = agentPlaceOne({ item: spec.item, lot: lotId(spec.col, spec.row), flip: spec.flip, reason: spec.reason });
        if (outcome.ok) placed += 1;
      }
      await afterRender();
      endWrite(`planted ${placed} pieces`);
      return ok({
        noticed: `${area === "edge" ? "boundary raised" : `planted ${area}`}: ${placed}/${specs.length} placed`,
        placed,
        skipped: specs.length - placed,
      });
    },
  },
  {
    name: "create_ground_patch",
    description:
      "SEMANTIC — paint one themed ground patch: an intentional region of a different material, not noise. The repair for a too-uniform ground. Pass material (see get_scene_rules for the palette), optional near (zone id/type or lot id — defaults to the island center), and size (small|medium|large). Patches merge into the scene's material ecosystem and render as coherent voxel regions.",
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
      if (!GROUND_MATERIALS.includes(material)) {
        return fail(`Unknown material "${material}".`, { materials: GROUND_MATERIALS });
      }
      const island = landMaskFromEnv(env);
      if (!island.cells.size) return fail("No ground to paint.");
      const center =
        (input.near != null ? resolvePoint(env, String(input.near)) : null) ?? {
          col: island.bbox.c0 + Math.floor(island.bbox.w / 2),
          row: island.bbox.r0 + Math.floor(island.bbox.d / 2),
          label: "the center",
        };
      const radius = { small: 1.6, medium: 2.6, large: 3.6 }[String(input.size) as "small" | "medium" | "large"] ?? 2.6;
      const rng = createSeededRandom(deriveSeed(`${state.sceneMeta?.seed ?? "UNSEEDED"}`, `patch:${material}:${center.col}:${center.row}:${env.ground?.length ?? 0}`));
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
      "SEMANTIC — restyle the whole environment with a theme's material ecosystem: repaints the ground platforms to the theme's primary, lays fresh seeded secondary/accent/rare patches, and sets the themed walk material. Pass theme (an id from get_scene_rules, or free text to resolve one, e.g. 'spooky graveyard'). Pieces are untouched — follow with create_vegetation {area:'edge'} if the boundary should change too.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "Theme id (e.g. spooky, candy, snow) or free text." },
      },
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
      const platforms = env.platforms.map((p) => {
        if (p.inset || p.level !== 0 || p.material === "road" || p.id === "pier") return p;
        return { ...p, material: themeSpec.primary };
      });
      useTown.getState().setEnvironment(
        withWaterPaint(
          {
            ...env,
            platforms,
            ground: paintTerrain(island, themeSpec, state.sceneMeta?.seed ?? "UNSEEDED"),
            themeId: themeSpec.id,
            pathMaterial: themeSpec.pathMaterial,
          },
          state.sceneMeta?.seed ?? "UNSEEDED",
        ),
      );
      await afterRender();
      endWrite(`restyled as ${themeSpec.label}`);
      return ok({
        noticed: `theme applied: ${themeSpec.label} (${themeSpec.primary} ground, patches of ${[...themeSpec.secondary, ...themeSpec.accent].map((l) => l.m).join(", ")})`,
        theme: themeSpec.id,
      });
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

/**
 * WebMCP lifecycle log — dev-only console line per call: tool, args, wall
 * time, and a one-line result (or the error). Makes it obvious in DevTools
 * whether an agent actually ran plan → compose → validate → repair, or just
 * hammered primitives. The user-facing tally lives in the Agent Build panel.
 */
function logToolCall(name: string, input: Record<string, unknown>, ms: number, result?: ModelContextToolResult, err?: unknown) {
  if (process.env.NODE_ENV === "production") return;
  const args = JSON.stringify(input ?? {});
  const argLine = args.length > 160 ? `${args.slice(0, 160)}…` : args;
  if (err) {
    console.warn(`[webmcp] ${name} ✗ ${ms.toFixed(0)}ms`, argLine, err);
    return;
  }
  const text = result?.content?.[0]?.text ?? "";
  const summary = typeof text === "string" && text.length > 140 ? `${text.slice(0, 140)}…` : text;
  console.debug(`[webmcp] ${name} ${result?.isError ? "✗" : "✓"} ${ms.toFixed(0)}ms`, argLine, summary);
}

async function runInstrumented(
  tool: ModelContextTool,
  input: Record<string, unknown>,
): Promise<ModelContextToolResult> {
  useTown.getState().recordToolCall(tool.name);
  const t0 = performance.now();
  try {
    const result = await tool.execute(input);
    logToolCall(tool.name, input, performance.now() - t0, result);
    return result;
  } catch (err) {
    logToolCall(tool.name, input, performance.now() - t0, undefined, err);
    throw err;
  }
}

/** Same tool list the host sees, with the call counter + lifecycle log. */
function instrumentedTools() {
  return TOWN_TOOLS.map((tool) => ({
    ...tool,
    execute: (input: Record<string, unknown>) => runInstrumented(tool, input),
  }));
}

/** Dev/test harness — lets a console (or a test driver) call the same executes. */
export async function callTownTool(
  name: string,
  input: Record<string, unknown> = {},
): Promise<ModelContextToolResult> {
  const tool = TOWN_TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`No tool named "${name}".`);
  return runInstrumented(tool, input);
}

export { CATALOG, FEATURED };
