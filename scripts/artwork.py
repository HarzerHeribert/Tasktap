"""Generate deterministic desktop and waveform artwork. Uses the Python standard library."""
import math
import pathlib
import random
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1] / "prototype" / "assets"
def write_png(path, width, height, rows):
    def chunk(tag, payload):
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(b"\0" + r for r in rows), 9)) + chunk(b"IEND", b""))

def landscape():
    w,h=1440,960
    rng=random.Random(79)
    rows=[bytearray(w*3) for _ in range(h)]
    palettes=[(119,144,151),(99,127,139),(75,105,119),(53,84,98),(36,66,79),(23,48,61),(18,39,52)]
    for x in range(w):
        t=x/w
        edges=[int(h*(.16+.115*j+.115*math.sin(t*5.2+j*.71)+.068*math.sin(t*10.7+j*.67)+.023*math.sin(t*20+j*.35))) for j in range(7)]
        for y in range(h):
            layer=next((j for j in reversed(range(7)) if y>=edges[j]),-1)
            if layer==-1:
                glow=1-min(1,abs(t-.22)*1.3+y/h*.7)
                color=tuple(a+glow*b for a,b in zip((100,131,146),(70,47,37)))
            else:
                dist=y-edges[layer]
                contour=math.exp(-((dist%10.5)/1.2)**2)*9
                color=tuple(c+16*math.exp(-dist/36)+contour for c in palettes[layer])
            grain=rng.uniform(-1.7,1.7)
            rows[y][x*3:x*3+3]=bytes(int(max(0,min(255,c+grain))) for c in color)
    write_png(ROOT/"desktop.png",w,h,rows)

if __name__=="__main__":
    landscape()
