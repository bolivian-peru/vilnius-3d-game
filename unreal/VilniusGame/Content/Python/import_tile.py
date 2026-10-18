"""Import a Blender-built Vilnius tile into the open Unreal project.

Run inside the editor (Output Log, with the command field set to "Cmd"):

    py "Content/Python/import_tile.py" E000_N000

It imports unreal/VilniusGame/SourceAssets/<tile>/*.fbx into /Game/Vilnius/Tiles/<tile>,
creates the pilot map on first run, places every mesh at the location recorded in
manifest.json, and copies tile.json to Content/VilniusData for the traffic system.

Written against the UE 5 editor Python API and not yet executed: this machine has
no Unreal installation. Expect to adjust import options on first run.
"""

import json
import os
import shutil
import sys

import unreal

MAP_PATH = "/Game/Vilnius/Maps/Vilnius_Pilot"


def import_meshes(src_dir, manifest, dest):
    tasks = []
    for asset in manifest["assets"]:
        options = unreal.FbxImportUI()
        options.import_mesh = True
        options.import_as_skeletal = False
        options.import_animations = False
        options.import_materials = True
        options.import_textures = True
        data = options.static_mesh_import_data
        data.combine_meshes = True
        data.auto_generate_collision = False
        data.remove_degenerates = True
        data.normal_import_method = unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS
        data.build_nanite = bool(asset.get("nanite"))

        task = unreal.AssetImportTask()
        task.filename = os.path.join(src_dir, asset["file"])
        task.destination_path = dest
        task.destination_name = asset["name"]
        task.automated = True
        task.replace_existing = True
        task.save = True
        task.options = options
        tasks.append(task)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)


def configure_mesh(mesh, asset):
    body = mesh.get_editor_property("body_setup")
    if asset["collision"]:
        # The generated layers are thin surfaces; use their triangles directly.
        body.set_editor_property("collision_trace_flag", unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
    else:
        body.set_editor_property("collision_trace_flag", unreal.CollisionTraceFlag.CTF_USE_SIMPLE_AS_COMPLEX)
    unreal.EditorAssetLibrary.save_loaded_asset(mesh)


def ensure_map():
    levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if unreal.EditorAssetLibrary.does_asset_exist(MAP_PATH):
        levels.load_level(MAP_PATH)
        return False
    levels.new_level(MAP_PATH)
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    sun = actors.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(0, 0, 5000), unreal.Rotator(0, -48, 200))
    sun.set_actor_label("Sun")
    sun.light_component.set_editor_property("atmosphere_sun_light", True)
    actors.spawn_actor_from_class(unreal.SkyAtmosphere, unreal.Vector(0, 0, 0)).set_actor_label("SkyAtmosphere")
    sky = actors.spawn_actor_from_class(unreal.SkyLight, unreal.Vector(0, 0, 5000))
    sky.light_component.set_editor_property("real_time_capture", True)
    actors.spawn_actor_from_class(unreal.ExponentialHeightFog, unreal.Vector(0, 0, 0))
    return True


def to_world(x, y, z):
    """Project-local metres (x east, y north, z up) -> Unreal centimetres (east, south, up)."""
    return unreal.Vector(100.0 * x, -100.0 * y, 100.0 * z)


def place_player_start(tile, actors):
    """Stand the player on the first bridge deck, or the first road if the tile has no bridge."""
    roads = [r for r in tile["roads"] if r["car_access"] == "yes" and r["centerline"][0][2] is not None]
    if not roads:
        return
    road = next((r for r in roads if r["bridge"]), roads[0])
    line = road["centerline"]
    a, b = line[len(line) // 2 - 1], line[len(line) // 2]
    import math

    yaw = math.degrees(math.atan2(-(b[1] - a[1]), b[0] - a[0]))
    start = actors.spawn_actor_from_class(unreal.PlayerStart, to_world(a[0], a[1], a[2] + 1.5), unreal.Rotator(0, 0, yaw))
    start.set_actor_label("PlayerStart_" + tile["tile"])


def main(tile_name):
    project = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
    src_dir = os.path.join(project, "SourceAssets", tile_name)
    with open(os.path.join(src_dir, "manifest.json")) as f:
        manifest = json.load(f)
    with open(os.path.join(src_dir, "tile.json")) as f:
        tile = json.load(f)

    dest = "/Game/Vilnius/Tiles/" + tile_name
    import_meshes(src_dir, manifest, dest)

    data_dir = os.path.join(project, "Content", "VilniusData", tile_name)
    os.makedirs(data_dir, exist_ok=True)
    shutil.copy(os.path.join(src_dir, "tile.json"), os.path.join(data_dir, "tile.json"))

    created = ensure_map()
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    folder = "Tiles/" + tile_name
    for actor in actors.get_all_level_actors():
        if str(actor.get_folder_path()) == folder:
            actors.destroy_actor(actor)

    location = unreal.Vector(*manifest["unreal_location_cm"])
    missing = []
    for asset in manifest["assets"]:
        mesh = unreal.EditorAssetLibrary.load_asset("{}/{}".format(dest, asset["name"]))
        if not mesh:
            missing.append(asset["name"])
            continue
        configure_mesh(mesh, asset)
        actor = actors.spawn_actor_from_object(mesh, location)
        actor.set_actor_label(asset["name"])
        actor.set_folder_path(folder)
        actor.set_actor_hidden_in_game(not asset["visible"])
        component = actor.static_mesh_component
        component.set_collision_enabled(
            unreal.CollisionEnabled.QUERY_AND_PHYSICS if asset["collision"] else unreal.CollisionEnabled.NO_COLLISION)
        if asset["layer"] == "Calibration":
            actor.set_is_temporarily_hidden_in_editor(False)

    if created:
        place_player_start(tile, actors)
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level()
    unreal.log("Vilnius tile {}: {} assets placed, {} missing {}".format(
        tile_name, len(manifest["assets"]) - len(missing), len(missing), missing))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "E000_N000")
