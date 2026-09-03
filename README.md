# SharableWorlds

**A WebMCP world studio — humans and agents build the same 3D miniature together, on a real grid, with a shareable seed.**

You describe a place (“a harbor full of fishing boats”). The page registers site tools. A WebMCP agent plans, composes, places, inspects, and repairs until the scene actually reads as what you asked for. You can paint pieces yourself; the agent builds around what you locked. Anyone with the link gets the same world.

[Live demo](https://sharableworlds.com/) · [Source](https://github.com/Saivion/TwoMinds) · License: [MIT](./LICENSE)

No login. Open the live URL in **ChatGPT’s in-app browser** or **Chrome with WebMCP enabled**. Footer should read **WebMCP on**.

---

## Why this is a strong fit for WebMCP

WebMCP is for when the *page* is the environment the model should act in — not a remote API with a chat bolted on.

SharableWorlds is that environment. The canvas, the lot grid, the catalog, and the completeness score all live in the browser. An agent should not invent coordinates or dump a glTF. It should speak the page’s language: lots (`C4`), zones (`picnic`), relationships (`east of the grill`), and a scored loop until `complete: true`.

`document.modelContext.registerTool` is the only write path. The human UI, Surprise Me, share-link replay, and an attached agent all call the same tools. If a host cannot see the tools, the agent cannot build. That is the point of WebMCP: the site is the capability surface.

---

## How it is a better experience

Typical “AI 3D” demos are opaque. The model places objects at raw x/y/z, you cannot tell if it succeeded, and the result is not shareable.

Here the loop is visible and collaborative:

1. **Structure, not coordinates.** A picnic table belongs *in the picnic zone*, facing the grill.
2. **Tool success ≠ scene success.** `validate_scene` scores six dimensions. Placing 47 pieces is not done.
3. **The human stays on the board.** Kit-placed lots are locked. The agent must skip them and build around them.
4. **The result travels.** Same seed → same world. Share a World Pass link or PNG sticker.

The top bar shows **Scene Complete**, a completeness badge, and a **Details** panel with pieces, scores, and a live WebMCP trace. You watch the agent work the same tools you could call.

---

## What people and agents can do together

Things that were awkward or impossible when the model only had a chat box and a file:

| Together | Why it needed WebMCP |
| --- | --- |
| You drop a character on a lot; the agent composes a harbor around it | Human locks are first-class occupancy the tools must honor |
| You say “add a fishing dock with boats” to a finished village | `extend_scene` is additive — nothing standing is replaced |
| You paint a few trees, then ask the agent to finish the forest camp | Shared occupancy map: agent reads `human_locks`, writes only empty lots |
| Either of you shares the world | Seed + prompt replay through the same tools; no coordinate dump in the URL |
| You undo, flip, or drag a piece while the agent is between calls | One Zustand world. Next `get_occupancy` sees what you changed |

The agent never imports Three.js. The renderer only reads world state. People act with the kit and rails; agents act with tools; both land on the same lots.

---

## How WebMCP is implemented

On load, the studio registers every site tool on **`document.modelContext`** (fallback: `navigator.modelContext`). Registration lives in [`lib/town.ts`](lib/town.ts). Executes mutate Zustand; React Three Fiber renders.

```js
document.modelContext.registerTool({
  name: "list_catalog",
  description: "Search the Kenney piece catalog",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Substring of id or label" },
      pack: { type: "string" },
      kind: { type: "string" },
    },
  },
  execute: async (input) => {
    /* filter 1,813 pieces; return ids the agent can place */
  },
});
```

The same shape is used for every tool: `name`, `description`, `inputSchema`, `execute`. Writes are instrumented into the Details trace (tool, args, timing, nested children).

**Lifecycle the agent is steered through:**

```
get_occupancy
  → plan_scene
  → compose_scene
  → populate_zones
  → create_environment
  → get_scene / inspect_region
  → validate_scene
  → repair_scene   (repeat until complete: true)
```

Small edits are one targeted call (`place_piece`, `create_vegetation`, `move_piece`). Growing a standing world is `extend_scene`, never a rebuild.

Surprise Me and share-URL boot call these same executes when no host is attached, so the page still works in ordinary Chrome — and the trace still shows WebMCP-shaped work.

---

## Try it (judges)

**Live:** [https://sharableworlds.com/](https://sharableworlds.com/)

Hosted on Cloudflare Workers. No auth.

1. Open the URL in ChatGPT’s in-app browser, or Chrome with WebMCP.
2. Confirm the footer: **WebMCP on**.
3. Ask: *“Build a backyard picnic with burgers and cake.”*
4. Watch Details: plan → compose → populate → validate → repair.
5. Open the kit, place a piece, then **Build On with Agent** — e.g. *“a fishing harbor with boats at anchor.”*
6. **Share** on the seed chip for a World Pass that rebuilds the world.

Without a WebMCP host, **Surprise Me** still runs the full lifecycle through the same tools.

---

## Tools

Agents never see raw x/y. They speak lots, zones, and relationships.

### Read

| Tool | Role |
| --- | --- |
| `get_occupancy` | Start here. Map, goal, human locks, phase, `next_step`. |
| `get_scene_rules` | Laws, archetypes, themes, scoring. |
| `get_scene` | Paged snapshot of pieces, zones, environment. |
| `inspect_region` | One zone or neighborhood. |
| `lookup_object` | One piece’s placement record. |
| `list_catalog` | Search 1,813 Kenney pieces. |
| `get_selection` | What the human has selected. |
| `validate_scene` | Six-dimension score + structured repairs. |
| `get_scene_seed` | Current seed metadata. |

### Lifecycle

| Tool | Role |
| --- | --- |
| `plan_scene` | Prompt → archetype + story. Read-only. |
| `compose_scene` | Footprint, zones, walls, stairs, paths, water. |
| `populate_zones` | Story objects per zone. |
| `create_environment` | Boundary and ground. |
| `build_scene` | Full loop in one call (nested in the trace). |
| `extend_scene` | Additive grow. Does not replace what stands. |
| `repair_scene` | Applies `validate_scene` repairs, then re-scores. |

### Incremental

`create_zone`, `create_path`, `create_focal_point`, `create_prop_cluster`, `create_vegetation`, `create_ground_patch`, `apply_theme`, `place_piece`, `place_batch`, `move_piece`, `orient_piece`, `label_piece`, `remove_piece`, `tell_story`.

### Seeds

`generate_scene_seed`, `set_scene_seed`, `regenerate_scene`.

---

## Scoring

`validate_scene` weights:

| Dimension | Weight |
| --- | --- |
| Intent coverage | 30% |
| Composition | 20% |
| Spatial coherence | 15% |
| Navigation | 15% |
| Environment | 10% |
| Placement validity | 10% |

**Complete** at ≥ 85% with no critical failures. Failures return `{ tool, args, why }` for `repair_scene`.

---

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (WebMCP requires HTTPS or localhost).

```bash
npm test              # seed determinism + lifecycle
npm run test:scenes   # 32 scene lifecycle checks
npm run cf:deploy     # static export → Cloudflare Worker
```

Deploy notes: [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md). Composition internals: [docs/COMPOSITION.md](docs/COMPOSITION.md).

---

## Stack

- **Next.js** 16 (static export) + React 19
- **Three.js** / react-three-fiber — isometric diorama
- **Zustand** — lots, zones, pieces, trace
- **WebMCP** — `document.modelContext.registerTool`
- **Kenney** CC0 — 22 packs, 1,813 GLBs

Composition lives in `lib/composition/`. Tools live in `lib/town.ts`. The renderer in `components/stage3d/` only reads state.

---

## License

[MIT](./LICENSE) for the application source.

Art is [Kenney](https://kenney.nl), CC0 — see `public/assets/kenney/LICENSE-kenney.txt`.
