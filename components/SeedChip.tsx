"use client";

import { useEffect, useRef, useState } from "react";
import { shareUrl } from "@/lib/composition/seed";
import { useTown } from "@/lib/store";
import { callTownTool } from "@/lib/town";

/**
 * The scene's seed identity, worn on the canvas: the seed is copyable, the
 * share link reproduces this exact world anywhere, and Remix mints a new
 * seed for a meaningfully different take on the same concept — all through
 * the same WebMCP tools an agent would use.
 */
export function SeedChip() {
  const meta = useTown((s) => s.sceneMeta);
  const agentBusy = useTown((s) => s.agentBusy);
  const [flash, setFlash] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  if (!meta) return null;

  const note = (text: string) => {
    setFlash(text);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(null), 1600);
  };

  const copySeed = async () => {
    try {
      await navigator.clipboard.writeText(meta.seed);
      note("seed copied");
    } catch {
      note("copy failed");
    }
  };

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(window.location.origin, meta));
      note("link copied");
    } catch {
      note("copy failed");
    }
  };

  const remix = () => {
    void callTownTool("regenerate_scene", {});
  };

  return (
    <div className="seed-chip" data-busy={agentBusy || undefined}>
      <button type="button" className="seed-chip-seed" onClick={copySeed} title="Copy seed">
        <span className="seed-chip-label">seed</span>
        <span className="seed-chip-value">{meta.seed}</span>
      </button>
      <button type="button" className="seed-chip-btn" onClick={copyShare} title="Copy a link that reproduces this exact world">
        Share
      </button>
      <button type="button" className="seed-chip-btn" onClick={remix} disabled={agentBusy} title="New seed, new take on the same scene">
        Remix
      </button>
      {flash && <span className="seed-chip-flash">{flash}</span>}
    </div>
  );
}
