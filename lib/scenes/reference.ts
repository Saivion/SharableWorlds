"use client";

import type { EnvironmentSpec } from "../composition/types";
import { useTown } from "../store";
import { catalogItem } from "../catalog";
import type { Piece } from "../types";

/**
 * Ember Square — the authored reference diorama and the benchmark for the
 * composition system. Everything about it is deliberate: architecture first
 * (platforms, a walled home terrace one level up, a rise for the skyline),
 * distinct zones (home / market row / garden / plaza), one focal landmark,
 * clustered props, connected elevations, characters inside the environment,
 * and intentional negative space around the monument.
 *
 * It seeds the board on first load so the app opens as a composed place, not
 * an empty canvas. Every piece is agent-owned and unlocked — the human and
 * the agent can both reshape it, and a new Nudge sweeps it for a fresh scene.
 */

const ENV: EnvironmentSpec = {
  platforms: [
    { id: "main", rect: { c0: 5, r0: 6, w: 15, d: 12 }, level: 0, material: "stone" },
    { id: "terrace", rect: { c0: 6, r0: 7, w: 6, d: 4 }, level: 1, material: "wood" },
    { id: "garden-bed", rect: { c0: 6, r0: 13, w: 4, d: 4 }, level: 0, material: "grass", inset: true },
    { id: "rise", rect: { c0: 6, r0: 4, w: 13, d: 2 }, level: 1, material: "grass" },
  ],
  walls: [
    { id: "terrace-n", c: 6, r: 7, len: 6, dir: "h", side: "n", height: 1.7 },
    { id: "terrace-w", c: 6, r: 7, len: 4, dir: "v", side: "w", height: 1.7 },
  ],
  stairs: [{ id: "terrace-stair", at: { col: 9, row: 11 }, dir: "n", fromLevel: 0, toLevel: 1 }],
  paths: [
    { id: "entrance", cells: [13, 14, 15, 16, 17].map((row) => ({ col: 13, row })) },
    {
      id: "stair-walk",
      cells: [
        { col: 10, row: 11 },
        { col: 11, row: 11 },
        { col: 12, row: 11 },
        { col: 12, row: 12 },
      ],
    },
  ],
  water: [],
  zones: [
    { id: "home", type: "home", label: "the house", rect: { c0: 6, r0: 7, w: 6, d: 4 }, level: 1, focal: { col: 8, row: 8 } },
    { id: "market", type: "market", label: "the market row", rect: { c0: 16, r0: 8, w: 3, d: 7 }, level: 0, focal: { col: 17, row: 11 } },
    { id: "garden", type: "garden", label: "the garden", rect: { c0: 6, r0: 13, w: 4, d: 4 }, level: 0, focal: { col: 7, row: 14 } },
    { id: "skyline", type: "skyline", label: "the rise behind town", rect: { c0: 6, r0: 4, w: 13, d: 2 }, level: 1, focal: { col: 12, row: 4 } },
    { id: "plaza", type: "plaza", label: "the square", rect: { c0: 5, r0: 6, w: 15, d: 12 }, level: 0, focal: { col: 13, row: 12 } },
  ],
};

// [catalogId, lot, flip, rot]
type Seed = [string, string, boolean?, number?];

const PIECES: Seed[] = [
  // The house — a lived-in room up on the terrace, heavy pieces against the walls.
  ["furniture-bed-double", "G8", false, 0],
  ["furniture-bookcase-open", "I8", false, 0],
  ["furniture-kitchen-fridge", "J8", false, 0],
  ["furniture-kitchen-coffee-machine", "K8", false, 0],
  ["furniture-lounge-sofa", "H10", false, 0],
  ["furniture-television-vintage", "H11", false, 180],
  ["furniture-rug-rectangle", "I10", false, 0],
  ["furniture-lamp-round-floor", "G10", false, 0],
  ["furniture-plant-small1", "L10", false, 0],
  ["pets-animal-cat", "K10", false, 90],

  // Market row — stalls face each other across a walkable aisle.
  ["market-display-fruit", "Q9", false, 270],
  ["market-display-bread", "Q11", false, 270],
  ["market-shelf-bags", "Q13", false, 270],
  ["market-freezer", "S10", false, 90],
  ["market-shelf-boxes", "S12", false, 90],
  ["market-shopping-cart", "R14", false, 0],
  ["food-apple", "Q10", false, 0],
  ["food-bread", "Q12", false, 0],
  ["food-cake-birthday", "S11", false, 90],
  ["market-character-employee", "R11", false, 90],

  // Garden — trees at the back, flowers inside, small lives among them.
  ["nature-tree-oak", "G14", false, 0],
  ["nature-tree-pine-small-a", "G16", false, 0],
  ["nature-tree-oak", "H17"],
  ["nature-campfire-stones", "H15", false, 0],
  ["nature-flower-purple-a", "I14", false, 0],
  ["nature-flower-red-a", "I16", false, 0],
  ["nature-flower-yellow-a", "J15", false, 0],
  ["nature-plant-bush", "F16", false, 0],
  ["pets-animal-bunny", "I15", false, 180],
  ["pets-animal-dog", "J16", false, 90],

  // Plaza — the monument holds the center; benches and blooms at its corners,
  // and the space around it stays deliberately open.
  ["nature-statue-obelisk", "N13", false, 0],
  ["furniture-bench-cushion", "L14", false, 270],
  ["furniture-bench-cushion", "P14", true, 90],
  ["nature-flower-purple-b", "K13", false, 0],
  ["nature-flower-red-b", "P11", false, 0],

  // The square's people — gathered around the monument, not floating beside it.
  ["characters-character-female-a", "M14", false, 270],
  ["characters-character-male-b", "O14", true, 90],
  ["characters-character-female-c", "N15", false, 180],
  ["characters-wheelchair", "M16", false, 0],
  ["characters-character-male-a", "R13", false, 0],
  ["characters-character-female-b", "J10", false, 90],
  ["characters-character-male-c", "I17", false, 180],

  // The rise — houses shoulder to shoulder above and behind the square.
  ["buildings-building-sample-house-a", "H5", false, 0],
  ["buildings-building-sample-house-b", "K5", false, 0],
  ["buildings-building-sample-house-c", "N5", false, 0],
  ["buildings-building-sample-tower-a", "Q5", false, 0],
  ["nature-tree-pine-small-a", "G6"],
  ["nature-tree-oak", "O6"],
];

/** Seed Ember Square onto an empty board. Quiet by design: no story events —
 * the town was simply already here when the session began. */
export function seedReferenceScene() {
  const store = useTown.getState();
  if (Object.keys(store.pieces).length > 0 || store.environment) return;
  store.setEnvironment(ENV);
  const t0 = Date.now();
  PIECES.forEach(([catalogId, lot, flip, rot], i) => {
    const item = catalogItem(catalogId);
    if (!item) return;
    const n = store.bumpCounter(catalogId);
    const piece: Piece = {
      id: `${catalogId}-${n}`,
      catalogId,
      kind: item.kind,
      lot,
      owner: "agent",
      locked: false,
      label: "",
      color: "",
      flip: Boolean(flip),
      ...(rot ? { rot } : {}),
      bornAt: t0 + i,
    };
    store.addPiece(piece);
  });
  store.bumpFocus();
}
