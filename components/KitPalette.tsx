"use client";

import { CATALOG, FEATURED, type CatalogItem } from "@/lib/catalog";
import { useTown } from "@/lib/store";

const BY_PACK = new Map<string, CatalogItem[]>();
for (const item of CATALOG) {
  const list = BY_PACK.get(item.pack) ?? [];
  list.push(item);
  BY_PACK.set(item.pack, list);
}

/** Every catalog piece, pack order unchanged. Featured ids stay first in each group. */
const KIT_GROUPS = FEATURED.map((group) => {
  const featured = new Set(group.ids);
  const items = BY_PACK.get(group.pack) ?? [];
  const head = group.ids
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is CatalogItem => Boolean(item));
  const rest = items.filter((item) => !featured.has(item.id));
  return { pack: group.pack, title: group.title, items: [...head, ...rest] };
});

/**
 * The human's kit palette: every imported Kenney piece, grouped by pack.
 * Click a piece, then click a lot.
 */
export function KitPalette({ open }: { open: boolean }) {
  const activeId = useTown((s) => s.activeId);
  const agentGrabId = useTown((s) => s.agentGrabId);
  const setActiveId = useTown((s) => s.setActiveId);
  const setTool = useTown((s) => s.setTool);

  if (!open) return null;

  return (
    <div className="kit-palette" data-testid="kit-palette">
      {KIT_GROUPS.map((group) => (
        <section key={group.pack} className="kit-group">
          <h3 className="kit-group__title">{group.title}</h3>
          <div className="kit-group__grid">
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="kit-cell tip"
                data-tip={item.label}
                data-catalog-id={item.id}
                data-active={activeId === item.id}
                data-agent-grab={agentGrabId === item.id ? "true" : undefined}
                aria-label={item.label}
                onClick={() => {
                  setActiveId(item.id);
                  setTool("place");
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.src} alt="" draggable={false} loading="lazy" />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
