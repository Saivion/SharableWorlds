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
 * Local goal fulfillment (the Surprise Me button). Committing a goal must DO
 * something even when no WebMCP host is attached, so the page runs the SAME
 * tool lifecycle the Scene Architect prompt prescribes for an external agent:
 * get_occupancy → plan_scene → choreographed placement (each piece lands as
 * the cursor arrives — kit grabs are batched, drops are not dumped) →
 * inspect (get_scene) → validate_scene → repair the named checks
 * (create_vegetation / create_prop_cluster / create_focal_point / move_piece)
 * → validate_scene again — with the agent cursor visible the whole way.
 * The Agent Build panel tallies exactly these calls; it should read as an
 * orchestrated build, never as a wall of primitives.
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

// --- Validate & repair -----------------------------------------------------

type ZoneRect = { id: string; type: string; c0: number; r0: number; w: number; d: number };

/** plan_scene reports zones as "id:type@LOT WxD" strings — recover the rects. */
function parseZoneRects(zones: unknown): ZoneRect[] {
  if (!Array.isArray(zones)) return [];
  const out: ZoneRect[] = [];
  for (const entry of zones) {
    const m = /^([a-z0-9-]+):([a-z]+)@([A-Z]+\d+|C-?\d+R-?\d+) (\d+)x(\d+)/.exec(String(entry));
    if (!m) continue;
    const at = lotCoord(m[3]);
    if (!at) continue;
    out.push({ id: m[1], type: m[2], c0: at.col, r0: at.row, w: Number(m[4]), d: Number(m[5]) });
  }
  return out;
}

/** Lots inside a zone rect, nearest-to-center first — move_piece rejects
 * collisions itself, so the caller just walks the list until one lands. */
function zoneLots(z: ZoneRect): string[] {
  const cells: { lot: string; d: number }[] = [];
  const cx = z.c0 + (z.w - 1) / 2;
  const cy = z.r0 + (z.d - 1) / 2;
  for (let r = z.r0; r < z.r0 + z.d; r += 1) {
    for (let c = z.c0; c < z.c0 + z.w; c += 1) {
      cells.push({ lot: coordLot(c, r), d: Math.abs(c - cx) + Math.abs(r - cy) });
    }
  }
  return cells.sort((a, b) => a.d - b.d).map((c) => c.lot);
}

const REPAIR_CAP = 4;

/**
 * The lifecycle's closing loop: validate_scene, repair what the failed
 * checks themselves prescribe (each names its fix), then validate again.
 * One round, capped — the runner polishes, it does not thrash.
 */
async function validateAndRepair(id: number, gen: number, theme: string, zones: ZoneRect[]): Promise<void> {
  const store = useTown.getState();
  store.setAgentStatus("checking the composition");
  const report = parse(await callTownTool("validate_scene", { theme }));
  if (id !== runId || !isMotionCurrent(gen)) return;
  const checks = Array.isArray(report.checks) ? (report.checks as string[]) : [];
  const failed = checks.filter((c) => c.includes("✗"));
  if (report.complete === true || !failed.length) {
    store.setAgentStatus(`validated — ${String(report.completion ?? "complete")}`);
    return;
  }

  let repairs = 0;
  for (const check of failed) {
    if (repairs >= REPAIR_CAP) break;
    if (id !== runId || !isMotionCurrent(gen)) return;
    if (check.includes("environmental_boundary")) {
      store.setAgentStatus("thickening the boundary");
      await callTownTool("create_vegetation", { area: "edge", density: "medium" });
      repairs += 1;
    } else if (check.includes("zones_populated")) {
      const zone = /empty zone: ([a-z0-9-]+)/.exec(check)?.[1];
      if (!zone) continue;
      store.setAgentStatus(`furnishing the ${zone}`);
      await callTownTool("create_prop_cluster", { zone });
      repairs += 1;
    } else if (check.includes("focal_point")) {
      store.setAgentStatus("raising a landmark");
      await callTownTool("create_focal_point", {});
      repairs += 1;
    } else if (check.includes("characters_in_zones")) {
      // The check names the strays as id@LOT; walk up to two into a zone.
      const strays = [...check.matchAll(/([a-z0-9-]+-\d+)@(?:[A-Z]+\d+|C-?\d+R-?\d+)/g)].map((m) => m[1]);
      const target = zones.find((z) => z.type === "plaza") ?? zones[0];
      if (!target || !strays.length) continue;
      const lots = zoneLots(target);
      let walked = 0;
      for (const stray of strays.slice(0, 2)) {
        if (id !== runId || !isMotionCurrent(gen)) return;
        store.setAgentStatus("walking a wanderer back in");
        for (const lot of lots.slice(0, 10)) {
          if (id !== runId || !isMotionCurrent(gen)) return;
          const pt = lotScreenPoint(lot);
          if (pt) await travelCursor(pt, 320, gen);
          const res = parse(await callTownTool("move_piece", { id: stray, lot, intent: "walking a wanderer back in" }));
          if (!res.error) {
            walked += 1;
            break;
          }
        }
      }
      if (walked) repairs += 1;
    }
  }

  if (!repairs) {
    store.setAgentStatus(`validated — ${String(report.completion ?? "")}`);
    return;
  }
  if (id !== runId || !isMotionCurrent(gen)) return;
  const again = parse(await callTownTool("validate_scene", { theme }));
  const pct = String(again.completion ?? "");
  store.setAgentStatus(
    again.complete === true
      ? `validated — complete${pct ? ` (${pct})` : ""}`
      : `repaired ${repairs} — ${pct || "still settling"}`,
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

    // Bulk carries: consecutive todos of the same piece become ONE grab —
    // the cursor visits the kit once, the carry counter ticks up to N, and
    // the N pieces land on a steady beat instead of N palette round-trips.
    //
    // TEMPO — the build is a little performance, and everything follows one
    // beat: the counter ticks up so each number is readable, the full
    // armload holds for a breath, and every landing gets its own moment.
    // Tune here, never inline.
    const TEMPO = {
      kitTravel: 480, // cursor gliding to the shelf
      countTick: 130, // per +1 on the carry counter
      armloadHold: 380, // pause with the full armload before leaving the kit
      firstDrop: 520, // travel to the first lot of a carry
      hop: 340, // hop between drops of the same carry
      settle: 190, // beat after each landing (counter ticks down here)
      groupRest: 260, // breath between carries
    };

    // The build is packed into ACTS — kit visits are batched, but every
    // drop is placed as the cursor arrives so pieces land one by one
    // (never dump-then-tour):
    //   carry — one kit grab, counter ticks up, then hop+place each drop
    //           while the armload counts down.
    //   tray  — one kit visit flipping through sprites, then hop+place
    //           each gathered piece on its lot.
    //   solo  — 1-2 stray singles: place_piece with its own kit grab.
    type Todo = (typeof todos)[number];
    type Act =
      | { kind: "carry"; place: string; todos: Todo[] }
      | { kind: "tray"; todos: Todo[] }
      | { kind: "solo"; todo: Todo };
    const TRAY_MIN = 3;
    const TRAY_MAX = 8;
    const runs: { place: string; todos: Todo[] }[] = [];
    for (const todo of todos) {
      const last = runs[runs.length - 1];
      if (last && last.place === todo.place) last.todos.push(todo);
      else runs.push({ place: todo.place, todos: [todo] });
    }
    const acts: Act[] = [];
    let tray: Todo[] = [];
    const flushTray = () => {
      if (tray.length >= TRAY_MIN) acts.push({ kind: "tray", todos: tray });
      else for (const todo of tray) acts.push({ kind: "solo", todo });
      tray = [];
    };
    for (const run of runs) {
      if (run.todos.length > 1) {
        flushTray();
        acts.push({ kind: "carry", place: run.place, todos: run.todos });
      } else {
        tray.push(run.todos[0]);
        if (tray.length >= TRAY_MAX) flushTray();
      }
    }
    flushTray();

    const labelFor = (place: string) => {
      const item = catalogItem(place);
      return item ? phraseForCatalog(item.id, item.kind) : place;
    };

    for (const act of acts) {
      if (id !== runId || !isMotionCurrent(gen)) return;

      if (act.kind === "carry") {
        const n = act.todos.length;
        const label = labelFor(act.place);
        const reason = act.todos[0].reason;
        // Chip first, then motion — otherwise the line lags the cursor by a whole hop.
        useTown.getState().setAgentStatus(`grabbing ${n} × ${label}${reason ? ` — ${reason}` : ""}`);
        useTown.getState().setKitOpen(true);
        const kitPt = await waitForKitCell(act.place, gen);
        if (kitPt && isMotionCurrent(gen)) await travelCursor(kitPt, TEMPO.kitTravel, gen);
        useTown.getState().setAgentGrabId(act.place);
        // Count the carry up at the shelf — every number readable, and very
        // large armloads compress so the count-up never drags past ~10 ticks.
        const step = n > 10 ? Math.ceil(n / 10) : 1;
        for (let c = step; ; c += step) {
          if (id !== runId || !isMotionCurrent(gen)) return;
          const shown = Math.min(n, c);
          useTown.getState().setAgentCarry({ catalogId: act.place, count: shown });
          if (shown >= n) break;
          await sleep(TEMPO.countTick, gen);
        }
        await sleep(TEMPO.armloadHold, gen);
        if (id !== runId || !isMotionCurrent(gen)) return;
        useTown.getState().setAgentStatus(`placing ${n} × ${label}${reason ? ` — ${reason}` : ""}`);
        // Place each drop as the cursor arrives — never dump the whole
        // armload then hop empty lots like a count tour.
        let remaining = n;
        let first = true;
        for (const todo of act.todos) {
          if (id !== runId || !isMotionCurrent(gen)) return;
          const lotPt = lotScreenPoint(todo.lot);
          if (lotPt) await travelCursor(lotPt, first ? TEMPO.firstDrop : TEMPO.hop, gen);
          first = false;
          if (id !== runId || !isMotionCurrent(gen)) return;
          useTown.getState().setAgentGhost({ lot: todo.lot, catalogId: act.place });
          await callTownTool("place_piece", {
            id: todo.place,
            lot: todo.lot,
            flip: Boolean(todo.flip),
            ...(todo.rot ? { rot: todo.rot } : {}),
            intent: `placing ${label}${todo.reason ? ` — ${todo.reason}` : ""}`,
            ...(todo.reason ? { reason: todo.reason } : {}),
          });
          remaining -= 1;
          useTown.getState().setAgentCarry(remaining > 0 ? { catalogId: act.place, count: remaining } : null);
          await sleep(remaining > 0 ? TEMPO.settle : TEMPO.groupRest, gen);
        }
      } else if (act.kind === "tray") {
        const n = act.todos.length;
        const reasons = new Set(act.todos.map((t) => t.reason).filter(Boolean));
        const trayLine = reasons.size === 1 ? ` — ${[...reasons][0]}` : "";
        useTown.getState().setAgentStatus(`gathering ${n} pieces${trayLine}`);
        useTown.getState().setKitOpen(true);
        const kitPt = await waitForKitCell(act.todos[0].place, gen);
        if (kitPt && isMotionCurrent(gen)) await travelCursor(kitPt, TEMPO.kitTravel, gen);
        // Flip the grab chip through the tray at the shelf — the collecting
        // gesture, one sprite per tick.
        for (const todo of act.todos) {
          if (id !== runId || !isMotionCurrent(gen)) return;
          useTown.getState().setAgentGrabId(todo.place);
          await sleep(TEMPO.countTick, gen);
        }
        await sleep(TEMPO.armloadHold, gen);
        if (id !== runId || !isMotionCurrent(gen)) return;
        // Drop each gathered piece when the cursor lands on its lot.
        let first = true;
        for (const todo of act.todos) {
          if (id !== runId || !isMotionCurrent(gen)) return;
          const pieceLabel = labelFor(todo.place);
          useTown.getState().setAgentStatus(todo.reason ? `placing ${pieceLabel} — ${todo.reason}` : `placing ${pieceLabel}`);
          useTown.getState().setAgentGrabId(todo.place);
          const lotPt = lotScreenPoint(todo.lot);
          if (lotPt) await travelCursor(lotPt, first ? TEMPO.firstDrop : TEMPO.hop, gen);
          first = false;
          if (id !== runId || !isMotionCurrent(gen)) return;
          useTown.getState().setAgentGhost({ lot: todo.lot, catalogId: todo.place });
          await callTownTool("place_piece", {
            id: todo.place,
            lot: todo.lot,
            flip: Boolean(todo.flip),
            ...(todo.rot ? { rot: todo.rot } : {}),
            intent: todo.reason ? `placing ${pieceLabel} — ${todo.reason}` : `placing ${pieceLabel}`,
            ...(todo.reason ? { reason: todo.reason } : {}),
          });
          await sleep(TEMPO.settle, gen);
        }
        await sleep(TEMPO.groupRest, gen);
      } else {
        // A single piece is exactly what the place_piece primitive is for.
        const todo = act.todo;
        const label = labelFor(todo.place);
        const reason = todo.reason;
        useTown.getState().setAgentStatus(reason ? `placing ${label} — ${reason}` : `placing ${label}`);
        useTown.getState().setKitOpen(true);
        const kitPt = await waitForKitCell(todo.place, gen);
        if (kitPt && isMotionCurrent(gen)) await travelCursor(kitPt, TEMPO.kitTravel, gen);
        useTown.getState().setAgentGrabId(todo.place);
        useTown.getState().setAgentCarry({ catalogId: todo.place, count: 1 });
        if (id !== runId || !isMotionCurrent(gen)) return;
        useTown.getState().setAgentGhost({ lot: todo.lot, catalogId: todo.place });
        const lotPt = lotScreenPoint(todo.lot);
        if (lotPt) await travelCursor(lotPt, TEMPO.firstDrop, gen);
        if (id !== runId || !isMotionCurrent(gen)) return;
        await callTownTool("place_piece", {
          id: todo.place,
          lot: todo.lot,
          flip: Boolean(todo.flip),
          ...(todo.rot ? { rot: todo.rot } : {}),
          intent: reason ? `placing ${label} — ${reason}` : `placing ${label}`,
          ...(todo.reason ? { reason: todo.reason } : {}),
        });
        useTown.getState().setAgentCarry(null);
        await sleep(TEMPO.groupRest, gen);
      }
      useTown.getState().setAgentCarry(null);
    }

    if (id !== runId || !isMotionCurrent(gen)) return;
    await inspectAndRefine(id, gen);
    if (id !== runId || !isMotionCurrent(gen)) return;
    await validateAndRepair(id, gen, goal, parseZoneRects(plan.zones));
  } finally {
    if (id === runId) {
      const latest = useTown.getState();
      latest.setAgentLoop(false);
      latest.setAgentBusy(false);
      latest.setAgentStatus(null);
      latest.setAgentGrabId(null);
      latest.setAgentCarry(null);
      latest.setAgentGhost(null);
      latest.setAgentCursor(latest.agentCursor ? { ...latest.agentCursor, visible: false } : null);
    }
  }
}
