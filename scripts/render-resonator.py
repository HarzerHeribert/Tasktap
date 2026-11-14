"""Render Tasktap's resonator, then encode the web assets with ffmpeg.

BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"
"$BLENDER" -b -t 6 --python scripts/render-resonator.py
Pass -- --preview to render one frame, --device METAL for the macOS GPU, or
--icon to opt into regenerating the Finder icon after a full render.
"""
import argparse
from array import array
import math
from pathlib import Path
import subprocess
import sys
import tempfile

import bpy
from mathutils import Vector

args = argparse.ArgumentParser()
args.add_argument("--preview", action="store_true")
args.add_argument("--icon", action="store_true", help="Also regenerate the Finder icon from this finish")
args.add_argument("--device", choices=["CPU","METAL"], default="CPU")
args.add_argument("--encode-only", action="store_true", help="Reuse the rendered frames")
args.add_argument("--frames", type=Path, default=Path(tempfile.gettempdir()) / "tasktap-resonator")
args = args.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
args.frames.mkdir(parents=True, exist_ok=True)
assets = Path(__file__).resolve().parents[1] / "prototype/assets/resonator"
assets.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 36
scene.cycles.adaptive_threshold = 0.035
scene.cycles.adaptive_min_samples = 12
scene.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.cycles.sample_clamp_indirect = 2.0
scene.cycles.device = "CPU"
if args.device == "METAL":
    preferences = bpy.context.preferences.addons["cycles"].preferences
    preferences.compute_device_type = "METAL"
    preferences.refresh_devices()
    gpu = [device for device in preferences.devices if device.type == "METAL"]
    if not gpu:
        raise RuntimeError("Blender did not discover a Metal GPU. Run with --device CPU.")
    for device in preferences.devices:
        device.use = device.type == "METAL"
    scene.cycles.device = "GPU"
scene.render.resolution_x, scene.render.resolution_y = 720, 416
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.image_settings.compression = 15
scene.view_settings.view_transform = "AgX"
scene.world = bpy.data.worlds.new("Black cyclorama")
scene.world.use_nodes = True
# A full studio panorama gives mirror faces bright softbox panels and substantial grey
# walls even where there is no direct lamp. Camera rays receive a separate black backdrop.
world = scene.world.node_tree.nodes["Background"]
world.inputs[1].default_value = 1.0
width, height = 768, 384
pixels = array("f")
panels = [
    (-2.45, .61, .92, .31, -.18, (2.04, 2.16, 2.24)),
    (-.83, .27, .71, .068, .16, (2.35, 2.31, 2.09)),
    (.54, .32, .49, .54, -.21, (1.13, 1.25, 1.39)),
    (2.61, -.21, .38, .34, .23, (1.03, .66, .40)),
    (1.68, -.73, 1.1, .23, .10, (.42, .50, .55)),
]
# The flags are unlit black cards between the rectangular strip lights.
flags = [(-.30,.02,.92,.19,-.19), (1.21,-.33,.80,.23,.32), (-2.45,-.45,1.20,.18,.22)]
for y in range(height):
    lat = ((y+.5)/height-.5)*math.pi
    for x in range(width):
        lon = ((x+.5)/width-.5)*2*math.pi
        wall = .095 + .10 * (1+math.sin(lat)) + .046*math.cos(lon-1.15)
        rgb = [wall*.90, wall, wall*1.05]
        for px, py, sx, sy, tilt in flags:
            dx = (lon-px+math.pi)%(2*math.pi)-math.pi
            edge = max(abs(dx)-sx,abs(lat-py-tilt*dx)-sy)
            amount = min(1,max(0,.5-edge/.09))
            rgb = [value*(1-.94*amount) for value in rgb]
        for px, py, sx, sy, tilt, color in panels:
            dx = (lon-px+math.pi)%(2*math.pi)-math.pi
            dy = lat-py-tilt*dx
            edge = max(abs(dx)-sx,abs(dy)-sy)
            weight = min(1,max(0,.5-edge/.04))
            if weight:
                for channel in range(3): rgb[channel] += color[channel]*weight
        pixels.extend((*rgb,1))
panorama = bpy.data.images.new("Cyclorama strip-light cards", width=width, height=height, float_buffer=True)
panorama.colorspace_settings.name = "Non-Color"
panorama.pixels.foreach_set(pixels)
nodes = scene.world.node_tree.nodes
links = scene.world.node_tree.links
environment = nodes.new("ShaderNodeTexEnvironment")
environment.image = panorama
links.new(environment.outputs["Color"], world.inputs[0])
camera_background = nodes.new("ShaderNodeBackground")
camera_background.inputs[0].default_value = (.0009,.0017,.0017,1)
lights = nodes.new("ShaderNodeLightPath")
mix = nodes.new("ShaderNodeMixShader")
links.new(lights.outputs["Is Camera Ray"],mix.inputs[0])
links.new(world.outputs[0],mix.inputs[1])
links.new(camera_background.outputs[0],mix.inputs[2])
links.new(mix.outputs[0],nodes.get("World Output").inputs["Surface"])


def lacquer(name, tint, metallic, roughness, coat=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    for key, value in {"Base Color": (*tint, 1), "Metallic": metallic, "Roughness": roughness,
                       "Coat Weight": coat, "Coat Roughness": 0.17}.items():
        shader.inputs[key].default_value = value
    # Combine a deterministic mirror of the studio map with a smaller true metal
    # pass for inter-ring reflections. This keeps shadowed faces steady across frames.
    tree = material.node_tree
    reflection = tree.nodes.new("ShaderNodeTexCoord")
    card = tree.nodes.new("ShaderNodeTexEnvironment")
    card.image = panorama
    tree.links.new(reflection.outputs["Reflection"], card.inputs["Vector"])
    coating = tree.nodes.new("ShaderNodeVectorMath")
    coating.operation = "MULTIPLY"
    coating.inputs[1].default_value = tint
    tree.links.new(card.outputs["Color"], coating.inputs[0])
    chrome = tree.nodes.new("ShaderNodeEmission")
    tree.links.new(coating.outputs[0], chrome.inputs["Color"])
    surface = tree.nodes.new("ShaderNodeMixShader")
    surface.inputs[0].default_value = 0.54
    tree.links.new(shader.outputs[0], surface.inputs[1])
    tree.links.new(chrome.outputs[0], surface.inputs[2])
    tree.links.new(surface.outputs[0], tree.nodes.get("Material Output").inputs["Surface"])
    return material


nickel = lacquer("Mirror nickel", (0.72, 0.75, 0.77), 1.0, 0.075)
steel = lacquer("Blue steel", (0.47, 0.58, 0.67), 1.0, 0.095)
champagne = lacquer("Champagne chrome", (0.81, 0.63, 0.42), 1.0, 0.080)
edge_metal = lacquer("Polished collar", (0.87, 0.90, 0.89), 1.0, 0.060)
lining = lacquer("Dark inner wall", (0.19, 0.23, 0.26), 1.0, 0.11)


def rounded_frame(index, finish, size):
    # Revolve a rounded rectangular cross-section around a superelliptic aperture.
    # A narrow material band at each shoulder catches the moving strip reflections.
    median = 0.83 * size
    half_band, half_depth = 0.145 * size, 0.057
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
    for mat in (finish, edge_metal, lining):
        geometry.materials.append(mat)
    for face in geometry.polygons:
        edge = face.index % width
        face.material_index = 1 if edge in (2, 17) else 2 if edge in (9, 10, 11) else 0
        face.use_smooth = True
    return obj


rings = []
for index in range(21):
    t = index / 20
    size = 0.73 + 0.36 * math.sin(t * math.pi) ** 0.75 + 0.07 * math.cos(t * 2 * math.pi)
    metal = champagne if index in (6, 7) else steel if index in (12, 13, 14, 15) else nickel
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


softbox("Overhead silk", (0.5, -1.4, 5.4), (1.0, 0.98, 0.92), 220, 7.4, 2.8)
softbox("Hard vertical strip", (-3.8, -3.5, 0.8), (0.80, 0.93, 1.0), 130, 6.8, 0.58)
softbox("Warm side card", (4.7, 1.1, 1.8), (1.0, 0.80, 0.63), 145, 3.0, 1.4)
softbox("Cool rear wall", (-1.6, 3.8, 2.5), (0.74, 0.89, 1.0), 195, 5.4, 2.0)
softbox("Low lens-side strip", (4.2, -4.5, -0.9), (0.96, 0.99, 1.0), 90, 5.4, 0.70)
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

if args.icon and not args.preview:
    # Optional Finder icon generation from the current finish.
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
