// Built-in looks, each modelled on clips in "Instagram tabs/04 Glitch - Psychedelic".
// A layer spec is [effectId, params, layerExtras]; layerExtras can set scope, mix, mods.

import { makeLayer } from './effects/index.js';

const L = (id, params = {}, extra = {}) => ({ id, params, extra });

export const PRESETS = [
  {
    id: 'neon-specimen',
    name: 'Neon Specimen',
    blurb: 'Cutout on a warped grid, red glow + yellow neon line, deep-fried color',
    swatch: ['#ff1fd2', '#ff1a1a', '#f6ff00'],
    mask: 'ai',
    chaos: 0.1,
    layers: [
      L('patternBg', { pattern: 1, scale: 46, speed: 0.4, warp: 0.25, colorA: '#ff1fd2', colorB: '#59597a', thick: 0.5 }),
      L('neonHalo', { width: 30, fill: 0.9, line: 1, glow: 0.3, colorMode: 0, colorA: '#ff1a1a', colorB: '#f6ff00', wobble: 0.25 }),
      L('deepFry', { sharpen: 1.3, contrast: 1.35, sat: 2.0, crunch: 0.35, heat: 0.05 }),
      L('rgbSplit', { amount: 0.005, jitter: 0.5 }),
      L('blockGlitch', { amount: 0.06, blockSize: 40 }),
    ],
  },
  {
    id: 'wobble-lines',
    name: 'Wobble Lines',
    blurb: 'Jittery striped backdrop, rainbow halo, ghosting specimen',
    swatch: ['#e0a070', '#ff4fd8', '#00e5ff'],
    mask: 'ai',
    chaos: 0.15,
    layers: [
      L('patternBg', { pattern: 2, scale: 14, speed: 1.6, warp: 0.05, colorMode: 1, colorB: '#c77d4a', hueSpeed: 0.15 }),
      L('echo', { source: 1, decay: 0.7, hue: 0.09, dx: -0.006, dy: 0, every: 2 }),
      L('neonHalo', { width: 18, fill: 0.7, line: 0.8, glow: 0.5, colorMode: 1, speed: 1.2 }),
      L('acidHue', { spread: 0.9, speed: 0.15, sat: 1.7 }, { scope: 'subject' }),
      L('scanTear', { amount: 0.18, lineH: 5, shift: 0.04 }),
      L('rgbSplit', { amount: 0.006 }),
    ],
  },
  {
    id: 'rainbow-ghost',
    name: 'Rainbow Ghost',
    blurb: 'Hue-shifting echo copies of the subject over op-art waves',
    swatch: ['#00c853', '#ffeb3b', '#e040fb'],
    mask: 'ai',
    chaos: 0,
    layers: [
      L('patternBg', { pattern: 5, scale: 22, speed: 0.8, warp: 0.1, colorA: '#2bd94a', colorB: '#0a3d12', thick: 0.45 }),
      L('echo', { source: 1, decay: 0.86, hue: 0.12, dx: 0.008, dy: 0.004, zoom: 1.01, every: 3 }),
      L('rgbSplit', { amount: 0.007, angle: 20 }),
      L('deepFry', { sharpen: 0.8, contrast: 1.2, sat: 1.5, crunch: 0.15 }),
    ],
  },
  {
    id: 'pixel-drip',
    name: 'Pixel Drip',
    blurb: 'Melting columns + sorted streaks in glitch windows, pastel wash',
    swatch: ['#e7b7c8', '#a07a9b', '#f8e1d9'],
    mask: 'none',
    chaos: 0.05,
    layers: [
      L('pixelDrip', { mode: 0, dir: 0, line: 0.5, jag: 0.45, colw: 2, length: 1, speed: 0.6 }),
      L('pixelSort', { lo: 0.45, hi: 1, axis: 1, chunk: 512 }, { scope: 'windows', windows: 3 }),
      L('pixelDrip', { mode: 0, dir: 2, line: 0.4, jag: 0.6, colw: 4, length: 0.5, speed: 1.4 }, { scope: 'windows', windows: 2 }),
      L('gradientMap', { palette: 5, mix: 0.45, contrast: 1 }),
      L('grain', { grain: 0.05, vignette: 0.2 }),
    ],
  },
  {
    id: 'fashion-mosh',
    name: 'Fashion Mosh',
    blurb: 'Melting bodies, dripping hems, glitch bars over faces',
    swatch: ['#ffc107', '#ff4081', '#2979ff'],
    mask: 'ai',
    chaos: 0.1,
    layers: [
      // unclipped on purpose: on a flat backdrop only the bodies visibly melt, and the smears spill past the silhouette
      L('liquid', { amount: 0.03, map: 0, scale: 2.2, speed: 0.45, octaves: 2, direction: 0, rgb: 0.12 }, { mods: [{ param: 'amount', shape: 'noise', rate: 0.5, depth: 0.05 }] }),
      L('pixelDrip', { mode: 0, dir: 0, line: 0.84, jag: 0.25, colw: 3, length: 0.25, speed: 0.8 }, { mods: [{ param: 'line', shape: 'noise', rate: 0.6, depth: 0.12 }] }),
      L('blockGlitch', { amount: 0.08, blockSize: 36, aspect: 2.5, speed: 6, shift: 0.06, swap: 0.3 }, { scope: 'subject' }),
      L('censorBlocks', { count: 2, size: 90, aspect: 2.6, speed: 3, style: 0, onSubject: true, top: 1, pix: 12 }),
      L('rgbSplit', { amount: 0.0025, jitter: 0.7 }),
    ],
  },
  {
    id: 'mandala-trip',
    name: 'Mandala Trip',
    blurb: 'Kaleidoscope symmetry, cycling acid hues, neon edges',
    swatch: ['#7a00ff', '#00e5ff', '#ff4fd8'],
    mask: 'none',
    chaos: 0,
    layers: [
      L('kaleido', { mode: 3, segments: 8, spin: 0.12, zoom: 1.1 }),
      L('tunnel', { feedback: 0.7, zoom: 1.02, rotate: 0.006, hue: 0.2 }),
      L('acidHue', { spread: 1.4, speed: 0.2, sat: 1.8 }),
      L('edgeNeon', { amount: 1.1, threshold: 0.2, colorMode: 0, dim: 0.1 }),
    ],
  },
  {
    id: 'deep-fried',
    name: 'Deep Fried',
    blurb: 'Solarized specimen on static, posterized and crunchy',
    swatch: ['#ff0033', '#ff9a00', '#fff200'],
    mask: 'ai',
    chaos: 0.25,
    layers: [
      L('patternBg', { pattern: 4, scale: 15, speed: 1.2, colorA: '#ffffff', colorB: '#050505', thick: 0.5 }),
      L('solarize', { mode: 0, threshold: 0.55 }, { scope: 'subject' }),
      L('neonHalo', { width: 14, fill: 0.5, line: 1, glow: 0.6, colorMode: 2, colorA: '#ff00aa', colorB: '#00ffea', speed: 1.5 }),
      L('posterize', { levels: 5, dither: 0.1 }),
      L('deepFry', { sharpen: 1.8, contrast: 1.5, sat: 2.6, crunch: 0.6, heat: 0.3 }),
      L('echo', { source: 1, decay: 0.6, hue: 0.15, dx: 0.01, every: 1 }),
    ],
  },
  {
    id: 'checker-acid',
    name: 'Checker Acid',
    blurb: 'Red micro-checker backdrop, punchy cutout, color blocks',
    swatch: ['#c40018', '#0b0b0b', '#00e5ff'],
    mask: 'ai',
    chaos: 0.1,
    layers: [
      L('patternBg', { pattern: 0, scale: 18, speed: 0.3, warp: 0.05, colorA: '#c40018', colorB: '#140405' }),
      L('neonHalo', { width: 8, fill: 0.2, line: 0.9, glow: 0.2, colorA: '#000000', colorB: '#101010', wobble: 0 }),
      L('deepFry', { sharpen: 1.5, contrast: 1.4, sat: 2.2, crunch: 0.4 }),
      L('blockGlitch', { amount: 0.08, blockSize: 30, swap: 0.6 }),
      L('rgbSplit', { amount: 0.004 }),
    ],
  },
  {
    id: 'signal-loss',
    name: 'Signal Loss',
    blurb: 'Broken broadcast: tearing, time-sliced RGB, tape rot',
    swatch: ['#00ff6a', '#ff00ff', '#222222'],
    mask: 'none',
    chaos: 0.35,
    layers: [
      L('timeSlice', { mode: 0, delay: 3 }),
      L('scanTear', { amount: 0.3, lineH: 8, shift: 0.1 }),
      L('blockGlitch', { amount: 0.18, blockSize: 70, aspect: 4 }),
      L('vhs', { interlace: 0.5, tracking: 0.5, bleed: 0.6, noise: 0.3 }),
      L('grain', { grain: 0.08, scanlines: 0.4, vignette: 0.5 }),
    ],
  },
  {
    id: 'thermal-melt',
    name: 'Thermal Melt',
    blurb: 'Heat-map colors, slit-scan time warp, dripping brights',
    swatch: ['#3a00a0', '#ff0080', '#ffb000'],
    mask: 'none',
    chaos: 0.05,
    layers: [
      L('timeSlice', { mode: 1, spread: 0.8 }),
      L('pixelDrip', { mode: 1, dir: 0, length: 0.6, threshold: 0.6 }),
      L('gradientMap', { palette: 1, cycle: 0.2, contrast: 1.4 }),
      L('bloom', { intensity: 0.8, threshold: 0.55, radius: 20 }),
    ],
  },
];

export function buildLayers(preset) {
  return preset.layers.map((s) => makeLayer(s.id, s.params, JSON.parse(JSON.stringify(s.extra || {}))));
}
