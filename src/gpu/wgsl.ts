// The shaders of the WebGPU backend: the same programs as src/gpu/glsl.ts, in WGSL.
// src/gpu/coverage.ts holds the arithmetic in plain code, with its tests.
//
// Positions are device pixels with the origin at the top left, like the SVG (and like
// WebGPU's own fragment coordinates, so nothing is flipped here).
import { END_N, LUT_H, LUT_W, SHARP } from './coverage';

const f = (n: number) => n.toFixed(1);

/** One block of values per draw. Its size in bytes, and where each backend-side field goes (in floats). */
export const UNIFORM_FLOATS = 40;

export const WGSL = /* wgsl */ `
struct U {
  view: vec4f,    // width, height
  xf: vec4f,      // pixels per unit, then the offset in pixels
  color: vec4f,   // ink
  paper: vec4f,   // white
  dash: vec4f,    // on, off; for a circle: arc length at its nearest point, opacity
  rect: vec4f,    // a rectangle in pixels
  near: vec4f,    // a circle's nearest point, and the outward direction there
  shape: vec4f,   // a circle's radius, half stroke width, width index, 1 if filled; or a layer's opacity
  half: array<vec4f, 2>,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var discs: texture_2d_array<f32>;
@group(0) @binding(2) var rounds: texture_2d_array<f32>;
@group(0) @binding(3) var smooth_: sampler;
@group(1) @binding(0) var faded: texture_2d<f32>;

// (larger, smaller) absolute component of a unit direction: the shape of a pixel seen along it
fn kern(d: vec2f) -> vec2f { let a = abs(d); return vec2f(max(a.x, a.y), max(min(a.x, a.y), 1e-4)); }
// share of the pixel on the near side of an edge at signed distance x (positive: centre inside)
fn edge(x: f32, k: vec2f) -> f32 {
  let ax = abs(x);
  let top = 0.5 * (k.x - k.y);
  let base = 0.5 * (k.x + k.y);
  var g = 0.5;
  if (ax <= top) { g = ax / k.x; } else if (ax < base) { g = 0.5 - (base - ax) * (base - ax) / (2.0 * k.x * k.y); }
  if (x < 0.0) { return 0.5 - g; }
  return 0.5 + g;
}
// share of the pixel inside two half-planes at once, given the cosine between their normals
fn both(a: f32, b: f32, c: f32) -> f32 {
  let p = a * b;
  if (c >= 0.0) { return mix(p, min(a, b), c); }
  return mix(p, max(0.0, a + b - 1.0), -c);
}
fn disc(off: vec2f, h: f32, layer: i32) -> f32 {
  let a = abs(off);
  let dist = length(a);
  let mx = max(a.x, a.y);
  var fold = 0.0;
  if (mx > 1e-5) { fold = min(a.x, a.y) / mx; }
  let uu = clamp((dist - h + 1.0) * 0.5, 0.0, 1.0);
  return textureSampleLevel(discs, smooth_, vec2f((uu * ${f(LUT_W - 1)} + 0.5) / ${f(LUT_W)}, (fold * ${f(LUT_H - 1)} + 0.5) / ${f(LUT_H)}), layer, 0.0).r;
}
fn roundEnd(along: f32, across: f32, h: f32, layer: i32) -> f32 {
  let uu = clamp((along + 0.5) / (h + 1.0), 0.0, 1.0);
  let vv = clamp(abs(across) / (h + 0.5), 0.0, 1.0);
  return textureSampleLevel(rounds, smooth_, vec2f((uu * ${f(END_N - 1)} + 0.5) / ${f(END_N)}, (vv * ${f(END_N - 1)} + 0.5) / ${f(END_N)}), layer, 0.0).r;
}
fn wrap(x: f32, per: f32) -> f32 { return x - per * floor(x / per); }
fn clip(pos: vec2f) -> vec4f { return vec4f(pos.x / u.view.x * 2.0 - 1.0, 1.0 - pos.y / u.view.y * 2.0, 0.0, 1.0); }

// ---- marks: one record per segment, drawn as a quad around it

struct Mark {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) ab: vec4f,
  @location(1) @interpolate(flat) un: vec4f,
  @location(2) @interpolate(flat) nb: vec4f,
  @location(3) @interpolate(flat) misc: vec4f,
}
const GUARD = 24.0;
fn px(q: vec2f) -> vec2f { return q * u.xf.x + u.xf.yz; }
fn dir(a: vec2f, b: vec2f) -> vec2f {
  let d = b - a;
  let l = dot(d, d);
  if (l > 0.0) { return d * inverseSqrt(l); }
  return vec2f(0.0);
}
@vertex fn vs_marks(@builtin(vertex_index) vi: u32, @location(0) seg: vec4f, @location(1) adj: vec4f, @location(2) s0: f32, @location(3) tag: vec4u) -> Mark {
  let flags = tag.y;
  let isDisc = (flags & 4u) != 0u;
  var h = u.half[tag.x / 4u][tag.x % 4u];
  if (isDisc) { h = s0 * u.xf.x; }
  let A = px(seg.xy);
  let B = px(seg.zw);
  var w = dir(A, B);
  let full = length(B - A);
  // 1: meets a neighbour, 2: a round end
  var ea = 1;
  var eb = 1;
  if ((flags & 1u) != 0u) { ea = 2; }
  if ((flags & 2u) != 0u) { eb = 2; }
  var pu = vec2f(0.0);
  var nu = vec2f(0.0);
  if (ea == 1) { pu = dir(px(adj.xy), A); let m = pu + w; if (dot(m, m) < 1e-6) { ea = 2; } }
  if (eb == 1) { nu = dir(B, px(adj.zw)); let m = w + nu; if (dot(m, m) < 1e-6) { eb = 2; } }
  if (full == 0.0) { w = vec2f(1.0, 0.0); }
  let e = h + 1.0;
  let g = GUARD + e;
  let lo = vec2f(-g) - A;
  let hi = u.view.xy + g - A;
  var ta = 0.0;
  var tb = full;
  var seen = false;
  if (full > 0.0) {
    // where the segment enters and leaves a band around the window, per axis
    let t1 = lo / w;
    let t2 = hi / w;
    var tmin = min(t1, t2);
    var tmax = max(t1, t2);
    if (abs(w.x) < 1e-9) { tmin.x = 1e30; if (lo.x <= 0.0 && hi.x >= 0.0) { tmin.x = -1e30; } tmax.x = 1e30; }
    if (abs(w.y) < 1e-9) { tmin.y = 1e30; if (lo.y <= 0.0 && hi.y >= 0.0) { tmin.y = -1e30; } tmax.y = 1e30; }
    ta = max(0.0, max(tmin.x, tmin.y));
    tb = min(full, min(tmax.x, tmax.y));
    seen = ta <= tb;
  } else {
    seen = lo.x <= 0.0 && lo.y <= 0.0 && hi.x >= 0.0 && hi.y >= 0.0;
  }
  if (isDisc) { seen = true; ta = 0.0; tb = 0.0; }
  // an end cut off beyond the window is no end at all: 0
  if (ta > 0.0) { ea = 0; }
  if (tb < full) { eb = 0; }
  var A2 = A;
  var B2 = B;
  if (ta > 0.0) { A2 = A + w * ta; }
  if (tb < full) { B2 = A + w * tb; }
  let per = u.dash.x + u.dash.y;
  var out: Mark;
  out.ab = vec4f(A2, B2);
  out.un = vec4f(w, tb - ta, h);
  out.nb = vec4f(pu, nu);
  var phase = 0.0;
  if (per > 0.0) { phase = wrap(s0 * u.xf.x + ta, per); }
  out.misc = vec4f(phase, f32(ea + 4 * eb), f32(tag.x), f32(isDisc));
  let c = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  var pos = B2 + w * e;
  if (c.x < 0.0) { pos = A2 - w * e; }
  pos += vec2f(-w.y, w.x) * (c.y * e);
  out.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  if (seen) { out.pos = clip(pos); }
  return out;
}

// what two strips meeting at a corner cover between them, with the round join (coverage.ts: corner2)
fn corner(x: vec2f, u1: vec2f, u2: vec2f, h: f32, layer: i32) -> f32 {
  let sn = u1.x * u2.y - u1.y * u2.x;
  let cs = dot(u1, u2);
  var side = 1.0;
  if (sn < 0.0) { side = -1.0; }
  let d1 = side * (x.y * u1.x - x.x * u1.y);
  let d2 = side * (x.y * u2.x - x.x * u2.y);
  let k1 = kern(u1);
  let k2 = kern(u2);
  let outer = both(edge(d1 + h, k1), edge(d2 + h, k2), cs);
  let inner = both(edge(d1 - h, k1), edge(d2 - h, k2), cs);
  let gap = both(edge(dot(x, u1), k1), 1.0 - edge(dot(x, u2), k2), -cs);
  return max(0.0, (1.0 - gap) * outer + gap * disc(x, h, layer) - inner);
}
fn cover(v: Mark) -> f32 {
  let p = v.pos.xy;
  let w = v.un.xy;
  let L = v.un.z;
  let h = v.un.w;
  let layer = i32(v.misc.z);
  let ends = i32(v.misc.y);
  let ea = ends & 3;
  let eb = ends >> 2u;
  let pa = p - v.ab.xy;
  let pb = p - v.ab.zw;
  let dashed = u.dash.x > 0.0;
  if (v.misc.w > 0.5) {
    // a filled disc that scales with the drawing
    let dist = length(pa);
    var along = vec2f(1.0, 0.0);
    if (dist > 1e-5) { along = pa / dist; }
    let k = kern(along);
    return (edge(h - dist, k) - edge(-h - dist, k)) * min(1.0, 1.5708 * h);
  }
  if (L == 0.0 && ends == 10 && !dashed) { return disc(pa, h, layer); }
  var own = 1.0;
  var sinA = 0.0;
  var sinB = 0.0;
  // each pixel belongs to the segment on its side of the line that bisects the corner
  if (ea == 1) { if (dot(pa, v.nb.xy + w) < 0.0) { own = 0.0; } sinA = abs(v.nb.x * w.y - v.nb.y * w.x); }
  if (eb == 1) { if (dot(pb, w + v.nb.zw) >= 0.0) { own = 0.0; } sinB = abs(w.x * v.nb.w - w.y * v.nb.z); }
  let t = dot(pa, w);
  let d = dot(pa, vec2f(-w.y, w.x));
  let k = kern(w);
  let S = edge(d + h, k) - edge(d - h, k);
  var t0 = 0.0;
  var t1 = L;
  var ra = ea == 2;
  var rb = eb == 2;
  if (dashed) {
    let per = u.dash.x + u.dash.y;
    let tc = clamp(t, 0.0, L);
    var ph = wrap(v.misc.x + tc, per);
    if (ph > u.dash.x + 0.5 * u.dash.y) { ph -= per; }
    t0 = tc - ph;
    t1 = t0 + u.dash.x;
    // a dash that runs past a joint carries on in the neighbour; past a real end it is cut there
    if (t0 < 0.0) { if (ea == 2) { t0 = 0.0; } else { ra = false; } } else { ra = true; }
    if (t1 > L) { if (eb == 2) { t1 = L; } else { rb = false; } } else { rb = true; }
    if (t1 < t0) { own = 0.0; }
  }
  var cov = S;
  // a corner only reaches as far along the stroke as the neighbour's strip stays within a pixel of this one
  let near = 2.0 * h + 1.5;
  if (ra) { cov += roundEnd(t0 - t, d, h, layer) - S * (1.0 - edge(t - t0, k)); }
  else if (!dashed && sinA > ${SHARP} && t * sinA < near) { cov += corner(pa, v.nb.xy, w, h, layer) - S; }
  if (rb) { cov += roundEnd(t - t1, d, h, layer) - S * edge(t - t1, k); }
  else if (!dashed && sinB > ${SHARP} && (L - t) * sinB < near) { cov += corner(pb, w, v.nb.zw, h, layer) - S; }
  return clamp(cov, 0.0, 1.0) * own;
}
// paint; gather coverage in alpha; lay the gathered shape down
@fragment fn fs_paint(v: Mark) -> @location(0) vec4f { return u.color * cover(v); }
@fragment fn fs_gather(v: Mark) -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, cover(v)); }
@fragment fn fs_lay(v: Mark) -> @location(0) vec4f { return vec4f(u.color.rgb, 1.0); }

// ---- the inside of a filled shape: plain triangles; the shape's own stroke covers the edge

@vertex fn vs_fill(@location(0) at: vec2f) -> @builtin(position) vec4f { return clip(at * u.xf.x + u.xf.yz); }
@fragment fn fs_fill() -> @location(0) vec4f { return u.paper; }

// ---- a rectangle given in pixels, for the two programs that work per pixel over an area

@vertex fn vs_rect(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = u.rect.xy;
  if ((vi & 1u) != 0u) { pos.x = u.rect.z; }
  if ((vi >> 1u) != 0u) { pos.y = u.rect.w; }
  return clip(pos);
}

// A true circle of any size. Distance is measured from the point of the circle nearest the
// window, not from its centre, so that nothing cancels in 32-bit arithmetic.
@fragment fn fs_circle(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let q = at.xy - u.near.xy;
  let n = u.near.zw;
  let tn = vec2f(-n.y, n.x);
  let R = u.shape.x;
  let h = u.shape.y;
  let layer = i32(u.shape.z);
  let qn = dot(q, n);
  let qt = dot(q, tn);
  let far = sqrt(max(0.0, R * R + 2.0 * R * qn + dot(q, q)));
  // signed distance to the circle, outside positive
  let d = (2.0 * R * qn + dot(q, q)) / (far + R);
  var g = n;
  if (far > 1e-5) { g = (R * n + q) / far; }
  let k = kern(g);
  var S = edge(d + h, k) - edge(d - h, k);
  if (u.dash.x > 0.0) {
    // arc length along the circle, in the direction the browser walks it
    let per = u.dash.x + u.dash.y;
    var ph = wrap(u.dash.z + R * atan2(qt, R + qn), per);
    if (ph > u.dash.x + 0.5 * u.dash.y) { ph -= per; }
    S = S * (edge(ph, k) - edge(ph - u.dash.x, k)) + roundEnd(-ph, d, h, layer) + roundEnd(ph - u.dash.x, d, h, layer);
  }
  var inside = 0.0;
  if (u.shape.w > 0.5) { inside = edge(-d, k); }
  let a = S + (1.0 - S) * inside;
  return (u.color * S + u.paper * (a - S)) * u.dash.w;
}

// A faded layer, drawn on its own beforehand, laid over the picture: red holds ink, green holds cover.
@fragment fn fs_over(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let t = textureLoad(faded, vec2i(at.xy), 0);
  return (u.color * t.r + u.paper * (t.g - t.r)) * u.shape.x;
}
`;
