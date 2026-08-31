"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { catalogItem } from "@/lib/catalog";
import { catalogBox, catalogContentBox, groundOf, isoOf, isoToGrid, snapLotCoord, TILE_H, TILE_W } from "@/lib/iso";
import { GRID, humanFlip, humanMove, humanPlace, lotId, occupancyMap, parseLot } from "@/lib/town";
import { useTown } from "@/lib/store";
import type { Piece } from "@/lib/types";

/**
 * Centralized camera. The projection itself is baked into the sprites
 * (Kenney's isometric renders) and isoOf's 2:1 diamond — what is tunable is
 * framing: base frustum width, default zoom, zoom range, focal point, and the
 * ease-to-fit behavior on first build. Tune here, never per object.
 */
const CAMERA = {
  baseW: 160,
  zoom: 0.72,
  minZoom: 0.4,
  maxZoom: 2.4,
  easeMaxZoom: 1.05,
  easeMinZoom: 0.55,
};
/** Screen-px corner radius for the selected / hovered object pad. */
const HIGHLIGHT_RADIUS_PX = 22;
const TOWN_CENTER = { x: 0, y: ((GRID.cols + GRID.rows - 2) / 2) * (TILE_H / 2) };

type Camera = { cx: number; cy: number; zoom: number };

function flipTf(flip: boolean | undefined, ox: number) {
  if (!flip) return undefined;
  return `translate(${ox} 0) scale(-1 1) translate(${-ox} 0)`;
}

function SpriteImage({ piece, opacity = 1 }: { piece: Pick<Piece, "catalogId" | "lot"> & { flip?: boolean }; opacity?: number }) {
  const parsed = parseLot(piece.lot);
  const item = catalogItem(piece.catalogId);
  if (!parsed || !item) return null;
  const box = catalogBox(item, parsed.col, parsed.row);
  const origin = groundOf(parsed.col, parsed.row);
  return (
    <g
      opacity={opacity}
      style={{ pointerEvents: "none" }}
      transform={flipTf(piece.flip, origin.x)}
    >
      <image
        href={item.src}
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        style={{ imageRendering: "pixelated" }}
      />
    </g>
  );
}

function HighlightPad({
  catalogId,
  lot,
  flip = false,
  selected,
  viewW,
  viewportW,
}: {
  catalogId: string;
  lot: string;
  flip?: boolean;
  selected: boolean;
  viewW: number;
  viewportW: number;
}) {
  const parsed = parseLot(lot);
  const item = catalogItem(catalogId);
  if (!parsed || !item) return null;
  const content = catalogContentBox(item, parsed.col, parsed.row);
  const pad = TILE_W * 0.08;
  const w = content.w + pad * 2;
  const h = content.h + pad * 2;
  const radius = Math.min(HIGHLIGHT_RADIUS_PX * (viewW / Math.max(1, viewportW)), w / 2, h / 2);
  const origin = groundOf(parsed.col, parsed.row);
  return (
    <rect
      x={content.x - pad}
      y={content.y - pad}
      width={w}
      height={h}
      rx={radius}
      ry={radius}
      fill={selected ? "rgba(10, 10, 10, 0.07)" : "rgba(10, 10, 10, 0.045)"}
      transform={flipTf(flip, origin.x)}
      style={{ pointerEvents: "none" }}
    />
  );
}

export function Stage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const pieces = useTown((s) => s.pieces);
  const tool = useTown((s) => s.tool);
  const activeId = useTown((s) => s.activeId);
  const selection = useTown((s) => s.selection);
  const setSelection = useTown((s) => s.setSelection);
  const setError = useTown((s) => s.setLastError);
  const agentGhost = useTown((s) => s.agentGhost);
  const focusToken = useTown((s) => s.focusToken);

  const [camera, setCamera] = useState<Camera>({ cx: TOWN_CENTER.x, cy: TOWN_CENTER.y, zoom: CAMERA.zoom });
  const [viewport, setViewport] = useState({ w: 1, h: 1 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [hover, setHover] = useState<{ col: number; row: number } | null>(null);

  // ?debug=1 shows lot ids — hydration-safe one-time read.
  const debug = useSyncExternalStore(
    () => () => {},
    () => window.location.search.includes("debug"),
    () => false,
  );

  const drag = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const moveRef = useRef<{ pointerId: number; id: string; fromLot: string } | null>(null);
  const [moving, setMoving] = useState<{ id: string; fromLot: string } | null>(null);
  const cameraAnim = useRef<number | null>(null);
  const handMode = tool === "hand" || spaceDown;
  const placing = tool === "place" && activeId != null;
  const canMove = tool === "select" && !handMode;

  const occ = occupancyMap();
  const ordered = Object.values(pieces).sort((a, b) => {
    const pa = parseLot(a.lot);
    const pb = parseLot(b.lot);
    const da = pa ? pa.col + pa.row : 0;
    const db = pb ? pb.col + pb.row : 0;
    if (da !== db) return da - db;
    return (pa?.col ?? 0) - (pb?.col ?? 0);
  });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const fit = () => setViewport({ w: Math.max(1, svg.clientWidth), h: Math.max(1, svg.clientHeight) });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

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

  const cameraRef = useRef(camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  // Ease the camera to frame the scene when the agent's first build lands.
  useEffect(() => {
    if (focusToken === 0) return;
    const lots = Object.values(useTown.getState().pieces)
      .map((p) => parseLot(p.lot))
      .filter((p): p is { col: number; row: number } => Boolean(p));
    if (!lots.length) return;
    const pts = lots.map((l) => isoOf(l.col, l.row));
    const minX = Math.min(...pts.map((p) => p.x)) - 12;
    const maxX = Math.max(...pts.map((p) => p.x)) + 12;
    const minY = Math.min(...pts.map((p) => p.y)) - TILE_H * 3;
    const maxY = Math.max(...pts.map((p) => p.y)) + TILE_H * 2;
    const target: Camera = {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      zoom: Math.min(CAMERA.easeMaxZoom, Math.max(CAMERA.easeMinZoom, (CAMERA.baseW * 0.72) / Math.max(maxX - minX, 24))),
    };
    const from = { ...cameraRef.current };
    const start = performance.now();
    const DURATION = 900;
    if (cameraAnim.current) cancelAnimationFrame(cameraAnim.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      setCamera({
        cx: from.cx + (target.cx - from.cx) * e,
        cy: from.cy + (target.cy - from.cy) * e,
        zoom: from.zoom + (target.zoom - from.zoom) * e,
      });
      if (t < 1) cameraAnim.current = requestAnimationFrame(step);
    };
    cameraAnim.current = requestAnimationFrame(step);
    return () => {
      if (cameraAnim.current) cancelAnimationFrame(cameraAnim.current);
    };
  }, [focusToken]);

  const vbW = CAMERA.baseW / camera.zoom;
  const vbH = (vbW * viewport.h) / viewport.w;
  const view = { x: camera.cx - vbW / 2, y: camera.cy - vbH / 2, w: vbW, h: vbH };

  useEffect(() => {
    const main = document.querySelector("main.studio");
    if (!(main instanceof HTMLElement)) return;
    const scale = viewport.w / Math.max(1, view.w);
    main.style.backgroundSize = "20px 20px";
    main.style.backgroundPosition = `${-view.x * scale}px ${-view.y * scale}px`;
  }, [viewport.w, view.w, view.x, view.y]);

  function toBoard(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  function lotAtClient(clientX: number, clientY: number) {
    const p = toBoard(clientX, clientY);
    const g = isoToGrid(p.x, p.y);
    const col = snapLotCoord(g.col);
    const row = snapLotCoord(g.row);
    return { col, row, lot: lotId(col, row) };
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    const panning = e.button === 1 || (e.button === 0 && handMode);
    if (panning) {
      e.preventDefault();
      drag.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const hit = lotAtClient(e.clientX, e.clientY);
    if (!hit) {
      setSelection([]);
      return;
    }
    const holder = occ.get(hit.lot);
    if (holder) {
      setSelection([holder.id]);
      setError(null);
      if (canMove) {
        moveRef.current = { pointerId: e.pointerId, id: holder.id, fromLot: holder.lot };
        setMoving({ id: holder.id, fromLot: holder.lot });
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (placing && activeId) {
      const outcome = humanPlace(activeId, hit.lot);
      setError(outcome.ok ? null : outcome.why);
      return;
    }
    setSelection([]);
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (drag.current?.pointerId === e.pointerId) {
      const svg = svgRef.current;
      if (!svg) return;
      const scale = view.w / Math.max(1, svg.clientWidth);
      const dx = (e.clientX - drag.current.lastX) * scale;
      const dy = (e.clientY - drag.current.lastY) * scale;
      drag.current.lastX = e.clientX;
      drag.current.lastY = e.clientY;
      setCamera((c) => ({ ...c, cx: c.cx - dx, cy: c.cy - dy }));
      return;
    }
    const hit = lotAtClient(e.clientX, e.clientY);
    setHover(hit ? { col: hit.col, row: hit.row } : null);
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
    const move = moveRef.current;
    if (move?.pointerId === e.pointerId) {
      const hit = lotAtClient(e.clientX, e.clientY);
      if (hit && hit.lot !== move.fromLot) {
        const outcome = humanMove(move.id, hit.lot);
        setError(outcome.ok ? null : outcome.why);
      }
      moveRef.current = null;
      setMoving(null);
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }

  function onWheel(e: ReactWheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    setCamera((c) => ({ ...c, zoom: Math.min(CAMERA.maxZoom, Math.max(CAMERA.minZoom, c.zoom * factor)) }));
  }

  const hoverLot = hover ? lotId(hover.col, hover.row) : null;
  const hoverPiece = hoverLot ? occ.get(hoverLot) : undefined;
  const hoverEmpty = Boolean(hoverLot && (!hoverPiece || hoverPiece.id === moving?.id));
  const selectedPieces = selection.map((id) => pieces[id]).filter(Boolean);
  const ghostParsed = agentGhost ? parseLot(agentGhost.lot) : null;
  const movingPiece = moving ? pieces[moving.id] : undefined;
  const stageClass = [
    "stage",
    handMode ? "stage--pan" : "",
    moving ? "stage--moving" : "",
    !moving && canMove && hoverPiece ? "stage--move" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid slice"
      className={stageClass}
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        if (!moveRef.current) setHover(null);
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      {/* Pieces, back to front */}
      {ordered.map((piece) => {
        const parsed = parseLot(piece.lot);
        const item = catalogItem(piece.catalogId);
        if (!parsed || !item) return null;
        const isSelected = selectedPieces.some((p) => p.id === piece.id);
        const isHover = hoverLot === piece.lot;
        return (
          <g key={piece.id}>
            {(isSelected || isHover) && (
              <HighlightPad
                catalogId={piece.catalogId}
                lot={piece.lot}
                flip={piece.flip}
                selected={isSelected}
                viewW={view.w}
                viewportW={viewport.w}
              />
            )}
            <SpriteImage piece={piece} opacity={moving?.id === piece.id ? 0.35 : 1} />
            {piece.label !== "" && (isSelected || isHover) && (
              <text
                x={isoOf(parsed.col, parsed.row).x}
                y={isoOf(parsed.col, parsed.row).y - TILE_H * 1.9}
                textAnchor="middle"
                className="iso-tag"
              >
                {piece.label}
              </text>
            )}
            {debug && (
              <text
                x={isoOf(parsed.col, parsed.row).x}
                y={isoOf(parsed.col, parsed.row).y + 1}
                textAnchor="middle"
                className="iso-debug"
              >
                {piece.lot}
              </text>
            )}
          </g>
        );
      })}

      {/* Ghost sprite while the agent writes */}
      {agentGhost && ghostParsed && !occ.has(agentGhost.lot) && (
        <g>
          <HighlightPad
            catalogId={agentGhost.catalogId}
            lot={agentGhost.lot}
            selected={false}
            viewW={view.w}
            viewportW={viewport.w}
          />
          <SpriteImage piece={{ catalogId: agentGhost.catalogId, lot: agentGhost.lot }} opacity={0.45} />
        </g>
      )}

      {/* Placement ghost under the cursor — same pad as selected objects / kit cells */}
      {hover && hoverEmpty && !handMode && placing && activeId && (
        <g>
          <HighlightPad
            catalogId={activeId}
            lot={lotId(hover.col, hover.row)}
            selected
            viewW={view.w}
            viewportW={viewport.w}
          />
          <SpriteImage piece={{ catalogId: activeId, lot: lotId(hover.col, hover.row) }} opacity={0.5} />
        </g>
      )}

      {/* Move ghost follows the pointer while Select is dragging a piece */}
      {moving && movingPiece && hover && hoverEmpty && hoverLot !== moving.fromLot && (
        <g>
          <HighlightPad
            catalogId={movingPiece.catalogId}
            lot={lotId(hover.col, hover.row)}
            flip={movingPiece.flip}
            selected
            viewW={view.w}
            viewportW={viewport.w}
          />
          <SpriteImage
            piece={{ catalogId: movingPiece.catalogId, lot: lotId(hover.col, hover.row), flip: movingPiece.flip }}
            opacity={0.7}
          />
        </g>
      )}
    </svg>
  );
}
