"use client";

import { useState } from "react";
import { buildStory } from "@/lib/story";
import { useTown } from "@/lib/store";

/**
 * The floating title pill — a Dynamic-Island-style "notch". Compact by
 * default ("Together · agent idle/building"); grows to show the agent's live
 * status while it's writing; click to expand into the goal, piece counts,
 * and an on-demand narrated recap built from the build log (`lib/story.ts`).
 * The same recap is what an external WebMCP host gets from the `tell_story`
 * tool — this is the human-facing side of "when called upon".
 */
export function Notch() {
  const agentBusy = useTown((s) => s.agentBusy);
  const agentStatus = useTown((s) => s.agentStatus);
  const nudgeGoal = useTown((s) => s.nudgeGoal);
  const pieces = useTown((s) => s.pieces);
  const events = useTown((s) => s.events);
  const [expanded, setExpanded] = useState(false);
  const [story, setStory] = useState<{ title: string; paragraphs: string[] } | null>(null);

  const pieceList = Object.values(pieces);
  const humanCount = pieceList.filter((p) => p.owner === "human").length;
  const agentCount = pieceList.length - humanCount;

  function toggle() {
    setExpanded((v) => !v);
  }

  function tellStory() {
    setStory(buildStory(events, pieces));
  }

  return (
    <div className="notch-wrap">
      <button
        type="button"
        className="notch"
        data-expanded={expanded || undefined}
        data-busy={agentBusy || undefined}
        onClick={toggle}
        aria-expanded={expanded}
        aria-label="Together — session details"
      >
        <span className="notch-row">
          <span className="notch-mark">Together</span>
          <span className="notch-sep" aria-hidden>
            ·
          </span>
          <span className="notch-status">{agentBusy ? "agent building" : "agent idle"}</span>
        </span>
        {agentStatus && !expanded && <span className="notch-live">{agentStatus}</span>}
      </button>

      {expanded && (
        <div className="notch-panel" role="dialog" aria-label="Session details">
          <dl className="notch-facts">
            <div>
              <dt>Pieces</dt>
              <dd>
                {pieceList.length} total{pieceList.length ? ` · ${humanCount} yours · ${agentCount} agent's` : ""}
              </dd>
            </div>
            {nudgeGoal && (
              <div>
                <dt>Nudge</dt>
                <dd>{nudgeGoal}</dd>
              </div>
            )}
          </dl>

          {!story ? (
            <button type="button" className="notch-story-btn" onClick={tellStory}>
              Tell me what happened
            </button>
          ) : (
            <div className="notch-story">
              <p className="notch-story__title">{story.title}</p>
              {story.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              <button type="button" className="text-link" onClick={tellStory}>
                Retell it
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
