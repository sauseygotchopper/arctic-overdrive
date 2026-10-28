# Arctic Overdrive

Browser snowmobile game — Three.js + Rapier + Vite + TypeScript.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build
```

## Controls (Phase 1)
| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake (hold brake when stopped = reverse) | W / S | RT / LT |
| Steer | A / D | Left stick |
| Rider lean (side / fore-aft, pitch in the air) | Arrow keys | Right stick |
| Camera (chase / far / hood) | C | Back |
| Time of day | T | D-pad up |
| Recover | R | LB |

## Layout
- `src/core` — game loop (fixed 60 Hz physics + interpolated rendering), input, camera, save
- `src/physics` — Rapier world, terrain heightfield, surface definitions
- `src/vehicles` — sled spec → derived physics params, raycast sled physics, primitive model (`SledVisual` interface for GLTF swap)
- `src/world` — noise, terrain generation (heights + surface zones), terrain mesh, scenery, sky, effects
- `src/data` — all tunables: `surfaces.json`, `sleds.json`, `world.json`

## Debugging
`window.__game.simulate(seconds, { throttle: 1, steer: 0.5 })` runs deterministic physics steps from the console and returns the sled physics state.
