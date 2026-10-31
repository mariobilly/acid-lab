// Small WebGL2 toolkit: fullscreen passes from a fragment body, cached programs, float render targets.
// The shared HEADER gives every effect the same inputs and helper functions.

export const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const HEADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;   // this pass's input
uniform sampler2D uSrc;   // untouched source, already framed to the output
uniform sampler2D uMask;  // subject mask in output space (r: 1 = subject)
uniform vec2 uRes;
uniform float uTime, uFrame, uSeed;
uniform vec4 uAudio;      // level, low, high, beat (0..1)

#define PI 3.14159265
#define TAU 6.28318531
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p, float oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { if (float(i) >= oct) break; s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 hueShift(vec3 c, float h) { vec3 v = rgb2hsv(c); v.x = fract(v.x + h); return hsv2rgb(v); }
vec3 rainbow(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67))); }
vec3 saturate3(vec3 c, float s) { return mix(vec3(luma(c)), c, s); }
float mask(vec2 uv) { return texture(uMask, uv).r; }
vec2 px() { return 1.0 / uRes; }
// Pixel sizes are authored against a 1080-px short side so looks hold at any output size.
float pxs(float v) { return v * min(uRes.x, uRes.y) / 1080.0; }
`;

export class Program {
  constructor(gl, frag) {
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        console.error(lines);
        throw new Error(gl.getShaderInfoLog(s) || 'shader error');
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
    this.prog = p;
    this.locs = new Map();
  }
  loc(name) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.locs.get(name);
  }
}

const isRT = (u) => u && typeof u === 'object' && 'fbo' in u;

export class Gpu {
  constructor(gl) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.programs = new Map();
    // Uniforms every pass receives (inputs shared by all effects).
    this.globals = {};
  }

  program(frag) {
    let p = this.programs.get(frag);
    if (!p) {
      p = new Program(this.gl, HEADER + frag);
      this.programs.set(frag, p);
    }
    return p;
  }

  texture(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  target(w, h, fmt = 'rgba8', linear = true) {
    const gl = this.gl;
    if (fmt !== 'rgba8' && !this.floatOk) fmt = 'rgba8';
    const tex = this.texture(linear && fmt !== 'rgba32f' ? gl.LINEAR : gl.NEAREST);
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (fmt === 'rgba8') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    else if (fmt === 'rgba16f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, fmt };
  }

  /** A ring of `n` frames as one TEXTURE_2D_ARRAY, with one framebuffer per layer. */
  arrayTarget(w, h, n) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, n);
    const fbos = [];
    for (let i = 0; i < n; i++) {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, i);
      fbos.push({ fbo: f, w, h });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbos, w, h, n, array: true };
  }

  free(rt) {
    if (!rt) return;
    const gl = this.gl;
    gl.deleteTexture(rt.tex);
    if (rt.fbo) gl.deleteFramebuffer(rt.fbo);
    if (rt.fbos) rt.fbos.forEach((f) => gl.deleteFramebuffer(f.fbo));
  }

  fit(rt, w, h, fmt = 'rgba8', linear = true) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (rt && rt.w === w && rt.h === h && (rt.fmt === fmt || !this.floatOk)) return rt;
    this.free(rt);
    return this.target(w, h, fmt, linear);
  }

  /** Draw a fullscreen pass into `out` (null = canvas). Numbers -> float, arrays -> vecN, textures -> samplers. */
  pass(frag, out, uniforms = {}, canvasSize) {
    const gl = this.gl;
    const p = this.program(frag);
    gl.useProgram(p.prog);
    const [w, h] = out ? [out.w, out.h] : canvasSize;
    gl.uniform2f(p.loc('uRes'), w, h);
    let unit = 0;
    const all = { ...this.globals, ...uniforms };
    for (const name in all) {
      const v = all[name];
      const loc = p.loc(name);
      if (loc === null || v === undefined || v === null) continue;
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (Array.isArray(v) || v instanceof Float32Array) {
        if (v.length === 2) gl.uniform2fv(loc, v);
        else if (v.length === 3) gl.uniform3fv(loc, v);
        else if (v.length === 4) gl.uniform4fv(loc, v);
        else gl.uniform1fv(loc, v);
      } else if (v.array) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, v.tex);
        gl.uniform1i(loc, unit++);
      } else {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, isRT(v) ? v.tex : v);
        gl.uniform1i(loc, unit++);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export const COPY = `void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;
