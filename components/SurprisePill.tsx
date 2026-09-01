"use client";

import { useEffect, useRef, useState } from "react";
import { pickSurpriseGoal } from "@/lib/surpriseGoals";
import { useTown } from "@/lib/store";

const CLICK_SPIN_MS = 720;

/**
 * Top-right one-click world button. Commits a fresh surprise goal through the
 * same pipeline a WebMCP agent uses. A short sparkle spin plays on click,
 * then the build starts.
 */
export function SurprisePill() {
  const busy = useTown((s) => s.agentBusy);
  const goal = useTown((s) => s.nudgeGoal);
  const setNudgeGoal = useTown((s) => s.setNudgeGoal);
  const [spinning, setSpinning] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const onClick = () => {
    if (busy || spinning) return;
    setSpinning(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setSpinning(false);
      setNudgeGoal(pickSurpriseGoal(goal));
    }, CLICK_SPIN_MS);
  };

  return (
    <div className="surprise-anchor">
      <button
        type="button"
        className="gloss-btn"
        disabled={busy || spinning}
        onClick={onClick}
        title="Build a surprise world"
      >
        <span className="gloss-btn__spark" data-spin={spinning || undefined}>
          ✦
        </span>{" "}
        Surprise Me
      </button>
    </div>
  );
}
