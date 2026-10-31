// Beat Sync: turns a song's beat grid into "cuts" and decides what the effect stack looks like after each one.
// Everything is a pure function of (beat grid, settings, seed, cut index), so a frame-by-frame export lands
// on exactly the same random choices as the live preview.

import { mulberry32, hashInts, hash01, randomLayer, randomStackIds, mutateLayers } from './random.js';
import { EFFECTS } from './effects/index.js';
import { buildLayers } from './presets.js';

export const EVERY = { 'half beat': 0.5, beat: 1, '2 beats': 2, bar: 4, '2 bars': 8, '4 bars': 16, kick: 'kick' };
export const MODES = {
  single: 'one effect hits',
  looks: 'random look',
  params: 're-roll settings',
  dice: 'new random stack',
  seed: 'reshuffle glitches',
};

export const defaultBeatCfg = () => ({
  on: false, mode: 'looks', every: 'bar', chance: 1, amount: 0.35, punch: 0.4, start: 0, barShift: 0, pool: null,
  // "one effect hits": a single layer of your stack fires on the cuts, everything else stays put
  target: null, style: 'flash', hold: 0.5, vary: 0,
});
export const HIT_STYLES = { flash: 'flash', pulse: 'fade out', toggle: 'on / off' };

/** Cut times in timeline seconds (0 = the music start point). */
export function triggerTimes(grid, cfg, seed) {
  if (!grid?.beats?.length) return [];
  const start = cfg.start || 0;
  let src;
  if (cfg.every === 'kick') src = grid.kicks || [];
  else {
    const b = grid.beats;
    const div = EVERY[cfg.every] ?? 1;
    if (div === 0.5) {
      src = [];
      b.forEach((t, i) => { src.push(t); if (i + 1 < b.length) src.push((t + b[i + 1]) / 2); });
    } else if (div === 1) src = b;
    else {
      // bar-based divisions start on the downbeat; the user can shift which beat counts as "1"
      const phase = ((grid.phase || 0) + (cfg.barShift || 0)) % 4;
      const off = div >= 4 ? phase : phase % div;
      src = b.filter((_, i) => i >= off && (i - off) % div === 0);
    }
  }
  const chance = cfg.chance ?? 1;
  const out = [];
  src.forEach((t, k) => {
    const tt = t - start;
    if (tt < -1e-6) return;
    if (chance >= 1 || hash01(seed, k, 77) < chance) out.push(tt);
  });
  return out;
}

/** Index of the last time <= t, or -1. */
export function lastIndex(times, t) {
  let lo = 0, hi = times.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

export class BeatDirector {
  constructor() {
    this.version = -1;
    this.cache = new Map();
    this.cuts = [];
    this.beatTimes = [];
    this.seq = [];
  }

  /** ctx: { grid, cfg, base, pool: [{name, user, layers?}], subject, seed, version } — cheap when unchanged. */
  update(ctx) {
    if (ctx.version === this.version && ctx.grid === this.grid) return;
    this.version = ctx.version;
    this.grid = ctx.grid;
    this.ctx = ctx;
    this.cache.clear();
    const start = ctx.cfg.start || 0;
    this.cuts = ctx.cfg.on ? triggerTimes(ctx.grid, ctx.cfg, ctx.seed) : [];
    this.beatTimes = (ctx.grid?.beats || []).map((t) => t - start);
    // hit length is set in beats so it follows the song's tempo
    this.holdSec = Math.max(0.02, (ctx.cfg.hold || 0.5) * 60 / (ctx.grid?.tempo || 120));
    // look order: random, but never the same look twice in a row
    const n = ctx.pool.length;
    this.seq = new Array(this.cuts.length);
    let prev = -1;
    for (let k = 0; k < this.cuts.length; k++) {
      const r = mulberry32(hashInts(ctx.seed, k, 3))();
      let i = Math.floor(r * n);
      if (n > 1 && i === prev) i = (i + 1 + Math.floor(r * 997) % (n - 1)) % n;
      this.seq[k] = i;
      prev = i;
    }
  }

  /** 0..1 pulse that snaps to 1 on every beat and decays (for punch and audio-beat modulation). */
  beatEnv(t) {
    const i = lastIndex(this.beatTimes, t);
    return i < 0 ? 0 : Math.exp(-(t - this.beatTimes[i]) / 0.11);
  }

  /** Stack in effect at timeline time t. */
  at(t) {
    const c = this.ctx;
    const k = c?.cfg.on ? lastIndex(this.cuts, t) : -1;
    if (c?.cfg.on && c.cfg.mode === 'single') return this.single(t, k);
    if (k < 0) return { layers: c ? c.base : [], seed: c ? c.seed : 0, cut: -1, label: c?.cfg.on ? 'waiting for the first beat' : '' };
    let seg = this.cache.get(k);
    if (!seg) {
      seg = this.make(k);
      if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(k, seg);
    }
    return seg;
  }

  /** One layer fires on the cuts (flash / fade / on-off); every other layer stays exactly as you set it. */
  single(t, k) {
    const { cfg, base, seed } = this.ctx;
    const target = base.find((l) => l.uid === cfg.target);
    if (!target) return { layers: base, seed, cut: k, label: 'pick the effect to fire', hit: 0 };
    let m = 0;
    if (k >= 0) {
      const age = t - this.cuts[k];
      if (cfg.style === 'toggle') m = k % 2 === 0 ? 1 : 0;
      else if (cfg.style === 'pulse') m = Math.max(0, 1 - age / this.holdSec);
      else m = age < this.holdSec ? 1 : 0;
    }
    const hit = { ...target, on: target.on && m > 0.001, mix: target.mix * (cfg.style === 'pulse' ? m : 1) };
    if (cfg.vary > 0 && k >= 0) {
      // optional: nudge its settings a little on every hit (0 = identical every time)
      let p = this.cache.get(`p${k}`);
      if (!p) {
        p = mutateLayers([target], mulberry32(hashInts(seed, k, 13)), cfg.vary)[0].params;
        this.cache.set(`p${k}`, p);
      }
      hit.params = p;
    }
    const name = EFFECTS[target.fx]?.name || target.fx;
    return { layers: base.map((l) => (l === target ? hit : l)), seed, cut: k, label: m > 0.001 ? `${name} ⚡` : name, hit: m };
  }

  make(k) {
    const { cfg, base, pool, subject, seed } = this.ctx;
    const rnd = mulberry32(hashInts(seed, k, 11));
    const tag = (layers) => layers.map((l, i) => ({ ...l, uid: `B${k}_${i}` }));
    if (cfg.mode === 'looks' && pool.length) {
      const look = pool[this.seq[k]];
      let layers = look.user ? JSON.parse(JSON.stringify(look.layers)).filter((l) => EFFECTS[l.fx]) : buildLayers(look);
      if (cfg.amount > 0) layers = mutateLayers(layers, rnd, cfg.amount * 0.6);
      return { layers: tag(layers), seed, cut: k, label: look.name };
    }
    if (cfg.mode === 'dice') {
      const ids = randomStackIds(rnd, subject);
      return { layers: tag(ids.map((id) => randomLayer(id, rnd))), seed, cut: k, label: ids.map((id) => EFFECTS[id].name).join(' + ') };
    }
    if (cfg.mode === 'seed') {
      const s = hashInts(seed, k, 5) % 1000;
      return { layers: base, seed: s, cut: k, label: `seed ${s}` };
    }
    // params: same layers (and uids, so echo/datamosh keep their state), new values
    return { layers: mutateLayers(base, rnd, Math.max(0.05, cfg.amount)), seed, cut: k, label: `re-roll #${k + 1}` };
  }
}
