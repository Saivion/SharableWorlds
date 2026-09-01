"use client";

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { LotRect } from "@/lib/composition/grid3d";
import { GROUND_SUB } from "./terrainLook";

/**
 * One clock for the Lego drop. Foundation bricks and the pieces that stand
 * on them share it, so a compose never shows ships sitting on the paper
 * while the island is still in the air.
 */

export const DROP = 5.4;
export const SNAP = 0.48;
export const WAVE = 0.016;

export function easeOut(t: number) {
  const u = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - u, 3);
}

export function dropDelay(gx: number, gz: number, origin: number) {
  return Math.max(0, (gx + gz - origin) * WAVE);
}

export function waveOrigin(rects: LotRect[]): number {
  let minC = Infinity;
  let minR = Infinity;
  for (const r of rects) {
    if (r.c0 < minC) minC = r.c0;
    if (r.r0 < minR) minR = r.r0;
  }
  if (!Number.isFinite(minC)) return 0;
  return (minC + minR) * GROUND_SUB;
}

export function legoPop(t: number) {
  const u = t / SNAP;
  if (u < 0.82) return 0.2 + easeOut(u) * 0.92;
  return 1 + Math.sin(((u - 0.82) / 0.18) * Math.PI) * 0.08;
}

type Wave = { born: number; origin: number };

let wave: Wave | null = null;

export function startFoundationWave(origin: number) {
  wave = { born: performance.now(), origin };
}

export function currentWave(): Wave | null {
  return wave;
}

export type PieceSnap = { delay: number; bornAt: number };

/** Delay for a lot if its brick is still in the air; null once that cell has landed. */
export function pieceWaveSnap(col: number, row: number): PieceSnap | null {
  if (!wave) return null;
  const delay = dropDelay(col * GROUND_SUB, row * GROUND_SUB, wave.origin);
  const t = (performance.now() - wave.born) / 1000 - delay;
  if (t >= SNAP) return null;
  return { delay, bornAt: wave.born };
}

/** One piece falling in from above and snapping down — Lego click. */
export function SnapDown({
  delay = 0,
  bornAt,
  children,
}: {
  delay?: number;
  bornAt?: number;
  children: ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  const born = useRef(0);
  const done = useRef(false);
  useLayoutEffect(() => {
    born.current = bornAt ?? performance.now();
    done.current = false;
    const g = ref.current;
    if (g) {
      g.position.y = DROP;
      g.scale.setScalar(0);
    }
  }, [delay, bornAt]);
  useFrame(() => {
    const g = ref.current;
    if (!g || done.current || born.current === 0) return;
    const t = (performance.now() - born.current) / 1000 - delay;
    if (t < 0) {
      g.position.y = DROP;
      g.scale.setScalar(0);
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
    <group ref={ref} position={[0, DROP, 0]} scale={0}>
      {children}
    </group>
  );
}

/**
 * Capture-on-mount: if this lot's brick is still falling, ride the same
 * wave. Later placements (agent hop, human click) skip and grow in place.
 */
export function PieceArrive({
  col,
  row,
  children,
}: {
  col: number;
  row: number;
  children: (snapping: boolean) => ReactNode;
}) {
  const [snap] = useState(() => pieceWaveSnap(col, row));
  const inner = children(snap != null);
  if (!snap) return inner;
  return (
    <SnapDown delay={snap.delay} bornAt={snap.bornAt}>
      {inner}
    </SnapDown>
  );
}
