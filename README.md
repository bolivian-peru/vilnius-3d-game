# Vilnius — an open-world city game built from the real city

An open-source, browser-first open-world game set in **real Vilnius, Lithuania**, at 1:1 scale. Streets, junctions, street names and buildings come from OpenStreetMap; the look of the city comes from the municipality's public 3D photogrammetry survey, streamed live. You walk, drive and (soon) take on quests across real Antakalnis, Žirmūnai, the Old Town and beyond.

The long-term goal is a **story- and quest-driven open-world game in the spirit of the classic 2000s crime sandboxes** (think the mission structure and attitude of *Vice City*): contacts who hand out missions, chases, races, deliveries, side jobs, collectibles, radio, police heat — set in a place people actually live in. This repository is the foundation, and **everyone is welcome to build it with us**.

> Not affiliated with or endorsed by Rockstar Games or Take-Two. "GTA" and "Vice City" are their trademarks and are mentioned only to describe the genre.

![status](https://img.shields.io/badge/status-early%20playable%20prototype-orange) ![licence](https://img.shields.io/badge/code-MIT-blue)

---

## What works today

| Area | State |
| --- | --- |
| **Browser game** (`web/`, three.js) | Playable. Start at the Šv. Petro ir Povilo roundabout in Antakalnis; walk or drive anywhere in the city. 60 fps on an Apple M-series laptop. |
| **City streaming** (`web/src/i3s.js`) | Streams the municipal 2022 I3S photomesh by level of detail. A light 4 km horizon layer is always visible; full detail loads only around you and where you look or drive. Worker decoding, request prioritisation and cancellation, GPU memory budget, frame-time quality governor. |
| **Roads** (`web/src/roads.js`) | Every mapped OSM street and footpath is a clean drivable surface with asphalt, lane markings, kerbs and name signs; tree canopies and baked-in parked cars on the road are cut out so every street is reachable. |
| **Trees** (`web/src/trees.js`, `pipeline/vilnius_pipeline/trees.py`) | Trees are detected in the survey (position, height, crown, colour) and replaced by procedural 3D trees (ez-tree) with wind and three LODs incl. impostors. Currently generated around Antakalnis. |
| **Car** (`web/src/vehicle.js`) | Tyre-physics model: suspension, weight transfer, slip, drifts, handbrake turns, automatic gearbox with rpm. |
| **Player** | Animated casual man (Quaternius, CC0) with idle/walk/run matched to speed. |
| **Data pipeline** (`pipeline/`, Python) | OSM extract of the whole city → 3,415 tiles of 500 m (roads, buildings, areas, lane graph with turn restrictions), mesh prewarm cache, tree detection. |
| **Blender** (`blender/`) | Headless tile builder → `.blend`, previews, FBX. |
| **Unreal Engine 5** (`unreal/`) | Character, car, traffic and import code written but **never compiled** — a future high-end target. |
| Quests, NPCs, police, audio, saving | **Not started — this is where you come in.** See the [roadmap](#roadmap). |

---

## Quick start

Requirements: **Node 20+**, **[uv](https://docs.astral.sh/uv/)** (Python 3.12 is fetched automatically), ~3 GB free disk, a recent Chrome/Edge/Safari, internet access (the city mesh is streamed from the municipal server).

```sh
git clone https://github.com/<you>/vilnius-3d-game.git
cd vilnius-3d-game

# 1. Map data (OpenStreetMap, ODbL) — about 1 GB download + a few minutes of processing
mkdir -p data/raw/osm
curl -L -o data/raw/osm/lithuania-latest.osm.pbf https://download.geofabrik.de/europe/lithuania-latest.osm.pbf
cd pipeline
uv run vilnius osm ../data/raw/osm/lithuania-latest.osm.pbf   # city extract + lane graph
uv run vilnius tiles --all                                    # 3,415 street/building tiles

# 2. Optional: cache the start area and detect trees (local use only, see "Data & licences")
uv run vilnius prewarm --lon 25.3050 --lat 54.6945 --fine 700 --wide 4000
uv run vilnius trees --radius 1200

# 3. Play
cd ../web && npm install && npm run dev                          # http://localhost:5180
```

The dev server runs on port **5180**. On `localhost` mesh requests are spread over `s0–s3.localhost` to get around the browser's 6-connections-per-host limit (Chrome and Firefox resolve `*.localhost` automatically).

### Controls

| Key | Action |
| --- | --- |
| Mouse | Look (click to capture the pointer, Esc releases it) |
| W A S D / arrows | Walk or drive |
| Shift | Run |
| Space | Jump on foot, handbrake in the car |
| F | Enter / leave the car |
| R | Back to the start |

URL options: `?gpu=2.4` sets the GPU memory budget in GB.

---

## How it works

```
OpenStreetMap PBF ──► pipeline/ (Python) ──► data/build/tiles/<E###_N###>/tile.json   roads, buildings, lane graph
                                         └─► trees.json + veg.png                       detected trees, canopy mask
Municipal I3S mesh ─► vite caching proxy (/i3s) ─► web/src/i3s.js                       streamed photomesh + horizon
                                                     │
web/src/main.js  ── game loop, player, camera, HUD, minimap
  ├─ roads.js     clean drivable roads and footpaths from OSM, collision
  ├─ ground.js    ground sheet where the survey has no ground
  ├─ trees.js     procedural trees replacing survey canopy blobs
  ├─ vehicle.js   car physics
  ├─ models.js    player and car models
  ├─ post.js      two-pass render (horizon + detail), sharpening, dynamic resolution
  └─ places.js    start points
```

**Coordinates** — everything uses the Lithuanian national grid **LKS-94 (EPSG:3346)** relative to a fixed origin (E 582 250, N 6 062 250, H 100 m). In three.js: `x = east`, `y = up`, `z = −north`, metres. Tiles are 500 × 500 m, named by their index from the origin (`E003_N000`). `web/src/geo.js` and `pipeline/vilnius_pipeline/geo.py` implement the same transform.

**Testing** — `node web/playtest.mjs <outdir>` plays the game in headless Chromium: walks, drives from the start through the roundabout to the end of Vasaros g. using key presses, checks physics, memory, frame times and console errors, and saves screenshots. Point it at a Playwright Chromium (`npx playwright install chromium`). Pipeline tests: `cd pipeline && uv run --with pytest pytest`.

More background: [game foundation and delivery plan](docs/game-foundation.md), [map sources](docs/map-sources.md), [source catalog](data/source-catalog.json).

---

## Roadmap

The aim is a quest-based open-world game. Rough order — pick anything, open an issue to claim it.

### 1. Quest system (highest priority)
- [ ] `web/src/quests/` — data-driven quests: JSON/JS definitions with steps (`goTo`, `enterCar`, `driveTo`, `deliver`, `chase`, `race`, `talkTo`, `timer`, `collect`), conditions, rewards and fail states.
- [ ] Quest markers on the minimap and in the world (light beam + ring), route guidance along the lane graph (`tile.json` → `lanegraph`).
- [ ] Mission start/complete/fail screens, mission text, checkpoints, retry.
- [ ] Contacts: quest givers at real places (cafés, courtyards, markets) — e.g. a first story arc in Antakalnis: deliveries along Antakalnio g., a race across Žaliasis tiltas, a chase through Užupis.
- [ ] Side activities: taxi, courier, street races, time trials, hidden collectibles at landmarks.
- [ ] Save/load (localStorage first) for progress, money, unlocked cars.

### 2. Living city
- [ ] Traffic on the lane graph (signals and turn restrictions are already in the data), parked cars.
- [ ] Pedestrians on footpaths with simple behaviours.
- [ ] Police and wanted level.
- [ ] Day/night and weather; street lights from OSM.

### 3. Player and vehicles
- [ ] Several cars (local favourites: old Golfs, Škodas, a trolleybus), damage, horn, lights, interior camera.
- [ ] Better character, melee/combat (keep it tasteful), entering/leaving animations.
- [ ] Audio: engine, city ambience, a Vilnius radio with royalty-free music.

### 4. City quality
- [ ] Run tree detection city-wide; replace more survey artefacts (lamp posts, signs, benches from OSM).
- [ ] Rebuilt facades and landmarks near the player (Blender), building interiors for missions.
- [ ] Bare-earth terrain from national LiDAR for ground and collision.
- [ ] Mobile/low-end mode.

### 5. Unreal Engine 5 port
- [ ] Compile `unreal/VilniusGame`, import tiles, match the browser feature set.

---

## Contributing

1. Fork, create a branch, keep pull requests focused.
2. Match the existing style: small ES modules, concise code, comments only where they explain *why*.
3. Run `node web/playtest.mjs /tmp/pt` before opening a PR and mention fps and any screenshots that show the change.
4. **Never commit data derived from the municipal mesh** (`data/raw`, `data/build`, caches, screenshots of large mesh areas are fine in PRs but no mesh files). These paths are git-ignored — keep it that way.
5. New 3D assets must be CC0, CC-BY or similarly permissive; add the source and licence to `web/public/models/CREDITS.md`.
6. Write quests and dialogue in Lithuanian and English if you can.

Good first issues: new start points in `web/src/places.js`, minimap improvements, a simple quest marker, car sounds, more tree species.

---

## Data & licences

- **Code**: [MIT](LICENSE).
- **OpenStreetMap** data: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Derived tiles are generated locally by each developer.
- **Vilnius 3D mesh** (`Vilnius_mesh_2022`, © Vilnius city municipality / ID Vilnius, served from [opencity.idvilnius.lt](https://opencity.idvilnius.lt/server/rest/services/3D)): streamed from the public service at runtime. It has **no published reuse licence**, so this repository contains **none** of it and nothing derived from it — the proxy cache, tree data and Blender/Unreal exports stay on your machine (`data/`, git-ignored). Don't redistribute them, and don't bulk-download the city. A request for reuse rights is drafted in [docs/map-sources.md](docs/map-sources.md); if you can help with that, please get in touch.
- **Models**: player "Casual Character" by Quaternius (CC0); Ferrari 458 by vicent091036 (CC BY 4.0, via the three.js examples); procedural trees and their textures from [ez-tree](https://github.com/dgreenheck/ez-tree) by Dan Greenheck (MIT). See [web/public/models/CREDITS.md](web/public/models/CREDITS.md).
- **Draco decoder** (`web/public/draco/`): Google, Apache 2.0.
