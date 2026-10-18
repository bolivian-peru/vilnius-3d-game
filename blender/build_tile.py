"""Build one Vilnius tile in Blender and export it for Unreal.

    tools/Blender.app/Contents/MacOS/Blender -b -P blender/build_tile.py -- --tile E000_N000

Reads data/build/tiles/<tile>/ (tile.json, terrain.npy, photomesh/*.obj) and writes
  data/build/tiles/<tile>/<tile>.blend        full scene, project-local metres
  data/build/tiles/<tile>/preview_*.png       renders
  unreal/VilniusGame/SourceAssets/<tile>/     FBX + textures + import manifest

Mesh data is stored relative to the tile's south-west corner and each object is
placed at that corner, so vertices stay small however far the tile is from the
project origin. Blender axes: X east, Y north, Z up, metres.
"""

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.geometry import tessellate_polygon

REPO = Path(__file__).resolve().parents[1]
CHUNK_M = 125.0
ROAD_LIFT_M = 0.04
BUILDING_SINK_M = 1.5

COLORS = {
    "Terrain": (0.25, 0.33, 0.2, 1), "Roads": (0.12, 0.12, 0.13, 1), "Paths": (0.45, 0.42, 0.38, 1),
    "Buildings": (0.72, 0.68, 0.6, 1), "Water": (0.1, 0.25, 0.4, 1), "Calibration": (1, 0, 0.6, 1),
}


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tile", default="E000_N000")
    ap.add_argument("--no-photomesh", action="store_true")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--no-export", action="store_true")
    return ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def collection(name):
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def material(name):
    mat = bpy.data.materials.new(f"M_{name}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = COLORS[name]
    bsdf.inputs["Roughness"].default_value = 0.9
    mat.diffuse_color = COLORS[name]
    return mat


def add_mesh(name, verts, faces, col, mat, origin):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = origin
    obj.data.materials.append(mat)
    col.objects.link(obj)
    return obj


class Terrain:
    """Bilinear lookup over the tile's terrain grid, in tile-relative metres."""

    def __init__(self, path, info):
        self.grid = np.load(path) if path.exists() else None
        self.cell = info["cell_m"] if info else 2.0

    def z(self, x, y):
        if self.grid is None:
            return 0.0
        rows, cols = self.grid.shape
        fx = min(max(x / self.cell - 0.5, 0), cols - 1.001)
        fy = min(max(y / self.cell - 0.5, 0), rows - 1.001)
        c, r = int(fx), int(fy)
        tx, ty = fx - c, fy - r
        g = self.grid
        return float((g[r, c] * (1 - tx) + g[r, c + 1] * tx) * (1 - ty)
                     + (g[r + 1, c] * (1 - tx) + g[r + 1, c + 1] * tx) * ty)

    def mesh(self, size):
        """Vertices on cell corners so neighbouring tiles share their edge line."""
        g = np.pad(self.grid, 1, mode="edge")
        corners = (g[:-1, :-1] + g[1:, :-1] + g[:-1, 1:] + g[1:, 1:]) / 4.0
        rows, cols = corners.shape
        xs = np.linspace(0, size, cols)
        ys = np.linspace(0, size, rows)
        gx, gy = np.meshgrid(xs, ys)
        verts = np.column_stack([gx.ravel(), gy.ravel(), corners.ravel()]).tolist()
        idx = np.arange(rows * cols).reshape(rows, cols)
        quads = np.column_stack([idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(),
                                 idx[1:, 1:].ravel(), idx[1:, :-1].ravel()]).tolist()
        return verts, quads


def ribbon(points, width, verts, faces):
    """Append a flat-across road strip following a 3D centerline."""
    if len(points) < 2:
        return
    half = width / 2.0
    base = len(verts)
    for i, p in enumerate(points):
        a = points[max(i - 1, 0)]
        b = points[min(i + 1, len(points) - 1)]
        d = Vector((b[0] - a[0], b[1] - a[1]))
        if d.length < 1e-6:
            d = Vector((1, 0))
        d.normalize()
        left = Vector((-d.y, d.x))
        verts.append((p[0] + left.x * half, p[1] + left.y * half, p[2] + ROAD_LIFT_M))
        verts.append((p[0] - left.x * half, p[1] - left.y * half, p[2] + ROAD_LIFT_M))
    for i in range(len(points) - 1):
        k = base + 2 * i
        faces.append((k + 1, k + 3, k + 2, k))


def build_lines(items, key_width, terrain, x0, y0):
    verts, faces = [], []
    for it in items:
        pts = []
        for x, y, z in it["centerline"]:
            x, y = x - x0, y - y0
            pts.append((x, y, terrain.z(x, y) if z is None else z))
        ribbon(pts, key_width(it), verts, faces)
    return verts, faces


def build_buildings(buildings, terrain, x0, y0):
    verts, faces = [], []
    for b in buildings:
        rings = [[(x - x0, y - y0) for x, y in ring[:-1]] for ring in b["footprint"]]
        rings = [r for r in rings if len(r) >= 3]
        if not rings:
            continue
        cx = sum(p[0] for p in rings[0]) / len(rings[0])
        cy = sum(p[1] for p in rings[0]) / len(rings[0])
        base = b["base_z"] if b["base_z"] is not None else terrain.z(cx, cy)
        top = base + b["height_m"]
        bottom = base - BUILDING_SINK_M
        start = len(verts)
        flat = [p for r in rings for p in r]
        verts.extend((x, y, top) for x, y in flat)
        verts.extend((x, y, bottom) for x, y in flat)
        n = len(flat)
        for tri in tessellate_polygon([[Vector((x, y, 0)) for x, y in r] for r in rings]):
            faces.append(tuple(start + i for i in tri))
        offset = 0
        for r in rings:
            m = len(r)
            for i in range(m):
                a, c = start + offset + i, start + offset + (i + 1) % m
                faces.append((a, c, c + n, a + n))
            offset += m
    return verts, faces


def build_areas(areas, kinds, terrain, x0, y0, lift):
    verts, faces = [], []
    for a in areas:
        if a["kind"] not in kinds:
            continue
        rings = [[(x - x0, y - y0) for x, y in ring[:-1]] for ring in a["polygon"]]
        rings = [r for r in rings if len(r) >= 3]
        if not rings:
            continue
        start = len(verts)
        flat = [p for r in rings for p in r]
        level = min(terrain.z(x, y) for x, y in flat) + lift
        verts.extend((x, y, level) for x, y in flat)
        for tri in tessellate_polygon([[Vector((x, y, 0)) for x, y in r] for r in rings]):
            faces.append(tuple(start + i for i in tri))
    return verts, faces


def fix_normals(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


def import_photomesh(folder, col, x0, y0, origin):
    """Import every node OBJ, then join them into CHUNK_M cells for streaming."""
    shift = Matrix.Translation((-x0, -y0, 0))
    chunks = {}
    for path in sorted(folder.glob("node_*.obj")):
        bpy.ops.wm.obj_import(filepath=str(path), forward_axis="Y", up_axis="Z")
        for obj in bpy.context.selected_objects:
            obj.data.transform(shift)
            c = sum((Vector(v) for v in obj.bound_box), Vector()) / 8.0
            key = (int(c.x // CHUNK_M), int(c.y // CHUNK_M))
            chunks.setdefault(key, []).append(obj)
            for old in obj.users_collection:
                old.objects.unlink(obj)
            col.objects.link(obj)
    out = []
    for (cx, cy), objs in sorted(chunks.items()):
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        joined.name = joined.data.name = f"Photomesh_{cx}_{cy}"
        joined.location = origin
        for poly in joined.data.polygons:
            poly.use_smooth = True
        out.append(joined)
    for mat in bpy.data.materials:
        if mat.use_nodes and (bsdf := mat.node_tree.nodes.get("Principled BSDF")) and mat.name.startswith("node_"):
            bsdf.inputs["Roughness"].default_value = 1.0
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
    return out


def export_fbx(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    saved = []
    for o in objs:
        saved.append((o, o.location.copy(), o.hide_viewport, o.hide_get()))
        o.hide_viewport = False
        o.hide_set(False)
        o.location = (0, 0, 0)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.fbx(
        filepath=str(path), use_selection=True, object_types={"MESH"}, apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS", axis_forward="-Z", axis_up="Y", mesh_smooth_type="FACE",
        use_mesh_modifiers=False, bake_anim=False, path_mode="COPY", embed_textures=False,
    )
    for o, loc, hv, h in saved:
        o.location = loc
        o.hide_viewport = hv
        o.hide_set(h)


def render(path, cam_pos, target, lens, hide):
    scene = bpy.context.scene
    cam = scene.camera
    cam.location = cam_pos
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - Vector(cam_pos)).to_track_quat("-Z", "Y").to_euler()
    for col in scene.collection.children:
        col.hide_render = col.name in hide
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main():
    args = parse_args()
    tile_dir = REPO / "data" / "build" / "tiles" / args.tile
    tile = json.loads((tile_dir / "tile.json").read_text())
    ox, oy = tile["origin"]["e"], tile["origin"]["n"]
    x0, y0, x1, y1 = tile["bounds_local"]
    size = x1 - x0
    origin = (x0, y0, 0.0)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene["vilnius_tile"] = args.tile
    scene["vilnius_origin_lks94"] = [ox, oy, tile["origin"]["h"]]

    terrain = Terrain(tile_dir / "terrain.npy", tile["terrain"])
    mats = {k: material(k) for k in COLORS}
    gameplay = collection("Gameplay")
    groups = {}

    if terrain.grid is not None:
        v, f = terrain.mesh(size)
        groups["Terrain"] = add_mesh("Terrain", v, f, gameplay, mats["Terrain"], origin)

    v, f = build_lines([r for r in tile["roads"] if not r["tunnel"]], lambda r: r["width_m"], terrain, x0, y0)
    if f:
        groups["Roads"] = add_mesh("Roads", v, f, gameplay, mats["Roads"], origin)

    walk = [p for p in tile["paths"] if "highway" in p["tags"]]
    v, f = build_lines(walk, lambda p: 2.0, terrain, x0, y0)
    if f:
        groups["Paths"] = add_mesh("Paths", v, f, gameplay, mats["Paths"], origin)

    v, f = build_buildings([b for b in tile["buildings"] if not b["part"]], terrain, x0, y0)
    if f:
        groups["Buildings"] = add_mesh("Buildings", v, f, gameplay, mats["Buildings"], origin)
        fix_normals(groups["Buildings"])

    v, f = build_areas(tile["areas"], {"natural=water", "waterway=riverbank"}, terrain, x0, y0, 0.1)
    if f:
        groups["Water"] = add_mesh("Water", v, f, gameplay, mats["Water"], origin)

    # 1 m cube with its base on the tile's south-west corner: after import it must
    # sit at Unreal (100*x0, -100*y0, 0) and measure 100 cm on each side.
    cube = [(x, y, z) for z in (0, 1) for y in (0, 1) for x in (0, 1)]
    cube_faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    groups["Calibration"] = add_mesh("Calibration", cube, cube_faces, gameplay, mats["Calibration"], origin)

    photomesh = []
    photo_dir = tile_dir / "photomesh"
    if not args.no_photomesh and photo_dir.exists():
        photomesh = import_photomesh(photo_dir, collection("Photomesh"), x0, y0, origin)

    # Lighting and camera for previews.
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.75, 0.85, 1.0, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 2.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(200))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    cam.data.clip_end = 5000
    scene.collection.objects.link(cam)
    scene.camera = cam

    bpy.ops.wm.save_as_mainfile(filepath=str(tile_dir / f"{args.tile}.blend"))

    if not args.no_render:
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 48
        scene.cycles.use_denoising = True
        prefs = bpy.context.preferences.addons["cycles"].preferences
        try:
            prefs.compute_device_type = "METAL"
            prefs.get_devices()
            for d in prefs.devices:
                d.use = True
            scene.cycles.device = "GPU"
        except Exception as exc:  # CPU fallback keeps headless builds working
            print("GPU unavailable, rendering on CPU:", exc)
        scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
        scene.view_settings.view_transform = "Standard"
        mid = Vector((x0 + size / 2, y0 + size / 2, 0))
        aerial = (mid.x + 330, mid.y - 420, 300)
        if photomesh:
            render(tile_dir / "preview_photomesh_aerial.png", aerial, mid, 32, {"Gameplay"})
            render(tile_dir / "preview_photomesh_low.png", (mid.x + 40, mid.y - 150, 45), (mid.x, mid.y + 60, -5), 28,
                   {"Gameplay"})
        render(tile_dir / "preview_gameplay_aerial.png", aerial, mid, 32, {"Photomesh"})
        for col in scene.collection.children:
            col.hide_render = False

    if not args.no_export:
        out = REPO / "unreal" / "VilniusGame" / "SourceAssets" / args.tile
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        assets = []
        for name, obj in groups.items():
            export_fbx([obj], out / f"SM_{args.tile}_{name}.fbx")
            assets.append({"name": f"SM_{args.tile}_{name}", "file": f"SM_{args.tile}_{name}.fbx", "layer": name,
                           "visible": name in {"Water", "Calibration"},
                           "collision": name in {"Terrain", "Roads", "Paths", "Buildings"}})
        for obj in photomesh:
            export_fbx([obj], out / f"SM_{args.tile}_{obj.name}.fbx")
            assets.append({"name": f"SM_{args.tile}_{obj.name}", "file": f"SM_{args.tile}_{obj.name}.fbx",
                           "layer": "Photomesh", "visible": True, "collision": False, "nanite": True})
        manifest = {
            "tile": args.tile,
            "origin_lks94": tile["origin"],
            "blender_location_m": list(origin),
            # East, south, up in centimetres: X = 100*x, Y = -100*y, Z = 100*z.
            "unreal_location_cm": [100 * x0, -100 * y0, 0.0],
            "size_m": size,
            "assets": assets,
            "gameplay_data": "tile.json",
        }
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
        shutil.copy(tile_dir / "tile.json", out / "tile.json")
        print(f"exported {len(assets)} assets to {out}")


if __name__ == "__main__":
    main()
