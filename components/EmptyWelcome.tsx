"use client";

import { pickSurpriseGoal } from "@/lib/surpriseGoals";
import { useTown } from "@/lib/store";

/**
 * Empty-canvas welcome. Shown when nothing has been built yet — points the
 * human at Surprise Me so the first visit isn't a blank grid.
 *
 * Positioned with flex (no translate centering) so it never jumps on paint.
 */
export function EmptyWelcome({ quiet }: { quiet?: boolean }) {
  const meta = useTown((s) => s.sceneMeta);
  const environment = useTown((s) => s.environment);
  const pieces = useTown((s) => s.pieces);
  const busy = useTown((s) => s.agentBusy);
  const goal = useTown((s) => s.nudgeGoal);
  const setNudgeGoal = useTown((s) => s.setNudgeGoal);

  const empty = !meta && !environment && Object.keys(pieces).length === 0 && !busy;
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
          </span>{" "}
          Surprise Me
        </button>
        <p className="empty-welcome__hint">Same button lives up top · right corner</p>
      </div>
    </div>
  );
}
