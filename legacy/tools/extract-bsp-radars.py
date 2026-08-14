#!/usr/bin/env python
"""
Extract radar overviews embedded in CS:GO map BSPs (the pakfile lump) and add
them to the app's maps/ folder. Handles .bsp and .bsp.bz2.

  python tools/extract-bsp-radars.py "C:/Users/w/Downloads/custom maps"

For each map that ships an overview it writes maps/<map>.png and merges the
calibration (pos_x/pos_y/scale) into maps/maps.json. Maps without an embedded
radar are skipped (the app falls back to the auto-fit 2D view for those).
"""
import sys, os, io, re, bz2, zipfile, json
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "maps")


def pakfile(bsp):
    base = 8 + 40 * 16  # LUMP_PAKFILE = 40
    ofs = int.from_bytes(bsp[base:base + 4], "little", signed=True)
    ln = int.from_bytes(bsp[base + 4:base + 8], "little", signed=True)
    return bsp[ofs:ofs + ln]


def parse_txt(txt):
    def num(k):
        m = re.search(r'"%s"\s+"([-0-9.]+)"' % k, txt)
        return float(m.group(1)) if m else None
    return {"pos_x": num("pos_x"), "pos_y": num("pos_y"), "scale": num("scale"),
            "rotate": num("rotate") or 0, "zoom": num("zoom") or 0}


def process(path, cal):
    name = re.sub(r"\.bsp(\.bz2)?$", "", os.path.basename(path), flags=re.I)
    data = open(path, "rb").read()
    if path.lower().endswith(".bz2"):
        try: data = bz2.decompress(data)
        except Exception as e: return ("err", name, str(e))
    if data[:4] != b"VBSP":
        return ("skip", name, "not VBSP")
    try:
        zf = zipfile.ZipFile(io.BytesIO(pakfile(data)))
    except Exception:
        return ("none", name, "no pakfile")
    entries = zf.namelist()
    low = name.lower()
    txt = dds = None
    for e in entries:
        el = e.lower()
        if el == f"resource/overviews/{low}.txt": txt = e
        if el == f"resource/overviews/{low}_radar.dds": dds = e
    if not txt or not dds:  # fallback: any non-spectate overview
        for e in entries:
            el = e.lower()
            if el.startswith("resource/overviews/") and el.endswith(".txt") and "spectate" not in el and not txt: txt = e
            if el.startswith("resource/overviews/") and el.endswith("_radar.dds") and "spectate" not in el and not dds: dds = e
    if not txt or not dds:
        return ("none", name, "no overview")
    meta = parse_txt(zf.read(txt).decode("utf-8", "ignore"))
    if meta["pos_x"] is None or meta["scale"] is None:
        return ("none", name, "bad txt")
    try:
        im = Image.open(io.BytesIO(zf.read(dds))).convert("RGBA")
    except Exception as e:
        return ("err", name, "dds: " + str(e))
    meta["size"] = im.size[0]
    im.save(os.path.join(OUT, name + ".png"))
    cal[name] = meta
    return ("ok", name, f"{im.size[0]}px scale {meta['scale']}")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\w\Downloads\custom maps"
    os.makedirs(OUT, exist_ok=True)
    cal_path = os.path.join(OUT, "maps.json")
    cal = json.load(open(cal_path)) if os.path.exists(cal_path) else {}
    before = len(cal)
    files = [f for f in os.listdir(src) if f.lower().endswith((".bsp", ".bsp.bz2"))]
    print(f"{len(files)} map files in {src}\n")
    added = 0
    for f in sorted(files):
        status, name, msg = process(os.path.join(src, f), cal)
        if status == "ok": added += 1
        print(f"  [{status:4}] {name}  {msg}")
    json.dump(cal, open(cal_path, "w"), indent=2)
    print(f"\nAdded {added} radars ({before} -> {len(cal)} total in maps.json)")


if __name__ == "__main__":
    main()
