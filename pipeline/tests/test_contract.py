import unittest

import numpy as np

from vilnius_pipeline import config, geo, lanegraph
from vilnius_pipeline.config import Tile


class CoordinateContract(unittest.TestCase):
    def test_origin_maps_to_zero(self):
        lon, lat = geo.from_local([0.0], [0.0], config.GEOGRAPHIC_CRS)
        x, y = geo.to_local(lon, lat, config.GEOGRAPHIC_CRS)
        self.assertAlmostEqual(float(x[0]), 0.0, places=3)
        self.assertAlmostEqual(float(y[0]), 0.0, places=3)

    def test_zaliasis_tiltas_is_in_pilot_tile(self):
        x, y = geo.to_local([25.2797], [54.6917], config.GEOGRAPHIC_CRS)
        self.assertEqual(Tile.containing(float(x[0]), float(y[0])), config.PILOT_TILE)

    def test_tile_names_round_trip(self):
        for tile in (Tile(0, 0), Tile(-3, 12), Tile(7, -1)):
            self.assertEqual(Tile.parse(tile.name), tile)
        self.assertEqual(Tile(-1, 0).bounds_local, (-500.0, 0.0, 0.0, 500.0))

    def test_mercator_metres_are_not_ground_metres(self):
        # Guards the photomesh import: EPSG:3857 distances must be reprojected, not copied.
        x, _ = geo.to_local(np.array([2814000.0, 2814100.0]), np.array([7302000.0, 7302000.0]), "EPSG:3857")
        self.assertAlmostEqual(float(x[1] - x[0]), 57.8, delta=0.5)


class LaneGraph(unittest.TestCase):
    def setUp(self):
        nodes = {"1": [0, 0], "2": [100, 0], "3": [200, 0], "4": [100, 100]}
        self.city = {
            "source": {}, "crs": config.WORK_CRS, "origin": {}, "nodes": nodes, "node_tags": {},
            "roads": [
                {"osm_id": "w1", "nodes": [1, 2], "tags": {"highway": "primary", "lanes": "4"}},
                {"osm_id": "w2", "nodes": [2, 3], "tags": {"highway": "primary", "oneway": "yes"}},
                {"osm_id": "w3", "nodes": [2, 4], "tags": {"highway": "residential"}},
            ],
            "restrictions": [{"osm_id": "r1", "tags": {"restriction": "no_left_turn"}, "members": [
                {"type": "w", "ref": 1, "role": "from"}, {"type": "n", "ref": 2, "role": "via"},
                {"type": "w", "ref": 3, "role": "to"}]}],
        }

    def test_lanes_oneway_and_restrictions(self):
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "g.json"
            lanegraph.build(self.city, out)
            g = json.loads(out.read_text())
        seg = {s["osm_way"]: s for s in g["segments"]}
        self.assertEqual((seg["w1"]["lanes_fwd"], seg["w1"]["lanes_bwd"]), (2, 2))
        self.assertEqual(seg["w1"]["inferred"], ["width", "maxspeed"])
        self.assertEqual(seg["w2"]["lanes_bwd"], 0)
        self.assertIn("lanes", seg["w3"]["inferred"])
        conns = {tuple(c) for c in g["connections"]}
        self.assertIn((seg["w1"]["id"], 1, seg["w2"]["id"], 1), conns)
        self.assertNotIn((seg["w1"]["id"], 1, seg["w3"]["id"], 1), conns)  # banned left turn
        self.assertNotIn((seg["w3"]["id"], -1, seg["w2"]["id"], -1), conns)  # against the one-way
        self.assertIn((seg["w3"]["id"], -1, seg["w1"]["id"], -1), conns)


if __name__ == "__main__":
    unittest.main()
