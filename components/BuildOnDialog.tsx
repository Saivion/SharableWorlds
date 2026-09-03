"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { archetypeById } from "@/lib/composition/archetypes";
import { buildOnSuggestions } from "@/lib/buildOnSuggestions";
import { useTown } from "@/lib/store";
import { buildAroundGoal, humanPieces } from "./EmptyWelcome";
import { CloseIcon } from "./icons";

const OUT_MS = 220;

type Props = {
  onClose: () => void;
};

/**
 * "Build On with Agent" — grow the world that already stands. Offers
 * suggestions tuned to the current scene and a free prompt; committing hands
 * the agent an ADDITIVE goal (extendGoal → extend_scene), so nothing on the
 * board is replaced. Portaled to <body> like the share card, so it sits
 * above the agent cursor and the chrome. Mounted only while open, so its
 * state starts fresh each time.
 */
export function BuildOnDialog({ onClose }: Props) {
  const meta = useTown((s) => s.sceneMeta);
  const plan = useTown((s) => s.scenePlan);
  const pieces = useTown((s) => s.pieces);
  const busy = useTown((s) => s.agentBusy);
  const extendGoal = useTown((s) => s.extendGoal);
  const [text, setText] = useState("");
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  const sceneType = plan?.intent.sceneType ?? meta?.sceneType;
  const label = archetypeById(sceneType)?.label ?? sceneType?.replace(/_/g, " ") ?? "world";
  const human = humanPieces(pieces);
  const additions = meta?.additions ?? [];
  const suggestions = buildOnSuggestions(sceneType, human.length ? buildAroundGoal(pieces) : null, additions);

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  const close = () => {
    if (closing) return;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onClose();
    }, OUT_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  const commit = (goal: string) => {
    const trimmed = goal.trim();
    if (!trimmed || busy) return;
    extendGoal(trimmed);
    close();
  };

  return createPortal(
    <div className="about-scrim buildon-scrim" data-closing={closing || undefined} onClick={close}>
      <div className="about-dialog buildon-dialog" role="dialog" aria-modal="true" aria-labelledby="buildon-title" onClick={(e) => e.stopPropagation()}>
        {/* The World Pass foil, dithered into the paper, lapping out as a wave. */}
        <div className="buildon-head" aria-hidden>
          <svg className="buildon-head-wave" viewBox="0 0 600 36" preserveAspectRatio="none">
            <path d="M0 22 C72 6 128 34 198 20 C268 6 318 32 392 18 C466 4 528 30 600 16 V36 H0 Z" />
          </svg>
        </div>
        <button type="button" className="panel-close buildon-close" aria-label="Close" onClick={close}>
          <CloseIcon active />
        </button>
        <div className="buildon-body">
          <p className="about-kicker">Build on with agent</p>
          <h2 id="buildon-title" className="about-title">
            Add to your {label}
          </h2>
          <p className="about-body">
            Describe what to add. The agent keeps everything that stands, lays out the new ground beside it, fills it, and checks the whole
            world again.
          </p>
          {additions.length > 0 && (
            <p className="buildon-history">
              Already added: {additions.map((a, i) => (i ? `, ${a}` : a))}
            </p>
          )}
          <div className="buildon-chips" role="list">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                role="listitem"
                className="buildon-chip"
                disabled={busy}
                onClick={() => {
                  setText(s);
                  inputRef.current?.focus();
                }}
                title="Use this suggestion"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            className="buildon-form"
            onSubmit={(e) => {
              e.preventDefault();
              commit(text);
            }}
          >
            <input
              ref={inputRef}
              autoFocus
              className="buildon-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="or type your own — “a lighthouse on the point with a keeper’s cottage”"
              maxLength={160}
              disabled={busy}
              aria-label="What to add to the world"
            />
            <button type="submit" className="gloss-btn buildon-submit" disabled={busy || !text.trim()}>
              <span className="gloss-btn__spark" aria-hidden>
                ✦
              </span>
              Build on
            </button>
          </form>
          <p className="buildon-hint">{busy ? "The agent is still building — wait for it to finish." : "Nothing on the board is removed. The share link replays every addition."}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
