# assets/

Killfeed artwork used by the highlight cards and the preview overlay.

- `weapons/` — one SVG per weapon, keyed by the weapon name the demo reports (`ak47`, `awp`, …).
- `modifiers/` — the small badges drawn before the weapon: headshot, noscope, wallbang,
  through-smoke, blind, in-air.

Icons are read at startup and inlined as data URIs, so nothing is fetched at runtime.
