"use client";

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { LotRect } from "@/lib/composition/grid3d";
import { GROUND_SUB } from "./terrainLook";
import { renderClock } from "./stageState";

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

let restarts = 0;

export function startFoundationWave(origin: number) {
  wave = { born: performance.now(), origin };
  restarts += 1;
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    (window as unknown as { __wave?: () => { born: number; origin: number; restarts: number } | null }).__wave = () => (wave ? { ...wave, restarts } : null);
  }
}

export function currentWave(): Wave | null {
  return wave;
}

/** A wave older than this has landed; bricks mounting after it (ground
 * grown onto a standing scene) drop on their own short clock. */
const WAVE_FRESH_MS = 3000;

/**
 * The clock a strip of bricks should drop on: the shared foundation wave
 * while it is still sweeping, else a fresh one starting now from the strip's
 * own corner — so new ground lands in a beat instead of waiting out a wave
 * measured from the far side of the island, or popping in with no drop.
 */
export function waveFor(rect: { c0: number; r0: number }): Wave {
  const now = performance.now();
  if (wave && now - wave.born < WAVE_FRESH_MS) return wave;
  return { born: now, origin: (rect.c0 + rect.r0) * GROUND_SUB };
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
    // The renderer draws on demand: a drop must ask for its frames.
    renderClock.animating();
  }, [delay, bornAt]);
  useFrame(() => {
    const g = ref.current;
    if (!g || done.current || born.current === 0) return;
    const t = (performance.now() - born.current) / 1000 - delay;
    if (t < 0 && t > -60) {
      g.position.y = DROP;
      g.scale.setScalar(0);
      renderClock.animating();
      return;
    }
    // A clock that is minutes off (a stale wave captured at mount) lands now.
    if (t >= SNAP || t <= -60) {
      g.position.y = 0;
      g.scale.setScalar(1);
      done.current = true;
      renderClock.markSceneDirty();
      return;
    }
    const e = easeOut(t / SNAP);
    g.position.y = DROP * (1 - e);
    g.scale.setScalar(legoPop(t));
    renderClock.animating();
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
