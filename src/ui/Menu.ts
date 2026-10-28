import type { Game } from '../core/Game';
import modesData from '../data/modes.json';
import freerideData from '../data/freeride.json';
import { COURSES, fmtTime } from '../modes/TimeTrial';
import { riderLevel } from '../core/Progression';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const medalIcon = (m: string | null | undefined) => (m ? `<span class="medal ${m}"></span>` : '');

/**
 * Main menu, mode select, course select and pause menu as plain DOM overlays.
 * (The visual polish pass and settings screen arrive in Phase 7.)
 */
export class Menu {
  readonly el: HTMLDivElement;
  readonly pauseEl: HTMLDivElement;
  private view: 'modes' | 'courses' = 'modes';

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'menu';
    this.pauseEl = document.createElement('div');
    this.pauseEl.className = 'pause';
    game.container.append(this.el, this.pauseEl);
    window.addEventListener('keydown', (e) => {
      if (!this.el.classList.contains('show')) return;
      if (e.code === 'Escape' && this.view === 'courses') { this.view = 'modes'; this.render(); }
    });
  }

  show() {
    this.view = 'modes';
    this.render();
    this.el.classList.add('show');
  }

  hide() {
    this.el.classList.remove('show');
  }

  get visible() {
    return this.el.classList.contains('show');
  }

  private render() {
    const g = this.game;
    const sd = g.save.data;
    const lvl = riderLevel(sd.xp);
    const goal = g.progression.goalProgress();
    // next-sled progress sits at the top of the menu
    const goalHtml = goal
      ? `<div class="m-goal" title="${goal.missing}"><div class="m-goal-h"><span>Next sled · T${goal.spec.tier} ${goal.spec.brand} ${goal.spec.model}</span><b>${goal.ready ? 'Ready to buy!' : `${Math.round(goal.frac * 100)}%`}</b></div><div class="m-goal-bar"><span style="width:${goal.frac * 100}%"></span></div><div class="m-goal-l">${goal.ready ? 'Head to the Dealership' : goal.missing}</div></div>`
      : '<div class="m-goal"><div class="m-goal-h"><span>Every sled in the stable is yours</span><b>100%</b></div><div class="m-goal-bar"><span style="width:100%"></span></div></div>';
    const head = `
      <div class="menu-side">
        <div class="logo">ARCTIC <em>OVERDRIVE</em></div>
        <div class="tag">Frostpine Valley · T${g.player.setup.spec.tier} ${g.player.setup.spec.brand} ${g.player.setup.spec.model}</div>
        <div class="wallet"><b>$${fmt(sd.currency)}</b><span>Lv ${lvl.level} · ${fmt(sd.xp)} XP</span></div>
        <div class="lvl"><span style="width:${(lvl.into / lvl.span) * 100}%"></span></div>
        <div class="side-btns">
          <button data-garage="upgrades">Garage</button>
          <button data-garage="dealer">Dealership</button>
        </div>
        <div class="menu-help">Mouse to choose · <b>Esc</b> back / pause in game</div>
      </div>`;
    if (this.view === 'modes') {
      const cards = modesData.modes.map((m) => {
        let best = '';
        if (m.id === 'freeride') best = `${sd.freeride.crystals.length}/${freerideData.collectibles.length} crystals · ${sd.freeride.viewpoints.length}/${freerideData.viewpoints.length} viewpoints`;
        if (m.id === 'timeTrial') {
          const medals = Object.values(sd.timeTrials).flatMap((r) => r.medals);
          best = `${medals.filter((x) => x === 'gold').length} gold · ${medals.filter((x) => x === 'silver').length} silver · ${medals.filter((x) => x === 'bronze').length} bronze`;
        }
        const reward = m.id === 'freeride'
          ? `$${modesData.freeride.collectible.currency} per crystal · ${modesData.freeride.trickSpotMultiplier}× trick spots`
          : m.id === 'timeTrial' ? `Up to $${modesData.timeTrial.medals.gold.currency + modesData.timeTrial.finish.currency} per course` : '';
        return `
          <button class="card ${m.available ? '' : 'locked'}" data-mode="${m.id}" ${m.available ? '' : 'disabled'}>
            <div class="card-name">${m.name}</div>
            <div class="card-tag">${m.tagline}</div>
            <div class="card-desc">${m.description}</div>
            ${m.available ? `<div class="card-best">${best}</div><div class="card-reward">${reward}</div>` : `<div class="card-soon">Coming in ${m.comingIn}</div>`}
          </button>`;
      }).join('');
      this.el.innerHTML = `${head}<div class="menu-main">${goalHtml}<div class="menu-title">Choose a mode</div><div class="cards">${cards}</div></div>`;
      this.bindSide();
      this.el.querySelectorAll<HTMLButtonElement>('.card[data-mode]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.mode!;
        if (id === 'timeTrial') { this.view = 'courses'; this.render(); }
        else g.startMode(id);
      }));
    } else {
      const rows = COURSES.map((c) => {
        const r = sd.timeTrials[c.id];
        const top = r?.medals.includes('gold') ? 'gold' : r?.medals.includes('silver') ? 'silver' : r?.medals.includes('bronze') ? 'bronze' : null;
        return `
          <button class="course" data-course="${c.id}">
            <div class="course-head"><div class="course-name">${c.name}</div>${medalIcon(top)}</div>
            <div class="course-desc">${c.description}</div>
            <div class="chips">${c.surfaces.map((s) => `<span>${s}</span>`).join('')}</div>
            <div class="course-times">
              <span>${medalIcon('gold')} ${fmtTime(c.medals.gold)}</span>
              <span>${medalIcon('silver')} ${fmtTime(c.medals.silver)}</span>
              <span>${medalIcon('bronze')} ${fmtTime(c.medals.bronze)}</span>
              <span class="pb">Best ${r?.best ? fmtTime(r.best) : '—'}</span>
            </div>
          </button>`;
      }).join('');
      this.el.innerHTML = `${head}<div class="menu-main">${goalHtml}<div class="menu-title"><button class="back">‹ Back</button>Time Trial</div><div class="courses">${rows}</div></div>`;
      this.bindSide();
      this.el.querySelector('.back')!.addEventListener('click', () => { this.view = 'modes'; this.render(); });
      this.el.querySelectorAll<HTMLButtonElement>('.course').forEach((b) => b.addEventListener('click', () => g.startMode('timeTrial', b.dataset.course)));
    }
  }

  private bindSide() {
    this.el.querySelectorAll<HTMLButtonElement>('[data-garage]').forEach((b) => b.addEventListener('click', () => this.game.openGarage(b.dataset.garage as 'upgrades' | 'dealer')));
  }

  // ---------- pause ----------

  showPause(title: string, canRestart: boolean) {
    this.pauseEl.innerHTML = `
      <div class="pause-card">
        <div class="pause-title">Paused</div>
        <div class="pause-sub">${title}</div>
        <button data-a="resume" class="primary">Resume</button>
        ${canRestart ? '<button data-a="restart">Restart</button>' : ''}
        <button data-a="menu">Quit to menu</button>
      </div>`;
    this.pauseEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'resume') this.game.setPaused(false);
      if (a === 'restart') { this.game.setPaused(false); this.game.mode?.restart?.(); }
      if (a === 'menu') this.game.toMenu();
    }));
    this.pauseEl.classList.add('show');
  }

  hidePause() {
    this.pauseEl.classList.remove('show');
  }
}
