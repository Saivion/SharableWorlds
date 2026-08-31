"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "right" | "left";
type Tip = { text: string; x: number; y: number; side: Side };

function tipFrom(node: HTMLElement): Tip | null {
  const text = node.getAttribute("data-tip")?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const r = node.getBoundingClientRect();
  if (node.closest(".kit-palette")) {
    const panel = node.closest(".kit-palette")!.getBoundingClientRect();
    return { text, x: panel.right + 10, y: r.top + r.height / 2, side: "right" };
  }
  if (node.closest(".gooey-rail--right")) {
    return { text, x: r.left - 10, y: r.top + r.height / 2, side: "left" };
  }
  if (node.closest(".inspector")) {
    return { text, x: r.left + r.width / 2, y: r.top - 8, side: "top" };
  }
  return { text, x: r.right + 10, y: r.top + r.height / 2, side: "right" };
}

function HoverTipCard({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (box.left < 8) dx += 8 - box.left;
    if (box.right > window.innerWidth - 8) dx += window.innerWidth - 8 - box.right;
    if (box.top < 8) dy += 8 - box.top;
    if (box.bottom > window.innerHeight - 8) dy += window.innerHeight - 8 - box.bottom;
    el.style.setProperty("--tip-shift-x", `${dx}px`);
    el.style.setProperty("--tip-shift-y", `${dy}px`);
  }, [tip]);

  return (
    <div
      ref={ref}
      className={`hover-tip hover-tip--${tip.side}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>
  );
}

/** Floating label for any `[data-tip]` — lives on the body so scroll clips never cut it. */
export function HoverTipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);

  useEffect(() => {
    function nodeFrom(target: EventTarget | null) {
      return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
    }

    function show(event: Event) {
      const node = nodeFrom(event.target);
      if (node) setTip(tipFrom(node));
    }

    function hide(event: PointerEvent) {
      const node = nodeFrom(event.target);
      if (!node) return;
      const next = event.relatedTarget;
      if (next instanceof Node && node.contains(next)) return;
      setTip(null);
    }

    function clear() {
      setTip(null);
    }

    document.addEventListener("pointerover", show);
    document.addEventListener("pointerout", hide);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("pointerover", show);
      document.removeEventListener("pointerout", hide);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, []);

  if (!ready || !tip) return null;
  return createPortal(<HoverTipCard tip={tip} />, document.body);
}
