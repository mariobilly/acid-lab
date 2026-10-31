// Seeded randomness for Dice and Beat Sync: the same seed always rolls the same stack, so a beat-driven
// "random" sequence renders identically in the preview and in the export.

import { EFFECTS, CATEGORIES, makeLayer, isNum } from './effects/index.js';

/** Small fast PRNG -> () => [0, 1). */
export function mulberry32(a) {
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer hash of a few numbers. */
export function hashInts(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h ^= Math.floor(x * 1000) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

export const hash01 = (...xs) => mulberry32(hashInts(...xs))();

const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const lerp = (a, b, t) => a + (b - a) * t;

function hslHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
const vivid = (rnd) => hslHex(Math.floor(rnd() * 360), 100, Math.floor(lerp(48, 62, rnd())));
const deep = (rnd) => hslHex(Math.floor(rnd() * 360), Math.floor(lerp(20, 70, rnd())), Math.floor(lerp(8, 30, rnd())));

/** Select params worth randomizing (others, like "direction" or "resolution", keep their defaults). */
export const RANDOM_SELECTS = new Set(['pattern', 'palette', 'colorMode', 'style', 'dir', 'map', 'source', 'by']);

/** Random values for an effect's params; with `base` and amount < 1 it nudges base toward a random target. */
export function randomParams(fx, rnd, amount = 1, base = null) {
  const out = {};
  for (const p of fx.params) {
    const b = base ? base[p.key] : undefined;
    if (isNum(p) && p.rand) {
      let v = lerp(p.rand[0], p.rand[1], rnd());
      if (b !== undefined) v = lerp(Number(b), v, amount);
      if (p.step === 1) v = Math.round(v);
      out[p.key] = v;
    } else if (p.type === 'select' && RANDOM_SELECTS.has(p.key)) {
      out[p.key] = b !== undefined && rnd() > amount ? b : Number(pick(rnd, Object.values(p.options)));
    } else if (p.type === 'color') {
      out[p.key] = b !== undefined && rnd() > amount ? b : vivid(rnd);
    }
  }
  if (fx.id === 'patternBg' && (!base || rnd() < amount)) out.colorB = deep(rnd);
  return out;
}

export function randomLayer(id, rnd, extra = {}) {
  return makeLayer(id, randomParams(EFFECTS[id], rnd), extra);
}

const POOL = {
  distort: ['liquid', 'wave', 'kaleido', 'tunnel'],
  time: ['echo', 'timeSlice', 'stutter'],
  glitch: ['rgbSplit', 'blockGlitch', 'datamosh', 'pixelSort', 'pixelDrip', 'scanTear', 'censorBlocks', 'vhs'],
  color: ['acidHue', 'posterize', 'solarize', 'gradientMap', 'deepFry'],
  finish: ['edgeNeon', 'bloom', 'grain'],
};
const WEIGHTS = [['glitch', 3], ['color', 3], ['time', 1.6], ['distort', 1.3], ['finish', 1]];
const HEAVY = new Set(['datamosh', 'pixelSort', 'tunnel', 'kaleido', 'timeSlice']);

/** Effect ids for a random stack, in a sensible order (subject first, finish last). */
export function randomStackIds(rnd, subject) {
  const ids = [];
  if (subject && rnd() < 0.8) {
    ids.push('patternBg');
    if (rnd() < 0.75) ids.push('neonHalo');
  }
  const n = 2 + Math.floor(rnd() * 3) + ids.length;
  for (let guard = 0; ids.length < n && guard < 40; guard++) {
    let r = rnd() * WEIGHTS.reduce((s, w) => s + w[1], 0);
    const cat = WEIGHTS.find((w) => (r -= w[1]) < 0)[0];
    const id = pick(rnd, POOL[cat]);
    if (ids.includes(id) || (HEAVY.has(id) && ids.some((x) => HEAVY.has(x)))) continue;
    ids.push(id);
  }
  const order = CATEGORIES.map((c) => c.id);
  return ids.sort((a, b) => order.indexOf(EFFECTS[a].cat) - order.indexOf(EFFECTS[b].cat));
}

/** Copy of `layers` with params nudged toward random values (same uids, so stateful effects keep running). */
export function mutateLayers(layers, rnd, amount) {
  return layers.map((l) => {
    const fx = EFFECTS[l.fx];
    if (!fx) return l;
    return { ...l, params: { ...l.params, ...randomParams(fx, rnd, amount, l.params) } };
  });
}
