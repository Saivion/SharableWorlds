"use client";

import { catalogItem } from "@/lib/catalog";
import { pickSurpriseGoal } from "@/lib/surpriseGoals";
import { useTown } from "@/lib/store";
import type { Piece } from "@/lib/types";

/** Canvas has nothing built and the agent isn't working. */
export function isCanvasEmpty(state: {
  sceneMeta: unknown;
  environment: unknown;
  pieces: Record<string, Piece>;
  agentBusy: boolean;
}): boolean {
  return !state.sceneMeta && !state.environment && Object.keys(state.pieces).length === 0 && !state.agentBusy;
}

/** Human kit pieces the agent must build around (locked lots). */
export function humanPieces(pieces: Record<string, Piece>): Piece[] {
  return Object.values(pieces).filter((p) => p.owner === "human");
}

/** Goal that asks the agent to compose around what the human already placed. */
export function buildAroundGoal(pieces: Record<string, Piece>): string {
  const human = humanPieces(pieces);
  // Distinct labels, counted — four of the same column is one idea, not four.
  const counts = new Map<string, number>();
  for (const p of human) {
    const label = (catalogItem(p.catalogId)?.label ?? p.kind).toLowerCase();
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts.entries()].slice(0, 4).map(([label, n]) => (n > 1 ? `${n} ${label} pieces` : label));
  if (labels.length === 0) return pickSurpriseGoal();
  if (labels.length === 1) return `a scene built around the ${labels[0]} I've placed`;
  if (labels.length === 2) return `a scene built around my ${labels[0]} and ${labels[1]}`;
  const last = labels[labels.length - 1];
  return `a scene built around my ${labels.slice(0, -1).join(", ")}, and ${last}`;
}

/**
 * Empty-canvas welcome. Shown when nothing has been built yet — owns the
 * Surprise Me CTA so the top-right button can stay hidden.
 */
export function EmptyWelcome({ quiet }: { quiet?: boolean }) {
  const meta = useTown((s) => s.sceneMeta);
  const environment = useTown((s) => s.environment);
  const pieces = useTown((s) => s.pieces);
  const busy = useTown((s) => s.agentBusy);
  const goal = useTown((s) => s.nudgeGoal);
  const setNudgeGoal = useTown((s) => s.setNudgeGoal);

  const empty = isCanvasEmpty({ sceneMeta: meta, environment, pieces, agentBusy: busy });
  if (!empty || quiet) return null;

  return (
    <div className="empty-welcome" role="status">
      <div className="empty-welcome__card">
        <p className="empty-welcome__kicker">SharableWorlds</p>
        <h2 className="empty-welcome__title">Your canvas is empty</h2>
        <p className="empty-welcome__body">
          Tap <strong>Surprise Me</strong> to generate a seeded world — or open the kit and place a piece yourself.
        </p>
        <button
          type="button"
          className="gloss-btn empty-welcome__cta"
          onClick={() => setNudgeGoal(pickSurpriseGoal(goal))}
        >
          <span className="gloss-btn__spark" aria-hidden>
            ✦
          </span>
          Surprise Me
        </button>
      </div>
    </div>
  );
}
