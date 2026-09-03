"use client";

import { useEffect, useRef, useState } from "react";
import { pickSurpriseGoal } from "@/lib/surpriseGoals";
import { useTown } from "@/lib/store";
import { BuildOnDialog } from "./BuildOnDialog";
import { isCanvasEmpty } from "./EmptyWelcome";
import { HammerIcon, type HammerIconHandle } from "./icons/HammerIcon";

const CLICK_SPIN_MS = 720;

/**
 * Top-right world buttons. Hidden while the empty-canvas welcome owns Surprise
 * Me. Once a world stands, a second button opens the Build On dialog: a
 * prompt the agent adds to the scene without replacing it.
 */
export function SurprisePill() {
  const busy = useTown((s) => s.agentBusy);
  const goal = useTown((s) => s.nudgeGoal);
  const setNudgeGoal = useTown((s) => s.setNudgeGoal);
  const meta = useTown((s) => s.sceneMeta);
  const environment = useTown((s) => s.environment);
  const pieces = useTown((s) => s.pieces);
  const empty = isCanvasEmpty({ sceneMeta: meta, environment, pieces, agentBusy: busy });
  const standing = Boolean(meta || environment || Object.keys(pieces).length);
  const [spinning, setSpinning] = useState(false);
  const [buildOnOpen, setBuildOnOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const hammerRef = useRef<HammerIconHandle>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  if (empty) return null;

  const run = (next: string) => {
    if (busy || spinning) return;
    setSpinning(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setSpinning(false);
      setNudgeGoal(next);
    }, CLICK_SPIN_MS);
  };

  return (
    <div className="surprise-anchor">
      {standing && (
        <button
          type="button"
          className="gloss-btn surprise-around"
          disabled={busy || spinning}
          onClick={() => setBuildOnOpen(true)}
          onPointerEnter={() => hammerRef.current?.startAnimation()}
          onPointerLeave={() => hammerRef.current?.stopAnimation()}
          title="Ask the agent to add to this world from a prompt"
        >
          <span className="gloss-btn__icon">
            <HammerIcon ref={hammerRef} size={16} />
          </span>
          Build On with Agent
        </button>
      )}
      {buildOnOpen && <BuildOnDialog onClose={() => setBuildOnOpen(false)} />}
      <button
        type="button"
        className="gloss-btn"
        disabled={busy || spinning}
        onClick={() => run(pickSurpriseGoal(goal))}
        title="Build a surprise world"
      >
        <span className="gloss-btn__spark" data-spin={spinning || undefined} aria-hidden>
          ✦
        </span>
        Surprise Me
      </button>
    </div>
  );
}
