// Distortion effects. Liquid, Kaleido and Tunnel are ported from Glitch Chain's warp.ts.

export const liquid = {
  id: 'liquid',
  name: 'Liquid Warp',
  cat: 'distort',
  key: 'amount',
  params: [
    { key: 'amount', min: 0, max: 0.3, def: 0.035, rand: [0.01, 0.08] },
    { key: 'map', type: 'select', options: { 'noise (liquid)': 0, 'own brightness': 1, 'sine bands': 2, blocks: 3 }, def: 0 },
    { key: 'scale', min: 0.2, max: 30, def: 4, rand: [1.5, 9] },
    { key: 'speed', min: 0, max: 4, def: 0.4 },
    { key: 'octaves', min: 1, max: 6, step: 1, def: 3 },
    { key: 'direction', type: 'select', options: { both: 0, horizontal: 1, vertical: 2 }, def: 0 },
    { key: 'rgb', label: 'rgb split', min: 0, max: 1, def: 0.25 },
  ],
  frag: `
uniform float u_amount, u_map, u_scale, u_speed, u_octaves, u_direction, u_rgb;
vec2 field(vec2 uv) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * u_scale;
  float t = uTime * u_speed;
  vec2 d;
  if (u_map < 0.5) d = vec2(fbm(p + t, u_octaves), fbm(p + vec2(5.2, 1.3) - t, u_octaves)) - 0.5;
  else if (u_map < 1.5) {
    float l = luma(texture(uTex, uv).rgb);
    d = vec2(l - 0.5, 0.5 - l) + (vec2(fbm(p + t, 2.0), fbm(p - t, 2.0)) - 0.5) * 0.3;
  } else if (u_map < 2.5) d = vec2(sin(uv.y * u_scale * 20.0 + t * 6.0), cos(uv.x * u_scale * 13.0 - t * 4.0)) * 0.5;
  else { vec2 c = floor(p); d = vec2(hash12(c + floor(t * 4.0)), hash12(c + 9.1 + floor(t * 4.0))) - 0.5; }
  if (u_direction > 0.5 && u_direction < 1.5) d.y = 0.0;
  if (u_direction > 1.5) d.x = 0.0;
  return d * 2.0;
}
void main() {
  vec2 d = field(vUv) * u_amount * (1.0 + uAudio.w * 0.5);
  vec3 c = vec3(texture(uTex, vUv + d * (1.0 + u_rgb * 0.5)).r, texture(uTex, vUv + d).g, texture(uTex, vUv + d * (1.0 - u_rgb * 0.5)).b);
  outColor = vec4(c, 1.0);
}`,
};

export const kaleido = {
  id: 'kaleido',
  name: 'Kaleidoscope / Mirror',
  cat: 'distort',
  key: 'segments',
  params: [
    { key: 'mode', type: 'select', options: { 'mirror left→right': 0, 'mirror top→bottom': 1, quad: 2, kaleidoscope: 3 }, def: 3 },
    { key: 'segments', min: 2, max: 16, step: 1, def: 6, rand: [3, 10] },
    { key: 'rotate', min: 0, max: 6.2832, def: 0 },
    { key: 'spin', label: 'spin speed', min: -2, max: 2, def: 0.1, rand: [-0.4, 0.4] },
    { key: 'zoom', min: 0.3, max: 3, def: 1 },
    { key: 'centerX', label: 'center x', min: 0, max: 1, def: 0.5 },
    { key: 'centerY', label: 'center y', min: 0, max: 1, def: 0.5 },
  ],
  frag: `
uniform float u_mode, u_segments, u_rotate, u_spin, u_zoom, u_centerX, u_centerY;
void main() {
  vec2 uv = vUv;
  vec2 c = vec2(u_centerX, u_centerY);
  if (u_mode < 0.5) uv.x = c.x - abs(uv.x - c.x);
  else if (u_mode < 1.5) uv.y = c.y + abs(uv.y - c.y);
  else if (u_mode < 2.5) uv = c - abs(uv - c);
  else {
    float asp = uRes.x / uRes.y;
    vec2 p = (uv - c) * vec2(asp, 1.0);
    float r = length(p) / u_zoom;
    float a = atan(p.y, p.x) + u_rotate + uTime * u_spin;
    float seg = TAU / u_segments;
    a = mod(a, seg);
    a = abs(a - seg * 0.5);
    uv = c + vec2(cos(a), sin(a)) * r / vec2(asp, 1.0);
  }
  uv = clamp(uv, 0.0, 1.0);
  outColor = vec4(texture(uTex, uv).rgb, 1.0);
}`,
};

const FEEDBACK = `
uniform sampler2D uIn, uSelf;
uniform float uFeedback, uZoom, uRotate, uShiftX, uShiftY, uHue, uWarp, uMode, uFirst, uDecaySat;
void main() {
  vec3 cur = texture(uIn, vUv).rgb;
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float a = uRotate;
  p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p / uZoom;
  p += (vec2(fbm(p * 3.0 + uTime * 0.3, 3.0), fbm(p * 3.0 - uTime * 0.3 + 4.0, 3.0)) - 0.5) * uWarp;
  vec2 q = p / vec2(uRes.x / uRes.y, 1.0) + 0.5 - vec2(uShiftX, uShiftY);
  vec3 prev = texture(uSelf, q).rgb;
  prev = saturate3(hueShift(prev, uHue / TAU), uDecaySat) * uFeedback;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) prev = vec3(0.0);
  vec3 c = uMode < 0.5 ? max(cur, prev) : uMode < 1.5 ? cur + prev * 0.5 : mix(cur, prev, uFeedback);
  outColor = vec4(uFirst > 0.5 ? cur : c, 1.0);
}`;

export const tunnel = {
  id: 'tunnel',
  name: 'Feedback Tunnel',
  cat: 'distort',
  key: 'feedback',
  params: [
    { key: 'feedback', min: 0, max: 0.99, def: 0.85, rand: [0.6, 0.93] },
    { key: 'mode', type: 'select', options: { lighten: 0, add: 1, mix: 2 }, def: 0 },
    { key: 'zoom', min: 0.9, max: 1.1, def: 1.025, rand: [0.97, 1.05] },
    { key: 'rotate', label: 'rotate (rad/frame)', min: -0.1, max: 0.1, def: 0.01, rand: [-0.03, 0.03] },
    { key: 'shiftX', label: 'drift x', min: -0.02, max: 0.02, def: 0 },
    { key: 'shiftY', label: 'drift y', min: -0.02, max: 0.02, def: 0 },
    { key: 'warp', label: 'noise warp', min: 0, max: 0.05, def: 0.004 },
    { key: 'hue', label: 'hue cycle', min: 0, max: 0.5, def: 0.12 },
    { key: 'saturate', min: 0.5, max: 1.3, def: 1.03 },
  ],
  frag: `
uniform sampler2D uFb;
void main() { outColor = vec4(texture(uFb, vUv).rgb, 1.0); }`,
  runtime: (gpu) => {
    let st = [null, null], cur = 0, first = true, last = null;
    return {
      prepare({ input, width, height, params, advance }) {
        if (!advance && last) return { uFb: last };
        st = [gpu.fit(st[0], width, height, 'rgba16f'), gpu.fit(st[1], width, height, 'rgba16f')];
        gpu.pass(FEEDBACK, st[cur], {
          uIn: input, uSelf: st[cur ^ 1], uFeedback: params.feedback, uMode: params.mode, uZoom: params.zoom,
          uRotate: params.rotate, uShiftX: params.shiftX, uShiftY: params.shiftY, uWarp: params.warp, uHue: params.hue,
          uDecaySat: params.saturate, uFirst: first ? 1 : 0,
        });
        last = st[cur];
        cur ^= 1;
        first = false;
        return { uFb: last };
      },
      reset() { first = true; last = null; },
      dispose() { st.forEach((t) => gpu.free(t)); },
    };
  },
};

export const wave = {
  id: 'wave',
  name: 'Wave / Swirl',
  cat: 'distort',
  key: 'ampX',
  params: [
    { key: 'ampX', label: 'wave x', min: 0, max: 0.1, def: 0.012, rand: [0, 0.03] },
    { key: 'ampY', label: 'wave y', min: 0, max: 0.1, def: 0.004, rand: [0, 0.02] },
    { key: 'freq', label: 'frequency', min: 0.5, max: 40, def: 6, rand: [2, 14] },
    { key: 'speed', min: -10, max: 10, def: 2.5 },
    { key: 'swirl', min: -6, max: 6, def: 0, rand: [-2, 2] },
    { key: 'radius', label: 'swirl radius', min: 0.05, max: 1.2, def: 0.6 },
  ],
  frag: `
uniform float u_ampX, u_ampY, u_freq, u_speed, u_swirl, u_radius;
void main() {
  vec2 uv = vUv;
  uv.x += sin(uv.y * u_freq * TAU + uTime * u_speed) * u_ampX;
  uv.y += sin(uv.x * u_freq * TAU * 0.7 + uTime * u_speed * 1.3) * u_ampY;
  if (u_swirl != 0.0) {
    float asp = uRes.x / uRes.y;
    vec2 p = (uv - 0.5) * vec2(asp, 1.0);
    float r = length(p);
    float a = u_swirl * smoothstep(u_radius, 0.0, r) * (0.8 + 0.2 * sin(uTime));
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
    uv = p / vec2(asp, 1.0) + 0.5;
  }
  outColor = vec4(texture(uTex, clamp(uv, 0.0, 1.0)).rgb, 1.0);
}`,
};

export const distortFx = [liquid, wave, kaleido, tunnel];
