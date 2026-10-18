"""Export a built tile as GLB files for the browser build in web/.

    tools/Blender.app/Contents/MacOS/Blender -b data/build/tiles/E000_N000/E000_N000.blend \
        -P blender/export_web.py -- --tile E000_N000

Photomesh textures are halved in each dimension so the tile fits in browser GPU memory.
glTF is Y-up: Blender (x east, y north, z up) becomes three.js (x, z, -y).
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

import bpy

REPO = Path(__file__).resolve().parents[1]
TEXTURE_SCALE = 0.5


def export(objs, path, draco):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
        export_image_format="JPEG", export_image_quality=82, export_normals=not draco, export_tangents=False,
        export_animations=False, export_cameras=False, export_lights=False,
        export_draco_mesh_compression_enable=draco, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14, export_draco_texcoord_quantization=12,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tile", default="E000_N000")
    args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])
    out = REPO / "web" / "public" / "tiles" / args.tile
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for img in bpy.data.images:
        if img.size[0] > 64 and img.source == "FILE":
            img.scale(max(64, int(img.size[0] * TEXTURE_SCALE)), max(64, int(img.size[1] * TEXTURE_SCALE)))

    gameplay = [o for o in bpy.data.collections["Gameplay"].objects if o.type == "MESH"]
    export(gameplay, out / "gameplay.glb", False)
    chunks = []
    if "Photomesh" in bpy.data.collections:
        for o in sorted(bpy.data.collections["Photomesh"].objects, key=lambda o: o.name):
            export([o], out / f"{o.name}.glb", True)
            chunks.append(f"{o.name}.glb")

    tile_dir = REPO / "data" / "build" / "tiles" / args.tile
    shutil.copy(tile_dir / "tile.json", out / "tile.json")
    (out / "web.json").write_text(json.dumps({"tile": args.tile, "gameplay": "gameplay.glb", "photomesh": chunks}))
    print("web export:", len(chunks), "photomesh chunks ->", out)


if __name__ == "__main__":
    main()
