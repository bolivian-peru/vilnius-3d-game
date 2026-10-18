"""Height grids derived from the photomesh samples of one tile.

`low` is the lowest surface seen in each cell (ground where the survey saw it,
canopy or roof where it did not); `high` is the highest. Neither is bare earth:
there is no classified LiDAR in the pipeline yet, and consumers record that.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np

from .config import Tile

CELL_M = 1.0


@dataclass
class HeightGrid:
    x0: float
    y0: float
    cell: float
    low: np.ndarray  # [row=y, col=x]
    high: np.ndarray

    def _idx(self, xs, ys):
        c = np.clip(((np.asarray(xs) - self.x0) / self.cell).astype(int), 0, self.low.shape[1] - 1)
        r = np.clip(((np.asarray(ys) - self.y0) / self.cell).astype(int), 0, self.low.shape[0] - 1)
        return r, c

    def sample(self, xs, ys, layer: str = "low") -> np.ndarray:
        r, c = self._idx(xs, ys)
        return getattr(self, layer)[r, c]

    def window(self, x: float, y: float, radius: float, layer: str = "low") -> np.ndarray:
        r, c = self._idx([x], [y])
        k = max(1, int(round(radius / self.cell)))
        g = getattr(self, layer)
        return g[max(0, r[0] - k): r[0] + k + 1, max(0, c[0] - k): c[0] + k + 1]


def _fill(grid: np.ndarray) -> np.ndarray:
    """Fill NaN cells from their neighbours until none remain."""
    g = grid.copy()
    for _ in range(max(g.shape)):
        nan = np.isnan(g)
        if not nan.any():
            break
        padded = np.pad(g, 1, constant_values=np.nan)
        stack = np.stack([padded[1:-1, :-2], padded[1:-1, 2:], padded[:-2, 1:-1], padded[2:, 1:-1]])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(stack, axis=0)
        g[nan] = mean[nan]
    return g


def build(tile: Tile) -> HeightGrid | None:
    path = tile.dir / "photomesh" / "samples.npy"
    if not path.exists():
        return None
    pts = np.load(path)
    x0, y0, x1, y1 = tile.bounds_local
    nx, ny = int((x1 - x0) / CELL_M), int((y1 - y0) / CELL_M)
    c = np.clip(((pts[:, 0] - x0) / CELL_M).astype(int), 0, nx - 1)
    r = np.clip(((pts[:, 1] - y0) / CELL_M).astype(int), 0, ny - 1)
    flat = r * nx + c
    low = np.full(nx * ny, np.inf, dtype=np.float32)
    high = np.full(nx * ny, -np.inf, dtype=np.float32)
    np.minimum.at(low, flat, pts[:, 2])
    np.maximum.at(high, flat, pts[:, 2])
    low[np.isinf(low)] = np.nan
    high[np.isinf(high)] = np.nan
    return HeightGrid(x0, y0, CELL_M, _fill(low.reshape(ny, nx)), _fill(high.reshape(ny, nx)))
