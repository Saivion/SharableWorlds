"use client";

import { create } from "zustand";
import type { ComposedPlan } from "./composition/compose";
import type { SceneMeta } from "./composition/seed";
import type { EnvironmentSpec } from "./composition/types";
import type { ValidationReport } from "./composition/validate";
import type { Piece, StoryEvent, ToolMode } from "./types";
import { LABEL_MAX_CHARS } from "./types";

/** Lifecycle phase a WebMCP call belongs to — derived from the tool name. */
export type BuildPhase = "understand" | "plan" | "compose" | "execute" | "inspect" | "validate" | "repair" | "complete";

export type TraceCaller = "host" | "runner" | "ui";

/** One WebMCP call in the lifecycle trace: tool, args, timing, outcome. */
export type TraceEntry = {
  id: number;
  /** Enclosing call when a bulk/orchestrating tool dispatched this one. */
  parent?: number;
  phase: BuildPhase;
  tool: string;
  caller: TraceCaller;
  /** Compact JSON of the arguments (≤ 160 chars). */
  args: string;
  t: number;
  ms?: number;
  ok?: boolean;
  /** One line: the tool's `noticed` / `error`. */
  summary?: string;
  placed?: number;
  skipped?: number;
};

const TRACE_MAX = 400;

export const AGENT_ACCENT = "#236ffd";

const HUMAN_ACTIONS_MAX = 6;
const UNDO_MAX = 40;
const EVENTS_MAX = 200;
export const NUDGE_MAX_CHARS = 200;

export type UndoEntry =
  | { t: "place"; id: string }
  | { t: "remove"; piece: Piece }
  | { t: "label"; id: string; prev: string }
  | { t: "move"; id: string; prevLot: string }
  | { t: "flip"; id: string; prev: boolean };

export type TownStore = {
  /** All pieces by id. Occupancy is derived from this — one lot, one piece. */
  pieces: Record<string, Piece>;
  /**
   * The authored architecture under the pieces: platforms, walls, stairs,
   * paths, water, zones. Set by scene plans (and the reference scene); null
   * means freeform — the stage derives ground pads under whatever exists.
   */
  environment: EnvironmentSpec | null;
  /** Seed + prompt + generator version of the current procedural scene —
   * enough to reproduce the world. Null for authored/freeform boards. */
  sceneMeta: SceneMeta | null;
  /** Per-catalog-item id counters — instance ids stay stable, never reused. */
  counters: Record<string, number>;
  /** Human's current selection (piece ids). */
  selection: string[];
  /** Short human activity log, newest last — surfaced to the agent via get_selection. */
  humanActions: string[];
  /**
   * Full build log, newest last. Unlike `pieces`, this survives a scene wipe
   * (new Nudge goal) — it's the raw material `lib/story.ts` narrates from.
   */
  events: StoryEvent[];
  /** One-line live trace of the agent's last write, for the footer. */
  agentLastMove: string | null;
  /** Live status chip: what the agent says it is doing / just noticed. */
  agentStatus: string | null;
  /** Ghost sprite target while a write is in flight. */
  agentGhost: { lot: string; catalogId: string } | null;
  /** Screen-space agent pointer while it is working. */
  agentCursor: { x: number; y: number; visible: boolean } | null;
  /** Catalog id the agent is currently grabbing in the kit. */
  agentGrabId: string | null;
  /** Bulk carry: what the agent grabbed and how many are left to place. */
  agentCarry: { catalogId: string; count: number } | null;
  /** True between a write's start and finish — drives the "agent building" state. */
  agentBusy: boolean;
  /** True while a multi-piece Nudge build is in flight — keeps busy across placements. */
  agentLoop: boolean;
  /** WebMCP tool invocations this chapter — name → call count. */
  toolCalls: Record<string, number>;
  /** The lifecycle trace this chapter — every WebMCP call, nested. */
  trace: TraceEntry[];
  /** The phase the agent is in right now (last call), or complete. */
  phase: BuildPhase | null;
  /** Last validation report — the completeness score the UI shows. */
  validation: (ValidationReport & { t: number }) | null;
  /** The plan the current scene was composed from — the staged tools
   * (compose_scene / populate_zones / create_environment) read it. */
  scenePlan: ComposedPlan | null;
  /** Kit palette open — the agent opens it when grabbing a piece. */
  kitOpen: boolean;
  /** Bumped when the camera should ease to frame the town (first build). */
  focusToken: number;
  /** Persistent goal statement the human sets for the agent — not chat. */
  nudgeGoal: string | null;
  /** Bumped on every goal commit — re-committing the same text re-triggers. */
  nudgeToken: number;
  tool: ToolMode;
  /** Catalog id armed for placement when tool === "place". */
  activeId: string | null;
  undoStack: UndoEntry[];
  webmcp: "pending" | "available" | "missing";
  lastError: string | null;

  setEnvironment: (env: EnvironmentSpec | null) => void;
  setSceneMeta: (meta: SceneMeta | null) => void;
  addPiece: (piece: Piece) => void;
  deletePiece: (id: string) => void;
  patchPiece: (id: string, patch: Partial<Piece>) => void;
  bumpCounter: (catalogId: string) => number;
  setSelection: (ids: string[]) => void;
  recordHumanAction: (text: string) => void;
  pushEvent: (event: Omit<StoryEvent, "t">) => void;
  setAgentLastMove: (text: string) => void;
  setAgentStatus: (text: string | null) => void;
  setAgentGhost: (ghost: { lot: string; catalogId: string } | null) => void;
  setAgentCursor: (cursor: { x: number; y: number; visible: boolean } | null) => void;
  setAgentGrabId: (id: string | null) => void;
  setAgentCarry: (carry: { catalogId: string; count: number } | null) => void;
  setAgentBusy: (busy: boolean) => void;
  setAgentLoop: (loop: boolean) => void;
  recordToolCall: (name: string) => void;
  beginTrace: (entry: Omit<TraceEntry, "id" | "t">) => number;
  endTrace: (id: number, patch: Partial<TraceEntry>) => void;
  setPhase: (phase: BuildPhase | null) => void;
  setValidation: (report: ValidationReport | null) => void;
  setScenePlan: (plan: ComposedPlan | null) => void;
  /** Add many pieces in ONE store update (one render), for bulk tools. */
  addPieces: (pieces: Piece[]) => void;
  setKitOpen: (open: boolean) => void;
  bumpFocus: () => void;
  setNudgeGoal: (goal: string | null) => void;
  setTool: (tool: ToolMode) => void;
  setActiveId: (id: string | null) => void;
  pushUndo: (entry: UndoEntry) => void;
  undo: () => void;
  setWebmcp: (state: TownStore["webmcp"]) => void;
  setLastError: (message: string | null) => void;
};

export function clampLabel(text: string) {
  // Printable characters only — tool input is untrusted.
  return text.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, LABEL_MAX_CHARS);
}

let traceSeq = 1;

export const useTown = create<TownStore>((set, get) => ({
  pieces: {},
  environment: null,
  sceneMeta: null,
  counters: {},
  selection: [],
  humanActions: [],
  events: [],
  agentLastMove: null,
  agentStatus: null,
  agentGhost: null,
  agentCursor: null,
  agentGrabId: null,
  agentCarry: null,
  agentBusy: false,
  agentLoop: false,
  toolCalls: {},
  trace: [],
  phase: null,
  validation: null,
  scenePlan: null,
  kitOpen: true,
  focusToken: 0,
  nudgeGoal: null,
  nudgeToken: 0,
  tool: "select",
  activeId: "characters-character-female-a",
  undoStack: [],
  webmcp: "pending",
  lastError: null,

  setEnvironment: (environment) => set({ environment }),
  setSceneMeta: (sceneMeta) => set({ sceneMeta }),
  addPiece: (piece) =>
    set((state) => ({
      pieces: {
        ...state.pieces,
        [piece.id]: { ...piece, label: clampLabel(piece.label), flip: Boolean(piece.flip) },
      },
    })),
  deletePiece: (id) =>
    set((state) => {
      const pieces = { ...state.pieces };
      delete pieces[id];
      return { pieces, selection: state.selection.filter((s) => s !== id) };
    }),
  patchPiece: (id, patch) =>
    set((state) => {
      const prev = state.pieces[id];
      if (!prev) return state;
      const next = { ...prev, ...patch };
      next.label = clampLabel(next.label);
      return { pieces: { ...state.pieces, [id]: next } };
    }),
  bumpCounter: (catalogId) => {
    const next = (get().counters[catalogId] ?? 0) + 1;
    set((state) => ({ counters: { ...state.counters, [catalogId]: next } }));
    return next;
  },
  setSelection: (selection) => set({ selection }),
  recordHumanAction: (text) =>
    set((state) => ({
      humanActions: [...state.humanActions, text].slice(-HUMAN_ACTIONS_MAX),
    })),
  pushEvent: (event) =>
    set((state) => ({
      events: [...state.events, { ...event, t: Date.now() }].slice(-EVENTS_MAX),
    })),
  setAgentLastMove: (agentLastMove) => set({ agentLastMove }),
  setAgentStatus: (agentStatus) => set({ agentStatus }),
  setAgentGhost: (agentGhost) => set({ agentGhost }),
  setAgentCursor: (agentCursor) => set({ agentCursor }),
  setAgentGrabId: (agentGrabId) => set({ agentGrabId }),
  setAgentCarry: (agentCarry) => set({ agentCarry }),
  setAgentBusy: (agentBusy) => set({ agentBusy }),
  setAgentLoop: (agentLoop) => set({ agentLoop }),
  recordToolCall: (name) =>
    set((state) => ({
      toolCalls: { ...state.toolCalls, [name]: (state.toolCalls[name] ?? 0) + 1 },
    })),
  beginTrace: (entry) => {
    const id = traceSeq++;
    set((state) => ({
      trace: [...state.trace, { ...entry, id, t: Date.now() }].slice(-TRACE_MAX),
      phase: entry.phase,
    }));
    return id;
  },
  endTrace: (id, patch) =>
    set((state) => ({ trace: state.trace.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
  setPhase: (phase) => set({ phase }),
  setValidation: (report) => set({ validation: report ? { ...report, t: Date.now() } : null }),
  setScenePlan: (scenePlan) => set({ scenePlan }),
  addPieces: (list) =>
    set((state) => {
      const pieces = { ...state.pieces };
      for (const piece of list) pieces[piece.id] = { ...piece, label: clampLabel(piece.label), flip: Boolean(piece.flip) };
      return { pieces };
    }),
  setKitOpen: (kitOpen) => set({ kitOpen }),
  bumpFocus: () => set((state) => ({ focusToken: state.focusToken + 1 })),
  setNudgeGoal: (goal) => {
    const trimmed = goal?.trim().slice(0, NUDGE_MAX_CHARS) ?? "";
    set((state) => {
      if (!trimmed.length) {
        return { nudgeGoal: null };
      }
      // A new goal starts a new scene — wipe prior objects first. The event
      // log survives so the story can narrate the pivot as a chapter break.
      const clearedCount = Object.keys(state.pieces).length;
      const events = [
        ...state.events,
        {
          t: Date.now(),
          actor: "human" as const,
          verb: "goal" as const,
          goal: trimmed,
          detail: clearedCount ? `cleared ${clearedCount} piece${clearedCount === 1 ? "" : "s"}` : undefined,
        },
      ].slice(-EVENTS_MAX);
      return {
        pieces: {},
        environment: null,
        sceneMeta: null,
        counters: {},
        selection: [],
        undoStack: [],
        agentGhost: null,
        agentCursor: null,
        agentGrabId: null,
        agentCarry: null,
        agentBusy: false,
        agentLastMove: null,
        toolCalls: {},
        trace: [],
        phase: null,
        validation: null,
        scenePlan: null,
        lastError: null,
        kitOpen: true,
        nudgeGoal: trimmed,
        nudgeToken: state.nudgeToken + 1,
        events,
      };
    });
  },
  setTool: (tool) => set({ tool }),
  setActiveId: (activeId) => set({ activeId }),
  pushUndo: (entry) =>
    set((state) => ({ undoStack: [...state.undoStack, entry].slice(-UNDO_MAX) })),
  undo: () =>
    set((state) => {
      const entry = state.undoStack.at(-1);
      if (!entry) return state;
      const undoStack = state.undoStack.slice(0, -1);
      const pieces = { ...state.pieces };
      if (entry.t === "place") {
        delete pieces[entry.id];
        return {
          undoStack,
          pieces,
          selection: state.selection.filter((s) => s !== entry.id),
        };
      }
      if (entry.t === "remove") {
        const lotTaken = Object.values(pieces).some((p) => p.lot === entry.piece.lot);
        if (lotTaken) return { undoStack };
        pieces[entry.piece.id] = entry.piece;
        return { undoStack, pieces };
      }
      const prev = pieces[entry.id];
      if (!prev) return { undoStack };
      if (entry.t === "move") {
        const taken = Object.values(pieces).some((p) => p.id !== entry.id && p.lot === entry.prevLot);
        if (taken) return { undoStack };
        pieces[entry.id] = { ...prev, lot: entry.prevLot };
      } else if (entry.t === "flip") {
        pieces[entry.id] = { ...prev, flip: entry.prev };
      } else {
        pieces[entry.id] = { ...prev, label: entry.prev };
      }
      return { undoStack, pieces };
    }),
  setWebmcp: (webmcp) => set({ webmcp }),
  setLastError: (lastError) => set({ lastError }),
}));
