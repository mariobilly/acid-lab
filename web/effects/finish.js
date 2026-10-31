// Finishing effects: neon edges, bloom, grain / vignette / scanlines.

export const edgeNeon = {
  id: 'edgeNeon',
  name: 'Edge Neon',
  cat: 'finish',
  key: 'amount',
  params: [
    { key: 'amount', min: 0, max: 3, def: 1.2, rand: [0.6, 2] },
    { key: 'threshold', min: 0, max: 1, def: 0.18, rand: [0.08, 0.35] },
    { key: 'thick', label: 'thickness (px)', min: 0.5, max: 6, def: 1.5 },
    { key: 'colorMode', label: 'colors', type: 'select', options: { rainbow: 0, solid: 1, 'boosted source': 2 }, def: 0 },
    { key: 'color', type: 'color', def: '#39ff14' },
    { key: 'dim', label: 'darken image', min: 0, max: 1, def: 0.2, rand: [0, 0.7] },
    { key: 'speed', label: 'color speed', min: 0, max: 3, def: 0.5 },
  ],
  frag: `
uniform float u_amount, u_threshold, u_thick, u_colorMode, u_dim, u_speed;
uniform vec3 u_color;
float L(vec2 o) { return luma(texture(uTex, vUv + o).rgb); }
void main() {
  vec2 p = px() * pxs(u_thick);
  float tl = L(vec2(-p.x, p.y)), t = L(vec2(0, p.y)), tr = L(vec2(p.x, p.y));
  float l = L(vec2(-p.x, 0)), r = L(vec2(p.x, 0));
  float bl = L(vec2(-p.x, -p.y)), b = L(vec2(0, -p.y)), br = L(vec2(p.x, -p.y));
  vec2 g = vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, tl + 2.0 * t + tr - bl - 2.0 * b - br);
  float e = smoothstep(u_threshold, u_threshold + 0.25, length(g));
  vec3 base = texture(uTex, vUv).rgb;
  vec3 col;
  if (u_colorMode < 0.5) col = rainbow(atan(g.y, g.x) / TAU + uTime * u_speed + luma(base));
  else if (u_colorMode < 1.5) col = u_color;
  else col = saturate3(base, 2.5) * 1.6;
  outColor = vec4(clamp(base * (1.0 - u_dim) + col * e * u_amount, 0.0, 1.0), 1.0);
}`,
};

export const bloom = {
  id: 'bloom',
  name: 'Bloom',
  cat: 'finish',
  key: 'intensity',
  params: [
    { key: 'intensity', min: 0, max: 3, def: 0.9, rand: [0.4, 1.6] },
    { key: 'threshold', min: 0, max: 1, def: 0.6 },
    { key: 'radius', label: 'radius (px)', min: 2, max: 80, def: 24 },
    { key: 'tint', type: 'color', def: '#ffffff' },
  ],
  frag: `
uniform float u_intensity, u_threshold, u_radius;
uniform vec3 u_tint;
vec3 bright(vec2 uv) { vec3 c = texture(uTex, uv).rgb; return c * smoothstep(u_threshold, u_threshold + 0.2, luma(c)); }
void main() {
  vec3 base = texture(uTex, vUv).rgb;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int r = 1; r <= 4; r++) {
    float rad = pxs(u_radius) * float(r) / 4.0;
    for (int k = 0; k < 12; k++) {
      float a = float(k) * TAU / 12.0 + float(r) * 0.5;
      float w = 1.0 / float(r);
      acc += bright(vUv + vec2(cos(a), sin(a)) * rad / uRes) * w;
      wsum += w;
    }
  }
  outColor = vec4(clamp(base + acc / wsum * u_intensity * u_tint * 2.0, 0.0, 1.0), 1.0);
}`,
};

export const grain = {
  id: 'grain',
  name: 'Grain / Vignette',
  cat: 'finish',
  key: 'grain',
  params: [
    { key: 'grain', min: 0, max: 0.5, def: 0.08, rand: [0.03, 0.15] },
    { key: 'size', label: 'grain size', min: 1, max: 6, def: 1.5 },
    { key: 'chroma', label: 'color noise', min: 0, max: 1, def: 0.3 },
    { key: 'vignette', min: 0, max: 1.5, def: 0.45 },
    { key: 'scanlines', min: 0, max: 1, def: 0 },
  ],
  frag: `
uniform float u_grain, u_size, u_chroma, u_vignette, u_scanlines;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  vec2 g = floor(gl_FragCoord.xy / max(pxs(u_size), 1.0));
  float n = hash12(g + uFrame * 7.13) - 0.5;
  vec3 cn = vec3(hash12(g + 3.1 + uFrame), hash12(g + 5.7 + uFrame), hash12(g + 9.9 + uFrame)) - 0.5;
  c += mix(vec3(n), cn, u_chroma) * u_grain;
  vec2 v = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  c *= 1.0 - u_vignette * smoothstep(0.35, 1.0, length(v) * 1.2);
  c *= 1.0 - u_scanlines * 0.35 * step(0.5, fract(gl_FragCoord.y / max(pxs(3.0), 1.0)));
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
};

export const finishFx = [edgeNeon, bloom, grain];
