"use client";

import { MousePointer2 } from "lucide-react";
import { AGENT_ACCENT, useTown } from "@/lib/store";

/** Same MousePointer2 as the Select rail, in agent blue. Hidden when idle. */
export function AgentCursor() {
  const cursor = useTown((s) => s.agentCursor);
  if (!cursor?.visible) return null;
  return (
    <div className="agent-cursor" style={{ left: cursor.x, top: cursor.y }} aria-hidden>
      <span className="agent-cursor__ptr">
        <MousePointer2
          size={22}
          strokeWidth={1.75}
          color={AGENT_ACCENT}
          fill={AGENT_ACCENT}
          absoluteStrokeWidth
        />
      </span>
      <span className="agent-cursor__name">agent</span>
    </div>
  );
}
