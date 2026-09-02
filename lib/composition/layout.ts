import type { CatalogItem, CatalogKind } from "../catalog";
import { roleOf, type Role } from "./roles";
import { bodiesCollide, type Body } from "./scale3d";
import type { ZoneType } from "./types";

/**
 * Layout primitives shared by both composers (the archetype program and the
 * selection-driven fallback): occupancy bookkeeping during planning, facing
 * math, and the selection → zone program that decides which extra places a
 * theme implies (boats want a harbor, cars want a street).
 */

export type OccupiedBody = Body;

export type Placement = {
  item: CatalogItem;
  col: number;
  row: number;
  flip?: boolean;
  rot?: number;
  reason: string;
  /** Archetype bookkeeping — zone id, element role, and build phase. */
  zone?: string;
  role?: string;
  phase?: PlanPhase;
  /** Where the composition wanted it; differs from col/row only after a nudge. */
  intended?: { col: number; row: number };
};

export type PlanPhase = "focal" | "populate" | "people" | "environment";

export function key(col: number, row: number) {
  return `${col}:${row}`;
}

/** Facing rotation that points a piece from (col,row) toward a target cell. */
export function faceToward(col: number, row: number, target: { col: number; row: number }): number {
  const dc = target.col - col;
  const dr = target.row - row;
  if (Math.abs(dc) >= Math.abs(dr)) return dc >= 0 ? 270 : 90; // east : west
  return dr >= 0 ? 0 : 180; // south : north
}

/** Unit grid vector a piece with `rot` faces: 0 south, 90 west, 180 north, 270 east. */
export function facingVector(rot: number | undefined): { dc: number; dr: number } {
  switch (((rot ?? 0) % 360 + 360) % 360) {
    case 90:
      return { dc: -1, dr: 0 };
    case 180:
      return { dc: 0, dr: -1 };
    case 270:
      return { dc: 1, dr: 0 };
    default:
      return { dc: 0, dr: 1 };
  }
}

/**
 * Occupancy bookkeeping during composition. `taken` is hard (a body stands
 * there); `softReserved` is circulation — paths and breathing room that
 * props avoid and people may stand on.
 */
export class Board {
  taken = new Set<string>();
  softReserved = new Set<string>();
  bodies: OccupiedBody[] = [];

  constructor(occupied: Iterable<OccupiedBody>) {
    for (const body of occupied) {
      this.taken.add(key(body.col, body.row));
      this.bodies.push({ col: body.col, row: body.row, r: body.r });
    }
  }

  free(col: number, row: number, allowSoft = false, radius = 0.48, kind?: CatalogKind): boolean {
    const k = key(col, row);
    if (this.taken.has(k)) return false;
    if (!allowSoft && this.softReserved.has(k)) return false;
    const next: Body = { col, row, r: radius, kind };
    for (const body of this.bodies) {
      if (bodiesCollide(next, body)) return false;
    }
    return true;
  }

  claim(
    col: number,
    row: number,
    allowSoft = false,
    valid?: (col: number, row: number) => boolean,
    radius = 0.48,
    kind?: CatalogKind,
  ): boolean {
    if (valid && !valid(col, row)) return false;
    if (!this.free(col, row, allowSoft, radius, kind)) return false;
    this.taken.add(key(col, row));
    this.bodies.push({ col, row, r: radius, kind });
    return true;
  }

  /**
   * Claim the cell or the nearest free cell within `ring` steps. `valid`
   * fences the search to the intended zone and level — a fallback cell must
   * never escape the place it was meant for.
   */
  claimNear(
    col: number,
    row: number,
    ring = 1,
    allowSoft = false,
    valid?: (col: number, row: number) => boolean,
    radius = 0.48,
    kind?: CatalogKind,
  ): { col: number; row: number } | null {
    for (let r = 0; r <= ring; r += 1) {
      for (let dc = -r; dc <= r; dc += 1) {
        for (let dr = -r; dr <= r; dr += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
          if (this.claim(col + dc, row + dr, allowSoft, valid, radius, kind)) {
            return { col: col + dc, row: row + dr };
          }
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zone program — what places does a SELECTION imply? (the fallback composer's
// only source of zones, and the archetype composer's source of extras)
// ---------------------------------------------------------------------------

export type ZonePlan = { type: ZoneType; label: string };

export const INTERIOR_BY_KIND: Partial<Record<CatalogKind, ZonePlan>> = {
  furniture: { type: "home", label: "the house" },
  machine: { type: "arcade", label: "the hall" },
  dungeon: { type: "keep", label: "the keep" },
  cave: { type: "keep", label: "the hollow" },
  space: { type: "lab", label: "the station" },
};

export type ZoneProgram = {
  interior: ZonePlan | null;
  market: boolean;
  garden: boolean;
  harbor: boolean;
  street: boolean;
  skyline: boolean;
};

export function groupByRole(items: CatalogItem[]): Record<Role, CatalogItem[]> {
  const byRole: Record<Role, CatalogItem[]> = {
    ground: [], wall: [], connector: [], structure: [], backdrop: [],
    track: [], tabletop: [], vessel: [], vehicle: [], person: [], scenery: [],
  };
  for (const item of items) byRole[roleOf(item)].push(item);
  return byRole;
}

export function planZones(byRole: Record<Role, CatalogItem[]>): ZoneProgram {
  const interiorCounts = new Map<CatalogKind, number>();
  for (const item of byRole.structure) {
    const plan = INTERIOR_BY_KIND[item.kind];
    if (plan) interiorCounts.set(item.kind, (interiorCounts.get(item.kind) ?? 0) + 1);
  }
  let interior: ZonePlan | null = null;
  let best = 0;
  for (const [kind, count] of interiorCounts) {
    if (count >= 4 && count > best) {
      best = count;
      interior = INTERIOR_BY_KIND[kind] ?? null;
    }
  }
  const stalls = byRole.structure.filter((i) => i.kind === "stall").length;
  return {
    interior,
    market: stalls >= 2 && interior?.type !== "home",
    garden: byRole.scenery.length + byRole.ground.length >= 5,
    harbor: byRole.vessel.length >= 1,
    street: byRole.vehicle.length >= 2,
    skyline: byRole.backdrop.length >= 2,
  };
}
