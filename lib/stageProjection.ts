"use client";

/**
 * Stage projection registry — the seam between the agent-cursor choreography
 * (screen-space, lib/agentMotion.ts) and whichever stage is rendering.
 *
 * The 3D stage registers a projector (lot -> client px through its camera);
 * agentMotion asks here first and falls back to the legacy SVG CTM lookup.
 */

export type LotProjector = (lot: string) => { x: number; y: number } | null;

let projector: LotProjector | null = null;

export function registerLotProjector(fn: LotProjector | null) {
  projector = fn;
}

export function projectLot(lot: string): { x: number; y: number } | null {
  return projector ? projector(lot) : null;
}
