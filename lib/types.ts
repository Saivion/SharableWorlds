import type { CatalogKind } from "./catalog";

export type Owner = "human" | "agent";

export const SIDES = ["north", "south", "east", "west"] as const;
export type Side = (typeof SIDES)[number];

export function isSide(value: unknown): value is Side {
  return typeof value === "string" && (SIDES as readonly string[]).includes(value);
}

/**
 * One placed object, keyed by a stable instance id like "market-display-fruit-2",
 * living on one lot. What it looks like lives in the catalog (catalogId).
 */
export type Piece = {
  id: string;
  /** Catalog entry that renders this piece. */
  catalogId: string;
  /** Catalog kind, denormalized for compact tool payloads. */
  kind: CatalogKind;
  /** Lot id like "C3" — column letter, row number. Tool payloads only, never on the map. */
  lot: string;
  owner: Owner;
  /** Human-placed or human-painted pieces are locked; the agent must not touch them. */
  locked: boolean;
  label: string;
  /** Unused. Color lives on the agent cursor only. */
  color: string;
  /** Horizontal mirror — faces the opposite isometric direction. */
  flip: boolean;
  /** Yaw in quarter turns of degrees (0|90|180|270) — which way the piece faces. */
  rot?: number;
  bornAt: number;
};

export type ToolMode = "select" | "hand" | "place";

export const LABEL_MAX_CHARS = 40;

/**
 * One entry in the persistent build log — the raw material `lib/story.ts`
 * turns into prose. Survives scene wipes (a new Nudge goal clears `pieces`
 * but not history) so a story can span chapters.
 */
export type StoryEvent = {
  t: number;
  actor: Owner;
  verb: "place" | "move" | "label" | "paint" | "remove" | "blocked" | "goal" | "flip";
  pieceId?: string;
  catalogId?: string;
  kind?: CatalogKind;
  lot?: string;
  label?: string;
  goal?: string;
  /** On `place`: the scene planner's zone reason ("the centerpiece"), verbatim.
   * On `goal`: the wipe summary. On `blocked`: the skip summary. */
  detail?: string;
  /** Accent hex, set on a `paint` event — otherwise a wiped piece's color is lost to history. */
  color?: string;
  flip?: boolean;
};
