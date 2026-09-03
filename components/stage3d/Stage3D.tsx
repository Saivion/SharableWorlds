"use client";

import { ContactShadows, Environment, Html, Lightformer } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Component,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import * as THREE from "three";
import { catalogItem, type CatalogItem } from "@/lib/catalog";
import { autoGroundPads } from "@/lib/composition/autoEnv";
import { DECK_BLOCK, PLINTH_DEPTH, TILE, worldOf, type LotRect } from "@/lib/composition/grid3d";
import { environmentBounds, reservedLots, surfaceAt } from "@/lib/composition/surface";
import type { EnvironmentSpec } from "@/lib/composition/types";
import { snapLotCoord } from "@/lib/iso";
import { registerLotProjector } from "@/lib/stageProjection";
import { registerSnapshot } from "@/lib/stageSnapshot";
import { useTown } from "@/lib/store";
import type { Piece } from "@/lib/types";
import { humanFlip, humanMove, humanPlace, lotId, occupancyMap, parseLot } from "@/lib/town";
import { Environment3D } from "./Environment3D";
import { InstancedPieces, type InstancedEntry } from "./InstancedPieces";
import { PieceArrive } from "./legoDrop";
import { ModelPiece } from "./ModelPiece";
import {
  CAMERA,
  DEFAULT_YAW,
  camStore,
  countRender,
  hoverStore,
  movingStore,
  perfCounters,
  registerStagePicker,
  renderClock,
  setHover,
  setMoving,
  stagePicker,
  useHover,
  useIsMoving,
  useMoving,
  useMovingId,
  type CameraState,
  type LotCoord,
} from "./stageState";
import { blockLift, GROUND_SUB } from "./terrainLook";

/**
 * The diorama stage — an orthographic miniature the whole scene is composed
 * for. Same contract as ever: the same store, the same lot addressing, the
 * same tools, the same interactions (click-to-place, drag-to-move, F to
 * flip, pan/zoom, orbit), the same screen-space hooks the agent cursor relies on.
 *
 * Rendering architecture (the part that scales to a thousand pieces):
 *
 *   DOCUMENT MODEL (zustand: pieces, environment, selection)
 *     ↓ subscribed per layer, never at the root for hot values
 *   PieceLayer      — memoized PieceNode per piece + stable instanced groups
 *   Environment3D   — the architecture, memoized on the environment
 *   OverlayLayer    — pads, labels, ghosts: the only thing hover re-renders
 *     ↓
 *   Three.js scene, drawn on demand (frameloop="demand")
 *
 * Interaction state (camera, hovered lot, in-flight move) lives outside
 * React in ./stageState. Pointer events are handled ONCE on the wrapper
 * with analytic lot picking — no per-piece event handlers, so React Three
 * Fiber never raycasts the scene on pointermove. One raycast on click
 * picks a model precisely.
 */

// Camera framing. Elevation stays isometric; yaw orbits the diorama.
const EL = Math.atan(1 / Math.SQRT2); // elevation ≈ 35.26°
const CAM_DIST = 90;
const BASE_VIEW_W = 46; // world units across the viewport at zoom 1
const ORBIT_RAD_PER_PX = 0.007;

/** A catalog id repeated this often collapses into an instanced group. */
const INSTANCE_MIN = 3;

const SIN_EL = Math.sin(EL);
const COS_EL = Math.cos(EL);

function yawTrig(yaw: number) {
  return { sin: Math.sin(yaw), cos: Math.cos(yaw) };
}

const HOME = worldOf(12, 12); // M13 — same home center as the 2D board

const DOT_PERIOD = 20; // px — the paper's dot pitch (app/globals.css)

function zoomPx(viewportW: number, zoom: number) {
  return (viewportW / BASE_VIEW_W) * zoom;
}

/** Lot-space extent of everything built: the environment footprint plus
 * any piece standing outside it. Null when the world is empty. */
function worldExtent(state: ReturnType<typeof useTown.getState>) {
  const bounds = environmentBounds(state.environment);
  let minC = bounds ? bounds.c0 : Infinity;
  let maxC = bounds ? bounds.c0 + bounds.w - 1 : -Infinity;
  let minR = bounds ? bounds.r0 : Infinity;
  let maxR = bounds ? bounds.r0 + bounds.d - 1 : -Infinity;
  for (const piece of Object.values(state.pieces)) {
    const l = parseLot(piece.lot);
    if (!l) continue;
    minC = Math.min(minC, l.col);
    maxC = Math.max(maxC, l.col);
    minR = Math.min(minR, l.row);
    maxR = Math.max(maxR, l.row);
  }
  if (!Number.isFinite(minC)) return null;
  return { minC, maxC, minR, maxR };
}

/** Puts an orthographic camera on the iso rail, aimed at (tx, 0, tz). */
function placeOnRail(cam: THREE.OrthographicCamera, tx: number, tz: number, yaw = DEFAULT_YAW) {
  const { sin, cos } = yawTrig(yaw);
  cam.position.set(tx + CAM_DIST * sin * COS_EL, CAM_DIST * SIN_EL, tz + CAM_DIST * cos * COS_EL);
  cam.lookAt(tx, 0, tz);
}

/**
 * A camera that frames the whole world regardless of where the person has
 * panned or zoomed: same iso angle, centered on the world, zoomed out until
 * every corner of its bounding box (floor of the plinth to the tallest
 * tower) projects inside the viewport. The sticker crops to painted pixels
 * afterwards, so generous headroom costs nothing.
 */
function framingCamera(base: THREE.OrthographicCamera, viewportW: number, extent: NonNullable<ReturnType<typeof worldExtent>>) {
  const cam = base.clone();
  const cx = ((extent.minC + extent.maxC) / 2) * TILE;
  const cz = ((extent.minR + extent.maxR) / 2) * TILE;
  placeOnRail(cam, cx, cz);
  cam.zoom = zoomPx(Math.max(1, viewportW), 1);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  const x0 = (extent.minC - 1.5) * TILE, x1 = (extent.maxC + 1.5) * TILE;
  const z0 = (extent.minR - 1.5) * TILE, z1 = (extent.maxR + 1.5) * TILE;
  const y0 = -PLINTH_DEPTH - 0.5, y1 = 10;
  const v = new THREE.Vector3();
  let reach = 0;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
    v.set(x, y, z).project(cam);
    reach = Math.max(reach, Math.abs(v.x), Math.abs(v.y));
  }
  // Orthographic projection scales linearly with zoom: shrink until the
  // farthest corner sits at 92% of the half-viewport.
  if (reach > 0) cam.zoom *= 0.92 / reach;
  cam.updateProjectionMatrix();
  return cam;
}

type SurfaceY = (col: number, row: number) => number;

/** Keeps the default orthographic camera on the iso rail and registers the
 * lot → screen projector the agent cursor uses. */
function CameraRig({ surfaceYAt }: { surfaceYAt: SurfaceY }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __stage3d?: { scene: THREE.Scene; camera: THREE.Camera; gl: THREE.WebGLRenderer; pick: typeof stagePicker } }).__stage3d = { scene, camera, gl, pick: stagePicker };
  }, [scene, camera, gl]);

  // Applied every rendered frame — immune to mount-order races between R3F's
  // own camera management and React effects. Mutating the camera in useFrame
  // is the idiomatic R3F pattern; the immutability lint rule predates it.
  /* eslint-disable react-hooks/immutability */
  useFrame(() => {
    const cam = camStore.state;
    const ortho = camera as THREE.OrthographicCamera;
    placeOnRail(ortho, cam.tx, cam.tz, cam.yaw ?? DEFAULT_YAW);
    ortho.zoom = Math.max(0.0001, zoomPx(Math.max(1, size.width), cam.zoom));
    ortho.near = -400;
    ortho.far = 800;
    ortho.updateProjectionMatrix();
  });
  /* eslint-enable react-hooks/immutability */

  useEffect(() => {
    const project = (lot: string) => {
      const parsed = parseLot(lot);
      if (!parsed) return null;
      const { x, z } = worldOf(parsed.col, parsed.row);
      const v = new THREE.Vector3(x, surfaceYAt(parsed.col, parsed.row) + 0.4, z);
      v.project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return {
        x: rect.left + ((v.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v.y) / 2) * rect.height,
      };
    };
    registerLotProjector(project);
    // The share sticker asks for a fresh frame of the WHOLE world — rendered
    // through a camera that frames it, not the person's current pan/zoom —
    // then hands over the canvas. The next animation frame repaints the
    // live view, so nothing of this shows on screen.
    registerSnapshot(() => {
      const extent = worldExtent(useTown.getState());
      const cam = extent ? framingCamera(camera as THREE.OrthographicCamera, size.width, extent) : camera;
      gl.shadowMap.needsUpdate = true;
      gl.render(scene, cam);
      renderClock.markSceneDirty();
      return gl.domElement;
    });
    return () => {
      registerLotProjector(null);
      registerSnapshot(null);
    };
  }, [camera, gl, scene, size.width, surfaceYAt]);

  return null;
}

/**
 * Installs the render clock: the Canvas draws only when asked (camera,
 * hover, a store change, an animation frame), and the shadow map refreshes
 * only when something that casts a shadow changed. A static diorama costs
 * zero frames; a pan costs the main pass alone.
 */
function FrameDriver() {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    renderClock.invalidate = () => invalidate();
    renderClock.attach(gl);
    renderClock.markSceneDirty();
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __stagePerf?: typeof perfCounters }).__stagePerf = perfCounters;
    }
    return () => {
      renderClock.invalidate = null;
      renderClock.attach(null);
    };
  }, [invalidate, gl]);

  // Every document change can cast new shadows: a piece placed, moved,
  // removed, flipped; ground grown; the agent's ghost appearing.
  useEffect(
    () =>
      useTown.subscribe((s, prev) => {
        if (s.pieces !== prev.pieces || s.environment !== prev.environment || s.agentGhost !== prev.agentGhost || s.selection !== prev.selection) {
          renderClock.markSceneDirty();
        }
      }),
    [],
  );

  useFrame(() => {
    renderClock.frames += 1;
  });

  return null;
}

/**
 * Picking without per-object event handlers. The wrapper's DOM handlers
 * ask this for the lot under the pointer (a ray/plane intersection refined
 * onto the surface standing there — a raised deck projects to a different
 * ground lot) and, on click only, for the model under the pointer (one
 * raycast against the piece layer, resolved to a piece id through userData).
 */
function Picker({ surfaceYAt, pieceRoot }: { surfaceYAt: SurfaceY; pieceRoot: RefObject<THREE.Group | null> }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const setRay = (clientX: number, clientY: number) => {
      const r = gl.domElement.getBoundingClientRect();
      ndc.set(((clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -((clientY - r.top) / Math.max(1, r.height)) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
    };
    const lotOnPlane = (y: number): LotCoord | null => {
      plane.constant = -y;
      if (!raycaster.ray.intersectPlane(plane, hit)) return null;
      return { col: snapLotCoord(hit.x / TILE), row: snapLotCoord(hit.z / TILE) };
    };
    registerStagePicker({
      lotAt(clientX, clientY) {
        setRay(clientX, clientY);
        let lot = lotOnPlane(0);
        if (!lot) return null;
        for (let i = 0; i < 2; i += 1) {
          const next = lotOnPlane(surfaceYAt(lot.col, lot.row));
          if (!next || (next.col === lot.col && next.row === lot.row)) break;
          lot = next;
        }
        return lot;
      },
      pieceAt(clientX, clientY) {
        const root = pieceRoot.current;
        if (!root) return null;
        setRay(clientX, clientY);
        // A piece committed since the last drawn frame has no world matrix
        // yet (frames are on demand) — refresh before intersecting.
        root.updateMatrixWorld(true);
        const hits = raycaster.intersectObjects(root.children, true);
        for (const h of hits) {
          if (h.instanceId != null) {
            const ids = h.object.userData.pieceIds as string[] | undefined;
            const id = ids?.[h.instanceId];
            if (id) return id;
            continue;
          }
          let o: THREE.Object3D | null = h.object;
          while (o && o !== root) {
            const id = o.userData.pieceId;
            if (typeof id === "string") return id;
            o = o.parent;
          }
        }
        return null;
      },
    });
    return () => registerStagePicker(null);
  }, [camera, gl, surfaceYAt, pieceRoot]);

  return null;
}

/** Key + fill + sky, with the shadow camera fitted to the scene bounds. */
function Lights({ center, extent }: { center: { x: number; z: number }; extent: number }) {
  const key = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    const light = key.current;
    if (!light) return;
    const span = Math.max(18, extent * 0.72);
    light.shadow.camera.left = -span;
    light.shadow.camera.right = span;
    light.shadow.camera.top = span;
    light.shadow.camera.bottom = -span;
    light.shadow.camera.updateProjectionMatrix();
    renderClock.markSceneDirty();
  }, [extent]);
  return (
    <>
      <hemisphereLight args={["#d4e2f4", "#5a5244", 0.85]} />
      <ambientLight intensity={0.22} color="#e8eef8" />
      <directionalLight
        ref={key}
        castShadow
        color="#ffe9cc"
        intensity={1.85}
        position={[center.x + 16, 26, center.z + 8]}
        target-position={[center.x, 0, center.z]}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.00025}
        shadow-normalBias={0.035}
        shadow-radius={6}
      />
      <directionalLight color="#9eb6dc" intensity={0.42} position={[center.x - 14, 10, center.z - 18]} />
    </>
  );
}

/** Developer overlay (`?perf`): renderer stats and React commit counters
 * written straight into a DOM node on a timer — no React state, no frame
 * requests, so the probe never wakes the renderer it observes. */
const PERF_HUD_ID = "stage3d-perf-hud";

function PerfProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    let lastFrames = renderClock.frames;
    let lastT = performance.now();
    const tick = () => {
      const el = document.getElementById(PERF_HUD_ID);
      if (!el) return;
      const now = performance.now();
      const fps = ((renderClock.frames - lastFrames) * 1000) / Math.max(1, now - lastT);
      lastFrames = renderClock.frames;
      lastT = now;
      let meshes = 0;
      let instanced = 0;
      let instances = 0;
      scene.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) {
          instanced += 1;
          instances += (o as THREE.InstancedMesh).count;
        } else if ((o as THREE.Mesh).isMesh) meshes += 1;
      });
      const info = gl.info;
      const c = perfCounters;
      el.textContent =
        `${fps.toFixed(0)} fps (on demand) · ${info.render.calls} calls · ` +
        `${(info.render.triangles / 1000).toFixed(1)}k tris · ` +
        `${meshes} mesh · ${instanced} imesh (${instances} inst) · ` +
        `${info.memory.geometries} geo · ${info.memory.textures} tex · ${info.programs?.length ?? 0} prog · ` +
        `renders root ${c.rootRenders} / layer ${c.pieceLayerRenders} / node ${c.pieceNodeRenders} / inst ${c.instancedGroupRenders} (${c.instancedWrites} writes) / overlay ${c.overlayRenders} / env ${c.environmentRenders} (ground ${c.groundRebuilds}, rubble ${c.rubbleUpdates})`;
    };
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [gl, scene]);
  return null;
}

/** One failed model must never take the whole canvas down with it. */
class PieceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Soft rounded pad under a hovered / selected / ghosted lot — same quiet
 * ink wash the 2D stage used on the paper background. */
function LotPad({ col, row, y, strong = false }: { col: number; row: number; y: number; strong?: boolean }) {
  const { x, z } = worldOf(col, row);
  return (
    <mesh position={[x, y + 0.03, z]} rotation-x={-Math.PI / 2}>
      <circleGeometry args={[TILE * 0.55, 40]} />
      <meshBasicMaterial color="#0a0a0a" transparent opacity={strong ? 0.14 : 0.08} depthWrite={false} />
    </mesh>
  );
}

// --- Piece layer -----------------------------------------------------------

type InstanceGroup = { item: CatalogItem; entries: InstancedEntry[] };

function sameEntry(a: InstancedEntry, b: InstancedEntry) {
  return a.id === b.id && a.x === b.x && a.y === b.y && a.z === b.z && a.rot === b.rot;
}

/**
 * Repeated static models render as instances — one draw call per sub-mesh
 * for the whole group instead of one per piece. Characters/pets (rigged),
 * flipped pieces (a mirrored instance matrix has a negative determinant,
 * which inverts instanced normals and renders the model black), and the
 * piece being moved (needs the translucent clone) stay per-piece.
 *
 * Groups are STABLE: a group whose members did not change keeps its previous
 * `entries` array, so placing one lantern rewrites the lantern group's
 * instance buffer and leaves the other forty groups untouched.
 */
function useStableInstanceGroups(pieces: Record<string, Piece>, movingId: string | null, surfaceYAt: SurfaceY, disabled: boolean): InstanceGroup[] {
  const prev = useRef(new Map<string, InstanceGroup>());
  return useMemo(() => {
    // The previous groups are a cache keyed by this memo's own inputs — read
    // and replaced here on purpose. It is never read during render anywhere
    // else, which is what the React Compiler's ref rule guards against.
    const cache = prev.current;
    if (disabled) {
      // eslint-disable-next-line react-hooks/refs
      prev.current = new Map();
      return [];
    }
    const by = new Map<string, InstanceGroup>();
    for (const piece of Object.values(pieces)) {
      if (piece.id === movingId || piece.flip) continue;
      const item = catalogItem(piece.catalogId);
      if (!item?.model || item.kind === "character" || item.kind === "pet") continue;
      const parsed = parseLot(piece.lot);
      if (!parsed) continue;
      const { x, z } = worldOf(parsed.col, parsed.row);
      const entry: InstancedEntry = {
        id: piece.id,
        col: parsed.col,
        row: parsed.row,
        x,
        y: surfaceYAt(parsed.col, parsed.row),
        z,
        rot: piece.rot ?? 0,
      };
      const group = by.get(piece.catalogId);
      if (group) group.entries.push(entry);
      else by.set(piece.catalogId, { item, entries: [entry] });
    }
    const next = new Map<string, InstanceGroup>();
    const out: InstanceGroup[] = [];
    for (const [catalogId, group] of by) {
      if (group.entries.length < INSTANCE_MIN) continue;
      // eslint-disable-next-line react-hooks/refs
      const old = cache.get(catalogId);
      const unchanged = old != null && old.entries.length === group.entries.length && old.entries.every((e, i) => sameEntry(e, group.entries[i]));
      const kept = unchanged ? old : group;
      next.set(catalogId, kept);
      out.push(kept);
    }
    // eslint-disable-next-line react-hooks/refs
    prev.current = next;
    return out;
  }, [pieces, movingId, surfaceYAt, disabled]);
}

/** One placed model. Memoized on its piece object (zustand keeps untouched
 * pieces referentially identical across updates) — a change to piece #42
 * re-renders piece #42. */
const PieceNode = memo(function PieceNode({ piece, surfaceYAt }: { piece: Piece; surfaceYAt: SurfaceY }) {
  countRender("pieceNodeRenders");
  const isMoving = useIsMoving(piece.id);
  const parsed = parseLot(piece.lot);
  const item = catalogItem(piece.catalogId);
  if (!parsed || !item?.model) return null;
  const { x, z } = worldOf(parsed.col, parsed.row);
  const y = surfaceYAt(parsed.col, parsed.row);
  return (
    <PieceArrive col={parsed.col} row={parsed.row}>
      {(snapping) => (
        <PieceBoundary>
          <Suspense fallback={null}>
            <ModelPiece pieceId={piece.id} item={item} position={[x, y, z]} flip={piece.flip} rot={piece.rot} dim={isMoving} grow={!snapping} />
          </Suspense>
        </PieceBoundary>
      )}
    </PieceArrive>
  );
});

/** Every placed model: instanced groups first, then the per-piece rest.
 * Subscribes to `pieces` itself so the stage root never has to. */
const PieceLayer = memo(function PieceLayer({ surfaceYAt, rootRef }: { surfaceYAt: SurfaceY; rootRef: RefObject<THREE.Group | null> }) {
  countRender("pieceLayerRenders");
  const pieces = useTown((s) => s.pieces);
  const movingId = useMovingId();
  const noInstancing = useSyncExternalStore(
    () => () => {},
    () => window.location.search.includes("noinst"),
    () => false,
  );
  const groups = useStableInstanceGroups(pieces, movingId, surfaceYAt, noInstancing);
  const instancedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups) for (const e of g.entries) ids.add(e.id);
    return ids;
  }, [groups]);

  return (
    <group ref={rootRef}>
      {groups.map((g) => (
        <PieceBoundary key={`inst-${g.item.id}`}>
          <Suspense fallback={null}>
            <InstancedPieces item={g.item} entries={g.entries} />
          </Suspense>
        </PieceBoundary>
      ))}
      {Object.values(pieces).map((piece) => (instancedIds.has(piece.id) ? null : <PieceNode key={piece.id} piece={piece} surfaceYAt={surfaceYAt} />))}
    </group>
  );
});

// --- Overlay layer ---------------------------------------------------------

/**
 * Pads, labels and ghosts. This is the ONLY component that subscribes to
 * the hovered lot, the selection and the in-flight move — a pointer
 * crossing lots re-renders a handful of small meshes, never a model.
 */
const OverlayLayer = memo(function OverlayLayer({
  surfaceYAt,
  environment,
  autoPads,
  reserved,
  handMode,
  debug,
}: {
  surfaceYAt: SurfaceY;
  environment: EnvironmentSpec | null;
  autoPads: LotRect[];
  reserved: Set<string>;
  handMode: boolean;
  debug: boolean;
}) {
  countRender("overlayRenders");
  const pieces = useTown((s) => s.pieces);
  const selection = useTown((s) => s.selection);
  const agentGhost = useTown((s) => s.agentGhost);
  const tool = useTown((s) => s.tool);
  const activeId = useTown((s) => s.activeId);
  const hover = useHover();
  const moving = useMoving();

  // occupancyMap reads the store itself — `pieces` is its invalidation key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const occ = useMemo(() => occupancyMap(), [pieces]);

  const placing = tool === "place" && activeId != null;
  const hoverLot = hover ? lotId(hover.col, hover.row) : null;
  const hoverPiece = hoverLot ? occ.get(hoverLot) : undefined;
  // A preview only where a piece can actually stand: the architecture, a
  // freeform pad, or water for a vessel. Off the foundation the pointer
  // shows nothing — a ghost hanging in the void reads as a placed piece.
  const standable = (col: number, row: number, item: CatalogItem | undefined) => {
    if (!environment) return true;
    const s = surfaceAt(environment, col, row);
    if (s.kind === "platform") return true;
    if (s.kind === "water") return item?.kind === "boat" || item?.kind === "pirate";
    return autoPads.some((p) => col >= p.c0 && col < p.c0 + p.w && row >= p.r0 && row < p.r0 + p.d);
  };
  const hoverEmpty = Boolean(hoverLot && !reserved.has(hoverLot) && (!hoverPiece || hoverPiece.id === moving?.id));
  const movingPiece = moving ? pieces[moving.id] : undefined;
  const ghostParsed = agentGhost ? parseLot(agentGhost.lot) : null;

  const marked: { piece: Piece; strong: boolean }[] = [];
  for (const id of selection) {
    const piece = pieces[id];
    if (piece) marked.push({ piece, strong: true });
  }
  if (hoverPiece && !selection.includes(hoverPiece.id)) marked.push({ piece: hoverPiece, strong: false });

  return (
    <>
      {marked.map(({ piece, strong }) => {
        const parsed = parseLot(piece.lot);
        if (!parsed) return null;
        const { x, z } = worldOf(parsed.col, parsed.row);
        const y = surfaceYAt(parsed.col, parsed.row);
        return (
          <group key={`mark-${piece.id}`}>
            <LotPad col={parsed.col} row={parsed.row} y={y} strong={strong} />
            {piece.label !== "" && (
              <Html position={[x, y + 2.4, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
                <div className="iso-tag3d">{piece.label}</div>
              </Html>
            )}
          </group>
        );
      })}

      {debug &&
        Object.values(pieces).map((piece) => {
          const parsed = parseLot(piece.lot);
          if (!parsed) return null;
          const { x, z } = worldOf(parsed.col, parsed.row);
          return (
            <Html key={`dbg-${piece.id}`} position={[x, surfaceYAt(parsed.col, parsed.row) + 0.1, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
              <div className="iso-debug3d">{piece.lot}</div>
            </Html>
          );
        })}

      {/* Ghost while the agent writes */}
      {agentGhost && ghostParsed && !occ.has(agentGhost.lot) && (() => {
        const item = catalogItem(agentGhost.catalogId);
        if (!item?.model) return null;
        const { x, z } = worldOf(ghostParsed.col, ghostParsed.row);
        const y = surfaceYAt(ghostParsed.col, ghostParsed.row);
        return (
          <group>
            <LotPad col={ghostParsed.col} row={ghostParsed.row} y={y} />
            <PieceBoundary><Suspense fallback={null}>
              <ModelPiece item={item} position={[x, y, z]} ghost />
            </Suspense></PieceBoundary>
          </group>
        );
      })()}

      {/* Placement ghost under the cursor */}
      {hover && hoverEmpty && !handMode && placing && activeId && !moving && (() => {
        const item = catalogItem(activeId);
        if (!item?.model || !standable(hover.col, hover.row, item)) return null;
        const { x, z } = worldOf(hover.col, hover.row);
        const y = surfaceYAt(hover.col, hover.row);
        return (
          <group>
            <LotPad col={hover.col} row={hover.row} y={y} strong />
            <PieceBoundary><Suspense fallback={null}>
              <ModelPiece item={item} position={[x, y, z]} ghost />
            </Suspense></PieceBoundary>
          </group>
        );
      })()}

      {/* Move ghost follows the pointer */}
      {moving && movingPiece && hover && hoverEmpty && hoverLot !== moving.fromLot && (() => {
        const item = catalogItem(movingPiece.catalogId);
        if (!item?.model || !standable(hover.col, hover.row, item)) return null;
        const { x, z } = worldOf(hover.col, hover.row);
        const y = surfaceYAt(hover.col, hover.row);
        return (
          <group>
            <LotPad col={hover.col} row={hover.row} y={y} strong />
            <PieceBoundary><Suspense fallback={null}>
              <ModelPiece item={item} position={[x, y, z]} flip={movingPiece.flip} rot={movingPiece.rot} ghost />
            </Suspense></PieceBoundary>
          </group>
        );
      })()}
    </>
  );
});

// --- Stage root ------------------------------------------------------------

export function Stage3D() {
  countRender("rootRenders");
  // Document-level inputs only. Hover, selection and the in-flight move are
  // read by the layers that draw them — never here, where a re-render would
  // reconcile the whole canvas.
  const pieces = useTown((s) => s.pieces);
  const environment = useTown((s) => s.environment);
  const tool = useTown((s) => s.tool);
  const activeId = useTown((s) => s.activeId);
  const focusToken = useTown((s) => s.focusToken);

  const [spaceDown, setSpaceDown] = useState(false);
  const [rotateDown, setRotateDown] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const pieceRoot = useRef<THREE.Group>(null);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const orbitRef = useRef<{ pointerId: number; lastX: number } | null>(null);
  // A press on a piece ARMS a move; it becomes one (dimmed piece, ghost
  // under the pointer) only once the pointer travels — a plain click never
  // touches the piece tree.
  const moveRef = useRef<{ pointerId: number; id: string; fromLot: string; startX: number; startY: number; active: boolean } | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, pending: false });
  const camAnim = useRef<number | null>(null);

  const debug = useSyncExternalStore(
    () => () => {},
    () => window.location.search.includes("debug"),
    () => false,
  );
  const perf = useSyncExternalStore(
    () => () => {},
    () => window.location.search.includes("perf"),
    () => false,
  );

  const handMode = tool === "hand" || spaceDown;
  const orbitMode = tool === "orbit" || rotateDown;
  const placing = tool === "place" && activeId != null;
  const canMove = tool === "select" && !handMode && !orbitMode;

  // Keep the studio's dotted paper world-locked, the way the 2D stage panned
  // it: the dots anchor to the world origin and travel with it. The pattern
  // is periodic, so the offset is taken modulo one period. Subscribes to the
  // camera store directly — no React render in the loop. (The dots stay a
  // plain background on the page: a separate compositor layer under the
  // WebGL canvas is one more thing for a browser to get wrong.)
  useEffect(() => {
    const main = document.querySelector("main.studio");
    if (!(main instanceof HTMLElement)) return;
    const sync = () => {
      const w = wrapRef.current?.clientWidth ?? 1;
      const h = wrapRef.current?.clientHeight ?? 1;
      const px = zoomPx(w, camStore.state.zoom);
      const { tx, tz, yaw } = camStore.state;
      const { sin, cos } = yawTrig(yaw ?? DEFAULT_YAW);
      const dx = (-tx * cos + tz * sin) * px;
      const dy = -(tx * sin + tz * cos) * SIN_EL * px;
      const ox = w / 2 + dx;
      const oy = h / 2 + dy;
      const mx = ((ox % DOT_PERIOD) + DOT_PERIOD) % DOT_PERIOD;
      const my = ((oy % DOT_PERIOD) + DOT_PERIOD) % DOT_PERIOD;
      main.style.backgroundPosition = `${mx.toFixed(2)}px ${my.toFixed(2)}px`;
    };
    sync();
    const unsub = camStore.subscribe(sync);
    window.addEventListener("resize", sync);
    return () => {
      unsub();
      window.removeEventListener("resize", sync);
    };
  }, []);

  // Derived geometry. Cheap (one pass over the pieces) and, above all,
  // STABLE: `surfaceYAt` only changes identity when the ground it describes
  // changes, so the layers below it do not re-render per placement.
  const reserved = useMemo(() => reservedLots(environment), [environment]);
  const autoPadsRaw = useMemo(() => autoGroundPads(pieces, environment), [pieces, environment]);
  const autoPadsKey = autoPadsRaw.map((p) => `${p.c0}:${p.r0}:${p.w}x${p.d}`).join("|");
  // Keyed on the pads' shape, not the array: a placement that changes no pad
  // keeps the previous array, and everything memoized on it stays put.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const autoPads = useMemo(() => autoPadsRaw, [autoPadsKey]);
  // Lots with a piece on them: the ground's rubble gives way there. Kept
  // referentially stable while its members are unchanged (a flip, a label,
  // a rotation) so the architecture layer does not re-render for them.
  const occupiedKey = useMemo(
    () =>
      Object.values(pieces)
        .map((p) => p.lot)
        .sort()
        .join("|"),
    [pieces],
  );
  // The set is a pure function of the lot list (its key), so keying the
  // memo on that string is exact — and keeps the identity when it matches.
  const occupiedCells = useMemo(() => {
    const set = new Set<string>();
    for (const lot of occupiedKey ? occupiedKey.split("|") : []) {
      const at = parseLot(lot);
      if (at) set.add(`${at.col}:${at.row}`);
    }
    return set;
  }, [occupiedKey]);
  // The height a piece stands at: the engine's surface, plus the tallest of
  // the lot's four ground bricks (the floor is jagged on purpose — a piece
  // must not sink into a raised brick), and the deck of a freeform pad when
  // the lot is off the architecture.
  const surfaceYAt = useMemo<SurfaceY>(
    () => (col: number, row: number) => {
      const s = surfaceAt(environment, col, row);
      if (s.kind === "water") return s.y;
      const onPad = s.kind === "ground" && autoPads.some((p) => col >= p.c0 && col < p.c0 + p.w && row >= p.r0 && row < p.r0 + p.d);
      const base = s.kind === "ground" ? (onPad ? DECK_BLOCK : s.y) : s.y;
      if (s.kind === "ground" && !onPad) return base;
      let lift = 0;
      for (let sz = 0; sz < GROUND_SUB; sz += 1) for (let sx = 0; sx < GROUND_SUB; sx += 1) lift = Math.max(lift, blockLift(col * GROUND_SUB + sx, row * GROUND_SUB + sz));
      return base + lift;
    },
    [environment, autoPads],
  );

  // Occupancy for the pointer handlers — read from a ref so the handlers
  // themselves never have to be recreated.
  const occRef = useRef<Map<string, Piece>>(new Map());
  useEffect(() => {
    occRef.current = occupancyMap();
  }, [pieces]);
  const reservedRef = useRef(reserved);
  useEffect(() => {
    reservedRef.current = reserved;
  }, [reserved]);

  // Cursor grammar, applied to the wrapper's class list imperatively: the
  // hovered piece changes many times a second and must not render the root.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => {
      const hover = hoverStore.get();
      const moving = movingStore.get();
      const hoverPiece = hover ? occRef.current.get(lotId(hover.col, hover.row)) : undefined;
      el.classList.toggle("stage--pan", handMode);
      el.classList.toggle("stage--orbit", orbitMode);
      el.classList.toggle("stage--moving", moving != null);
      el.classList.toggle("stage--move", !moving && canMove && hoverPiece != null);
    };
    sync();
    const a = hoverStore.subscribe(sync);
    const b = movingStore.subscribe(sync);
    return () => {
      a();
      b();
    };
  }, [handMode, orbitMode, canMove, pieces]);

  // Keyboard: Space pans, R orbits, F flips the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceDown(e.type === "keydown");
      }
      if (e.code === "KeyR") {
        e.preventDefault();
        setRotateDown(e.type === "keydown");
      }
      if (e.type === "keydown" && e.key.toLowerCase() === "f") {
        const id = useTown.getState().selection[0];
        const selected = id ? useTown.getState().pieces[id] : undefined;
        if (!selected) return;
        e.preventDefault();
        humanFlip(selected.id);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  // Ease the camera to frame the scene when a build lands.
  useEffect(() => {
    if (focusToken === 0) return;
    const extent = worldExtent(useTown.getState());
    if (!extent) return;
    const { minC, maxC, minR, maxR } = extent;
    const cx = ((minC + maxC) / 2) * TILE;
    const cz = ((minR + maxR) / 2) * TILE + TILE; // bias down — leaves headroom above
    const spanW = (maxC - minC + 6) * TILE;
    const spanD = (maxR - minR + 6) * TILE;
    // Screen-projected width of the diorama ≈ (w + d) / sqrt(2) for a 45° view.
    const projected = (spanW + spanD) / Math.SQRT2;
    const zoom = Math.min(CAMERA.easeMaxZoom, Math.max(CAMERA.easeMinZoom, BASE_VIEW_W / Math.max(projected, 12)));
    // The kit palette floats over the left edge — nudge the frame so the
    // composition centers in the clear area to its right.
    const shift = 0.07 * (BASE_VIEW_W / zoom);
    const yaw = camStore.state.yaw ?? DEFAULT_YAW;
    const { sin, cos } = yawTrig(yaw);
    const target: CameraState = {
      tx: cx - shift * cos,
      tz: cz + shift * sin,
      zoom,
      yaw,
    };
    const from = { ...camStore.state, yaw: camStore.state.yaw ?? DEFAULT_YAW };
    const start = performance.now();
    const DURATION = 900;
    if (camAnim.current) cancelAnimationFrame(camAnim.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      camStore.set({
        tx: from.tx + (target.tx - from.tx) * e,
        tz: from.tz + (target.tz - from.tz) * e,
        zoom: from.zoom + (target.zoom - from.zoom) * e,
        yaw: from.yaw + (target.yaw - from.yaw) * e,
      });
      if (t < 1) camAnim.current = requestAnimationFrame(step);
    };
    camAnim.current = requestAnimationFrame(step);
    return () => {
      if (camAnim.current) cancelAnimationFrame(camAnim.current);
    };
  }, [focusToken]);

  // --- Wrapper-level pointer handling ---------------------------------------
  // Hover is resolved at most once per animation frame from the latest
  // pointer position: pointermove stores coordinates, the frame does the
  // (tiny) math, and only a CHANGE of lot reaches the overlay.
  const scheduleHover = () => {
    const p = pointerRef.current;
    if (p.pending) return;
    p.pending = true;
    requestAnimationFrame(() => {
      p.pending = false;
      if (panRef.current || orbitRef.current) return;
      const picker = stagePicker();
      setHover(picker ? picker.lotAt(p.x, p.y) : null);
    });
  };

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const orbiting = !handMode && (e.button === 2 || (e.button === 0 && (orbitMode || e.altKey)));
    if (orbiting) {
      e.preventDefault();
      orbitRef.current = { pointerId: e.pointerId, lastX: e.clientX };
      try {
        wrapRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      return;
    }
    const panning = e.button === 1 || (e.button === 0 && handMode);
    if (panning) {
      e.preventDefault();
      panRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
      try {
        wrapRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      return;
    }
    if (handMode || orbitMode || e.button !== 0) return;
    const picker = stagePicker();
    if (!picker) return;
    const state = useTown.getState();
    // A model under the pointer wins (a tall tower over the lot behind it);
    // otherwise whoever holds the lot the pointer is on.
    const hitId = picker.pieceAt(e.clientX, e.clientY);
    const lot = picker.lotAt(e.clientX, e.clientY);
    const holder = hitId ? state.pieces[hitId] : lot ? occRef.current.get(lotId(lot.col, lot.row)) : undefined;
    if (holder) {
      const sel = state.selection;
      // Shift extends the selection; a plain click replaces it.
      state.setSelection(e.shiftKey ? (sel.includes(holder.id) ? sel.filter((s) => s !== holder.id) : [...sel, holder.id]) : [holder.id]);
      state.setLastError(null);
      if (canMove) {
        moveRef.current = { pointerId: e.pointerId, id: holder.id, fromLot: holder.lot, startX: e.clientX, startY: e.clientY, active: false };
        try {
          wrapRef.current?.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
      }
      return;
    }
    if (placing && activeId && lot) {
      const id = lotId(lot.col, lot.row);
      if (reservedRef.current.has(id)) {
        state.setLastError("Those stairs hold the way up — pick another lot.");
        return;
      }
      const outcome = humanPlace(activeId, id);
      state.setLastError(outcome.ok ? null : outcome.why);
      return;
    }
    if (!e.shiftKey) state.setSelection([]);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    pointerRef.current.x = e.clientX;
    pointerRef.current.y = e.clientY;
    const orbit = orbitRef.current;
    if (orbit && orbit.pointerId === e.pointerId) {
      const dYaw = (e.clientX - orbit.lastX) * ORBIT_RAD_PER_PX;
      orbit.lastX = e.clientX;
      camStore.set({ yaw: (camStore.state.yaw ?? DEFAULT_YAW) + dYaw });
      return;
    }
    const pan = panRef.current;
    if (pan && pan.pointerId === e.pointerId) {
      const w = wrapRef.current?.clientWidth ?? 1;
      const px = zoomPx(w, camStore.state.zoom);
      const dx = e.clientX - pan.lastX;
      const dy = e.clientY - pan.lastY;
      pan.lastX = e.clientX;
      pan.lastY = e.clientY;
      // Drag-the-world: the grabbed ground point stays under the pointer.
      // camStore.set requests one frame; the rig applies it in useFrame.
      const { sin, cos } = yawTrig(camStore.state.yaw ?? DEFAULT_YAW);
      const rx = -dx / px;
      const fz = dy / (px * SIN_EL);
      camStore.set({
        tx: camStore.state.tx + rx * cos - fz * sin,
        tz: camStore.state.tz - rx * sin - fz * cos,
      });
      return;
    }
    const move = moveRef.current;
    if (move && !move.active && move.pointerId === e.pointerId && Math.hypot(e.clientX - move.startX, e.clientY - move.startY) > 4) {
      move.active = true;
      setMoving({ id: move.id, fromLot: move.fromLot });
    }
    scheduleHover();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (orbitRef.current?.pointerId === e.pointerId) {
      orbitRef.current = null;
      try {
        wrapRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      scheduleHover();
    }
    if (panRef.current?.pointerId === e.pointerId) {
      panRef.current = null;
      try {
        wrapRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      scheduleHover();
    }
    const move = moveRef.current;
    if (move && move.pointerId === e.pointerId) {
      const state = useTown.getState();
      const picker = stagePicker();
      const target = picker ? picker.lotAt(e.clientX, e.clientY) : hoverStore.get();
      // A click is not a drag: a tall model's roof projects onto a lot
      // behind its own, and a plain click must select, never relocate.
      if (target && move.active) {
        const lot = lotId(target.col, target.row);
        if (lot !== move.fromLot && !reservedRef.current.has(lot)) {
          // The ONE store write of the whole drag.
          const outcome = humanMove(move.id, lot);
          state.setLastError(outcome.ok ? null : outcome.why);
        }
      }
      moveRef.current = null;
      if (move.active) setMoving(null);
      try {
        wrapRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
    }
  }

  function onWheel(e: ReactWheelEvent<HTMLDivElement>) {
    const factor = Math.exp(-e.deltaY * 0.0016);
    camStore.set({ zoom: Math.min(CAMERA.maxZoom, Math.max(CAMERA.minZoom, camStore.state.zoom * factor)) });
    scheduleHover();
  }

  const bounds = environmentBounds(environment);
  const lightCenter = useMemo(
    () => (bounds ? { x: (bounds.c0 + bounds.w / 2) * TILE, z: (bounds.r0 + bounds.d / 2) * TILE } : { x: HOME.x, z: HOME.z }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bounds?.c0, bounds?.r0, bounds?.w, bounds?.d],
  );
  const lightExtent = bounds ? Math.max(bounds.w, bounds.d) * TILE : 30;

  return (
    <div
      ref={wrapRef}
      className="stage3d"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => {
        if (!moveRef.current && !panRef.current && !orbitRef.current) setHover(null);
      }}
    >
      <Canvas
        orthographic
        shadows="percentage"
        dpr={[1.5, 2]}
        // On demand: frames are requested by the render clock (camera, hover,
        // store changes, running animations). A still diorama draws nothing.
        frameloop="demand"
        // preserveDrawingBuffer: the share sticker reads the last frame back
        // from the canvas; without it the buffer is discarded after compositing
        // and toDataURL returns a blank image.
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance", stencil: false, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.06;
          // The shadow map is a snapshot of the world, not of the view: it
          // only re-renders when something that casts a shadow changes
          // (renderClock.markSceneDirty), never because the camera moved.
          gl.shadowMap.autoUpdate = false;
          gl.shadowMap.needsUpdate = true;
        }}
      >
        <FrameDriver />
        <CameraRig surfaceYAt={surfaceYAt} />
        <Picker surfaceYAt={surfaceYAt} pieceRoot={pieceRoot} />
        {perf && <PerfProbe />}
        <Lights center={lightCenter} extent={lightExtent} />
        <Environment resolution={256} environmentIntensity={0.42}>
          <Lightformer intensity={1.4} position={[14, 18, 10]} scale={[22, 10, 1]} form="rect" />
          <Lightformer intensity={0.45} position={[-12, 8, -8]} scale={9} color="#a8c0e4" />
          <Lightformer intensity={0.3} position={[0, 5, 16]} scale={[12, 4, 1]} color="#ffe6c8" />
        </Environment>

        <Environment3D env={environment} autoPads={autoPads} surfaceYAt={surfaceYAt} occupied={occupiedCells} />
        <ContactShadows
          key={`env-${environment?.platforms.length ?? 0}-${environment?.water.length ?? 0}`}
          frames={1}
          position={[lightCenter.x, -PLINTH_DEPTH + 0.02, lightCenter.z]}
          opacity={0.42}
          scale={Math.max(28, lightExtent * 1.55)}
          blur={2.6}
          far={14}
          resolution={512}
          color="#3a3228"
        />

        <PieceLayer surfaceYAt={surfaceYAt} rootRef={pieceRoot} />
        <OverlayLayer surfaceYAt={surfaceYAt} environment={environment} autoPads={autoPads} reserved={reserved} handMode={handMode} debug={debug} />
      </Canvas>
      {perf && (
        <div
          id={PERF_HUD_ID}
          style={{
            position: "absolute",
            left: 10,
            bottom: 8,
            padding: "4px 8px",
            borderRadius: 6,
            background: "rgba(12, 12, 14, 0.72)",
            color: "#c9f27c",
            font: "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
            pointerEvents: "none",
            zIndex: 30,
            whiteSpace: "nowrap",
          }}
        />
      )}
    </div>
  );
}
