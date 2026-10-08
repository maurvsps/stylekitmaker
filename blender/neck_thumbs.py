"""
Render a close-up of every shirt's neckline for the editor's collar picker: public/models/<name>_neck.png.

    blender --background --python blender/neck_thumbs.py            (every shirt in public/models/kits.json)
    blender --background --python blender/neck_thumbs.py -- shirt_clo_v shirt_puma19

Each model is imported from its GLB, painted one grey and lit by Workbench's studio light with cavity shading, so only
the shape of the collar shows (the kit's colours come from the editor).
"""

import json
import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "public", "models")
SIZE = 360


def render(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, name + ".glb"))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    top = max((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
    grey = bpy.data.materials.new("grey")
    grey.diffuse_color = (0.62, 0.62, 0.64, 1)
    for o in meshes:
        o.data.materials.clear()
        o.data.materials.append(grey)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    shading.show_shadows = True
    scene.display.render_aa = "8"

    cam_data = bpy.data.cameras.new("neck")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 0.36
    cam = bpy.data.objects.new("neck", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, -1.2, top - 0.075)  # the shirt faces -Y
    cam.rotation_euler = (math.pi / 2, 0, 0)
    scene.camera = cam
    scene.render.filepath = os.path.join(MODELS, name + "_neck.png")
    bpy.ops.render.render(write_still=True)
    print(f"[neck] {name}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        with open(os.path.join(MODELS, "kits.json")) as fh:
            argv = [k["name"] for k in json.load(fh)["kits"] if k["garment"] == "shirt"]
    for name in argv:
        render(name)


main()
