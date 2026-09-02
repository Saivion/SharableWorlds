"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { catalogItem } from "@/lib/catalog";
import { useTown, type BuildPhase, type TraceEntry } from "@/lib/store";
import type { StoryEvent } from "@/lib/types";

/**
 * Center chrome for the current agent chapter. Collapsed: headline + score +
 * Details. Open: prompt, pieces, scores, and trace in stacked sections.
 */

const PHASES: { id: BuildPhase; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "compose", label: "Compose" },
  { id: "execute", label: "Build" },
  { id: "inspect", label: "Inspect" },
  { id: "validate", label: "Validate" },
  { id: "repair", label: "Repair" },
  { id: "complete", label: "Complete" },
];

const DIM_COLS = [
  ["intentCoverage", "spatialCoherence", "environment"],
  ["composition", "navigation", "placementValidity"],
] as const;

const DIM_LABEL = {
  intentCoverage: "intent",
  composition: "composition",
  spatialCoherence: "coherence",
  navigation: "navigation",
  environment: "environment",
  placementValidity: "placement",
} as const;

export function AgentBuild() {
  const busy = useTown((s) => s.agentBusy);
  const events = useTown((s) => s.events);
  const carry = useTown((s) => s.agentCarry);
  const trace = useTown((s) => s.trace);
  const phase = useTown((s) => s.phase);
  const validation = useTown((s) => s.validation);
  const status = useTown((s) => s.agentStatus);
  const nudgeGoal = useTown((s) => s.nudgeGoal);
  const sceneMeta = useTown((s) => s.sceneMeta);
  const scenePlan = useTown((s) => s.scenePlan);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const chapter = useMemo(() => chapterAgentEvents(events), [events]);
  const items = useMemo(() => itemTallies(chapter, carry), [chapter, carry]);
  const rows = useMemo(() => traceRows(trace), [trace]);
  const prompt = (nudgeGoal || sceneMeta?.prompt || "").trim();
  const hasResults = Boolean(prompt || items.length > 0 || trace.length > 0);
  const visible = busy || hasResults;
  const complete = validation?.complete === true;
  const activeLabel = PHASES.find((p) => p.id === phase)?.label;
  const failed = rows.filter((r) => r.ok === false).length;
  const pieceTotal = items.reduce((n, i) => n + i.count, 0);

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

  const headline = busy ? "Agent Building" : complete ? "Scene Complete" : validation ? `${validation.completion}% Complete` : "Agent Built";

  return (
    <div className="agent-build-anchor">
      <div
        ref={wrapRef}
        className="agent-build"
        data-open={open || undefined}
        data-busy={busy || undefined}
        data-complete={complete || undefined}
      >
        <div className="agent-build__bar">
          <span className="agent-build__status">
            <span className="agent-build__dot" aria-hidden />
            {headline}
          </span>
          {validation && !busy && (
            <span className="agent-build__score" title={validation.verdict}>
              {validation.completion}%
            </span>
          )}
          <button type="button" className="gloss-btn agent-build__details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Details
          </button>
        </div>

        {busy && (status || activeLabel) && !open && (
          <p className="agent-build__line" aria-live="polite">
            {activeLabel && <span className="agent-build__phase-now">{activeLabel}</span>}
            {status && <span className="agent-build__line-text">{status}</span>}
          </p>
        )}

        <div className="agent-build__drop" data-open={open || undefined} aria-hidden={!open}>
          <div className="agent-build__drop-inner">
            {prompt && (
              <section className="agent-build__intro">
                <p className="agent-build__prompt">{prompt}</p>
                {scenePlan && <p className="agent-build__story">{scenePlan.intent.story}</p>}
                {validation && <p className="agent-build__verdict">{validation.verdict}</p>}
              </section>
            )}

            {items.length > 0 && (
              <section className="agent-build__block">
                <h3 className="agent-build__block-title">
                  Pieces <span className="agent-build__block-meta">{pieceTotal}</span>
                </h3>
                <div className="agent-build__chips" aria-label="Items">
                  {items.map((item) => {
                    const cat = catalogItem(item.catalogId);
                    return (
                      <span key={item.catalogId} className="agent-build__chip" title={cat?.label ?? item.catalogId}>
                        {cat && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cat.src} alt="" draggable={false} />
                        )}
                        <span className="agent-build__chip-count">×{item.count}</span>
                      </span>
                    );
                  })}
                </div>
              </section>
            )}

            {validation && (
              <section className="agent-build__block">
                <h3 className="agent-build__block-title">
                  Scores <span className="agent-build__block-meta">{validation.completion}%</span>
                </h3>
                <div className="agent-build__dims" aria-label="Completeness">
                  {DIM_COLS.map((col, i) => (
                    <ul key={i} className="agent-build__dim-col">
                      {col.map((d) => {
                        const pct = Math.round(validation.score[d] * 100);
                        return (
                          <li key={d} title={d}>
                            <span className="agent-build__dim-label">{DIM_LABEL[d]}</span>
                            <span className="agent-build__dim-bar" data-warn={pct < 85 || undefined}>
                              <span style={{ width: `${pct}%` }} />
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ))}
                </div>
              </section>
            )}

            <section className="agent-build__block">
              <h3 className="agent-build__block-title">
                Trace <span className="agent-build__block-meta">{rows.length || "—"}</span>
              </h3>
              <ul className="agent-build__actions" aria-label="WebMCP lifecycle">
                {rows.length === 0 ? (
                  <li className="agent-build__action agent-build__action--empty">{busy ? "Waiting for tools…" : "No tools recorded"}</li>
                ) : (
                  rows.map((row) => (
                    <li
                      key={row.id}
                      className="agent-build__action"
                      data-ok={row.ok === false ? "no" : row.ok ? "yes" : undefined}
                      title={`${row.args}\n${row.summary ?? ""}`}
                    >
                      <span className="agent-build__tool">
                        {row.tool}
                        {row.children > 0 && <span className="agent-build__nested">+{row.children}</span>}
                      </span>
                      <span className="agent-build__action-mark">
                        {row.ok === false ? "✗" : row.placed != null ? row.placed : row.ok ? "✓" : "…"}
                      </span>
                      {row.ms != null && <span className="agent-build__ms">{fmtMs(row.ms)}</span>}
                    </li>
                  ))
                )}
                {failed > 0 && (
                  <li className="agent-build__action agent-build__action--empty">
                    {failed} call{failed === 1 ? "" : "s"} refused
                  </li>
                )}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

type TraceRow = TraceEntry & { children: number };

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function traceRows(trace: TraceEntry[]): TraceRow[] {
  const children = new Map<number, number>();
  for (const e of trace) if (e.parent != null) children.set(e.parent, (children.get(e.parent) ?? 0) + 1);
  return trace.filter((e) => e.parent == null).map((e) => ({ ...e, children: children.get(e.id) ?? 0 }));
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

function itemTallies(events: StoryEvent[], carry: { catalogId: string; count: number } | null): { catalogId: string; count: number }[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.verb !== "place" || !e.catalogId) continue;
    map.set(e.catalogId, (map.get(e.catalogId) ?? 0) + 1);
  }
  if (carry && !map.has(carry.catalogId)) map.set(carry.catalogId, carry.count);
  return [...map.entries()]
    .map(([catalogId, count]) => ({ catalogId, count }))
    .sort((a, b) => b.count - a.count || a.catalogId.localeCompare(b.catalogId));
}
