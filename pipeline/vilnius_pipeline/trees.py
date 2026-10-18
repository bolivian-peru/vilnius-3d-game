"""Detect individual trees in the photomesh and write per-tile tree lists plus a vegetation mask.

The municipal reality mesh renders trees as melted blobs. This module turns the mesh of one
tile (finest I3S nodes, plus a buffer so crowns on tile edges are seen whole) into:

* a 0.5 m surface model (DSM, highest mesh surface) with the texture colour of that surface,
* a 1 m ground model (DTM) from a progressive morphological filter over the lowest surface,
  with building footprints and canopy removed and the holes interpolated from the ground
  around them,
* a canopy height model (CHM = DSM - DTM) and a vegetation mask (tall + foliage coloured or
  rough, never inside OSM building footprints),
* individual trees: variable-window local maxima of the smoothed CHM, marker-controlled
  watershed crowns, per-crown height / radius / base / type / colour, merged with OSM
  natural=tree nodes.

Outputs (local metres, same frame as tile.json; licence of the source unverified, so they
live under data/build only):
  tiles/<TILE>/trees.json  {"tile", "method", "trees": [[x, y, ground_z, h, r, base, type, "#rrggbb"]]}
  tiles/<TILE>/veg.png     RGBA 500x500, 1 m/px, row 0 = north; R = canopy mask,
                           G*256+B = ground height in cm above the height datum
                           (z_local = cm / 100 - ORIGIN_H), A = 255
  tiles/trees_index.json
"""

from __future__ import annotations

import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import shapely
from PIL import Image
from scipy import ndimage as ndi
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator
from shapely.geometry import box

from . import config, geo, i3s
from .config import Tile

CELL = 0.5            # surface / canopy grid, metres
GCELL = 1.0           # ground grid, metres
BUFFER_M = 30.0       # processed margin around a tile so edge crowns are whole
SUB_M = 0.22          # triangle sampling step
MIN_CANOPY_M = 2.0    # vegetation threshold above ground
MIN_TREE_M = 2.5      # lowest local maximum accepted as a tree top
METHOD = ("photomesh leaf nodes -> 0.5 m DSM + top-surface texture colour; DTM by progressive "
          "morphological filter on the lowest surface (buildings/canopy removed, holes linearly "
          "interpolated); vegetation = CHM >= 2 m & (foliage colour | rough surface), outside OSM "
          "buildings; trees = variable-window CHM maxima + watershed crowns; OSM natural=tree merged")


# ---------------------------------------------------------------------------------------------
# Mesh -> rasters


class Raster:
    """Top/bottom surface grids over a rectangle in local metres. Row 0 is the SOUTH edge."""

    def __init__(self, bounds, cell=CELL):
        self.x0, self.y0, x1, y1 = bounds
        self.cell = cell
        self.nx = int(round((x1 - self.x0) / cell))
        self.ny = int(round((y1 - self.y0) / cell))
        n = self.nx * self.ny
        self.top = np.full(n, -np.inf, np.float32)
        self.low = np.full(n, np.inf, np.float32)
        self.rgb = np.zeros((n, 3), np.float32)

    def add(self, pts: np.ndarray, rgb: np.ndarray):
        c = np.floor((pts[:, 0] - self.x0) / self.cell).astype(np.int64)
        r = np.floor((pts[:, 1] - self.y0) / self.cell).astype(np.int64)
        ok = (c >= 0) & (c < self.nx) & (r >= 0) & (r < self.ny)
        if not ok.any():
            return
        flat, z, rgb = r[ok] * self.nx + c[ok], pts[ok, 2].astype(np.float32), rgb[ok]
        np.minimum.at(self.low, flat, z)
        # highest sample per cell within this batch, then merge
        order = np.lexsort((z, flat))
        flat, z, rgb = flat[order], z[order], rgb[order]
        last = np.r_[flat[1:] != flat[:-1], True]
        flat, z, rgb = flat[last], z[last], rgb[last]
        better = z > self.top[flat]
        self.top[flat[better]] = z[better]
        self.rgb[flat[better]] = rgb[better]

    def grids(self):
        shape = (self.ny, self.nx)
        top = self.top.reshape(shape).copy()
        low = self.low.reshape(shape).copy()
        top[~np.isfinite(top)] = np.nan
        low[~np.isfinite(low)] = np.nan
        return top, low, self.rgb.reshape(shape + (3,))


def _barycentric(k: int) -> np.ndarray:
    ij = [(i, j) for i in range(k + 1) for j in range(k + 1 - i)]
    a = np.array(ij, np.float32) / k
    return np.column_stack([1 - a[:, 0] - a[:, 1], a[:, 0], a[:, 1]])


_BARY = {k: _barycentric(k) for k in range(1, 25)}


def sample_node(pos: np.ndarray, uv: np.ndarray, faces: np.ndarray, jpg: bytes, clip=None):
    """Dense surface samples of one mesh node with texture colour: (N,3) xyz, (N,3) rgb."""
    img = Image.open(io.BytesIO(jpg)).convert("RGB")
    w, h = img.size
    img = img.reduce(2)  # 2x2 box average: less JPEG noise, still ~6 cm/px on leaf nodes
    tex = np.asarray(img, np.float32)
    th, tw = tex.shape[:2]
    if clip is not None:
        x0, y0, x1, y1 = clip
        cen = pos[faces].mean(axis=1)
        keep = (cen[:, 0] > x0 - 3) & (cen[:, 0] < x1 + 3) & (cen[:, 1] > y0 - 3) & (cen[:, 1] < y1 + 3)
        faces = faces[keep]
    if not len(faces):
        return np.zeros((0, 3)), np.zeros((0, 3))
    tri = pos[faces]
    edge = np.max(np.linalg.norm(tri[:, [1, 2, 0], :2] - tri[:, :, :2], axis=2), axis=1)
    ks = np.clip(np.ceil(edge / SUB_M), 1, 24).astype(int)
    out_p, out_c = [], []
    for k in np.unique(ks):
        sel = ks == k
        bary = _BARY[int(k)]
        f = faces[sel]
        p = np.einsum("sv,tvd->tsd", bary, pos[f]).reshape(-1, 3)
        t = np.einsum("sv,tvd->tsd", bary, uv[f]).reshape(-1, 2)
        u = np.clip((t[:, 0] % 1.0) * tw, 0, tw - 1).astype(np.int32)
        v = np.clip((t[:, 1] % 1.0) * th, 0, th - 1).astype(np.int32)
        out_p.append(p)
        out_c.append(tex[v, u])
    return np.concatenate(out_p), np.concatenate(out_c)


def rasterize(layer: i3s.I3SLayer, bounds, workers: int = 8) -> tuple[Raster, int]:
    bbox = geo.local_bounds_to(i3s.MESH_CRS, bounds)
    nodes = layer.select(bbox)
    ras = Raster(bounds)

    def work(n):
        return sample_node(*layer.fetch_node(n), clip=bounds)

    with ThreadPoolExecutor(workers) as pool:  # <= 8 concurrent requests for uncached nodes
        for p, c in pool.map(work, nodes):
            ras.add(p, c)
    return ras, len(nodes)


# ---------------------------------------------------------------------------------------------
# Raster helpers


def _fill_nearest(g: np.ndarray) -> np.ndarray:
    nan = np.isnan(g)
    if not nan.any():
        return g
    if nan.all():
        return np.zeros_like(g)
    idx = ndi.distance_transform_edt(nan, return_distances=False, return_indices=True)
    return g[tuple(idx)]


def _disk(r_cells: float) -> np.ndarray:
    k = int(math.ceil(r_cells))
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    return (xx * xx + yy * yy) <= r_cells * r_cells + 1e-6


def _block(g: np.ndarray, f: int, how) -> np.ndarray:
    ny, nx = g.shape
    return how(g.reshape(ny // f, f, nx // f, f), axis=(1, 3))


def _cell_centres(x0, y0, nx, ny, cell):
    xs = x0 + (np.arange(nx) + 0.5) * cell
    ys = y0 + (np.arange(ny) + 0.5) * cell
    return np.meshgrid(xs, ys)


def _mask_polys(polys, x0, y0, nx, ny, cell) -> np.ndarray:
    if not polys:
        return np.zeros((ny, nx), bool)
    gx, gy = _cell_centres(x0, y0, nx, ny, cell)
    return shapely.contains_xy(shapely.union_all(polys), gx, gy)


# ---------------------------------------------------------------------------------------------
# Ground


def ground_model(low: np.ndarray, blocked: np.ndarray, max_window_m: float = 30.0,
                 slope: float = 0.25, base_m: float = 0.4) -> tuple[np.ndarray, np.ndarray]:
    """Progressive-morphological DTM on a 1 m grid. Returns (dtm, ground_cells)."""
    z = _fill_nearest(low)
    nonground = blocked.copy()
    # progressive morphological filter (Zhang et al. 2003): compare the surface with openings of
    # growing radius; the allowed rise grows with the window so slopes survive, canopy does not
    for r in (1, 2, 3, 4, 6, 8, 11, 15, 20, 25, 30):
        if r > max_window_m:
            break
        opened = ndi.grey_opening(z, footprint=_disk(r / GCELL))
        nonground |= (z - opened) > (slope * r + base_m)
    ground = ~nonground & ~np.isnan(low)
    # small ground patches inside canopy are usually V-shaped dips of the mesh between crowns, not
    # the forest floor: keep them only if they drop deep below the canopy around them
    lab, n = ndi.label(ground)
    if n:
        size = ndi.sum(ground, lab, np.arange(1, n + 1))
        small = np.isin(lab, np.nonzero(size < 12)[0] + 1)
        depth = ndi.maximum_filter(z, footprint=_disk(6)) - z
        ground &= ~(small & (depth < 9.0))
    dtm = _interpolate(z, ground)
    # second pass: anything clearly above the provisional surface is not ground
    ground &= (z - dtm) < 0.6
    dtm = _interpolate(z, ground)
    return ndi.gaussian_filter(dtm, 1.0), ground


def _interpolate(z: np.ndarray, known: np.ndarray) -> np.ndarray:
    if known.sum() < 3:
        return np.full_like(z, np.nanmedian(z))
    # hole rims carry the information; thin the interior to keep the triangulation small
    rim = known & ndi.binary_dilation(~known, iterations=3)
    rr, cc = np.nonzero(known)
    keep = rim[rr, cc] | ((rr % 4 == 0) & (cc % 4 == 0))
    rr, cc = rr[keep], cc[keep]
    pts = np.column_stack([rr, cc]).astype(np.float64)
    vals = z[rr, cc]
    out = z.copy()
    hr, hc = np.nonzero(~known)
    if len(hr):
        lin = LinearNDInterpolator(pts, vals)(hr, hc)
        bad = np.isnan(lin)
        if bad.any():
            lin[bad] = NearestNDInterpolator(pts, vals)(hr[bad], hc[bad])
        out[hr, hc] = lin
    return out


# ---------------------------------------------------------------------------------------------
# Vegetation and trees


def foliage_colour(rgb: np.ndarray) -> np.ndarray:
    """0..1 likelihood that a surface colour is foliage (sunlit green or shaded dark green)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    exg = 2 * g - r - b
    v = np.maximum(np.maximum(r, g), b)
    sun = np.clip((exg - 4.0) / 20.0, 0, 1)
    # shaded foliage: dark, green not below red, not blue-grey (shadowed asphalt is neutral/blue)
    shade = (v < 80) & (g >= r - 2) & (g >= b - 4)
    return np.maximum(sun, np.where(shade, 0.6, 0.0))


def roughness(dsm: np.ndarray) -> np.ndarray:
    """Local deviation of the surface from a smooth fit, metres (high in crowns, low on roofs)."""
    d = dsm - ndi.gaussian_filter(dsm, 2.0)
    return np.sqrt(np.maximum(ndi.uniform_filter(d * d, 5), 0.0))


def window_radius(h):
    """Variable-window radius (m) for a tree-top search at canopy height h."""
    return np.clip(1.0 + 0.12 * np.asarray(h), 1.5, 4.5)


def detect(chm: np.ndarray, veg: np.ndarray):
    """Tree tops (row, col) and watershed crown labels on the 0.5 m CHM."""
    from skimage.segmentation import watershed

    smooth = ndi.gaussian_filter(np.where(veg, chm, 0.0), 2.0)
    cand = (smooth == ndi.maximum_filter(smooth, size=3)) & veg & (smooth >= MIN_TREE_M)
    radii = np.arange(1.5, 4.51, 0.25)
    rad = window_radius(smooth)
    tops = np.zeros_like(cand)
    for r in radii:
        sel = cand & (np.abs(rad - r) < 0.125 + 1e-6)
        if sel.any():
            mx = ndi.maximum_filter(smooth, footprint=_disk(r / CELL))
            tops |= sel & (smooth >= mx - 1e-4)
    # plateaus give several equal maxima: keep one per connected group
    lab, n = ndi.label(tops, structure=np.ones((3, 3)))
    if n == 0:
        return np.zeros((0, 2), int), np.zeros_like(chm, np.int32), smooth
    cms = np.array(ndi.center_of_mass(tops, lab, np.arange(1, n + 1))).round().astype(int)
    markers = np.zeros(chm.shape, np.int32)
    markers[cms[:, 0], cms[:, 1]] = np.arange(1, n + 1)
    labels = watershed(-smooth, markers, mask=veg)
    # fringe noise makes tiny crowns on the flanks of big ones: drop markers whose crown is small
    # and touches another crown, then flood again so the neighbour takes the cells
    for _ in range(3):
        area = ndi.sum(np.ones_like(labels), labels, np.arange(1, n + 1)) * CELL * CELL
        touch = np.zeros(n + 1, bool)
        for sh in ((0, 1), (1, 0)):
            a = labels[: labels.shape[0] - sh[0], : labels.shape[1] - sh[1]]
            b = labels[sh[0]:, sh[1]:]
            diff = (a != b) & (a > 0) & (b > 0)
            touch[a[diff]] = True
            touch[b[diff]] = True
        h = smooth[cms[:, 0], cms[:, 1]]
        small = (area < np.pi * (0.5 + 0.15 * h) ** 2) & touch[1:]
        if not small.any():
            break
        cms = cms[~small]
        n = len(cms)
        markers = np.zeros(chm.shape, np.int32)
        markers[cms[:, 0], cms[:, 1]] = np.arange(1, n + 1)
        labels = watershed(-smooth, markers, mask=veg)
    return cms, labels, smooth


def _hex(rgb) -> str:
    r, g, b = (int(np.clip(round(float(c)), 0, 255)) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def tree_attributes(cms, labels, chm, smooth, rgb, x0, y0):
    """Per-crown height, radius, base, type and colour."""
    n = len(cms)
    if n == 0:
        return []
    idx = np.arange(1, n + 1)
    flat_lab = labels.ravel()
    order = np.argsort(flat_lab, kind="stable")
    sorted_lab = flat_lab[order]
    starts = np.searchsorted(sorted_lab, idx)
    ends = np.searchsorted(sorted_lab, idx, side="right")
    chm_f, rgb_f = chm.ravel(), rgb.reshape(-1, 3)
    out = []
    for i in range(n):
        cells = order[starts[i]:ends[i]]
        if len(cells) < 4:
            continue
        hc = chm_f[cells]
        h = float(np.percentile(hc, 98))
        area = len(cells) * CELL * CELL
        radius = float(np.clip(math.sqrt(area / math.pi), 1.0, 9.0))
        if h < MIN_TREE_M:
            continue
        # sunlit upper crown sets the leaf colour; shaded flanks would make everything black
        upper = cells[hc >= 0.7 * h]
        col = np.median(rgb_f[upper if len(upper) >= 3 else cells], axis=0)
        mean_h = float(hc.mean())
        r0, c0 = cms[i]
        out.append({"x": x0 + (c0 + 0.5) * CELL, "y": y0 + (r0 + 0.5) * CELL, "h": h, "r": radius,
                    "col": col, "sharp": (h - mean_h) / max(radius, 1.0)})
    if not out:
        return out
    # conifers (pine/spruce) read darker and bluer than the broadleaf street and park trees around
    # them and peak sharply; the test is relative to the tile so lighting differences cancel out
    cols = np.array([q["col"] for q in out])
    v = cols.max(axis=1)
    blu = (cols[:, 2] - cols[:, 0]) / np.maximum(v, 1.0)
    v_med, blu_med = np.median(v), np.median(blu)
    for q, vi, bi in zip(out, v, blu):
        kind = int(bi > blu_med + 0.07 and vi < v_med - 12 and q["sharp"] > 0.6)
        q["type"] = kind
        # crown base is never seen from above: typical urban/park ratios, clamped to the tree
        q["base"] = float(np.clip(q["h"] * (0.18 if kind else 0.33), 0.6 if kind else 1.6, q["h"] - 1.0))
    return out


# ---------------------------------------------------------------------------------------------
# Tile driver


def _tile_doc(t: Tile):
    p = t.dir / "tile.json"
    return json.loads(p.read_text()) if p.exists() else None


def _neighbourhood(t: Tile):
    """Building footprints and OSM trees from the tile and its 8 neighbours."""
    from .tiles import _poly

    polys, osm_trees = [], []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            d = _tile_doc(Tile(t.ix + dx, t.iy + dy))
            if not d:
                continue
            for b in d["buildings"]:
                if b["part"]:
                    continue
                p = _poly(b["footprint"])
                if not p.is_empty:
                    polys.append(p)
            for p in d["points"]:
                if p["kind"] == "natural=tree":
                    osm_trees.append((p["xyz"][0], p["xyz"][1], p["tags"]))
    return polys, osm_trees


def tiles_within(x: float, y: float, radius: float) -> list[Tile]:
    s = config.TILE_SIZE_M
    out = []
    for ix in range(math.floor((x - radius) / s), math.floor((x + radius) / s) + 1):
        for iy in range(math.floor((y - radius) / s), math.floor((y + radius) / s) + 1):
            t = Tile(ix, iy)
            x0, y0, x1, y1 = t.bounds_local
            if math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1)) <= radius:
                out.append(t)
    return out


def encode_veg_png(mask255: np.ndarray, ground_local: np.ndarray) -> Image.Image:
    """mask255 / ground_local are 500x500 with row 0 = SOUTH; the PNG has row 0 = NORTH."""
    cm = np.clip(np.round((ground_local + config.ORIGIN_H) * 100.0), 0, 65535).astype(np.uint16)
    rgba = np.zeros(mask255.shape + (4,), np.uint8)
    rgba[..., 0] = mask255
    rgba[..., 1] = cm >> 8
    rgba[..., 2] = cm & 255
    rgba[..., 3] = 255
    return Image.fromarray(rgba[::-1].copy(), "RGBA")


def decode_veg_png(img: Image.Image):
    a = np.asarray(img.convert("RGBA"))[::-1]
    cm = a[..., 1].astype(np.int32) * 256 + a[..., 2]
    return a[..., 0], cm / 100.0 - config.ORIGIN_H


LAST: dict = {}  # arrays of the most recent tile, for debugging


def analyse(top, low, rgb, bounds, polys, osm_trees) -> dict:
    """Rasters of one buffered tile -> ground, canopy, vegetation mask and trees (all in the buffer)."""
    bx0, by0 = bounds[0], bounds[1]
    ny, nx = top.shape
    covered = ~np.isnan(top)
    dsm = _fill_nearest(top)
    rgb = rgb.copy()
    for ch in range(3):
        rgb[..., ch] = _fill_nearest(np.where(covered, rgb[..., ch], np.nan))
    bld_fine = _mask_polys(polys, bx0, by0, nx, ny, CELL)

    # ground on the 1 m grid: lowest surface, buildings (with eaves) removed
    f = int(GCELL / CELL)
    low_g = _block(np.where(np.isnan(low), np.inf, low), f, np.min)
    low_g[~np.isfinite(low_g)] = np.nan
    bld_g = _mask_polys([p.buffer(1.5) for p in polys], bx0, by0, nx // f, ny // f, GCELL)
    # canopy cells (foliage colour, rough, above the local minimum) never count as ground
    fol_g = _block(foliage_colour(rgb), f, np.mean)
    rough_g = _block(roughness(dsm), f, np.max)
    rel = low_g - ndi.grey_erosion(_fill_nearest(low_g), footprint=_disk(25))
    canopy_g = (fol_g > 0.5) & (((rel > 1.0) & (rough_g > 0.15)) | (rough_g > 0.35))
    canopy_g = ndi.binary_dilation(canopy_g, iterations=1)
    dtm_g, ground_g = ground_model(low_g, bld_g | canopy_g)
    dtm = ndi.gaussian_filter(np.kron(dtm_g, np.ones((f, f))), 1.0)

    chm = np.clip(dsm - dtm, 0, None)
    chm[~covered] = 0
    fol = foliage_colour(rgb)
    rough = roughness(dsm)
    veg_score = np.maximum(fol, np.clip((rough - 0.25) / 0.4, 0, 1) * (fol > 0.15))
    veg = (chm >= MIN_CANOPY_M) & (veg_score >= 0.5) & ~bld_fine
    veg = ndi.binary_opening(veg, structure=_disk(1))
    veg = ndi.binary_closing(veg, structure=_disk(2)) & (chm >= MIN_CANOPY_M * 0.75) & ~bld_fine
    lab, n = ndi.label(veg)
    if n:
        sizes = ndi.sum(veg, lab, np.arange(1, n + 1))
        veg &= np.isin(lab, np.nonzero(sizes * CELL * CELL >= 3.0)[0] + 1)
    # small enclosed gaps (sunlit or grey-looking crown parts) belong to the crown
    holes = ndi.binary_fill_holes(veg) & ~veg & ~bld_fine
    hl, hn = ndi.label(holes)
    if hn:
        hs = ndi.sum(holes, hl, np.arange(1, hn + 1))
        veg |= np.isin(hl, np.nonzero(hs * CELL * CELL < 20.0)[0] + 1)

    cms, labels, smooth = detect(chm, veg)
    found = tree_attributes(cms, labels, chm, smooth, rgb, bx0, by0)
    osm_used = merge_osm(found, osm_trees, chm, veg, rgb, bounds)
    LAST.clear()
    LAST.update(dsm=dsm, low_g=low_g, dtm_g=dtm_g, ground_g=ground_g, canopy_g=canopy_g, chm=chm, fol=fol,
                rough=rough, veg=veg, rgb=rgb, bounds=bounds)
    return {"found": found, "veg": veg, "dtm_g": dtm_g, "ground_g": ground_g, "chm": chm, "labels": labels,
            "rgb": rgb, "bld_fine": bld_fine, "osm_used": osm_used}


def merge_osm(found: list, osm_trees, chm, veg, rgb, bounds) -> int:
    """Snap OSM natural=tree nodes to detected crowns, or add them where the CHM shows canopy."""
    bx0, by0 = bounds[0], bounds[1]
    used = 0
    fx = np.array([[q["x"], q["y"]] for q in found]) if found else np.zeros((0, 2))
    for x, y, tags in osm_trees:
        if not (bounds[0] + 2 <= x < bounds[2] - 2 and bounds[1] + 2 <= y < bounds[3] - 2):
            continue
        needle = tags.get("leaf_type") == "needleleaved"
        broad = tags.get("leaf_type") == "broadleaved"
        if len(fx):
            d = np.hypot(fx[:, 0] - x, fx[:, 1] - y)
            j = int(d.argmin())
            if d[j] < max(3.0, 0.6 * found[j]["r"]):
                q = found[j]
                q["type"] = 1 if needle else 0 if broad else q["type"]
                q["osm"] = True
                used += 1
                continue
        c, r = int((x - bx0) / CELL), int((y - by0) / CELL)
        win = chm[max(0, r - 4):r + 5, max(0, c - 4):c + 5]
        vwin = veg[max(0, r - 4):r + 5, max(0, c - 4):c + 5]
        if win.size and vwin.any() and win.max() >= MIN_TREE_M:
            h = float(win.max())
            col = np.median(rgb[max(0, r - 2):r + 3, max(0, c - 2):c + 3].reshape(-1, 3), axis=0)
            kind = 1 if needle else 0
            found.append({"x": x, "y": y, "h": h, "r": float(np.clip(0.3 * h, 1.5, 5.0)),
                          "base": float(np.clip(h * (0.18 if kind else 0.33), 0.6 if kind else 1.6, h - 1.0)),
                          "type": kind, "col": col, "sharp": 0.0, "osm": True})
            fx = np.vstack([fx, [x, y]])
            used += 1
    return used


def tile_outputs(t: Tile, res: dict, polys, bounds):
    """Crop an analysis to the tile: (tree rows, 500x500 mask 0..255, 500x500 ground z), row 0 south."""
    tx0, ty0, tx1, ty1 = t.bounds_local
    bx0, by0 = bounds[0], bounds[1]
    dtm_g = res["dtm_g"]

    trees = []
    for q in res["found"]:
        if not (tx0 <= q["x"] < tx1 and ty0 <= q["y"] < ty1):
            continue
        gz = float(ndi.map_coordinates(dtm_g, [[(q["y"] - by0) / GCELL - 0.5], [(q["x"] - bx0) / GCELL - 0.5]],
                                       order=1, mode="nearest")[0])
        trees.append([round(q["x"], 2), round(q["y"], 2), round(gz, 2), round(q["h"], 2), round(q["r"], 2),
                      round(q["base"], 2), int(q["type"]), _hex(q["col"])])
    trees.sort(key=lambda a: (a[1], a[0]))

    # mask dilated ~1 m so blob fringes are covered, soft edge, never on a building footprint
    f = int(GCELL / CELL)
    m = ndi.binary_dilation(res["veg"], structure=_disk(2)) & ~res["bld_fine"]
    soft = np.maximum(ndi.gaussian_filter(m.astype(np.float32), 1.0), ndi.binary_erosion(m) * 1.0)
    o = int(round((tx0 - bx0) / CELL)), int(round((ty0 - by0) / CELL))
    k = int(config.TILE_SIZE_M / CELL)
    soft_t = _block(soft[o[1]:o[1] + k, o[0]:o[0] + k], f, np.mean)
    bld_t = _mask_polys(polys, tx0, ty0, soft_t.shape[1], soft_t.shape[0], 1.0)
    mask255 = np.where(bld_t, 0, np.clip(np.round(soft_t * 1.15 * 255), 0, 255)).astype(np.uint8)
    g = int(round((tx0 - bx0) / GCELL)), int(round((ty0 - by0) / GCELL))
    kg = int(config.TILE_SIZE_M / GCELL)
    ground_t = dtm_g[g[1]:g[1] + kg, g[0]:g[0] + kg]
    return trees, mask255, ground_t


def process_tile(t: Tile, layer: i3s.I3SLayer | None = None, debug_dir=None) -> dict:
    layer = layer or i3s.I3SLayer()
    tx0, ty0, tx1, ty1 = t.bounds_local
    bounds = (tx0 - BUFFER_M, ty0 - BUFFER_M, tx1 + BUFFER_M, ty1 + BUFFER_M)
    t0 = time.time()
    ras, n_nodes = rasterize(layer, bounds)
    top, low, rgb = ras.grids()
    polys, osm_trees = _neighbourhood(t)
    res = analyse(top, low, rgb, bounds, polys, osm_trees)
    trees, mask255, ground_t = tile_outputs(t, res, polys, bounds)

    t.dir.mkdir(parents=True, exist_ok=True)
    encode_veg_png(mask255, ground_t).save(t.dir / "veg.png", optimize=True)
    (t.dir / "trees.json").write_text(json.dumps({"tile": t.name, "method": METHOD, "trees": trees},
                                                 separators=(",", ":")))

    hs = np.array([a[3] for a in trees]) if trees else np.zeros(1)
    rs = np.array([a[4] for a in trees]) if trees else np.zeros(1)
    summary = {"tile": t.name, "trees": len(trees), "conifers": sum(a[6] for a in trees),
               "osm_merged": res["osm_used"], "nodes": n_nodes,
               "canopy_fraction": round(float((mask255 > 127).mean()), 3),
               "height_median": round(float(np.median(hs)), 2), "height_p95": round(float(np.percentile(hs, 95)), 2),
               "radius_median": round(float(np.median(rs)), 2), "seconds": round(time.time() - t0, 1)}
    if debug_dir is not None:
        _debug_images(debug_dir, t, res["chm"], res["veg"], res["labels"], res["found"], res["rgb"],
                      res["dtm_g"], res["ground_g"], bounds, polys)
    return summary


def _debug_images(out, t, chm, veg, labels, found, rgb, dtm_g, ground_g, bounds, polys):
    from PIL import ImageDraw

    out.mkdir(parents=True, exist_ok=True)
    bx0, by0 = bounds[0], bounds[1]
    ny = chm.shape[0]
    # 1) canopy height (grey ramp, 0..25 m) with veg tint and crowns
    v = np.clip(chm / 25.0, 0, 1)
    img = np.stack([v * 255] * 3, -1)
    img[veg] = img[veg] * np.array([0.35, 1.0, 0.35]) + np.array([0, 40, 0])
    edge = (labels != ndi.grey_erosion(labels, size=3)) & veg
    img[edge] = [255, 200, 0]
    im = Image.fromarray(np.clip(img[::-1], 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)

    def px(x, y):
        return (x - bx0) / CELL, ny - (y - by0) / CELL

    doc = _tile_doc(t)
    if doc:
        for b in doc["buildings"]:
            for ring in b["footprint"][:1]:
                d.line([px(x, y) for x, y in ring], fill=(80, 140, 255), width=2)
        for rd in doc["roads"] + doc["paths"]:
            d.line([px(p[0], p[1]) for p in rd["centerline"]], fill=(255, 60, 255) if rd in doc["roads"] else (200, 120, 255), width=2 if rd in doc["roads"] else 1)
    for q in found:
        cx, cy = px(q["x"], q["y"])
        rr = q["r"] / CELL
        col = (255, 40, 40) if q["type"] == 0 else (0, 220, 255)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=col, width=1)
        d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=(255, 255, 255) if q.get("osm") else col)
    x0, y0, x1, y1 = t.bounds_local
    d.rectangle([px(x0, y1), px(x1, y0)], outline=(255, 255, 255))
    im.save(out / f"{t.name}_chm.png")
    # 2) texture top view
    Image.fromarray(np.clip(rgb[::-1], 0, 255).astype(np.uint8)).save(out / f"{t.name}_rgb.png")
    # 3) mask overlay on texture, cropped to the tile, from the written veg.png
    mask, ground = decode_veg_png(Image.open(t.dir / "veg.png"))
    c0 = int(BUFFER_M / CELL)
    k = int(config.TILE_SIZE_M / CELL)
    tex = rgb[c0:c0 + k, c0:c0 + k]
    tex1 = tex.reshape(k // 2, 2, k // 2, 2, 3).mean(axis=(1, 3))
    a = (mask / 255.0)[..., None]
    ov = tex1 * (1 - 0.6 * a) + np.array([255, 0, 0]) * 0.6 * a
    Image.fromarray(np.clip(ov[::-1], 0, 255).astype(np.uint8)).resize((1000, 1000), Image.NEAREST).save(
        out / f"{t.name}_mask.png")
    # 4) ground model hillshade with ground cells
    gy, gx = np.gradient(dtm_g)
    shade = np.clip(0.5 + (gx - gy) * 1.5, 0, 1)
    g = np.stack([shade * 255] * 3, -1)
    g[~ground_g] = g[~ground_g] * 0.6 + np.array([90, 0, 0])
    Image.fromarray(g[::-1].astype(np.uint8)).save(out / f"{t.name}_dtm.png")


def run(x: float, y: float, radius: float, debug_dir=None, debug_tiles=(), only=None) -> list[dict]:
    layer = i3s.I3SLayer()
    todo = tiles_within(x, y, radius)
    if only:
        todo = [t for t in todo if t.name in only]
    index_path = config.TILES_DIR / "trees_index.json"
    old = {}
    if index_path.exists() and only:
        old = {e["tile"]: e for e in json.loads(index_path.read_text()).get("tiles", [])}
    out = []
    for t in todo:
        s = process_tile(t, layer, debug_dir if (debug_dir and (not debug_tiles or t.name in debug_tiles)) else None)
        print(json.dumps(s), flush=True)
        out.append(s)
        old[t.name] = s
    doc = {"built_on": time.strftime("%Y-%m-%d"), "centre_local": [x, y], "radius_m": radius, "method": METHOD,
           "tree_row": ["x_east", "y_north", "ground_z", "height_m", "crown_radius_m", "crown_base_m",
                        "type(0 broadleaf,1 conifer)", "leaf_colour"],
           "veg_png": "RGBA 500x500 1 m/px, row 0 north, col 0 west; R canopy mask; ground_cm=G*256+B, "
                      "z_local=ground_cm/100-100",
           "licence": "derived from municipal photomesh, licence unverified: local evaluation only",
           "tiles": sorted(old.values(), key=lambda e: e["tile"])}
    index_path.write_text(json.dumps(doc, indent=1))
    return out
