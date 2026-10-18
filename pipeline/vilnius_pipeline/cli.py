"""Command line entry point: `uv run vilnius <command>`."""

from __future__ import annotations

import argparse
import json
import sys

from . import config
from .config import Tile


def _tile(name: str | None) -> Tile:
    return Tile.parse(name) if name else config.PILOT_TILE


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="vilnius", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("osm", help="extract the Vilnius window from an OSM PBF and build the lane graph")
    p.add_argument("pbf", help="path to a Lithuania .osm.pbf snapshot")

    p = sub.add_parser("photomesh", help="fetch one tile of the municipal mesh (local evaluation only)")
    p.add_argument("--tile")
    p.add_argument("--max-depth", type=int, help="limit level of detail; omit for the finest")

    p = sub.add_parser("tiles", help="write tile.json for one tile, or for every tile with --all")
    p.add_argument("--tile")
    p.add_argument("--all", action="store_true")

    p = sub.add_parser("prewarm", help="cache the mesh around a point for the browser build")
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--fine", type=float, default=320.0, help="radius cached at full detail, metres")
    p.add_argument("--wide", type=float, default=1500.0, help="radius cached at coarse detail, metres")

    p = sub.add_parser("trees", help="detect trees in the photomesh; write trees.json + veg.png per tile")
    p.add_argument("--radius", type=float, default=1200.0, help="cover tiles within this many metres of the centre")
    p.add_argument("--x", type=float, default=1878.5, help="centre, local metres east (default: Sv. Petro ir Povilo roundabout)")
    p.add_argument("--y", type=float, default=481.5, help="centre, local metres north")
    p.add_argument("--tile", action="append", help="only these tiles (repeatable); the index keeps the others")
    p.add_argument("--debug-dir", help="write canopy/mask/ground debug PNGs here")

    sub.add_parser("info", help="print the coordinate contract and pilot tile")

    args = ap.parse_args(argv)

    if args.cmd == "info":
        t = config.PILOT_TILE
        print(json.dumps({"crs": config.WORK_CRS, "origin": [config.ORIGIN_E, config.ORIGIN_N, config.ORIGIN_H],
                          "tile_size_m": config.TILE_SIZE_M, "pilot_tile": t.name,
                          "pilot_bounds_lks94": t.bounds_lks}, indent=2))
    elif args.cmd == "osm":
        from . import lanegraph, osm

        city_dir = config.BUILD_DIR / "city"
        print(osm.extract(config.REPO_ROOT / args.pbf if not args.pbf.startswith("/") else args.pbf,
                          city_dir / "osm_vilnius.json"))
        city = json.loads((city_dir / "osm_vilnius.json").read_text())
        print(lanegraph.build(city, city_dir / "lanegraph.json"))
    elif args.cmd == "prewarm":
        from . import geo, i3s

        x, y = geo.to_local([args.lon], [args.lat], config.GEOGRAPHIC_CRS)
        print(i3s.prewarm(float(x[0]), float(y[0]), args.fine, args.wide))
    elif args.cmd == "trees":
        from pathlib import Path

        from . import trees

        res = trees.run(args.x, args.y, args.radius, Path(args.debug_dir) if args.debug_dir else None,
                        only=set(args.tile) if args.tile else None)
        print(f"{len(res)} tiles, {sum(r['trees'] for r in res)} trees -> {config.TILES_DIR / 'trees_index.json'}")
    elif args.cmd == "photomesh":
        from . import i3s

        m = i3s.fetch_tile(_tile(args.tile), args.max_depth)
        print(f"{m['tile']}: {len(m['nodes'])} nodes, {m['triangles']} triangles")
    elif args.cmd == "tiles":
        from . import tiles

        city = tiles.City()
        todo = city.tile_names() if args.all else [_tile(args.tile)]
        index = []
        for i, t in enumerate(todo):
            index.append(tiles.build_tile(city, t))
            if not args.all or i % 100 == 0:
                print(index[-1], file=sys.stderr if args.all else sys.stdout)
        if args.all:
            (config.TILES_DIR / "index.json").write_text(json.dumps(index, indent=1))
            print(f"{len(index)} tiles, {sum(t['roads'] for t in index)} road pieces, "
                  f"{sum(t['buildings'] for t in index)} buildings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
