import { rectContains, type LotRect } from "./grid3d";
import { cellKey, maskToRects, type IslandMask } from "./island";
import type { ThemeSpec } from "./themes";
import type { EnvironmentSpec, PlatformMaterial, PlatformSpec } from "./types";

/**
 * Relief — seeded hills and mountains as CONTOUR TIERS.
 *
 * Like a contour map: a hill is a stack of organic terraces, each one level
 * higher and smaller than the one below, cut from the island's own cells.
 * Tiers are ordinary platforms, so pieces standing on them (a grove on the
 * slope, a watch tower on the summit) ground themselves automatically and
 * the renderer draws them as stepped voxel columns. Relief only rises where
 * nothing functional lives: outside every zone, off the walks, away from
 * stairs, piers, roads, and the waterline.
 *
 * Some scenes are flat, some rolling, some mountainous — decided by the
 * prompt ("hill", "mountain", "flat"), the archetype's hint, and otherwise
 * the seed. Same seed, same mountains.
 */

export type ReliefIntensity = "none" | "some" | "hills" | "mountains";

const MOUNTAIN_WORDS = /\b(mountain|mountains|peak|peaks|alpine|cliff|cliffs|highland|highlands|summit|volcano)\b/i;
const HILL_WORDS = /\b(hill|hills|hilly|hillside|valley|ridge|slope|slopes|rise|terraces?|rolling)\b/i;
const FLAT_WORDS = /\b(flat|plain|plains|floor|indoor|indoors)\b/i;

/** What the prompt, the archetype, and the seed say the ground should do. */
export function reliefIntensity(prompt: string, hint: ReliefIntensity | undefined, rng: () => number): ReliefIntensity {
  if (MOUNTAIN_WORDS.test(prompt)) return "mountains";
  if (HILL_WORDS.test(prompt)) return "hills";
  if (FLAT_WORDS.test(prompt)) return "none";
  const base = hint ?? "some";
  if (base !== "some") return base;
  // "some": every world gets relief — rolling hills or real peaks — and
  // only an explicit "flat" in the prompt keeps one level.
  return rng() < 0.45 ? "hills" : "mountains";
}

/** How far past the coastline a ridge may climb — mountains rise BEHIND the
 * island like a backdrop, not only on the thin rim between zones and sea. */
/** Extra world units per hill level on top of ELEV (0.7). */
const HILL_STEP_LIFT = 0.3;

const REACH_BEYOND_COAST: Record<ReliefIntensity, number> = { none: 0, some: 0, hills: 2, mountains: 4 };

function largestComponent(cells: Set<string>): Set<string> {
  const seen = new Set<string>();
  let best = new Set<string>();
  for (const start of cells) {
    if (seen.has(start)) continue;
    const comp = new Set<string>();
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const k = queue.pop()!;
      comp.add(k);
      const [c, r] = k.split(":").map(Number);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nk = cellKey(c + dc, r + dr);
        if (cells.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          queue.push(nk);
        }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

function bboxOf(cells: Set<string>): LotRect {
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (const k of cells) {
    const [c, r] = k.split(":").map(Number);
    c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
  }
  return Number.isFinite(c0) ? { c0, r0, w: c1 - c0 + 1, d: r1 - r0 + 1 } : { c0: 0, r0: 0, w: 0, d: 0 };
}

function capMaterial(theme: ThemeSpec, tier: number, tiers: number): PlatformMaterial {
  if (tier === 1) return theme.primary;
  if (tier === 2 && tiers > 2) return theme.secondary[0]?.m ?? theme.primary;
  // The summit: bare rock, or what the biome puts on its high ground.
  switch (theme.id) {
    case "snow":
      return "snow";
    case "volcanic":
      return "rock-dark";
    case "spooky":
    case "dungeon":
      return "stone-dark";
    case "desert":
    case "beach":
    case "pirate-isle":
      return "sand-dark";
    case "candy":
    case "toybox":
      return "candy-lilac";
    default:
      return tiers > 2 ? "stone" : theme.secondary[0]?.m ?? "stone";
  }
}

export type ReliefResult = { platforms: PlatformSpec[]; cells: Set<string>; peaks: { col: number; row: number; level: number }[] };

/**
 * Plan the hills. `avoid` holds cells that must stay flat (walks, stairs,
 * shorelines); every zone rect is kept flat as well.
 */
export function planRelief(
  island: IslandMask,
  env: EnvironmentSpec,
  theme: ThemeSpec,
  rng: () => number,
  intensity: ReliefIntensity,
  avoid: Set<string>,
): ReliefResult {
  const none: ReliefResult = { platforms: [], cells: new Set(), peaks: [] };
  if (intensity === "none") return none;
  const flatRects: LotRect[] = env.zones
    .filter((z) => z.type !== "harbor")
    .map((z) => (z.type === "plaza" ? z.rect : { c0: z.rect.c0 - 1, r0: z.rect.r0 - 1, w: z.rect.w + 2, d: z.rect.d + 2 }));
  const water = new Set<string>();
  for (const w of env.water) for (let r = w.rect.r0 - 1; r <= w.rect.r0 + w.rect.d; r += 1) for (let c = w.rect.c0 - 1; c <= w.rect.c0 + w.rect.w; c += 1) water.add(cellKey(c, r));
  const center = { col: island.bbox.c0 + island.bbox.w / 2, row: island.bbox.r0 + island.bbox.d / 2 };
  const reach = REACH_BEYOND_COAST[intensity];
  const candidates: { col: number; row: number }[] = [];
  const candidateKeys = new Set<string>();
  const consider = (col: number, row: number) => {
    const k = cellKey(col, row);
    if (candidateKeys.has(k) || avoid.has(k) || water.has(k)) return;
    if (flatRects.some((rect) => rectContains(rect, col, row))) return;
    // Off-island cells only in the ring behind the coast — never over the
    // entrance side (south), never inside another platform's footprint.
    if (!island.cells.has(k)) {
      if (row > center.row + island.bbox.d * 0.15) return;
      if (env.platforms.some((p) => rectContains(p.rect, col, row))) return;
    }
    candidateKeys.add(k);
    candidates.push({ col, row });
  };
  for (const k of island.cells) {
    const [col, row] = k.split(":").map(Number);
    consider(col, row);
  }
  if (reach > 0) {
    for (let row = island.bbox.r0 - reach; row < island.bbox.r0 + island.bbox.d + reach; row += 1) {
      for (let col = island.bbox.c0 - reach; col < island.bbox.c0 + island.bbox.w + reach; col += 1) {
        const k = cellKey(col, row);
        if (island.cells.has(k)) continue;
        // Within `reach` of the coast, measured to the nearest land cell.
        let near = false;
        for (let dr = -reach; dr <= reach && !near; dr += 1) for (let dc = -reach; dc <= reach; dc += 1) if (island.cells.has(cellKey(col + dc, row + dr))) { near = true; break; }
        if (near) consider(col, row);
      }
    }
  }
  if (candidates.length < 6) return none;
  const tiers = intensity === "mountains" ? 4 : 2;
  const hillCount = 1 + (rng() < (intensity === "mountains" ? 0.5 : 0.35) ? 1 : 0);
  const platforms: PlatformSpec[] = [];
  const allCells = new Set<string>();
  const peaks: ReliefResult["peaks"] = [];
  const seeds: { col: number; row: number }[] = [];

  for (let h = 0; h < hillCount; h += 1) {
    // Seed at the island's rim — behind and beside the action, never in it —
    // with seeded jitter so no two worlds crest in the same place.
    let seed: { col: number; row: number } | null = null;
    let best = -Infinity;
    for (const c of candidates) {
      if (seeds.some((s) => Math.hypot(s.col - c.col, s.row - c.row) < 7)) continue;
      // Far from the action, and preferably BEHIND it (north), so peaks
      // frame the scene instead of hiding it from the camera.
      const behind = c.row < center.row ? 2.5 : 0;
      const score = Math.hypot(c.col - center.col, c.row - center.row) + behind + rng() * 3.5;
      if (score > best) {
        best = score;
        seed = c;
      }
    }
    if (!seed) break;
    seeds.push(seed);
    const r1 = intensity === "mountains" ? 4.6 + rng() * 2.2 : 3 + rng() * 1.6;
    const wobble = rng() * Math.PI * 2;
    const ratios = [1, 0.7, 0.46, 0.26];
    let below: Set<string> | null = null;
    for (let tier = 1; tier <= tiers; tier += 1) {
      const radius = r1 * ratios[tier - 1];
      let cells = new Set<string>();
      for (let dr = -Math.ceil(radius); dr <= Math.ceil(radius); dr += 1) {
        for (let dc = -Math.ceil(radius); dc <= Math.ceil(radius); dc += 1) {
          const col = seed.col + dc;
          const row = seed.row + dr;
          const k = cellKey(col, row);
          if (!candidateKeys.has(k) || (below && !below.has(k))) continue;
          const edge = radius * (0.82 + 0.22 * Math.sin(Math.atan2(dr, dc) * 2 + wobble) + 0.08 * Math.sin(Math.atan2(dr, dc) * 3 - wobble));
          if (Math.hypot(dc, dr) <= edge) cells.add(k);
        }
      }
      cells = largestComponent(cells);
      if (cells.size < (tier === 1 ? 4 : 1)) break;
      const mask: IslandMask = { cells, bbox: bboxOf(cells) };
      maskToRects(mask).forEach((rect, i) => {
        // Each hill step is a touch taller than a room terrace (ELEV): the
        // relief reads from the isometric camera without dwarfing the scene.
        platforms.push({ id: `hill-${h + 1}-l${tier}-${i}`, rect, level: tier, lift: tier * HILL_STEP_LIFT, material: capMaterial(theme, tier, tiers) });
      });
      for (const k of cells) allCells.add(k);
      below = cells;
      if (tier === tiers || cells.size <= 3) {
        const [pc, pr] = [...cells][Math.floor(cells.size / 2)].split(":").map(Number);
        peaks.push({ col: pc, row: pr, level: tier });
        break;
      }
    }
  }
  return { platforms, cells: allCells, peaks };
}
