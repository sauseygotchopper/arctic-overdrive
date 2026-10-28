import './ui/styles.css';
import { Game } from './core/Game';

const app = document.getElementById('app')!;
const loader = document.getElementById('loader')!;
const bar = loader.querySelector('.bar span') as HTMLElement;
const msg = loader.querySelector('.msg') as HTMLElement;

const game = new Game(app, (m, f) => {
  msg.textContent = m;
  bar.style.width = `${Math.round(f * 100)}%`;
});

game
  .init()
  .then(() => {
    loader.classList.add('done');
    setTimeout(() => loader.remove(), 700);
    game.start();
  })
  .catch((e) => {
    console.error(e);
    msg.textContent = `Failed to start: ${e?.message ?? e}`;
  });
