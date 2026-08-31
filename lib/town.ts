"use client";

import { CATALOG, catalogItem, defaultForKind, FEATURED, type CatalogItem } from "./catalog";
import { snapLotCoord } from "./iso";
import { clampLabel, useTown } from "./store";
import { buildStory } from "./story";
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
export function chooseAutoLot(occ = occupancyMap()): string | null {
  if (occ.size === 0) {
    return CENTER_LOTS.find((lot) => !occ.has(lot)) ?? null;
  }
  const seen = new Set<string>();
  const candidates: string[] = [];
  const occupied = [...occ.keys()];
  for (const lot of occupied) {
    for (const gap of [2, 1]) {
      for (const side of SIDE_ORDER) {
        const next = stepLot(lot, side, gap);
        if (next && !occ.has(next) && !seen.has(next)) {
          seen.add(next);
          candidates.push(next);
        }
      }
    }
  }
  const pool = candidates.length ? candidates : emptyLots(occ);
  if (!pool.length) return null;
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
  return {
    grid: { infinite: true },
    catalog_pieces: CATALOG.length,
    catalog_packs: FEATURED.length,
    goal: state.nudgeGoal,
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
function occupiedHint(lot: string, occ = occupancyMap()) {
  const holder = occ.get(lot);
  const empties = nearestEmpties(lot, occ, 4);
  return {
    error: holder
      ? `Lot ${lot} occupied by ${holder.id} (${holder.owner}${holder.locked ? ", locked" : ""}).`
      : `Lot ${lot} unavailable.`,
    empty_nearby: empties,
  };
}

function nearestEmpties(fromLot: string, occ = occupancyMap(), count = 4): string[] {
  const from = lotCenter(fromLot);
  return emptyLots(occ)
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
  /** The planner's zone reason ("the centerpiece"), carried into the story log. */
  reason?: string;
};

export type PlaceOutcome =
  | { ok: true; piece: Piece }
  | { ok: false; why: string; empty_nearby?: string[]; lot?: string };

/**
 * Place one catalog object. The page picks and validates the cell; raw x,y
 * never enters this function. Refuses occupied lots, never touches locked ones.
 */
export function placePiece(spec: PlaceSpec, owner: Owner): PlaceOutcome {
  const occ = occupancyMap();
  let lot: string | null = null;

  if (spec.lot != null) {
    const parsed = parseLot(spec.lot);
    if (!parsed) {
      return { ok: false, why: `"${String(spec.lot)}" is not a lot. Use A1-style ids (C4, M13).` };
    }
    lot = lotId(parsed.col, parsed.row);
  } else if (spec.relativeTo != null) {
    const anchor = useTown.getState().pieces[String(spec.relativeTo).trim()];
    if (!anchor) {
      return { ok: false, why: `No piece "${String(spec.relativeTo)}". Use ids from get_occupancy.` };
    }
    const side = spec.side ?? "east";
    const gap = Math.min(8, Math.max(0.5, Math.round(Number(spec.gap ?? 1) * 2) / 2 || 1));
    lot = stepLot(anchor.lot, side, gap);
    if (!lot) {
      return {
        ok: false,
        why: `${side} of ${anchor.id} (${anchor.lot}) is off-grid.`,
        empty_nearby: nearestEmpties(anchor.lot, occ),
      };
    }
  } else {
    lot = chooseAutoLot(occ);
    if (!lot) return { ok: false, why: "No empty lots left." };
  }

  const holder = occ.get(lot);
  if (holder) {
    const hint = occupiedHint(lot, occ);
    return { ok: false, why: hint.error, empty_nearby: hint.empty_nearby, lot };
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
  if (input.reason != null) spec.reason = String(input.reason).slice(0, 60);
  return spec;
}

function agentPlaceOne(spec: PlaceSpec): PlaceOutcome {
  const outcome = placePiece(spec, "agent");
  if (outcome.ok) {
    const store = useTown.getState();
    store.setAgentLastMove(`placed ${outcome.piece.id} on ${outcome.piece.lot}`);
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

/** Show the model's stated intent on the canvas the moment a write starts. */
function beginWrite(intent: string | null, ghost: { lot: string; catalogId: string } | null) {
  const store = useTown.getState();
  if (intent) store.setAgentStatus(intent);
  store.setAgentGhost(ghost);
  store.setAgentBusy(true);
}

/** Swap the chip to what actually happened; drop the ghost. */
function endWrite(noticed: string | null) {
  const store = useTown.getState();
  if (noticed) store.setAgentStatus(noticed);
  store.setAgentGhost(null);
  if (!store.agentLoop) store.setAgentBusy(false);
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
  if (!hadPiecesBefore && occupancyMap().size > 0) {
    useTown.getState().bumpFocus();
  }
}

// ---------------------------------------------------------------------------
// plan_scene — a proposal, never a mutation.
// ---------------------------------------------------------------------------

function planScene(theme: string, keepHumanLots: boolean) {
  const occ = occupancyMap();
  const reserved = keepHumanLots ? occ.keys() : [...occ.entries()].filter(([, p]) => p.owner === "human").map(([lot]) => lot);
  const todos = planCompleteScene(theme, reserved);
  const skip = keepHumanLots
    ? humanLockLots(occ).map((lot) => ({ lot, why: `human-owned ${occ.get(lot)?.id ?? ""}`.trim() }))
    : [];

  return {
    todos,
    skip,
    note: `Nothing placed. ${todos.length} pieces planned as a complete scene. Feed todos to place_piece or place_batch as {id: place, lot, flip, reason} — copy reason through verbatim.`,
  };
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
      "Call first. Read-only map of the scene: grid size, catalog_pieces (full Kenney catalog size — every id is placeable), goal (the human's standing Nudge — build toward it when set), filled lots as lot:id:owner (owner is human|agent), empty lots, human_locks (must not be written), the human's selection, and last_human_actions (what the person just did). Empty lots are the only legal targets. Browse every id with list_catalog.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => ok(occupancySnapshot()),
  },
  {
    name: "list_catalog",
    description:
      "Read-only. The complete Kenney catalog — every pack, every id, not a featured subset. Filter with pack (e.g. furniture, pets, food, nature, coaster, toy-car), kind (pet|food|furniture|building|cave|space|nature|coaster|character|car|boat|...), or query (substring of id/label). Omit filters to list every pack with all ids. Use these ids in place_piece / place_batch / plan_scene.",
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
      "Read-only compact list of every placed piece: id:lot:kind:owner:locked-flag:label. Ids embed their catalog id (e.g. pirate-barrel-2). If the list is long you get a count instead — then use get_occupancy plus lookup_object.",
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
      "Read-only full record for one piece id (from get_occupancy or get_scene): catalog id, kind, lot, sprite src, owner, locked, label.",
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
      "Read-only view of what the human has selected right now plus their recent edits. Check this to build around the human's current focus instead of guessing.",
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
      "Read-only. Turns everything placed so far into a short narrated recap — a few paragraphs of actual prose, not a log — that you can relay to the human in your own words or verbatim. Covers what got built, roughly in what order, and moments where the agent worked around the human's locked pieces. Call this when the human asks what happened, what you built, or for a summary/recap/story of the session.",
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
      "Plan a complete scene without mutating anything. Uses the FULL Kenney catalog (every pack, every id — not a featured subset). Pass theme (e.g. 'pirate dock with boats and cars', 'cozy living room', 'cube pet zoo') and optional keep_human_lots (default true). Returns a full layout of todos [{id, place: catalog-id, lot, flip, reason}] with real spacing — not a pile. Call list_catalog if you need ids, then get_occupancy, then this, then place EVERY todo (place_piece or place_batch). Do not stop after a handful of pieces.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "What to build, e.g. 'pirate dock', 'market street', 'skate park'. Defaults to the human's Nudge goal when omitted." },
        keep_human_lots: { type: "boolean", description: "Default true. Never plan over human lots." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const theme = String(input.theme ?? "").slice(0, 120) || (useTown.getState().nudgeGoal ?? "");
      const keep = input.keep_human_lots !== false;
      return okWide(planScene(theme, keep));
    },
  },
  {
    name: "place_piece",
    description:
      `Place one Kenney object from the catalog. Pass id (catalog id, preferred — e.g. ${ID_EXAMPLES}) or kind (stall|prop|character|tree|crate|machine|ramp|dungeon|boat|pirate|car|pet|food|furniture|building|cave|space|nature|coaster). Target a lot (A1-style) OR relative_to (piece id) + side (north|south|east|west) + optional gap. No x,y — the page picks the cell; with no target it grows the scene. Refuses occupied and human-locked lots, returns the new id plus empty lots. For a full scene use plan_scene then place every todo. ${AGENT_WRITE_RULES}`,
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
        reason: { type: "string", description: "Copy this todo's reason from plan_scene verbatim (e.g. 'the centerpiece', 'out over the water') so the story can narrate the scene by zone." },
      },
    },
    execute: async (input) => {
      const spec = parsePlaceSpec(input);
      if ("error" in spec) return fail(spec.error);
      const intent = chipText(input.intent);
      const hadPieces = occupancyMap().size > 0;
      const ghostLot = spec.lot && parseLot(spec.lot) ? spec.lot.trim().toUpperCase() : null;
      beginWrite(intent ?? `placing ${spec.item.label}`, ghostLot ? { lot: ghostLot, catalogId: spec.item.id } : null);
      const outcome = agentPlaceOne(spec);
      await afterRender();
      if (!outcome.ok) {
        endWrite(`blocked: ${outcome.why.slice(0, 70)}`);
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
      endWrite(`placed ${outcome.piece.id} on ${outcome.piece.lot}`);
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
      `Place many catalog objects in one call — the right tool for building a complete scene. Before placing, say what you noticed and what you will build — pass it as intent. items: array of place_piece specs ({id or kind, lot? or relative_to+side+gap?, flip?, reason?}), applied in order — copy each todo's reason through verbatim. Human locks and collisions are skipped, not fatal. Returns per-item ok/skip, occupancy, and a one-line noticed: string. Place every planned todo; do not stop early. ${AGENT_WRITE_RULES}`,
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
        const outcome = agentPlaceOne(spec);
        if (outcome.ok) {
          placed += 1;
          report.push({ ok: true, id: outcome.piece.id, lot: outcome.piece.lot });
        } else {
          if (spec.lot) skippedLots.push(spec.lot.trim().toUpperCase());
          report.push({ ok: false, skip: outcome.why });
        }
        await afterRender();
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
      endWrite(noticed);
      return ok({ noticed, intent: intent ?? undefined, items: report, occupancy: occupancySnapshot() });
    },
  },
  {
    name: "move_piece",
    description:
      `Move one agent-owned piece to a new lot: id plus lot OR relative_to + side + gap. Refuses human-locked pieces, occupied targets, and off-grid lots. ${AGENT_WRITE_RULES}`,
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
      const intent = chipText(input.intent);
      beginWrite(intent ?? `moving ${piece.id} to ${target}`, { lot: target, catalogId: piece.catalogId });
      store.patchPiece(piece.id, { lot: target });
      store.setAgentLastMove(`moved ${piece.id} to ${target}`);
      store.pushEvent({ actor: "agent", verb: "move", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: target });
      await afterRender();
      endWrite(`moved ${piece.id} to ${target}`);
      return ok({ noticed: `moved ${piece.id} to ${target}`, intent: intent ?? undefined, moved: { id: piece.id, lot: target }, occupancy: occupancySnapshot() });
    },
  },
  {
    name: "label_piece",
    description:
      "Set the text label on one piece: id, text (40 chars max). Labels only. Refuses human-locked pieces.",
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
      store.setAgentLastMove(`labeled ${piece.id} "${text}"`);
      store.pushEvent({ actor: "agent", verb: "label", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot, label: text });
      await afterRender();
      endWrite(`labeled ${piece.id}`);
      return ok({ noticed: `labeled ${piece.id}`, labeled: { id: piece.id, label: text } });
    },
  },
  {
    name: "remove_piece",
    description:
      "Remove one agent-owned piece by id. Human-owned pieces are refused unless the human currently has that piece selected AND force:true is passed. There is no clear-all.",
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
      store.setAgentLastMove(`removed ${piece.id} from ${piece.lot}`);
      store.pushEvent({ actor: "agent", verb: "remove", pieceId: piece.id, catalogId: piece.catalogId, kind: piece.kind, lot: piece.lot });
      await afterRender();
      endWrite(`removed ${piece.id}`);
      return ok({ noticed: `removed ${piece.id} from ${piece.lot}`, removed: piece.id, occupancy: occupancySnapshot() });
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

  if (document.modelContext?.registerTool) {
    for (const { name, description, inputSchema, execute, annotations } of TOWN_TOOLS) {
      await document.modelContext.registerTool({ name, description, inputSchema, execute, annotations }, { signal });
    }
    await document.modelContext.provideContext?.({ tools: TOWN_TOOLS });
    signal.addEventListener("abort", () => {
      void document.modelContext?.provideContext?.({ tools: [] });
    });
    return "document.modelContext";
  }
  if (navigator.modelContext?.registerTool) {
    for (const { name, description, inputSchema, execute, annotations } of TOWN_TOOLS) {
      await navigator.modelContext.registerTool({ name, description, inputSchema, execute, annotations }, { signal });
    }
    await navigator.modelContext.provideContext?.({ tools: TOWN_TOOLS });
    return "navigator.modelContext";
  }
  if (document.modelContext?.provideContext) {
    await document.modelContext.provideContext({ tools: TOWN_TOOLS });
    return "document.modelContext";
  }
  return null;
}

/** Dev/test harness — lets a console (or a test driver) call the same executes. */
export async function callTownTool(
  name: string,
  input: Record<string, unknown> = {},
): Promise<ModelContextToolResult> {
  const tool = TOWN_TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`No tool named "${name}".`);
  return tool.execute(input);
}

export { CATALOG, FEATURED };
