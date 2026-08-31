"use client";

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { DECK_BLOCK, ELEV, PLINTH_DEPTH, TILE, type LotRect } from "@/lib/composition/grid3d";
import type { EnvironmentSpec, PlatformMaterial, StairSpec, WallSpec } from "@/lib/composition/types";
import {
  GROUND_SUB,
  blockHex,
  blockLift,
  getGrainTexture,
  hash2,
  isRubble,
  pathHex,
  rubbleHex,
  waterHex,
} from "./terrainLook";

/**
 * The architecture layer — everything the scene stands on. The island is
 * Lego columns: foundation and deck are one brick per cell, falling in one
 * wave. No slab first, no texture rain after.
 */

const WALL_COLOR = "#e4dccb";
const WALL_CAP = "#b9a98d";
const DROP = 5.4;
const SNAP = 0.48;
const WAVE = 0.016;

function easeOut(t: number) {
  const u = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - u, 3);
}

function dropDelay(gx: number, gz: number, origin: number) {
  return Math.max(0, (gx + gz - origin) * WAVE);
}

function waveOrigin(rects: LotRect[]): number {
  let minC = Infinity;
  let minR = Infinity;
  for (const r of rects) {
    if (r.c0 < minC) minC = r.c0;
    if (r.r0 < minR) minR = r.r0;
  }
  if (!Number.isFinite(minC)) return 0;
  return (minC + minR) * GROUND_SUB;
}

function legoPop(t: number) {
  const u = t / SNAP;
  if (u < 0.82) return 0.2 + easeOut(u) * 0.92;
  return 1 + Math.sin(((u - 0.82) / 0.18) * Math.PI) * 0.08;
}

/** One piece falling in from above and snapping down — Lego click. */
function SnapDown({
  delay = 0,
  children,
}: {
  delay?: number;
  children: ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  const born = useRef(0);
  const done = useRef(false);
  useLayoutEffect(() => {
    born.current = performance.now();
    done.current = false;
    const g = ref.current;
    if (g) {
      g.position.y = DROP;
      g.scale.setScalar(0.04);
    }
  }, [delay]);
  useFrame(() => {
    const g = ref.current;
    if (!g || done.current || born.current === 0) return;
    const t = (performance.now() - born.current) / 1000 - delay;
    if (t < 0) {
      g.position.y = DROP;
      g.scale.setScalar(0.04);
      return;
    }
    if (t >= SNAP) {
      g.position.y = 0;
      g.scale.setScalar(1);
      done.current = true;
      return;
    }
    const e = easeOut(t / SNAP);
    g.position.y = DROP * (1 - e);
    g.scale.setScalar(legoPop(t));
  });
  return (
    <group ref={ref} position={[0, DROP, 0]} scale={0.04}>
      {children}
    </group>
  );
}

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

type RubbleBrick = Brick & { sx: number; sz: number };

function GroundBlocks({
  rect,
  top,
  bottom,
  material,
  origin,
  kind = "land",
}: {
  rect: LotRect;
  top: number;
  bottom: number;
  material: PlatformMaterial;
  origin: number;
  kind?: "land" | "water";
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const rubbleRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const born = useRef(0);
  const done = useRef(false);
  const rest = useRef<Brick[]>([]);
  const rubbleRest = useRef<RubbleBrick[]>([]);
  const wet = kind === "water";
  const sub = GROUND_SUB;
  const size = TILE / sub;
  const count = Math.max(1, rect.w * rect.d * sub * sub);

  const rubbleSpots = useMemo(() => {
    if (wet) return [] as { gx: number; gz: number; x: number; z: number }[];
    const spots: { gx: number; gz: number; x: number; z: number }[] = [];
    for (let dr = 0; dr < rect.d; dr += 1) {
      for (let dc = 0; dc < rect.w; dc += 1) {
        for (let sz = 0; sz < sub; sz += 1) {
          for (let sx = 0; sx < sub; sx += 1) {
            const gx = (rect.c0 + dc) * sub + sx;
            const gz = (rect.r0 + dr) * sub + sz;
            if (!isRubble(gx, gz)) continue;
            const ox = (sx + 0.5 - sub / 2) * size;
            const oz = (sz + 0.5 - sub / 2) * size;
            spots.push({ gx, gz, x: (rect.c0 + dc) * TILE + ox, z: (rect.r0 + dr) * TILE + oz });
          }
        }
      }
    }
    return spots;
  }, [rect.c0, rect.r0, rect.w, rect.d, wet, sub, size]);

  useLayoutEffect(() => {
    born.current = performance.now();
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
            const h = Math.max(DECK_BLOCK, top + cap - bottom);
            const delay = dropDelay(gx, gz, origin);
            cells.push({
              x: (rect.c0 + dc) * TILE + ox,
              y: bottom + h / 2,
              z: (rect.r0 + dr) * TILE + oz,
              sy: h / DECK_BLOCK,
              delay,
            });
            dummy.position.set(cells[i].x, cells[i].y + DROP, cells[i].z);
            dummy.scale.set(0.04, 0.04, 0.04);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            color.set(wet ? waterHex(gx, gz) : blockHex(gx, gz, material));
            mesh.setColorAt(i, color);
            i += 1;
          }
        }
      }
    }
    rest.current = cells;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const rubble = rubbleRef.current;
    const rubbleCells: RubbleBrick[] = [];
    if (rubble) {
      rubbleSpots.forEach((spot, ri) => {
        const h = hash2(spot.gx, spot.gz);
        const s = 0.28 + (h % 5) * 0.04;
        const rh = 0.18 + (h % 3) * 0.08;
        const jx = ((h % 7) - 3) * 0.04;
        const jz = (((h >> 3) % 7) - 3) * 0.04;
        const lift = blockLift(spot.gx, spot.gz);
        rubbleCells.push({
          x: spot.x + jx,
          y: top + DECK_BLOCK + lift + rh / 2,
          z: spot.z + jz,
          sx: s / 0.4,
          sy: rh / 0.4,
          sz: s / 0.4,
          delay: dropDelay(spot.gx, spot.gz, origin),
        });
        dummy.position.set(rubbleCells[ri].x, rubbleCells[ri].y + DROP, rubbleCells[ri].z);
        dummy.scale.set(0.04, 0.04, 0.04);
        dummy.updateMatrix();
        rubble.setMatrixAt(ri, dummy.matrix);
        color.set(rubbleHex(spot.gx, spot.gz));
        rubble.setColorAt(ri, color);
      });
      rubble.instanceMatrix.needsUpdate = true;
      if (rubble.instanceColor) rubble.instanceColor.needsUpdate = true;
    }
    rubbleRest.current = rubbleCells;
  }, [rect.c0, rect.r0, rect.w, rect.d, material, wet, top, bottom, origin, sub, size, dummy, rubbleSpots]);

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
    const rubble = rubbleRef.current;
    if (rubble) {
      rubbleRest.current.forEach((cell, i) => {
        const t = t0 - cell.delay;
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
        rubble.setMatrixAt(i, dummy.matrix);
      });
      rubble.instanceMatrix.needsUpdate = true;
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
      {rubbleSpots.length > 0 && (
        <instancedMesh
          ref={rubbleRef}
          args={[undefined, undefined, rubbleSpots.length]}
          castShadow
          receiveShadow
          frustumCulled={false}
        >
          <boxGeometry args={[0.4, 0.4, 0.4]} />
          <meshStandardMaterial roughness={0.9} metalness={0.04} envMapIntensity={0.2} />
        </instancedMesh>
      )}
    </group>
  );
}

function Platform({
  rect,
  level,
  material,
  inset,
  origin,
}: {
  rect: LotRect;
  level: number;
  material: PlatformMaterial;
  inset?: boolean;
  origin: number;
}) {
  const top = level * ELEV + (inset ? 0.06 : 0);
  const height = inset ? 0.06 : top + PLINTH_DEPTH;
  const bottom = top - height;
  return <GroundBlocks rect={rect} top={top} bottom={bottom} material={material} origin={origin} />;
}

function Wall({ wall }: { wall: WallSpec }) {
  const body = useMat(WALL_COLOR, { roughness: 0.82 });
  const cap = useMat(WALL_CAP, { roughness: 0.78 });
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

function PathCell({ col, row, y, origin }: { col: number; row: number; y: number; origin: number }) {
  const color = pathHex(col, row);
  return (
    <SnapDown delay={dropDelay(col * GROUND_SUB, row * GROUND_SUB, origin)}>
      <mesh position={[col * TILE, y + 0.02, row * TILE]} receiveShadow>
        <boxGeometry args={[TILE * 0.55, 0.04, TILE * 0.55]} />
        <meshStandardMaterial color={color} roughness={0.88} metalness={0.02} />
      </mesh>
    </SnapDown>
  );
}

export function Environment3D({
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

  return (
    <group>
      {env?.platforms.map((p) => (
        <Platform
          key={`${p.id}-${p.rect.c0}-${p.rect.r0}-${p.rect.w}x${p.rect.d}-${p.material}`}
          rect={p.rect}
          level={p.level}
          material={p.material}
          inset={p.inset}
          origin={origin}
        />
      ))}
      {autoPads.map((pad, i) => (
        <Platform key={`auto-${i}-${pad.c0}-${pad.r0}-${pad.w}x${pad.d}`} rect={pad} level={0} material="grass" origin={origin} />
      ))}
      {env?.walls.map((w) => {
        const y = surfaceYAt(w.c, w.r);
        return (
          <group key={w.id} position={[0, y, 0]}>
            <SnapDown delay={dropDelay(w.c * GROUND_SUB, w.r * GROUND_SUB, origin)}>
              <Wall wall={w} />
            </SnapDown>
          </group>
        );
      })}
      {env?.stairs.map((s) => (
        <SnapDown key={s.id} delay={dropDelay(s.at.col * GROUND_SUB, s.at.row * GROUND_SUB, origin)}>
          <Stair stair={s} />
        </SnapDown>
      ))}
      {env?.paths.map((path) =>
        path.cells.map((cell, i) => (
          <PathCell
            key={`${path.id}-${i}`}
            col={cell.col}
            row={cell.row}
            y={surfaceYAt(cell.col, cell.row)}
            origin={origin}
          />
        )),
      )}
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
          />
        );
      })}
    </group>
  );
}
