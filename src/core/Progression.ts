import { SaveData, newSledSave } from './SaveSystem';
import { SLEDS, SledSpec, SledSetup, getSled, getPart, partFits, COSMETICS, RIDER_MASS, Livery, Tuning, DEFAULT_TUNING } from '../vehicles/SledSpec';
import trailerData from '../data/trailers.json';
import freerideData from '../data/freeride.json';
import skillsData from '../data/skills.json';

export const SKILLS = skillsData.skills;

export interface Requirement { label: string; have: number; need: number }

/** Rider level from total XP: each level past 1 earns skill points (skills.json). */
export function riderLevel(xp: number): { level: number; into: number; span: number } {
  let level = 1, need = 400, acc = 0;
  while (xp >= acc + need) { acc += need; level++; need = Math.round(need * 1.18); }
  return { level, into: xp - acc, span: need };
}

/** Purchases, unlocks and installs. All game rules about spending live here; UI only calls these. */
export class Progression {
  constructor(private save: SaveData, private onChange: () => void) {}

  private get d() { return this.save; }

  counts() {
    const medals = Object.values(this.d.timeTrials).flatMap((r) => r.medals);
    return {
      xp: this.d.xp,
      medals: new Set(Object.entries(this.d.timeTrials).filter(([, r]) => r.medals.length).map(([k]) => k)).size,
      gold: medals.filter((m) => m === 'gold').length,
      crystals: this.d.freeride.crystals.length,
      deliveries: this.d.delivery.completed,
      podiums: Object.values(this.d.snocross).reduce((a, r) => a + r.podiums, 0),
      wins: Object.values(this.d.snocross).reduce((a, r) => a + r.wins, 0),
      specials: this.d.special.completed,
    };
  }

  /** Progress gates for buying a sled (price is checked separately). */
  requirements(spec: SledSpec): Requirement[] {
    const c = this.counts();
    const u = spec.unlock;
    const out: Requirement[] = [];
    // tiers unlock in order: own the tier below first
    if (spec.tier > 1) {
      const has = SLEDS.some((x) => x.tier >= spec.tier - 1 && this.owns(x.id)) ? 1 : 0;
      out.push({ label: `Own a tier ${spec.tier - 1} sled`, have: has, need: 1 });
    }
    if (u.xp) out.push({ label: 'XP', have: c.xp, need: u.xp });
    if (u.medals) out.push({ label: 'Courses medalled', have: c.medals, need: u.medals });
    if (u.gold) out.push({ label: 'Gold medals', have: c.gold, need: u.gold });
    if (u.deliveries) out.push({ label: 'Deliveries completed', have: c.deliveries, need: u.deliveries });
    if (u.podiums) out.push({ label: 'Snocross podiums', have: c.podiums, need: u.podiums });
    if (u.wins) out.push({ label: 'Snocross wins', have: c.wins, need: u.wins });
    if (u.crystals) out.push({ label: `Frost crystals (of ${freerideData.collectibles.length})`, have: c.crystals, need: u.crystals });
    return out;
  }

  unlocked(spec: SledSpec): boolean {
    return this.requirements(spec).every((r) => r.have >= r.need);
  }

  owns(sledId: string) { return this.d.ownedSleds.includes(sledId); }

  garage(sledId: string) {
    return (this.d.sleds[sledId] ??= newSledSave());
  }

  /** The setup (spec + fitted parts + livery) the physics and model are built from. */
  setupFor(sledId: string, extraParts: string[] = [], livery?: Livery, cargoMass = 0, tuning?: Tuning): SledSetup {
    const g = this.garage(sledId);
    const installed = { ...g.installed };
    for (const id of extraParts) { const p = getPart(id); if (p) installed[p.slot] = id; }
    return {
      spec: getSled(sledId), riderMass: RIDER_MASS, cargoMass, parts: Object.values(installed), skills: { ...this.d.skills },
      livery: livery ?? g.livery, tuning: tuning ?? { ...DEFAULT_TUNING, ...g.tuning },
    };
  }

  // ---------- rider skills ----------

  /** Points earned so far: startPoints plus pointsPerLevel per rider level past 1. */
  skillPointsEarned(): number {
    return skillsData.startPoints + (riderLevel(this.d.xp).level - 1) * skillsData.pointsPerLevel;
  }

  skillPointsSpent(): number {
    return SKILLS.reduce((a, sk) => a + sk.cost.slice(0, this.skillLevel(sk.id)).reduce((x, y) => x + y, 0), 0);
  }

  skillPoints(): number { return this.skillPointsEarned() - this.skillPointsSpent(); }

  skillLevel(id: string): number { return this.d.skills[id] ?? 0; }

  /** Cost of the next level of a skill (null when maxed). */
  skillCost(id: string): number | null {
    const sk = SKILLS.find((s) => s.id === id);
    if (!sk) return null;
    const lvl = this.skillLevel(id);
    return lvl >= sk.maxLevel ? null : sk.cost[lvl];
  }

  /** Error message, or null on success. */
  buySkill(id: string): string | null {
    const cost = this.skillCost(id);
    if (cost === null) return 'Already maxed';
    if (this.skillPoints() < cost) return `Needs ${cost} skill point${cost === 1 ? '' : 's'}`;
    this.d.skills[id] = this.skillLevel(id) + 1;
    this.onChange();
    return null;
  }

  resetSkills(): string | null {
    if (!this.skillPointsSpent()) return 'Nothing to reset';
    if (skillsData.resetCost && !this.spend(skillsData.resetCost)) return `Needs $${skillsData.resetCost}`;
    this.d.skills = {};
    this.onChange();
    return null;
  }

  /** Tuning is free: just store it. */
  setTuning(sledId: string, tuning: Tuning) {
    this.garage(sledId).tuning = { ...tuning };
    this.onChange();
  }

  canTow(sledId: string): boolean {
    const g = this.garage(sledId);
    return !!g.installed.hitch;
  }

  private spend(amount: number): boolean {
    if (this.d.currency < amount) return false;
    this.d.currency -= amount;
    return true;
  }

  buySled(id: string): string | null {
    const spec = getSled(id);
    if (this.owns(id)) return 'Already owned';
    if (!this.unlocked(spec)) return 'Locked – keep progressing';
    if (!this.spend(spec.price)) return 'Not enough cash';
    this.d.ownedSleds.push(id);
    this.garage(id);
    this.d.currentSled = id;
    this.onChange();
    return null;
  }

  selectSled(id: string) {
    if (!this.owns(id)) return;
    this.d.currentSled = id;
    this.onChange();
  }

  /** Buy (if needed) and fit a part. Returns an error string or null. */
  buyPart(sledId: string, partId: string): string | null {
    const p = getPart(partId);
    const spec = getSled(sledId);
    if (!p) return 'Unknown part';
    if (!partFits(p, spec)) return `Needs a tier ${p.tier}+ sled`;
    const g = this.garage(sledId);
    if (!g.parts.includes(partId)) {
      if (!this.spend(p.price)) return 'Not enough cash';
      g.parts.push(partId);
    }
    g.installed[p.slot] = partId;
    this.onChange();
    return null;
  }

  removePart(sledId: string, slot: string) {
    delete this.garage(sledId).installed[slot];
    this.onChange();
  }

  buyCosmetic(sledId: string, kind: 'paint' | 'wrap' | 'gear', id: string): string | null {
    const list = kind === 'paint' ? COSMETICS.paints : kind === 'wrap' ? COSMETICS.wraps : COSMETICS.gear;
    const item = list.find((x) => x.id === id) as { id: string; price: number; minTier?: number } | undefined;
    if (!item) return 'Unknown item';
    const spec = getSled(sledId);
    if (item.minTier && spec.tier < item.minTier) return `Tier ${item.minTier} sled only`;
    const g = this.garage(sledId);
    const key = `${kind}:${id}`;
    if (item.price > 0 && !g.cosmetics.includes(key)) {
      if (!this.spend(item.price)) return 'Not enough cash';
      g.cosmetics.push(key);
    }
    g.livery = { ...g.livery, [kind]: id };
    this.onChange();
    return null;
  }

  setNumber(sledId: string, n: number) {
    const g = this.garage(sledId);
    g.livery = { ...g.livery, number: Math.max(1, Math.min(99, Math.round(n))) };
    this.onChange();
  }

  buyTrailerPart(slot: 'suspension' | 'skis' | 'tieDowns', id: string): string | null {
    if (!Object.values(this.d.sleds).some((g) => g.installed.hitch)) return 'Fit a tow hitch first';
    const item = (trailerData.upgrades[slot] as { id: string; price: number }[]).find((x) => x.id === id);
    if (!item) return 'Unknown part';
    const key = `${slot}:${id}`;
    const t = this.d.trailer;
    if (item.price > 0 && !t.ownedParts.includes(key)) {
      if (!this.spend(item.price)) return 'Not enough cash';
      t.ownedParts.push(key);
    }
    t.upgrades[slot] = id;
    this.onChange();
    return null;
  }

  /**
   * Progress toward the next sled: each requirement and the price count equally, capped at 100%.
   * Drives the "next sled" bars in the menu and garage.
   */
  goalProgress(): { spec: SledSpec; frac: number; ready: boolean; missing: string } | null {
    const spec = this.nextGoal();
    if (!spec) return null;
    const reqs = this.requirements(spec);
    const parts = [...reqs.map((r) => Math.min(1, r.have / r.need)), Math.min(1, this.d.currency / spec.price)];
    const frac = parts.reduce((a, b) => a + b, 0) / parts.length;
    const unmet = reqs.filter((r) => r.have < r.need).map((r) => `${r.label} ${Math.round(r.have).toLocaleString('en-US')}/${r.need.toLocaleString('en-US')}`);
    if (this.d.currency < spec.price) unmet.push(`$${(spec.price - this.d.currency).toLocaleString('en-US')} more`);
    return { spec, frac, ready: !unmet.length, missing: unmet.join(' · ') };
  }

  /** Cheapest locked/unowned sled the player is working toward (menu hint). */
  nextGoal(): SledSpec | null {
    return SLEDS.find((s) => !this.owns(s.id)) ?? null;
  }
}
