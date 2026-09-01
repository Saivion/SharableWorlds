"use client";

import { useState } from "react";
import { AboutIcon, RetryIcon } from "./icons";
import { GooeyRail, RailSection, railHotHandlers } from "./GooeyRail";

type Props = {
  aboutOpen?: boolean;
  onAbout?: () => void;
};

/** Right rail: About and session reset. Goal-setting lives on the canvas —
 * Surprise Me in the top-right commits goals directly. */
export function Rail({ aboutOpen = false, onAbout }: Props) {
  const [hotId, setHotId] = useState<string | null>(null);
  const hot = railHotHandlers();

  return (
    <div className="studio-aside">
      <GooeyRail side="right">
        <RailSection>
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
