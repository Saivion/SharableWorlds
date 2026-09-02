# SharableWorlds

**Build a 3D miniature world with an AI agent — in your browser, on a real grid, with a shareable seed.**

SharableWorlds is an isometric diorama studio where humans and WebMCP agents compose scenes together. You describe a place (“a harbor full of fishing boats”), the agent plans and builds it piece by piece on a lot grid, and you get a **World Pass** — a link that rebuilds the exact same world for anyone who opens it.

---

## The problem

Most “AI builds a scene” demos are opaque: the model dumps objects into 3D space with raw coordinates, you cannot tell if it succeeded, and the result is not reproducible or shareable.

We wanted something different:

1. **Agents need structure, not coordinates.** A picnic table belongs *in the picnic zone*, facing the grill — not at `(12.4, 0, -3.1)`.
2. **Tool success ≠ scene success.** Placing 47 pieces does not mean the scene *reads* as what you asked for.
3. **Humans and agents must coexist.** If you place a character yourself, the agent should build around it — not overwrite it.
4. **The result should travel.** Same seed → same world, shareable as a link or sticker.

---

## What we built

A **composed 3D diorama** (Three.js, orthographic isometric camera) on top of a discrete lot grid:

- **Environment first** — platforms, walls, stairs, paths, water, and named zones establish the place.
- **Pieces second** — 1,800+ Kenney GLB models placed *on* that architecture, one per lot.
- **WebMCP as the only write path** — every mutation goes through registered browser tools; the UI and the agent share the same API.
- **A scored lifecycle** — plan → compose → populate → frame → inspect → validate → repair until the scene actually matches the request.
- **Deterministic seeds** — `BUSY-JWCV8B` rebuilds the same market, harbor, or dungeon every time.

Humans can also build by hand (palette, paint, undo) with no agent at all. Human-placed lots are **locked**; agents must skip them.

---

## WebMCP tools

The page registers **site tools** on `document.modelContext` (WebMCP). An agent never sees raw x/y — it speaks in **lots** (`C4`), **zones** (`picnic`), and **relationships** (`east of barrel-1`).

### Read (look before you write)

| Tool | What it does |
|------|----------------|
| `get_occupancy` | **Start here.** Map state, standing goal, human locks, current phase, and `next_step` hint. |
| `get_scene_rules` | World-building laws, archetypes, themes, and how scoring works. |
| `get_scene` | Paged scene snapshot — pieces, zones, environment summary. |
| `inspect_region` | Zoom into a zone or lot neighborhood. |
| `lookup_object` | Full placement record for one piece. |
| `list_catalog` | Search 1,813 Kenney pieces by pack, kind, or query. |
| `get_selection` | What the human currently has selected. |
| `validate_scene` | **The arbiter of done.** Six-dimension completeness score + structured repair list. |
| `get_scene_seed` | Current seed metadata. |

### Lifecycle (build a world)

| Tool | What it does |
|------|----------------|
| `plan_scene` | Understand the prompt → scene archetype + story. **Read-only** — no mutation. |
| `compose_scene` | Architecture: footprint, zones, walls, stairs, paths, terrain, water. |
| `populate_zones` | Story objects per zone (stalls, trees, characters) via composition grammar. |
| `create_environment` | Boundary framing and ground texture. |
| `build_scene` | Runs the full lifecycle in one call when the agent cannot steer step by step. |
| `repair_scene` | Applies `validate_scene` repairs through the other tools, then re-validates. |

### Incremental (grow or fix)

| Tool | What it does |
|------|----------------|
| `create_zone` | Add a named functional zone. |
| `create_path` | Carve a walkway between zones. |
| `create_focal_point` | Anchor a landmark in a zone. |
| `create_prop_cluster` | Place a themed cluster (archetype-driven). |
| `create_vegetation` | Trees and plants, seed-pure. |
| `create_ground_patch` | Paint terrain material on lots. |
| `apply_theme` | Set the visual theme (grass, sand, stone, …). |
| `place_piece` | Place one catalog item on a lot. |
| `place_batch` | Place many items in one decision (nested in trace). |
| `move_piece` | Relocate with strategies (`into_zone`, `away_from`, off path). |
| `orient_piece` | Rotate a piece to face an anchor. |
| `label_piece` / `remove_piece` | Rename or delete. |
| `tell_story` | Narrate what the agent noticed (status chip). |

### Seeds (reproducibility)

| Tool | What it does |
|------|----------------|
| `generate_scene_seed` | Mint a new seed string. |
| `set_scene_seed` | Apply a seed (rebuilds from it). |
| `regenerate_scene` | New seed, same prompt — a different take. |

### Typical agent loop

```
get_occupancy
  → plan_scene
  → compose_scene
  → populate_zones
  → create_environment
  → get_scene / inspect_region
  → validate_scene
  → repair_scene (repeat until complete: true)
```

Small edits (“add a tree by the house”) use **one** targeted call — not a full rebuild.

The **Details** panel in the top pill shows the live trace, completeness score, and pieces placed.

---

## Try it

```bash
npm install
npm run dev
```

Open **http://localhost:3000** (WebMCP requires HTTPS or localhost).

| Action | How |
|--------|-----|
| Build with an agent | In a WebMCP-enabled browser: *"Build a backyard picnic with burgers and cake."* |
| Surprise Me | Top-right button — same pipeline, no chat required. |
| Build by hand | Open the kit palette, click a piece, click a lot. |
| Share | **Share** on the seed chip → World Pass link or PNG sticker. |
| Debug lots | Append `?debug` to the URL. |

**Headless tests:**

```bash
npm test              # seed determinism + lifecycle scenarios
npm run test:scenes   # 32 scene lifecycle checks
```

---

## How scoring works

`validate_scene` scores six dimensions:

| Dimension | Weight | Checks |
|-----------|--------|--------|
| Intent coverage | 30% | Does the scene contain what was asked for? |
| Composition | 20% | Landmark, focal clearance, zone grammar. |
| Spatial coherence | 15% | Zones furnished, seats face the action. |
| Navigation | 15% | Paths connect zones; stairs work. |
| Environment | 10% | Grounded, framed, themed. |
| Placement validity | 10% | No overlaps; pieces match the plan. |

**Complete** at ≥ 85% with no critical failures. Failures return structured repairs: `{ tool, args, why }` for `repair_scene` to apply.

---

## Stack

- **Next.js** + React 19
- **Three.js** / react-three-fiber — isometric diorama renderer
- **Zustand** — world state (lots, zones, pieces, trace)
- **WebMCP** — `document.modelContext.registerTool` site tools
- **Kenney** CC0 assets — 22 packs, 1,813 catalogued GLBs

Composition logic lives in `lib/composition/` (intent, archetypes, compose, validate). The renderer in `components/stage3d/` only reads state — tools never import Three.js.

---

## Credits

All art is [Kenney](https://kenney.nl), CC0 — Mini Arcade, Arena, Characters, Dungeon, Forest, Market, Skate, Watercraft, Pirate Kit, Car Kit, and more. See `public/assets/kenney/LICENSE-kenney.txt`.
