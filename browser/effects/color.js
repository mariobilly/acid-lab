// Color effects: acid hue cycling, posterize, solarize, gradient maps, deep-fry crunch.

export const acidHue = {
  id: 'acidHue',
  name: 'Acid Hue Cycle',
  cat: 'color',
  key: 'spread',
  params: [
    { key: 'shift', label: 'hue shift°', min: 0, max: 360, def: 0, rand: [0, 360] },
    { key: 'speed', label: 'cycle speed', min: -2, max: 2, def: 0.25, rand: [-0.6, 0.6] },
    { key: 'spread', label: 'luma spread', min: 0, max: 3, def: 0.6, rand: [0, 1.6] },
    { key: 'sat', label: 'saturation', min: 0, max: 3, def: 1.6, rand: [1.1, 2.2] },
    { key: 'contrast', min: 0.5, max: 2.5, def: 1.15 },
  ],
  frag: `
uniform float u_shift, u_speed, u_spread, u_sat, u_contrast;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  vec3 h = rgb2hsv(c);
  h.x = fract(h.x + u_shift / 360.0 + uTime * u_speed + h.z * u_spread);
  h.y = clamp(h.y * u_sat + (u_sat - 1.0) * 0.08, 0.0, 1.0);
  c = hsv2rgb(h);
  c = (c - 0.5) * u_contrast + 0.5;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
};

export const posterize = {
  id: 'posterize',
  name: 'Posterize',
  cat: 'color',
  key: 'levels',
  params: [
    { key: 'levels', min: 2, max: 16, step: 1, def: 5, rand: [3, 7] },
    { key: 'gamma', min: 0.3, max: 2.5, def: 1 },
    { key: 'dither', min: 0, max: 1, def: 0.15 },
  ],
  frag: `
uniform float u_levels, u_gamma, u_dither;
void main() {
  vec3 c = pow(texture(uTex, vUv).rgb, vec3(u_gamma));
  float n = (hash12(gl_FragCoord.xy) - 0.5) * u_dither;
  float L = max(u_levels - 1.0, 1.0);
  c = floor(c * L + 0.5 + n) / L;
  outColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / u_gamma)), 1.0);
}`,
};

export const solarize = {
  id: 'solarize',
  name: 'Solarize / Invert',
  cat: 'color',
  key: 'threshold',
  params: [
    { key: 'mode', type: 'select', options: { solarize: 0, invert: 1, 'invert brightness': 2, 'acid fold': 3 }, def: 0 },
    { key: 'threshold', min: 0, max: 1, def: 0.5, rand: [0.3, 0.7] },
    { key: 'flicker', label: 'flicker / beat', min: 0, max: 1, def: 0 },
  ],
  frag: `
uniform float u_mode, u_threshold, u_flicker;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  vec3 o;
  if (u_mode < 0.5) o = mix(c, 1.0 - c, step(u_threshold, c));
  else if (u_mode < 1.5) o = 1.0 - c;
  else if (u_mode < 2.5) { vec3 h = rgb2hsv(c); h.z = 1.0 - h.z; o = hsv2rgb(h); }
  else o = abs(fract(c * 2.0 * (0.5 + u_threshold)) * 2.0 - 1.0);
  float on = 1.0;
  if (u_flicker > 0.0) on = step(u_flicker, hash11(floor(uTime * 12.0) + uSeed)) * (1.0 - step(0.5, uAudio.w * u_flicker));
  outColor = vec4(mix(c, o, on), 1.0);
}`,
};

// 5-stop gradients, dark -> light.
const PALETTES = {
  toxic: ['#12001f', '#5b00a8', '#00ff6a', '#d8ff00', '#ffffff'],
  thermal: ['#000020', '#3a00a0', '#ff0080', '#ffb000', '#ffffe0'],
  vaporwave: ['#1a0033', '#7a00ff', '#ff4fd8', '#00e5ff', '#fff3ff'],
  infrared: ['#003300', '#ff0055', '#ff66cc', '#ffd1f0', '#ffffff'],
  sunset: ['#1b0030', '#7b1fa2', '#ff5722', '#ffc107', '#fff8e1'],
  'pastel drip': ['#3d2b3d', '#a07a9b', '#e7b7c8', '#f8e1d9', '#fffaf4'],
  'x-ray': ['#000000', '#002b45', '#00b7ff', '#b8f3ff', '#ffffff'],
  'blood neon': ['#000000', '#5a0010', '#ff0033', '#ff9a00', '#fff200'],
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export const gradientMap = {
  id: 'gradientMap',
  name: 'Gradient Map',
  cat: 'color',
  key: 'mix',
  params: [
    { key: 'palette', type: 'select', options: Object.fromEntries(Object.keys(PALETTES).map((k, i) => [k, i])), def: 0 },
    { key: 'cycle', label: 'cycle speed', min: -2, max: 2, def: 0, rand: [-0.4, 0.4] },
    { key: 'offset', min: 0, max: 1, def: 0 },
    { key: 'contrast', min: 0.5, max: 3, def: 1.2 },
    { key: 'mix', min: 0, max: 1, def: 1, rand: [0.5, 1] },
  ],
  extra: (p) => {
    const name = Object.keys(PALETTES)[Math.round(p.palette)] || 'toxic';
    return { u_stops: new Float32Array(PALETTES[name].flatMap(hex)) };
  },
  frag: `
uniform float u_cycle, u_offset, u_contrast, u_mix;
uniform float u_stops[15];
vec3 stopc(int i) { return vec3(u_stops[i * 3], u_stops[i * 3 + 1], u_stops[i * 3 + 2]); }
vec3 grad(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  int i = int(min(floor(t), 3.0));
  return mix(stopc(i), stopc(i + 1), t - float(i));
}
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float l = clamp((luma(c) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float t = l;
  if (u_cycle != 0.0 || u_offset != 0.0) t = abs(fract(l * 0.5 + u_offset + uTime * u_cycle * 0.25) * 2.0 - 1.0);
  outColor = vec4(mix(c, grad(t), u_mix), 1.0);
}`,
};

export const deepFry = {
  id: 'deepFry',
  name: 'Deep-Fry',
  cat: 'color',
  key: 'crunch',
  params: [
    { key: 'sharpen', min: 0, max: 3, def: 1.2, rand: [0.5, 2] },
    { key: 'contrast', min: 0.5, max: 3, def: 1.45, rand: [1.1, 1.8] },
    { key: 'sat', label: 'saturation', min: 0, max: 4, def: 2.1, rand: [1.4, 2.8] },
    { key: 'crunch', label: 'jpeg crunch', min: 0, max: 1, def: 0.45, rand: [0.1, 0.8] },
    { key: 'heat', min: 0, max: 1, def: 0.15 },
    { key: 'noise', min: 0, max: 0.3, def: 0.04 },
  ],
  frag: `
uniform float u_sharpen, u_contrast, u_sat, u_crunch, u_heat, u_noise;
void main() {
  vec2 p = px() * max(1.0, pxs(1.0));
  vec3 c = texture(uTex, vUv).rgb;
  vec3 b = (texture(uTex, vUv + vec2(p.x, 0)).rgb + texture(uTex, vUv - vec2(p.x, 0)).rgb +
            texture(uTex, vUv + vec2(0, p.y)).rgb + texture(uTex, vUv - vec2(0, p.y)).rgb) * 0.25;
  c += (c - b) * u_sharpen * 2.5;
  if (u_crunch > 0.0) {
    // codec-style chroma blocks: luma stays sharp, color snaps to 8px blocks
    vec2 bs = vec2(pxs(8.0)) / uRes;
    vec3 cb = texture(uTex, (floor(vUv / bs) + 0.5) * bs).rgb;
    float l = luma(c);
    vec3 chroma = mix(c - luma(c), cb - luma(cb), u_crunch);
    c = l + chroma;
    float q = mix(64.0, 6.0, u_crunch);
    c = floor(c * q + 0.5) / q;
  }
  c = saturate3(c, u_sat);
  c = (c - 0.5) * u_contrast + 0.5;
  c *= mix(vec3(1.0), vec3(1.18, 0.98, 0.72), u_heat);
  c += (hash12(gl_FragCoord.xy + uFrame) - 0.5) * u_noise;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
};

export const colorFx = [acidHue, posterize, solarize, gradientMap, deepFry];
