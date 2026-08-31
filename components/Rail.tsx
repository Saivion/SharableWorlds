"use client";

import { useCallback, useRef, useState } from "react";
import { AboutIcon, NudgeIcon, RetryIcon } from "./icons";
import { NudgePanel } from "./NudgePanel";
import { GooeyRail, RailSection, railHotHandlers } from "./GooeyRail";
import { useTown } from "@/lib/store";

const PANEL_OUT_MS = 240;

type Props = {
  aboutOpen?: boolean;
  onAbout?: () => void;
};

/** Right rail: Nudge goal, About, session reset. */
export function Rail({ aboutOpen = false, onAbout }: Props) {
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [hotId, setHotId] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const openRef = useRef(false);
  const nudgeGoal = useTown((s) => s.nudgeGoal);
  const hot = railHotHandlers();

  const closePanel = useCallback(() => {
    if (!openRef.current) return;
    setClosing(true);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setNudgeOpen(false);
      openRef.current = false;
      setClosing(false);
      closeTimer.current = null;
    }, PANEL_OUT_MS);
  }, []);

  function toggleNudge() {
    if (openRef.current) {
      closePanel();
      return;
    }
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    setClosing(false);
    setNudgeOpen(true);
    openRef.current = true;
  }

  return (
    <div className="studio-aside">
      {nudgeOpen && (
        <div className="panel panel--float panel--nudge" data-closing={closing || undefined}>
          <NudgePanel onCommitted={closePanel} onClose={closePanel} />
        </div>
      )}

      <GooeyRail side="right">
        <RailSection>
          <button
            type="button"
            className="rail-btn tip"
            data-tip="Nudge — Set Goal"
            data-active={nudgeOpen && !closing}
            aria-label="Nudge"
            onClick={toggleNudge}
            onPointerEnter={(e) => {
              setHotId("nudge");
              hot.onPointerEnter(e);
            }}
            onPointerLeave={(e) => {
              setHotId(null);
              hot.onPointerLeave(e);
            }}
          >
            <NudgeIcon active={hotId === "nudge" || nudgeOpen || Boolean(nudgeGoal)} />
          </button>
          <button
            type="button"
            className="rail-btn tip"
            data-tip="About"
            data-active={aboutOpen}
            aria-label="About"
            onClick={onAbout}
            onPointerEnter={(e) => {
              setHotId("about");
              hot.onPointerEnter(e);
            }}
            onPointerLeave={(e) => {
              setHotId(null);
              hot.onPointerLeave(e);
            }}
          >
            <AboutIcon active={hotId === "about" || aboutOpen} />
          </button>
          <button
            type="button"
            className="rail-btn tip"
            data-tip="Reset"
            aria-label="Reset"
            onClick={() => window.location.reload()}
            onPointerEnter={(e) => {
              setHotId("retry");
              hot.onPointerEnter(e);
            }}
            onPointerLeave={(e) => {
              setHotId(null);
              hot.onPointerLeave(e);
            }}
          >
            <RetryIcon active={hotId === "retry"} />
          </button>
        </RailSection>
      </GooeyRail>
    </div>
  );
}
