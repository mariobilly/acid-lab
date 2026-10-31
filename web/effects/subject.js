// Subject effects: everything that needs the cutout mask (uMask). This is the "Neon Specimen" look —
// subject on an animated pattern, wrapped in a neon halo.

export const PATTERNS = {
  checker: 0, 'warped checker': 1, 'wobble lines': 2, scanlines: 3, squiggles: 4, 'op-art waves': 5,
  dots: 6, grid: 7, rings: 8, static: 9, stripes: 10, plaid: 11,
};

export const patternBg = {
  id: 'patternBg',
  name: 'Pattern Background',
  cat: 'subject',
  needsMask: true,
  key: 'warp',
  params: [
    { key: 'pattern', type: 'select', options: PATTERNS, def: 0 },
    { key: 'scale', label: 'cell size', min: 4, max: 160, def: 34, rand: [10, 70] },
    { key: 'speed', min: -4, max: 4, def: 0.6, rand: [-1.5, 1.5] },
    { key: 'warp', min: 0, max: 1, def: 0.15, rand: [0, 0.6] },
    { key: 'angle', min: 0, max: 180, def: 0 },
    { key: 'thick', label: 'line weight', min: 0.05, max: 0.95, def: 0.5, rand: [0.2, 0.7] },
    { key: 'colorMode', label: 'colors', type: 'select', options: { 'two colors': 0, rainbow: 1, 'cycling hue': 2 }, def: 0 },
    { key: 'colorA', label: 'color A', type: 'color', def: '#ff1fd2' },
    { key: 'colorB', label: 'color B', type: 'color', def: '#4a4a66' },
    { key: 'hueSpeed', label: 'hue speed', min: 0, max: 2, def: 0.2 },
    { key: 'keep', label: 'keep original bg', min: 0, max: 1, def: 0 },
  ],
  frag: `
uniform float u_pattern, u_scale, u_speed, u_warp, u_angle, u_thick, u_colorMode, u_hueSpeed, u_keep;
uniform vec3 u_colorA, u_colorB;
float pat(vec2 p, float t, out float cellId) {
  float id = u_pattern;
  float th = u_thick;
  cellId = 0.0;
  if (id < 0.5 || (id > 0.5 && id < 1.5)) {               // checker / warped checker
    vec2 c = floor(p); cellId = hash12(c);
    return mod(c.x + c.y, 2.0);
  } else if (id < 2.5) {                                    // wobble lines: jittery colored segments per row
    float row = floor(p.y);
    float seg = floor(p.x * 0.35 + hash11(row) * 40.0 + t * (hash11(row + 7.0) - 0.5) * 6.0);
    cellId = hash12(vec2(row, seg));
    return step(th * 0.5, fract(p.y)) * cellId;
  } else if (id < 3.5) {                                    // scanlines
    return step(1.0 - th * 0.6, fract(p.y + t * 0.5));
  } else if (id < 4.5) {                                    // squiggles: contour lines of moving noise
    float n = vnoise(p * 1.3 + vec2(t * 0.35, -t * 0.2)) * 0.7 + vnoise(p * 2.9 - t * 0.2) * 0.3;
    return 1.0 - smoothstep(0.012, 0.012 + th * 0.05, abs(n - 0.5));
  } else if (id < 5.5) {                                    // op-art waves
    float y = p.y + sin(p.x * 0.45 + t * 2.0) * 0.9 + sin(p.x * 0.13 - t) * 1.5;
    return step(th, fract(y));
  } else if (id < 6.5) {                                    // dots
    vec2 c = floor(p); cellId = hash12(c);
    float r = 0.18 + 0.22 * th + 0.1 * sin(t * 2.0 + c.x * 0.4 + c.y * 0.3);
    return step(length(fract(p) - 0.5), r);
  } else if (id < 7.5) {                                    // grid
    vec2 f = fract(p);
    float w = th * 0.25;
    return max(step(1.0 - w, f.x), step(1.0 - w, f.y));
  } else if (id < 8.5) {                                    // rings
    return step(th, fract(length(p) * 0.25 - t * 0.6));
  } else if (id < 9.5) {                                    // static
    cellId = hash12(floor(p * 4.0) + floor(uFrame) * 17.31);
    return step(0.5, cellId);
  } else if (id < 10.5) {                                   // diagonal stripes
    return step(th, fract((p.x + p.y) * 0.5));
  }
  vec2 f = fract(p * 0.5);                                  // plaid
  return clamp(step(th, f.x) * 0.5 + step(th, f.y) * 0.5, 0.0, 1.0);
}
void main() {
  vec3 base = texture(uTex, vUv).rgb;
  float t = uTime * u_speed;
  vec2 p = (vUv - 0.5) * uRes / max(pxs(u_scale), 1.0);   // in cells
  float a = radians(u_angle);
  p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  float warp = u_warp + (u_pattern > 0.5 && u_pattern < 1.5 ? 0.45 : 0.0);
  p += (vec2(fbm(p * 0.09 + t * 0.15, 3.0), fbm(p * 0.09 + 5.2 - t * 0.15, 3.0)) - 0.5) * warp * 9.0;
  if (u_pattern < 1.5 || u_pattern > 5.5) p += vec2(t, t * 0.35);
  float cid;
  float v = pat(p, t, cid);
  vec3 col;
  if (u_colorMode < 0.5) col = mix(u_colorB, u_colorA, v);
  else if (u_colorMode < 1.5) col = mix(u_colorB * 0.25, rainbow(cid + v * 0.35 + uTime * u_hueSpeed), max(v, 0.15));
  else col = hueShift(mix(u_colorB, u_colorA, v), uTime * u_hueSpeed);
  float m = mask(vUv);
  outColor = vec4(mix(mix(col, base, m), base, u_keep), 1.0);
}`,
};

export const neonHalo = {
  id: 'neonHalo',
  name: 'Neon Halo',
  cat: 'subject',
  needsMask: true,
  key: 'glow',
  params: [
    { key: 'width', label: 'width (px)', min: 2, max: 90, def: 26, rand: [10, 50] },
    { key: 'fill', label: 'inner glow', min: 0, max: 1, def: 0.85, rand: [0.3, 1] },
    { key: 'line', label: 'outer line', min: 0, max: 1, def: 1, rand: [0, 1] },
    { key: 'glow', label: 'soft glow', min: 0, max: 1, def: 0.35, rand: [0, 0.7] },
    { key: 'colorMode', label: 'colors', type: 'select', options: { 'two-tone': 0, 'rainbow bands': 1, 'cycling hue': 2 }, def: 0 },
    { key: 'colorA', label: 'inner color', type: 'color', def: '#ff1a1a' },
    { key: 'colorB', label: 'line color', type: 'color', def: '#f6ff00' },
    { key: 'speed', label: 'color speed', min: 0, max: 3, def: 0.6 },
    { key: 'pulse', label: 'pulse / beat', min: 0, max: 1, def: 0.15 },
    { key: 'wobble', min: 0, max: 1, def: 0.2 },
  ],
  frag: `
uniform float u_width, u_fill, u_line, u_glow, u_colorMode, u_speed, u_pulse, u_wobble;
uniform vec3 u_colorA, u_colorB;
void main() {
  vec3 base = texture(uTex, vUv).rgb;
  float m0 = mask(vUv);
  float W = pxs(u_width) * (1.0 + u_pulse * (0.35 * sin(uTime * 7.0) + 0.8 * uAudio.w));
  // jittery outline: offset the lookup a little with noise so the halo boils like hand-drawn neon
  vec2 wob = (vec2(vnoise(vUv * 18.0 + uTime * 3.0), vnoise(vUv * 18.0 - uTime * 3.0 + 9.0)) - 0.5) * u_wobble * W * 0.6 / uRes;
  float dist = 1e4;
  if (m0 < 0.5) {
    for (int r = 1; r <= 10; r++) {
      float rad = W * float(r) / 10.0;
      bool hit = false;
      for (int k = 0; k < 16; k++) {
        float ang = float(k) * TAU / 16.0 + float(r) * 0.37;
        if (mask(vUv + wob + vec2(cos(ang), sin(ang)) * rad / uRes) > 0.5) { hit = true; break; }
      }
      if (hit) { dist = rad; break; }
    }
  } else dist = 0.0;
  float d = clamp(dist / max(W, 1.0), 0.0, 1.0);
  float inside = dist < 1e3 ? 1.0 : 0.0;
  vec3 cA = u_colorA, cB = u_colorB;
  if (u_colorMode > 0.5 && u_colorMode < 1.5) { cA = rainbow(d * 1.4 - uTime * u_speed); cB = rainbow(d * 1.4 - uTime * u_speed + 0.5); }
  else if (u_colorMode > 1.5) { cA = hueShift(u_colorA, uTime * u_speed * 0.3); cB = hueShift(u_colorB, uTime * u_speed * 0.3); }
  float fill = u_fill * inside * pow(1.0 - d, 0.6);
  float line = u_line * inside * smoothstep(0.62, 0.8, d) * (1.0 - smoothstep(0.93, 1.0, d));
  vec3 c = mix(base, cA, clamp(fill, 0.0, 1.0));
  c = mix(c, cB, clamp(line, 0.0, 1.0));
  c += cA * u_glow * inside * exp(-d * 2.5) * 0.6;
  outColor = vec4(mix(c, base, m0), 1.0);
}`,
};

export const subjectFx = [patternBg, neonHalo];
