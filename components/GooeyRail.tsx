"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

type Props = {
  side: "left" | "right";
  children: ReactNode;
  className?: string;
};

/** Half the blob height — transform is measured from the blob's top edge. */
const BLOB_HALF = 20;

/**
 * White floating pill. A filtered blob pools under the hovered icon —
 * snapped to that button's center, not free-tracking the pointer.
 */
export function GooeyRail({ side, children, className = "" }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const [blob, setBlob] = useState({ y: 0, active: false });

  const snapToButton = useCallback((btn: HTMLElement) => {
    const rail = railRef.current;
    if (!rail) return;
    const shell = rail.querySelector(".gooey-shell");
    if (!(shell instanceof HTMLElement)) return;

    // Selected tools already have their own ink fill — don't stack a second bg.
    if (btn.dataset.active === "true") {
      setBlob((b) => ({ ...b, active: false }));
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const centerY = btnRect.top + btnRect.height / 2 - shellRect.top;
    setBlob({ y: centerY - BLOB_HALF, active: true });
  }, []);

  const snapFromPoint = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      if (!rail) return;
      const buttons = [...rail.querySelectorAll<HTMLElement>(".rail-btn")];
      if (!buttons.length) return;

      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const btn of buttons) {
        const r = btn.getBoundingClientRect();
        const cy = r.top + r.height / 2;
        const d = Math.abs(cy - clientY);
        if (d < bestDist) {
          bestDist = d;
          best = btn;
        }
      }

      // Past the rail padding / far from any icon → hide rather than float.
      if (!best || bestDist > btnReach(best)) {
        setBlob((b) => ({ ...b, active: false }));
        return;
      }
      snapToButton(best);
    },
    [snapToButton],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const btn = (e.target as Element | null)?.closest?.(".rail-btn");
      if (btn instanceof HTMLElement) {
        snapToButton(btn);
        return;
      }
      snapFromPoint(e.clientY);
    },
    [snapToButton, snapFromPoint],
  );

  return (
    <div
      className={`gooey-rail gooey-rail--${side} ${className}`}
      ref={railRef}
      onPointerEnter={onPointerMove}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setBlob((b) => ({ ...b, active: false }))}
    >
      <svg className="gooey-defs" aria-hidden width="0" height="0">
        <defs>
          {/* Light blur so hover corners stay close to --rail-blob-radius */}
          <filter id={`goo-${side}`} x="-50%" y="-30%" width="200%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
              result="goo"
            />
          </filter>
        </defs>
      </svg>

      <div className="gooey-shell">
        <div
          className="gooey-blob-layer"
          style={{ filter: `url(#goo-${side})` }}
          aria-hidden
        >
          <div
            className="gooey-blob"
            data-active={blob.active}
            style={
              {
                "--blob-y": `${blob.y}px`,
              } as CSSProperties
            }
          />
        </div>
        <div className="gooey-content">{children}</div>
      </div>
    </div>
  );
}

function btnReach(btn: HTMLElement) {
  return btn.getBoundingClientRect().height * 0.75 + 6;
}

export function RailSection({ children }: { children: ReactNode }) {
  return <div className="rail-section">{children}</div>;
}

export function RailDivider() {
  return <div className="rail-divider" aria-hidden />;
}

export function railHotHandlers() {
  return {
    onPointerEnter: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.currentTarget.dataset.hot = "true";
    },
    onPointerLeave: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.currentTarget.dataset.hot = "false";
    },
  };
}
