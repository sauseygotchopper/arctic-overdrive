# Arctic Overdrive

Browser snowmobile game — Three.js + Rapier + Vite + TypeScript.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build
```

## Controls
| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake (hold brake when stopped = reverse) | W / S | RT / LT |
| Steer (in the air: spin) | A / D | Left stick |
| Rider lean side / fore-aft (in the air: roll / flip) | Arrow keys | Right stick |
| Pop: hold to preload, release to jump | Space | A |
| Tricks: Superman / Heel Clicker / Seat Grab / Cliffhanger | J / K / L / I | X / Y / B / RB |
| Can-Can / Nac-Nac | J or K + A/D | X or Y + stick |
| Hitch / unhitch trailer | H | D-pad down |
| Cycle trailer test load | G | D-pad right |
| Camera (chase / far / hood) | C | Back |
| Time of day | T | D-pad up |
| Recover | R | LB |

### Tricks
Flips (backflip / front flip) and 360s are detected from the sled's real rotation; pose tricks are held
with a trick button and score more the longer you hold them. Get the rider back in the seat before
touchdown or it's a crash. Tricks chain into a combo (×1 per trick); a clean landing keeps the combo
open for 2 s so you can chain the next jump, a sketchy landing banks 75%, a crash loses it.
Heavier setups pop lower and rotate slower (air torques are fixed, inertia comes from mass).

### Handling & snow
Tuning for the arcade feel lives in `src/data/handling.json`: suspension damping (extra rebound
damping stops the rear bucking), slip curves (skis/track grip up to a peak slip angle then slide;
throttle or braking uses up the track's grip so the rear steps out), body position (lean into a
turn for bite, counter-lean to lose it; side lean steers by itself in powder; lean forward to load
the skis, back for traction and to keep the nose up), landing assist and the bog model (snow drag
fades near standstill so a heavy rig crawls instead of stopping; wheelspin digs the track in).

Every ski, track and trailer runner stamps a persistent rut into a GPU deformation texture
(0.25 m resolution on high quality) that the terrain shader shades as real grooves. A matching
packed-snow grid feeds back into physics: riding in an existing rut sinks less.

### Trailer
`H` hitches the Haulmaster utility trailer (spherical hitch joint + soft yaw/pitch/roll limits).
Cargo adds mass and raises the trailer's centre of gravity: slower acceleration, longer braking,
wider turns, deeper sinking in powder, swing-out on ice, jackknifes when braking hard while
turning, tip-overs on sidehills and bad landings (cargo spills; fragile items lose value on hard
landings and bottom-outs). Tricks are disabled while towing; small jumps still score airtime.
Upgrades (garage UI arrives in Phase 4; data in `src/data/trailers.json`):
heavy-duty shocks, wide powder skis, ratchet straps / cargo net. From the console:
`__game.setTrailerUpgrade('suspension', 'heavyDuty')`.

## Layout
- `src/core` — game loop (fixed 60 Hz physics + interpolated rendering), input, camera, save
- `src/physics` — Rapier world, terrain heightfield, surface definitions
- `src/vehicles` — sled spec → derived physics params, raycast sled physics, primitive model (`SledVisual` interface for GLTF swap)
- `src/world` — noise, terrain generation (heights + surface zones), terrain mesh, scenery, sky, effects
- `src/data` — all tunables: `surfaces.json`, `sleds.json`, `world.json` (incl. jumps), `tricks.json`, `handling.json`, `trailers.json`, `cargo.json`

## Debugging
- `__game.simulate(seconds, { throttle: 1, steer: 0.5 }, { jump: true })` — deterministic physics steps.
- `__dev.startTrail('loop', 'full')` then `__dev.drive(10, 50)` — autopilot along a trail (loads: none/empty/light/full), returns speed, trailer swing, cargo left and events.
