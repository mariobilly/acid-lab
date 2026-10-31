// Time effects: own-state feedback and a ring buffer of past frames.
// Runtimes only advance when the frame changes, so tweaking a paused frame doesn't smear it further.

const ECHO = `
uniform sampler2D uIn, uSelf;
uniform float uDecay, uHue, uDX, uDY, uZoom, uSubject, uFirst, uSat, uBlend;
void main() {
  vec3 cur = texture(uIn, vUv).rgb;
  float m = uSubject > 0.5 ? mask(vUv) : 1.0;
  vec2 q = (vUv - 0.5) / uZoom + 0.5 - vec2(uDX, uDY);
  vec4 prev = texture(uSelf, q);
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) prev = vec4(0.0);
  if (prev.a > 1e-3) {
    vec3 c = prev.rgb / prev.a;
    c = saturate3(hueShift(c, uHue), uSat);
    prev.rgb = c * prev.a;
  }
  prev *= uDecay;
  vec4 s;
  if (uSubject > 0.5) {
    s = vec4(cur * m + prev.rgb * (1.0 - m), m + prev.a * (1.0 - m));   // current subject over its ghosts
  } else {
    vec3 c = uBlend < 0.5 ? max(cur, prev.rgb) : uBlend < 1.5 ? cur + prev.rgb * 0.5 : mix(cur, prev.rgb / max(uDecay, 1e-3), uDecay);
    s = vec4(c, 1.0);
  }
  outColor = uFirst > 0.5 ? vec4(cur * m, m) : s;
}`;

export const echo = {
  id: 'echo',
  name: 'Echo Trails',
  cat: 'time',
  key: 'decay',
  params: [
    { key: 'source', type: 'select', options: { 'subject ghosts': 1, 'whole frame': 0 }, def: 1 },
    { key: 'decay', min: 0, max: 0.98, def: 0.82, rand: [0.6, 0.92] },
    { key: 'hue', label: 'hue / frame', min: -0.3, max: 0.3, def: 0.07, rand: [-0.12, 0.12] },
    { key: 'sat', label: 'ghost saturation', min: 0.5, max: 1.6, def: 1.15 },
    { key: 'dx', label: 'drift x', min: -0.03, max: 0.03, def: 0.004, rand: [-0.01, 0.01] },
    { key: 'dy', label: 'drift y', min: -0.03, max: 0.03, def: 0.002, rand: [-0.01, 0.01] },
    { key: 'zoom', min: 0.95, max: 1.06, def: 1.008 },
    { key: 'every', label: 'copy every N frames', min: 1, max: 12, step: 1, def: 1 },
    { key: 'blend', label: 'frame blend', type: 'select', options: { lighten: 0, add: 1, mix: 2 }, def: 0 },
  ],
  frag: `
uniform sampler2D uEcho;
uniform float u_source;
void main() {
  vec3 base = texture(uTex, vUv).rgb;
  vec4 s = texture(uEcho, vUv);
  vec3 o = u_source > 0.5 ? base * (1.0 - s.a) + s.rgb : s.rgb;
  if (u_source > 0.5) o = mix(o, base, mask(vUv));
  outColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`,
  runtime: (gpu) => {
    let st = [null, null], cur = 0, first = true, last = null, n = 0;
    return {
      prepare({ input, width, height, params, advance }) {
        if (!advance && last) return { uEcho: last };
        st = [gpu.fit(st[0], width, height, 'rgba16f'), gpu.fit(st[1], width, height, 'rgba16f')];
        const every = Math.max(1, Math.round(params.every));
        if (!first && last && n++ % every !== 0) return { uEcho: last };
        gpu.pass(ECHO, st[cur], {
          uIn: input, uSelf: st[cur ^ 1], uDecay: params.decay, uHue: params.hue * every, uDX: params.dx * every,
          uDY: params.dy * every, uZoom: Math.pow(params.zoom, every), uSubject: params.source, uFirst: first ? 1 : 0,
          uSat: params.sat, uBlend: params.blend,
        });
        last = st[cur];
        cur ^= 1;
        first = false;
        return { uEcho: last };
      },
      reset() { first = true; last = null; n = 0; },
      dispose() { st.forEach((t) => gpu.free(t)); },
    };
  },
};

const HIST_N = 24;
export const timeSlice = {
  id: 'timeSlice',
  name: 'Time-Slice',
  cat: 'time',
  key: 'delay',
  params: [
    { key: 'mode', type: 'select', options: { 'rgb from the past': 0, 'slit-scan rows': 1, 'slit-scan columns': 2, radial: 3, 'random blocks': 4 }, def: 0 },
    { key: 'delay', label: 'delay (frames)', min: 1, max: 11, step: 1, def: 4, rand: [2, 8] },
    { key: 'spread', min: 0.1, max: 1, def: 1 },
    { key: 'block', label: 'block (px)', min: 8, max: 300, def: 80 },
  ],
  frag: `
uniform sampler2DArray uHist;
uniform float uHead, uCount, u_mode, u_delay, u_spread, u_block;
vec3 at(float back, vec2 uv) {
  float k = clamp(floor(back), 0.0, uCount - 1.0);
  return texture(uHist, vec3(uv, mod(uHead - k + ${HIST_N}.0, ${HIST_N}.0))).rgb;
}
void main() {
  float N = (uCount - 1.0) * u_spread;
  vec3 c;
  if (u_mode < 0.5) c = vec3(at(0.0, vUv).r, at(u_delay, vUv).g, at(u_delay * 2.0, vUv).b);
  else if (u_mode < 1.5) c = at((1.0 - vUv.y) * N, vUv);
  else if (u_mode < 2.5) c = at(vUv.x * N, vUv);
  else if (u_mode < 3.5) c = at(length((vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0)) * 2.0 * N, vUv);
  else { vec2 b = floor(vUv * uRes / max(pxs(u_block), 1.0)); c = at(hash12(b + floor(uTime * 2.0)) * N, vUv); }
  outColor = vec4(c, 1.0);
}`,
  runtime: (gpu) => {
    let ring = null, head = -1, count = 0;
    const COPYF = `uniform sampler2D uIn; void main() { outColor = vec4(texture(uIn, vUv).rgb, 1.0); }`;
    return {
      prepare({ input, width, height, advance }) {
        if (!ring || ring.w !== width || ring.h !== height) {
          gpu.free(ring);
          ring = gpu.arrayTarget(width, height, HIST_N);
          head = -1;
          count = 0;
        }
        if (advance || count === 0) {
          head = (head + 1) % HIST_N;
          count = Math.min(count + 1, HIST_N);
          gpu.pass(COPYF, ring.fbos[head], { uIn: input });
        }
        return { uHist: ring, uHead: head, uCount: count };
      },
      reset() { head = -1; count = 0; },
      dispose() { gpu.free(ring); },
    };
  },
};

export const stutter = {
  id: 'stutter',
  name: 'Stutter / Strobe',
  cat: 'time',
  key: 'chance',
  params: [
    { key: 'chance', label: 'freeze chance', min: 0, max: 1, def: 0.3, rand: [0.1, 0.5] },
    { key: 'hold', label: 'hold (frames)', min: 2, max: 30, step: 1, def: 6 },
    { key: 'strobe', label: 'invert strobe', min: 0, max: 1, def: 0 },
    { key: 'beat', label: 'strobe on beat', type: 'bool', def: true },
  ],
  frag: `
uniform sampler2D uHold;
uniform float uHolding, u_strobe, u_beat;
void main() {
  vec3 c = uHolding > 0.5 ? texture(uHold, vUv).rgb : texture(uTex, vUv).rgb;
  float flash = step(1.0 - u_strobe * 0.35, hash11(floor(uTime * 15.0) + uSeed * 3.0));
  if (u_beat > 0.5) flash = max(flash, step(0.6, uAudio.w) * step(0.01, u_strobe));
  outColor = vec4(mix(c, 1.0 - c, flash), 1.0);
}`,
  runtime: (gpu) => {
    let hold = null, holding = 0;
    const COPYF = `uniform sampler2D uIn; void main() { outColor = vec4(texture(uIn, vUv).rgb, 1.0); }`;
    return {
      prepare({ input, width, height, frame, params, seed, advance }) {
        hold = gpu.fit(hold, width, height, 'rgba16f');
        const len = Math.max(2, Math.round(params.hold));
        const bucket = Math.floor(frame / len);
        const r = Math.abs(Math.sin((bucket + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1;
        const inHold = r < params.chance;
        if (advance || !holding) {
          if (!inHold || frame % len === 0) gpu.pass(COPYF, hold, { uIn: input });
          holding = inHold && frame % len !== 0 ? 1 : 0;
        }
        return { uHold: hold, uHolding: holding };
      },
      reset() { holding = 0; },
      dispose() { gpu.free(hold); },
    };
  },
};

export const timeFx = [echo, timeSlice, stutter];
