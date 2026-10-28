import type { Game } from '../core/Game';
import { riderLevel } from '../core/Progression';
import { SLEDS, PART_CATEGORIES, SLOT_NAMES, PARTS, COSMETICS, getSled, getPart, partFits, displayStats, SledSetup, StatLine } from '../vehicles/SledSpec';
import trailerData from '../data/trailers.json';

type Tab = 'dealer' | 'garage' | 'style' | 'trailer';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Dealership (buy/select sleds), Garage (parts), Paint & Gear (cosmetics) and Trailer tabs over the
 * 3D showroom. Every choice previews live with a before/after stat comparison before you spend.
 */
export class Garage {
  readonly el: HTMLDivElement;
  private tab: Tab = 'garage';
  private dealerPick = '';
  private preview: { kind: 'part' | 'cosmetic' | 'stock'; id: string; slot?: string; cosmeticKind?: 'paint' | 'wrap' | 'gear' } | null = null;
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

  open(tab: Tab) {
    this.tab = tab;
    this.dealerPick = this.sledId;
    this.preview = null;
    this.render();
    this.el.classList.add('show');
    this.updatePreview();
  }

  close() {
    this.el.classList.remove('show');
  }

  private flash(text: string) {
    this.msg = text;
    this.msgTimer = 2.4;
  }

  update(dt: number) {
    if (this.msgTimer > 0 && (this.msgTimer -= dt) <= 0) {
      const m = this.el.querySelector('.g-msg');
      if (m) m.classList.remove('show');
    }
  }

  // ---------- setups ----------

  private baseSetup(): SledSetup {
    if (this.tab === 'dealer') return this.prog.setupFor(this.sledId);
    return this.prog.setupFor(this.sledId);
  }

  private candidateSetup(): SledSetup {
    if (this.tab === 'dealer') {
      const id = this.dealerPick || this.sledId;
      return this.prog.owns(id) ? this.prog.setupFor(id) : { ...this.prog.setupFor(id), parts: [] };
    }
    const base = this.prog.setupFor(this.sledId);
    const pv = this.preview;
    if (!pv) return base;
    if (pv.kind === 'part') return this.prog.setupFor(this.sledId, [pv.id]);
    if (pv.kind === 'stock' && pv.slot) {
      const g = this.prog.garage(this.sledId);
      const installed = { ...g.installed };
      delete installed[pv.slot];
      return { ...base, parts: Object.values(installed) };
    }
    if (pv.kind === 'cosmetic' && pv.cosmeticKind) return { ...base, livery: { ...base.livery!, [pv.cosmeticKind]: pv.id } };
    return base;
  }

  private updatePreview() {
    this.game.showroom.show(this.candidateSetup());
  }

  // ---------- render ----------

  private render() {
    const sd = this.game.save.data;
    const lvl = riderLevel(sd.xp);
    const tabs: [Tab, string][] = [['dealer', 'Dealership'], ['garage', 'Garage'], ['style', 'Paint & Gear'], ['trailer', 'Trailer']];
    const spec = getSled(this.tab === 'dealer' ? this.dealerPick || this.sledId : this.sledId);
    this.el.innerHTML = `
      <div class="g-top">
        <button class="g-back">‹ Menu</button>
        <div class="g-tabs">${tabs.map(([t, n]) => `<button data-tab="${t}" class="${t === this.tab ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="g-wallet"><b>$${fmt(sd.currency)}</b><span>Lv ${lvl.level} · ${fmt(sd.xp)} XP</span></div>
      </div>
      <div class="g-body">
        <div class="g-list">${this.listHtml()}</div>
        <div class="g-center"><div class="g-title"><span class="tier">T${spec.tier}</span>${esc(spec.brand)} <b>${esc(spec.model)}</b><div class="g-class">${esc(spec.class)} · ${esc(spec.reference)}</div></div></div>
        <div class="g-stats">${this.statsHtml()}</div>
      </div>
      <div class="g-msg ${this.msgTimer > 0 ? 'show' : ''}">${esc(this.msg)}</div>`;
    this.el.querySelector('.g-back')!.addEventListener('click', () => this.game.closeGarage());
    this.el.querySelectorAll<HTMLButtonElement>('.g-tabs button').forEach((b) => b.addEventListener('click', () => {
      this.tab = b.dataset.tab as Tab;
      this.preview = null;
      this.dealerPick = this.sledId;
      this.render();
      this.updatePreview();
    }));
    this.bindList();
  }

  private statsHtml(): string {
    const before = displayStats(this.baseSetup());
    const after = displayStats(this.candidateSetup());
    const changed = this.tab === 'dealer' ? this.dealerPick !== this.sledId : !!this.preview && this.preview.kind !== 'cosmetic';
    const rows = after.map((a: StatLine, i: number) => {
      const b = before[i];
      const d = a.bar - b.bar;
      const lo = Math.min(a.bar, b.bar), hi = Math.max(a.bar, b.bar);
      const delta = changed && Math.abs(d) > 0.004
        ? `<span class="delta ${d > 0 ? 'up' : 'down'}" style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></span>` : '';
      return `
        <div class="stat">
          <div class="stat-h"><span>${a.label}</span><span class="${changed && a.value !== b.value ? (d >= 0 ? 'up' : 'down') : ''}">${changed && a.value !== b.value ? `${b.value} → ` : ''}${a.value}</span></div>
          <div class="bar"><span class="fill" style="width:${lo * 100}%"></span>${delta}${!changed || Math.abs(d) <= 0.004 ? `<span class="fill" style="width:${a.bar * 100}%"></span>` : ''}</div>
        </div>`;
    }).join('');
    const head = this.tab === 'dealer' && this.dealerPick !== this.sledId
      ? `<div class="g-h">Compared with your ${esc(getSled(this.sledId).model)}</div>` : '<div class="g-h">Stats</div>';
    return head + rows + this.actionHtml();
  }

  private actionHtml(): string {
    const sd = this.game.save.data;
    if (this.tab === 'dealer') {
      const spec = getSled(this.dealerPick || this.sledId);
      if (this.prog.owns(spec.id)) {
        return spec.id === this.sledId ? '<button class="g-act" disabled>Current sled</button>' : `<button class="g-act primary" data-act="select">Ride this sled</button>`;
      }
      const reqs = this.prog.requirements(spec);
      const ok = this.prog.unlocked(spec);
      const reqHtml = reqs.length ? `<div class="reqs">${reqs.map((r) => `<div class="${r.have >= r.need ? 'met' : ''}"><span>${r.label}</span><span>${fmt(Math.min(r.have, r.need))}/${fmt(r.need)}</span></div>`).join('')}</div>` : '';
      return `${reqHtml}<button class="g-act primary" data-act="buySled" ${ok && sd.currency >= spec.price ? '' : 'disabled'}>${ok ? `Buy · $${fmt(spec.price)}` : 'Locked'}</button>`;
    }
    const pv = this.preview;
    if (!pv) return '<div class="g-hint">Pick a part or style to preview it.</div>';
    if (pv.kind === 'stock') return `<button class="g-act" data-act="remove">Refit stock ${esc(SLOT_NAMES[pv.slot!] ?? '')}</button>`;
    if (pv.kind === 'part') {
      const p = getPart(pv.id)!;
      const g = this.prog.garage(this.sledId);
      const owned = g.parts.includes(p.id);
      const fitted = g.installed[p.slot] === p.id;
      if (!partFits(p, getSled(this.sledId))) return `<button class="g-act" disabled>Needs a tier ${p.tier}+ sled</button>`;
      if (fitted) return '<button class="g-act" disabled>Installed</button>';
      return `<div class="g-desc">${esc(p.desc)}</div><button class="g-act primary" data-act="buyPart" ${owned || sd.currency >= p.price ? '' : 'disabled'}>${owned ? 'Install' : `Buy & install · $${fmt(p.price)}`}</button>`;
    }
    const list = pv.cosmeticKind === 'paint' ? COSMETICS.paints : pv.cosmeticKind === 'wrap' ? COSMETICS.wraps : COSMETICS.gear;
    const item = list.find((x) => x.id === pv.id) as { price: number; minTier?: number };
    const g = this.prog.garage(this.sledId);
    const owned = item.price === 0 || g.cosmetics.includes(`${pv.cosmeticKind}:${pv.id}`);
    if (g.livery[pv.cosmeticKind!] === pv.id) return '<button class="g-act" disabled>Applied</button>';
    if (item.minTier && getSled(this.sledId).tier < item.minTier) return `<button class="g-act" disabled>Turbo Build only</button>`;
    return `<button class="g-act primary" data-act="buyCosmetic" ${owned || sd.currency >= item.price ? '' : 'disabled'}>${owned ? 'Apply' : `Buy & apply · $${fmt(item.price)}`}</button>`;
  }

  private listHtml(): string {
    const g = this.prog.garage(this.sledId);
    const spec = getSled(this.sledId);
    if (this.tab === 'dealer') {
      return SLEDS.map((s) => {
        const owned = this.prog.owns(s.id);
        const status = s.id === this.sledId ? 'Riding' : owned ? 'Owned' : this.prog.unlocked(s) ? `$${fmt(s.price)}` : 'Locked';
        return `<button class="item sled ${s.id === this.dealerPick ? 'sel' : ''} ${!owned && !this.prog.unlocked(s) ? 'locked' : ''}" data-sled="${s.id}">
          <span class="tier">T${s.tier}</span><span class="nm"><b>${esc(s.brand)} ${esc(s.model)}</b><small>${esc(s.class)}</small></span><span class="st">${status}</span></button>`;
      }).join('');
    }
    if (this.tab === 'garage') {
      return PART_CATEGORIES.map((cat) => `
        <div class="cat">${esc(cat.name)}</div>
        ${cat.slots.map((slot) => {
          const parts = PARTS.filter((p) => p.slot === slot);
          const fitted = g.installed[slot];
          const sel = (k: string, id: string) => (this.preview?.kind === k && this.preview.id === id ? 'sel' : '');
          return `<div class="slot"><div class="slot-n">${esc(SLOT_NAMES[slot])}</div>
            <button class="item part ${!fitted ? 'fitted' : ''} ${sel('stock', slot)}" data-stock="${slot}"><span class="nm">Stock</span><span class="st">${!fitted ? '✓' : ''}</span></button>
            ${parts.map((p) => {
              const fits = partFits(p, spec);
              const st = fitted === p.id ? '✓' : g.parts.includes(p.id) ? 'Owned' : fits ? `$${fmt(p.price)}` : `T${p.tier}+`;
              return `<button class="item part ${fitted === p.id ? 'fitted' : ''} ${fits ? '' : 'locked'} ${sel('part', p.id)}" data-part="${p.id}"><span class="nm">${esc(p.name)}</span><span class="st">${st}</span></button>`;
            }).join('')}</div>`;
        }).join('')}`).join('');
    }
    if (this.tab === 'style') {
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
    // trailer
    const t = this.game.save.data.trailer;
    const U = trailerData.upgrades;
    const row = (slot: 'suspension' | 'skis' | 'tieDowns', title: string, describe: (x: Record<string, number | string>) => string) => `
      <div class="cat">${title}</div>
      ${(U[slot] as unknown as Record<string, number | string>[]).map((x) => {
        const on = t.upgrades[slot] === x.id;
        const owned = x.price === 0 || t.ownedParts.includes(`${slot}:${x.id}`);
        return `<button class="item part ${on ? 'fitted' : ''}" data-tslot="${slot}" data-id="${x.id}"><span class="nm">${esc(String(x.name))}<small>${describe(x)}</small></span><span class="st">${on ? '✓' : owned ? 'Owned' : `$${fmt(Number(x.price))}`}</span></button>`;
      }).join('')}`;
    return `<div class="g-note">Hitch the trailer in Freeride with <b>H</b>. Upgrades apply next time you hitch up.</div>
      ${row('suspension', 'Suspension', (x) => `${Math.round(Number(x.travel) * 100)} cm travel · ${x.stiffness}× springs`)}
      ${row('skis', 'Skis', (x) => `${Math.round(Number(x.width) * 100)} cm wide · ${x.lateralGrip}× bite`)}
      ${row('tieDowns', 'Tie-downs', (x) => `${Math.round(Number(x.spillChance) * 100)}% spill risk · ${x.damageMult}× damage`)}`;
  }

  private bindList() {
    const q = <T extends HTMLElement>(s: string) => [...this.el.querySelectorAll<T>(s)];
    const rerender = () => { this.render(); this.updatePreview(); };
    q<HTMLButtonElement>('[data-sled]').forEach((b) => b.addEventListener('click', () => { this.dealerPick = b.dataset.sled!; rerender(); }));
    q<HTMLButtonElement>('[data-part]').forEach((b) => b.addEventListener('click', () => { this.preview = { kind: 'part', id: b.dataset.part! }; rerender(); }));
    q<HTMLButtonElement>('[data-stock]').forEach((b) => b.addEventListener('click', () => { this.preview = { kind: 'stock', id: b.dataset.stock!, slot: b.dataset.stock! }; rerender(); }));
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
      rerender();
    }));
    q<HTMLButtonElement>('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act!)));
  }

  private act(a: string) {
    let err: string | null = null;
    let ok = '';
    if (a === 'select') { this.prog.selectSled(this.dealerPick); ok = 'Sled selected'; }
    if (a === 'buySled') { err = this.prog.buySled(this.dealerPick); ok = `Welcome to the ${getSled(this.dealerPick).model}!`; }
    if (a === 'buyPart' && this.preview) { err = this.prog.buyPart(this.sledId, this.preview.id); ok = `${getPart(this.preview.id)!.name} installed`; }
    if (a === 'remove' && this.preview?.slot) { this.prog.removePart(this.sledId, this.preview.slot); ok = 'Stock part refitted'; }
    if (a === 'buyCosmetic' && this.preview?.cosmeticKind) { err = this.prog.buyCosmetic(this.sledId, this.preview.cosmeticKind, this.preview.id); ok = 'Looking sharp'; }
    this.flash(err ?? ok);
    this.game.audioCue?.(err ? 'deny' : 'buy');
    if (!err) this.preview = null;
    this.render();
    this.updatePreview();
  }
}
