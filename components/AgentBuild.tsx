"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { catalogItem } from "@/lib/catalog";
import { useTown } from "@/lib/store";
import type { StoryEvent } from "@/lib/types";

/**
 * Center chrome for the current agent chapter: sidebar-style shell with status
 * + Details. Stays up after the run finishes so the prompt, items, and tool
 * tallies remain reviewable until the next goal.
 */
export function AgentBuild() {
  const busy = useTown((s) => s.agentBusy);
  const events = useTown((s) => s.events);
  const carry = useTown((s) => s.agentCarry);
  const toolCalls = useTown((s) => s.toolCalls);
  const nudgeGoal = useTown((s) => s.nudgeGoal);
  const sceneMeta = useTown((s) => s.sceneMeta);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const chapter = useMemo(() => chapterAgentEvents(events), [events]);
  const items = useMemo(() => itemTallies(chapter, carry), [chapter, carry]);
  const tools = useMemo(() => toolTallies(toolCalls), [toolCalls]);
  const prompt = (nudgeGoal || sceneMeta?.prompt || "").trim();
  const hasResults = Boolean(prompt || items.length > 0 || tools.length > 0);
  const visible = busy || hasResults;

  useEffect(() => {
    if (!open) return;
    function onPtr(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPtr);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPtr);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!visible) return null;

  return (
    <div className="agent-build-anchor">
      <div
        ref={wrapRef}
        className="agent-build"
        data-open={open || undefined}
        data-busy={busy || undefined}
      >
        <div className="agent-build__bar">
          <span className="agent-build__status">
            <span className="agent-build__dot" aria-hidden />
            {busy ? "Agent Building" : "Agent Built"}
          </span>
          <button
            type="button"
            className="gloss-btn agent-build__details"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            Details
          </button>
        </div>

        <div className="agent-build__drop" data-open={open || undefined} aria-hidden={!open}>
          <div className="agent-build__drop-inner">
            {prompt && (
              <>
                <hr className="agent-build__rule" />
                <p className="agent-build__prompt">{prompt}</p>
                <hr className="agent-build__rule" />
              </>
            )}

            {items.length > 0 && (
              <div className="agent-build__items" aria-label="Items">
                {items.map((item) => {
                  const cat = catalogItem(item.catalogId);
                  return (
                    <span key={item.catalogId} className="agent-build__item" title={cat?.label ?? item.catalogId}>
                      {cat && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cat.src} alt="" draggable={false} />
                      )}
                      <span className="agent-build__item-count">×{item.count}</span>
                    </span>
                  );
                })}
              </div>
            )}

            <ul className="agent-build__actions" aria-label="WebMCP tools">
              {tools.length === 0 ? (
                <li className="agent-build__action agent-build__action--empty">
                  {busy ? "Waiting for tools…" : "No tools recorded"}
                </li>
              ) : (
                tools.map((tool) => (
                  <li key={tool.name} className="agent-build__action">
                    <span className="agent-build__tool">{tool.name}</span>
                    <span className="agent-build__action-count">×{tool.count}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function chapterAgentEvents(events: StoryEvent[]): StoryEvent[] {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].verb === "goal") {
      start = i + 1;
      break;
    }
  }
  return events.slice(start).filter((e) => e.actor === "agent");
}

function itemTallies(
  events: StoryEvent[],
  carry: { catalogId: string; count: number } | null,
): { catalogId: string; count: number }[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.verb !== "place" || !e.catalogId) continue;
    map.set(e.catalogId, (map.get(e.catalogId) ?? 0) + 1);
  }
  if (carry && !map.has(carry.catalogId)) {
    map.set(carry.catalogId, carry.count);
  }
  return [...map.entries()]
    .map(([catalogId, count]) => ({ catalogId, count }))
    .sort((a, b) => b.count - a.count || a.catalogId.localeCompare(b.catalogId));
}

function toolTallies(calls: Record<string, number>): { name: string; count: number }[] {
  return Object.entries(calls)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
