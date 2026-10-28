import { Game } from './core/Game';

const app = document.getElementById('app')!;
const loader = document.getElementById('loader')!;
const bar = loader.querySelector('.bar span') as HTMLElement;
const msg = loader.querySelector('.msg') as HTMLElement;
const pct = loader.querySelector('.pct') as HTMLElement;

const game = new Game(
  app,
  (m, f) => {
    msg.textContent = m;
    bar.style.width = `${Math.round(f * 100)}%`;
    pct.innerHTML = `${Math.round(f * 100)}<small>%</small>`;
  },
  loader,
);

// start() swaps the progress bar for Play / Settings on the cover
game
  .init()
  .then(() => game.start())
  .catch((e) => {
    console.error(e);
    msg.textContent = `Failed to start: ${e?.message ?? e}`;
  });
