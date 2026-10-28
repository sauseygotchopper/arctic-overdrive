import type { Game } from '../core/Game';
import { riderLevel } from '../core/Progression';
import {
  SLEDS, PART_CATEGORIES, SLOT_NAMES, PARTS, COSMETICS, TUNING_DEFS, DEFAULT_TUNING,
  getSled, getPart, partFits, displayStats, SledSetup, StatLine, Tuning,
} from '../vehicles/SledSpec';
import trailerData from '../data/trailers.json';

type Tab = 'dealer' | 'upgrades';
type Section = 'engine' | 'drivetrain' | 'track' | 'suspension' | 'skis' | 'weight' | 'towing' | 'style';
const SECTIONS: [Section, string][] = [
  ['engine', 'Engine'], ['drivetrain', 'Drivetrain'], ['track', 'Track'], ['suspension', 'Suspension'],
  ['skis', 'Skis'], ['weight', 'Weight'], ['towing', 'Towing'], ['style', 'Paint & Gear'],
];
type Preview =
  | { kind: 'part'; id: string }
  | { kind: 'stock'; slot: string }
  | { kind: 'cosmetic'; id: string; cosmeticKind: 'paint' | 'wrap' | 'gear' };

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Garage screen over the 3D showroom: Dealership (buy/select sleds) and Upgrades (parts by section,
 * free suspension/drivetrain tuning, towing, paint & gear). Every change previews live with a
 * before/after stat comparison before anything is spent.
 */
export class Garage {
  readonly el: HTMLDivElement;
  private tab: Tab = 'upgrades';
  private section: Section = 'engine';
  private dealerPick = '';
  private preview: Preview | null = null;
  private tuning: Tuning | null = null; // unsaved slider values
  private msg = '';
  private msgTimer = 0;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'garage';
    game.container.appendChild(this.el);
    window.addEventListener('keydown', (e) => {
      if (this.el.classList.contains('show') && e.code === 'Escape') { e.stopImmediatePropagation(); this.game.closeGarage(); }
    }, true);
  }

  private get prog() { return this.game.progression; }
  private get sledId() { return this.game.save.data.currentSled; }

  open(tab: Tab, section: Section = this.section) {
    this.tab = tab;
    this.section = section;
    this.dealerPick = this.sledId;
    this.preview = null;
    this.tuning = null;
    this.render();
    this.el.classList.add('show');
    this.updateModel();
  }

  close() {
    this.el.classList.remove('show');
  }

  update(dt: number) {
    if (this.msgTimer > 0 && (this.msgTimer -= dt) <= 0) this.el.querySelector('.g-msg')?.classList.remove('show');
  }

  private flash(text: string) {
    this.msg = text;
    this.msgTimer = 2.4;
  }

  // ---------- setups ----------

  private savedTuning(): Tuning {
    return { ...DEFAULT_TUNING, ...this.prog.garage(this.sledId).tuning };
  }

  private baseSetup(): SledSetup {
    return this.prog.setupFor(this.sledId);
  }

  private candidateSetup(): SledSetup {
    if (this.tab === 'dealer') {
      const id = this.dealerPick || this.sledId;
      return this.prog.owns(id) ? this.prog.setupFor(id) : { ...this.prog.setupFor(id), parts: [], tuning: { ...DEFAULT_TUNING } };
    }
    const tuning = this.tuning ?? undefined;
    const pv = this.preview;
    if (pv?.kind === 'part') return this.prog.setupFor(this.sledId, [pv.id], undefined, 0, tuning);
    const base = this.prog.setupFor(this.sledId, [], undefined, 0, tuning);
    if (pv?.kind === 'stock') {
      const installed = { ...this.prog.garage(this.sledId).installed };
      delete installed[pv.slot];
      return { ...base, parts: Object.values(installed) };
    }
    if (pv?.kind === 'cosmetic') return { ...base, livery: { ...base.livery!, [pv.cosmeticKind]: pv.id } };
    return base;
  }

  private updateModel() {
    this.game.showroom.show(this.candidateSetup());
  }

  // ---------- render ----------

  private render() {
    const sd = this.game.save.data;
    const lvl = riderLevel(sd.xp);
    const spec = getSled(this.tab === 'dealer' ? this.dealerPick || this.sledId : this.sledId);
    const goal = this.prog.goalProgress();
    const goalHtml = goal
      ? `<div class="g-goal" title="${esc(goal.missing)}"><div class="g-goal-h"><span>Next sled · T${goal.spec.tier} ${esc(goal.spec.model)}</span><b>${goal.ready ? 'Ready!' : `${Math.round(goal.frac * 100)}%`}</b></div><div class="g-goal-bar"><span style="width:${goal.frac * 100}%"></span></div><div class="g-goal-l">${goal.ready ? 'Buy it in the Dealership' : esc(goal.missing)}</div></div>`
      : '<div class="g-goal"><div class="g-goal-h"><span>Full stable</span><b>100%</b></div><div class="g-goal-bar"><span style="width:100%"></span></div></div>';
    this.el.innerHTML = `
      <div class="g-top">
        <button class="g-back">‹ Menu</button>
        <div class="g-tabs">
          <button data-tab="dealer" class="${this.tab === 'dealer' ? 'on' : ''}">Dealership</button>
          <button data-tab="upgrades" class="${this.tab === 'upgrades' ? 'on' : ''}">Upgrades</button>
        </div>
        ${goalHtml}
        <div class="g-wallet"><b>$${fmt(sd.currency)}</b><span>Lv ${lvl.level} · ${fmt(sd.xp)} XP</span></div>
      </div>
      <div class="g-body">
        <div class="g-left">
          ${this.tab === 'upgrades' ? `<div class="g-sections">${SECTIONS.map(([id, n]) => `<button data-section="${id}" class="${id === this.section ? 'on' : ''}">${n}</button>`).join('')}</div>` : ''}
          <div class="g-list">${this.tab === 'dealer' ? this.dealerHtml() : this.sectionHtml()}</div>
        </div>
        <div class="g-center"><div class="g-title"><span class="tier">T${spec.tier}</span>${esc(spec.brand)} <b>${esc(spec.model)}</b><div class="g-class">${esc(spec.class)} · ${esc(spec.reference)}</div></div></div>
        <div class="g-stats"></div>
      </div>
      <div class="g-msg ${this.msgTimer > 0 ? 'show' : ''}">${esc(this.msg)}</div>`;
    this.el.querySelector('.g-back')!.addEventListener('click', () => this.game.closeGarage());
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      this.tab = b.dataset.tab as Tab;
      this.reset();
    }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((b) => b.addEventListener('click', () => {
      this.section = b.dataset.section as Section;
      this.reset();
    }));
    this.bindList();
    this.renderStats();
  }

  private reset() {
    this.preview = null;
    this.tuning = null;
    this.dealerPick = this.sledId;
    this.render();
    this.updateModel();
  }

  private renderStats() {
    const el = this.el.querySelector('.g-stats') as HTMLElement;
    el.innerHTML = this.statsHtml();
    el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act!)));
  }

  private statsHtml(): string {
    const before = displayStats(this.baseSetup());
    const after = displayStats(this.candidateSetup());
    const changed = this.tab === 'dealer' ? this.dealerPick !== this.sledId : (!!this.preview && this.preview.kind !== 'cosmetic') || !!this.tuning;
    const rows = after.map((a: StatLine, i: number) => {
      const b = before[i];
      const d = a.bar - b.bar;
      const lo = Math.min(a.bar, b.bar), hi = Math.max(a.bar, b.bar);
      const moved = changed && Math.abs(d) > 0.004;
      const valueChanged = changed && a.value !== b.value;
      return `
        <div class="stat">
          <div class="stat-h"><span>${a.label}</span><span class="${valueChanged ? (d >= 0 ? 'up' : 'down') : ''}">${valueChanged ? `${b.value} → ` : ''}${a.value}</span></div>
          <div class="bar"><span class="fill" style="width:${(moved ? lo : a.bar) * 100}%"></span>${moved ? `<span class="delta ${d > 0 ? 'up' : 'down'}" style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></span>` : ''}</div>
        </div>`;
    }).join('');
    const head = this.tab === 'dealer' && this.dealerPick !== this.sledId
      ? `<div class="g-h">Compared with your ${esc(getSled(this.sledId).model)}</div>`
      : `<div class="g-h">${this.tuning ? 'Tuning preview' : 'Stats'}</div>`;
    return head + rows + this.actionHtml();
  }

  private actionHtml(): string {
    const sd = this.game.save.data;
    if (this.tab === 'dealer') {
      const spec = getSled(this.dealerPick || this.sledId);
      if (this.prog.owns(spec.id)) {
        return spec.id === this.sledId ? '<button class="g-act" disabled>Current sled</button>' : '<button class="g-act primary" data-act="select">Ride this sled</button>';
      }
      const reqs = this.prog.requirements(spec);
      const ok = this.prog.unlocked(spec);
      const reqHtml = reqs.length ? `<div class="reqs">${reqs.map((r) => `<div class="${r.have >= r.need ? 'met' : ''}"><span>${r.label}</span><span>${fmt(Math.min(r.have, r.need))}/${fmt(r.need)}</span></div>`).join('')}</div>` : '';
      return `${reqHtml}<button class="g-act primary" data-act="buySled" ${ok && sd.currency >= spec.price ? '' : 'disabled'}>${ok ? `Buy · $${fmt(spec.price)}` : 'Locked'}</button>`;
    }
    if (this.tuning) {
      return '<div class="g-hint">Tuning is free. Save it to ride with it.</div><button class="g-act primary" data-act="saveTuning">Save tuning</button><button class="g-act" data-act="discardTuning">Discard changes</button>';
    }
    const pv = this.preview;
    if (!pv) return '<div class="g-hint">Pick a part to preview it, or move a tuning slider.</div>';
    if (pv.kind === 'stock') return `<button class="g-act" data-act="remove">Refit stock ${esc(SLOT_NAMES[pv.slot] ?? '')}</button>`;
    if (pv.kind === 'part') {
      const p = getPart(pv.id)!;
      const g = this.prog.garage(this.sledId);
      const owned = g.parts.includes(p.id);
      if (!partFits(p, getSled(this.sledId))) return `<div class="g-desc">${esc(p.desc)}</div><button class="g-act" disabled>Needs a tier ${p.tier}+ sled</button>`;
      if (g.installed[p.slot] === p.id) return `<div class="g-desc">${esc(p.desc)}</div><button class="g-act" disabled>Installed</button>`;
      return `<div class="g-desc">${esc(p.desc)}</div><button class="g-act primary" data-act="buyPart" ${owned || sd.currency >= p.price ? '' : 'disabled'}>${owned ? 'Install' : `Buy & install · $${fmt(p.price)}`}</button>`;
    }
    const list = pv.cosmeticKind === 'paint' ? COSMETICS.paints : pv.cosmeticKind === 'wrap' ? COSMETICS.wraps : COSMETICS.gear;
    const item = list.find((x) => x.id === pv.id) as { price: number; minTier?: number };
    const g = this.prog.garage(this.sledId);
    const owned = item.price === 0 || g.cosmetics.includes(`${pv.cosmeticKind}:${pv.id}`);
    if (g.livery[pv.cosmeticKind] === pv.id) return '<button class="g-act" disabled>Applied</button>';
    if (item.minTier && getSled(this.sledId).tier < item.minTier) return '<button class="g-act" disabled>Turbo Build only</button>';
    return `<button class="g-act primary" data-act="buyCosmetic" ${owned || sd.currency >= item.price ? '' : 'disabled'}>${owned ? 'Apply' : `Buy & apply · $${fmt(item.price)}`}</button>`;
  }

  // ---------- lists ----------

  private dealerHtml(): string {
    return SLEDS.map((s) => {
      const owned = this.prog.owns(s.id);
      const status = s.id === this.sledId ? 'Riding' : owned ? 'Owned' : this.prog.unlocked(s) ? `$${fmt(s.price)}` : 'Locked';
      return `<button class="item sled ${s.id === this.dealerPick ? 'sel' : ''} ${!owned && !this.prog.unlocked(s) ? 'locked' : ''}" data-sled="${s.id}">
        <span class="tier">T${s.tier}</span><span class="nm"><b>${esc(s.brand)} ${esc(s.model)}</b><small>${esc(s.class)}</small></span><span class="st">${status}</span></button>`;
    }).join('');
  }

  private slotsHtml(slots: string[]): string {
    const g = this.prog.garage(this.sledId);
    const spec = getSled(this.sledId);
    return slots.map((slot) => {
      const fitted = g.installed[slot];
      const isSel = (pv: Preview | null, match: (p: Preview) => boolean) => (pv && match(pv) ? 'sel' : '');
      return `<div class="slot"><div class="slot-n">${esc(SLOT_NAMES[slot])}</div>
        <button class="item part ${!fitted ? 'fitted' : ''} ${isSel(this.preview, (p) => p.kind === 'stock' && p.slot === slot)}" data-stock="${slot}"><span class="nm">${slot === 'hitch' ? 'None' : 'Stock'}</span><span class="st">${!fitted ? '✓' : ''}</span></button>
        ${PARTS.filter((p) => p.slot === slot).map((p) => {
          const fits = partFits(p, spec);
          const st = fitted === p.id ? '✓' : g.parts.includes(p.id) ? 'Owned' : fits ? `$${fmt(p.price)}` : `T${p.tier}+`;
          return `<button class="item part ${fitted === p.id ? 'fitted' : ''} ${fits ? '' : 'locked'} ${isSel(this.preview, (x) => x.kind === 'part' && x.id === p.id)}" data-part="${p.id}"><span class="nm">${esc(p.name)}</span><span class="st">${st}</span></button>`;
        }).join('')}</div>`;
    }).join('');
  }

  private tuningHtml(section: Section): string {
    const defs = TUNING_DEFS.filter((t) => t.section === section);
    if (!defs.length) return '';
    const t = this.tuning ?? this.savedTuning();
    return `<div class="cat">Tuning <small>free</small></div>
      ${defs.map((d) => `
        <div class="tune">
          <div class="tune-h"><span>${esc(d.name)}</span><b data-val="${d.id}">${t[d.id] > 0 ? '+' : ''}${t[d.id]}${d.unit}</b></div>
          <input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${t[d.id]}" data-tune="${d.id}">
          <div class="tune-ends"><span>${esc(d.lo)}</span><span>${esc(d.hi)}</span></div>
          <div class="tune-d">${esc(d.desc)}</div>
        </div>`).join('')}
      <button class="item reset-tune" data-reset-tune="${section}"><span class="nm">Reset ${section} tuning to factory</span></button>`;
  }

  private sectionHtml(): string {
    const sec = this.section;
    if (sec === 'style') return this.styleHtml();
    const cat = PART_CATEGORIES.find((c) => c.id === sec);
    let html = cat ? this.slotsHtml(cat.slots) : '';
    if (sec === 'suspension' || sec === 'drivetrain') html += this.tuningHtml(sec);
    if (sec === 'towing') html += this.trailerHtml();
    return html;
  }

  private styleHtml(): string {
    const g = this.prog.garage(this.sledId);
    const spec = getSled(this.sledId);
    const sw = (kind: 'paint' | 'wrap' | 'gear', items: { id: string; name: string; price: number; minTier?: number; body?: string; suit?: string; accent?: string }[]) => items.map((x) => {
      const owned = x.price === 0 || g.cosmetics.includes(`${kind}:${x.id}`);
      const on = g.livery[kind] === x.id;
      const locked = x.minTier && spec.tier < x.minTier;
      const chip = x.body ?? x.suit ?? spec.colors.body;
      const sel = this.preview?.kind === 'cosmetic' && this.preview.cosmeticKind === kind && this.preview.id === x.id ? 'sel' : '';
      return `<button class="item cos ${on ? 'fitted' : ''} ${locked ? 'locked' : ''} ${sel}" data-cos="${kind}" data-id="${x.id}">
        <span class="chip" style="background:${kind === 'wrap' ? 'repeating-linear-gradient(45deg,#ffffff22 0 6px,transparent 6px 12px),' : ''}linear-gradient(135deg, ${chip} 55%, ${x.accent ?? spec.colors.accent} 55%)"></span>
        <span class="nm">${esc(x.name)}</span><span class="st">${on ? '✓' : owned ? '' : locked ? 'T5' : `$${fmt(x.price)}`}</span></button>`;
    }).join('');
    return `<div class="cat">Paint</div>${sw('paint', COSMETICS.paints)}
      <div class="cat">Wrap</div>${sw('wrap', COSMETICS.wraps)}
      <div class="cat">Rider gear</div>${sw('gear', COSMETICS.gear)}
      <div class="cat">Race number</div>
      <div class="num"><button data-num="-1">−</button><b>${g.livery.number}</b><button data-num="1">+</button></div>`;
  }

  private trailerHtml(): string {
    const hasHitch = this.prog.canTow(this.sledId);
    const t = this.game.save.data.trailer;
    const U = trailerData.upgrades;
    const row = (slot: 'suspension' | 'skis' | 'tieDowns', title: string, describe: (x: Record<string, number | string>) => string) => `
      <div class="slot-n">${title}</div>
      ${(U[slot] as unknown as Record<string, number | string>[]).map((x) => {
        const on = t.upgrades[slot] === x.id;
        const owned = x.price === 0 || t.ownedParts.includes(`${slot}:${x.id}`);
        return `<button class="item part ${on ? 'fitted' : ''} ${hasHitch ? '' : 'locked'}" data-tslot="${slot}" data-id="${x.id}" ${hasHitch ? '' : 'disabled'}><span class="nm">${esc(String(x.name))}<small>${describe(x)}</small></span><span class="st">${on ? '✓' : owned ? 'Owned' : `$${fmt(Number(x.price))}`}</span></button>`;
      }).join('')}`;
    return `<div class="cat">Trailer · ${esc(trailerData.base.name)}</div>
      <div class="g-note">${hasHitch ? 'Hitch up in Freeride with <b>H</b>. Trailer upgrades apply the next time you hitch.' : 'Fit a tow hitch above to tow the trailer and upgrade it.'}</div>
      ${row('suspension', 'Trailer suspension', (x) => `${Math.round(Number(x.travel) * 100)} cm travel · ${x.stiffness}× springs`)}
      ${row('skis', 'Trailer skis', (x) => `${Math.round(Number(x.width) * 100)} cm wide · ${x.lateralGrip}× bite`)}
      ${row('tieDowns', 'Tie-downs', (x) => `${Math.round(Number(x.spillChance) * 100)}% spill risk · ${x.damageMult}× damage`)}`;
  }

  private bindList() {
    const q = <T extends HTMLElement>(s: string) => [...this.el.querySelectorAll<T>(s)];
    const rerender = (model = true) => { this.render(); if (model) this.updateModel(); };
    q<HTMLButtonElement>('[data-sled]').forEach((b) => b.addEventListener('click', () => { this.dealerPick = b.dataset.sled!; rerender(); }));
    q<HTMLButtonElement>('[data-part]').forEach((b) => b.addEventListener('click', () => { this.tuning = null; this.preview = { kind: 'part', id: b.dataset.part! }; rerender(); }));
    q<HTMLButtonElement>('[data-stock]').forEach((b) => b.addEventListener('click', () => { this.tuning = null; this.preview = { kind: 'stock', slot: b.dataset.stock! }; rerender(); }));
    q<HTMLButtonElement>('[data-cos]').forEach((b) => b.addEventListener('click', () => {
      this.preview = { kind: 'cosmetic', id: b.dataset.id!, cosmeticKind: b.dataset.cos as 'paint' | 'wrap' | 'gear' };
      rerender();
    }));
    q<HTMLButtonElement>('[data-num]').forEach((b) => b.addEventListener('click', () => {
      this.prog.setNumber(this.sledId, this.prog.garage(this.sledId).livery.number + Number(b.dataset.num));
      rerender();
    }));
    q<HTMLButtonElement>('[data-tslot]').forEach((b) => b.addEventListener('click', () => {
      const err = this.prog.buyTrailerPart(b.dataset.tslot as 'suspension' | 'skis' | 'tieDowns', b.dataset.id!);
      this.flash(err ?? 'Trailer upgrade fitted');
      this.game.audioCue?.(err ? 'deny' : 'buy');
      rerender(false);
    }));
    // tuning sliders update the stats live without rebuilding the list (keeps the slider grabbed)
    q<HTMLInputElement>('[data-tune]').forEach((inp) => inp.addEventListener('input', () => {
      const id = inp.dataset.tune as keyof Tuning;
      this.preview = null;
      this.tuning = { ...(this.tuning ?? this.savedTuning()), [id]: Number(inp.value) };
      const d = TUNING_DEFS.find((x) => x.id === id)!;
      const v = this.tuning[id];
      (this.el.querySelector(`[data-val="${id}"]`) as HTMLElement).textContent = `${v > 0 ? '+' : ''}${v}${d.unit}`;
      this.renderStats();
    }));
    q<HTMLButtonElement>('[data-reset-tune]').forEach((b) => b.addEventListener('click', () => {
      const sec = b.dataset.resetTune!;
      const t = { ...(this.tuning ?? this.savedTuning()) };
      for (const d of TUNING_DEFS) if (d.section === sec) t[d.id] = 0;
      this.tuning = t;
      this.preview = null;
      rerender(false);
    }));
  }

  private act(a: string) {
    let err: string | null = null;
    let ok = '';
    const pv = this.preview;
    if (a === 'select') { this.prog.selectSled(this.dealerPick); ok = 'Sled selected'; }
    if (a === 'buySled') { err = this.prog.buySled(this.dealerPick); ok = `Welcome to the ${getSled(this.dealerPick).model}!`; }
    if (a === 'buyPart' && pv?.kind === 'part') { err = this.prog.buyPart(this.sledId, pv.id); ok = `${getPart(pv.id)!.name} installed`; }
    if (a === 'remove' && pv?.kind === 'stock') { this.prog.removePart(this.sledId, pv.slot); ok = pv.slot === 'hitch' ? 'Hitch removed' : 'Stock part refitted'; }
    if (a === 'buyCosmetic' && pv?.kind === 'cosmetic') { err = this.prog.buyCosmetic(this.sledId, pv.cosmeticKind, pv.id); ok = 'Looking sharp'; }
    if (a === 'saveTuning' && this.tuning) { this.prog.setTuning(this.sledId, this.tuning); ok = 'Tuning saved'; }
    if (a === 'discardTuning') ok = 'Tuning changes discarded';
    this.flash(err ?? ok);
    this.game.audioCue?.(err ? 'deny' : 'buy');
    if (!err) { this.preview = null; this.tuning = null; }
    if (a === 'select' || a === 'buySled') this.dealerPick = this.sledId;
    this.render();
    this.updateModel();
  }
}
