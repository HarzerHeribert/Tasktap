#!/usr/bin/env python3
"""Point Fusion's El Torito catalog at Microsoft's no-keypress UEFI loader."""
from pathlib import Path
import struct
import subprocess
import sys

source, loader, output = map(Path, sys.argv[1:])
if output.exists():
    sys.exit("Output already exists")
subprocess.run(["cp", "-c", source, output], check=True)
with output.open("r+b") as iso:
    for sector in range(16, 32):
        iso.seek(sector * 2048)
        descriptor = iso.read(2048)
        if descriptor.startswith(b"\x00CD001\x01EL TORITO SPECIFICATION"):
            break
    else:
        sys.exit("El Torito boot record missing")
    catalog = struct.unpack_from("<I", descriptor, 71)[0] * 2048
    iso.seek(catalog)
    entry = bytearray(iso.read(64))
    if entry[30:33] != b"\x55\xaa\x88":
        sys.exit("Unexpected boot catalog")
    image = loader.read_bytes()
    end = iso.seek(0, 2)
    if end % 2048 or len(image) % 2048:
        sys.exit("Unaligned boot media")
    iso.write(image)
    entry[1] = 0xef  # EFI platform, no disk emulation
    entry[33] = 0
    struct.pack_into("<H", entry, 28, 0)
    struct.pack_into("<H", entry, 28, -sum(struct.unpack("<16H", entry[:32])) & 0xffff)
    struct.pack_into("<HI", entry, 38, len(image) // 512, end // 2048)
    iso.seek(catalog)
    iso.write(entry)
