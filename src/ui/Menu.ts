import type { Game } from '../core/Game';
import modesData from '../data/modes.json';
import freerideData from '../data/freeride.json';
import { COURSES, fmtTime } from '../modes/TimeTrial';
import { riderLevel } from '../core/Progression';
import { DELIVERY_JOBS, jobPoint } from '../modes/Delivery';
import { SNOCROSS_EVENTS } from '../modes/Snocross';
import { getSled, getPart } from '../vehicles/SledSpec';
import cargoData from '../data/cargo.json';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const medalIcon = (m: string | null | undefined) => (m ? `<span class="medal ${m}"></span>` : '');

/**
 * Main menu, mode select, course select and pause menu as plain DOM overlays.
 * (The visual polish pass and settings screen arrive in Phase 7.)
 */
export class Menu {
  readonly el: HTMLDivElement;
  readonly pauseEl: HTMLDivElement;
  private view: 'modes' | 'courses' | 'delivery' | 'snocross' = 'modes';

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'menu';
    this.pauseEl = document.createElement('div');
    this.pauseEl.className = 'pause';
    game.container.append(this.el, this.pauseEl);
    window.addEventListener('keydown', (e) => {
      if (!this.el.classList.contains('show')) return;
      if (e.code === 'Escape' && this.view !== 'modes') { this.view = 'modes'; this.render(); }
    });
  }

  show(view: 'courses' | 'delivery' | 'snocross' | 'modes' = 'modes') {
    this.view = view;
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
        if (m.id === 'delivery') best = `${sd.delivery.completed} deliveries completed`;
        if (m.id === 'snocross') {
          const r = Object.values(sd.snocross);
          best = `${r.reduce((a, x) => a + x.wins, 0)} wins · ${r.reduce((a, x) => a + x.podiums, 0)} podiums`;
        }
        if (m.id === 'timeTrial') {
          const medals = Object.values(sd.timeTrials).flatMap((r) => r.medals);
          best = `${medals.filter((x) => x === 'gold').length} gold · ${medals.filter((x) => x === 'silver').length} silver · ${medals.filter((x) => x === 'bronze').length} bronze`;
        }
        const reward = m.id === 'freeride'
          ? `$${modesData.freeride.collectible.currency} per crystal · ${modesData.freeride.trickSpotMultiplier}× trick spots`
          : m.id === 'timeTrial' ? `Up to $${modesData.timeTrial.medals.gold.currency + modesData.timeTrial.finish.currency} per course`
          : m.id === 'delivery' ? `$${Math.min(...DELIVERY_JOBS.map((j) => j.pay))}–${Math.max(...DELIVERY_JOBS.map((j) => j.pay)).toLocaleString('en-US')} per job + time bonus`
          : m.id === 'snocross' ? `Up to $${Math.max(...SNOCROSS_EVENTS.map((e) => e.rewards[0])).toLocaleString('en-US')} for a win` : '';
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
        else if (id === 'delivery' || id === 'snocross') { this.view = id; this.render(); }
        else g.startMode(id);
      }));
    } else if (this.view === 'delivery') {
      this.renderJobs(head, goalHtml);
    } else if (this.view === 'snocross') {
      this.renderEvents(head, goalHtml);
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

  private renderJobs(head: string, goalHtml: string) {
    const g = this.game;
    const sd = g.save.data;
    const tier = getSled(sd.currentSled).tier;
    const hitch = g.progression.canTow(sd.currentSled);
    const types = cargoData.types as Record<string, { name: string; massKg: number; fragile: boolean }>;
    const rows = DELIVERY_JOBS.map((j) => {
      const a = jobPoint(g, j.from), b = jobPoint(g, j.to);
      const km = Math.hypot(a.x - b.x, a.z - b.z) / 1000;
      const counts: Record<string, number> = {};
      for (const c of j.cargo) counts[c] = (counts[c] ?? 0) + 1;
      const mass = j.cargo.reduce((m, c) => m + types[c].massKg, 0);
      const fragile = j.cargo.some((c) => types[c].fragile);
      const needHitch = j.carry === 'trailer' && !hitch;
      const lockedTier = tier < j.tier;
      const rec = sd.delivery.jobs[j.id];
      const locked = needHitch || lockedTier;
      return `
        <button class="course ${locked ? 'locked' : ''}" data-job="${j.id}" ${locked ? 'disabled' : ''}>
          <div class="course-head"><div class="course-name">${j.name}</div><span class="pay">$${fmt(j.pay)}</span></div>
          <div class="course-desc">${a.name} → ${b.name} · ${km.toFixed(1)} km · ${fmtTime(j.timeLimit)} limit</div>
          <div class="course-desc">${j.brief}</div>
          <div class="chips">${Object.entries(counts).map(([c, n]) => `<span>${n}× ${types[c].name}</span>`).join('')}<span>${Math.round(mass)} kg</span><span>${j.carry === 'trailer' ? 'Trailer' : 'Rear rack'}</span>${fragile ? '<span class="frag">Fragile</span>' : ''}</div>
          <div class="course-times">${locked ? `<span class="lockmsg">${needHitch ? `Needs a tow hitch (${getPart('hitch-ball')!.name}, Garage › Upgrades › Towing)` : `Needs a tier ${j.tier}+ sled`}</span>` : ''}
            <span class="pb">${rec ? `Done ${rec.done}× · best $${fmt(rec.bestPay)}${rec.bestTime ? ` · ${fmtTime(rec.bestTime)}` : ''}` : 'Not done yet'}</span></div>
        </button>`;
    }).join('');
    this.el.innerHTML = `${head}<div class="menu-main">${goalHtml}<div class="menu-title"><button class="back">‹ Back</button>Delivery jobs</div><div class="courses">${rows}</div></div>`;
    this.bindSide();
    this.el.querySelector('.back')!.addEventListener('click', () => { this.view = 'modes'; this.render(); });
    this.el.querySelectorAll<HTMLButtonElement>('[data-job]').forEach((b) => b.addEventListener('click', () => g.startMode('delivery', b.dataset.job)));
  }

  private renderEvents(head: string, goalHtml: string) {
    const g = this.game;
    const sd = g.save.data;
    const tier = getSled(sd.currentSled).tier;
    const rows = SNOCROSS_EVENTS.map((e) => {
      const rec = sd.snocross[e.id];
      const locked = tier < e.tier;
      const ai = getSled(e.aiSled);
      const best = rec ? (rec.best === 1 ? 'gold' : rec.best === 2 ? 'silver' : rec.best === 3 ? 'bronze' : null) : null;
      return `
        <button class="course ${locked ? 'locked' : ''}" data-event="${e.id}" ${locked ? 'disabled' : ''}>
          <div class="course-head"><div class="course-name">${e.name}</div>${medalIcon(best)}</div>
          <div class="course-desc">Tier ${e.tier} · ${e.laps} laps · 5 rivals on ${ai.brand} ${ai.model}</div>
          <div class="chips"><span>1st $${fmt(e.rewards[0])}</span><span>2nd $${fmt(e.rewards[1])}</span><span>3rd $${fmt(e.rewards[2])}</span></div>
          <div class="course-times">${locked ? `<span class="lockmsg">Needs a tier ${e.tier}+ sled</span>` : ''}<span class="pb">${rec ? `Best ${['', '1st', '2nd', '3rd', '4th', '5th', '6th'][rec.best]} · ${rec.wins} win${rec.wins === 1 ? '' : 's'} in ${rec.races}` : 'Not raced yet'}</span></div>
        </button>`;
    }).join('');
    this.el.innerHTML = `${head}<div class="menu-main">${goalHtml}<div class="menu-title"><button class="back">‹ Back</button>Snocross · Frostpine Arena</div><div class="courses">${rows}</div></div>`;
    this.bindSide();
    this.el.querySelector('.back')!.addEventListener('click', () => { this.view = 'modes'; this.render(); });
    this.el.querySelectorAll<HTMLButtonElement>('[data-event]').forEach((b) => b.addEventListener('click', () => g.startMode('snocross', b.dataset.event)));
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
