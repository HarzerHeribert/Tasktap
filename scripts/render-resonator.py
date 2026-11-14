"""Render Tasktap's resonator, then encode the web assets with ffmpeg.

BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"
"$BLENDER" -b -t 6 --python scripts/render-resonator.py
Pass -- --preview to render just the first frame to the temporary directory.
"""
import argparse
import math
from pathlib import Path
import subprocess
import sys
import tempfile

import bpy
from mathutils import Vector

args = argparse.ArgumentParser()
args.add_argument("--preview", action="store_true")
args.add_argument("--encode-only", action="store_true", help="Reuse the rendered frames")
args.add_argument("--frames", type=Path, default=Path(tempfile.gettempdir()) / "tasktap-resonator")
args = args.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
args.frames.mkdir(parents=True, exist_ok=True)
assets = Path(__file__).resolve().parents[1] / "prototype/assets/resonator"
assets.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 12
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.cycles.device = "CPU"
scene.render.resolution_x, scene.render.resolution_y = 720, 416
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.image_settings.compression = 15
scene.view_settings.view_transform = "AgX"
scene.world = bpy.data.worlds.new("Black cyclorama")
scene.world.use_nodes = True
world = scene.world.node_tree.nodes["Background"]
world.inputs[0].default_value = (0.002, 0.003, 0.0025, 1)
world.inputs[1].default_value = 0.25


def lacquer(name, tint, metallic, roughness, coat=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    for key, value in {"Base Color": (*tint, 1), "Metallic": metallic, "Roughness": roughness,
                       "Coat Weight": coat, "Coat Roughness": 0.17}.items():
        shader.inputs[key].default_value = value
    return material


jade = lacquer("Vitreous malachite", (0.075, 0.29, 0.195), 0.61, 0.22, 0.35)
petrol = lacquer("Deep petrol enamel", (0.039, 0.14, 0.12), 0.7, 0.25, 0.32)
brass = lacquer("Satin champagne brass", (0.55, 0.32, 0.12), 0.91, 0.22)
aureate = lacquer("Polished pale gold edge", (0.82, 0.55, 0.24), 0.92, 0.15)
amber = lacquer("Amber vitreous enamel", (0.83, 0.25, 0.042), 0.55, 0.2, 0.36)
lining = lacquer("Palladium inner lining", (0.43, 0.53, 0.49), 0.89, 0.19)


def rounded_frame(index, finish, size):
    # Revolve a rounded rectangular cross-section around a superelliptic aperture.
    # A narrow material band at each shoulder catches the moving strip reflections.
    median = 0.83 * size
    half_band, half_depth = 0.145 * size, 0.043
    fillet = min(half_depth, half_band) * 0.72
    section = []
    for corner in range(4):
        angle = corner * math.pi / 2
        r_centre = (half_band - fillet) * (1 if corner in (0, 3) else -1)
        x_centre = (half_depth - fillet) * (1 if corner in (0, 1) else -1)
        for step in range(5):
            theta = angle + step / 4 * math.pi / 2
            section.append((median + r_centre + fillet * math.cos(theta),
                            x_centre + fillet * math.sin(theta)))
    count, width = 112, len(section)
    vertices, quads = [], []
    for i in range(count):
        a = 2 * math.pi * i / count
        y, z = math.cos(a), math.sin(a)
        radius = (abs(y) ** 3.5 + abs(z) ** 3.5) ** (-1 / 3.5)
        for r, depth in section:
            vertices.append((depth, y * radius * r, z * radius * r))
        for j in range(width):
            near, far = i * width, ((i + 1) % count) * width
            quads.append((near+j, far+j, far+(j+1)%width, near+(j+1)%width))
    geometry = bpy.data.meshes.new(f"Milled aperture {index:02}")
    geometry.from_pydata(vertices, [], quads)
    obj = bpy.data.objects.new(geometry.name, geometry)
    scene.collection.objects.link(obj)
    for mat in (finish, aureate, lining):
        geometry.materials.append(mat)
    for face in geometry.polygons:
        edge = face.index % width
        face.material_index = 1 if edge in (2, 17) else 2 if edge in (9, 10, 11) else 0
        face.use_smooth = True
    return obj


rings = []
for index in range(27):
    t = index / 26
    size = 0.73 + 0.36 * math.sin(t * math.pi) ** 0.75 + 0.07 * math.cos(t * 2 * math.pi)
    metal = amber if index in (12, 13, 14) else brass if index in (0, 1, 9, 10, 16, 24, 25, 26) else petrol if index < 8 else jade
    rings.append(rounded_frame(index, metal, size))


def pose(phase):
    for index, ring in enumerate(rings):
        t = index / (len(rings) - 1)
        wave = phase - t * 2 * math.pi
        ring.location = ((t - 0.5) * 4.1 + 0.15 * math.sin(wave),
                         0.13 * math.sin(t * 2 * math.pi + 0.32 * math.cos(phase)),
                         0.35 * math.sin(t * 2 * math.pi - 0.7) + 0.55 * (t - 0.5) + 0.13 * math.cos(wave))
        ring.rotation_euler = (t * 2.48 + 0.29 * math.sin(wave),
                               -0.16 - 0.15 * math.cos(wave),
                               0.07 * math.sin(wave + 0.6))
        ring.scale = (1, 1 + 0.075 * math.cos(wave), 1 + 0.075 * math.cos(wave))


def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat("-Z", "Y").to_euler()


def softbox(name, xyz, color, power, width, height):
    lamp = bpy.data.lights.new(name, "AREA")
    lamp.shape, lamp.energy, lamp.color = "RECTANGLE", power, color
    lamp.size, lamp.size_y = width, height
    obj = bpy.data.objects.new(name, lamp)
    scene.collection.objects.link(obj)
    obj.location = xyz
    aim(obj, (0, 0, 0))


softbox("Overhead parchment", (0, -1, 5), (1, 0.91, 0.77), 620, 6.5, 2.1)
softbox("Long opal strip", (-3, -4, 1.2), (0.69, 0.94, 0.9), 420, 5.8, 0.8)
softbox("Warm edge", (4.7, 1.1, 2.2), (1, 0.79, 0.53), 480, 3, 1.15)
softbox("Patina rim", (-2, 3, 2.8), (0.52, 1, 0.74), 510, 3.8, 1.2)
softbox("Lens-side bounce", (4, -4, -1.6), (0.82, 0.94, 1), 170, 3.4, 1.4)
bpy.ops.object.camera_add(location=(5.8, -10.0, 5.0))
cam = bpy.context.object
aim(cam, (0, 0, 0))
cam.data.type, cam.data.ortho_scale = "ORTHO", 5.65
# Roll the object up through the frame, as if the front aperture is lifting.
cam.rotation_euler.rotate_axis("Z", -0.24)
scene.camera = cam

total = 72
for frame in range(0 if args.encode_only else 1 if args.preview else total):
    pose(frame * 2 * math.pi / total + 0.35)
    scene.render.filepath = str(args.frames / f"{frame:04d}.png")
    bpy.ops.render.render(write_still=True)

if not args.preview:
    def ffmpeg(*arguments):
        subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, arguments)], check=True)

    for suffix, size in (("stage", "720:416"), ("miniature", "180:104")):
        ffmpeg("-i", args.frames/"0000.png", "-frames:v", "1", "-vf", "scale="+size,
               "-q:v", "2", assets/f"{suffix}.jpg")
        ffmpeg("-framerate", "24", "-i", args.frames/"%04d.png", "-frames:v", total,
               "-vf", "scale="+size, "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", "-an", assets/f"{suffix}.mp4")

    # Compose the Finder icon from the same render, inside the macOS icon grid.
    iconset = args.frames/"Tasktap.iconset"
    iconset.mkdir(exist_ok=True)
    plate, mark, master = (args.frames/name for name in ("plate.png", "mark.png", "icon.png"))
    def magick(*arguments):
        subprocess.run(["magick", *map(str, arguments)], check=True)
    magick("-size","1024x1024","xc:none","-fill","#141c19","-stroke","#4a554d","-strokewidth","3",
           "-draw","roundrectangle 80,80 944,944 170,170",plate)
    magick(args.frames/"0000.png","-resize","930x","-background","#000","-gravity","center","-extent","1024x1024",mark)
    magick(plate,"(",mark,")","-compose","Screen","-composite","(",plate,"-alpha","extract",")",
           "-compose","CopyOpacity","-composite",master)
    for points in (16,32,128,256,512):
        for scale,suffix in ((1,""),(2,"@2x")):
            magick(master,"-resize",str(points*scale)+"x","-depth","8","-strip",
                   iconset/f"icon_{points}x{points}{suffix}.png")
    subprocess.run(["iconutil","-c","icns","-o",str(assets/"Tasktap.icns"),str(iconset)],check=True)
