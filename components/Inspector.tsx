"use client";

import { catalogItem } from "@/lib/catalog";
import { phraseForCatalog } from "@/lib/story";
import { useTown } from "@/lib/store";
import { humanFlip, humanRemove } from "@/lib/town";
import { FlipIcon, TrashIcon } from "./icons";

/** Compact selection bar: what this is, flip, delete. No naming. */
export function Inspector() {
  const pieces = useTown((s) => s.pieces);
  const selection = useTown((s) => s.selection);
  const piece = selection.length === 1 ? pieces[selection[0]] : undefined;

  if (!piece) return null;

  const name = titleFor(piece.catalogId, piece.kind);

  return (
    <div className="inspector" data-testid="inspector">
      <span className="inspector-name">{name}</span>
      <div className="inspector-actions">
        <button
          type="button"
          className="inspector-btn tip"
          data-tip={piece.flip ? "Flipped — click to face the other way" : "Flip horizontally"}
          aria-label="Flip horizontally"
          aria-pressed={Boolean(piece.flip)}
          onClick={() => humanFlip(piece.id)}
        >
          <FlipIcon />
        </button>
        <button
          type="button"
          className="inspector-btn tip"
          data-tip="Delete"
          aria-label="Delete piece"
          onClick={() => humanRemove(piece.id)}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

function titleFor(catalogId: string, kind: Parameters<typeof phraseForCatalog>[1]): string {
  const phrase = phraseForCatalog(catalogId, kind);
  const bare = phrase.replace(/^an? /, "");
  return bare ? bare[0].toUpperCase() + bare.slice(1) : (catalogItem(catalogId)?.label ?? "Piece");
}
