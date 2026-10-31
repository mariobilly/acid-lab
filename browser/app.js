// Acid Lab UI: media, layer stack, inspector, looks, dice, transport, export.

import { Engine } from './engine.js';
import { EFFECTS, CATEGORIES, makeLayer, isNum, defaults, uid } from './effects/index.js';
import { PRESETS, buildLayers } from './presets.js';
import { exportVideo, seekVideo } from './export.js';
import { BeatDirector, defaultBeatCfg, EVERY, MODES } from './beat.js';
import { randomLayer as seededLayer, randomStackIds } from './random.js';

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const CAT_COLORS = { subject: '#ff2bd6', distort: '#00f0ff', time: '#ffb000', glitch: '#c6ff00', color: '#a66bff', finish: '#e8e8e8' };
const SCOPE_LABELS = { all: 'All', subject: 'Subject', background: 'BG', windows: 'Windows' };
const MOD_SHAPES = ['sine', 'triangle', 'saw', 'square', 'random', 'noise', 'audio-level', 'audio-bass', 'audio-high', 'audio-beat'];

function toast(msg, err = false, ms = 3800) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------------ state

const defaultState = () => ({
  layers: buildLayers(PRESETS[0]),
  chaos: PRESETS[0].chaos,
  seed: 7,
  look: PRESETS[0].name,
  mask: { mode: 'ai', threshold: 0.5, soft: 0.25, invert: false },
  out: { aspect: 'orig', fit: 'cover', zoom: 1 },
  beat: defaultBeatCfg(),
});
const ui = { selected: null, compare: 0, split: 0.5, showMask: false, muted: false };

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('acidlab.state'));
    if (!s || !Array.isArray(s.layers)) return null;
    s.layers = s.layers.filter((l) => EFFECTS[l.fx]).map((l) => ({ ...l, params: { ...defaults(EFFECTS[l.fx]), ...l.params } }));
    return { ...defaultState(), ...s, beat: { ...defaultBeatCfg(), ...(s.beat || {}) } };
  } catch {
    return null;
  }
}
let state = loadState() || defaultState();
const snapshot = () => JSON.stringify({ layers: state.layers, chaos: state.chaos, seed: state.seed, look: state.look, mask: state.mask, out: state.out, beat: state.beat });
let beatVersion = 0;   // bumped whenever anything Beat Sync depends on changes
const hist = { stack: [snapshot()], idx: 0 };
function commit() {
  beatVersion++;
  const s = snapshot();
  if (hist.stack[hist.idx] === s) return;
  hist.stack = hist.stack.slice(0, hist.idx + 1);
  hist.stack.push(s);
  if (hist.stack.length > 120) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  try { localStorage.setItem('acidlab.state', s); } catch {}
}
function restore(s) {
  state = { ...state, ...JSON.parse(s) };
  beatVersion++;
  try { localStorage.setItem('acidlab.state', s); } catch {}
  if (!state.layers.find((l) => l.uid === ui.selected)) ui.selected = state.layers[0]?.uid || null;
  engine.prune(state.layers);
  applyOutSize();
  renderAll();
}
const undo = () => { if (hist.idx > 0) restore(hist.stack[--hist.idx]); };
const redo = () => { if (hist.idx < hist.stack.length - 1) restore(hist.stack[++hist.idx]); };

// ------------------------------------------------------------------ engine + media

const canvas = $('canvas');
let engine;
try {
  engine = new Engine(canvas);
} catch (e) {
  document.body.innerHTML = `<div style="padding:40px;font-size:18px">WebGL2 failed to start: ${e.message}</div>`;
  throw e;
}

const video = document.createElement('video');
video.loop = true;
video.playsInline = true;
video.preload = 'auto';
video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
document.body.append(video);

let media = null;
let envelope = null;
// Beat Sync: a loaded song (master clock + soundtrack) or the video's own sound provides the beat grid
let music = null;
let musicEnv = null;
let grid = null;
let gridFor = null;
const musicEl = new Audio();
musicEl.preload = 'auto';
const director = new BeatDirector();
let image = null;
let playing = false;
let dirty = true;
let exporting = false;
let lastDrawn = -1;
const imgClock = { start: performance.now(), t: 0 };

const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = window.acidSrc ? window.acidSrc(src) : src; });   // web edition: files in memory

function setBusy(text, p) {
  $('busy').classList.toggle('hidden', text === null);
  if (text !== null) {
    $('busyText').textContent = text;
    $('busyBar').style.width = `${Math.round((p || 0) * 100)}%`;
  }
}

async function waitJob(id, onTick) {
  for (;;) {
    const j = await fetch(`/api/job/${id}`).then((r) => r.json());
    onTick?.(j);
    if (j.state === 'done') return j;
    if (j.state === 'error') throw new Error(j.message || 'failed');
    if (j.state === 'cancelled') return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function openJob(jobId) {
  setBusy('Preparing…', 0);
  try {
    const j = await waitJob(jobId, (s) => setBusy(s.message || 'Preparing…', s.progress));
    if (j) await (j.result.kind === 'audio' ? loadMusic(j.result) : loadMedia(j.result));
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(null);
  }
}

async function openPath(path) {
  const r = await post('/api/open', { path });
  if (r.error) return toast(r.error, true);
  await openJob(r.job);
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  setBusy(`Loading ${file.name}…`, 0);
  const r = await fetch('/api/upload', { method: 'POST', body: fd }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.error) { setBusy(null); return toast(r.error, true); }
  await openJob(r.job);
}

async function browse(musicOnly = false) {
  const r = await post('/api/browse', { music: musicOnly });
  if (r.cancelled) return;
  if (r.error) return toast(r.error, true);
  await openJob(r.job);
}

async function setVideoSrc(url, keepTime) {
  const t = keepTime ? video.currentTime : 0;
  const wasPlaying = playing;
  video.pause();
  video.src = window.acidSrc ? window.acidSrc(url) : url;   // web edition: files in memory
  await once(video, 'loadeddata');
  engine.setSource(video, media.width, media.height, url.includes('/packed'));
  if (t > 0) await seekVideo(video, t);
  if (wasPlaying || !keepTime) play(true);
  dirty = true;
}

async function loadMedia(m) {
  media = m;
  envelope = null;
  image = null;
  $('empty').classList.add('hidden');
  if (m.kind === 'video') {
    await setVideoSrc(`/api/media/${m.id}/${m.has_mask ? 'packed' : 'video'}?v=${Date.now()}`, false);
    if (m.has_envelope) envelope = await fetch(`/api/media/${m.id}/audio`).then((r) => r.json()).catch(() => null);
  } else {
    video.pause();
    video.removeAttribute('src');
    image = await loadImage(`/api/media/${m.id}/image?v=${Date.now()}`);
    engine.setSource(image, m.width, m.height, false);
    engine.setMaskImage(m.has_mask ? await loadImage(`/api/media/${m.id}/mask?v=${Date.now()}`) : null);
    imgClock.start = performance.now();
    imgClock.t = 0;
    play(true);
  }
  applyOutSize();
  renderMediaInfo();
  renderMaskUi();
  if (music) {
    musicEnv = await fetch(`/api/media/${music.id}/envelope?fps=${m.fps}`).then((r) => r.json()).catch(() => null);
    seekTimeline(0);
  }
  await ensureGrid();
  updateScrubMax();
  if (state.mask.mode === 'ai' && !m.has_mask && state.layers.some((l) => EFFECTS[l.fx]?.needsMask)) {
    toast('Using auto key for now — hit ✂ Cut out subject for a clean AI cutout.');
  }
  dirty = true;
}

function outSize() {
  let sw = media?.width || 1080, sh = media?.height || 1920;
  const a = state.out.aspect;
  if (a === 'orig') {
    const up = Math.max(1, 1080 / Math.min(sw, sh));
    const down = Math.min(1, 1920 / Math.max(sw * up, sh * up));
    return [sw * up * down, sh * up * down];
  }
  const [aw, ah] = a.split(':').map(Number);
  return aw <= ah ? [1080, (1080 * ah) / aw] : [(1080 * aw) / ah, 1080];
}
function applyOutSize() {
  const [w, h2] = outSize();
  engine.resize(w, h2);
  fitCanvas();
  dirty = true;
}

/** Scale the canvas (CSS only) to fit the stage while keeping the output aspect. */
function fitCanvas() {
  const vp = $('viewport');
  const aw = vp.clientWidth - 36, ah = vp.clientHeight - 36;
  const s = Math.min(aw / engine.w, ah / engine.h);
  canvas.style.width = `${Math.max(1, Math.floor(engine.w * s))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(engine.h * s))}px`;
  positionSplit();
}

function audioAt(f) {
  const env = music ? musicEnv : envelope;
  if (!env?.level) return [0, 0, 0, 0];
  const i = clamp(f, 0, env.level.length - 1);
  return [env.level[i], env.low[i], env.high[i], env.beat[i]];
}

// ------------------------------------------------------------------ timeline + clock
// With a song loaded the song is the clock: the timeline runs from the chosen start point to the song's end and
// the video loops underneath. Without one, the clip (or a 5 s loop for stills) is the timeline.

function timeline() {
  const fps = media?.fps || 30;
  if (music) {
    const d = Math.max(0.1, music.duration - (state.beat.start || 0));
    return { fps, duration: d, frames: Math.max(1, Math.floor(d * fps)) };
  }
  return { fps, duration: media?.duration || 5, frames: media?.frames || 150 };
}

function nowT() {
  if (music) return Math.max(0, musicEl.currentTime - (state.beat.start || 0));
  if (media?.kind === 'video') return video.currentTime;
  return imgClock.t;
}

function currentFrame() {
  if (!media) return 0;
  const tl = timeline();
  return clamp(Math.floor(nowT() * tl.fps + 1e-3), 0, tl.frames - 1);
}

function updateScrubMax() {
  $('scrub').max = Math.max(0, timeline().frames - 1);
}

/** Jump the whole timeline (song + looping clip) to t seconds. */
async function seekTimeline(t) {
  if (!media) return;
  const tl = timeline();
  t = clamp(t, 0, tl.duration - 1 / tl.fps);
  if (music) musicEl.currentTime = (state.beat.start || 0) + t;
  if (media.kind === 'video') {
    const src = music ? t % media.duration : t;
    await seekVideo(video, Math.min(src, media.duration - 0.5 / media.fps));
  } else imgClock.t = t % media.duration;
  if (media.kind === 'image' && playing) imgClock.start = performance.now() - imgClock.t * 1000;
  dirty = true;
}

/** Keep the looping clip under the song (only nudge on real drift, never fight the clip's own loop). */
function syncVideoToMusic() {
  if (!music || media?.kind !== 'video' || video.seeking) return;
  const target = nowT() % media.duration;
  const d = Math.abs(video.currentTime - target);
  if (d > 0.12 && d < media.duration - 0.12) video.currentTime = target;
  if (playing && video.paused) video.play().catch(() => {});
}

function lookPool() {
  const all = [...PRESETS, ...userLooks.map((l) => ({ ...l, user: true }))];
  const pool = state.beat.pool;
  const chosen = pool ? all.filter((l) => pool.includes(l.name)) : all;
  return chosen.length ? chosen : all;
}

function beatContext() {
  director.update({
    grid: state.beat.on ? grid : null, cfg: state.beat, base: state.layers, pool: lookPool(),
    subject: state.mask.mode !== 'none', seed: state.seed, version: beatVersion,
  });
}

function renderOpts(frame, t, clean = false) {
  beatContext();
  const live = state.beat.on && grid;
  const fps = timeline().fps;
  // a cut takes effect on the frame nearest to it
  const seg = live ? director.at(t + 0.5 / fps) : null;
  const audio = audioAt(frame);
  if (grid) audio[3] = director.beatEnv(t);   // the musical beat grid beats raw onset detection
  return {
    layers: seg ? seg.layers : state.layers, seed: seg ? seg.seed : state.seed, chaos: state.chaos,
    punch: live ? state.beat.punch : 0, maskCfg: state.mask, fit: state.out.fit, zoom: state.out.zoom, frame, time: t, audio,
    compare: clean ? 0 : ui.compare, split: ui.split, showMask: clean ? false : ui.showMask, seg,
  };
}

let lastCut = -2;
function tick() {
  requestAnimationFrame(tick);
  if (exporting || !media) return;
  if (media.kind === 'image' && playing && !music) {
    imgClock.t = ((performance.now() - imgClock.start) / 1000) % media.duration;
  }
  syncVideoToMusic();
  const f = currentFrame();
  if (f === lastDrawn && !dirty) return;
  const tl = timeline();
  const o = renderOpts(f, f / tl.fps);
  try {
    engine.render(o);
  } catch (e) {
    console.error(e);
    toast('Render error: ' + e.message, true);
  }
  lastDrawn = f;
  dirty = false;
  $('scrub').value = f;
  $('time').textContent = `${fmtTime(f / tl.fps)} / ${fmtTime(tl.duration)}`;
  updateBeatHud(o, f / tl.fps);
  if ((o.seg?.cut ?? -1) !== lastCut) lastCut = o.seg?.cut ?? -1;
}
requestAnimationFrame(tick);

function play(on) {
  playing = on ?? !playing;
  if (music) {
    if (playing) musicEl.play().catch(() => {});
    else musicEl.pause();
  }
  if (media?.kind === 'video') {
    video.muted = !!music || ui.muted;
    if (playing) video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    else video.pause();
  } else if (playing && !music) imgClock.start = performance.now() - imgClock.t * 1000;
  $('play').textContent = playing ? '❚❚' : '▶';
  dirty = true;
}

async function gotoFrame(f) {
  if (!media) return;
  const tl = timeline();
  play(false);
  await seekTimeline((clamp(f, 0, tl.frames - 1) + 0.5) / tl.fps);
}

// ------------------------------------------------------------------ music + Beat Sync

async function loadMusic(m) {
  music = m;
  musicEl.src = window.acidSrc(`/api/media/${m.id}/music`);   // web edition: files in memory
  musicEl.muted = ui.muted;
  state.beat.start = 0;
  grid = await fetch(`/api/beats/${m.id}`).then((r) => r.json()).catch(() => null);
  if (!grid?.beats) grid = null;
  gridFor = m.id;
  if (media) musicEnv = await fetch(`/api/media/${m.id}/envelope?fps=${media.fps}`).then((r) => r.json()).catch(() => null);
  state.beat.on = true;
  commit();
  updateScrubMax();
  renderBeatUi();
  if (media) {
    await seekTimeline(0);
    play(true);
  }
  toast(grid ? `♫ ${m.name} · ${Math.round(grid.tempo)} BPM · ${grid.beats.length} beats — Beat Sync on`
    : `♫ ${m.name} loaded, but I couldn't find a steady beat`, false, 5000);
}

function removeMusic() {
  musicEl.pause();
  musicEl.removeAttribute('src');
  music = null;
  musicEnv = null;
  grid = null;
  gridFor = null;
  state.beat.start = 0;
  commit();
  if (media?.kind === 'video') {
    video.muted = ui.muted;
    if (playing) video.play().catch(() => {});
  }
  ensureGrid();
  updateScrubMax();
  renderBeatUi();
  dirty = true;
}

/** Without a song, Beat Sync follows the clip's own soundtrack. */
async function ensureGrid() {
  if (music) return;
  if (!state.beat.on || !media?.audio) {
    renderBeatUi();
    return;
  }
  if (gridFor === media.id && grid) return;
  setBusy('Finding the beat…', 0.5);
  try {
    const g = await fetch(`/api/beats/${media.id}`).then((r) => r.json());
    grid = g.beats ? g : null;
    gridFor = media.id;
  } catch {
    grid = null;
  }
  setBusy(null);
  renderBeatUi();
  dirty = true;
}

function setBeat(patch, doCommit = true) {
  Object.assign(state.beat, patch);
  beatVersion++;
  if (doCommit) commit();
  dirty = true;
}

/** Turn the current random cut into your own stack (and stop randomizing). */
function keepCurrentCut() {
  const f = currentFrame();
  const o = renderOpts(f, f / timeline().fps);
  if (!o.seg) return;
  state.layers = o.seg.layers.map((l) => ({ ...JSON.parse(JSON.stringify(l)), uid: uid() }));
  state.seed = o.seg.seed;
  state.look = o.seg.label;
  state.beat.on = false;
  ui.selected = state.layers[0]?.uid || null;
  commit();
  renderAll();
  toast(`Kept “${o.seg.label}” as your stack — Beat Sync paused`);
}

function updateBeatHud(o, t) {
  const hud = $('beatHud');
  const live = state.beat.on && grid;
  hud.classList.toggle('hidden', !live);
  if (!live) return;
  const env = director.beatEnv(t);
  $('beatDot').style.transform = `scale(${1 + env * 1.4})`;
  $('beatDot').style.opacity = 0.35 + env * 0.65;
  const n = director.cuts.length;
  $('beatLabel').textContent = o.seg && o.seg.cut >= 0 ? `cut ${o.seg.cut + 1}/${n} · ${o.seg.label}` : o.seg?.label || '';
  $('beatKeep').classList.toggle('hidden', !(o.seg && o.seg.cut >= 0 && !['seed', 'single'].includes(state.beat.mode)));
}

// ------------------------------------------------------------------ media + mask panel

function renderMediaInfo() {
  $('mediaName').textContent = media ? media.name : 'no media';
  const box = $('mediaInfo');
  box.innerHTML = '';
  if (!media) return;
  const [ow, oh] = outSize().map((v) => Math.round(v / 2) * 2);
  const rows = [
    ['type', media.kind],
    ['source', `${media.width}×${media.height}`],
    ['output', `${ow}×${oh}`],
    ['fps', media.fps],
    ['length', media.kind === 'video' ? `${media.duration.toFixed(2)} s · ${media.frames} fr` : 'still (animated)'],
    ['audio', media.audio ? (envelope ? 'yes · beat-reactive' : 'yes') : 'none'],
  ];
  for (const [k, v] of rows) box.append(h('span', {}, k), h('b', {}, v));
}

function renderMaskUi() {
  document.querySelectorAll('#maskMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.mask.mode));
  $('maskTh').value = state.mask.threshold;
  $('maskThV').textContent = state.mask.threshold.toFixed(2);
  $('maskSoft').value = state.mask.soft;
  $('maskSoftV').textContent = state.mask.soft.toFixed(2);
  $('maskInv').checked = !!state.mask.invert;
  $('maskShow').checked = ui.showMask;
  const tag = $('maskTag');
  const ready = media?.has_mask;
  tag.textContent = !media ? '—' : ready ? 'AI cutout ready' : state.mask.mode === 'ai' ? 'auto key (no AI yet)' : state.mask.mode;
  tag.classList.toggle('ok', !!ready);
  $('cutBtn').disabled = !media;
  $('cutBtn').textContent = ready ? '✂ Redo AI cutout' : '✂ Cut out subject';
}

let cutJob = null;
async function cutOut() {
  if (!media || cutJob) return;
  if (media.has_mask && !confirmInline($('cutBtn'), 'Run the AI cutout again?')) return;
  const r = await post(`/api/mask/${media.id}`);
  if (!r.job) return toast(r.error || 'could not start cutout', true);
  cutJob = r.job;
  const bar = $('cutProg');
  bar.classList.remove('hidden');
  $('cutBtn').disabled = true;
  try {
    const j = await waitJob(r.job, (s) => {
      bar.querySelector('i').style.width = `${Math.round(s.progress * 100)}%`;
      bar.querySelector('span').textContent = s.message || `${Math.round(s.progress * 100)}%`;
    });
    if (j) {
      media = j.result;
      state.mask.mode = 'ai';
      commit();
      if (media.kind === 'video') await setVideoSrc(`/api/media/${media.id}/packed?v=${Date.now()}`, true);
      else engine.setMaskImage(await loadImage(`/api/media/${media.id}/mask?v=${Date.now()}`));
      toast('Subject cut out ✓');
    }
  } catch (e) {
    toast('Cutout failed: ' + e.message, true, 7000);
  } finally {
    cutJob = null;
    bar.classList.add('hidden');
    renderMaskUi();
    dirty = true;
  }
}

/** Two-click confirm on a button (no blocking browser dialogs). */
const armed = new WeakMap();
function confirmInline(btn, text) {
  if (armed.get(btn)) { armed.delete(btn); return true; }
  const old = btn.textContent;
  armed.set(btn, true);
  btn.textContent = text;
  setTimeout(() => { armed.delete(btn); renderMaskUi(); if (btn.textContent === text) btn.textContent = old; }, 2500);
  return false;
}

// ------------------------------------------------------------------ looks

let userLooks = [];
async function loadUserLooks() {
  userLooks = await fetch('/api/presets').then((r) => r.json()).catch(() => []);
  beatVersion++;
  renderLooks();
  renderBeatUi();
}
const saveUserLooks = () => { beatVersion++; renderBeatUi(); return post('/api/presets', userLooks); };

function applyLook(p, user = false) {
  state.layers = user
    ? p.layers.filter((l) => EFFECTS[l.fx]).map((l) => ({ ...JSON.parse(JSON.stringify(l)), uid: uid() }))
    : buildLayers(p);
  state.chaos = p.chaos ?? 0;
  if (p.mask) state.mask.mode = p.mask;
  state.look = p.name;
  ui.selected = state.layers[0]?.uid || null;
  engine.prune(state.layers);
  engine.reset();
  commit();
  renderAll();
  if (media && p.mask === 'ai' && !media.has_mask) toast('Tip: ✂ Cut out subject gives this look a clean AI edge.');
}

function renderLooks() {
  const box = $('looks');
  box.innerHTML = '';
  const card = (p, user) =>
    h('button', { class: 'look' + (state.look === p.name ? ' on' : ''), title: p.blurb || p.name, onclick: () => applyLook(p, user) },
      h('div', { class: 'sw', style: `background:linear-gradient(120deg,${(p.swatch || ['#ff2bd6', '#c6ff00', '#00f0ff']).join(',')})` }),
      h('div', { class: 'nm' }, p.name),
      user && h('span', {
        class: 'del', title: 'Delete this look',
        onclick: (e) => { e.stopPropagation(); userLooks = userLooks.filter((x) => x !== p); saveUserLooks(); renderLooks(); },
      }, '✕'));
  PRESETS.forEach((p) => box.append(card(p, false)));
  if (userLooks.length) {
    box.append(h('div', { class: 'look-sep' }, 'My looks'));
    userLooks.forEach((p) => box.append(card(p, true)));
  }
}

function saveLookForm() {
  const box = $('looks');
  if (box.querySelector('.save-form')) return;
  const inp = h('input', { type: 'text', placeholder: 'Name this look', value: state.look?.startsWith('Dice') ? '' : '' });
  const save = () => {
    const name = inp.value.trim();
    if (!name) return form.remove();
    const cols = state.layers.flatMap((l) => Object.values(l.params).filter((v) => typeof v === 'string' && v.startsWith('#'))).slice(0, 3);
    userLooks.push({ name, layers: JSON.parse(JSON.stringify(state.layers)), chaos: state.chaos, mask: state.mask.mode,
      swatch: cols.length >= 2 ? cols : ['#ff2bd6', '#c6ff00', '#00f0ff'] });
    state.look = name;
    saveUserLooks();
    renderLooks();
    toast(`Saved look “${name}”`);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') form.remove(); e.stopPropagation(); });
  const form = h('div', { class: 'save-form', style: 'grid-column:1/-1;display:flex;gap:6px' }, inp,
    h('button', { class: 'mini acid', onclick: save }, 'save'));
  box.prepend(form);
  inp.focus();
}

// ------------------------------------------------------------------ dice

const randomLayer = (id) => seededLayer(id, Math.random);

function dice() {
  const ids = randomStackIds(Math.random, state.mask.mode !== 'none');
  state.layers = ids.map(randomLayer);
  state.seed = Math.floor(Math.random() * 1000);
  state.look = `Dice #${state.seed}`;
  ui.selected = state.layers[0]?.uid;
  engine.prune(state.layers);
  engine.reset();
  commit();
  renderAll();
}

// ------------------------------------------------------------------ layers

function scopeBadge(l) {
  return h('span', { class: 'sc ' + (l.scope || 'all') }, SCOPE_LABELS[l.scope] || 'All');
}

let dragUid = null;
function renderLayers() {
  const ol = $('layers');
  ol.innerHTML = '';
  $('layerCount').textContent = state.layers.length ? `${state.layers.length}` : '';
  if (!state.layers.length) {
    ol.append(h('li', { class: 'empty-layers' }, 'No effects yet — pick a look, roll the 🎲, or + Add effect'));
  }
  state.layers.forEach((l) => {
    const fx = EFFECTS[l.fx];
    const li = h('li', {
      class: `layer${l.uid === ui.selected ? ' sel' : ''}${l.on ? '' : ' off'}`, draggable: true,
      onclick: () => { ui.selected = l.uid; renderLayers(); renderInspector(); },
      ondragstart: (e) => { dragUid = l.uid; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { e.preventDefault(); li.classList.add('drag-over'); },
      ondragleave: () => li.classList.remove('drag-over'),
      ondrop: (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        if (!dragUid || dragUid === l.uid) return;
        const from = state.layers.findIndex((x) => x.uid === dragUid);
        const [m] = state.layers.splice(from, 1);
        state.layers.splice(state.layers.findIndex((x) => x.uid === l.uid), 0, m);
        dragUid = null;
        commit();
        renderLayers();
        dirty = true;
      },
    },
      h('span', { class: 'grip', title: 'Drag to reorder' }, '⋮⋮'),
      h('button', { class: 'eye', title: 'Toggle', onclick: (e) => { e.stopPropagation(); l.on = !l.on; commit(); renderLayers(); dirty = true; } }, l.on ? '◉' : '○'),
      h('span', { class: 'nm' }, h('i', { class: 'cat-dot', style: `background:${CAT_COLORS[fx.cat]}` }), fx.name,
        l.mix < 0.999 ? h('small', {}, `${Math.round(l.mix * 100)}%`) : null,
        isBeatTarget(l) ? h('span', { class: 'beat-badge', title: 'Fires on the beat (Beat Sync)' }, '♪') : null),
      scopeBadge(l),
      h('button', { class: 'solo' + (l.solo ? ' on' : ''), title: 'Solo', onclick: (e) => { e.stopPropagation(); l.solo = !l.solo; commit(); renderLayers(); dirty = true; } }, 'S'),
      h('button', { class: 'x', title: 'Remove (Del)', onclick: (e) => { e.stopPropagation(); removeLayer(l.uid); } }, '✕'));
    ol.append(li);
  });
  if (state.beat.mode === 'single') renderBeatTarget();
}

const isBeatTarget = (l) => state.beat.on && state.beat.mode === 'single' && state.beat.target === l.uid;

/** Make `l` the one effect that fires on the beat. */
function fireOnBeat(l) {
  setBeat({ on: true, mode: 'single', target: l.uid });
  ensureGrid();
  renderBeatUi();
  renderLayers();
  renderInspector();
  if (!music && !media?.audio) toast('Load a song (♫ in Beat Sync) so it has a beat to follow.', false, 4500);
  else toast(`${EFFECTS[l.fx].name} now fires on every ${state.beat.every} — the rest of your stack stays put`, false, 3500);
}

function removeLayer(id) {
  const i = state.layers.findIndex((x) => x.uid === id);
  if (i < 0) return;
  state.layers.splice(i, 1);
  if (ui.selected === id) ui.selected = state.layers[Math.min(i, state.layers.length - 1)]?.uid || null;
  engine.prune(state.layers);
  commit();
  renderLayers();
  renderInspector();
  dirty = true;
}

function addLayer(id) {
  const l = makeLayer(id);
  const fx = EFFECTS[id];
  if (fx.cat === 'subject') {
    // subject effects go first so later effects glitch the whole composite
    let i = 0;
    while (i < state.layers.length && EFFECTS[state.layers[i].fx].cat === 'subject') i++;
    state.layers.splice(i, 0, l);
  } else state.layers.push(l);
  ui.selected = l.uid;
  commit();
  renderLayers();
  renderInspector();
  dirty = true;
  if (fx.needsMask && media && !media.has_mask && state.mask.mode === 'ai') toast('Subject effects work best after ✂ Cut out subject.');
  if (fx.needsMask && state.mask.mode === 'none') toast('Subject cutout is Off — switch it to AI or Key to see this effect.');
  return l;
}

function renderAddMenu() {
  const menu = $('addMenu');
  menu.innerHTML = '';
  for (const c of CATEGORIES) {
    menu.append(h('div', { class: 'mc' }, h('i', { class: 'cat-dot', style: `background:${CAT_COLORS[c.id]}` }), c.name, c.hint ? ` · ${c.hint}` : ''));
    for (const fx of Object.values(EFFECTS).filter((e) => e.cat === c.id)) {
      menu.append(h('button', { onclick: () => { menu.classList.add('hidden'); addLayer(fx.id); } }, fx.name));
    }
  }
}

// ------------------------------------------------------------------ inspector

function fmtVal(p, v) {
  if (!isNum(p)) return '';
  if (p.step === 1) return String(Math.round(v));
  const r = p.max - p.min;
  return r >= 100 ? v.toFixed(0) : r >= 10 ? v.toFixed(1) : r >= 1 ? v.toFixed(2) : v.toFixed(3);
}

function numberRow(label, p, get, set, animated = false) {
  const val = h('span', { class: 'val', title: 'Double-click to type a value' }, fmtVal(p, get()));
  const step = p.step || (p.max - p.min) / 1000;
  const range = h('input', {
    type: 'range', min: p.min, max: p.max, step, value: get(),
    oninput: () => { set(Number(range.value)); val.textContent = fmtVal(p, Number(range.value)); dirty = true; },
    onchange: () => commit(),
    ondblclick: () => { set(p.def); range.value = p.def; val.textContent = fmtVal(p, p.def); dirty = true; commit(); },
  });
  val.addEventListener('dblclick', () => {
    const inp = h('input', { type: 'number', value: get(), step });
    const done = () => {
      const v = clamp(Number(inp.value), p.min, p.max);
      if (!Number.isNaN(v)) { set(v); range.value = v; commit(); dirty = true; }
      val.textContent = fmtVal(p, get());
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('blur', done);
    val.textContent = '';
    val.append(inp);
    inp.select();
  });
  return h('div', { class: 'prow' + (animated ? ' animated' : ''), title: 'Double-click the slider to reset' }, h('label', {}, label), range, val);
}

function renderInspector() {
  const box = $('inspector');
  box.innerHTML = '';
  const l = state.layers.find((x) => x.uid === ui.selected);
  if (!l) {
    box.append(h('div', { class: 'insp-empty' },
      h('div', {}, 'Select a layer to tweak it.'),
      h('div', {}, h('b', {}, 'Space'), ' play · ', h('b', {}, '← →'), ' step · ', h('b', {}, 'D'), ' dice'),
      h('div', {}, h('b', {}, 'C'), ' compare · ', h('b', {}, 'M'), ' mask · ', h('b', {}, 'E'), ' export')));
    return;
  }
  const fx = EFFECTS[l.fx];
  box.append(h('div', { class: 'insp-title' }, h('i', { class: 'cat-dot', style: `background:${CAT_COLORS[fx.cat]}` }), fx.name,
    h('small', {}, fx.cat),
    h('button', { class: 'mini', style: 'margin-left:auto', title: 'Duplicate layer', onclick: () => {
      const c = { ...JSON.parse(JSON.stringify(l)), uid: uid() };
      state.layers.splice(state.layers.indexOf(l) + 1, 0, c);
      ui.selected = c.uid; commit(); renderLayers(); renderInspector(); dirty = true;
    } }, '⧉'),
    h('button', {
      class: 'mini' + (isBeatTarget(l) ? ' beat-on' : ''), title: 'Fire only this effect on the beat (Beat Sync)',
      onclick: () => (isBeatTarget(l) ? (setBeat({ on: false }), renderBeatUi(), renderLayers(), renderInspector()) : fireOnBeat(l)),
    }, '♪'),
    h('button', { class: 'mini', title: 'Randomize this layer', onclick: () => {
      const r = randomLayer(l.fx);
      l.params = { ...l.params, ...r.params }; commit(); renderInspector(); dirty = true;
    } }, '🎲'),
    h('button', { class: 'mini', title: 'Reset parameters', onclick: () => { l.params = defaults(fx); l.mods = []; commit(); renderInspector(); dirty = true; } }, '↺')));

  if (fx.needsMask && state.mask.mode === 'none') box.append(h('div', { class: 'note' }, 'Subject cutout is Off, so this effect has nothing to work with. Set it to AI or Key (left panel).'));
  else if (fx.needsMask && media && !media.has_mask && state.mask.mode === 'ai') box.append(h('div', { class: 'note' }, 'Using auto key until you run ✂ Cut out subject.'));

  box.append(h('div', { class: 'insp-sec' }, 'Layer'));
  box.append(numberRow('mix', { min: 0, max: 1, def: 1 }, () => l.mix, (v) => { l.mix = v; }));
  const seg = h('div', { class: 'seg small', style: 'grid-column:2/4' });
  for (const [k, lab] of Object.entries(SCOPE_LABELS)) {
    seg.append(h('button', { class: (l.scope || 'all') === k ? 'on' : '', title: k === 'windows' ? 'Only inside random glitch windows' : `Apply to ${k}`,
      onclick: () => { l.scope = k; commit(); renderInspector(); renderLayers(); dirty = true; } }, lab));
  }
  box.append(h('div', { class: 'prow' }, h('label', {}, 'apply to'), seg));
  if (l.scope === 'windows') box.append(numberRow('windows', { min: 1, max: 8, step: 1, def: 4 }, () => l.windows ?? 4, (v) => { l.windows = v; }));

  box.append(h('div', { class: 'insp-sec' }, 'Parameters'));
  const animatedKeys = new Set((l.mods || []).filter((m) => m.shape !== 'off').map((m) => m.param));
  for (const p of fx.params) {
    const label = p.label || p.key;
    if (isNum(p)) box.append(numberRow(label, p, () => l.params[p.key], (v) => { l.params[p.key] = v; }, animatedKeys.has(p.key)));
    else if (p.type === 'select') {
      const sel = h('select', { onchange: () => { l.params[p.key] = Number(sel.value); commit(); dirty = true; } },
        Object.entries(p.options).map(([k, v]) => h('option', { value: v, selected: Number(l.params[p.key]) === Number(v) }, k)));
      box.append(h('div', { class: 'prow' }, h('label', {}, label), sel));
    } else if (p.type === 'color') {
      const inp = h('input', { type: 'color', value: l.params[p.key], oninput: () => { l.params[p.key] = inp.value; dirty = true; }, onchange: () => commit() });
      box.append(h('div', { class: 'prow' }, h('label', {}, label), inp));
    } else if (p.type === 'bool') {
      const cb = h('input', { type: 'checkbox', checked: !!l.params[p.key], onchange: () => { l.params[p.key] = cb.checked; commit(); dirty = true; } });
      box.append(h('div', { class: 'prow' }, h('label', {}, label), h('label', { class: 'chk' }, cb, 'on')));
    }
  }

  box.append(h('div', { class: 'insp-sec' }, 'Animate'));
  const numParams = fx.params.filter(isNum);
  (l.mods || []).forEach((m, i) => {
    const pSel = h('select', { onchange: () => { m.param = pSel.value; commit(); renderInspector(); dirty = true; } },
      numParams.map((p) => h('option', { value: p.key, selected: m.param === p.key }, p.label || p.key)));
    const sSel = h('select', { onchange: () => { m.shape = sSel.value; commit(); dirty = true; } },
      MOD_SHAPES.map((s) => h('option', { value: s, selected: m.shape === s }, s)));
    const rate = h('input', { type: 'range', min: 0.05, max: 8, step: 0.01, value: m.rate,
      oninput: () => { m.rate = Number(rate.value); rv.textContent = `${m.rate.toFixed(2)}Hz`; dirty = true; }, onchange: commit });
    const rv = h('b', {}, `${Number(m.rate).toFixed(2)}Hz`);
    const depth = h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: m.depth,
      oninput: () => { m.depth = Number(depth.value); dv.textContent = `${Math.round(m.depth * 100)}%`; dirty = true; }, onchange: commit });
    const dv = h('b', {}, `${Math.round(m.depth * 100)}%`);
    box.append(h('div', { class: 'mod' }, pSel, sSel,
      h('button', { class: 'x', title: 'Remove', onclick: () => { l.mods.splice(i, 1); commit(); renderInspector(); dirty = true; } }, '✕'),
      h('div', { class: 'full' }, 'rate', rate, rv),
      h('div', { class: 'full' }, 'depth', depth, dv)));
  });
  if (numParams.length) {
    box.append(h('button', { class: 'mini', style: 'align-self:flex-start', onclick: () => {
      l.mods = l.mods || [];
      const key = fx.key && numParams.some((p) => p.key === fx.key) ? fx.key : numParams[0].key;
      l.mods.push({ param: key, shape: media?.audio && envelope ? 'audio-beat' : 'sine', rate: 0.5, depth: 0.25 });
      commit(); renderInspector(); dirty = true;
    } }, '+ animate a parameter (LFO / audio)'));
    if ((l.mods || []).some((m) => m.shape.startsWith('audio')) && !envelope) box.append(h('div', { class: 'note' }, 'This media has no audio, so audio modulation stays at 0.'));
  }
}

function renderTop() {
  $('chaos').value = state.chaos;
  $('chaosVal').textContent = state.chaos.toFixed(2);
  $('aspect').value = state.out.aspect;
  $('fit').value = state.out.fit;
  $('zoom').value = state.out.zoom;
  document.querySelectorAll('#compare button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === ui.compare));
  $('splitHandle').classList.toggle('hidden', ui.compare !== 1 || !media);
  positionSplit();
}

function renderAll() {
  renderTop();
  renderBeatUi();
  renderLooks();
  renderLayers();
  renderInspector();
  renderMaskUi();
  renderMediaInfo();
  dirty = true;
}

function positionSplit() {
  const r = canvas.getBoundingClientRect();
  const vp = $('viewport').getBoundingClientRect();
  const hnd = $('splitHandle');
  hnd.style.left = `${r.left - vp.left + r.width * ui.split}px`;
  hnd.style.top = `${r.top - vp.top}px`;
  hnd.style.bottom = 'auto';
  hnd.style.height = `${r.height}px`;
}

// ------------------------------------------------------------------ export

let cancelExport = false;
let lastOut = null;
function openExport() {
  if (!media) return toast('Open a video or image first.', true);
  play(false);
  const m = $('exportModal');
  m.classList.remove('hidden');
  $('exForm').classList.remove('hidden');
  $('exRun').classList.add('hidden');
  $('exDone').classList.add('hidden');
  $('exName').value = media.name;
  $('exAudioRow').classList.toggle('hidden', !(music || (media.kind === 'video' && media.audio)));
  $('exAudioLbl').textContent = music ? `use the song (${music.name})` : 'keep original audio';
  // a song sets the length (the clip loops under it); Reels max out at 90 s by default
  const free = !!music || media.kind === 'image';
  $('exDurRow').classList.toggle('hidden', !free);
  if (free) {
    const max = music ? timeline().duration : 60;
    $('exDur').max = max.toFixed(1);
    $('exDur').value = (music ? Math.min(max, 90) : 5).toFixed(1);
  }
  updateExMeta();
}
function exFrames() {
  if (!music && media.kind !== 'image') return media.frames;
  const tl = timeline();
  const n = Math.max(1, Math.round(Number($('exDur').value || 5) * tl.fps));
  return music ? Math.min(n, tl.frames) : n;
}
function updateExMeta() {
  const fps = timeline().fps;
  const n = exFrames();
  let beat = '';
  if (state.beat.on && grid) {
    beatContext();
    const cuts = director.cuts.filter((t) => t < n / fps).length;
    beat = ` · ♪ ${cuts} beat cuts`;
  }
  $('exMeta').textContent = `${engine.w}×${engine.h} · ${fps} fps · ${n} frames · ${(n / fps).toFixed(2)} s${beat} · H.264 MP4\n→ Videos\\Acid Lab`;
}

async function runExport() {
  $('exForm').classList.add('hidden');
  $('exRun').classList.remove('hidden');
  exporting = true;
  cancelExport = false;
  const frames = exFrames();
  const keepT = nowT();
  musicEl.pause();
  try {
    const res = await exportVideo({
      engine, media, fps: timeline().fps, frames, video: media.kind === 'video' ? video : null,
      // with a song the clip loops underneath it
      sourceTime: (i) => ((i % media.frames) + 0.5) / media.fps,
      music, musicStart: state.beat.start || 0,
      name: $('exName').value || media.name, preset: state.beat.on && grid ? `${state.look || 'custom'} beat-sync` : state.look || 'custom',
      quality: $('exQuality').value, audio: $('exAudio').checked,
      renderFrame: (i, t) => engine.render(renderOpts(i, t, true)),
      onProgress: (i, n, rate) => {
        $('exBar').style.width = `${(i / n) * 100}%`;
        const eta = (n - i) / Math.max(rate, 0.01);
        $('exStat').textContent = `frame ${i} / ${n} · ${rate.toFixed(1)} fps · ${eta < 60 ? eta.toFixed(0) + ' s' : (eta / 60).toFixed(1) + ' min'} left`;
      },
      isCancelled: () => cancelExport,
    });
    if (res.cancelled) {
      $('exportModal').classList.add('hidden');
      toast('Export cancelled');
    } else {
      lastOut = res.out;
      $('exRun').classList.add('hidden');
      $('exDone').classList.remove('hidden');
      $('exPath').textContent = res.out;
    }
  } catch (e) {
    $('exportModal').classList.add('hidden');
    toast('Export failed: ' + e.message, true, 8000);
  } finally {
    exporting = false;
    engine.reset();
    await seekTimeline(keepT);
    dirty = true;
  }
}

async function saveStill() {
  const f = currentFrame();
  engine.render(renderOpts(f, f / timeline().fps, true));
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  dirty = true;
  const r = await fetch(`/api/still?name=${encodeURIComponent($('exName').value || media.name)}`, { method: 'POST', body: blob }).then((x) => x.json());
  if (r.ok) {
    lastOut = r.out;
    $('exForm').classList.add('hidden');
    $('exDone').classList.remove('hidden');
    $('exPath').textContent = r.out;
  } else toast('Could not save the still', true);
}

// ------------------------------------------------------------------ wiring

$('openBtn').onclick = browse;
$('cutBtn').onclick = cutOut;
$('dice').onclick = dice;
$('reseed').onclick = () => { state.seed = Math.floor(Math.random() * 1000); commit(); dirty = true; toast(`Seed ${state.seed}`, false, 1200); };
$('undo').onclick = undo;
$('redo').onclick = redo;
$('play').onclick = () => media && play();
$('stepB').onclick = () => gotoFrame(currentFrame() - 1);
$('stepF').onclick = () => gotoFrame(currentFrame() + 1);
$('mute').onclick = () => {
  ui.muted = !ui.muted;
  musicEl.muted = ui.muted;
  video.muted = !!music || ui.muted;
  $('mute').textContent = ui.muted ? '🔇' : '🔊';
};
$('scrub').oninput = () => {
  if (!media) return;
  seekTimeline((Number($('scrub').value) + 0.5) / timeline().fps);
};
$('chaos').oninput = () => { state.chaos = Number($('chaos').value); $('chaosVal').textContent = state.chaos.toFixed(2); dirty = true; };
$('chaos').onchange = commit;
$('aspect').onchange = () => { state.out.aspect = $('aspect').value; applyOutSize(); renderMediaInfo(); commit(); requestAnimationFrame(positionSplit); };
$('fit').onchange = () => { state.out.fit = $('fit').value; commit(); dirty = true; };
$('zoom').oninput = () => { state.out.zoom = Number($('zoom').value); dirty = true; };
$('zoom').onchange = commit;
$('zoom').ondblclick = () => { state.out.zoom = 1; $('zoom').value = 1; commit(); dirty = true; };
document.querySelectorAll('#compare button').forEach((b) => (b.onclick = () => { ui.compare = Number(b.dataset.v); renderTop(); dirty = true; }));
document.querySelectorAll('#maskMode button').forEach((b) => (b.onclick = () => { state.mask.mode = b.dataset.v; commit(); renderMaskUi(); renderInspector(); dirty = true; }));
$('maskTh').oninput = () => { state.mask.threshold = Number($('maskTh').value); $('maskThV').textContent = state.mask.threshold.toFixed(2); dirty = true; };
$('maskSoft').oninput = () => { state.mask.soft = Number($('maskSoft').value); $('maskSoftV').textContent = state.mask.soft.toFixed(2); dirty = true; };
$('maskTh').onchange = commit;
$('maskSoft').onchange = commit;
$('maskInv').onchange = () => { state.mask.invert = $('maskInv').checked; commit(); dirty = true; };
$('maskShow').onchange = () => { ui.showMask = $('maskShow').checked; dirty = true; };
$('saveLook').onclick = saveLookForm;
$('addBtn').onclick = (e) => { e.stopPropagation(); $('addMenu').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!$('addMenu').contains(e.target)) $('addMenu').classList.add('hidden'); });

$('exportBtn').onclick = openExport;
$('exClose').onclick = () => { if (!exporting) $('exportModal').classList.add('hidden'); };
$('exGo').onclick = runExport;
$('exStill').onclick = saveStill;
$('exDur').oninput = updateExMeta;
$('exCancel').onclick = () => { cancelExport = true; };

// ------------------------------------------------------------------ Beat Sync panel

const allLooks = () => [...PRESETS, ...userLooks.map((l) => ({ ...l, user: true }))];

function renderBeatUi() {
  const b = state.beat;
  $('beatOn').checked = !!b.on;
  $('beatCard').classList.toggle('on', !!b.on);
  $('musicX').classList.toggle('hidden', !music);
  $('musicBtn').textContent = music ? `♫ ${music.name}` : '♫ Load music…';
  $('musicBtn').title = music ? 'Load a different song' : 'Load a song: its beat drives the randomizer and it becomes the soundtrack';
  let info;
  if (music) info = grid ? `${Math.round(grid.tempo)} BPM · ${grid.beats.length} beats · ${fmtTime(music.duration)} — video loops under it` : 'no steady beat found in this song';
  else if (media?.audio) info = grid ? `following the clip's own sound · ${Math.round(grid.tempo)} BPM · ${grid.beats.length} beats` : b.on ? 'listening…' : "turn on to follow the clip's own beat, or load a song";
  else info = 'load a song — the video loops under it';
  $('beatInfo').textContent = info;
  $('beatEvery').value = b.every;
  $('beatMode').value = b.mode;
  $('beatChance').value = b.chance;
  $('beatChanceV').textContent = `${Math.round(b.chance * 100)}%`;
  const single = b.mode === 'single';
  const amt = single ? b.vary || 0 : b.amount;
  $('beatAmount').value = amt;
  $('beatAmountV').textContent = single && !amt ? 'same' : `${Math.round(amt * 100)}%`;
  $('beatAmountRow').classList.toggle('hidden', !['looks', 'params', 'single'].includes(b.mode));
  $('beatAmountL').textContent = b.mode === 'params' ? 'amount' : 'variation';
  $('beatAmountL').title = single ? '0 = the effect looks identical on every hit' : '';
  $('beatTargetRow').classList.toggle('hidden', !single);
  $('beatStyleRow').classList.toggle('hidden', !single);
  $('beatHoldRow').classList.toggle('hidden', !single || b.style === 'toggle');
  document.querySelectorAll('#beatStyle button').forEach((x) => x.classList.toggle('on', x.dataset.v === b.style));
  $('beatHold').value = b.hold;
  $('beatHoldV').textContent = `${b.hold.toFixed(2).replace(/0$/, '')} bt`;
  if (single) renderBeatTarget();
  $('beatPunch').value = b.punch;
  $('beatPunchV').textContent = `${Math.round(b.punch * 100)}%`;
  $('beatStartRow').classList.toggle('hidden', !music);
  if (music) {
    $('beatStart').max = Math.max(0, music.duration - 1).toFixed(2);
    $('beatStart').value = b.start || 0;
    $('beatStartV').textContent = fmtTime(b.start || 0).replace(/\.\d+$/, '');
  }
  $('beatBarRow').classList.toggle('hidden', !['bar', '2 bars', '4 bars', '2 beats'].includes(b.every));
  document.querySelectorAll('#beatBar button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === (b.barShift || 0)));
  const chips = $('beatPool');
  chips.classList.toggle('hidden', b.mode !== 'looks');
  chips.innerHTML = '';
  if (b.mode === 'looks') {
    const names = allLooks().map((l) => l.name);
    const sel = new Set(b.pool || names);
    chips.append(h('div', { class: 'chips-h' }, 'looks to jump between',
      h('button', { class: 'mini', onclick: () => { setBeat({ pool: null }); renderBeatUi(); } }, 'all')));
    for (const n of names) {
      chips.append(h('button', {
        class: 'chip' + (sel.has(n) ? ' on' : ''),
        onclick: () => {
          const next = new Set(b.pool || names);
          if (next.has(n)) next.delete(n); else next.add(n);
          if (!next.size) return toast('Keep at least one look in the mix', true, 1800);
          setBeat({ pool: next.size === names.length ? null : [...next] });
          renderBeatUi();
        },
      }, n));
    }
  }
  renderLayersBanner();
}

function renderBeatTarget() {
  const b = state.beat;
  const sel = $('beatTarget');
  sel.innerHTML = '';
  if (!state.layers.some((l) => l.uid === b.target)) sel.append(h('option', { value: '', selected: true }, '— pick an effect —'));
  const mine = h('optgroup', { label: 'from your layers' });
  state.layers.forEach((l, i) => mine.append(h('option', { value: 'L:' + l.uid, selected: l.uid === b.target }, `${i + 1}. ${EFFECTS[l.fx].name}`)));
  const add = h('optgroup', { label: 'add a new effect and fire it' });
  Object.values(EFFECTS).forEach((fx) => add.append(h('option', { value: 'F:' + fx.id }, `+ ${fx.name}`)));
  if (state.layers.length) sel.append(mine);
  sel.append(add);
}

function renderLayersBanner() {
  const b = state.beat;
  const show = b.on && grid && ['looks', 'dice'].includes(b.mode);
  $('beatBanner').classList.toggle('hidden', !show);
}

for (const [label, v] of Object.entries(EVERY)) $('beatEvery').append(h('option', { value: label }, `every ${label}`));
for (const [k, label] of Object.entries(MODES)) $('beatMode').append(h('option', { value: k }, label));
$('beatOn').onchange = () => {
  setBeat({ on: $('beatOn').checked });
  if (state.beat.on && !music && !media?.audio) toast('Load a song (♫) — this clip has no sound to follow.', false, 4000);
  ensureGrid();
  renderBeatUi();
};
$('musicBtn').onclick = () => browse(true);
$('musicX').onclick = removeMusic;
$('beatEvery').onchange = () => { setBeat({ every: $('beatEvery').value }); renderBeatUi(); };
$('beatMode').onchange = () => {
  const mode = $('beatMode').value;
  const patch = { mode };
  // default target: the selected layer, else the top one
  if (mode === 'single' && !state.layers.some((l) => l.uid === state.beat.target)) patch.target = ui.selected || state.layers.at(-1)?.uid || null;
  setBeat(patch);
  renderBeatUi();
  renderLayers();
};
$('beatTarget').onchange = () => {
  const v = $('beatTarget').value;
  if (v.startsWith('L:')) setBeat({ target: v.slice(2) });
  else if (v.startsWith('F:')) { const l = addLayer(v.slice(2)); setBeat({ target: l.uid }); }
  renderBeatUi();
  renderLayers();
  renderInspector();
};
document.querySelectorAll('#beatStyle button').forEach((x) => (x.onclick = () => { setBeat({ style: x.dataset.v }); renderBeatUi(); }));
$('beatHold').oninput = () => { setBeat({ hold: Number($('beatHold').value) }, false); renderBeatUi(); };
$('beatHold').onchange = commit;
for (const [id, key] of [['beatChance', 'chance'], ['beatAmount', 'amount'], ['beatPunch', 'punch']]) {
  $(id).oninput = () => {
    const k = key === 'amount' && state.beat.mode === 'single' ? 'vary' : key;
    setBeat({ [k]: Number($(id).value) }, false);
    renderBeatUi();
  };
  $(id).onchange = commit;
}
$('beatStart').oninput = () => {
  setBeat({ start: Number($('beatStart').value) }, false);
  if (music) musicEl.currentTime = state.beat.start;
  $('beatStartV').textContent = fmtTime(state.beat.start).replace(/\.\d+$/, '');
};
$('beatStart').onchange = () => { commit(); updateScrubMax(); seekTimeline(0); };
document.querySelectorAll('#beatBar button').forEach((x) => (x.onclick = () => { setBeat({ barShift: Number(x.dataset.v) }); renderBeatUi(); }));
$('beatKeep').onclick = keepCurrentCut;
$('bannerKeep').onclick = keepCurrentCut;

// split-compare dragging on the canvas
let splitDrag = false;
canvas.addEventListener('pointerdown', (e) => {
  if (ui.compare !== 1) return;
  splitDrag = true;
  canvas.setPointerCapture(e.pointerId);
  moveSplit(e);
});
canvas.addEventListener('pointermove', (e) => splitDrag && moveSplit(e));
canvas.addEventListener('pointerup', () => { splitDrag = false; });
function moveSplit(e) {
  const r = canvas.getBoundingClientRect();
  ui.split = clamp((e.clientX - r.left) / r.width, 0, 1);
  positionSplit();
  dirty = true;
}
new ResizeObserver(fitCanvas).observe($('viewport'));

// drag & drop files
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('dropOverlay').classList.remove('hidden'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.add('hidden');
  uploadFile(e.dataTransfer.files[0]);
});

// keyboard
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && !['range', 'checkbox'].includes(e.target.type)) return;
  if (tag === 'select') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || exporting) return;
  if (k === ' ') { e.preventDefault(); if (media) play(); }
  else if (k === 'arrowleft') { e.preventDefault(); gotoFrame(currentFrame() - (e.shiftKey ? 10 : 1)); }
  else if (k === 'arrowright') { e.preventDefault(); gotoFrame(currentFrame() + (e.shiftKey ? 10 : 1)); }
  else if (k === 'd') dice();
  else if (k === 'b') { $('beatOn').checked = !state.beat.on; $('beatOn').onchange(); }
  else if (k === 'c') { ui.compare = (ui.compare + 1) % 3; renderTop(); dirty = true; }
  else if (k === 'm') { ui.showMask = !ui.showMask; renderMaskUi(); dirty = true; }
  else if (k === 'e') openExport();
  else if ((k === 'delete' || k === 'backspace') && ui.selected) removeLayer(ui.selected);
  else if (k === 'escape') { $('addMenu').classList.add('hidden'); if (!exporting) $('exportModal').classList.add('hidden'); }
});

// lifecycle: heartbeat (also delivers files dropped on the desktop shortcut) + goodbye
async function heartbeat() {
  try {
    const r = await post('/api/ping');
    if (r.open) openPath(r.open);
  } catch {}
}
setInterval(heartbeat, 5000);
heartbeat();

// boot
ui.selected = state.layers[0]?.uid || null;
renderAddMenu();
renderAll();
loadUserLooks();
const openParam = new URLSearchParams(location.search).get('open');
if (openParam) {
  history.replaceState(null, '', '/');
  openPath(openParam);
}
window.acid = {
  get state() { return state; }, engine, video, musicEl, director, openPath, renderOpts, timeline,
  get media() { return media; }, get music() { return music; }, get grid() { return grid; },
};
