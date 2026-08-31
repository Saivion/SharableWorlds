"use client";

import { ContactShadows, Environment, Html, Lightformer } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import * as THREE from "three";
import { catalogItem } from "@/lib/catalog";
import { autoGroundPads } from "@/lib/composition/autoEnv";
import { DECK_BLOCK, ELEV, PLINTH_DEPTH, TILE, worldOf } from "@/lib/composition/grid3d";
import { environmentBounds, reservedLots, surfaceAt } from "@/lib/composition/surface";
import { snapLotCoord } from "@/lib/iso";
import { registerLotProjector } from "@/lib/stageProjection";
import { useTown } from "@/lib/store";
import { humanFlip, humanMove, humanPlace, lotId, occupancyMap, parseLot } from "@/lib/town";
import { Environment3D } from "./Environment3D";
import { ModelPiece } from "./ModelPiece";

/**
 * The diorama stage — an orthographic miniature the whole scene is composed
 * for. Replaces the 2D sprite stage while keeping its entire contract: the
 * same store, the same lot addressing, the same tools, the same interactions
 * (click-to-place, drag-to-move, F to flip, pan/zoom), and the same
 * screen-space hooks the agent cursor choreography relies on.
 */

// Camera framing constants. The projection angle is fixed (classic 2:1-ish
// isometric); what is tunable is framing: base view width, zoom range, ease.
const AZ = Math.PI / 4; // azimuth
const EL = Math.atan(1 / Math.SQRT2); // elevation ≈ 35.26°
const CAM_DIST = 90;
const BASE_VIEW_W = 46; // world units across the viewport at zoom 1
const CAMERA = { zoom: 0.85, minZoom: 0.35, maxZoom: 3.2, easeMaxZoom: 1.25, easeMinZoom: 0.55 };

const SIN_AZ = Math.sin(AZ);
const COS_AZ = Math.cos(AZ);
const SIN_EL = Math.sin(EL);
const COS_EL = Math.cos(EL);

type CameraState = { tx: number; tz: number; zoom: number };

const HOME = worldOf(12, 12); // M13 — same home center as the 2D board

function zoomPx(viewportW: number, zoom: number) {
  return (viewportW / BASE_VIEW_W) * zoom;
}

/** Keeps the default orthographic camera on the iso rail and registers the
 * lot → screen projector the agent cursor uses. */
function CameraRig({
  cam,
  surfaceYAt,
}: {
  cam: CameraState;
  surfaceYAt: (col: number, row: number) => number;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __stage3d?: { scene: THREE.Scene; camera: THREE.Camera } }).__stage3d = { scene, camera };
  }, [scene, camera]);

  // Applied every frame — immune to mount-order races between R3F's own
  // camera management and React effects. Mutating the camera in useFrame is
  // the idiomatic R3F pattern; the immutability lint rule predates it.
  /* eslint-disable react-hooks/immutability */
  useFrame(() => {
    const ortho = camera as THREE.OrthographicCamera;
    ortho.position.set(
      cam.tx + CAM_DIST * SIN_AZ * COS_EL,
      CAM_DIST * SIN_EL,
      cam.tz + CAM_DIST * COS_AZ * COS_EL,
    );
    ortho.lookAt(cam.tx, 0, cam.tz);
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
    return () => registerLotProjector(null);
  }, [camera, gl, surfaceYAt]);

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

export function Stage3D() {
  const pieces = useTown((s) => s.pieces);
  const environment = useTown((s) => s.environment);
  const tool = useTown((s) => s.tool);
  const activeId = useTown((s) => s.activeId);
  const selection = useTown((s) => s.selection);
  const setSelection = useTown((s) => s.setSelection);
  const setError = useTown((s) => s.setLastError);
  const agentGhost = useTown((s) => s.agentGhost);
  const focusToken = useTown((s) => s.focusToken);

  const [cam, setCam] = useState<CameraState>({ tx: HOME.x, tz: HOME.z, zoom: CAMERA.zoom });
  const [spaceDown, setSpaceDown] = useState(false);
  const [hover, setHover] = useState<{ col: number; row: number } | null>(null);
  const [moving, setMoving] = useState<{ id: string; fromLot: string } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef(cam);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const moveRef = useRef<{ pointerId: number; id: string; fromLot: string } | null>(null);
  const camAnim = useRef<number | null>(null);

  useEffect(() => {
    camRef.current = cam;
  }, [cam]);

  const debug = useSyncExternalStore(
    () => () => {},
    () => window.location.search.includes("debug"),
    () => false,
  );

  // Keep the studio's dotted-paper pattern world-locked, the way the 2D
  // stage panned it: the dots anchor to the world origin and travel with it.
  useEffect(() => {
    const main = document.querySelector("main.studio");
    if (!(main instanceof HTMLElement)) return;
    const sync = () => {
      const w = wrapRef.current?.clientWidth ?? 1;
      const h = wrapRef.current?.clientHeight ?? 1;
      const px = zoomPx(w, camRef.current.zoom);
      const { tx, tz } = camRef.current;
      const dx = (-tx * COS_AZ + tz * SIN_AZ) * px;
      const dy = -(tx * SIN_AZ + tz * COS_AZ) * SIN_EL * px;
      main.style.backgroundSize = "20px 20px";
      main.style.backgroundPosition = `${w / 2 + dx}px ${h / 2 + dy}px`;
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [cam]);

  const handMode = tool === "hand" || spaceDown;
  const placing = tool === "place" && activeId != null;
  const canMove = tool === "select" && !handMode;

  const occ = occupancyMap();
  const reserved = useMemo(() => reservedLots(environment), [environment]);
  const autoPads = useMemo(() => autoGroundPads(pieces, environment), [pieces, environment]);
  const surfaceYAt = useMemo(
    () => (col: number, row: number) => surfaceAt(environment, col, row).y,
    [environment],
  );

  // Keyboard: Space pans, F flips the selection — same contract as the 2D stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceDown(e.type === "keydown");
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
    const state = useTown.getState();
    const bounds = environmentBounds(state.environment);
    const lots = Object.values(state.pieces)
      .map((p) => parseLot(p.lot))
      .filter((p): p is { col: number; row: number } => Boolean(p));
    let minC = bounds ? bounds.c0 : Infinity;
    let maxC = bounds ? bounds.c0 + bounds.w - 1 : -Infinity;
    let minR = bounds ? bounds.r0 : Infinity;
    let maxR = bounds ? bounds.r0 + bounds.d - 1 : -Infinity;
    for (const l of lots) {
      minC = Math.min(minC, l.col);
      maxC = Math.max(maxC, l.col);
      minR = Math.min(minR, l.row);
      maxR = Math.max(maxR, l.row);
    }
    if (!Number.isFinite(minC)) return;
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
    const target: CameraState = {
      tx: cx - shift * COS_AZ,
      tz: cz + shift * SIN_AZ,
      zoom,
    };
    const from = { ...camRef.current };
    const start = performance.now();
    const DURATION = 900;
    if (camAnim.current) cancelAnimationFrame(camAnim.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      setCam({
        tx: from.tx + (target.tx - from.tx) * e,
        tz: from.tz + (target.tz - from.tz) * e,
        zoom: from.zoom + (target.zoom - from.zoom) * e,
      });
      if (t < 1) camAnim.current = requestAnimationFrame(step);
    };
    camAnim.current = requestAnimationFrame(step);
    return () => {
      if (camAnim.current) cancelAnimationFrame(camAnim.current);
    };
  }, [focusToken]);

  // --- Wrapper-level pan & zoom -------------------------------------------
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const panning = e.button === 1 || (e.button === 0 && handMode);
    if (!panning) return;
    e.preventDefault();
    panRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    wrapRef.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    const w = wrapRef.current?.clientWidth ?? 1;
    const px = zoomPx(w, camRef.current.zoom);
    const dx = e.clientX - pan.lastX;
    const dy = e.clientY - pan.lastY;
    pan.lastX = e.clientX;
    pan.lastY = e.clientY;
    // Drag-the-world: the grabbed ground point stays under the pointer.
    const rx = -dx / px;
    const fz = dy / (px * SIN_EL);
    setCam((c) => ({
      ...c,
      tx: c.tx + rx * COS_AZ - fz * SIN_AZ,
      tz: c.tz - rx * SIN_AZ - fz * COS_AZ,
    }));
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId === e.pointerId) {
      panRef.current = null;
      try {
        wrapRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
    }
    const move = moveRef.current;
    if (move?.pointerId === e.pointerId) {
      const state = useTown.getState();
      const hoverNow = hoverRef.current;
      if (hoverNow) {
        const lot = lotId(hoverNow.col, hoverNow.row);
        if (lot !== move.fromLot && !reserved.has(lot)) {
          const outcome = humanMove(move.id, lot);
          state.setLastError(outcome.ok ? null : outcome.why);
        }
      }
      moveRef.current = null;
      setMoving(null);
    }
  }

  function onWheel(e: ReactWheelEvent<HTMLDivElement>) {
    const factor = Math.exp(-e.deltaY * 0.0016);
    setCam((c) => ({ ...c, zoom: Math.min(CAMERA.maxZoom, Math.max(CAMERA.minZoom, c.zoom * factor)) }));
  }

  // --- Scene-level picking -------------------------------------------------
  const hoverRef = useRef(hover);
  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);

  function lotFromPoint(point: THREE.Vector3) {
    return { col: snapLotCoord(point.x / TILE), row: snapLotCoord(point.z / TILE) };
  }

  const onSurfaceMove = (e: { point: THREE.Vector3; stopPropagation: () => void }) => {
    e.stopPropagation();
    if (panRef.current) return;
    const hit = lotFromPoint(e.point);
    setHover((h) => (h && h.col === hit.col && h.row === hit.row ? h : hit));
  };

  const onSurfaceDown = (e: { point: THREE.Vector3; stopPropagation: () => void; button?: number; nativeEvent?: PointerEvent }) => {
    if (handMode || (e.nativeEvent && e.nativeEvent.button !== 0)) return;
    e.stopPropagation();
    const hit = lotFromPoint(e.point);
    const lot = lotId(hit.col, hit.row);
    const holder = occ.get(lot);
    if (holder) {
      setSelection([holder.id]);
      setError(null);
      if (canMove) {
        moveRef.current = { pointerId: -1, id: holder.id, fromLot: holder.lot };
        setMoving({ id: holder.id, fromLot: holder.lot });
      }
      return;
    }
    if (placing && activeId) {
      if (reserved.has(lot)) {
        setError("Those stairs hold the way up — pick another lot.");
        return;
      }
      const outcome = humanPlace(activeId, lot);
      setError(outcome.ok ? null : outcome.why);
      return;
    }
    setSelection([]);
  };

  const pieceDown = (pieceId: string) => (e: { stopPropagation: () => void; nativeEvent?: PointerEvent; pointerId?: number }) => {
    if (handMode || (e.nativeEvent && e.nativeEvent.button !== 0)) return;
    e.stopPropagation();
    const piece = useTown.getState().pieces[pieceId];
    if (!piece) return;
    setSelection([pieceId]);
    setError(null);
    if (canMove) {
      moveRef.current = { pointerId: e.pointerId ?? -1, id: pieceId, fromLot: piece.lot };
      setMoving({ id: pieceId, fromLot: piece.lot });
    }
  };

  // pointerId of piece-move follows whatever pointer lifts — normalize on the
  // wrapper: any pointerup finishes an in-flight move.
  function onWrapperPointerUpCapture(e: ReactPointerEvent<HTMLDivElement>) {
    if (moveRef.current && moveRef.current.pointerId === -1) {
      moveRef.current.pointerId = e.pointerId;
    }
  }

  const hoverLot = hover ? lotId(hover.col, hover.row) : null;
  const hoverPiece = hoverLot ? occ.get(hoverLot) : undefined;
  const hoverEmpty = Boolean(hoverLot && !reserved.has(hoverLot) && (!hoverPiece || hoverPiece.id === moving?.id));
  const movingPiece = moving ? pieces[moving.id] : undefined;
  const ghostParsed = agentGhost ? parseLot(agentGhost.lot) : null;
  const selectedIds = new Set(selection);

  const bounds = environmentBounds(environment);
  const lightCenter = bounds
    ? { x: (bounds.c0 + bounds.w / 2) * TILE, z: (bounds.r0 + bounds.d / 2) * TILE }
    : { x: HOME.x, z: HOME.z };
  const lightExtent = bounds ? Math.max(bounds.w, bounds.d) * TILE : 30;

  const stageClass = [
    "stage3d",
    handMode ? "stage--pan" : "",
    moving ? "stage--moving" : "",
    !moving && canMove && hoverPiece ? "stage--move" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={wrapRef}
      className={stageClass}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerUpCapture={onWrapperPointerUpCapture}
      onWheel={onWheel}
      onPointerLeave={() => {
        if (!moveRef.current) setHover(null);
      }}
    >
      <Canvas
        orthographic
        shadows="percentage"
        dpr={[1.5, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance", stencil: false }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.06;
        }}
      >
        <CameraRig cam={cam} surfaceYAt={surfaceYAt} />
        <Lights center={lightCenter} extent={lightExtent} />
        <Environment resolution={256} environmentIntensity={0.42}>
          <Lightformer intensity={1.4} position={[14, 18, 10]} scale={[22, 10, 1]} form="rect" />
          <Lightformer intensity={0.45} position={[-12, 8, -8]} scale={9} color="#a8c0e4" />
          <Lightformer intensity={0.3} position={[0, 5, 16]} scale={[12, 4, 1]} color="#ffe6c8" />
        </Environment>

        <Environment3D env={environment} autoPads={autoPads} surfaceYAt={surfaceYAt} />
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

        {/* Catch-all ground picking plane (invisible, below every deck). */}
        <mesh
          rotation-x={-Math.PI / 2}
          position-y={-0.01}
          onPointerMove={onSurfaceMove}
          onPointerDown={onSurfaceDown}
        >
          <planeGeometry args={[4000, 4000]} />
          <meshBasicMaterial visible={false} />
        </mesh>
        {/* Platform decks re-raycast at their own height for parallax-correct lots. */}
        {environment?.platforms.map((p) => {
          const w = p.rect.w * TILE;
          const d = p.rect.d * TILE;
          return (
            <mesh
              key={`pick-${p.id}`}
              rotation-x={-Math.PI / 2}
              position={[
                (p.rect.c0 + (p.rect.w - 1) / 2) * TILE,
                p.level * ELEV + (p.inset ? 0.06 : 0) + DECK_BLOCK + 0.02,
                (p.rect.r0 + (p.rect.d - 1) / 2) * TILE,
              ]}
              onPointerMove={onSurfaceMove}
              onPointerDown={onSurfaceDown}
            >
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial visible={false} />
            </mesh>
          );
        })}

        {/* Pieces */}
        {Object.values(pieces).map((piece) => {
          const parsed = parseLot(piece.lot);
          const item = catalogItem(piece.catalogId);
          if (!parsed || !item?.model) return null;
          const { x, z } = worldOf(parsed.col, parsed.row);
          const y = surfaceYAt(parsed.col, parsed.row);
          const isSelected = selectedIds.has(piece.id);
          const isHover = hoverLot === piece.lot;
          const isMoving = moving?.id === piece.id;
          return (
            <group key={piece.id}>
              {(isSelected || isHover) && (
                <LotPad col={parsed.col} row={parsed.row} y={y} strong={isSelected} />
              )}
              <PieceBoundary><Suspense fallback={null}>
                <ModelPiece
                  item={item}
                  position={[x, y, z]}
                  flip={piece.flip}
                  rot={piece.rot}
                  dim={isMoving}
                  grow
                  onPointerDown={pieceDown(piece.id)}
                />
              </Suspense></PieceBoundary>
              {piece.label !== "" && (isSelected || isHover) && (
                <Html position={[x, y + 2.4, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
                  <div className="iso-tag3d">{piece.label}</div>
                </Html>
              )}
              {debug && (
                <Html position={[x, y + 0.1, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
                  <div className="iso-debug3d">{piece.lot}</div>
                </Html>
              )}
            </group>
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
        {hover && hoverEmpty && !handMode && placing && activeId && (() => {
          const item = catalogItem(activeId);
          if (!item?.model) return null;
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
          if (!item?.model) return null;
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
      </Canvas>
    </div>
  );
}
