"use client";

import { useState } from "react";
import { useTown } from "@/lib/store";
import { humanFlip, humanLabel, humanRemove } from "@/lib/town";
import { LABEL_MAX_CHARS } from "@/lib/types";
import { CloseIcon, FlipIcon, TrashIcon } from "./icons";

/** Human-only controls for the selected piece: flip, label, delete. */
export function Inspector() {
  const pieces = useTown((s) => s.pieces);
  const selection = useTown((s) => s.selection);
  const setSelection = useTown((s) => s.setSelection);
  const piece = selection.length === 1 ? pieces[selection[0]] : undefined;
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Reset the draft when the selection moves to a different piece.
  if (piece && editingId !== piece.id) {
    setEditingId(piece.id);
    setDraft(piece.label);
  }

  if (!piece) return null;

  function commitLabel() {
    if (!piece || draft === piece.label) return;
    humanLabel(piece.id, draft);
  }

  return (
    <div className="inspector" data-testid="inspector">
      <div className="inspector-head">
        <span className="inspector-title">
          {piece.id} · {piece.lot} · {piece.owner}
          {piece.locked ? " · locked" : ""}
        </span>
        <button
          type="button"
          className="panel-close"
          aria-label="Deselect"
          onClick={() => setSelection([])}
        >
          <CloseIcon active />
        </button>
      </div>
      <div className="inspector-row">
        <button
          type="button"
          className="rail-btn tip"
          data-tip="Flip horizontally"
          aria-label="Flip horizontally"
          aria-pressed={Boolean(piece.flip)}
          onClick={() => humanFlip(piece.id)}
        >
          <FlipIcon />
        </button>
        <span className="inspector-flip">{piece.flip ? "Flipped" : "Front"}</span>
        <button
          type="button"
          className="rail-btn tip"
          data-tip="Delete"
          aria-label="Delete piece"
          onClick={() => humanRemove(piece.id)}
        >
          <TrashIcon />
        </button>
      </div>
      <input
        className="inspector-label"
        value={draft}
        maxLength={LABEL_MAX_CHARS}
        placeholder="Name this piece"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitLabel}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitLabel();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
