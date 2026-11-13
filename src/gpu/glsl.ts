// The shaders of the WebGL2 backend. src/gpu/wgsl.ts holds the same programs for WebGPU;
// src/gpu/coverage.ts holds the same arithmetic in plain code, with its tests.
//
// Positions are device pixels with the origin at the top left, like the SVG. Coverage is
// worked out per pixel from geometry (no multisampling): see coverage.ts for the formulas.
import { END_N, LUT_H, LUT_W, SHARP } from './coverage';

const f = (n: number) => n.toFixed(1);

const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2D;
`;

/** Shared by the fragment shaders: how much of a pixel lies inside an edge, a disc, a round end. */
const COVERAGE = /* glsl */ `
uniform sampler2DArray u_disc;
uniform sampler2DArray u_ends;
// (larger, smaller) absolute component of a unit direction: the shape of a pixel seen along it
vec2 kern(vec2 u) { vec2 a = abs(u); return vec2(max(a.x, a.y), max(min(a.x, a.y), 1e-4)); }
// share of the pixel on the near side of an edge at signed distance x (positive: centre inside)
float edge(float x, vec2 k) {
  float ax = abs(x), top = 0.5 * (k.x - k.y), base = 0.5 * (k.x + k.y);
  float g = ax <= top ? ax / k.x : (ax < base ? 0.5 - (base - ax) * (base - ax) / (2.0 * k.x * k.y) : 0.5);
  return x < 0.0 ? 0.5 - g : 0.5 + g;
}
// share of the pixel inside two half-planes at once, given the cosine between their normals
float both(float a, float b, float c) {
  float p = a * b;
  return c >= 0.0 ? mix(p, min(a, b), c) : mix(p, max(0.0, a + b - 1.0), -c);
}
float disc(vec2 off, float h, float layer) {
  vec2 a = abs(off);
  float dist = length(a), mx = max(a.x, a.y);
  float fold = mx > 1e-5 ? min(a.x, a.y) / mx : 0.0;
  float uu = clamp((dist - h + 1.0) * 0.5, 0.0, 1.0);
  return textureLod(u_disc, vec3((uu * ${f(LUT_W - 1)} + 0.5) / ${f(LUT_W)}, (fold * ${f(LUT_H - 1)} + 0.5) / ${f(LUT_H)}, layer), 0.0).r;
}
float roundEnd(float along, float across, float h, float layer) {
  float uu = clamp((along + 0.5) / (h + 1.0), 0.0, 1.0), vv = clamp(abs(across) / (h + 0.5), 0.0, 1.0);
  return textureLod(u_ends, vec3((uu * ${f(END_N - 1)} + 0.5) / ${f(END_N)}, (vv * ${f(END_N - 1)} + 0.5) / ${f(END_N)}, layer), 0.0).r;
}
`;

/**
 * One record per segment, drawn as a quad around it. The vertex stage places the segment on
 * screen, keeps only the stretch near the window, and hands the fragment stage everything as
 * per-segment constants; the fragment stage computes coverage from the pixel's position.
 */
export const MARKS_VS = COMMON + /* glsl */ `
layout(location = 0) in vec4 a_seg;   // the segment's two points, layer units
layout(location = 1) in vec4 a_adj;   // the point before and the point after
layout(location = 2) in float a_s0;   // arc length at the first point (or a disc's radius)
layout(location = 3) in vec4 a_meta;  // width index, flags
uniform vec3 u_xf;                    // pixels per unit, then the offset in pixels
uniform vec2 u_view;
uniform float u_half[8];
uniform vec3 u_dash;                  // on, off
flat out vec4 v_ab;
flat out vec4 v_un;
flat out vec4 v_nb;
flat out vec4 v_misc;
const float GUARD = 24.0;
vec2 px(vec2 q) { return q * u_xf.x + u_xf.yz; }
vec2 dir(vec2 a, vec2 b) { vec2 d = b - a; float l = dot(d, d); return l > 0.0 ? d * inversesqrt(l) : vec2(0.0); }
void main() {
  int flags = int(a_meta.y);
  bool isDisc = (flags & 4) != 0;
  float h = isDisc ? a_s0 * u_xf.x : u_half[int(a_meta.x)];
  vec2 A = px(a_seg.xy), B = px(a_seg.zw);
  vec2 u = dir(A, B);
  float full = length(B - A);
  // 1: meets a neighbour, 2: a round end
  int ea = (flags & 1) != 0 ? 2 : 1, eb = (flags & 2) != 0 ? 2 : 1;
  vec2 pu = vec2(0.0), nu = vec2(0.0);
  if (ea == 1) { pu = dir(px(a_adj.xy), A); vec2 m = pu + u; if (dot(m, m) < 1e-6) ea = 2; }
  if (eb == 1) { nu = dir(B, px(a_adj.zw)); vec2 m = u + nu; if (dot(m, m) < 1e-6) eb = 2; }
  if (full == 0.0) u = vec2(1.0, 0.0);
  float e = h + 1.0, g = GUARD + e;
  vec2 lo = vec2(-g) - A, hi = u_view + g - A;
  float ta = 0.0, tb = full;
  bool seen;
  if (full > 0.0) {
    // where the segment enters and leaves a band around the window, per axis
    vec2 t1 = lo / u, t2 = hi / u;
    vec2 tmin = min(t1, t2), tmax = max(t1, t2);
    if (abs(u.x) < 1e-9) { tmin.x = (lo.x <= 0.0 && hi.x >= 0.0) ? -1e30 : 1e30; tmax.x = 1e30; }
    if (abs(u.y) < 1e-9) { tmin.y = (lo.y <= 0.0 && hi.y >= 0.0) ? -1e30 : 1e30; tmax.y = 1e30; }
    ta = max(0.0, max(tmin.x, tmin.y));
    tb = min(full, min(tmax.x, tmax.y));
    seen = ta <= tb;
  } else {
    seen = lo.x <= 0.0 && lo.y <= 0.0 && hi.x >= 0.0 && hi.y >= 0.0;
  }
  if (isDisc) { seen = true; ta = 0.0; tb = 0.0; }
  // an end cut off beyond the window is no end at all: 0
  if (ta > 0.0) ea = 0;
  if (tb < full) eb = 0;
  vec2 A2 = ta > 0.0 ? A + u * ta : A, B2 = tb < full ? A + u * tb : B;
  float per = u_dash.x + u_dash.y;
  v_ab = vec4(A2, B2);
  v_un = vec4(u, tb - ta, h);
  v_nb = vec4(pu, nu);
  v_misc = vec4(per > 0.0 ? mod(a_s0 * u_xf.x + ta, per) : 0.0, float(ea + 4 * eb), a_meta.x, isDisc ? 1.0 : 0.0);
  vec2 c = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float(gl_VertexID >> 1) * 2.0 - 1.0);
  vec2 pos = (c.x < 0.0 ? A2 - u * e : B2 + u * e) + vec2(-u.y, u.x) * (c.y * e);
  gl_Position = seen ? vec4(pos.x / u_view.x * 2.0 - 1.0, 1.0 - pos.y / u_view.y * 2.0, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
}
`;

export const MARKS_FS = COMMON + COVERAGE + /* glsl */ `
flat in vec4 v_ab;
flat in vec4 v_un;
flat in vec4 v_nb;
flat in vec4 v_misc;
uniform vec2 u_view;
uniform vec4 u_color;
uniform vec3 u_dash;
uniform int u_mode;    // 0: paint, 1: gather coverage in alpha, 2: lay the gathered shape down
out vec4 o;
// what two strips meeting at a corner cover between them, with the round join (coverage.ts: corner2)
float corner(vec2 x, vec2 u1, vec2 u2, float h, float layer) {
  float sn = u1.x * u2.y - u1.y * u2.x, cs = dot(u1, u2);
  float side = sn >= 0.0 ? 1.0 : -1.0;
  float d1 = side * (x.y * u1.x - x.x * u1.y), d2 = side * (x.y * u2.x - x.x * u2.y);
  vec2 k1 = kern(u1), k2 = kern(u2);
  float outer = both(edge(d1 + h, k1), edge(d2 + h, k2), cs);
  float inner = both(edge(d1 - h, k1), edge(d2 - h, k2), cs);
  float gap = both(edge(dot(x, u1), k1), 1.0 - edge(dot(x, u2), k2), -cs);
  return max(0.0, (1.0 - gap) * outer + gap * disc(x, h, layer) - inner);
}
void main() {
  if (u_mode == 2) { o = vec4(u_color.rgb, 1.0); return; }
  vec2 p = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  vec2 u = v_un.xy;
  float L = v_un.z, h = v_un.w, layer = v_misc.z;
  int ends = int(v_misc.y), ea = ends & 3, eb = ends >> 2;
  vec2 pa = p - v_ab.xy, pb = p - v_ab.zw;
  bool dashed = u_dash.x > 0.0;
  float cov;
  if (v_misc.w > 0.5) {
    // a filled disc that scales with the drawing
    float dist = length(pa);
    vec2 k = kern(dist > 1e-5 ? pa / dist : vec2(1.0, 0.0));
    cov = (edge(h - dist, k) - edge(-h - dist, k)) * min(1.0, 1.5708 * h);
  } else if (L == 0.0 && ends == 10 && !dashed) {
    cov = disc(pa, h, layer);
  } else {
    float own = 1.0, sinA = 0.0, sinB = 0.0;
    // each pixel belongs to the segment on its side of the line that bisects the corner
    if (ea == 1) { if (dot(pa, v_nb.xy + u) < 0.0) own = 0.0; sinA = abs(v_nb.x * u.y - v_nb.y * u.x); }
    if (eb == 1) { if (dot(pb, u + v_nb.zw) >= 0.0) own = 0.0; sinB = abs(u.x * v_nb.w - u.y * v_nb.z); }
    float t = dot(pa, u), d = dot(pa, vec2(-u.y, u.x));
    vec2 k = kern(u);
    float S = edge(d + h, k) - edge(d - h, k);
    float t0 = 0.0, t1 = L;
    bool ra = ea == 2, rb = eb == 2;
    if (dashed) {
      float per = u_dash.x + u_dash.y, tc = clamp(t, 0.0, L);
      float ph = mod(v_misc.x + tc, per);
      if (ph > u_dash.x + 0.5 * u_dash.y) ph -= per;
      t0 = tc - ph; t1 = t0 + u_dash.x;
      // a dash that runs past a joint carries on in the neighbour; past a real end it is cut there
      if (t0 < 0.0) { if (ea == 2) t0 = 0.0; else ra = false; } else ra = true;
      if (t1 > L) { if (eb == 2) t1 = L; else rb = false; } else rb = true;
      if (t1 < t0) own = 0.0;
    }
    cov = S;
    // a corner only reaches as far along the stroke as the neighbour's strip stays within a pixel of this one
    float near = 2.0 * h + 1.5;
    if (ra) cov += roundEnd(t0 - t, d, h, layer) - S * (1.0 - edge(t - t0, k));
    else if (!dashed && sinA > ${SHARP} && t * sinA < near) cov += corner(pa, v_nb.xy, u, h, layer) - S;
    if (rb) cov += roundEnd(t - t1, d, h, layer) - S * edge(t - t1, k);
    else if (!dashed && sinB > ${SHARP} && (L - t) * sinB < near) cov += corner(pb, u, v_nb.zw, h, layer) - S;
    cov = clamp(cov, 0.0, 1.0) * own;
  }
  o = u_mode == 1 ? vec4(0.0, 0.0, 0.0, cov) : u_color * cov;
}
`;

/** The inside of a filled shape: plain triangles, hard-edged; the shape's own stroke covers the edge. */
export const FILL_VS = COMMON + /* glsl */ `
layout(location = 0) in vec2 a_pos;
uniform vec3 u_xf;
uniform vec2 u_view;
void main() {
  vec2 pos = a_pos * u_xf.x + u_xf.yz;
  gl_Position = vec4(pos.x / u_view.x * 2.0 - 1.0, 1.0 - pos.y / u_view.y * 2.0, 0.0, 1.0);
}
`;
export const FILL_FS = COMMON + /* glsl */ `
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }
`;

/** A rectangle given in pixels, for the two programs that work per pixel over an area. */
export const RECT_VS = COMMON + /* glsl */ `
uniform vec4 u_rect;
uniform vec2 u_view;
void main() {
  vec2 pos = vec2((gl_VertexID & 1) != 0 ? u_rect.z : u_rect.x, (gl_VertexID >> 1) != 0 ? u_rect.w : u_rect.y);
  gl_Position = vec4(pos.x / u_view.x * 2.0 - 1.0, 1.0 - pos.y / u_view.y * 2.0, 0.0, 1.0);
}
`;

/**
 * A true circle of any size: the Earth and the edge of the atmosphere, which grow far larger
 * than the window. Distance is measured from the point of the circle nearest the window, not
 * from its centre, so that nothing cancels in 32-bit arithmetic.
 */
export const CIRCLE_FS = COMMON + COVERAGE + /* glsl */ `
uniform vec2 u_view;
uniform vec4 u_near;     // the nearest point of the circle, and the outward direction there
uniform vec4 u_shape;    // radius, half stroke width, width index, 1 if filled white
uniform vec4 u_color;    // ink
uniform vec4 u_paper;    // white
uniform vec4 u_dash;     // on, off, arc length at the nearest point, opacity
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  vec2 q = p - u_near.xy, n = u_near.zw, tn = vec2(-n.y, n.x);
  float R = u_shape.x, h = u_shape.y, layer = u_shape.z;
  float qn = dot(q, n), qt = dot(q, tn);
  float far = sqrt(max(0.0, R * R + 2.0 * R * qn + dot(q, q)));
  // signed distance to the circle, outside positive
  float d = (2.0 * R * qn + dot(q, q)) / (far + R);
  vec2 g = far > 1e-5 ? (R * n + q) / far : n;
  vec2 k = kern(g);
  float S = edge(d + h, k) - edge(d - h, k);
  if (u_dash.x > 0.0) {
    // arc length along the circle, in the direction the browser walks it
    float per = u_dash.x + u_dash.y;
    float ph = mod(u_dash.z + R * atan(qt, R + qn), per);
    if (ph > u_dash.x + 0.5 * u_dash.y) ph -= per;
    S = S * (edge(ph, k) - edge(ph - u_dash.x, k)) + roundEnd(-ph, d, h, layer) + roundEnd(ph - u_dash.x, d, h, layer);
  }
  float inside = u_shape.w > 0.5 ? edge(-d, k) : 0.0;
  float a = S + (1.0 - S) * inside;
  o = (u_color * S + u_paper * (a - S)) * u_dash.w;
}
`;

/** A faded layer, drawn on its own beforehand, laid over the picture: red holds ink, green holds cover. */
export const OVER_FS = COMMON + /* glsl */ `
uniform sampler2D u_layer;
uniform vec4 u_color;
uniform vec4 u_paper;
uniform float u_opacity;
out vec4 o;
void main() {
  vec4 t = texelFetch(u_layer, ivec2(gl_FragCoord.xy), 0);
  o = (u_color * t.r + u_paper * (t.g - t.r)) * u_opacity;
}
`;
