"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { parseShareParams } from "@/lib/composition/seed";
import { runGoalBuild } from "@/lib/goalRunner";
import { seedReferenceScene } from "@/lib/scenes/reference";
import { callTownTool, registerTownTools, TOWN_TOOLS } from "@/lib/town";
import { SeedChip } from "./SeedChip";
import { AGENT_ACCENT, useTown } from "@/lib/store";
import type { ToolMode } from "@/lib/types";
import { Stage3D } from "./stage3d/Stage3D";
import { AboutDialog, useAboutDialog } from "./AboutDialog";
import { Rail } from "./Rail";
import { Inspector } from "./Inspector";
import { KitPalette } from "./KitPalette";
import { Notch } from "./Notch";
import { HoverTipHost } from "./HoverTip";
import { AgentCursor } from "./AgentCursor";
import { GooeyRail, RailDivider, RailSection, railHotHandlers } from "./GooeyRail";
import { HandIcon, KitIcon, SelectIcon, UndoIcon } from "./icons";

export function Studio() {
  const webmcp = useTown((s) => s.webmcp);
  const setWebmcp = useTown((s) => s.setWebmcp);
  const lastError = useTown((s) => s.lastError);
  const tool = useTown((s) => s.tool);
  const setTool = useTown((s) => s.setTool);
  const kitOpen = useTown((s) => s.kitOpen);
  const setKitOpen = useTown((s) => s.setKitOpen);
  const nudgeGoal = useTown((s) => s.nudgeGoal);
  const nudgeToken = useTown((s) => s.nudgeToken);
  const undo = useTown((s) => s.undo);
  const undoDepth = useTown((s) => s.undoStack.length);
  const [retry, setRetry] = useState(0);
  const [hotId, setHotId] = useState<string | null>(null);
  const hot = railHotHandlers();
  const { aboutOpen, aboutClosing, closeAbout, toggleAbout } = useAboutDialog();

  useEffect(() => {
    const controller = new AbortController();
    void registerTownTools(controller.signal)
      .then((surface) => setWebmcp(surface ? "available" : "missing"))
      .catch(() => setWebmcp("missing"));
    return () => controller.abort();
  }, [retry, setWebmcp]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as {
      __townTools?: { call: typeof callTownTool; tools: typeof TOWN_TOOLS };
    }).__townTools = { call: callTownTool, tools: TOWN_TOOLS };
  }, []);

  // Committing a Nudge builds toward it immediately — the local fallback for
  // when no WebMCP host is attached to act on the goal.
  useEffect(() => {
    if (nudgeToken === 0 || !nudgeGoal) return;
    void runGoalBuild(nudgeGoal);
  }, [nudgeToken, nudgeGoal]);

  // Boot: a share URL (?scene=…&seed=…) reconstructs that exact procedural
  // world — the seed is sufficient, no coordinates travel in the link.
  // Otherwise the first visit opens on the authored reference diorama.
  useEffect(() => {
    const shared = parseShareParams(window.location.search);
    if (shared) {
      void callTownTool("compose_scene", { theme: shared.prompt, seed: shared.seed });
      return;
    }
    seedReferenceScene();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  function toolBtn(id: ToolMode, label: string, Icon: (p: { active?: boolean }) => React.ReactNode) {
    return (
      <button
        key={id}
        type="button"
        className="rail-btn tip"
        data-tip={label}
        data-active={tool === id}
        aria-label={label}
        onClick={() => setTool(id)}
        onPointerEnter={(e) => {
          setHotId(id);
          hot.onPointerEnter(e);
        }}
        onPointerLeave={(e) => {
          setHotId(null);
          hot.onPointerLeave(e);
        }}
      >
        <Icon active={hotId === id || tool === id} />
      </button>
    );
  }

  return (
    <main
      className="studio"
      style={{ "--agent-accent": AGENT_ACCENT } as CSSProperties}
    >
      <Stage3D />

      <Notch />

      <GooeyRail side="left" className="studio-tools">
        <RailSection>
          {toolBtn("select", "Select", (p) => (
            <SelectIcon {...p} />
          ))}
          {toolBtn("hand", "Hand — Pan", (p) => (
            <HandIcon {...p} />
          ))}
        </RailSection>
        <RailDivider />
        <RailSection>
          <button
            type="button"
            className="rail-btn tip"
            data-tip="Kit — Pick a Piece"
            data-active={kitOpen}
            aria-label="Kit palette"
            onClick={() => setKitOpen(!kitOpen)}
            onPointerEnter={(e) => {
              setHotId("kit");
              hot.onPointerEnter(e);
            }}
            onPointerLeave={(e) => {
              setHotId(null);
              hot.onPointerLeave(e);
            }}
          >
            <KitIcon active={hotId === "kit" || kitOpen} />
          </button>
        </RailSection>
        <RailDivider />
        <RailSection>
          <button
            type="button"
            className="rail-btn tip"
            data-tip="Undo"
            aria-label="Undo"
            disabled={undoDepth === 0}
            onClick={undo}
            onPointerEnter={(e) => {
              setHotId("undo");
              hot.onPointerEnter(e);
            }}
            onPointerLeave={(e) => {
              setHotId(null);
              hot.onPointerLeave(e);
            }}
          >
            <UndoIcon active={hotId === "undo" && undoDepth > 0} />
          </button>
        </RailSection>
      </GooeyRail>

      <Rail aboutOpen={aboutOpen && !aboutClosing} onAbout={toggleAbout} />
      <AboutDialog open={aboutOpen} closing={aboutClosing} onClose={closeAbout} />
      <Inspector />
      <KitPalette open={kitOpen} />
      <AgentCursor />

      <footer className="studio-meta">
        {webmcp === "missing" ? (
          <span>
            WebMCP unavailable.{" "}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                setWebmcp("pending");
                setRetry((n) => n + 1);
              }}
            >
              Retry
            </button>
          </span>
        ) : (
          <span>WebMCP {webmcp === "pending" ? "…" : "on"}</span>
        )}
        {lastError && <div className="studio-error">{lastError}</div>}
      </footer>

      <div className="studio-hint">
        Select to drag objects · F to flip toward each other · pick a piece, click anywhere · Space + drag to pan · scroll to zoom
      </div>
      <SeedChip />
      <HoverTipHost />
    </main>
  );
}
