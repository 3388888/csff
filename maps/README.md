# maps/

Everything needed to draw a map from above.

- `<map>.webp` — the radar image (WebP; roughly 40% smaller than the PNGs it replaced).
- `maps.json` — per-map calibration: world origin, scale and image size. This is what converts a
  player's in-game position into a pixel on the radar, so a wrong entry puts players in the sea.

Versioned maps (`de_nuke_2023`, `de_vertigo_2019`) fall back to their base map's art when they
have no entry of their own.
