"use client";

import { useEffect, useRef, useState } from "react";
import { buildStory, phraseForCatalog } from "@/lib/story";
import { useTown } from "@/lib/store";

/**
 * Quiet session chip. Compact: wordmark + a live line (the goal when idle,
 * what the agent is doing when busy). Click to expand into a short session
 * card — goal, piece split, and the narrated recap from `lib/story.ts`.
 * The same recap is what a WebMCP host gets from `tell_story`.
 */
export function Notch() {
  const agentBusy = useTown((s) => s.agentBusy);
  const agentStatus = useTown((s) => s.agentStatus);
  const nudgeGoal = useTown((s) => s.nudgeGoal);
  const pieces = useTown((s) => s.pieces);
  const events = useTown((s) => s.events);
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const pieceList = Object.values(pieces);
  const humanCount = pieceList.filter((p) => p.owner === "human").length;
  const agentCount = pieceList.length - humanCount;
  const story = expanded ? buildStory(events, pieces) : null;

  const live = agentBusy ? humanizeStatus(agentStatus) ?? "building" : nudgeGoal;

  useEffect(() => {
    if (!expanded) return;
    function onPtr(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setExpanded(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("pointerdown", onPtr);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPtr);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  return (
    <div className="notch-anchor">
      <div
        ref={wrapRef}
        className="notch-wrap"
        data-expanded={expanded || undefined}
        data-busy={agentBusy || undefined}
      >
        <button
          type="button"
          className="notch"
          data-expanded={expanded || undefined}
          data-busy={agentBusy || undefined}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label="SharableWorlds session"
        >
          <span className="notch-row">
            <span className="notch-dot" data-busy={agentBusy || undefined} aria-hidden />
            <span className="notch-mark">SharableWorlds</span>
            {agentBusy && <span className="notch-status">building</span>}
          </span>
          {live && !expanded && <span className="notch-live">{live}</span>}
        </button>

        {expanded && (
          <div className="notch-panel" role="dialog" aria-label="Session">
            <p className="notch-goal">{nudgeGoal || "No goal yet"}</p>
            <p className="notch-count">{countLine(pieceList.length, humanCount, agentCount)}</p>
            {story && (
              <div className="notch-story">
                {recapBody(story.paragraphs, pieceList.length > 0).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function countLine(total: number, human: number, agent: number): string {
  if (!total) return "Empty board";
  if (human && agent) return `${total} pieces · ${human} yours · ${agent} agent's`;
  if (human) return `${total} piece${total === 1 ? "" : "s"}, all yours`;
  return `${total} piece${total === 1 ? "" : "s"}, all the agent's`;
}

/** Drop the closer that restates the piece count, then split walls of prose into sentences. */
function recapBody(paragraphs: string[], hasPieces: boolean): string[] {
  const paras = [...paragraphs];
  if (hasPieces && paras.length > 1) {
    const last = paras[paras.length - 1];
    if (/\d+\s+pieces?\b/i.test(last) && last.length < 200) paras.pop();
  }
  return paras.flatMap((p) => p.split(/(?<=\.)\s+/).filter(Boolean));
}

/** Safety net: leftover catalog-id dumps still read as English. */
function humanizeStatus(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(placed|moved|removed|labeled|named)\s+(\S+?)(?:\s+on\s+\S+)?$/.exec(raw);
  if (m && m[2].includes("-")) return `${m[1]} ${phraseForCatalog(m[2])}`;
  return raw;
}
