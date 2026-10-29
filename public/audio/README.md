# Game audio

Drop real recordings here. Names and per-sound volume are set in `src/data/audio.json`.
Any file that's missing is silent, so add them one at a time.

Loops (should loop seamlessly):
- `engine_loop.ogg` – a snowmobile held at steady rpm (about 6000 rpm, or set `engineRecordedRpm`). The game pitches it to the live rpm.
- `snow_groomed.ogg`, `snow_powder.ogg`, `snow_crust.ogg`, `snow_ice.ogg`, `snow_slush.ogg`, `snow_moguls.ogg` – track/skis on each surface
- `wind_loop.ogg`, `siren_loop.ogg`, `helicopter_loop.ogg`

One-shots:
- `land.ogg`, `crash.ogg`, `trick.ogg`, `banked.ogg`
- `ui_click.ogg`, `ui_hover.ogg`, `ui_buy.ogg`, `ui_deny.ogg`
- `countdown.ogg`, `countdown_go.ogg`, `checkpoint.ogg`, `finish.ogg`, `pickup.ogg`
- `wanted.ogg`, `busted.ogg`, `tutorial_step.ogg`

Use recordings you made or ones whose licence allows use in your game (e.g. CC0).
