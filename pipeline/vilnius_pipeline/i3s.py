"""Fetch a tile of the municipal I3S integrated mesh into local-metre OBJ files.

The service publishes View/Query capabilities and no stated reuse terms. This
fetcher exists to evaluate one tile at a time on a developer machine; its output
lives under data/build (git-ignored) and must not be shipped or redistributed
until ID Vilnius grants the rights listed in docs/map-sources.md.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import DracoPy
import numpy as np
import requests

from . import config, geo
from .config import Tile

NODES_PER_PAGE = 64
MESH_CRS = "EPSG:3857"
USER_AGENT = "vilnius-3d-game-pipeline/0.1 (local tile evaluation)"


class I3SLayer:
    def __init__(self, url: str = config.MUNICIPAL_MESH_2022, cache_dir: Path | None = None):
        self.url = url.rstrip("/")
        self.cache = cache_dir or (config.RAW_DIR / "i3s" / "Vilnius_mesh_2022")
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self._pages: dict[int, list[dict]] = {}

    def _get(self, rel: str, cache_name: str) -> bytes:
        path = self.cache / cache_name
        if path.exists():
            return path.read_bytes()
        r = None
        for attempt in range(5):
            try:
                r = self.session.get(f"{self.url}/{rel}", timeout=60)
            except requests.RequestException:
                if attempt == 4:
                    raise
                time.sleep(3.0 * (attempt + 1))
                continue
            if r.status_code == 200:
                break
            time.sleep(1.5 * (attempt + 1))
        else:
            r.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(r.content)
        tmp.replace(path)  # atomic: concurrent readers never see a half-written file
        return r.content

    def node(self, index: int) -> dict:
        page = index // NODES_PER_PAGE
        if page not in self._pages:
            self._pages[page] = json.loads(self._get(f"nodepages/{page}", f"nodepages/{page}.json"))["nodes"]
        return self._pages[page][index % NODES_PER_PAGE]

    @staticmethod
    def _aabb(obb: dict) -> tuple[np.ndarray, np.ndarray]:
        x, y, z, w = obb["quaternion"]
        rot = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ]
        )
        ext = np.abs(rot) @ np.array(obb["halfSize"])
        c = np.array(obb["center"])
        return c - ext, c + ext

    def select(self, bbox_3857: tuple[float, float, float, float], max_depth: int | None = None) -> list[dict]:
        """Finest available nodes whose bounds overlap the bbox."""
        x0, y0, x1, y1 = bbox_3857
        out: list[dict] = []
        stack = [(0, 0)]
        while stack:
            idx, depth = stack.pop()
            n = self.node(idx)
            lo, hi = self._aabb(n["obb"])
            if hi[0] < x0 or lo[0] > x1 or hi[1] < y0 or lo[1] > y1:
                continue
            children = n.get("children") or []
            if children and (max_depth is None or depth < max_depth):
                stack.extend((c, depth + 1) for c in children)
            elif "mesh" in n:
                out.append(n)
        return out

    def fetch_node(self, n: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, bytes]:
        """Returns (positions in local metres, uv, faces, jpeg bytes)."""
        res = n["mesh"]["geometry"]["resource"]
        raw = self._get(f"nodes/{res}/geometries/1", f"nodes/{res}/geometry.drc")
        mesh = DracoPy.decode(raw)
        pts = np.asarray(mesh.points, dtype=np.float64).reshape(-1, 3)
        faces = np.asarray(mesh.faces, dtype=np.int64).reshape(-1, 3)
        uv = np.asarray(mesh.tex_coord, dtype=np.float64).reshape(-1, 2)
        cx, cy, cz = n["obb"]["center"]
        lx, ly = geo.to_local(pts[:, 0] + cx, pts[:, 1] + cy, MESH_CRS)
        local = np.column_stack([lx, ly, pts[:, 2] + cz - config.ORIGIN_H])
        tex_res = n["mesh"]["material"]["resource"]
        jpg = self._get(f"nodes/{tex_res}/textures/0", f"nodes/{tex_res}/texture.jpg")
        return local, uv, faces, jpg


def prewarm(x: float, y: float, fine_m: float = 320.0, wide_m: float = 1500.0, workers: int = 12) -> dict:
    """Fill the local cache around a point so the browser build opens it at disk speed.

    Every level of detail is cached inside `fine_m`; out to `wide_m` only the coarse levels a
    distant view uses. Raw service responses are stored, nothing is decoded.
    """
    layer = I3SLayer()
    scale = 0.578  # ground metres per Mercator unit at Vilnius
    fine = geo.local_bounds_to(MESH_CRS, (x - fine_m, y - fine_m, x + fine_m, y + fine_m))
    wide = geo.local_bounds_to(MESH_CRS, (x - wide_m, y - wide_m, x + wide_m, y + wide_m))

    def hits(n, box):
        lo, hi = layer._aabb(n["obb"])
        return not (hi[0] < box[0] or lo[0] > box[2] or hi[1] < box[1] or lo[1] > box[3])

    todo, stack = [], [0]
    while stack:
        n = layer.node(stack.pop())
        if not hits(n, wide):
            continue
        coarse = max(n["obb"]["halfSize"][:2]) * scale > 70.0
        if not (coarse or hits(n, fine)):
            continue
        if "mesh" in n:
            todo.append(n)
        stack.extend(n.get("children") or [])

    def work(n):
        g, m = n["mesh"]["geometry"]["resource"], n["mesh"]["material"]["resource"]
        return len(layer._get(f"nodes/{g}/geometries/1", f"nodes/{g}/geometry.drc")) + len(
            layer._get(f"nodes/{m}/textures/0", f"nodes/{m}/texture.jpg"))

    with ThreadPoolExecutor(workers) as pool:
        size = sum(pool.map(work, todo))
    return {"nodes": len(todo), "megabytes": round(size / 1e6, 1)}


def fetch_tile(tile: Tile, max_depth: int | None = None, workers: int = 8) -> dict:
    """Write one OBJ/MTL/JPG triple per mesh node overlapping the tile."""
    layer = I3SLayer()
    bbox = geo.local_bounds_to(MESH_CRS, tile.bounds_local)
    nodes = layer.select(bbox, max_depth)
    out_dir = tile.dir / "photomesh"
    out_dir.mkdir(parents=True, exist_ok=True)

    def work(n: dict) -> dict | None:
        name = f"node_{n['index']}"
        pos, uv, faces, jpg = layer.fetch_node(n)
        x0, y0, x1, y1 = tile.bounds_local
        # Deterministic ownership: a triangle belongs to the tile holding its centroid.
        cen = pos[faces].mean(axis=1)
        keep = (cen[:, 0] >= x0) & (cen[:, 0] < x1) & (cen[:, 1] >= y0) & (cen[:, 1] < y1)
        faces = faces[keep]
        if not len(faces):
            return None
        used, inv = np.unique(faces, return_inverse=True)
        pos, uv, faces = pos[used], uv[used], inv.reshape(-1, 3)
        (out_dir / f"{name}.jpg").write_bytes(jpg)
        (out_dir / f"{name}.mtl").write_text(
            f"newmtl {name}\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nillum 1\nmap_Kd {name}.jpg\n"
        )
        with open(out_dir / f"{name}.obj", "w") as f:
            f.write(f"mtllib {name}.mtl\no {name}\n")
            np.savetxt(f, pos, fmt="v %.4f %.4f %.4f")
            # I3S texture origin is top-left; OBJ expects bottom-left.
            np.savetxt(f, np.column_stack([uv[:, 0], 1.0 - uv[:, 1]]), fmt="vt %.6f %.6f")
            f.write(f"usemtl {name}\n")
            idx = faces + 1
            np.savetxt(f, np.column_stack([idx[:, 0], idx[:, 0], idx[:, 1], idx[:, 1], idx[:, 2], idx[:, 2]]),
                       fmt="f %d/%d %d/%d %d/%d")
        # Vertices plus edge midpoints and centroids: a cheap surface sampling for heights.py.
        tri = pos[faces]
        samples = np.concatenate([pos, tri.mean(axis=1), (tri[:, 0] + tri[:, 1]) / 2,
                                  (tri[:, 1] + tri[:, 2]) / 2, (tri[:, 2] + tri[:, 0]) / 2])
        return {
            "samples": samples.astype(np.float32),
            "node": n["index"],
            "file": f"{name}.obj",
            "triangles": int(len(faces)),
            "z_min": float(pos[:, 2].min()),
            "z_max": float(pos[:, 2].max()),
        }

    with ThreadPoolExecutor(workers) as pool:
        parts = [p for p in pool.map(work, nodes) if p]
    np.save(out_dir / "samples.npy", np.concatenate([p.pop("samples") for p in parts]))

    manifest = {
        "tile": tile.name,
        "source": layer.url,
        "source_note": "Bentley ContextCapture reality mesh, service name states 2022; capture date unverified.",
        "license_status": "unverified - local evaluation only, do not redistribute",
        "fetched_on": time.strftime("%Y-%m-%d"),
        "max_depth": max_depth,
        "units": "metres, local frame (x east, y north, z up) relative to project origin",
        "nodes": sorted(parts, key=lambda p: p["node"]),
        "triangles": sum(p["triangles"] for p in parts),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest
