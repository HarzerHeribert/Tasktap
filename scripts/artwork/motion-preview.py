"""Export the labeled four-study comparison from the shipped H.264 loops. Requires Pillow and ffmpeg."""
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[2]
output = root / "design"
assets = root / "prototype/assets/motion"
studies = [
    ("glyph", "Glyph wave", "ASCII"),
    ("phase", "Phase field", "SHADER"),
    ("relay", "Relay", "ABSTRACT"),
    ("orbit", "Signal globe", "TECHNICAL ORB"),
]
width, height = 1152, 736
margin, gap, top = 26, 14, 76
card_width, card_height, film_height = 543, 307, 259
paper, edge = "#101717", "#2c3836"


def font(size, mono=False):
    candidates = ("/System/Library/Fonts/Menlo.ttc", "DejaVuSansMono.ttf") if mono else (
        "/System/Library/Fonts/HelveticaNeue.ttc", "DejaVuSans.ttf")
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


with tempfile.TemporaryDirectory() as scratch:
    scratch = Path(scratch)
    board = Image.new("RGB", (width, height), paper)
    draw = ImageDraw.Draw(board)
    draw.text((margin, 16), "Tasktap", font=font(31), fill="#f1f2e9")
    draw.text((width-margin, 32), "ACTIVITY STUDIES", font=font(13, True), fill="#b5c5bb", anchor="rm")
    inputs, chain, sources = [], [], []
    for i, (ident, label, medium) in enumerate(studies):
        x = margin + (i % 2) * (card_width + gap)
        y = top + (i // 2) * (card_height + gap)
        draw.rectangle((x-1, y-1, x+card_width, y+card_height), fill=edge)
        draw.rectangle((x, y, x+card_width-1, y+card_height-1), fill="#18201f")
        draw.text((x+16, y+film_height+22), label, font=font(22), fill="#edf0e7", anchor="lm")
        draw.text((x+card_width-15, y+film_height+22), medium, font=font(12, True), fill="#c0d0c5", anchor="rm")
        inputs.extend(["-i", str(assets / ident / "stage.mp4")])
        chain.append(f"[{i+1}:v]scale={card_width+1}:{film_height+1},crop={card_width}:{film_height}:exact=1[film{i}]")
        previous = f"[card{i-1}]" if i else "[0:v]"
        chain.append(f"{previous}[film{i}]overlay={x}:{y}:shortest=1[card{i}]")
        sources.append((x, y, ident))
    board.save(scratch / "board.png")
    for x, y, ident in sources:
        with Image.open(assets / ident / "stage.jpg") as poster:
            board.paste(poster.resize((card_width, film_height), Image.Resampling.LANCZOS), (x, y))
    board.save(output / "motion-studies.jpg", quality=92, optimize=True)
    subprocess.run(["ffmpeg","-y","-loglevel","error","-framerate","24","-loop","1","-i",str(scratch / "board.png"),
                    *inputs,"-filter_complex",";".join(chain),"-map","[card3]","-t","4","-an",
                    "-c:v","libx264","-profile:v","main","-pix_fmt","yuv420p","-crf","21","-preset","slow",
                    "-movflags","+faststart",str(output / "motion-studies.mp4")], check=True)
