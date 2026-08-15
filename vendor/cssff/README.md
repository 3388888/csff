# vendor/cssff/

`cssff_settings.ini` — the rulebook that decides what counts as a highlight.

Per weapon category it sets how fast a multi-kill has to be, how many headshots it needs, which
special kills (noscope, jumpshot, flick, wallbang) qualify, and the distances involved. The
parser reads this file directly, so editing it changes what the app finds — no rebuild.

Format is compatible with [cssff](https://github.com/kkthxbye-code/cssff).
