import { CATALOG, type CatalogItem, type CatalogKind } from "../catalog";
import { TILE } from "./grid3d";

/**
 * Asset normalization — one consistent miniature world scale.
 *
 * Kenney kits do not share units (a space "room" is 20 units, a burger 0.38),
 * so raw GLB size means nothing across packs. Normalization works in two
 * steps, mirroring lib/iso.ts's KIND_SCALE philosophy:
 *
 *  1. every kind has a canonical target size as a fraction of a lot — a
 *     character is always about three quarters of a lot tall, a food item
 *     always small, a building always over a lot wide;
 *  2. WITHIN a pack, an item keeps its relative size (a pirate flagship
 *     outsizes a rowboat) via a damped ratio to the pack median, clamped so
 *     no single model swallows the diorama.
 */

type KindScale = {
  /** Which raw dimension is canonical: footprint (max of w,d) or height. */
  axis: "xz" | "y";
  /** Canonical size as a fraction of TILE. */
  frac: number;
  /** Clamp range for the within-pack relative boost. */
  boost: [number, number];
};

const KIND_SCALE_3D: Record<CatalogKind, KindScale> = {
  character: { axis: "y", frac: 0.74, boost: [0.85, 1.2] },
  pet: { axis: "y", frac: 0.42, boost: [0.7, 1.4] },
  tree: { axis: "y", frac: 1.15, boost: [0.6, 1.7] },
  nature: { axis: "xz", frac: 0.8, boost: [0.45, 2.2] },
  prop: { axis: "xz", frac: 0.6, boost: [0.5, 1.9] },
  crate: { axis: "xz", frac: 0.5, boost: [0.6, 1.5] },
  stall: { axis: "xz", frac: 0.95, boost: [0.7, 1.5] },
  machine: { axis: "xz", frac: 0.72, boost: [0.7, 1.6] },
  ramp: { axis: "xz", frac: 1.0, boost: [0.6, 2.0] },
  dungeon: { axis: "xz", frac: 0.8, boost: [0.6, 2.0] },
  boat: { axis: "xz", frac: 1.4, boost: [0.55, 1.5] },
  pirate: { axis: "xz", frac: 0.75, boost: [0.5, 2.6] },
  car: { axis: "xz", frac: 1.05, boost: [0.8, 1.4] },
  other: { axis: "xz", frac: 0.7, boost: [0.6, 1.6] },
  food: { axis: "xz", frac: 0.32, boost: [0.6, 1.3] },
  furniture: { axis: "xz", frac: 0.78, boost: [0.55, 1.7] },
  building: { axis: "xz", frac: 1.5, boost: [0.7, 1.8] },
  cave: { axis: "xz", frac: 1.1, boost: [0.5, 2.0] },
  space: { axis: "xz", frac: 1.1, boost: [0.5, 2.0] },
  coaster: { axis: "xz", frac: 1.0, boost: [0.5, 2.0] },
};

const FALLBACK: KindScale = { axis: "xz", frac: 0.7, boost: [0.6, 1.6] };

function rawDim(item: CatalogItem, axis: "xz" | "y"): number {
  const size = item.size;
  if (!size) return 1;
  return axis === "y" ? Math.max(size[1], 0.001) : Math.max(size[0], size[2], 0.001);
}

/** Median canonical dimension per pack+axis, computed once. */
const medians = new Map<string, number>();

function packMedian(pack: string, axis: "xz" | "y"): number {
  const key = `${pack}:${axis}`;
  const cached = medians.get(key);
  if (cached != null) return cached;
  const dims = CATALOG.filter((i) => i.pack === pack && i.size)
    .map((i) => rawDim(i, axis))
    .sort((a, b) => a - b);
  const median = dims.length ? dims[Math.floor(dims.length / 2)] : 1;
  medians.set(key, median);
  return median;
}

export type ModelScale = {
  /** Uniform scale applied to the raw GLB. */
  scale: number;
  /** Scaled footprint in lots — how much floor the piece actually claims. */
  footprint: number;
  /** Scaled height in world units. */
  height: number;
};

export function modelScale(item: CatalogItem): ModelScale {
  const spec = KIND_SCALE_3D[item.kind] ?? FALLBACK;
  const dim = rawDim(item, spec.axis);
  const rel = dim / packMedian(item.pack, spec.axis);
  const boost = Math.min(spec.boost[1], Math.max(spec.boost[0], Math.sqrt(Math.max(rel, 0.0001))));
  const target = spec.frac * TILE * boost;
  const scale = target / dim;
  const size = item.size ?? [1, 1, 1];
  return {
    scale,
    footprint: (Math.max(size[0], size[2]) * scale) / TILE,
    height: size[1] * scale,
  };
}

const TIGHT_KINDS = new Set<CatalogKind>(["food", "crate", "character", "pet"]);
const BULKY_KINDS = new Set<CatalogKind>([
  "tree",
  "nature",
  "building",
  "boat",
  "cave",
  "space",
  "coaster",
]);

/**
 * Radius in lot units around a piece's lot center that other meshes must
 * stay out of. Catalog occupancy is one cell; Kenney models often span more
 * than that (logs, canopies, hulls), so the composer and the live placer
 * both use this instead of a single-lot lock.
 *
 * Diagonal neighbors are only 1.41 lots apart — two wide pieces on a
 * diagonal still clip, so bulky radii are sized to forbid that.
 */
export function clearanceLots(item: CatalogItem): number {
  const { footprint } = modelScale(item);
  if (TIGHT_KINDS.has(item.kind)) return Math.max(0.32, footprint * 0.42);
  if (item.kind === "tree") return Math.max(0.78, footprint * 0.5 + 0.28);
  const bulky =
    BULKY_KINDS.has(item.kind) ||
    ((item.kind === "prop" || item.kind === "stall" || item.kind === "dungeon") && footprint >= 0.5);
  if (bulky) return Math.max(0.68, footprint * 0.5 + 0.28);
  return Math.max(0.5, footprint * 0.5 + 0.18);
}

export function bodiesOverlap(
  a: { col: number; row: number; r: number },
  b: { col: number; row: number; r: number },
): boolean {
  return Math.hypot(a.col - b.col, a.row - b.row) < a.r + b.r;
}
