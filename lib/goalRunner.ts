"use client";

import { bumpMotionGen, isMotionCurrent, lotScreenPoint, sleep, travelCursor, waitForKitCell, waitForKitPalette } from "./agentMotion";
import { catalogItem } from "./catalog";
import { useTown } from "./store";
import { phraseForCatalog } from "./story";
import { callTownTool, setPlacementPacer, type PlacementOutcomeHook, type PlacementStep } from "./town";

/**
 * Local goal fulfillment (the Surprise Me button). Committing a goal must DO
 * something even when no WebMCP host is attached, so the page runs the SAME
 * lifecycle the Scene Architect prompt prescribes for an external agent —
 * through the same WebMCP tools, tagged as the runner:
 *
 *   get_occupancy → get_scene_rules → plan_scene → compose_scene
 *   → populate_zones → create_environment → get_scene → validate_scene
 *   → repair_scene → validate_scene (until complete, bounded)
 *
 * The runner never places a piece itself. The bulk tools do the placing;
 * the runner installs a PACER the tools await before every drop, which is
 * what walks the agent cursor to the kit and to each lot. The Agent Build
 * panel therefore tallies eight or nine semantic calls — never a wall of
 * place_piece.
 */

function parse(result: ModelContextToolResult): Record<string, unknown> {
  try {
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

let runId = 0;

class Cancelled extends Error {
  constructor() {
    super("build cancelled");
  }
}

// TEMPO — the build is a little performance; everything follows one beat.
const TEMPO = {
  kitTravel: 420, // cursor gliding to the shelf
  grabHold: 160, // pause at the shelf before leaving
  firstDrop: 440, // travel to the first lot of a carry
  hop: 280, // hop between drops of the same carry
  settle: 120, // beat after each landing
  frameHop: 150, // hops while framing the edge — many pieces, quicker
  phaseBreath: 700, // pause between lifecycle phases so the chip reads
  refusal: 520, // hold the "no room" line long enough to read
};

/**
 * A pacer for one phase: the cursor visits the kit when the piece changes,
 * then hops to the lot; each drop lands as the cursor arrives. Throws when
 * a newer build cancelled this one so the bulk tool stops mid-list instead
 * of building into the next scene.
 */
function makePacer(id: number, gen: number, phase: "populate" | "environment") {
  let lastGrab: string | null = null;
  let first = true;
  return async (step: PlacementStep) => {
    if (id !== runId || !isMotionCurrent(gen)) throw new Cancelled();
    const store = useTown.getState();
    const item = catalogItem(step.catalogId);
    const label = item ? phraseForCatalog(item.id, item.kind) : step.catalogId;
    const quick = phase === "environment";
    // Every change of piece is a trip to the shelf — framing included, just
    // at a quicker tempo. Repeats of the same piece hop straight on.
    if (step.catalogId !== lastGrab) {
      store.setKitOpen(true);
      store.setAgentStatus(`grabbing ${label}${step.reason ? ` — ${step.reason}` : ""}`);
      const kitPt = await waitForKitCell(step.catalogId, gen);
      if (kitPt && isMotionCurrent(gen)) await travelCursor(kitPt, quick ? TEMPO.kitTravel * 0.55 : TEMPO.kitTravel, gen);
      store.setAgentGrabId(step.catalogId);
      await sleep(quick ? TEMPO.grabHold * 0.5 : TEMPO.grabHold, gen);
      lastGrab = step.catalogId;
    } else {
      store.setAgentGrabId(step.catalogId);
    }
    if (id !== runId || !isMotionCurrent(gen)) throw new Cancelled();
    const remaining = step.total - step.index;
    store.setAgentCarry({ catalogId: step.catalogId, count: Math.min(remaining, 9) });
    store.setAgentStatus(`placing ${label}${step.reason ? ` — ${step.reason}` : ""}`);
    const pt = lotScreenPoint(step.lot);
    if (pt) await travelCursor(pt, first ? TEMPO.firstDrop : quick ? TEMPO.frameHop : TEMPO.hop, gen);
    first = false;
    store.setAgentGhost({ lot: step.lot, catalogId: step.catalogId });
    if (id !== runId || !isMotionCurrent(gen)) throw new Cancelled();
    // The drop lands when we return; settle after.
    window.setTimeout(() => {
      const s = useTown.getState();
      if (remaining <= 1) s.setAgentCarry(null);
    }, 0);
    await sleep(TEMPO.settle, gen);
  };
}

/** After each paced drop: say so when a piece found no room, instead of
 * narrating a placement that never happened. */
function makeOutcomeHook(id: number, gen: number): PlacementOutcomeHook {
  return async (step, outcome) => {
    if (id !== runId || !isMotionCurrent(gen)) return;
    const item = catalogItem(step.catalogId);
    const label = item ? phraseForCatalog(item.id, item.kind) : step.catalogId;
    const store = useTown.getState();
    if (!outcome.ok) {
      store.setAgentStatus(`no room for ${label} — ${outcome.why.replace(/^Lot [A-Z0-9]+ /, "").replace(/\.$/, "").toLowerCase()}`);
      store.setAgentGhost(null);
      await sleep(TEMPO.refusal, gen);
    } else if (outcome.drift > 0) {
      store.setAgentStatus(`placed ${label} ${outcome.drift} cell${outcome.drift === 1 ? "" : "s"} over — the spot was taken`);
      await sleep(TEMPO.settle, gen);
    }
  };
}

const MAX_REPAIR_ROUNDS = 3;

/**
 * INSPECT → VALIDATE → REPAIR until complete or nothing more applies.
 * `theme` names what to judge against; undefined judges the scene as a
 * whole — its base prompt plus everything it was grown with.
 */
async function settle(id: number, gen: number, theme: string | undefined, opts: { noNewGround?: boolean } = {}): Promise<void> {
  const alive = () => id === runId && isMotionCurrent(gen);
  const themed = theme ? { theme } : {};
  // Ground is laid at the start of a build-on; the repair phase furnishes
  // and tidies, it never annexes decks after the fact.
  const scoped = opts.noNewGround ? { exclude: ["zones"] } : {};
  useTown.getState().setAgentStatus("looking it over");
  await callTownTool("get_scene", { limit: 12 }, "runner");
  await sleep(TEMPO.phaseBreath, gen);
  if (!alive()) return;
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    useTown.getState().setAgentStatus("checking the composition");
    const report = parse(await callTownTool("validate_scene", { ...themed }, "runner"));
    if (!alive()) return;
    const completion = String(report.completion ?? "");
    if (report.complete === true) {
      useTown.getState().setAgentStatus(`complete — ${completion}%: ${String(report.verdict ?? "")}`);
      return;
    }
    useTown.getState().setAgentStatus(`${completion}% — ${String(report.verdict ?? "repairing")}`);
    await sleep(TEMPO.phaseBreath, gen);
    if (!alive()) return;
    const repaired = parse(await callTownTool("repair_scene", { max: 6, ...themed, ...scoped }, "runner"));
    if (!alive()) return;
    if (repaired.complete === true) {
      useTown.getState().setAgentStatus(`complete — ${String(repaired.after ?? "")}%`);
      return;
    }
    // No repair landed, or the score did not move: another round would
    // only replay the same refusals. Stop here and report where it stands.
    const landed = typeof repaired.landed === "number" ? repaired.landed : Array.isArray(repaired.applied) ? repaired.applied.length : 0;
    const gained = Number(repaired.after ?? 0) > Number(repaired.before ?? 0);
    if (!landed || !gained) break;
  }
  const final = parse(await callTownTool("validate_scene", { ...themed }, "runner"));
  useTown.getState().setAgentStatus(final.complete === true ? `complete — ${String(final.completion)}%` : `${String(final.completion ?? "")}% — ${String(final.verdict ?? "as far as it goes")}`);
}

export type GoalMode = "fresh" | "extend";

/** Screen point over the open canvas — clear of the kit/rail stack. */
function stageHome() {
  return { x: window.innerWidth * 0.52, y: window.innerHeight * 0.48 };
}

/** Match Stage3D's focus ease (900ms) plus a beat so lot projections are stable. */
const FOCUS_SETTLE_MS = 1000;

export async function runGoalBuild(goal: string, mode: GoalMode = "fresh"): Promise<void> {
  const id = ++runId;
  const gen = bumpMotionGen();
  const store = useTown.getState();
  store.setAgentLoop(true);
  store.setAgentBusy(true);
  store.setKitOpen(true);
  store.setAgentStatus(`understanding “${goal}”`);
  await waitForKitPalette(gen);
  const alive = () => id === runId && isMotionCurrent(gen);
  if (!alive()) {
    store.setAgentLoop(false);
    store.setAgentBusy(false);
    return;
  }
  // Stay on the open canvas through plan/compose — parking on the kit while the
  // camera reframes makes the pointer look like it teleports when building starts.
  store.setAgentCursor({ ...stageHome(), visible: true });
  await sleep(280, gen);
  if (!alive()) return;

  try {
    // UNDERSTAND
    await callTownTool("get_occupancy", {}, "runner");
    if (!alive()) return;
    await callTownTool("get_scene_rules", {}, "runner");
    if (!alive()) return;

    if (mode === "extend") {
      // GROW — one additive call does the ground, the story objects, and
      // the frame; the pacer walks the cursor through every drop. Then the
      // same inspect → validate → repair loop, judging the whole scene.
      useTown.getState().setAgentStatus(`building on the world: ${goal}`);
      await sleep(TEMPO.phaseBreath, gen);
      if (!alive()) return;
      // Camera may reframe as zones annex — wait it out before the first grab.
      await sleep(FOCUS_SETTLE_MS, gen);
      if (!alive()) return;
      setPlacementPacer(makePacer(id, gen, "populate"), makeOutcomeHook(id, gen));
      let grown: Record<string, unknown>;
      try {
        grown = parse(await callTownTool("extend_scene", { prompt: goal, validate: false }, "runner"));
      } finally {
        setPlacementPacer(null);
        useTown.getState().setAgentCarry(null);
        useTown.getState().setAgentGrabId(null);
        useTown.getState().setAgentGhost(null);
      }
      if (!alive()) return;
      if (grown.error) {
        useTown.getState().setAgentStatus(String(grown.error));
        return;
      }
      useTown.getState().setAgentStatus(grown.story ? `added: ${String(grown.story)}` : "added to the world");
      await sleep(TEMPO.phaseBreath, gen);
      if (!alive()) return;
      await settle(id, gen, undefined, { noNewGround: true });
      return;
    }

    // PLAN
    useTown.getState().setAgentStatus("planning the world");
    const plan = parse(await callTownTool("plan_scene", { theme: goal }, "runner"));
    if (!alive()) return;
    const intent = plan.intent as { scene_type?: string; story?: string } | undefined;
    if (plan.error || !plan.plan_id) {
      useTown.getState().setAgentStatus("couldn't plan that goal");
      return;
    }
    useTown.getState().setAgentStatus(intent?.story ? `planned: ${intent.story}` : `planned a ${intent?.scene_type ?? "scene"}`);
    await sleep(TEMPO.phaseBreath + 400, gen);
    if (!alive()) return;

    // COMPOSE — architecture lands and the camera eases to frame it.
    useTown.getState().setAgentStatus("laying out the ground and zones");
    await callTownTool("compose_scene", { plan_id: plan.plan_id }, "runner");
    if (!alive()) return;
    await sleep(FOCUS_SETTLE_MS, gen);
    if (!alive()) return;

    // EXECUTE — now glide to the kit and place; lot projections are stable.
    setPlacementPacer(makePacer(id, gen, "populate"), makeOutcomeHook(id, gen));
    try {
      await callTownTool("populate_zones", { intent: `building ${intent?.scene_type?.replace(/_/g, " ") ?? goal}` }, "runner");
      if (!alive()) return;
      setPlacementPacer(makePacer(id, gen, "environment"), makeOutcomeHook(id, gen));
      useTown.getState().setAgentStatus("framing the edge");
      await callTownTool("create_environment", {}, "runner");
    } finally {
      setPlacementPacer(null);
      useTown.getState().setAgentCarry(null);
      useTown.getState().setAgentGrabId(null);
      useTown.getState().setAgentGhost(null);
    }
    if (!alive()) return;

    // INSPECT → VALIDATE → REPAIR, bounded.
    await settle(id, gen, goal);
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
  } finally {
    setPlacementPacer(null);
    if (id === runId) {
      const latest = useTown.getState();
      latest.setAgentLoop(false);
      latest.setAgentBusy(false);
      latest.setAgentGrabId(null);
      latest.setAgentCarry(null);
      latest.setAgentGhost(null);
      latest.setAgentCursor(latest.agentCursor ? { ...latest.agentCursor, visible: false } : null);
    }
  }
}
