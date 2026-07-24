#!/usr/bin/env python
"""
Build the app's radar assets from a CS:GO install's overview files.

  python tools/build-radars.py "C:/.../csgo/resource/overviews"

For every <map>.txt + <map>_radar.dds it writes:
  maps/<map>.png            the radar image (PNG, canvas can render it)
  maps/maps.json            calibration: { "<map>": {pos_x, pos_y, scale, rotate, zoom, size} }
"""
import sys, os, re, json
from PIL import Image

def parse_txt(path):
    txt = open(path, "r", errors="ignore").read()
    def num(key):
        m = re.search(r'"%s"\s+"([-0-9.]+)"' % key, txt)
        return float(m.group(1)) if m else None
    return {
        "pos_x": num("pos_x"), "pos_y": num("pos_y"), "scale": num("scale"),
        "rotate": num("rotate") or 0, "zoom": num("zoom") or 0,
    }

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\w\Desktop\ClassicCounter\csgo\resource\overviews"
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "maps")
    os.makedirs(out_dir, exist_ok=True)

    cal = {}
    n = 0
    for f in os.listdir(src):
        if not f.endswith(".txt"):
            continue
        name = f[:-4]
        dds = os.path.join(src, name + "_radar.dds")
        if not os.path.exists(dds):
            continue
        meta = parse_txt(os.path.join(src, f))
        if meta["pos_x"] is None or meta["scale"] is None:
            continue
        try:
            im = Image.open(dds).convert("RGBA")
        except Exception as e:
            print("skip", name, e); continue
        meta["size"] = im.size[0]
        im.save(os.path.join(out_dir, name + ".png"))
        cal[name] = meta
        n += 1
        print("ok", name, im.size, meta["scale"])

    json.dump(cal, open(os.path.join(out_dir, "maps.json"), "w"), indent=2)
    print(f"\nWrote {n} radars + maps.json to {out_dir}")

if __name__ == "__main__":
    main()
