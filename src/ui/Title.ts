import type { Game } from '../core/Game';

/**
 * Title screen. The same overlay is the loading screen (static markup in index.html, so the cover art shows while the
 * game boots); once loaded the progress bar gives way to Play and Settings. Play reveals the mode menu underneath.
 */
export class Title {
  private shown = true;

  constructor(private root: HTMLElement, private game: Game) {
    root.querySelector('.ld-play')!.addEventListener('click', () => this.hide());
    root.querySelector('.ld-settings')!.addEventListener('click', () => game.openSettings(() => {}));
    window.addEventListener('keydown', (e) => {
      if (!this.shown || !this.root.classList.contains('ready') || game.settings.visible) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this.hide(); }
    });
  }

  /** The overlay is up (the world behind it is hidden, so rendering can pause). */
  get visible() {
    return this.shown;
  }

  /** Loading finished: show the buttons. */
  ready() {
    this.root.classList.add('ready');
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    // first launch goes straight into the tutorial
    if (!this.game.save.data.tutorialDone) this.game.startMode('tutorial');
    this.root.classList.add('done');
    setTimeout(() => this.root.remove(), 700);
  }
}
