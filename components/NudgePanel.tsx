"use client";

import { useState } from "react";
import { pickSurpriseGoal } from "@/lib/surpriseGoals";
import { NUDGE_MAX_CHARS, useTown } from "@/lib/store";
import { CloseIcon } from "./icons";

type Props = {
  /** Called after a commit — the panel closes immediately, before any blur/re-render. */
  onCommitted?: () => void;
  onClose?: () => void;
};

/**
 * Persistent goal statement — not chat. The agent reads it from
 * get_occupancy's `goal` field and plan_scene defaults to it.
 */
export function NudgePanel({ onCommitted, onClose }: Props) {
  const goal = useTown((s) => s.nudgeGoal);
  const setNudgeGoal = useTown((s) => s.setNudgeGoal);
  const [draft, setDraft] = useState(goal ?? "");

  function commit(value: string) {
    // Close first — a blur-triggered re-render must not swallow the click.
    onCommitted?.();
    setNudgeGoal(value);
  }

  function surprise() {
    const next = pickSurpriseGoal(draft || goal);
    setDraft(next);
    commit(next);
  }

  return (
    <div className="nudge">
      <div className="nudge-top">
        <span className="panel-title">Nudge</span>
        <button type="button" aria-label="Close panel" className="panel-close" onClick={onClose}>
          <CloseIcon active />
        </button>
      </div>
      <textarea
        className="nudge-field"
        value={draft}
        maxLength={NUDGE_MAX_CHARS}
        rows={3}
        placeholder='e.g. "a pirate dock with boats"'
        onChange={(e) => setDraft(e.target.value.slice(0, NUDGE_MAX_CHARS))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit(draft);
          }
        }}
      />
      <div className="nudge-bar">
        <span className="nudge-count">
          {draft.trim().length}/{NUDGE_MAX_CHARS}
        </span>
        <div className="nudge-actions">
          {goal && (
            <button
              type="button"
              className="text-link"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                setDraft("");
                commit("");
              }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="nudge-surprise"
            onPointerDown={(e) => e.preventDefault()}
            onClick={surprise}
          >
            Surprise me
          </button>
          <button
            type="button"
            className="nudge-save"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => commit(draft)}
          >
            Set goal
          </button>
        </div>
      </div>
    </div>
  );
}
