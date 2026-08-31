"use client";

import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Crosshair,
  FlipHorizontal2,
  Hand,
  LayoutGrid,
  MousePointer2,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

type Props = {
  size?: number;
  className?: string;
  active?: boolean;
  strokeWidth?: number;
};

function RailLucide({
  icon: Icon,
  size = 22,
  className,
  active = false,
  strokeWidth = 1.75,
}: Props & { icon: LucideIcon }) {
  return (
    <span
      className={`rail-icon ${active ? "rail-icon--active" : ""} ${className ?? ""}`}
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        lineHeight: 0,
      }}
    >
      <Icon size={size} strokeWidth={strokeWidth} absoluteStrokeWidth aria-hidden className="block" />
    </span>
  );
}

export function SelectIcon(props: Props) {
  return <RailLucide icon={MousePointer2} {...props} />;
}

export function HandIcon(props: Props) {
  return <RailLucide icon={Hand} {...props} />;
}

export function AboutIcon(props: Props) {
  return <RailLucide icon={BookOpen} {...props} />;
}

export function RetryIcon(props: Props) {
  return <RailLucide icon={RefreshCw} {...props} />;
}

export function UndoIcon(props: Props) {
  return <RailLucide icon={Undo2} {...props} />;
}

export function TrashIcon(props: Props) {
  return <RailLucide icon={Trash2} size={16} {...props} />;
}

export function FlipIcon(props: Props) {
  return <RailLucide icon={FlipHorizontal2} size={16} {...props} />;
}

export function CloseIcon(props: Props) {
  return <RailLucide icon={X} size={16} {...props} />;
}

export function KitIcon(props: Props) {
  return <RailLucide icon={LayoutGrid} {...props} />;
}

export function NudgeIcon(props: Props) {
  return <RailLucide icon={Crosshair} {...props} />;
}
