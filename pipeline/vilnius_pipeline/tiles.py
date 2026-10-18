"""Cut the city-wide extract into 500 m tiles and resolve heights where known.

Ownership is deterministic so neighbouring tiles never duplicate or drop
content: a building belongs to the tile holding its representative point, and
linear features are clipped to the half-open tile rectangle.
"""

from __future__ import annotations

import json
import math
import time
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.strtree import STRtree

from . import config, heights
from .config import Tile

LEVEL_HEIGHT_M = 3.0
DEFAULT_BUILDING_HEIGHT_M = 9.0
PROFILE_STEP_M = 2.0
TERRAIN_CELL_M = 2.0


def _num(text):
    try:
        return float(str(text).replace(",", ".").split()[0])
    except (ValueError, IndexError, AttributeError):
        return None


def _poly(rings) -> Polygon:
    p = Polygon(rings[0], rings[1:])
    return p if p.is_valid else p.buffer(0)


def _lines(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if g.geom_type == "LineString" and g.length > 0.05]


def _polys(geom) -> list[Polygon]:
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if g.geom_type == "Polygon" and g.area > 0.5]


def _coords(poly: Polygon) -> list:
    return [[[round(x, 3), round(y, 3)] for x, y in ring.coords] for ring in [poly.exterior, *poly.interiors]]


def _smooth(z: np.ndarray, k: int) -> np.ndarray:
    if len(z) < 3:
        return z
    k = min(k, len(z) // 2 * 2 - 1) if len(z) > 3 else 1
    if k < 3:
        return z
    pad = k // 2
    padded = np.pad(z, pad, mode="edge")
    med = np.median(np.lib.stride_tricks.sliding_window_view(padded, k), axis=1)
    padded = np.pad(med, pad, mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")


def _profile(line: LineString, grid: heights.HeightGrid | None) -> tuple[list, str]:
    """Densified centerline with a smoothed wheel-contact height where a grid exists."""
    n = max(1, int(math.ceil(line.length / PROFILE_STEP_M)))
    pts = [line.interpolate(i / n, normalized=True) for i in range(n + 1)]
    if grid is None:
        return [[round(p.x, 3), round(p.y, 3), None] for p in pts], "unknown"
    z = np.array([np.median(grid.window(p.x, p.y, 2.0)) for p in pts])
    z = _smooth(z, 7)
    return [[round(p.x, 3), round(p.y, 3), round(float(h), 3)] for p, h in zip(pts, z)], "photomesh_low_median"


class City:
    """City-wide extract plus lane graph, indexed for tile queries."""

    def __init__(self):
        city_dir = config.BUILD_DIR / "city"
        self.doc = json.loads((city_dir / "osm_vilnius.json").read_text())
        self.graph = json.loads((city_dir / "lanegraph.json").read_text())
        self.segments = self.graph["segments"]
        self.seg_lines = [LineString(s["points"]) for s in self.segments]
        self.seg_tree = STRtree(self.seg_lines)
        nodes = self.doc["nodes"]
        self.paths = self.doc["paths"] + self.doc["rails"]
        self.path_lines = [LineString([nodes[str(r)] for r in p["nodes"]]) for p in self.paths]
        self.path_tree = STRtree(self.path_lines)
        self.building_reps = shapely.points([b["polygons"][0][0][0] for b in self.doc["buildings"]])
        self.building_tree = STRtree(self.building_reps)
        self.area_polys = [
            shapely.union_all([_poly(r) for r in a["polygons"]]) for a in self.doc["areas"]
        ]
        self.area_tree = STRtree(self.area_polys)
        self.point_geoms = shapely.points([p["xy"] for p in self.doc["points"]])
        self.point_tree = STRtree(self.point_geoms)
        self.conn_by_seg = defaultdict(list)
        for c in self.graph["connections"]:
            self.conn_by_seg[c[0]].append(c)

    def tile_names(self) -> list[Tile]:
        """Every tile that owns at least one road or building."""
        seen = set()
        for s in self.segments:
            for x, y in s["points"]:
                seen.add((math.floor(x / config.TILE_SIZE_M), math.floor(y / config.TILE_SIZE_M)))
        for g in self.building_reps:
            seen.add((math.floor(g.x / config.TILE_SIZE_M), math.floor(g.y / config.TILE_SIZE_M)))
        return [Tile(ix, iy) for ix, iy in sorted(seen)]


def build_tile(city: City, tile: Tile) -> dict:
    x0, y0, x1, y1 = tile.bounds_local
    rect = box(x0, y0, x1, y1)
    grid = heights.build(tile)

    # --- roads ---------------------------------------------------------
    roads, graph_ids = [], []
    for i in city.seg_tree.query(box(x0 - config.TILE_BUFFER_M, y0 - config.TILE_BUFFER_M,
                                     x1 + config.TILE_BUFFER_M, y1 + config.TILE_BUFFER_M)):
        graph_ids.append(int(i))
    for i in sorted(graph_ids):
        seg = city.segments[i]
        for k, part in enumerate(_lines(city.seg_lines[i].intersection(rect))):
            centerline, z_source = _profile(part, grid)
            roads.append({
                "id": f"{seg['stable_id']}#{k}", "segment": seg["id"], "class": seg["class"], "name": seg["name"],
                "width_m": seg["width_m"], "lanes_fwd": seg["lanes_fwd"], "lanes_bwd": seg["lanes_bwd"],
                "lane_width_m": seg["lane_width_m"], "oneway": seg["oneway"], "bridge": seg["bridge"],
                "tunnel": seg["tunnel"], "layer": seg["layer"], "car_access": seg["car_access"],
                "inferred": seg["inferred"], "z_source": z_source, "centerline": centerline,
            })

    paths = []
    for i in sorted(int(i) for i in city.path_tree.query(rect)):
        p = city.paths[i]
        for k, part in enumerate(_lines(city.path_lines[i].intersection(rect))):
            centerline, z_source = _profile(part, grid)
            paths.append({"id": f"{p['osm_id']}#{k}", "tags": p["tags"], "z_source": z_source,
                          "centerline": centerline})

    # --- buildings -----------------------------------------------------
    buildings, footprints = [], []
    for i in sorted(int(i) for i in city.building_tree.query(rect)):
        rep = city.building_reps[i]
        if not (x0 <= rep.x < x1 and y0 <= rep.y < y1):
            continue
        b = city.doc["buildings"][i]
        tags = b["tags"]
        tag_h = _num(tags.get("height"))
        levels = _num(tags.get("building:levels"))
        for k, rings in enumerate(b["polygons"]):
            poly = _poly(rings)
            if poly.is_empty or poly.area < 1.0:
                continue
            base, height, source = None, None, None
            if grid is not None:
                bx0, by0, bx1, by1 = poly.bounds
                xs = np.arange(max(bx0, x0) + 0.5, min(bx1, x1), 1.0)
                ys = np.arange(max(by0, y0) + 0.5, min(by1, y1), 1.0)
                if len(xs) and len(ys):
                    gx, gy = np.meshgrid(xs, ys)
                    inside = shapely.contains_xy(poly, gx, gy)
                    bxs = np.arange(max(bx0 - 5, x0) + 0.5, min(bx1 + 5, x1), 1.0)
                    bys = np.arange(max(by0 - 5, y0) + 0.5, min(by1 + 5, y1), 1.0)
                    rgx, rgy = np.meshgrid(bxs, bys)
                    ring = shapely.contains_xy(poly.buffer(4.0), rgx, rgy) & ~shapely.contains_xy(poly.buffer(1.0), rgx, rgy)
                    if inside.sum() >= 4 and ring.sum() >= 4:
                        base = float(np.percentile(grid.sample(rgx[ring], rgy[ring], "low"), 10))
                        roof = float(np.percentile(grid.sample(gx[inside], gy[inside], "high"), 85))
                        if roof - base >= 2.0:
                            height, source = roof - base, "photomesh"
            if height is None:
                if tag_h:
                    height, source = tag_h, "osm_height"
                elif levels:
                    height, source = levels * LEVEL_HEIGHT_M + 1.0, "osm_levels_inferred"
                else:
                    height, source = DEFAULT_BUILDING_HEIGHT_M, "default"
            if not b["part"]:
                footprints.append(poly)
            buildings.append({
                "id": f"{b['osm_id']}#{k}", "part": b["part"], "tags": tags,
                "base_z": None if base is None else round(base, 2), "height_m": round(height, 2),
                "height_source": source, "osm_height_m": tag_h, "osm_levels": levels,
                "footprint": _coords(poly),
            })

    # --- areas and points ----------------------------------------------
    areas = []
    for i in sorted(int(i) for i in city.area_tree.query(rect)):
        a = city.doc["areas"][i]
        for k, poly in enumerate(_polys(city.area_polys[i].intersection(rect))):
            areas.append({"id": f"{a['osm_id']}#{k}", "kind": a["kind"], "tags": a["tags"],
                          "polygon": _coords(poly)})

    points = []
    for i in sorted(int(i) for i in city.point_tree.query(rect)):
        p = city.doc["points"][i]
        x, y = p["xy"]
        if x0 <= x < x1 and y0 <= y < y1:
            z = None if grid is None else round(float(np.median(grid.window(x, y, 1.5))), 2)
            points.append({"id": p["osm_id"], "kind": p["kind"], "xyz": [x, y, z], "tags": p["tags"]})

    # --- lane graph subset ---------------------------------------------
    ids = set(graph_ids)
    graph = {
        "segments": [city.segments[i] for i in sorted(ids)],
        "connections": [c for i in sorted(ids) for c in city.conn_by_seg[i] if c[2] in ids],
        "signals": [n for n in city.graph["signals"]
                    if any(n in (city.segments[i]["from_node"], city.segments[i]["to_node"]) for i in ids)],
    }

    # --- terrain -------------------------------------------------------
    terrain = None
    if grid is not None:
        low = grid.low.copy()
        if footprints:
            xs = np.arange(x0 + 0.5, x1, 1.0)
            gx, gy = np.meshgrid(xs, np.arange(y0 + 0.5, y1, 1.0))
            mask = shapely.contains_xy(shapely.union_all(footprints).buffer(1.5), gx, gy)
            low[mask] = np.nan
            low = heights._fill(low)
        step = int(TERRAIN_CELL_M / heights.CELL_M)
        ny, nx = low.shape
        coarse = low.reshape(ny // step, step, nx // step, step).min(axis=(1, 3))
        pad = np.pad(coarse, 1, mode="edge")
        coarse = np.median(np.lib.stride_tricks.sliding_window_view(pad, (3, 3)), axis=(2, 3))
        tile.dir.mkdir(parents=True, exist_ok=True)
        np.save(tile.dir / "terrain.npy", coarse.astype(np.float32))
        terrain = {"file": "terrain.npy", "cell_m": TERRAIN_CELL_M, "rows": coarse.shape[0],
                   "cols": coarse.shape[1], "layout": "row 0 is the south edge; value is the cell-centre height",
                   "source": "photomesh lowest surface, building footprints masked and filled; not bare earth"}

    doc = {
        "schema_version": 1,
        "tile": tile.name,
        "built_on": time.strftime("%Y-%m-%d"),
        "crs": config.WORK_CRS,
        "origin": {"e": config.ORIGIN_E, "n": config.ORIGIN_N, "h": config.ORIGIN_H},
        "bounds_local": [x0, y0, x1, y1],
        "bounds_lks94": list(tile.bounds_lks),
        "units": "metres; x east, y north, z up, relative to origin",
        "sources": {
            "vector": city.doc["source"],
            "heights": "Vilnius_mesh_2022 (municipal, licence unverified)" if grid is not None else None,
        },
        "terrain": terrain,
        "roads": roads, "paths": paths, "buildings": buildings, "areas": areas, "points": points,
        "lanegraph": graph,
    }
    tile.dir.mkdir(parents=True, exist_ok=True)
    (tile.dir / "tile.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    return {"tile": tile.name, "roads": len(roads), "paths": len(paths), "buildings": len(buildings),
            "areas": len(areas), "points": len(points), "graph_segments": len(graph["segments"]),
            "heights": grid is not None}
