"""Enforce named spacing, font-size and radius tokens in prototype CSS; zero and geometry are exempt."""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[1]
css = "\n".join(path.read_text() for path in sorted((root / "prototype").glob("*.css")))
css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
issues = []
for match in re.finditer(r"(?:^|[;{])\s*((?:margin|padding)(?:-[\w-]+)?|(?:row-|column-)?gap|font-size|border(?:-[\w-]+)?-radius)\s*:\s*([^;}]+)",css):
    prop, value = match.groups()
    simple = re.sub(r"var\(--[\w-]+\)|(?:calc|clamp|min|max)\([^;{}]+\)", "", value)
    if re.search(r"(?<![\w.-])[1-9][\d.]*(px|rem|em|vh|vw|%)", simple):
        issues.append((prop,value))
if issues:
    for issue in issues: print(*issue, sep=" → ")
    sys.exit(1)
print("Token lint passed.")
