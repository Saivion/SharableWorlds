"use client";

/**
 * Stage snapshot registry — the seam between the share sticker (2D, DOM)
 * and whichever stage is rendering. The 3D stage registers a function that
 * renders a fresh frame and hands back its canvas; `captureWorld` crops that
 * frame to the pixels the world actually painted (the stage canvas is
 * transparent around it) and centers them, so a sticker shows the world
 * sitting in the middle of its frame — not wherever the camera left it.
 */

export type SnapshotSource = () => HTMLCanvasElement | null;

let source: SnapshotSource | null = null;

export function registerSnapshot(fn: SnapshotSource | null) {
  source = fn;
}

/** Output aspect (matches the card's picture well). */
const ASPECT = 4 / 3;
/** Breathing room around the painted world, as a fraction of its larger side. */
const MARGIN = 0.08;
/** Pixels below this alpha count as background when finding the world. */
const ALPHA_FLOOR = 12;
/** Width of the low-res pass that finds the painted bounds. */
const SCAN_W = 480;

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Bounds of the painted pixels in `canvas`, in canvas pixels. Scans a
 * downscaled copy (cheap on a retina stage), then maps back with a cell of
 * slack so nothing is trimmed at the edge.
 */
function paintedBounds(canvas: HTMLCanvasElement): Box | null {
  const k = Math.min(1, SCAN_W / canvas.width);
  const sw = Math.max(1, Math.round(canvas.width * k));
  const sh = Math.max(1, Math.round(canvas.height * k));
  const scan = document.createElement("canvas");
  scan.width = sw;
  scan.height = sh;
  const ctx = scan.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, sw, sh);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    return null;
  }
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < sw; x++) {
      if (data[row + x * 4 + 3] > ALPHA_FLOOR) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const cell = 1 / k;
  return {
    x0: Math.max(0, (x0 - 1) * cell),
    y0: Math.max(0, (y0 - 1) * cell),
    x1: Math.min(canvas.width, (x1 + 2) * cell),
    y1: Math.min(canvas.height, (y1 + 2) * cell),
  };
}

/**
 * A PNG data URL of the world as currently framed, cropped to what it
 * painted and centered in a 4:3 frame. Null when no stage is registered or
 * nothing has been drawn.
 */
export function captureWorld(): string | null {
  const canvas = source?.();
  if (!canvas || !canvas.width || !canvas.height) return null;

  const box = paintedBounds(canvas) ?? { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
  const cw = box.x1 - box.x0, ch = box.y1 - box.y0;
  const cx = box.x0 + cw / 2, cy = box.y0 + ch / 2;

  // Symmetric margin, then grow the short side so the frame is 4:3 with the
  // world dead center. The frame may reach past the canvas; that part stays
  // transparent rather than dragging the world off-center.
  const pad = Math.max(cw, ch) * MARGIN;
  let fw = cw + pad * 2, fh = ch + pad * 2;
  if (fw / fh > ASPECT) fh = fw / ASPECT;
  else fw = fh * ASPECT;

  // Keep stickers crisp but bounded.
  const max = 1600;
  const k = Math.min(1, max / Math.max(fw, fh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(fw * k));
  out.height = Math.max(1, Math.round(fh * k));
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, cx - fw / 2, cy - fh / 2, fw, fh, 0, 0, out.width, out.height);
  try {
    return out.toDataURL("image/png");
  } catch {
    return null;
  }
}
