"use client";

import { MousePointer2 } from "lucide-react";
import { AGENT_ACCENT, useTown } from "@/lib/store";

/**
 * Agent pointer. Renders inside `.agent-cursor-layer` (a fixed full-viewport
 * overlay that is the last child of the studio) so it always paints above the
 * kit palette and tool rails — including on the first spawn frame.
 */
export function AgentCursor() {
  const cursor = useTown((s) => s.agentCursor);
  if (!cursor?.visible) return null;

  return (
    <div
      className="agent-cursor"
      style={{ transform: `translate3d(${cursor.x - 2}px, ${cursor.y - 1}px, 0)` }}
      aria-hidden
    >
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
