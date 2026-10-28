import type { Game } from '../core/Game';
import type { StuntEvent } from '../vehicles/Tricks';

/** A game mode plugs into the Game loop. The Game owns world, player, camera, HUD; modes own rules. */
export interface GameMode {
  readonly id: string;
  readonly title: string;
  enter(): void;
  exit(): void;
  /** Called every physics step before the world steps (drive AI sleds here). */
  prePhysics?(dt: number): void;
  /** Called every physics step after the player is simulated. */
  fixedUpdate(dt: number): void;
  /** Called every rendered frame. */
  update(dt: number): void;
  /** Player can drive (false during countdowns, results...). */
  readonly controlsEnabled: boolean;
  /** Every stunt event (landings, tricks, banked combos) for the player. */
  onStunt?(e: StuntEvent): void;
  /** Handle the recover key; return true if the mode handled it. */
  recover?(): boolean;
  /** Restart from the pause menu (omit if not restartable). */
  restart?(): void;
  /** Minimap overlay hook. */
  drawMap?(ctx: CanvasRenderingContext2D, toMap: (x: number, z: number) => [number, number]): void;
}

export type ModeFactory = (game: Game) => GameMode;
