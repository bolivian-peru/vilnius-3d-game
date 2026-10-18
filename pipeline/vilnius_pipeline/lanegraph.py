"""Build the drivable road graph: segments between junctions plus legal turns.

Lane geometry is not stored. A consumer offsets each lane from the segment
centerline: forward lane i sits (i + 0.5) * lane_width to the right of the
centre divider (right-hand traffic), backward lanes mirror that.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

# Explicitly recorded defaults, used only when OSM carries no value. Every use
# is flagged in the segment's `inferred` list so it can be audited and replaced.
DEFAULT_LANES = {"motorway": 2, "trunk": 2, "primary": 2, "secondary": 1, "tertiary": 1}
DEFAULT_LANE_WIDTH_M = 3.25
NARROW_LANE_WIDTH_M = 2.75
NARROW_CLASSES = {"residential", "living_street", "service", "unclassified", "pedestrian"}
DEFAULT_SPEED_KMH = {"motorway": 110, "motorway_link": 60, "trunk": 90, "living_street": 20,
                     "pedestrian": 10, "service": 20}
URBAN_SPEED_KMH = 50
NO_CAR_VALUES = {"no", "private", "delivery", "agricultural", "forestry", "emergency", "permit"}


def _num(text: str | None) -> float | None:
    if not text:
        return None
    m = re.match(r"\s*(\d+(?:[.,]\d+)?)", text)
    return float(m.group(1).replace(",", ".")) if m else None


def _lanes(tags: dict, cls: str, oneway: bool) -> tuple[int, int, bool]:
    total = _num(tags.get("lanes"))
    fwd, bwd = _num(tags.get("lanes:forward")), _num(tags.get("lanes:backward"))
    if oneway:
        if total or fwd:
            return int(fwd or total), 0, False
        return DEFAULT_LANES.get(cls.replace("_link", ""), 1) if not cls.endswith("_link") else 1, 0, True
    if fwd and bwd:
        return int(fwd), int(bwd), False
    if total and total >= 2:
        f = int(fwd) if fwd else int(total - bwd) if bwd else int(math.ceil(total / 2))
        return f, max(int(total) - f, 1), False
    if total == 1:
        # One shared lane used in both directions.
        return 1, 1, False
    n = DEFAULT_LANES.get(cls.replace("_link", ""), 1)
    return n, n, True


def car_access(tags: dict) -> str:
    """'yes', 'no' or 'restricted' for ordinary private cars."""
    cls = tags.get("highway")
    for key in ("motor_vehicle", "vehicle", "access"):
        v = tags.get(key)
        if v is None:
            continue
        if v in NO_CAR_VALUES:
            return "no" if v == "no" else "restricted"
        if v in {"yes", "permissive", "designated", "destination"}:
            return "yes"
    if cls in {"pedestrian", "busway"}:
        return "no"
    return "yes"


def build(city: dict, out: Path) -> dict:
    nodes = city["nodes"]
    use = Counter()
    for way in city["roads"]:
        refs = way["nodes"]
        for i, r in enumerate(refs):
            use[r] += 2 if i in (0, len(refs) - 1) else 1

    segments: list[dict] = []
    way_segments: dict[str, list[int]] = defaultdict(list)
    for way in city["roads"]:
        tags, refs = way["tags"], way["nodes"]
        cls = tags["highway"]
        ow = tags.get("oneway")
        roundabout = tags.get("junction") in {"roundabout", "circular"}
        oneway = ow in {"yes", "1", "true", "-1"} or roundabout or cls in {"motorway", "motorway_link"}
        if ow == "-1":
            refs = refs[::-1]
        lf, lb, lanes_inferred = _lanes(tags, cls, oneway)
        inferred = ["lanes"] if lanes_inferred else []
        width = _num(tags.get("width"))
        lane_w = DEFAULT_LANE_WIDTH_M if cls not in NARROW_CLASSES else NARROW_LANE_WIDTH_M
        if width:
            lane_w = min(max(width / (lf + lb), 2.2), 4.5)
        else:
            width = lane_w * (lf + lb)
            inferred.append("width")
        speed = _num(tags.get("maxspeed"))
        if speed is None:
            speed = DEFAULT_SPEED_KMH.get(cls, URBAN_SPEED_KMH)
            inferred.append("maxspeed")
        try:
            layer = int(float(tags.get("layer", 0)))
        except ValueError:
            layer = 0

        start = 0
        for i in range(1, len(refs)):
            if i == len(refs) - 1 or use[refs[i]] > 1:
                part = refs[start: i + 1]
                start = i
                if len(part) < 2 or any(str(r) not in nodes for r in part):
                    continue
                sid = len(segments)
                way_segments[way["osm_id"]].append(sid)
                segments.append({
                    "id": sid,
                    "stable_id": f"{way['osm_id']}:{part[0]}-{part[-1]}",
                    "osm_way": way["osm_id"],
                    "class": cls,
                    "name": tags.get("name"),
                    "from_node": part[0],
                    "to_node": part[-1],
                    "points": [nodes[str(r)] for r in part],
                    "lanes_fwd": lf,
                    "lanes_bwd": lb,
                    "lane_width_m": round(lane_w, 2),
                    "width_m": round(width, 2),
                    "maxspeed_kmh": speed,
                    "oneway": oneway,
                    "roundabout": roundabout,
                    "bridge": tags.get("bridge") not in (None, "no"),
                    "tunnel": tags.get("tunnel") not in (None, "no"),
                    "layer": layer,
                    "car_access": car_access(tags),
                    "inferred": inferred,
                })

    # Directed arrivals/departures at every junction node.
    arrive: dict[int, list[tuple[int, int]]] = defaultdict(list)  # node -> (segment, dir)
    depart: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for s in segments:
        arrive[s["to_node"]].append((s["id"], 1))
        depart[s["from_node"]].append((s["id"], 1))
        if s["lanes_bwd"]:
            arrive[s["from_node"]].append((s["id"], -1))
            depart[s["to_node"]].append((s["id"], -1))

    # Turn restrictions with a single via node. Via-way restrictions are kept
    # verbatim in `unhandled_restrictions` for manual review.
    banned: set[tuple[int, int, int]] = set()  # (via node, from way segment, to segment)
    only: dict[tuple[int, int], set[int]] = defaultdict(set)
    unhandled = []
    for rel in city["restrictions"]:
        kind = rel["tags"].get("restriction")
        frm = [m["ref"] for m in rel["members"] if m["role"] == "from" and m["type"] == "w"]
        to = [m["ref"] for m in rel["members"] if m["role"] == "to" and m["type"] == "w"]
        via = [m["ref"] for m in rel["members"] if m["role"] == "via" and m["type"] == "n"]
        if not (frm and to):
            continue
        known = [w for w in frm + to if f"w{w}" in way_segments]
        if not known:
            continue  # outside the city window
        if not kind or len(via) != 1 or len(known) != len(frm) + len(to):
            unhandled.append(rel)
            continue
        v = via[0]
        f_segs = [s for w in frm for s in way_segments[f"w{w}"] if v in (segments[s]["from_node"], segments[s]["to_node"])]
        t_segs = [s for w in to for s in way_segments[f"w{w}"] if v in (segments[s]["from_node"], segments[s]["to_node"])]
        for f in f_segs:
            for t in t_segs:
                if kind.startswith("no_"):
                    banned.add((v, f, t))
                elif kind.startswith("only_"):
                    only[(v, f)].add(t)

    connections = []
    for node, ins in arrive.items():
        outs = depart.get(node, [])
        for seg_in, dir_in in ins:
            options = [(so, do) for so, do in outs if so != seg_in]
            if not options:
                # Dead end: allow the U-turn so traffic never gets stuck.
                options = [(so, do) for so, do in outs if so == seg_in and do != dir_in]
            allowed = only.get((node, seg_in))
            for seg_out, dir_out in options:
                if (node, seg_in, seg_out) in banned or (allowed and seg_out not in allowed):
                    continue
                connections.append([seg_in, dir_in, seg_out, dir_out])

    doc = {
        "schema_version": 1,
        "source": city["source"],
        "crs": city["crs"],
        "origin": city["origin"],
        "units": "metres, local frame (x east, y north); heights are resolved per tile",
        "traffic_side": "right",
        "defaults": {"lanes": DEFAULT_LANES, "lane_width_m": DEFAULT_LANE_WIDTH_M,
                     "narrow_lane_width_m": NARROW_LANE_WIDTH_M, "urban_speed_kmh": URBAN_SPEED_KMH},
        "segments": segments,
        "connections": connections,
        "signals": [int(k) for k, t in city["node_tags"].items() if t.get("highway") == "traffic_signals"],
        "unhandled_restrictions": unhandled,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    return {
        "segments": len(segments), "connections": len(connections), "signals": len(doc["signals"]),
        "restrictions_applied": len(banned) + sum(len(v) for v in only.values()),
        "restrictions_unhandled": len(unhandled),
        "segments_with_inferred_lanes": sum("lanes" in s["inferred"] for s in segments),
        "km": round(sum(math.dist(a, b) for s in segments for a, b in zip(s["points"], s["points"][1:])) / 1000, 1),
    }
