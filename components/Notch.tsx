"use client";

import { AgentBuild } from "./AgentBuild";
import { SurprisePill } from "./SurprisePill";

/**
 * Top chrome: wordmark left, Surprise Me top-right, and — while the agent
 * works — a centered Agent Building chip with a Details dropdown.
 */
export function Notch() {
  return (
    <>
      <div className="studio-wordmark">SharableWorlds</div>
      <SurprisePill />
      <AgentBuild />
    </>
  );
}
