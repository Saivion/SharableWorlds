"use client";

import { isoOf } from "./iso";
import { projectLot } from "./stageProjection";
import { useTown } from "./store";
import { parseLot } from "./town";

/** Shared generation so a new Nudge can cancel in-flight travel. */
let motionGen = 0;

export function bumpMotionGen() {
  motionGen += 1;
  return motionGen;
}

export function isMotionCurrent(gen: number) {
  return gen === motionGen;
}

/** True when the page can't be seen — background tab, hidden pane. Timers get
 * throttled to a crawl there and animation frames stop entirely, so motion
 * helpers skip the show and let the build finish at full speed. */
function unwatched() {
  return document.visibilityState !== "visible";
}

export function sleep(ms: number, gen?: number) {
  if (unwatched()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    window.setTimeout(() => {
      if (gen == null || isMotionCurrent(gen)) resolve();
      else resolve();
    }, ms);
  });
}

function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function kitPalette(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".kit-palette");
}

function resolveKitCell(catalogId: string): HTMLElement | null {
  const exact = document.querySelector<HTMLElement>(`.kit-palette [data-catalog-id="${catalogId}"]`);
  if (exact) return exact;
  const prefix = catalogId.split("-")[0] ?? "";
  if (!prefix) return null;
  return document.querySelector<HTMLElement>(`.kit-palette [data-catalog-id^="${prefix}-"]`);
}

function scrollKitCellIntoView(el: HTMLElement, palette: HTMLElement) {
  const pr = palette.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const delta = er.top + er.height / 2 - (pr.top + pr.height / 2);
  if (Math.abs(delta) > 4) palette.scrollTop += delta;
}

function pointInside(el: HTMLElement, palette: HTMLElement): { x: number; y: number } | null {
  const r = el.getBoundingClientRect();
  const p = palette.getBoundingClientRect();
  const visible = r.bottom > p.top + 4 && r.top < p.bottom - 4 && r.right > p.left && r.left < p.right;
  if (!visible) return null;
  return { x: r.left + Math.min(12, r.width * 0.35), y: r.top + r.height / 2 };
}

/** Screen point of a kit cell — only after it is scrolled into the open palette. */
export function kitCellPoint(catalogId: string): { x: number; y: number } | null {
  const palette = kitPalette();
  const el = resolveKitCell(catalogId);
  if (!palette || !el) return null;
  scrollKitCellIntoView(el, palette);
  return pointInside(el, palette);
}

export function kitPalettePoint(): { x: number; y: number } | null {
  const palette = kitPalette();
  if (!palette) return null;
  const r = palette.getBoundingClientRect();
  return { x: r.left + 36, y: r.top + Math.min(80, r.height / 3) };
}

export function lotScreenPoint(lot: string): { x: number; y: number } | null {
  // The 3D stage registers a camera projector; the SVG CTM path below is the
  // legacy fallback for the 2D sprite stage.
  const projected = projectLot(lot);
  if (projected) return projected;
  const parsed = parseLot(lot);
  const svg = document.querySelector<SVGSVGElement>("svg.stage");
  if (!parsed || !svg) return null;
  const { x, y } = isoOf(parsed.col, parsed.row);
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  const screen = pt.matrixTransform(ctm);
  return { x: screen.x, y: screen.y };
}

export async function travelCursor(to: { x: number; y: number }, ms: number, gen: number) {
  const store = useTown.getState();
  if (unwatched()) {
    store.setAgentCursor({ x: to.x, y: to.y, visible: true });
    return;
  }
  const from = store.agentCursor ?? kitPalettePoint() ?? { x: 160, y: window.innerHeight * 0.38, visible: true };
  store.setAgentCursor({ x: from.x, y: from.y, visible: true });
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const step = (now: number) => {
      if (!isMotionCurrent(gen)) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - start) / Math.max(1, ms));
      const e = easeOut(t);
      useTown.getState().setAgentCursor({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        visible: true,
      });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

export async function waitForKitCell(catalogId: string, gen: number): Promise<{ x: number; y: number } | null> {
  for (let i = 0; i < 24; i += 1) {
    if (!isMotionCurrent(gen)) return null;
    const pt = kitCellPoint(catalogId);
    if (pt) return pt;
    await sleep(40, gen);
  }
  return kitCellPoint(catalogId) ?? kitPalettePoint();
}
