"use client";

import {
  bumpMotionGen,
  isMotionCurrent,
  kitPalettePoint,
  lotScreenPoint,
  sleep,
  travelCursor,
  waitForKitCell,
} from "./agentMotion";
import { catalogItem } from "./catalog";
import { useTown } from "./store";
import { phraseForCatalog } from "./story";
import { callTownTool } from "./town";

/**
 * Local Nudge fulfillment. Committing a goal must DO something even when no
 * WebMCP host is attached, so the page runs the same tool pipeline an
 * external agent would: read the map, plan toward the goal, then grab each
 * kit piece and place it — with the agent cursor visible the whole way.
 */

function parse(result: ModelContextToolResult): Record<string, unknown> {
  try {
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

let runId = 0;

// --- Inspect & refine ------------------------------------------------------

function lotCoord(lot: string): { col: number; row: number } | null {
  const cr = /^C(-?\d+)R(-?\d+)$/.exec(lot);
  if (cr) return { col: Number(cr[1]), row: Number(cr[2]) };
  const an = /^([A-Z]+)(\d+)$/.exec(lot);
  if (!an) return null;
  let col = 0;
  for (const ch of an[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(an[2]) - 1 };
}

function coordLot(col: number, row: number): string {
  if (col < 0 || row < 0) return `C${col}R${row}`;
  let n = col + 1;
  let letters = "";
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

const NUDGE_STEPS: [number, number][] = [
  [2, 0],
  [0, 2],
  [-2, 0],
  [0, -2],
  [2, 1],
  [1, 2],
  [-2, 1],
  [1, -2],
  [2, -1],
  [-1, 2],
  [-2, -1],
  [-1, -2],
];

/**
 * The look-it-over pass after a build: read the scene back and ask whether it
 * still holds together as one place. Any agent piece stranded more than three
 * cells from everything else gets walked in near its nearest neighbor —
 * collisions and human locks during placement can fling pieces wide, and this
 * is what tucks them back into the composition. Targets sit two cells out so
 * we never collapse a tree into a log.
 */
async function inspectAndRefine(id: number, gen: number): Promise<void> {
  const scene = parse(await callTownTool("get_scene"));
  const rows = Array.isArray(scene.pieces) ? (scene.pieces as string[]) : [];
  if (rows.length < 3) return;
  const pieces = rows.flatMap((row) => {
    const [pid, lot, , owner] = row.split(":");
    const at = lotCoord(lot ?? "");
    return at ? [{ id: pid, lot, owner, at }] : [];
  });
  const occupied = new Set(pieces.map((p) => p.lot));
  const cheb = (a: { col: number; row: number }, b: { col: number; row: number }) =>
    Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

  useTown.getState().setAgentStatus("looking it over");
  let moved = 0;
  for (const piece of pieces) {
    if (moved >= 3 || piece.owner !== "agent") continue;
    let nearest: (typeof pieces)[number] | null = null;
    let best = Infinity;
    for (const other of pieces) {
      if (other === piece) continue;
      const d = cheb(piece.at, other.at);
      if (d < best) {
        best = d;
        nearest = other;
      }
    }
    if (!nearest || best <= 3) continue;
    if (id !== runId || !isMotionCurrent(gen)) return;
    useTown.getState().setAgentStatus("pulling a straggler in");
    for (const [dc, dr] of NUDGE_STEPS) {
      const lot = coordLot(nearest.at.col + dc, nearest.at.row + dr);
      if (occupied.has(lot)) continue;
      if (id !== runId || !isMotionCurrent(gen)) return;
      const pt = lotScreenPoint(lot);
      if (pt) await travelCursor(pt, 380, gen);
      const res = parse(
        await callTownTool("move_piece", { id: piece.id, lot, intent: "pulling a straggler in" }),
      );
      if (res.error) continue;
      occupied.delete(piece.lot);
      occupied.add(lot);
      piece.lot = lot;
      piece.at = lotCoord(lot) ?? piece.at;
      moved += 1;
      break;
    }
  }
  useTown.getState().setAgentStatus(
    moved ? `tightened the scene — pulled ${moved} closer` : "looked it over — it holds together",
  );
}

export async function runGoalBuild(goal: string): Promise<void> {
  const id = ++runId;
  const gen = bumpMotionGen();
  const store = useTown.getState();
  store.setAgentLoop(true);
  store.setAgentBusy(true);
  store.setKitOpen(true);
  store.setAgentStatus(`building ${goal}`);
  await sleep(300, gen);
  const kitHome = kitPalettePoint() ?? { x: 160, y: window.innerHeight * 0.38 };
  store.setAgentCursor({
    x: kitHome.x,
    y: kitHome.y,
    visible: true,
  });

  try {
    const occ = parse(await callTownTool("get_occupancy"));
    if (id !== runId || !isMotionCurrent(gen)) return;
    const plan = parse(await callTownTool("plan_scene", { theme: goal }));
    if (id !== runId || !isMotionCurrent(gen)) return;
    const todos = (plan.todos ?? []) as { place: string; lot: string; flip?: boolean; rot?: number; reason?: string }[];
    if (!todos.length) {
      store.setAgentStatus("Nudge set — nothing to place for that goal");
      return;
    }
    const locks = Array.isArray(occ.human_locks) ? occ.human_locks.length : 0;
    store.setAgentStatus("laying the ground");
    await sleep(1600, gen);
    if (id !== runId || !isMotionCurrent(gen)) return;
    store.setAgentStatus(locks ? `building ${goal} around yours` : `building ${goal}`);

    let lastGrab: string | null = null;
    for (const todo of todos) {
      if (id !== runId || !isMotionCurrent(gen)) return;
      const item = catalogItem(todo.place);
      const label = item ? phraseForCatalog(item.id, item.kind) : todo.place;
      // Chip first, then motion — otherwise the line lags the cursor by a whole hop.
      useTown.getState().setAgentStatus(todo.reason ? `placing ${label} — ${todo.reason}` : `placing ${label}`);

      if (todo.place !== lastGrab) {
        useTown.getState().setKitOpen(true);
        const kitPt = await waitForKitCell(todo.place, gen);
        if (kitPt && isMotionCurrent(gen)) {
          await travelCursor(kitPt, 420, gen);
          useTown.getState().setAgentGrabId(todo.place);
          await sleep(220, gen);
        } else {
          useTown.getState().setAgentGrabId(todo.place);
        }
        lastGrab = todo.place;
      }

      if (id !== runId || !isMotionCurrent(gen)) return;
      useTown.getState().setAgentGhost({ lot: todo.lot, catalogId: todo.place });
      const lotPt = lotScreenPoint(todo.lot);
      if (lotPt) await travelCursor(lotPt, 520, gen);
      if (id !== runId || !isMotionCurrent(gen)) return;
      await callTownTool("place_piece", {
        id: todo.place,
        lot: todo.lot,
        flip: Boolean(todo.flip),
        ...(todo.rot ? { rot: todo.rot } : {}),
        intent: todo.reason ? `placing ${label} — ${todo.reason}` : `placing ${label}`,
        // Zone reason flows into the story log so the recap can narrate the
        // scene as a built place, zone by zone.
        ...(todo.reason ? { reason: todo.reason } : {}),
      });
      await sleep(140, gen);
    }

    if (id !== runId || !isMotionCurrent(gen)) return;
    await inspectAndRefine(id, gen);
  } finally {
    if (id === runId) {
      const latest = useTown.getState();
      latest.setAgentLoop(false);
      latest.setAgentBusy(false);
      latest.setAgentStatus(null);
      latest.setAgentGrabId(null);
      latest.setAgentGhost(null);
      latest.setAgentCursor(latest.agentCursor ? { ...latest.agentCursor, visible: false } : null);
    }
  }
}
