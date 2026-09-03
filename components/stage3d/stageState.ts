"use client";

import { useSyncExternalStore } from "react";
import { worldOf } from "@/lib/composition/grid3d";

/**
 * High-frequency stage state, kept OUTSIDE React.
 *
 * The stage is a rendering system, not a list of draggable elements. Anything
 * that changes many times a second while a person interacts — the camera,
 * the hovered lot, an in-flight move — lives in these tiny stores. Components
 * that genuinely need one of these values subscribe to exactly that value
 * (useSyncExternalStore with a primitive selector), so a pointer crossing a
 * lot re-renders the overlay that draws the hover pad and nothing else. The
 * piece tree never reads any of this.
 *
 * Document state (pieces, environment, selection) stays in the zustand store
 * in lib/store.ts — that is the world the WebMCP tools read and write.
 */

type Listener = () => void;

function createTinyStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(next: T) {
      if (Object.is(next, state)) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

type TinyStore<T> = ReturnType<typeof createTinyStore<T>>;

/** Subscribe to one derived value of a tiny store. The selector must return
 * a primitive or a stable reference — that is what keeps re-renders scoped. */
export function useTiny<T, S>(store: TinyStore<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

// --- Camera ----------------------------------------------------------------

export type CameraState = { tx: number; tz: number; zoom: number; yaw: number };

const HOME = worldOf(12, 12); // M13 — same home center as the 2D board
export const CAMERA = { zoom: 0.85, minZoom: 0.35, maxZoom: 3.2, easeMaxZoom: 1.25, easeMinZoom: 0.55 };
/** Classic isometric azimuth — the default view and the share-card frame. */
export const DEFAULT_YAW = Math.PI / 4;

/**
 * Panning fires per pointermove and the focus ease per animation frame —
 * routing those through setState re-rendered the entire piece tree on every
 * tick. The rig reads this store in useFrame (already per-frame); the
 * dotted-paper sync subscribes directly. Every set also requests a frame,
 * because the renderer sleeps when nothing moves (see renderClock).
 */
export const camStore = {
  state: { tx: HOME.x, tz: HOME.z, zoom: CAMERA.zoom, yaw: DEFAULT_YAW } as CameraState,
  listeners: new Set<Listener>(),
  set(patch: Partial<CameraState>) {
    Object.assign(camStore.state, patch);
    for (const l of camStore.listeners) l();
    renderClock.requestFrame();
  },
  subscribe(l: Listener) {
    camStore.listeners.add(l);
    return () => {
      camStore.listeners.delete(l);
    };
  },
};

// --- Pointer: hovered lot and in-flight move -------------------------------

export type LotCoord = { col: number; row: number };

/** The lot under the pointer, or null off the world. Updated at most once
 * per animation frame, and only when the lot actually changes. */
export const hoverStore = createTinyStore<LotCoord | null>(null);

export function setHover(next: LotCoord | null) {
  const cur = hoverStore.get();
  if (cur === next || (cur && next && cur.col === next.col && cur.row === next.row)) return;
  hoverStore.set(next);
  // Hover only moves the pad and a ghost — a frame, not a shadow pass.
  renderClock.requestFrame();
}

export function useHover(): LotCoord | null {
  return useTiny(hoverStore, (s) => s);
}

export type MoveState = { id: string; fromLot: string };

/** A piece the person is dragging: dimmed in place while a ghost follows the
 * pointer, committed to the store once, on release. */
export const movingStore = createTinyStore<MoveState | null>(null);

export function setMoving(next: MoveState | null) {
  movingStore.set(next);
  // The dragged piece swaps to a translucent clone — shadows change.
  renderClock.markSceneDirty();
}

export function useMoving(): MoveState | null {
  return useTiny(movingStore, (s) => s);
}

/** Per-piece: only the piece whose move starts or ends re-renders. */
export function useIsMoving(id: string): boolean {
  return useTiny(movingStore, (s) => s?.id === id);
}

export function useMovingId(): string | null {
  return useTiny(movingStore, (s) => s?.id ?? null);
}

// --- Render clock: the renderer sleeps unless something is worth drawing ---

/**
 * The Canvas runs with frameloop="demand": nothing is drawn unless a frame
 * is requested. Camera and hover changes request a plain frame. Anything
 * that changes what casts shadows (a piece arriving, moving, landing) marks
 * the scene dirty so the next frame also refreshes the shadow map — the
 * map is otherwise frozen (gl.shadowMap.autoUpdate = false), which halves
 * the draw calls of every pan/zoom frame.
 *
 * Animations call `animating()` from their useFrame while unsettled: that
 * schedules the following frame and keeps the shadow map live for it.
 */
export const renderClock = {
  /** Installed by the FrameDriver inside the Canvas. */
  invalidate: null as (() => void) | null,
  /** The renderer whose shadow map is gated. three.js clears
   * `shadowMap.needsUpdate` itself after the shadow pass runs. */
  gl: null as { shadowMap: { needsUpdate: boolean } } | null,
  /** Frames rendered — `?perf` HUD only. */
  frames: 0,
  attach(gl: { shadowMap: { needsUpdate: boolean } } | null) {
    renderClock.gl = gl;
  },
  /** A frame that shows the same world from a different view, or with a
   * different overlay: no shadow pass. */
  requestFrame() {
    renderClock.invalidate?.();
  },
  /** Something that casts a shadow changed: the next frame refreshes the
   * shadow map too. */
  markSceneDirty() {
    if (renderClock.gl) renderClock.gl.shadowMap.needsUpdate = true;
    renderClock.invalidate?.();
  },
  /** From an animation's useFrame while it is still moving: keep the loop
   * alive for one more frame, shadows included. */
  animating() {
    renderClock.markSceneDirty();
  },
};

// --- Picking: registered by the stage, used by the wrapper's DOM handlers --

export type StagePicker = {
  /** Lot under a client point, on whatever surface stands there. */
  lotAt: (clientX: number, clientY: number) => LotCoord | null;
  /** Piece id whose model is under a client point — one raycast, on click only. */
  pieceAt: (clientX: number, clientY: number) => string | null;
};

let picker: StagePicker | null = null;

export function registerStagePicker(next: StagePicker | null) {
  picker = next;
}

export function stagePicker(): StagePicker | null {
  return picker;
}

// --- Dev counters (`?perf` HUD): who re-rendered, how often ----------------

/** Incremented in render bodies (dev only) so the HUD can prove that a
 * hover, a pan, or one piece moving does not re-render the piece tree. */
export const perfCounters = {
  rootRenders: 0,
  pieceLayerRenders: 0,
  pieceNodeRenders: 0,
  instancedGroupRenders: 0,
  instancedWrites: 0,
  overlayRenders: 0,
  environmentRenders: 0,
  groundRebuilds: 0,
  rubbleUpdates: 0,
};

export function countRender(key: keyof typeof perfCounters) {
  if (process.env.NODE_ENV === "production") return;
  perfCounters[key] += 1;
}
