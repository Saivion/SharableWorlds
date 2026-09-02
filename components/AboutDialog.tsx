"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { catalogItem, FEATURED } from "@/lib/catalog";
import { CloseIcon } from "./icons";

const ABOUT_SEEN_KEY = "together-about-seen";
const ABOUT_OUT_MS = 220;
const SPRITE_COUNT = 12;
const FEATURED_IDS = FEATURED.flatMap((group) => group.ids);

type PlacedSprite = {
  id: string;
  src: string;
};

function shuffle<T>(items: T[]): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function pickSprites(): PlacedSprite[] {
  const placed: PlacedSprite[] = [];
  for (const id of shuffle(FEATURED_IDS)) {
    const item = catalogItem(id);
    if (!item) continue;
    placed.push({ id, src: item.src });
    if (placed.length === SPRITE_COUNT) break;
  }
  return placed;
}

export function useAboutDialog() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  /** False until localStorage is read — avoids flashing EmptyWelcome before About. */
  const [ready, setReady] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(ABOUT_SEEN_KEY)) setOpen(true);
    } catch {
      setOpen(true);
    }
    setReady(true);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  const closeAbout = useCallback(() => {
    if (!open || closing) return;
    setClosing(true);
    try {
      window.localStorage.setItem(ABOUT_SEEN_KEY, "1");
    } catch {
      /* ignore quota / private mode */
    }
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      timer.current = null;
    }, ABOUT_OUT_MS);
  }, [open, closing]);

  const toggleAbout = useCallback(() => {
    if (open && !closing) {
      closeAbout();
      return;
    }
    if (timer.current != null) window.clearTimeout(timer.current);
    setClosing(false);
    setOpen(true);
  }, [open, closing, closeAbout]);

  return { aboutOpen: open, aboutClosing: closing, aboutReady: ready, closeAbout, toggleAbout };
}

type Props = {
  open: boolean;
  closing: boolean;
  onClose: () => void;
};

/** First-visit / about modal: Kenney scene on the left, copy on the right. */
export function AboutDialog({ open, closing, onClose }: Props) {
  const [sprites, setSprites] = useState<PlacedSprite[]>([]);

  useEffect(() => {
    if (open) setSprites(pickSprites());
  }, [open]);

  useEffect(() => {
    if (!open || closing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closing, onClose]);

  if (!open) return null;

  return (
    <div
      className="about-scrim"
      data-closing={closing || undefined}
      onClick={onClose}
    >
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-visual" aria-hidden>
          {sprites.map((sprite) => (
            <span key={sprite.id} className="about-sprite">
              {/* Kenney previews are already sized; same pattern as the kit palette. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sprite.src} alt="" draggable={false} />
            </span>
          ))}
        </div>
        <div className="about-copy">
          <button
            type="button"
            className="panel-close about-close"
            aria-label="Close about"
            onClick={onClose}
          >
            <CloseIcon active />
          </button>
          <p className="about-kicker">SharableWorlds</p>
          <h2 id="about-title" className="about-title">
            Build a world you can share
          </h2>
          <p className="about-body">
            Tap <strong>Surprise Me</strong> to generate a seeded diorama — or
            open the kit, place a piece, and let an agent build around what you
            lock down.
          </p>
          <p className="about-body">
            Every world gets a seed. Share the link and anyone rebuilds the
            same place.
          </p>
          <button type="button" className="gloss-btn about-start" onClick={onClose}>
            <span className="gloss-btn__spark" aria-hidden>
              ✦
            </span>{" "}
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
