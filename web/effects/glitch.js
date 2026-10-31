// Glitch effects. Pixel Sort and Datamosh are ported from Glitch Chain (glitch-chain/src/renderer/src/effects).

export const rgbSplit = {
  id: 'rgbSplit',
  name: 'RGB Split',
  cat: 'glitch',
  key: 'amount',
  params: [
    { key: 'amount', min: 0, max: 0.05, def: 0.008, rand: [0.003, 0.02] },
    { key: 'angle', min: 0, max: 360, def: 0, rand: [0, 360] },
    { key: 'jitter', min: 0, max: 1, def: 0.35 },
    { key: 'speed', min: 0, max: 30, def: 12 },
    { key: 'radial', type: 'bool', def: false },
  ],
  frag: `
uniform float u_amount, u_angle, u_jitter, u_speed, u_radial;
void main() {
  float a = radians(u_angle);
  float j = 1.0 + (hash11(floor(uTime * u_speed) + uSeed) - 0.5) * 2.0 * u_jitter + uAudio.w * u_jitter;
  vec2 o = vec2(cos(a), sin(a)) * u_amount * j;
  if (u_radial > 0.5) o = (vUv - 0.5) * u_amount * j * 4.0;
  o.x *= uRes.y / uRes.x;
  outColor = vec4(texture(uTex, vUv + o).r, texture(uTex, vUv).g, texture(uTex, vUv - o).b, 1.0);
}`,
};

export const blockGlitch = {
  id: 'blockGlitch',
  name: 'Block Glitch',
  cat: 'glitch',
  key: 'amount',
  params: [
    { key: 'amount', min: 0, max: 1, def: 0.15, rand: [0.05, 0.35] },
    { key: 'blockSize', label: 'block size (px)', min: 4, max: 300, step: 1, def: 48, rand: [16, 120] },
    { key: 'aspect', min: 0.2, max: 8, def: 3, rand: [0.5, 5] },
    { key: 'speed', min: 0, max: 30, def: 8 },
    { key: 'shift', min: 0, max: 0.5, def: 0.1 },
    { key: 'swap', label: 'channel swap', min: 0, max: 1, def: 0.4 },
  ],
  frag: `
uniform float u_amount, u_blockSize, u_aspect, u_speed, u_shift, u_swap;
void main() {
  vec2 bs = vec2(pxs(u_blockSize) * u_aspect, pxs(u_blockSize)) / uRes;
  vec2 b = floor(vUv / bs);
  float st = floor(uTime * u_speed) + uSeed;
  vec3 col;
  if (hash12(b + st * 1.37) < u_amount + uAudio.w * 0.3 * u_amount) {
    vec2 o = (vec2(hash12(b + st + 3.1), hash12(b + st + 7.7)) - 0.5) * 2.0 * u_shift;
    o.y *= 0.15;
    col = texture(uTex, vUv + o).rgb;
    float s = hash12(b + st + 11.0);
    if (s < u_swap * 0.5) col = col.brg; else if (s < u_swap) col = col.gbr;
  } else col = texture(uTex, vUv).rgb;
  outColor = vec4(col, 1.0);
}`,
};

// ---------------------------------------------------------------- datamosh (motion-vector P-frame bleed)
const MOSH_SCALE = 8;
const DOWN = `
uniform sampler2D uIn;
void main() {
  vec2 t = 0.25 / uRes;
  float l = luma(texture(uIn, vUv + vec2(-t.x, -t.y)).rgb) + luma(texture(uIn, vUv + vec2(t.x, -t.y)).rgb)
          + luma(texture(uIn, vUv + vec2(-t.x, t.y)).rgb) + luma(texture(uIn, vUv + vec2(t.x, t.y)).rgb);
  outColor = vec4(l * 0.25, 0.0, 0.0, 1.0);
}`;
const FLOW = `
uniform sampler2D uCur, uPrevL;
uniform float uR;
float L(sampler2D t, ivec2 p) { return texelFetch(t, clamp(p, ivec2(0), ivec2(uRes) - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 1e9;
  vec2 bd = vec2(0.0);
  for (int dy = -7; dy <= 7; dy++) {
    for (int dx = -7; dx <= 7; dx++) {
      if (abs(float(dx)) > uR || abs(float(dy)) > uR) continue;
      float c = 0.0;
      for (int qy = -1; qy <= 1; qy++)
        for (int qx = -1; qx <= 1; qx++) {
          ivec2 q = p + ivec2(qx, qy);
          c += abs(L(uCur, q) - L(uPrevL, q + ivec2(dx, dy)));
        }
      c += length(vec2(dx, dy)) * 0.01;
      if (c < best) { best = c; bd = vec2(dx, dy); }
    }
  }
  outColor = vec4(bd / uRes, best, 1.0);
}`;
const MOSH = `
uniform sampler2D uIn, uMoshPrev, uFlow;
uniform float uStrength, uBlock, uRefresh, uBleed, uDrift, uMSeed, uFirst;
void main() {
  vec2 bs = max(pxs(uBlock), 1.0) / uRes;
  vec2 cell = floor(vUv / bs);
  vec2 cuv = uBlock > 1.5 ? (cell + 0.5) * bs : vUv;
  vec2 d = texture(uFlow, cuv).xy * uStrength;
  float a = vnoise(cuv * 6.0 + uTime * 0.15) * 12.566;
  d += vec2(cos(a), sin(a)) * uDrift;
  vec3 moshed = texture(uMoshPrev, vUv + d).rgb;
  vec3 inp = texture(uIn, vUv).rgb;
  float refresh = step(hash12(cell * 1.31 + uMSeed), uRefresh);
  outColor = vec4(mix(moshed, inp, max(max(refresh, uBleed), uFirst)), 1.0);
}`;

export const datamosh = {
  id: 'datamosh',
  name: 'Datamosh',
  cat: 'glitch',
  key: 'strength',
  params: [
    { key: 'strength', label: 'motion strength', min: 0, max: 4, def: 1.6, rand: [0.8, 2.5] },
    { key: 'block', label: 'macroblock (px)', min: 1, max: 64, step: 1, def: 16, rand: [8, 32] },
    { key: 'range', label: 'search range', type: 'select', options: { small: 3, medium: 5, large: 7 }, def: 5 },
    { key: 'refresh', label: 'refresh (I-frame)', min: 0, max: 1, def: 0.02, rand: [0, 0.08] },
    { key: 'bleed', label: 'clean bleed', min: 0, max: 0.3, def: 0.015 },
    { key: 'drift', min: 0, max: 0.02, def: 0.0015 },
  ],
  frag: `
uniform sampler2D uMosh;
void main() { outColor = vec4(texture(uMosh, vUv).rgb, 1.0); }`,
  runtime: (gpu) => {
    let small = [null, null], mosh = [null, null], flow = null, first = true, cur = 0, last = null;
    return {
      prepare({ input, width, height, time, params, advance }) {
        if (!advance && last) return { uMosh: last };
        const sw = Math.ceil(width / MOSH_SCALE), sh = Math.ceil(height / MOSH_SCALE);
        small = [gpu.fit(small[0], sw, sh, 'rgba16f'), gpu.fit(small[1], sw, sh, 'rgba16f')];
        mosh = [gpu.fit(mosh[0], width, height, 'rgba16f'), gpu.fit(mosh[1], width, height, 'rgba16f')];
        flow = gpu.fit(flow, sw, sh, 'rgba16f', false);
        const now = small[cur], before = small[cur ^ 1];
        gpu.pass(DOWN, now, { uIn: input });
        gpu.pass(FLOW, flow, { uCur: now, uPrevL: first ? now : before, uR: params.range });
        gpu.pass(MOSH, mosh[cur], {
          uIn: input, uMoshPrev: mosh[cur ^ 1], uFlow: flow, uStrength: params.strength, uBlock: params.block,
          uRefresh: params.refresh, uBleed: params.bleed, uDrift: params.drift,
          uMSeed: Math.floor(time * 30) * 0.618, uFirst: first ? 1 : 0,
        });
        last = mosh[cur];
        first = false;
        cur ^= 1;
        return { uMosh: last };
      },
      reset() { first = true; last = null; },
      dispose() { [...small, ...mosh, flow].forEach((t) => gpu.free(t)); },
    };
  },
};

// ---------------------------------------------------------------- pixel sort (bitonic network on the GPU)
const METRIC = `
float metric(vec3 c, float by) {
  if (by < 0.5) return luma(c);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  if (by > 1.5) return mx < 1e-4 ? 0.0 : (mx - mn) / mx;
  float d = mx - mn;
  if (d < 1e-4) return 0.0;
  float h = mx == c.r ? mod((c.g - c.b) / d, 6.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return h / 6.0;
}`;
const BUILD = METRIC + `
uniform sampler2D uIn;
uniform float uLen, uRows, uAxis, uLo, uHi, uBy, uN, uStagger;
void main() {
  vec2 f = floor(gl_FragCoord.xy);
  float i = f.x - floor(hash11(f.y * 1.37 + 0.5) * uN * uStagger);
  if (i < 0.0 || i >= uLen) { outColor = vec4(0.0, 0.0, 0.0, f.x); return; }
  vec2 uv = uAxis < 0.5 ? vec2((i + 0.5) / uLen, (f.y + 0.5) / uRows) : vec2((f.y + 0.5) / uRows, (i + 0.5) / uLen);
  vec3 c = texture(uIn, uv).rgb;
  float v = metric(c, uBy);
  bool inRange = v >= uLo && v <= uHi;
  outColor = vec4(c, inRange ? -1.0 : f.x);
}`;
const SCAN = `
uniform sampler2D uS;
uniform float uO, uN;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uS, p, 0);
  float cs = floor(float(p.x) / uN) * uN;
  if (float(p.x) - uO >= cs) s.a = max(s.a, texelFetch(uS, ivec2(p.x - int(uO), p.y), 0).a);
  outColor = s;
}`;
const KEYS = METRIC + `
uniform sampler2D uS;
uniform float uN, uBy, uReverse;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uS, p, 0);
  float x = float(p.x);
  float key = x;
  if (s.a != x) {
    float cs = floor(x / uN) * uN;
    float b = s.a >= cs ? s.a : cs - 1.0;
    float v = metric(s.rgb, uBy);
    key = b + 0.5 + 0.49 * (uReverse > 0.5 ? 1.0 - v : v);
  }
  outColor = vec4(s.rgb, key);
}`;
const BITONIC = `
uniform sampler2D uS;
uniform float uK, uJ, uN;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN), k = int(uK), j = int(uJ);
  int i = p.x % n;
  int partner = p.x - i + (i ^ j);
  vec4 a = texelFetch(uS, p, 0);
  vec4 b = texelFetch(uS, ivec2(partner, p.y), 0);
  bool asc = (i & k) == 0;
  bool lower = i < (i ^ j);
  bool swap = (asc == lower) ? b.a < a.a : b.a > a.a;
  outColor = swap ? b : a;
}`;
const UNMAP = `
uniform sampler2D uS;
uniform float uLen, uRows, uAxis, uN, uStagger;
void main() {
  vec2 q = uAxis < 0.5 ? vUv : vUv.yx;
  float row = min(floor(q.y * uRows), uRows - 1.0);
  float off = floor(hash11(row * 1.37 + 0.5) * uN * uStagger);
  ivec2 t = ivec2(min(floor(q.x * uLen), uLen - 1.0) + off, row);
  outColor = vec4(texelFetch(uS, t, 0).rgb, 1.0);
}`;

export const pixelSort = {
  id: 'pixelSort',
  name: 'Pixel Sort',
  cat: 'glitch',
  key: 'hi',
  params: [
    { key: 'lo', label: 'range low', min: 0, max: 1, def: 0.35, rand: [0.15, 0.55] },
    { key: 'hi', label: 'range high', min: 0, max: 1, def: 0.95, rand: [0.75, 1] },
    { key: 'by', label: 'sort by', type: 'select', options: { brightness: 0, hue: 1, saturation: 2 }, def: 0 },
    { key: 'axis', label: 'direction', type: 'select', options: { horizontal: 0, vertical: 1 }, def: 1 },
    { key: 'reverse', type: 'bool', def: false },
    { key: 'chunk', label: 'max streak (px)', type: 'select', options: { 64: 64, 128: 128, 256: 256, 512: 512, 1024: 1024 }, def: 256 },
    { key: 'stagger', label: 'stagger seams', type: 'bool', def: true },
    { key: 'res', label: 'resolution', type: 'select', options: { full: 1, half: 0.5, quarter: 0.25 }, def: 1 },
  ],
  frag: `
uniform sampler2D uSorted;
void main() { outColor = vec4(texture(uSorted, vUv).rgb, 1.0); }`,
  runtime: (gpu) => {
    let a = null, b = null, out = null;
    return {
      prepare({ input, width, height, params }) {
        const res = params.res, axis = params.axis, n = params.chunk;
        const len = Math.max(1, Math.round((axis < 0.5 ? width : height) * res));
        const rows = Math.max(1, Math.round((axis < 0.5 ? height : width) * res));
        const stagger = params.stagger ? 1 : 0;
        const padded = Math.ceil((len + (stagger ? n : 0)) / n) * n;
        a = gpu.fit(a, padded, rows, 'rgba32f', false);
        b = gpu.fit(b, padded, rows, 'rgba32f', false);
        out = gpu.fit(out, width, height, 'rgba16f');
        let src = a, dst = b;
        const step = (frag, u) => { gpu.pass(frag, dst, { uS: src, ...u }); [src, dst] = [dst, src]; };
        const by = params.by;
        gpu.pass(BUILD, src, { uIn: input, uLen: len, uRows: rows, uAxis: axis, uLo: params.lo, uHi: params.hi, uBy: by, uN: n, uStagger: stagger });
        for (let o = 1; o < n; o *= 2) step(SCAN, { uO: o, uN: n });
        step(KEYS, { uN: n, uBy: by, uReverse: params.reverse ? 1 : 0 });
        for (let k = 2; k <= n; k *= 2) for (let j = k / 2; j >= 1; j /= 2) step(BITONIC, { uK: k, uJ: j, uN: n });
        gpu.pass(UNMAP, out, { uS: src, uLen: len, uRows: rows, uAxis: axis, uN: n, uStagger: stagger });
        return { uSorted: out };
      },
      dispose() { [a, b, out].forEach((t) => gpu.free(t)); },
    };
  },
};

// ---------------------------------------------------------------- pixel drip / melt
export const pixelDrip = {
  id: 'pixelDrip',
  name: 'Pixel Drip / Melt',
  cat: 'glitch',
  key: 'jag',
  params: [
    { key: 'mode', type: 'select', options: { 'smear (freeze line)': 0, 'drip brights': 1 }, def: 0 },
    { key: 'dir', label: 'direction', type: 'select', options: { down: 0, up: 1, right: 2, left: 3 }, def: 0 },
    { key: 'line', label: 'melt line', min: 0, max: 1, def: 0.55, rand: [0.3, 0.75] },
    { key: 'jag', label: 'jaggedness', min: 0, max: 1, def: 0.35, rand: [0.1, 0.7] },
    { key: 'colw', label: 'column width (px)', min: 1, max: 40, def: 3, rand: [1, 8] },
    { key: 'length', min: 0.02, max: 1, def: 1, rand: [0.3, 1] },
    { key: 'threshold', label: 'drip threshold', min: 0, max: 1, def: 0.55 },
    { key: 'speed', min: 0, max: 4, def: 0.5 },
  ],
  frag: `
uniform float u_mode, u_dir, u_line, u_jag, u_colw, u_length, u_threshold, u_speed;
void main() {
  // q: x = across the drip, y = along it (0 = start edge)
  vec2 q;
  if (u_dir < 0.5) q = vec2(vUv.x, 1.0 - vUv.y);
  else if (u_dir < 1.5) q = vUv;
  else if (u_dir < 2.5) q = vec2(1.0 - vUv.y, vUv.x);
  else q = vec2(vUv.y, 1.0 - vUv.x);
  float acrossPx = (u_dir < 1.5 ? uRes.x : uRes.y);
  float colW = max(pxs(u_colw), 1.0) / acrossPx;
  float col = floor(q.x / colW);
  float t = uTime * u_speed;
  float jag = (vnoise(vec2(col * 0.07, t * 0.6)) - 0.5) * 1.2 + (hash12(vec2(col, floor(t * 3.0) + uSeed)) - 0.5) * 0.6;
  float edge = u_line + jag * u_jag * 0.6;
  vec2 sq = q;
  if (u_mode < 0.5) {
    float runLen = u_length * (0.4 + 0.6 * hash11(col + 3.7));
    if (q.y > edge && q.y < edge + runLen) sq.y = edge;
  } else {
    vec3 best = vec3(0.0); float bl = -1.0;
    float L = u_length * 0.5;
    for (int k = 0; k < 24; k++) {
      vec2 s = vec2(q.x, q.y - L * float(k) / 24.0);
      vec2 uvs;
      if (u_dir < 0.5) uvs = vec2(s.x, 1.0 - s.y); else if (u_dir < 1.5) uvs = s;
      else if (u_dir < 2.5) uvs = vec2(s.y, 1.0 - s.x); else uvs = vec2(1.0 - s.y, s.x);
      vec3 c = texture(uTex, uvs).rgb;
      float l = luma(c) - float(k) * 0.012;
      if (luma(c) > u_threshold && l > bl) { bl = l; best = c; }
    }
    vec3 o = texture(uTex, vUv).rgb;
    outColor = vec4(bl > luma(o) ? best : o, 1.0);
    return;
  }
  vec2 uv;
  if (u_dir < 0.5) uv = vec2(sq.x, 1.0 - sq.y);
  else if (u_dir < 1.5) uv = sq;
  else if (u_dir < 2.5) uv = vec2(sq.y, 1.0 - sq.x);
  else uv = vec2(1.0 - sq.y, sq.x);
  outColor = vec4(texture(uTex, uv).rgb, 1.0);
}`,
};

export const scanTear = {
  id: 'scanTear',
  name: 'Scanline Tear',
  cat: 'glitch',
  key: 'amount',
  params: [
    { key: 'amount', min: 0, max: 1, def: 0.25, rand: [0.08, 0.5] },
    { key: 'lineH', label: 'line height (px)', min: 1, max: 60, def: 6, rand: [2, 18] },
    { key: 'shift', min: 0, max: 0.4, def: 0.06, rand: [0.02, 0.15] },
    { key: 'speed', min: 0, max: 40, def: 14 },
    { key: 'wave', min: 0, max: 1, def: 0.15 },
    { key: 'rgb', label: 'rgb fringe', min: 0, max: 1, def: 0.4 },
  ],
  frag: `
uniform float u_amount, u_lineH, u_shift, u_speed, u_wave, u_rgb;
void main() {
  float line = floor(vUv.y * uRes.y / max(pxs(u_lineH), 1.0));
  float st = floor(uTime * u_speed) + uSeed;
  float off = 0.0;
  if (hash12(vec2(line, st)) < u_amount * (1.0 + uAudio.w)) off = (hash12(vec2(line * 1.7, st + 3.0)) - 0.5) * 2.0 * u_shift;
  off += sin(vUv.y * 60.0 + uTime * 9.0) * u_wave * 0.006;
  vec2 uv = vec2(fract(vUv.x + off), vUv.y);
  float f = abs(off) * u_rgb * 0.5;
  outColor = vec4(texture(uTex, uv + vec2(f, 0)).r, texture(uTex, uv).g, texture(uTex, uv - vec2(f, 0)).b, 1.0);
}`,
};

export const censorBlocks = {
  id: 'censorBlocks',
  name: 'Censor Blocks',
  cat: 'glitch',
  key: 'count',
  params: [
    { key: 'count', min: 1, max: 12, step: 1, def: 3, rand: [1, 6] },
    { key: 'size', label: 'size (px)', min: 10, max: 600, def: 120, rand: [60, 220] },
    { key: 'aspect', min: 0.2, max: 6, def: 2.2, rand: [1, 3.5] },
    { key: 'speed', min: 0, max: 20, def: 4 },
    { key: 'style', type: 'select', options: { 'rgb noise': 0, pixelate: 1, 'color bars': 2, 'black bar': 3, 'white bar': 4, invert: 5 }, def: 0 },
    { key: 'onSubject', label: 'stick to subject', type: 'bool', def: true },
    { key: 'top', label: 'prefer top (faces)', min: 0, max: 1, def: 0.7 },
    { key: 'pix', label: 'cell (px)', min: 2, max: 80, def: 14 },
  ],
  frag: `
uniform float u_count, u_size, u_aspect, u_speed, u_style, u_onSubject, u_top, u_pix;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    if (fi >= u_count) break;
    float st = floor(uTime * u_speed + hash11(fi * 7.1) * 3.0) + uSeed;
    vec2 ctr = vec2(-9.0);
    for (int j = 0; j < 10; j++) {
      vec2 cand = hash22(vec2(fi * 13.1 + float(j) * 1.7, st));
      cand.y = mix(cand.y, 1.0 - (1.0 - cand.y) * 0.3, u_top);   // GL y is up: bias toward heads
      if (u_onSubject < 0.5 || mask(cand) > 0.5) { ctr = cand; break; }
    }
    if (ctr.x < -1.0) continue;
    float s = pxs(u_size) * (0.6 + 0.8 * hash11(fi + st));
    vec2 hs = vec2(s * u_aspect, s) * 0.5 / uRes;
    vec2 d = vUv - ctr;
    if (abs(d.x) < hs.x && abs(d.y) < hs.y) {
      vec2 cell = vec2(max(pxs(u_pix), 1.0)) / uRes;
      vec2 ci = floor(vUv / cell);
      if (u_style < 0.5) c = mix(texture(uTex, (ci + 0.5) * cell).rgb, step(0.5, hash22(ci + st).xyy * vec3(1.0, 1.0, 0.0) + vec3(0.0, 0.0, hash12(ci * 1.3 + st))), 0.75);
      else if (u_style < 1.5) c = texture(uTex, (ci + 0.5) * cell).rgb;
      else if (u_style < 2.5) c = rainbow(floor((vUv.y - ctr.y) / hs.y * 4.0) * 0.17 + hash11(fi + st));
      else if (u_style < 3.5) c = vec3(0.0);
      else if (u_style < 4.5) c = vec3(0.96);
      else c = 1.0 - c;
    }
  }
  outColor = vec4(c, 1.0);
}`,
};

export const vhs = {
  id: 'vhs',
  name: 'VHS / Interlace',
  cat: 'glitch',
  key: 'tracking',
  params: [
    { key: 'interlace', min: 0, max: 1, def: 0.4 },
    { key: 'tracking', min: 0, max: 1, def: 0.35, rand: [0.1, 0.7] },
    { key: 'bleed', label: 'chroma bleed', min: 0, max: 1, def: 0.5 },
    { key: 'noise', min: 0, max: 1, def: 0.25 },
    { key: 'wobble', min: 0, max: 1, def: 0.3 },
  ],
  frag: `
uniform float u_interlace, u_tracking, u_bleed, u_noise, u_wobble;
vec3 yiq(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 rgb(vec3 c) { return vec3(dot(c, vec3(1.0, 0.956, 0.621)), dot(c, vec3(1.0, -0.272, -0.647)), dot(c, vec3(1.0, -1.106, 1.703))); }
void main() {
  vec2 uv = vUv;
  float row = floor(uv.y * uRes.y);
  uv.x += (vnoise(vec2(row * 0.05, uTime * 3.0)) - 0.5) * 0.006 * u_wobble;
  float band = fract(uTime * 0.13 + uSeed);
  float inBand = smoothstep(0.06, 0.0, abs(uv.y - band));
  uv.x += inBand * (hash12(vec2(row, floor(uTime * 30.0))) - 0.5) * 0.08 * u_tracking;
  if (mod(row, 2.0) < 1.0) uv.x += pxs(3.0) / uRes.x * u_interlace * (0.5 + 0.5 * sin(uTime * 13.0));
  vec3 Y = yiq(texture(uTex, uv).rgb);
  vec3 C = vec3(0.0);
  for (int k = 0; k < 6; k++) C += yiq(texture(uTex, uv - vec2(float(k) * pxs(2.5) / uRes.x * u_bleed, 0.0)).rgb);
  C /= 6.0;
  vec3 c = rgb(vec3(Y.x, C.yz));
  c += (hash12(gl_FragCoord.xy + uFrame * 3.1) - 0.5) * u_noise * 0.35;
  c += inBand * u_tracking * 0.25 * hash12(vec2(row, uFrame));
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
};

export const glitchFx = [rgbSplit, blockGlitch, datamosh, pixelSort, pixelDrip, scanTear, censorBlocks, vhs];
