"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { archetypeById } from "@/lib/composition/archetypes";
import { shareUrl } from "@/lib/composition/seed";
import { captureWorld } from "@/lib/stageSnapshot";
import { useTown } from "@/lib/store";
import { CloseIcon } from "./icons";

/**
 * The world sticker — what "Share" hands the human: a holographic card with
 * a live snapshot of their world, its seed as the hero, the story it tells,
 * and the numbers behind it. The foil shifts with the pointer (and shimmers
 * on its own when idle), and the card can be copied as a link, shared
 * through the system share sheet, or saved as a PNG sticker.
 *
 * Everything on the card comes from world state the WebMCP lifecycle
 * produced — the plan's intent, the validation score, the seed. Nothing
 * here touches the scene.
 */

type Stats = { pieces: number; zones: number; score: string; date: string };

function titleCase(text: string) {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ShareCard({ onClose }: { onClose: () => void }) {
  const meta = useTown((s) => s.sceneMeta);
  const plan = useTown((s) => s.scenePlan);
  const pieces = useTown((s) => s.pieces);
  const environment = useTown((s) => s.environment);
  const validation = useTown((s) => s.validation);
  // Captured once, at mount — the card is mounted only while open, so this
  // is a fresh frame cropped to the footprint every time Share is pressed.
  const [snapshot] = useState<string | null>(() => captureWorld());
  const [flash, setFlash] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /** Pointer target (0..1 across the card) and whether it is over the card. */
  const pointer = useRef({ x: 0.5, y: 0.42, hover: false });
  const closeRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);

  const url = useMemo(() => (meta && typeof window !== "undefined" ? shareUrl(window.location.origin, meta) : ""), [meta]);
  const archetype = archetypeById(plan?.intent.sceneType ?? meta?.sceneType);
  const title = archetype ? titleCase(archetype.label) : titleCase(meta?.prompt ?? "A World");
  const story = plan?.intent.story ?? meta?.prompt ?? "";
  const stats: Stats = useMemo(
    () => ({
      pieces: Object.keys(pieces).length,
      zones: environment?.zones.filter((z) => z.type !== "plaza").length ?? 0,
      score: validation?.completion != null ? `${validation.completion}%` : "—",
      date: meta?.createdAt ? new Date(meta.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "",
    }),
    [pieces, environment, meta, validation],
  );

  useEffect(() => {
    const id = window.setTimeout(() => closeRef.current?.focus(), 30);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const note = (text: string) => {
    setFlash(text);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(null), 1800);
  };

  // One loop drives the foil, the sheen, and the tilt. Idle: a slow drift.
  // Hover: the pointer. Both write the same variables and ease toward
  // their target, so entering or leaving the card never snaps.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const cur = { x: 0.5, y: 0.42, amp: 0 };
    const sway = { rx: 0, ry: 0 };
    const t0 = performance.now();
    let raf = 0;
    const write = () => {
      el.style.setProperty("--hx", `${(cur.x * 100).toFixed(2)}%`);
      el.style.setProperty("--hy", `${(cur.y * 100).toFixed(2)}%`);
      el.style.setProperty("--mx", `${(cur.x * 100).toFixed(2)}%`);
      el.style.setProperty("--my", `${(cur.y * 100).toFixed(2)}%`);
      // Pointer tilt blends in as the hover amplitude rises; the idle sway
      // fades out at the same rate, so the two never fight.
      el.style.setProperty("--rx", `${((cur.x - 0.5) * 28 * cur.amp + sway.rx * (1 - cur.amp)).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${((0.5 - cur.y) * 22 * cur.amp + sway.ry * (1 - cur.amp)).toFixed(2)}deg`);
      // A little lift and a touch of scale while the pointer is on the card.
      el.style.setProperty("--lift", `${(cur.amp * 14).toFixed(2)}px`);
      el.style.setProperty("--scale", (1 + cur.amp * 0.035).toFixed(4));
      // Depth cues: the rim lights on the side the light comes from, the
      // shadow falls away from it, and the picture drifts a few px against
      // the tilt so it reads as a layer floating over the card.
      const dx = cur.x - 0.5, dy = cur.y - 0.42;
      el.style.setProperty("--edge", `${((Math.atan2(dy, dx) * 180) / Math.PI + 90 - 75).toFixed(1)}deg`);
      el.style.setProperty("--sx", `${(-dx * 44).toFixed(1)}px`);
      el.style.setProperty("--sy", `${(26 - dy * 36).toFixed(1)}px`);
      el.style.setProperty("--px", `${(-dx * 10).toFixed(2)}px`);
      el.style.setProperty("--py", `${(-dy * 8).toFixed(2)}px`);
    };
    // Seed the variables before the first frame so the card never paints
    // with an unset foil, even where animation frames are throttled.
    write();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const p = pointer.current;
      // Idle: the foil sweeps the card about every 7 seconds (the original
      // cadence) and the card sways a few degrees on its own.
      const tx = p.hover ? p.x : 0.5 + 0.4 * Math.sin(t * 0.9);
      const ty = p.hover ? p.y : 0.45 + 0.3 * Math.cos(t * 0.7);
      const tAmp = p.hover ? 1 : 0;
      cur.x += (tx - cur.x) * 0.1;
      cur.y += (ty - cur.y) * 0.1;
      cur.amp += (tAmp - cur.amp) * 0.08;
      sway.rx = 3.2 * Math.sin(t * 1.05);
      sway.ry = 2.2 * Math.cos(t * 0.8);
      write();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pointer.current = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, hover: true };
  }, []);

  const onLeave = useCallback(() => {
    pointer.current = { ...pointer.current, hover: false };
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      note("link copied");
    } catch {
      note("copy failed");
    }
  };

  const stickerBlob = useCallback(async (): Promise<Blob | null> => {
    if (!meta) return null;
    return renderSticker({ snapshot, title, story, seed: meta.seed, stats, url });
  }, [meta, snapshot, title, story, stats, url]);

  const share = async () => {
    if (!meta) return;
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (!nav.share) {
      await copyLink();
      return;
    }
    try {
      const blob = await stickerBlob();
      const file = blob ? new File([blob], `sharableworlds-${meta.seed}.png`, { type: "image/png" }) : null;
      const data: ShareData = { title: `${title} · ${meta.seed}`, text: story, url };
      if (file && nav.canShare?.({ files: [file] })) await nav.share({ ...data, files: [file] });
      else await nav.share(data);
      note("shared");
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") await copyLink();
    }
  };

  const save = async () => {
    if (!meta) return;
    const blob = await stickerBlob();
    if (!blob) {
      note("nothing to save yet");
      return;
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `sharableworlds-${meta.seed}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 2000);
    note("sticker saved");
  };

  if (!meta) return null;

  // Portaled to <body>: the seed chip is its own stacking context, so a card
  // nested inside it would sit under the agent cursor and hover tips no
  // matter what z-index the scrim asked for.
  return createPortal(
    <div className="share-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Share this world">
      <div className="share-stage">
        <div className="share-card-shell">
          <div ref={cardRef} className="share-card" onPointerMove={onMove} onPointerLeave={onLeave}>
            <div className="share-card__foil" aria-hidden />
            <div className="share-card__glare" aria-hidden />
            <div className="share-card__body">
            <div className="share-card__head">
              <span className="share-card__brand">SharableWorlds</span>
              <span className="share-card__tag">World Pass</span>
            </div>
            <div className="share-card__shot" data-empty={snapshot ? undefined : true}>
              {snapshot ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={snapshot} alt={`${title} — ${meta.seed}`} draggable={false} />
              ) : (
                <span>Frame the world and open Share again</span>
              )}
            </div>
            <h2 className="share-card__title">{title}</h2>
            {story && <p className="share-card__story">{story}</p>}
            <div className="share-card__tear" aria-hidden />
            <div className="share-card__stub">
              <div className="share-card__stub-head">
                <span className="share-card__eyebrow">Seed</span>
                <span className="share-card__meta">{stats.date}</span>
              </div>
              <div className="share-card__seed-value">{meta.seed}</div>
              <dl className="share-card__stats">
                <div>
                  <dt>Pieces</dt>
                  <dd>{stats.pieces}</dd>
                </div>
                <div>
                  <dt>Zones</dt>
                  <dd>{stats.zones}</dd>
                </div>
                <div>
                  <dt>Score</dt>
                  <dd>{stats.score}</dd>
                </div>
              </dl>
            </div>
            </div>
          </div>
        </div>

        <div className="share-actions">
          <button type="button" className="gloss-btn share-actions__btn" onClick={copyLink}>
            Copy link
          </button>
          <button type="button" className="gloss-btn share-actions__btn" onClick={share}>
            Share…
          </button>
          <button type="button" className="gloss-btn share-actions__btn" onClick={save}>
            Save sticker
          </button>
          <button ref={closeRef} type="button" className="share-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
          {flash && <span className="share-flash">{flash}</span>}
        </div>
        <p className="share-hint">Same seed, same world — anyone with the link rebuilds it.</p>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// The saved sticker — the on-screen card, redrawn on a 2D canvas at 3× so
// the PNG people post looks like what they saw: same layout and type, the
// photo stage, the foil band and lit rim, the tear line and stub. Metrics
// below are the card's CSS pixels (see .share-card* in globals.css).
// ---------------------------------------------------------------------------

const INK = "#0a0a0a", MUTED = "#8a8a8a", LINE = "#ebebeb", LINE_STRONG = "#d6d6d6";

type Ctx = CanvasRenderingContext2D;

/** A CSS-style `linear-gradient(<angle>)` over a box: same angle convention
 * (0deg up, clockwise) and the same gradient line length as the browser. */
function cssLinear(ctx: Ctx, angleDeg: number, x: number, y: number, w: number, h: number) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2, cy = y + h / 2;
  return ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
}

function roundedPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function setTracking(ctx: Ctx, px: number) {
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${px}px`;
}

async function renderSticker(opts: { snapshot: string | null; title: string; story: string; seed: string; stats: Stats; url: string }): Promise<Blob | null> {
  const S = 3; // output pixels per CSS pixel of the on-screen card
  const M = 28; // transparent margin around the card, room for its shadow
  const W = 344, R = 22, PX = 16, PT = 14, PB = 16, GAP = 8;
  const INNER = W - PX * 2;
  const SHOT_H = Math.round((INNER * 3) / 4);

  try {
    await document.fonts?.ready;
  } catch {
    /* fonts are a nicety */
  }
  const family = getComputedStyle(document.body).fontFamily || "Figtree, system-ui, sans-serif";
  const mono = 'ui-monospace, "SF Mono", Menlo, monospace';
  const font = (size: number, weight: number, fam = family) => `${weight} ${size}px ${fam}`;

  // Measure the story first — the card grows with it, exactly like the DOM.
  const scratch = document.createElement("canvas").getContext("2d");
  if (!scratch) return null;
  scratch.font = font(12, 500);
  const all = opts.story ? wrap(scratch, opts.story, INNER) : [];
  const storyLines = all.slice(0, 2);
  if (all.length > 2) storyLines[1] = fitText(scratch, all.slice(1).join(" "), INNER);
  const STORY_LH = 16.8;

  // Vertical layout, top to bottom, mirroring .share-card__body.
  let y = PT;
  const headY = y;
  y += 15 + GAP;
  const shotY = y;
  y += SHOT_H + GAP;
  const titleY = y + 6;
  y = titleY + 23 + (storyLines.length ? GAP : 0);
  const storyY = y;
  y += storyLines.length * STORY_LH;
  const tearY = y + 10;
  y = tearY + 10;
  const stubHeadY = y;
  y += 13 + 6;
  const seedY = y;
  y += 26 + 6;
  const statsY = y + 6;
  const STATS_H = 1 + 8 + 11 + 3 + 17 + 8 + 1;
  y = statsY + STATS_H;
  const H = Math.round(y + PB);

  const canvas = document.createElement("canvas");
  canvas.width = (W + M * 2) * S;
  canvas.height = (H + M * 2) * S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(S, S);
  ctx.translate(M, M);

  // Shadow beneath the card.
  ctx.save();
  ctx.shadowColor = "rgba(10, 12, 20, 0.28)";
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 14;
  roundedPath(ctx, 0, 0, W, H, R);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

  // Card face.
  ctx.save();
  roundedPath(ctx, 0, 0, W, H, R);
  ctx.clip();
  const face = cssLinear(ctx, 160, 0, 0, W, H);
  face.addColorStop(0, "#ffffff");
  face.addColorStop(0.55, "#f9f9fb");
  face.addColorStop(1, "#f2f3f6");
  ctx.fillStyle = face;
  ctx.fillRect(0, 0, W, H);

  // Head.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = font(12, 640);
  setTracking(ctx, 0.12);
  ctx.fillText("SharableWorlds", PX, headY + 7.5);
  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.font = font(10, 600);
  setTracking(ctx, 1.2);
  ctx.fillText("WORLD PASS", W - PX, headY + 7.5);
  ctx.textAlign = "left";
  setTracking(ctx, 0);

  // Photo stage: soft top light falling off to a cool grey, then the world.
  ctx.save();
  roundedPath(ctx, PX, shotY, INNER, SHOT_H, 14);
  ctx.clip();
  ctx.save();
  ctx.translate(PX + INNER / 2, shotY + SHOT_H * 0.3);
  ctx.scale(INNER * 0.6, SHOT_H * 0.475);
  const stage = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  stage.addColorStop(0, "#ffffff");
  stage.addColorStop(0.55, "#eef0f4");
  stage.addColorStop(1, "#e2e5eb");
  ctx.fillStyle = stage;
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
  // Light on the stage, behind the world (as on screen): a specular streak with a refraction fringe.
  const streak = cssLinear(ctx, 112, PX, shotY, INNER, SHOT_H);
  streak.addColorStop(0.3, "rgba(255,255,255,0)");
  streak.addColorStop(0.42, "rgba(120,180,255,0.24)");
  streak.addColorStop(0.52, "rgba(255,255,255,0.7)");
  streak.addColorStop(0.62, "rgba(255,150,200,0.24)");
  streak.addColorStop(0.68, "rgba(255,170,110,0.16)");
  streak.addColorStop(0.78, "rgba(255,255,255,0)");
  ctx.fillStyle = streak;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(PX, shotY, INNER, SHOT_H);
  ctx.globalAlpha = 1;
  if (opts.snapshot) {
    const img = await loadImage(opts.snapshot);
    if (img) {
      const k = Math.min(INNER / img.width, SHOT_H / img.height);
      const dw = img.width * k, dh = img.height * k;
      ctx.drawImage(img, PX + (INNER - dw) / 2, shotY + (SHOT_H - dh) / 2, dw, dh);
    }
  }
  const shade = ctx.createLinearGradient(0, shotY + SHOT_H - 40, 0, shotY + SHOT_H);
  shade.addColorStop(0, "rgba(20,24,36,0)");
  shade.addColorStop(1, "rgba(20,24,36,0.1)");
  ctx.fillStyle = shade;
  ctx.fillRect(PX, shotY + SHOT_H - 40, INNER, 40);
  ctx.restore();
  roundedPath(ctx, PX + 0.5, shotY + 0.5, INNER - 1, SHOT_H - 1, 13.5);
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Title + story.
  ctx.fillStyle = INK;
  ctx.font = font(20, 720);
  setTracking(ctx, -0.2);
  ctx.fillText(fitText(ctx, opts.title, INNER), PX, titleY + 11.5);
  setTracking(ctx, 0);
  ctx.fillStyle = "#5a5a5a";
  ctx.font = font(12, 500);
  storyLines.forEach((line, i) => ctx.fillText(line, PX, storyY + i * STORY_LH + STORY_LH / 2));

  // Tear line.
  ctx.save();
  ctx.setLineDash([4.5, 4.5]);
  ctx.strokeStyle = LINE_STRONG;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, tearY);
  ctx.lineTo(W, tearY);
  ctx.stroke();
  ctx.restore();

  // Stub: seed, date, numbers.
  ctx.fillStyle = MUTED;
  ctx.font = font(10, 600);
  setTracking(ctx, 1.4);
  ctx.fillText("SEED", PX, stubHeadY + 6.5);
  setTracking(ctx, 0);
  ctx.textAlign = "right";
  ctx.font = font(10.5, 500);
  ctx.fillText(opts.stats.date, W - PX, stubHeadY + 6.5);
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = font(24, 700, mono);
  setTracking(ctx, 1.9);
  ctx.fillText(fitText(ctx, opts.seed, INNER), PX, seedY + 13);
  setTracking(ctx, 0);

  ctx.fillStyle = LINE;
  ctx.fillRect(PX, statsY, INNER, 1);
  ctx.fillRect(PX, statsY + STATS_H - 1, INNER, 1);
  const cells: [string, string][] = [
    ["PIECES", String(opts.stats.pieces)],
    ["ZONES", String(opts.stats.zones)],
    ["SCORE", opts.stats.score],
  ];
  const cellW = INNER / 4;
  cells.forEach(([k, v], i) => {
    const x = PX + i * cellW;
    if (i > 0) ctx.fillRect(x, statsY + 1, 1, STATS_H - 2);
    const tx = x + (i > 0 ? 10 : 0);
    ctx.fillStyle = MUTED;
    ctx.font = font(9, 600);
    setTracking(ctx, 1.1);
    ctx.fillText(k, tx, statsY + 1 + 8 + 5.5);
    setTracking(ctx, 0);
    ctx.fillStyle = INK;
    ctx.font = font(15, 700);
    ctx.fillText(fitText(ctx, v, cellW - 20), tx, statsY + 1 + 8 + 11 + 3 + 8.5);
    ctx.fillStyle = LINE;
  });

  // Foil: the refraction band split into prism lines, multiplied over the
  // card the way the on-screen layer is, frozen mid-sweep.
  const foil = document.createElement("canvas");
  foil.width = W * S;
  foil.height = H * S;
  const fx = foil.getContext("2d");
  if (fx) {
    fx.scale(S, S);
    const band = cssLinear(fx, 112, 0, 0, W, H);
    band.addColorStop(0.34, "rgba(255,255,255,0)");
    band.addColorStop(0.43, "rgba(110,170,255,0.55)");
    band.addColorStop(0.49, "rgba(255,140,205,0.6)");
    band.addColorStop(0.55, "rgba(255,95,110,0.5)");
    band.addColorStop(0.61, "rgba(255,165,95,0.55)");
    band.addColorStop(0.67, "rgba(110,170,255,0.4)");
    band.addColorStop(0.74, "rgba(255,255,255,0)");
    fx.fillStyle = band;
    fx.fillRect(0, 0, W, H);
    // Prism lines: keep every 2px of 3 at full strength, the third at 60%.
    const tile = document.createElement("canvas");
    tile.width = 1;
    tile.height = 3 * S;
    const tx = tile.getContext("2d");
    if (tx) {
      tx.fillStyle = "rgba(0,0,0,1)";
      tx.fillRect(0, 0, 1, 2 * S);
      tx.fillStyle = "rgba(0,0,0,0.6)";
      tx.fillRect(0, 2 * S, 1, S);
      const pattern = fx.createPattern(tile, "repeat");
      if (pattern) {
        fx.save();
        fx.globalCompositeOperation = "destination-in";
        fx.translate(W / 2, H / 2);
        fx.rotate((22 * Math.PI) / 180);
        fx.scale(1 / S, 1 / S);
        fx.fillStyle = pattern;
        const big = (W + H) * S;
        fx.fillRect(-big, -big, big * 2, big * 2);
        fx.restore();
      }
    }
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.42;
    ctx.drawImage(foil, 0, 0, W, H);
    ctx.restore();
  }

  // Glare: a soft highlight where the light sits.
  ctx.save();
  ctx.translate(W * 0.38, H * 0.24);
  ctx.scale(W * 0.34, H * 0.2);
  const glare = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  glare.addColorStop(0, "rgba(255,255,255,0.7)");
  glare.addColorStop(0.4, "rgba(255,255,255,0.25)");
  glare.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glare;
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();

  // Lit rim: the rainbow edge, brightest toward the light.
  ctx.restore(); // card clip
  const conic = (ctx as Ctx & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient }).createConicGradient;
  if (conic) {
    const rim = conic.call(ctx, ((200 - 90) * Math.PI) / 180, W / 2, H / 2);
    rim.addColorStop(0, "rgba(255,255,255,0.9)");
    rim.addColorStop(30 / 360, "#78b4ff");
    rim.addColorStop(60 / 360, "#ff9ad2");
    rim.addColorStop(90 / 360, "#ff6e78");
    rim.addColorStop(120 / 360, "#ffb06e");
    rim.addColorStop(175 / 360, "rgba(255,255,255,0)");
    rim.addColorStop(185 / 360, "rgba(255,255,255,0)");
    rim.addColorStop(1, "rgba(255,255,255,0.9)");
    ctx.save();
    ctx.globalAlpha = 0.85;
    roundedPath(ctx, 0.75, 0.75, W - 1.5, H - 1.5, R - 0.75);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  roundedPath(ctx, 0.5, 0.5, W - 1, H - 1, R - 0.5);
  ctx.strokeStyle = "rgba(0,0,0,0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Ticket notches: punched out of the card at the tear line.
  for (const nx of [0, W]) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(nx, tearY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(nx, tearY, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 3 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Dev hook: lets a session preview the sticker without a download.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __renderSticker?: typeof renderSticker }).__renderSticker = renderSticker;
}
