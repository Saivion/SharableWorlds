"use client";

import { useFrame } from "@react-three/fiber";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { DECK_BLOCK, ELEV, PLINTH_DEPTH, TILE, type LotRect } from "@/lib/composition/grid3d";
import type { EnvironmentSpec, PlatformMaterial, StairSpec, WallSpec, WaterTone } from "@/lib/composition/types";
import {
  DROP,
  SNAP,
  SnapDown,
  currentWave,
  dropDelay,
  easeOut,
  legoPop,
  startFoundationWave,
  waveOrigin,
} from "./legoDrop";
import { GROUND_SUB, blockHex, blockLift, getGrainTexture, hash2, isPebble, isRubble, pathHexFor, rubbleHex, rubbleShape, waterHex } from "./terrainLook";

/**
 * The architecture layer — everything the scene stands on. The island is
 * Lego columns: foundation and deck are one brick per cell, falling in one
 * wave. No slab first, no texture rain after.
 */

const WALL_COLOR = "#e4dccb";
const WALL_CAP = "#b9a98d";

function useGrain() {
  return useMemo(() => getGrainTexture(), []);
}

function useMat(color: string, extra?: Partial<THREE.MeshStandardMaterialParameters>) {
  const grain = useGrain();
  return useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.88,
        metalness: 0.02,
        map: grain ?? undefined,
        envMapIntensity: 0.3,
        ...extra,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [color, grain],
  );
}

type Brick = {
  x: number;
  y: number;
  z: number;
  sy: number;
  delay: number;
};

/** One bit of debris: which instanced mesh it lives in (`shape`), its slot
 * there, and its own scale and spin. */
type RubbleBrick = Brick & { sx: number; sz: number; ry: number; shape: 0 | 1 | 2; slot: number };

const RUBBLE_SHAPES = 3;

function GroundBlocks({
  rect,
  top,
  bottom,
  material,
  origin,
  kind = "land",
  cellMaterial,
  cellWaterTone,
  cellBottom,
}: {
  rect: LotRect;
  top: number;
  bottom: number;
  material: PlatformMaterial;
  origin: number;
  kind?: "land" | "water";
  /** Per-lot column base — a stacked tier starts where the tier beneath
   * ends instead of sharing (and z-fighting) the lower column's faces. */
  cellBottom?: (col: number, row: number) => number;
  /** Per-lot themed override — material patches painted by the terrain system. */
  cellMaterial?: (col: number, row: number) => PlatformMaterial | undefined;
  /** Per-lot water tone — seeded patch regions from paintWater. */
  cellWaterTone?: (col: number, row: number) => WaterTone | undefined;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const rubbleRefs = useRef<(THREE.InstancedMesh | null)[]>([null, null, null]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const born = useRef(0);
  const done = useRef(false);
  const rest = useRef<Brick[]>([]);
  const rubbleRest = useRef<RubbleBrick[]>([]);
  const wet = kind === "water";
  const sub = GROUND_SUB;
  const size = TILE / sub;
  const count = Math.max(1, rect.w * rect.d * sub * sub);

  type Spot = { gx: number; gz: number; x: number; z: number; shape: 0 | 1 | 2; pebble: boolean; slot: number };
  const rubbleSpots = useMemo(() => {
    if (wet) return [] as Spot[];
    const spots: Spot[] = [];
    const slots = [0, 0, 0];
    for (let dr = 0; dr < rect.d; dr += 1) {
      for (let dc = 0; dc < rect.w; dc += 1) {
        for (let sz = 0; sz < sub; sz += 1) {
          for (let sx = 0; sx < sub; sx += 1) {
            const gx = (rect.c0 + dc) * sub + sx;
            const gz = (rect.r0 + dr) * sub + sz;
            const rubble = isRubble(gx, gz);
            const pebble = !rubble && isPebble(gx, gz);
            if (!rubble && !pebble) continue;
            const ox = (sx + 0.5 - sub / 2) * size;
            const oz = (sz + 0.5 - sub / 2) * size;
            const shape = pebble ? 1 : rubbleShape(gx, gz);
            spots.push({ gx, gz, x: (rect.c0 + dc) * TILE + ox, z: (rect.r0 + dr) * TILE + oz, shape, pebble, slot: slots[shape] });
            slots[shape] += 1;
          }
        }
      }
    }
    return spots;
  }, [rect.c0, rect.r0, rect.w, rect.d, wet, sub, size]);
  const rubbleCounts = useMemo(() => {
    const counts = [0, 0, 0];
    for (const s of rubbleSpots) counts[s.shape] += 1;
    return counts;
  }, [rubbleSpots]);

  useLayoutEffect(() => {
    born.current = currentWave()?.born ?? performance.now();
    done.current = false;
    const mesh = meshRef.current;
    if (!mesh) return;
    const color = new THREE.Color();
    const cells: Brick[] = [];
    let i = 0;
    for (let dr = 0; dr < rect.d; dr += 1) {
      for (let dc = 0; dc < rect.w; dc += 1) {
        for (let sz = 0; sz < sub; sz += 1) {
          for (let sx = 0; sx < sub; sx += 1) {
            const gx = (rect.c0 + dc) * sub + sx;
            const gz = (rect.r0 + dr) * sub + sz;
            const ox = (sx + 0.5 - sub / 2) * size;
            const oz = (sz + 0.5 - sub / 2) * size;
            const lift = wet ? 0 : blockLift(gx, gz);
            const cap = DECK_BLOCK + lift;
            const base = cellBottom ? cellBottom(rect.c0 + dc, rect.r0 + dr) : bottom;
            const h = Math.max(DECK_BLOCK, top + cap - base);
            const delay = dropDelay(gx, gz, origin);
            cells.push({
              x: (rect.c0 + dc) * TILE + ox,
              y: base + h / 2,
              z: (rect.r0 + dr) * TILE + oz,
              sy: h / DECK_BLOCK,
              delay,
            });
            dummy.position.set(cells[i].x, cells[i].y + DROP, cells[i].z);
            dummy.scale.set(0.04, 0.04, 0.04);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            const cellMat = (!wet && cellMaterial?.(rect.c0 + dc, rect.r0 + dr)) || material;
            const tone = wet ? cellWaterTone?.(rect.c0 + dc, rect.r0 + dr) : undefined;
            color.set(wet ? waterHex(gx, gz, tone) : blockHex(gx, gz, cellMat));
            mesh.setColorAt(i, color);
            i += 1;
          }
        }
      }
    }
    rest.current = cells;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const rubbleCells: RubbleBrick[] = [];
    if (rubbleRefs.current.some(Boolean)) {
      rubbleSpots.forEach((spot) => {
        const rubble = rubbleRefs.current[spot.shape];
        if (!rubble) return;
        const h = hash2(spot.gx, spot.gz);
        const jx = ((h % 7) - 3) * 0.05;
        const jz = (((h >>> 3) % 7) - 3) * 0.05;
        const lift = blockLift(spot.gx, spot.gz);
        const ry = ((h >>> 5) % 8) * (Math.PI / 8);
        // Scale is relative to each shape's base geometry (0.4 rock, 0.22-radius
        // pebble, 0.5×0.12×0.36 slab).
        let sx: number, sy: number, sz: number, rh: number;
        if (spot.shape === 0) {
          const s = 0.26 + (h % 5) * 0.05;
          rh = 0.16 + (h % 3) * 0.09;
          sx = s / 0.4;
          sy = rh / 0.4;
          sz = (s * (0.85 + ((h >>> 2) % 3) * 0.12)) / 0.4;
        } else if (spot.shape === 1) {
          const s = spot.pebble ? 0.12 + (h % 4) * 0.03 : 0.2 + (h % 4) * 0.05;
          rh = s * 0.75;
          sx = s / 0.44;
          sy = rh / 0.44;
          sz = (s * (0.8 + ((h >>> 2) % 3) * 0.15)) / 0.44;
        } else {
          rh = 0.1 + (h % 2) * 0.04;
          sx = 0.75 + (h % 4) * 0.15;
          sy = rh / 0.12;
          sz = 0.75 + ((h >>> 2) % 4) * 0.15;
        }
        const cell: RubbleBrick = {
          x: spot.x + jx,
          y: top + DECK_BLOCK + lift + rh / 2,
          z: spot.z + jz,
          sx,
          sy,
          sz,
          ry,
          shape: spot.shape,
          slot: spot.slot,
          delay: dropDelay(spot.gx, spot.gz, origin),
        };
        rubbleCells.push(cell);
        dummy.position.set(cell.x, cell.y + DROP, cell.z);
        dummy.rotation.set(0, ry, 0);
        dummy.scale.set(0.04, 0.04, 0.04);
        dummy.updateMatrix();
        rubble.setMatrixAt(spot.slot, dummy.matrix);
        const rubbleMat = cellMaterial?.(Math.floor(spot.gx / sub), Math.floor(spot.gz / sub)) ?? material;
        color.set(rubbleHex(spot.gx, spot.gz, rubbleMat));
        rubble.setColorAt(spot.slot, color);
      });
      dummy.rotation.set(0, 0, 0);
      for (const rubble of rubbleRefs.current) {
        if (!rubble) continue;
        rubble.instanceMatrix.needsUpdate = true;
        if (rubble.instanceColor) rubble.instanceColor.needsUpdate = true;
      }
    }
    rubbleRest.current = rubbleCells;
  }, [rect.c0, rect.r0, rect.w, rect.d, material, wet, top, bottom, origin, sub, size, dummy, rubbleSpots, cellMaterial, cellWaterTone, cellBottom]);

  useFrame(() => {
    if (done.current || born.current === 0) return;
    if (rest.current.length === 0) return;
    const t0 = (performance.now() - born.current) / 1000;
    const mesh = meshRef.current;
    let remaining = false;
    if (mesh) {
      rest.current.forEach((cell, i) => {
        const t = t0 - cell.delay;
        if (t < 0) {
          remaining = true;
          dummy.position.set(cell.x, cell.y + DROP, cell.z);
          dummy.scale.set(0.04, 0.04, 0.04);
        } else if (t >= SNAP) {
          dummy.position.set(cell.x, cell.y, cell.z);
          dummy.scale.set(1, cell.sy, 1);
        } else {
          remaining = true;
          dummy.position.set(cell.x, cell.y + DROP * (1 - easeOut(t / SNAP)), cell.z);
          const pop = legoPop(t);
          dummy.scale.set(pop, cell.sy * pop, pop);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (rubbleRest.current.length) {
      for (const cell of rubbleRest.current) {
        const rubble = rubbleRefs.current[cell.shape];
        if (!rubble) continue;
        const t = t0 - cell.delay;
        dummy.rotation.set(0, cell.ry, 0);
        if (t < 0) {
          remaining = true;
          dummy.position.set(cell.x, cell.y + DROP, cell.z);
          dummy.scale.set(0.04, 0.04, 0.04);
        } else if (t >= SNAP) {
          dummy.position.set(cell.x, cell.y, cell.z);
          dummy.scale.set(cell.sx, cell.sy, cell.sz);
        } else {
          remaining = true;
          dummy.position.set(cell.x, cell.y + DROP * (1 - easeOut(t / SNAP)), cell.z);
          const pop = legoPop(t);
          dummy.scale.set(cell.sx * pop, cell.sy * pop, cell.sz * pop);
        }
        dummy.updateMatrix();
        rubble.setMatrixAt(cell.slot, dummy.matrix);
      }
      dummy.rotation.set(0, 0, 0);
      // Per-frame instance updates are the idiomatic R3F pattern; the
      // immutability rule predates it (same as the camera rig).
      // eslint-disable-next-line react-hooks/immutability
      for (const rubble of rubbleRefs.current) if (rubble) rubble.instanceMatrix.needsUpdate = true;
    }
    if (!remaining) done.current = true;
  });

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, count]}
        castShadow={!wet}
        receiveShadow
        frustumCulled={false}
      >
        <boxGeometry args={[size * 0.98, DECK_BLOCK, size * 0.98]} />
        <meshStandardMaterial
          roughness={wet ? 0.22 : 0.86}
          metalness={wet ? 0.12 : 0.02}
          envMapIntensity={wet ? 1 : 0.25}
          transparent={wet}
          opacity={wet ? 0.94 : 1}
        />
      </instancedMesh>
      {Array.from({ length: RUBBLE_SHAPES }, (_, shape) =>
        rubbleCounts[shape] > 0 ? (
          <instancedMesh
            key={shape}
            ref={(m) => {
              rubbleRefs.current[shape] = m;
            }}
            args={[undefined, undefined, rubbleCounts[shape]]}
            castShadow
            receiveShadow
            frustumCulled={false}
          >
            {shape === 0 ? <boxGeometry args={[0.4, 0.4, 0.4]} /> : shape === 1 ? <dodecahedronGeometry args={[0.22, 0]} /> : <boxGeometry args={[0.5, 0.12, 0.36]} />}
            <meshStandardMaterial roughness={0.9} metalness={0.04} envMapIntensity={0.2} flatShading={shape === 1} />
          </instancedMesh>
        ) : null,
      )}
    </group>
  );
}

function Platform({
  rect,
  level,
  material,
  inset,
  lift = 0,
  origin,
  cellMaterial,
  cellBottom,
}: {
  rect: LotRect;
  level: number;
  material: PlatformMaterial;
  inset?: boolean;
  lift?: number;
  origin: number;
  cellMaterial?: (col: number, row: number) => PlatformMaterial | undefined;
  cellBottom?: (col: number, row: number) => number;
}) {
  const top = level * ELEV + lift + (inset ? 0.06 : 0);
  const height = inset ? 0.06 : top + PLINTH_DEPTH;
  const bottom = top - height;
  return <GroundBlocks rect={rect} top={top} bottom={bottom} material={material} origin={origin} cellMaterial={cellMaterial} cellBottom={inset ? undefined : cellBottom} />;
}

/** Wall bricks: one ground block wide, half a block tall, a hand thick. */
const WALL_BRICK_H = 0.5;
const WALL_BRICK_T = 0.4;

/**
 * A wall laid in ground blocks — the same sub-lot bricks, the same seeded
 * palette as the material it is built from, so a room reads as the
 * foundation carried upward instead of a plaster sheet set on top of it.
 */
function WallBlocks({ wall, material }: { wall: WallSpec; material: PlatformMaterial }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const sub = GROUND_SUB;
  const size = TILE / sub;
  const rows = Math.max(1, Math.round(wall.height / WALL_BRICK_H));
  const open = useMemo(() => new Set(wall.openings ?? []), [wall.openings]);
  const solid = useMemo(() => {
    const cells: number[] = [];
    for (let i = 0; i < wall.len; i += 1) if (!open.has(i)) cells.push(i);
    return cells;
  }, [wall.len, open]);
  const count = Math.max(1, solid.length * sub * rows);
  const horizontal = wall.dir === "h";
  const edgeOffset = wall.side === "n" || wall.side === "w" ? -0.5 : 0.5;
  // The seed for tone variety: a wall's own footprint on the sub-lot grid,
  // offset per row so courses do not repeat the ground beneath.
  const salt = hash2(wall.c * 7 + wall.r * 13, wall.len + rows);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const color = new THREE.Color();
    let i = 0;
    for (const cell of solid) {
      for (let s = 0; s < sub; s += 1) {
        const alongIdx = cell * sub + s;
        const along = (cell + (s + 0.5 - sub / 2) / sub) * TILE;
        for (let r = 0; r < rows; r += 1) {
          // Running bond: every other course shifts half a brick.
          const bond = r % 2 ? size / 2 : 0;
          const x = horizontal ? (wall.c + along / TILE) * TILE + bond : (wall.c + edgeOffset) * TILE;
          const z = horizontal ? (wall.r + edgeOffset) * TILE : (wall.r + along / TILE) * TILE + bond;
          const h = r === rows - 1 ? wall.height - r * WALL_BRICK_H : WALL_BRICK_H;
          dummy.position.set(x, r * WALL_BRICK_H + h / 2, z);
          dummy.scale.set(1, h / WALL_BRICK_H, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          color.set(blockHex(alongIdx + salt, r * 31 + (horizontal ? wall.r : wall.c) * 3 + salt, material));
          mesh.setColorAt(i, color);
          i += 1;
        }
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [wall, material, solid, rows, sub, size, horizontal, edgeOffset, salt, dummy]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} castShadow receiveShadow frustumCulled={false}>
      <boxGeometry args={horizontal ? [size * 0.98, WALL_BRICK_H * 0.96, WALL_BRICK_T] : [WALL_BRICK_T, WALL_BRICK_H * 0.96, size * 0.98]} />
      <meshStandardMaterial roughness={0.86} metalness={0.02} envMapIntensity={0.25} />
    </instancedMesh>
  );
}

function Wall({ wall }: { wall: WallSpec }) {
  if (wall.material) return <WallBlocks wall={wall} material={wall.material} />;
  return <WallSlab wall={wall} />;
}

function WallSlab({ wall }: { wall: WallSpec }) {
  const body = useMat(wall.color ?? WALL_COLOR, { roughness: 0.82 });
  const cap = useMat(wall.cap ?? WALL_CAP, { roughness: 0.78 });
  const t = 0.16 * TILE;
  const segments = useMemo(() => {
    const open = new Set(wall.openings ?? []);
    const runs: { start: number; len: number }[] = [];
    let start: number | null = null;
    for (let i = 0; i <= wall.len; i += 1) {
      const solid = i < wall.len && !open.has(i);
      if (solid && start == null) start = i;
      if (!solid && start != null) {
        runs.push({ start, len: i - start });
        start = null;
      }
    }
    return runs;
  }, [wall]);

  return (
    <group>
      {segments.map(({ start, len }) => {
        const horizontal = wall.dir === "h";
        const along = len * TILE;
        const edgeOffset = wall.side === "n" || wall.side === "w" ? -0.5 : 0.5;
        const cx = horizontal
          ? (wall.c + start + (len - 1) / 2) * TILE
          : (wall.c + edgeOffset) * TILE;
        const cz = horizontal
          ? (wall.r + edgeOffset) * TILE
          : (wall.r + start + (len - 1) / 2) * TILE;
        return (
          <group key={start} position={[cx, 0, cz]}>
            <mesh position={[0, wall.height / 2, 0]} material={body} castShadow receiveShadow>
              <boxGeometry args={horizontal ? [along, wall.height, t] : [t, wall.height, along]} />
            </mesh>
            <mesh position={[0, wall.height + 0.04, 0]} material={cap} castShadow>
              <boxGeometry args={horizontal ? [along + t, 0.08, t * 1.6] : [t * 1.6, 0.08, along + t]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const STAIR_STEPS = 4;

function Stair({ stair }: { stair: StairSpec }) {
  const mat = useMat("#c2b89f", { roughness: 0.8 });
  const rise = (stair.toLevel - stair.fromLevel) * ELEV;
  const base = stair.fromLevel * ELEV + DECK_BLOCK;
  const yaw = { n: 0, e: -Math.PI / 2, s: Math.PI, w: Math.PI / 2 }[stair.dir];
  return (
    <group position={[stair.at.col * TILE, base, stair.at.row * TILE]} rotation-y={yaw}>
      {Array.from({ length: STAIR_STEPS }, (_, i) => {
        const h = (rise * (i + 1)) / STAIR_STEPS;
        const depth = TILE / STAIR_STEPS;
        const z = TILE / 2 - depth / 2 - i * depth;
        return (
          <mesh key={i} position={[0, h / 2, z]} material={mat} castShadow receiveShadow>
            <boxGeometry args={[TILE * 0.88, h, depth]} />
          </mesh>
        );
      })}
    </group>
  );
}

type PathCellSpec = { col: number; row: number; y: number };

/** Every walk cell in the scene as ONE instanced mesh — shared geometry,
 * shared material, per-instance color — instead of a mesh + material per
 * cell. Rides the same foundation wave as the ground bricks. */
function PathBlocks({ cells, origin, material }: { cells: PathCellSpec[]; origin: number; material?: PlatformMaterial }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const born = useRef(0);
  const done = useRef(false);

  useLayoutEffect(() => {
    born.current = currentWave()?.born ?? performance.now();
    done.current = false;
    const mesh = meshRef.current;
    if (!mesh) return;
    const color = new THREE.Color();
    cells.forEach((c, i) => {
      dummy.position.set(c.col * TILE, c.y + 0.02 + DROP, c.row * TILE);
      dummy.scale.setScalar(0.04);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(pathHexFor(c.col, c.row, material));
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [cells, material, dummy]);

  useFrame(() => {
    if (done.current || born.current === 0) return;
    const mesh = meshRef.current;
    if (!mesh) return;
    const t0 = (performance.now() - born.current) / 1000;
    let remaining = false;
    cells.forEach((c, i) => {
      const t = t0 - dropDelay(c.col * GROUND_SUB, c.row * GROUND_SUB, origin);
      if (t < 0) {
        remaining = true;
        dummy.position.set(c.col * TILE, c.y + 0.02 + DROP, c.row * TILE);
        dummy.scale.setScalar(0.04);
      } else if (t >= SNAP) {
        dummy.position.set(c.col * TILE, c.y + 0.02, c.row * TILE);
        dummy.scale.setScalar(1);
      } else {
        remaining = true;
        dummy.position.set(c.col * TILE, c.y + 0.02 + DROP * (1 - easeOut(t / SNAP)), c.row * TILE);
        dummy.scale.setScalar(legoPop(t));
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (!remaining) done.current = true;
  });

  return (
    <instancedMesh
      key={cells.length}
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, cells.length)]}
      receiveShadow
      frustumCulled={false}
    >
      <boxGeometry args={[TILE * 0.55, 0.04, TILE * 0.55]} />
      <meshStandardMaterial roughness={0.88} metalness={0.02} />
    </instancedMesh>
  );
}

/** The wave restarts only when the architecture itself changes — module
 * state, like the wave clock in legoDrop, because it must be read and set
 * during render (children mounting in the same pass ride the same wave). */
let lastWaveKey: string | null = null;

/** memo: the architecture only re-renders when the environment actually
 * changes — hover/selection churn in the stage above never reaches it. */
export const Environment3D = memo(function Environment3D({
  env,
  autoPads,
  surfaceYAt,
}: {
  env: EnvironmentSpec | null;
  autoPads: LotRect[];
  surfaceYAt: (col: number, row: number) => number;
}) {
  const origin = useMemo(() => {
    const rects: LotRect[] = [
      ...(env?.platforms.map((p) => p.rect) ?? []),
      ...autoPads,
      ...(env?.water.map((w) => w.rect) ?? []),
    ];
    return waveOrigin(rects);
  }, [env, autoPads]);

  // Start the shared drop clock during render so pieces that mount in this
  // same pass (compose, share URL, reference scene) see the wave before paint.
  const envId = env
    ? `${env.platforms.map((p) => `${p.id}:${p.rect.c0}:${p.rect.r0}:${p.rect.w}x${p.rect.d}:${p.level}`).join("|")}/${env.water.map((w) => `${w.id}:${w.rect.c0}:${w.rect.r0}`).join("|")}`
    : "empty";
  if (lastWaveKey !== envId) {
    // Deliberate render-time side effect: children mounting in this same
    // pass read the wave clock before paint — an effect fires too late.
    // eslint-disable-next-line react-hooks/globals
    lastWaveKey = envId;
    startFoundationWave(origin);
  }

  // Themed material patches: one lookup shared by every land platform strip.
  const ground = env?.ground;
  const cellMaterial = useMemo(() => {
    if (!ground?.length) return undefined;
    const map = new Map<string, PlatformMaterial>();
    for (const g of ground) map.set(`${g.col}:${g.row}`, g.m);
    return (col: number, row: number) => map.get(`${col}:${row}`);
  }, [ground]);

  const waterCells = env?.waterCells;
  const cellWaterTone = useMemo(() => {
    if (!waterCells?.length) return undefined;
    const map = new Map<string, WaterTone>();
    for (const w of waterCells) map.set(`${w.col}:${w.row}`, w.t);
    return (col: number, row: number) => map.get(`${col}:${row}`);
  }, [waterCells]);

  const paths = env?.paths;
  const pathCells = useMemo(
    () =>
      (paths ?? []).flatMap((path) =>
        path.cells.map((cell) => ({ col: cell.col, row: cell.row, y: surfaceYAt(cell.col, cell.row) })),
      ),
    [paths, surfaceYAt],
  );

  // A raised platform's column rests on the highest platform beneath each
  // of its lots (the island under a hill, a hill tier under the next), and
  // reaches the plinth only where nothing is beneath (a ridge past the
  // coast). Coplanar column faces were z-fighting as shimmer on hillsides.
  const platformsRef = env?.platforms;
  const bottomFor = useMemo(() => {
    const all = (platformsRef ?? []).filter((p) => !p.inset);
    const topOf = (p: (typeof all)[number]) => p.level * ELEV + (p.lift ?? 0);
    return (self: (typeof all)[number]) => (col: number, row: number) => {
      let best = -PLINTH_DEPTH;
      for (const q of all) {
        if (q === self || q.level >= self.level) continue;
        if (col < q.rect.c0 || col >= q.rect.c0 + q.rect.w || row < q.rect.r0 || row >= q.rect.r0 + q.rect.d) continue;
        best = Math.max(best, topOf(q) + DECK_BLOCK);
      }
      return best;
    };
  }, [platformsRef]);

  return (
    <group>
      {env?.platforms.map((p) => (
        <Platform
          key={`${p.id}-${p.rect.c0}-${p.rect.r0}-${p.rect.w}x${p.rect.d}-${p.material}`}
          rect={p.rect}
          level={p.level}
          material={p.material}
          inset={p.inset}
          lift={p.lift}
          origin={origin}
          cellMaterial={p.inset || p.level > 0 ? undefined : cellMaterial}
          cellBottom={p.level > 0 && !p.inset ? bottomFor(p) : undefined}
        />
      ))}
      {autoPads.map((pad, i) => (
        <Platform key={`auto-${i}-${pad.c0}-${pad.r0}-${pad.w}x${pad.d}`} rect={pad} level={0} material="grass" origin={origin} />
      ))}
      {env?.walls.map((w) => {
        const y = surfaceYAt(w.c, w.r);
        return (
          <group key={w.id} position={[0, y, 0]}>
            <SnapDown delay={dropDelay(w.c * GROUND_SUB, w.r * GROUND_SUB, origin)} bornAt={currentWave()?.born}>
              <Wall wall={w} />
            </SnapDown>
          </group>
        );
      })}
      {env?.stairs.map((s) => (
        <SnapDown key={s.id} delay={dropDelay(s.at.col * GROUND_SUB, s.at.row * GROUND_SUB, origin)} bornAt={currentWave()?.born}>
          <Stair stair={s} />
        </SnapDown>
      ))}
      {pathCells.length > 0 && <PathBlocks cells={pathCells} origin={origin} material={env?.pathMaterial} />}
      {env?.water.map((w) => {
        const top = w.level * ELEV - 0.22;
        const height = top + PLINTH_DEPTH - 0.05;
        return (
          <GroundBlocks
            key={`${w.id}-${w.rect.c0}-${w.rect.r0}`}
            rect={w.rect}
            top={top}
            bottom={top - height}
            material="sand"
            origin={origin}
            kind="water"
            cellWaterTone={cellWaterTone}
          />
        );
      })}
    </group>
  );
});
