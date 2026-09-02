import { CATALOG, type CatalogItem, type CatalogKind } from "../catalog";
import { seededShuffle, tokensOf } from "./select";

/**
 * Element picking — precise catalog selection for ONE composition role.
 *
 * select.ts answers "what is this whole theme about" (a broad, vocabulary
 * driven subset). Archetype elements need the opposite: "give me the picnic
 * table", "give me four graves", "give me the vendor". A PickSpec names exact
 * ids first (missing ids are skipped, so the data survives catalog churn) and
 * falls back to a whole-word query over id/label/kind, fenced by kind, pack,
 * and an exclusion pattern. Ties break on the seed, never on catalog order.
 */

export type PickSpec = {
  /** Exact catalog ids to prefer, in order. Unknown ids are skipped. */
  ids?: string[];
  /** Whole-word query over id/label/kind tokens ("tree pine", "flower"). */
  query?: string;
  kinds?: CatalogKind[];
  packs?: string[];
  /** Regex source; matching ids are dropped (e.g. "coffee|side|lamp"). */
  exclude?: string;
};

let hay: Map<string, Set<string>> | null = null;

function wordsOf(item: CatalogItem): Set<string> {
  if (!hay) {
    hay = new Map();
    for (const it of CATALOG) {
      hay.set(
        it.id,
        new Set(`${it.id} ${it.label} ${it.kind}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
      );
    }
  }
  return hay.get(item.id) ?? new Set();
}

function allowed(item: CatalogItem, spec: PickSpec, exclude: RegExp | null): boolean {
  if (!item.model) return false;
  if (spec.kinds && !spec.kinds.includes(item.kind)) return false;
  if (spec.packs && !spec.packs.includes(item.pack)) return false;
  if (exclude && exclude.test(item.id)) return false;
  return true;
}

/**
 * Up to `limit` distinct items for a spec, best matches first. Exact ids
 * lead (in the given order), then query matches ranked by whole-word score
 * with a seeded tie-break so equal candidates vary by scene, not by catalog
 * order. Deterministic for a given (spec, seed).
 */
export function pickItems(spec: PickSpec, seed: number, limit: number): CatalogItem[] {
  const exclude = spec.exclude ? new RegExp(spec.exclude, "i") : null;
  const out: CatalogItem[] = [];
  const taken = new Set<string>();
  for (const id of spec.ids ?? []) {
    const item = CATALOG.find((i) => i.id === id);
    if (item && allowed(item, spec, exclude) && !taken.has(item.id)) {
      taken.add(item.id);
      out.push(item);
      if (out.length >= limit) return out;
    }
  }
  const tokens = spec.query ? tokensOf(spec.query) : [];
  // A spec with no query but a kind/pack fence ("any townsfolk character")
  // still yields a seeded pool from everything the fence allows.
  const fenced = !tokens.length && (spec.kinds || spec.packs);
  if (tokens.length || fenced) {
    const scored = CATALOG.filter((item) => allowed(item, spec, exclude) && !taken.has(item.id)).flatMap((item) => {
      if (!tokens.length) return [{ item, score: 1 }];
      const words = wordsOf(item);
      let score = 0;
      for (const token of tokens) {
        if (words.has(token)) score += 4;
        else if (token.length >= 4 && [...words].some((w) => w.startsWith(token))) score += 2;
      }
      return score > 0 ? [{ item, score }] : [];
    });
    const ranked = seededShuffle(scored, seed).sort((a, b) => b.score - a.score);
    for (const { item } of ranked) {
      taken.add(item.id);
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** `n` placements drawn round-robin from `items`, starting at a seeded offset. */
export function cycleItems(items: CatalogItem[], n: number, seed: number): CatalogItem[] {
  if (!items.length || n <= 0) return [];
  const start = seed % items.length;
  return Array.from({ length: n }, (_, i) => items[(start + i) % items.length]);
}
