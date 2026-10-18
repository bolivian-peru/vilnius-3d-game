import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import box

from vilnius_pipeline import config, trees
from vilnius_pipeline.config import Tile


def synthetic_tile():
    """Sloped ground, three crowns (two touching), a grey building and a lawn, as photomesh rasters."""
    t = Tile(0, 0)
    b = trees.BUFFER_M
    bounds = (-b, -b, 500 + b, 500 + b)
    n = int((500 + 2 * b) / trees.CELL)
    xs = bounds[0] + (np.arange(n) + 0.5) * trees.CELL
    gx, gy = np.meshgrid(xs, xs)
    ground = 5.0 + 0.03 * gx + 0.01 * gy
    rng = np.random.default_rng(1)
    top = ground.copy()
    rgb = np.empty(top.shape + (3,))
    rgb[:] = (120, 118, 115)  # asphalt grey
    lawn = (gx > 350) & (gx < 420) & (gy > 50) & (gy < 120)
    rgb[lawn] = (95, 140, 70)
    truth = [(100.0, 100.0, 12.0, 4.0), (108.5, 100.0, 11.0, 4.0), (300.0, 320.0, 16.0, 5.5)]
    for x, y, h, r in truth:
        d = np.hypot(gx - x, gy - y)
        inside = d < r
        crown = ground + h - (h * 0.45) * (d / r) ** 2 + rng.normal(0, 0.25, d.shape)
        top = np.where(inside, np.maximum(top, crown), top)
        rgb[inside] = np.array([70, 110, 50]) + rng.normal(0, 8, (inside.sum(), 3))
    house = box(200, 200, 220, 220)
    inhouse = (gx > 200) & (gx < 220) & (gy > 200) & (gy < 220)
    top[inhouse] = ground[inhouse] + 10.0
    rgb[inhouse] = (150, 90, 80)
    low = top.copy()
    return t, bounds, top.astype(np.float32), low.astype(np.float32), rgb.astype(np.float32), [house], truth


class TreeDetection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        t, bounds, top, low, rgb, polys, cls.truth = synthetic_tile()
        res = trees.analyse(top, low, rgb, bounds, polys, [(300.5, 320.5, {"leaf_type": "needleleaved"})])
        cls.rows, cls.mask, cls.ground = trees.tile_outputs(t, res, polys, bounds)

    def test_each_crown_is_one_tree(self):
        self.assertEqual(len(self.rows), 3, self.rows)
        for x, y, h, r in self.truth:
            row = min(self.rows, key=lambda a: np.hypot(a[0] - x, a[1] - y))
            self.assertLess(np.hypot(row[0] - x, row[1] - y), 1.5)
            gz = 5.0 + 0.03 * x + 0.01 * y
            self.assertAlmostEqual(row[2], gz, delta=0.5)        # ground_z
            self.assertAlmostEqual(row[3], h, delta=1.5)         # height
            self.assertAlmostEqual(row[4], r, delta=1.5)         # crown radius
            self.assertLess(row[5], row[3])                      # crown base below the top
            self.assertRegex(row[7], r"^#[0-9a-f]{6}$")

    def test_osm_leaf_type_is_merged(self):
        big = min(self.rows, key=lambda a: np.hypot(a[0] - 300, a[1] - 320))
        self.assertEqual(big[6], 1)

    def test_mask_covers_crowns_only(self):
        m = self.mask  # row 0 south, 1 m cells
        self.assertEqual(m[100, 100], 255)
        self.assertGreater(m[100, 105], 200)   # 1 m past the crown edge is still covered (dilation)
        self.assertEqual(m[210, 210], 0)       # building
        self.assertEqual(m[80, 380], 0)        # lawn at ground level
        self.assertEqual(m[400, 50], 0)        # road
        self.assertLess((m > 0).mean(), 0.01)

    def test_ground_follows_slope_under_canopy(self):
        g = self.ground
        self.assertAlmostEqual(g[320, 300], 5.0 + 0.03 * 300.5 + 0.01 * 320.5, delta=0.5)
        self.assertAlmostEqual(g[210, 210], 5.0 + 0.03 * 210.5 + 0.01 * 210.5, delta=0.5)


class VegPngContract(unittest.TestCase):
    def test_round_trip_and_orientation(self):
        mask = np.zeros((500, 500), np.uint8)
        mask[499, 0] = 255                    # north-west cell (row 0 = south in arrays)
        ground = np.full((500, 500), 37.25)
        ground[0, 499] = -12.5                # south-east cell
        img = trees.encode_veg_png(mask, ground)
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "veg.png"
            img.save(p)
            a = np.asarray(Image.open(p))
        self.assertEqual(a.shape, (500, 500, 4))
        self.assertEqual(a[0, 0, 0], 255)     # PNG row 0 is north, col 0 west
        self.assertTrue((a[..., 3] == 255).all())
        cm = a[..., 1].astype(int) * 256 + a[..., 2]
        self.assertAlmostEqual(cm[0, 0] / 100 - config.ORIGIN_H, 37.25, places=2)
        self.assertAlmostEqual(cm[499, 499] / 100 - config.ORIGIN_H, -12.5, places=2)
        m2, _ = trees.decode_veg_png(img)
        self.assertTrue(np.array_equal(m2, mask))

    def test_area_tiles(self):
        names = {t.name for t in trees.tiles_within(1878.5, 481.5, 1200)}
        self.assertTrue({"E003_N000", "E004_N000", "E004_S001"} <= names)
        self.assertEqual(len(trees.tiles_within(1878.5, 481.5, 10)), 1)


if __name__ == "__main__":
    unittest.main()
