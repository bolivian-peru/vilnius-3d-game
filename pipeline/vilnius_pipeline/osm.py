"""Extract Vilnius streets, buildings and ground cover from an OSM PBF.

Output is a single city-wide JSON document in local metres. Tags that drive
gameplay are kept verbatim; nothing is defaulted here, so a missing lane count
stays missing until lanegraph.py records an explicit inferred value.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import osmium
from shapely import wkb as shapely_wkb
from shapely.geometry import MultiPolygon, Polygon

from . import config, geo

DRIVABLE = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "pedestrian", "busway",
}
WALKABLE = {"footway", "path", "steps", "cycleway", "track", "bridleway", "corridor"}
ROAD_TAGS = (
    "highway", "name", "ref", "oneway", "junction", "lanes", "lanes:forward", "lanes:backward",
    "turn:lanes", "turn:lanes:forward", "turn:lanes:backward", "maxspeed", "width", "surface",
    "bridge", "tunnel", "layer", "access", "motor_vehicle", "vehicle", "bus", "psv", "service",
    "sidewalk", "sidewalk:left", "sidewalk:right", "lit", "cycleway", "busway", "bicycle", "foot",
)
BUILDING_TAGS = (
    "building", "building:levels", "building:min_level", "height", "min_height", "roof:shape",
    "roof:height", "roof:levels", "name", "addr:street", "addr:housenumber", "amenity", "shop",
    "tourism", "historic", "building:material", "building:colour", "roof:colour", "roof:material",
)
AREA_KINDS = {
    "natural": {"water", "wood", "scrub", "grassland", "sand", "beach"},
    "landuse": {"forest", "grass", "meadow", "cemetery", "railway", "recreation_ground", "village_green",
                "allotments", "construction"},
    "leisure": {"park", "garden", "pitch", "playground"},
    "waterway": {"riverbank", "dock"},
    "amenity": {"parking"},
    "highway": {"pedestrian"},
}
POINT_KINDS = {
    "highway": {"traffic_signals", "crossing", "bus_stop", "street_lamp", "stop", "give_way",
                "mini_roundabout", "turning_circle"},
    "natural": {"tree"},
    "amenity": {"bench", "waste_basket", "fuel", "parking_entrance"},
}
RESTRICTION_KEYS = ("restriction", "restriction:conditional", "except", "type")


def _pick(tags, keys) -> dict:
    return {k: tags[k] for k in keys if k in tags}


def _rings(geom) -> list[list[list[list[float]]]]:
    """Shapely polygon(s) in lon/lat -> list of polygons, each [outer, hole, ...] in local metres."""
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for p in polys:
        if not isinstance(p, Polygon) or p.is_empty:
            continue
        rings = []
        for ring in [p.exterior, *p.interiors]:
            xs, ys = zip(*ring.coords)
            lx, ly = geo.to_local(xs, ys, config.GEOGRAPHIC_CRS)
            rings.append([[round(float(a), 3), round(float(b), 3)] for a, b in zip(lx, ly)])
        out.append(rings)
    return out


def extract(pbf: Path, out: Path, bbox_lonlat=config.CITY_BBOX_LONLAT) -> dict:
    w, s, e, n = bbox_lonlat

    def inside(lon: float, lat: float) -> bool:
        return w <= lon <= e and s <= lat <= n

    wkbfab = osmium.geom.WKBFactory()
    nodes: dict[int, list[float]] = {}
    roads, paths, rails, buildings, areas, points, restrictions = [], [], [], [], [], [], []
    node_tags: dict[int, dict] = {}

    fp = (
        osmium.FileProcessor(str(pbf))
        .with_locations()
        .with_areas()
        .with_filter(osmium.filter.KeyFilter(
            "highway", "building", "building:part", "natural", "landuse", "leisure", "waterway",
            "railway", "amenity", "restriction", "type"))
    )
    for obj in fp:
        tags = obj.tags
        if obj.is_node():
            if not obj.location.valid() or not inside(obj.lon, obj.lat):
                continue
            for key, kinds in POINT_KINDS.items():
                if tags.get(key) in kinds:
                    lx, ly = geo.to_local([obj.lon], [obj.lat], config.GEOGRAPHIC_CRS)
                    rec = {"osm_id": f"n{obj.id}", "kind": f"{key}={tags[key]}",
                           "xy": [round(float(lx[0]), 3), round(float(ly[0]), 3)],
                           "tags": {t.k: t.v for t in tags}}
                    points.append(rec)
                    node_tags[obj.id] = rec["tags"]
                    break
        elif obj.is_way():
            hw, rw = tags.get("highway"), tags.get("railway")
            is_line = (hw in DRIVABLE or hw in WALKABLE) and tags.get("area") != "yes"
            if not (is_line or rw in {"rail", "tram"}):
                continue
            refs, lon, lat = [], [], []
            for nd in obj.nodes:
                if nd.location.valid():
                    refs.append(nd.ref)
                    lon.append(nd.lon)
                    lat.append(nd.lat)
            if len(refs) < 2 or not any(inside(a, b) for a, b in zip(lon, lat)):
                continue
            lx, ly = geo.to_local(lon, lat, config.GEOGRAPHIC_CRS)
            for r, a, b in zip(refs, lx, ly):
                nodes[r] = [round(float(a), 3), round(float(b), 3)]
            rec = {"osm_id": f"w{obj.id}", "version": obj.version, "nodes": refs}
            if is_line:
                rec["tags"] = _pick(tags, ROAD_TAGS)
                (roads if hw in DRIVABLE else paths).append(rec)
            else:
                rec["tags"] = _pick(tags, ("railway", "bridge", "tunnel", "layer", "electrified"))
                rails.append(rec)
        elif obj.is_relation():
            if tags.get("type") == "restriction" or "restriction" in tags:
                members = [{"type": m.type, "ref": m.ref, "role": m.role} for m in obj.members]
                restrictions.append({"osm_id": f"r{obj.id}", "tags": _pick(tags, RESTRICTION_KEYS),
                                     "members": members})
        elif obj.is_area():
            is_building = "building" in tags or "building:part" in tags
            kind = None
            if not is_building:
                for key, kinds in AREA_KINDS.items():
                    if tags.get(key) in kinds and (key != "highway" or tags.get("area") == "yes"):
                        kind = f"{key}={tags[key]}"
                        break
                if kind is None:
                    continue
            try:
                geom = shapely_wkb.loads(wkbfab.create_multipolygon(obj), hex=True)
            except Exception:
                continue
            c = geom.representative_point()
            # Large water and forest polygons straddle the window, so test bounds for those.
            gx0, gy0, gx1, gy1 = geom.bounds
            if not (inside(c.x, c.y) or (not is_building and gx0 <= e and gx1 >= w and gy0 <= n and gy1 >= s)):
                continue
            src = f"{'w' if obj.from_way() else 'r'}{obj.orig_id()}"
            polys = _rings(geom)
            if not polys:
                continue
            if is_building:
                buildings.append({"osm_id": src, "part": "building:part" in tags and "building" not in tags,
                                  "tags": _pick(tags, BUILDING_TAGS + ("building:part",)), "polygons": polys})
            else:
                areas.append({"osm_id": src, "kind": kind, "tags": _pick(tags, ("name", "surface", "layer")),
                              "polygons": polys})

    used = {r for coll in (roads, paths, rails) for rec in coll for r in rec["nodes"]}
    doc = {
        "schema_version": 1,
        "source": {"file": pbf.name, "provider": "OpenStreetMap contributors via Geofabrik",
                   "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors"},
        "extracted_on": time.strftime("%Y-%m-%d"),
        "crs": config.WORK_CRS,
        "origin": {"e": config.ORIGIN_E, "n": config.ORIGIN_N, "h": config.ORIGIN_H},
        "bbox_lonlat": list(bbox_lonlat),
        "nodes": {str(k): v for k, v in nodes.items() if k in used},
        "node_tags": {str(k): v for k, v in node_tags.items() if k in used},
        "roads": roads, "paths": paths, "rails": rails, "buildings": buildings,
        "areas": areas, "points": points, "restrictions": restrictions,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    return {k: len(doc[k]) for k in ("nodes", "roads", "paths", "rails", "buildings", "areas", "points",
                                     "restrictions")}
