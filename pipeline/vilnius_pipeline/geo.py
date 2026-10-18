"""Coordinate transforms between source CRSs and the project-local frame."""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from pyproj import Transformer

from . import config


@lru_cache(maxsize=None)
def _transformer(src: str, dst: str) -> Transformer:
    return Transformer.from_crs(src, dst, always_xy=True)


def to_local(xs, ys, src_crs: str) -> tuple[np.ndarray, np.ndarray]:
    """Source horizontal coordinates -> local metres (x east, y north)."""
    e, n = _transformer(src_crs, config.WORK_CRS).transform(np.asarray(xs), np.asarray(ys))
    return np.asarray(e) - config.ORIGIN_E, np.asarray(n) - config.ORIGIN_N


def from_local(xs, ys, dst_crs: str) -> tuple[np.ndarray, np.ndarray]:
    e = np.asarray(xs) + config.ORIGIN_E
    n = np.asarray(ys) + config.ORIGIN_N
    x, y = _transformer(config.WORK_CRS, dst_crs).transform(e, n)
    return np.asarray(x), np.asarray(y)


def local_bounds_to(dst_crs: str, bounds: tuple[float, float, float, float], pad: float = 0.0):
    """Axis-aligned bounds in dst_crs that enclose a local-metre rectangle."""
    x0, y0, x1, y1 = bounds
    xs = [x0 - pad, x1 + pad, x1 + pad, x0 - pad]
    ys = [y0 - pad, y0 - pad, y1 + pad, y1 + pad]
    px, py = from_local(xs, ys, dst_crs)
    return (float(px.min()), float(py.min()), float(px.max()), float(py.max()))
