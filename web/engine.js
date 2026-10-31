// Render engine: source framing -> subject mask -> effect layers (each with mix + scope) -> CHAOS -> output.
// Pure function of (source frame, frame index, time, params, seed) except for the stateful time effects,
// which advance once per new frame — so an export rendered frame-by-frame matches the preview.

import { Gpu } from './gpu.js';
import { EFFECTS, isNum } from './effects/index.js';

const FRAME = `
uniform vec2 uSrcRes;
uniform float uFit, uZoom, uPanX, uPanY;
vec2 frameUv() {
  float ra = uRes.x / uRes.y, sa = uSrcRes.x / uSrcRes.y;
  vec2 s = vec2(1.0);
  if (uFit < 0.5) { if (sa > ra) s.x = ra / sa; else s.y = sa / ra; }     // cover (crop to fill)
  else            { if (sa > ra) s.y = sa / ra; else s.x = ra / sa; }     // contain (letterbox)
  return (vUv - 0.5) * s / uZoom + 0.5 + vec2(uPanX, uPanY);
}
bool outside(vec2 uv) { return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0; }
`;

const SOURCE = FRAME + `
uniform sampler2D uImg;
uniform float uPacked, uTexW;
void main() {
  vec2 uv = frameUv();
  if (outside(uv)) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (uPacked > 0.5) uv.x = clamp(uv.x * 0.5, 0.75 / uTexW, 0.5 - 0.75 / uTexW);
  outColor = vec4(texture(uImg, uv).rgb, 1.0);
}`;

const MASKP = FRAME + `
uniform sampler2D uImg, uMaskImg;
uniform float uPacked, uTexW, uMode, uThresh, uSoft, uInvert, uHasMaskImg;
vec3 col(vec2 uv) {
  if (uPacked > 0.5) uv.x = clamp(uv.x * 0.5, 0.75 / uTexW, 0.5 - 0.75 / uTexW);
  return texture(uImg, uv).rgb;
}
void main() {
  vec2 uv = frameUv();
  float raw = 1.0;
  float mode = uMode;
  if (mode > 0.5 && mode < 1.5 && uPacked < 0.5 && uHasMaskImg < 0.5) mode = 2.0;   // no AI mask yet: auto key
  if (mode > 0.5 && mode < 1.5) {
    raw = uPacked > 0.5 ? texture(uImg, vec2(clamp(0.5 + uv.x * 0.5, 0.5 + 0.75 / uTexW, 1.0), uv.y)).r
                        : texture(uMaskImg, uv).r;
  } else if (mode > 1.5 && mode < 2.5) {
    vec3 k = (col(vec2(0.02, 0.02)) + col(vec2(0.98, 0.02)) + col(vec2(0.02, 0.98)) + col(vec2(0.98, 0.98))
            + col(vec2(0.02, 0.5)) + col(vec2(0.98, 0.5)) + col(vec2(0.5, 0.98))) / 7.0;
    raw = clamp(length(col(uv) - k) * 2.0, 0.0, 1.0);
  } else if (mode > 2.5 && mode < 3.5) raw = luma(col(uv));
  else if (mode > 3.5) raw = 1.0 - luma(col(uv));
  float m = mode < 0.5 ? 1.0 : smoothstep(uThresh - uSoft * 0.5, uThresh + uSoft * 0.5 + 1e-3, raw);
  if (uInvert > 0.5 && mode > 0.5) m = 1.0 - m;
  if (outside(uv)) m = 0.0;
  outColor = vec4(m, m, m, 1.0);
}`;

const APPLY = `
uniform sampler2D uBefore, uAfter;
uniform float uMix, uScope, uWinCount;
void main() {
  vec3 a = texture(uBefore, vUv).rgb, b = texture(uAfter, vUv).rgb;
  float m = 1.0;
  if (uScope > 0.5 && uScope < 1.5) m = mask(vUv);
  else if (uScope > 1.5 && uScope < 2.5) m = 1.0 - mask(vUv);
  else if (uScope > 2.5) {
    m = 0.0;
    float st = floor(uTime * 3.0) + uSeed;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uWinCount) break;
      vec2 c = hash22(vec2(float(i) * 7.3, st));
      vec2 hs = vec2(0.08 + 0.2 * hash12(vec2(st, float(i))), 0.05 + 0.15 * hash12(vec2(float(i), st + 4.0)));
      if (abs(vUv.x - c.x) < hs.x && abs(vUv.y - c.y) < hs.y) m = 1.0;
    }
  }
  outColor = vec4(mix(a, b, clamp(uMix * m, 0.0, 1.0)), 1.0);
}`;

// Global CHAOS: random glitch bursts (and beat hits) on top of everything.
// uSteady = the CHAOS slider (always-on tearing); uChaos = burst strength (CHAOS or Beat Sync punch).
const CHAOS = `
uniform float uChaos, uBurst, uSteady;
void main() {
  vec2 uv = vUv;
  float st = floor(uTime * 10.0) + uSeed * 13.0;
  float b = uBurst;
  uv = (uv - 0.5) / (1.0 + 0.045 * b * uChaos) + 0.5;   // zoom kick on hits
  vec2 cell = floor(uv * vec2(6.0, 24.0));
  if (hash12(cell + st) < 0.35 * b) uv.x += (hash12(cell + st + 1.0) - 0.5) * 0.25 * b;
  float row = floor(uv.y * uRes.y / max(pxs(4.0), 1.0));
  if (hash12(vec2(row, st)) < 0.08 * uSteady) uv.x += (hash12(vec2(row * 3.0, st)) - 0.5) * 0.05;
  float o = 0.004 * uSteady + 0.02 * b * uChaos;
  vec3 c = vec3(texture(uTex, uv + vec2(o, 0)).r, texture(uTex, uv).g, texture(uTex, uv - vec2(o, 0)).b);
  if (b > 0.5 && hash11(st + 2.0) < 0.3 * uChaos) c = 1.0 - c;
  if (b > 0.5 && hash11(st + 5.0) < 0.5 * uChaos) c = hueShift(c, hash11(st + 9.0));
  outColor = vec4(c, 1.0);
}`;

// Final float -> 8-bit with ±0.5 LSB dither (no banding after long float chains). Also what export reads.
const OUTF = `
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  c += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const DISPLAY = `
uniform float uCompare, uSplit, uShowMask;
void main() {
  vec3 after = texture(uTex, vUv).rgb;
  vec3 before = texture(uSrc, vUv).rgb;
  vec3 c = after;
  if (uCompare > 1.5) c = before;
  else if (uCompare > 0.5) {
    c = vUv.x < uSplit ? before : after;
    float d = abs(vUv.x - uSplit) * uRes.x;
    c = mix(vec3(1.0), c, smoothstep(1.0, 2.5, d));
  }
  if (uShowMask > 0.5) c = mix(c, vec3(1.0, 0.1, 0.75), 0.45 * mask(vUv));
  outColor = vec4(c, 1.0);
}`;

const SCOPES = { all: 0, subject: 1, background: 2, windows: 3 };
const MASK_MODES = { none: 0, ai: 1, key: 2, luma: 3, dark: 4 };

const hexToRgb = (h) => {
  const n = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const frac = (x) => x - Math.floor(x);
const hash = (x) => frac(Math.sin(x * 12.9898 + 78.233) * 43758.5453);

/** Bipolar (-1..1) LFOs, unipolar (0..1) audio. */
export function modWave(mod, t, audio) {
  const ph = t * mod.rate;
  switch (mod.shape) {
    case 'sine': return Math.sin(ph * Math.PI * 2);
    case 'triangle': return 1 - 4 * Math.abs(frac(ph + 0.25) - 0.5);
    case 'saw': return 2 * frac(ph) - 1;
    case 'square': return frac(ph) < 0.5 ? 1 : -1;
    case 'random': return hash(Math.floor(ph) + 1) * 2 - 1;
    case 'noise': { const i = Math.floor(ph), f = frac(ph), u = f * f * (3 - 2 * f); return (hash(i + 1) * (1 - u) + hash(i + 2) * u) * 2 - 1; }
    case 'audio-level': return audio[0];
    case 'audio-bass': return audio[1];
    case 'audio-high': return audio[2];
    case 'audio-beat': return audio[3];
    default: return 0;
  }
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.gpu = new Gpu(gl);
    this.srcTex = this.gpu.texture(gl.LINEAR);
    this.maskImgTex = this.gpu.texture(gl.LINEAR);
    this.hasMaskImg = false;
    this.src = { el: null, w: 1, h: 1, packed: false, texW: 1, dirty: true };
    this.runtimes = new Map();
    this.lastFrame = -1;
    this.w = 0;
    this.h = 0;
    this.resize(1080, 1920);
  }

  resize(w, h) {
    w = Math.max(2, Math.round(w / 2) * 2);
    h = Math.max(2, Math.round(h / 2) * 2);
    if (w === this.w && h === this.h) return;
    const g = this.gpu;
    [this.srcRT, this.maskRT, this.outRT, ...(this.pool || [])].forEach((t) => g.free(t));
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    this.srcRT = g.target(w, h, 'rgba16f');
    this.maskRT = g.target(w, h, 'rgba8');
    this.outRT = g.target(w, h, 'rgba8');
    this.pool = [g.target(w, h, 'rgba16f'), g.target(w, h, 'rgba16f'), g.target(w, h, 'rgba16f')];
    this.reset();
  }

  /** el: <video> or <img>. packed: [color | mask] side-by-side video. */
  setSource(el, w, h, packed = false) {
    this.src = { el, w, h, packed, texW: packed ? w * 2 : w, dirty: true };
    this.reset();
  }

  setMaskImage(img) {
    const gl = this.gl;
    this.hasMaskImg = !!img;
    if (!img) return;
    gl.bindTexture(gl.TEXTURE_2D, this.maskImgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Drop all temporal state (new source, size, or the start of an export). */
  reset() {
    for (const r of this.runtimes.values()) r.reset?.();
    this.lastFrame = -1;
  }

  prune(layers) {
    const live = new Set(layers.map((l) => l.uid));
    for (const [id, r] of this.runtimes) {
      if (!live.has(id)) {
        r.dispose();
        this.runtimes.delete(id);
      }
    }
  }

  runtimeFor(layer, fx) {
    let r = this.runtimes.get(layer.uid);
    if (!r || r.fx !== fx.id) {
      r?.dispose();
      r = fx.runtime(this.gpu);
      r.fx = fx.id;
      this.runtimes.set(layer.uid, r);
    }
    return r;
  }

  upload(force) {
    const { el } = this.src;
    if (!el) return;
    const isVideo = el instanceof HTMLVideoElement;
    if (isVideo && el.readyState < 2) return;
    if (!isVideo && !this.src.dirty && !force) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.src.dirty = false;
  }

  resolve(fx, layer, t, audio, chaos, burst) {
    const out = {};
    for (const p of fx.params) {
      let v = layer.params[p.key] ?? p.def;
      if (isNum(p)) {
        v = Number(v);
        for (const m of layer.mods || []) {
          if (m.param === p.key && m.shape !== 'off') v += modWave(m, t, audio) * m.depth * (p.max - p.min);
        }
        if (chaos > 0 && p.key === fx.key) v += (p.max - v) * chaos * (0.2 + 0.6 * burst);
        v = Math.min(p.max, Math.max(p.min, v));
        if (p.step === 1) v = Math.round(v);
      } else if (p.type === 'bool') v = v ? 1 : 0;
      else if (p.type === 'select') v = Number(v);
      out[p.key] = v;
    }
    return out;
  }

  uniformsFor(fx, values) {
    const u = {};
    for (const p of fx.params) u['u_' + p.key] = p.type === 'color' ? hexToRgb(values[p.key]) : values[p.key];
    return fx.extra ? { ...u, ...fx.extra(values) } : u;
  }

  /**
   * o: { layers, chaos, seed, maskCfg:{mode,threshold,soft,invert}, fit, zoom, panX, panY,
   *      frame, time, audio:[4], compare, split, showMask }
   */
  render(o) {
    const g = this.gpu;
    const W = this.w, H = this.h;
    const advance = o.frame !== this.lastFrame;
    this.lastFrame = o.frame;
    this.upload(false);
    const audio = o.audio || [0, 0, 0, 0];
    const seed = o.seed || 0;
    const frame = {
      uSrcRes: [this.src.w, this.src.h], uFit: o.fit === 'contain' ? 1 : 0, uZoom: o.zoom || 1,
      uPanX: o.panX || 0, uPanY: o.panY || 0, uImg: this.srcTex, uPacked: this.src.packed ? 1 : 0, uTexW: this.src.texW,
    };
    g.globals = {};
    g.pass(SOURCE, this.srcRT, frame);
    const mc = o.maskCfg || {};
    g.pass(MASKP, this.maskRT, {
      ...frame, uMaskImg: this.maskImgTex, uHasMaskImg: this.hasMaskImg ? 1 : 0,
      uMode: MASK_MODES[mc.mode] ?? 0, uThresh: mc.threshold ?? 0.5, uSoft: mc.soft ?? 0.2, uInvert: mc.invert ? 1 : 0,
    });
    g.globals = { uSrc: this.srcRT, uMask: this.maskRT, uTime: o.time, uFrame: o.frame, uSeed: seed * 0.6180339 % 97, uAudio: audio };

    // Beat Sync swaps whole stacks on cuts: free the GPU state of layers that are no longer in play
    this.prune(o.layers);
    const chaos = o.chaos || 0;
    const punch = o.punch || 0;
    let burst = chaos > 0 && hash(Math.floor(o.time * 6) + seed * 7.1) < chaos * 0.45 ? 1 : 0;
    burst = Math.max(burst, audio[3] * Math.max(chaos, punch));
    const solo = o.layers.some((l) => l.solo && l.on);
    const active = o.layers.filter((l) => l.on && EFFECTS[l.fx] && (!solo || l.solo));
    let cur = this.srcRT;
    const pick = (...avoid) => this.pool.find((p) => !avoid.includes(p));
    for (const layer of active) {
      const fx = EFFECTS[layer.fx];
      const values = this.resolve(fx, layer, o.time, audio, chaos, burst);
      let extras = {};
      if (fx.runtime) {
        extras = this.runtimeFor(layer, fx).prepare({
          input: cur, width: W, height: H, time: o.time, frame: o.frame, params: values, seed, advance, audio,
        });
      }
      const fxOut = pick(cur);
      g.pass(fx.frag, fxOut, { uTex: cur, ...extras, ...this.uniformsFor(fx, values) });
      const scope = SCOPES[layer.scope] ?? 0;
      if (layer.mix < 0.999 || scope !== 0) {
        const ap = pick(cur, fxOut);
        g.pass(APPLY, ap, { uBefore: cur, uAfter: fxOut, uMix: layer.mix, uScope: scope, uWinCount: layer.windows ?? 4 });
        cur = ap;
      } else cur = fxOut;
    }
    if (chaos > 0 || punch > 0) {
      const c = pick(cur);
      g.pass(CHAOS, c, { uTex: cur, uChaos: Math.max(chaos, punch * 0.7), uBurst: burst, uSteady: chaos });
      cur = c;
    }
    g.pass(OUTF, this.outRT, { uTex: cur });
    g.pass(DISPLAY, null, { uTex: this.outRT, uCompare: o.compare || 0, uSplit: o.split ?? 0.5, uShowMask: o.showMask ? 1 : 0 }, [W, H]);
  }

  /** The last rendered frame, bottom row first (RGBA). */
  readPixels(buf) {
    const gl = this.gl;
    const out = buf && buf.length === this.w * this.h * 4 ? buf : new Uint8Array(this.w * this.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outRT.fbo);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
