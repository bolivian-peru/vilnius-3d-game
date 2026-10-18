"""Project-wide geographic contract.

Everything downstream (Blender, Unreal) depends on these values. Changing the
origin after assets exist invalidates every exported mesh, so treat it as frozen.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
BUILD_DIR = DATA_DIR / "build"
TILES_DIR = BUILD_DIR / "tiles"

# Working CRS: LKS-94 / Lithuania TM, metres, axis order (easting, northing).
WORK_CRS = "EPSG:3346"
GEOGRAPHIC_CRS = "EPSG:4326"

# Project origin in LKS-94 metres: south-west corner of the pilot tile, on the
# Neris bank by Žaliasis tiltas. H0 keeps local heights small; heights are the
# source's own values and no vertical datum conversion is applied.
ORIGIN_E = 582_250.0
ORIGIN_N = 6_062_250.0
ORIGIN_H = 100.0

TILE_SIZE_M = 500.0
TILE_BUFFER_M = 25.0

# City processing window in WGS84 (lon/lat), taken from the published extent of
# the municipal Pastatai_3D layer. It bounds the municipality, not its outline.
CITY_BBOX_LONLAT = (25.0183, 54.5650, 25.4894, 54.8354)

MUNICIPAL_MESH_2022 = (
    "https://opencity.idvilnius.lt/server/rest/services/3D/Vilnius_mesh_2022/SceneServer/layers/0"
)


@dataclass(frozen=True)
class Tile:
    """A 500 m processing tile addressed by integer grid indices from the origin."""

    ix: int
    iy: int

    @property
    def name(self) -> str:
        def part(prefix_pos: str, prefix_neg: str, v: int) -> str:
            return f"{prefix_pos if v >= 0 else prefix_neg}{abs(v):03d}"

        return f"{part('E', 'W', self.ix)}_{part('N', 'S', self.iy)}"

    @property
    def bounds_local(self) -> tuple[float, float, float, float]:
        """(min_x, min_y, max_x, max_y) in local metres, x east, y north."""
        x0 = self.ix * TILE_SIZE_M
        y0 = self.iy * TILE_SIZE_M
        return (x0, y0, x0 + TILE_SIZE_M, y0 + TILE_SIZE_M)

    @property
    def bounds_lks(self) -> tuple[float, float, float, float]:
        x0, y0, x1, y1 = self.bounds_local
        return (x0 + ORIGIN_E, y0 + ORIGIN_N, x1 + ORIGIN_E, y1 + ORIGIN_N)

    @property
    def dir(self) -> Path:
        return TILES_DIR / self.name

    @classmethod
    def parse(cls, name: str) -> "Tile":
        a, b = name.split("_")
        ix = int(a[1:]) * (1 if a[0] == "E" else -1)
        iy = int(b[1:]) * (1 if b[0] == "N" else -1)
        return cls(ix, iy)

    @classmethod
    def containing(cls, x_local: float, y_local: float) -> "Tile":
        return cls(math.floor(x_local / TILE_SIZE_M), math.floor(y_local / TILE_SIZE_M))


# Pilot tile: Žaliasis tiltas, the Neris banks and the first junctions south of it.
PILOT_TILE = Tile(0, 0)
