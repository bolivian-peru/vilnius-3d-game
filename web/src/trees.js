// Real 3D trees in place of the survey mesh's tree blobs. The photomesh drapes every canopy as a
// melted curtain down to the ground; the pipeline finds each tree in it (trees.json: position, height,
// crown, colour) and the canopy footprint with the ground under it (veg.png). Here the curtains are cut
// out of the survey shader (vegUniforms in i3s.js), a floor fills the ground the canopy hid, and
// procedural ez-tree trees (MIT, github.com/dgreenheck/ez-tree) stand in their place:
//   full branches and leaf cards up close, a lighter card set mid-range, and hemi-octahedral impostors
//   (albedo + normal atlas baked here once, relit per pixel) out to the edge of the loaded window.
// LODs cross-fade with a screen-door dither driven by the same distance in every shader.

import * as THREE from 'three';
import { Tree, TreePreset } from 'ez-tree';
import oakBark from 'ez-tree/assets/bark/oak_color_1k.jpg';
import birchBark from 'ez-tree/assets/bark/birch_color_1k.jpg';
import pineBark from 'ez-tree/assets/bark/pine_color_1k.jpg';
import oakLeaf from 'ez-tree/assets/leaves/oak_color.png';
import ashLeaf from 'ez-tree/assets/leaves/ash_color.png';
import aspenLeaf from 'ez-tree/assets/leaves/aspen_color.png';
import pineLeaf from 'ez-tree/assets/leaves/pine_color.png';
import { vegUniforms } from './i3s.js';
import { TILE_SIZE, tileName } from './geo.js';

const NEAR = 70, MID = 170, FAR = 1300, FADE = 12; // LOD bands, m from the camera
const WINDOW = 5;                                   // tiles per side kept around the focus
const G = 8, FRAME = 128;                           // impostor frames per side, px per frame
const CHUNK = 250;                                  // impostor draw/cull unit, m
const CUT = 1.0;                                    // survey canopy is cut this far above the ground
const FLOOR = 4;                                    // floor grid under removed canopy, m
const TRUNK_CELL = 8;

// Vilnius street and park trees: linden, Norway maple, horse chestnut, birch, oak; Scots pine and
// spruce on the Antakalnis hills. `leaf` is the default crown albedo (sRGB) mixed with the detected one.
const VARIANTS = [
  { name: 'linden', type: 0, preset: 'Oak Large', bark: 'oak', leaves: 'aspen', leaf: '#5d7a3c', set: { seed: 4011, leaves: { count: 12, size: 4.2, angle: 40 }, branch: { angle: { 1: 48 } } } },
  { name: 'maple', type: 0, preset: 'Ash Large', bark: 'oak', leaves: 'ash', leaf: '#587538', set: { seed: 917, leaves: { count: 12, size: 5.2 } } },
  { name: 'chestnut', type: 0, preset: 'Oak Medium', bark: 'oak', leaves: 'oak', leaf: '#4f6b33', set: { seed: 3312, leaves: { count: 16, size: 3.2 } } },
  { name: 'oak', type: 0, preset: 'Oak Large', bark: 'oak', leaves: 'oak', leaf: '#53703a', set: { seed: 23399 } },
  { name: 'birch', type: 0, preset: 'Aspen Large', bark: 'birch', leaves: 'aspen', leaf: '#6c8a40', set: { seed: 30631 } },
  { name: 'young', type: 0, preset: 'Ash Medium', bark: 'oak', leaves: 'ash', leaf: '#5f7d3d', set: { seed: 777 } },
  { name: 'pine', type: 1, preset: 'Pine Large', bark: 'pine', leaves: 'pine', leaf: '#3f5a2e',
    set: { seed: 515, branch: { children: { 0: 60 }, start: { 1: 0.55 }, angle: { 1: 100 }, length: { 1: 22 } }, leaves: { count: 14, size: 3.6 } } },
  { name: 'spruce', type: 1, preset: 'Pine Large', bark: 'pine', leaves: 'pine', leaf: '#344d2a', set: { seed: 44166 } },
];
const BARK_URL = { oak: oakBark, birch: birchBark, pine: pineBark };
const LEAF_URL = { oak: oakLeaf, ash: ashLeaf, aspen: aspenLeaf, pine: pineLeaf };

const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const merge = (a, b) => { for (const k in b) (b[k] && typeof b[k] === 'object' ? merge(a[k], b[k]) : (a[k] = b[k])); return a; };

// --- shaders -----------------------------------------------------------------------
const LIGHT = /* glsl */ `
uniform vec3 sunDir, sunColor, skyColor, groundColor;
vec3 treeLight(vec3 albedo, vec3 n, float leaf, vec3 sun) {
  float ndl = dot(n, sun);
  float diff = mix(max(ndl, 0.0), clamp(ndl * 0.6 + 0.4, 0.0, 1.0), leaf);
  return albedo * (mix(groundColor, skyColor, n.y * 0.5 + 0.5) + sunColor * diff);
}
float lodDither(vec2 fade) {
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return n >= fade.x || n < fade.y ? 0.0 : 1.0;
}
vec2 lodFade(vec4 band, float d) { return clamp((vec2(d) - band.xz) / (band.yw - band.xz), 0.0, 1.0); }`;

const MESH_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float ao;
uniform float time;
uniform vec2 wind;
uniform vec4 lodBand;
varying vec2 vUv;
varying vec3 vNormal, vTint;
varying float vAo;
varying vec2 vFade;
vec2 lodFade(vec4 band, float d) { return clamp((vec2(d) - band.xz) / (band.yw - band.xz), 0.0, 1.0); }
void main() {
  mat4 im = mat4(1.0);
#ifdef USE_INSTANCING
  im = instanceMatrix;
#endif
  vec3 s2 = vec3(dot(im[0].xyz, im[0].xyz), dot(im[1].xyz, im[1].xyz), dot(im[2].xyz, im[2].xyz));
  vTint = vec3(1.0);
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#endif
  vUv = uv;
  vAo = ao;
#ifdef BAKE
  vNormal = normal;
  vFade = vec2(1.0, 0.0);
  vec4 mvPosition = viewMatrix * modelMatrix * im * vec4(position, 1.0);
#else
  vec3 base = (modelMatrix * im[3]).xyz;
  vec4 wp = modelMatrix * im * vec4(position, 1.0);
  float ph = dot(base.xz, vec2(0.37, 0.23)), h2 = position.y * position.y;
  wp.xz += wind * (sin(time * 0.9 + ph) + 0.4 * sin(time * 2.3 + ph * 1.3)) * h2 * sqrt(s2.y) * 0.008;
#ifdef LEAF
  wp.xyz += vec3(0.5, 1.0, 0.5) * sin(time * 4.0 + dot(position, vec3(311.0, 173.0, 231.0))) * 0.04 * position.y;
#endif
  vNormal = normalize(mat3(modelMatrix) * (mat3(im) * (normal / s2)));
  vFade = lodFade(lodBand, distance(base, cameraPosition));
  vec4 mvPosition = viewMatrix * wp;
#endif
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const MESH_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${LIGHT}
uniform sampler2D map;
uniform vec2 repeat;
uniform vec3 albedoScale;
uniform float bakeMode;
varying vec2 vUv;
varying vec3 vNormal, vTint;
varying float vAo;
varying vec2 vFade;
void main() {
  if (lodDither(vFade) < 0.5) discard;
  vec4 tex = texture2D(map, vUv * repeat);
#ifdef LEAF
  const float leaf = 1.0;
#ifdef BAKE
  if (tex.a < 0.5) discard;
  float alpha = 1.0;
#else
  float alpha = clamp((tex.a - 0.5) / max(fwidth(tex.a), 1e-3) + 0.5, 0.0, 1.0);
#ifndef A2C
  alpha = step(0.5, tex.a);
#endif
  if (alpha < 0.02) discard;
#endif
#else
  const float leaf = 0.0;
  float alpha = 1.0;
#endif
  vec3 albedo = tex.rgb * albedoScale * vAo;
#ifdef BAKE
  gl_FragColor = bakeMode < 0.5 ? vec4(albedo * 0.5, 1.0) : vec4(normalize(vNormal) * 0.5 + 0.5, leaf);
#else
  gl_FragColor = vec4(treeLight(albedo * vTint, normalize(vNormal), leaf, sunDir), alpha);
  #include <fog_fragment>
  #include <colorspace_fragment>
#endif
}`;

const IMP_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec2 corner;
attribute vec4 iPos, iData;
attribute vec3 iTint;
uniform vec4 impInfo[${VARIANTS.length}];
uniform vec4 lodBand;
uniform vec3 sunDir;
varying vec2 vUv, vFade;
varying vec3 vTint, vSun;
vec2 lodFade(vec4 band, float d) { return clamp((vec2(d) - band.xz) / (band.yw - band.xz), 0.0, 1.0); }
void main() {
  vec4 info = impInfo[int(iData.z + 0.5)];
  vec3 scale = vec3(iData.x * iData.y, iData.x, iData.x * iData.y);
  vec3 centre = iPos.xyz + vec3(0.0, info.x * iData.x, 0.0);
  vec3 toCam = cameraPosition - centre;
  vFade = lodFade(lodBand, length(cameraPosition - iPos.xyz));
  if (vFade.x <= 0.0 || vFade.y >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float c = cos(iPos.w), s = sin(iPos.w);
  vec3 v = normalize(vec3(c * toCam.x - s * toCam.z, toCam.y, s * toCam.x + c * toCam.z) / scale);
  v.y = max(v.y, 0.0);
  vec3 a = v / (abs(v.x) + abs(v.y) + abs(v.z));
  vec2 cell = clamp(floor((vec2(a.x + a.z, a.z - a.x) * 0.5 + 0.5) * ${G}.0), 0.0, ${G - 1}.0);
  vec2 o = (cell + 0.5) / ${G}.0 * 2.0 - 1.0;
  vec3 f = vec3((o.x - o.y) * 0.5, 0.0, (o.x + o.y) * 0.5);
  f.y = 1.0 - abs(f.x) - abs(f.z);
  f = normalize(f);
  vec3 right = normalize(vec3(f.z, 0.0, -f.x)), up = cross(f, right);
  vec3 p = (vec3(0.0, info.x, 0.0) + (corner.x * right + corner.y * up) * info.y) * scale;
  vec3 wp = iPos.xyz + vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vUv = vec2((cell.x + corner.x * 0.5 + 0.5) / ${G}.0, (iData.z * ${G}.0 + cell.y + corner.y * 0.5 + 0.5) / ${G * VARIANTS.length}.0);
  vTint = iTint;
  vSun = vec3(c * sunDir.x - s * sunDir.z, sunDir.y, s * sunDir.x + c * sunDir.z);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const IMP_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${LIGHT}
uniform sampler2D albedoMap, normalMap;
varying vec2 vUv, vFade;
varying vec3 vTint, vSun;
void main() {
  if (lodDither(vFade) < 0.5) discard;
  vec4 al = texture2D(albedoMap, vUv);
  if (al.a < 0.1) discard;
  vec4 nm = texture2D(normalMap, vUv);
  float leaf = clamp(nm.a / al.a, 0.0, 1.0);
  vec3 n = normalize(nm.rgb / al.a * 2.0 - 1.0);
  float alpha = clamp((al.a - 0.5) / max(fwidth(al.a), 1e-3) + 0.5, 0.0, 1.0);
#ifndef A2C
  alpha = step(0.5, al.a);
#endif
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(treeLight(al.rgb / al.a * 2.0 * mix(vec3(1.0), vTint, leaf), n, leaf, vSun), alpha);
  #include <fog_fragment>
  #include <colorspace_fragment>
}`;

// --- veg.png ------------------------------------------------------------------------
/** 8-bit RGB/RGBA PNG decoded byte-exact (no colour management, no premultiplication); rows top first. */
async function decodePng(buffer) {
  const b = new Uint8Array(buffer), dv = new DataView(buffer);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  for (let p = 8; p < b.length;) {
    const len = dv.getUint32(p), tag = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (tag === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; type = b[p + 17]; interlace = b[p + 20]; }
    else if (tag === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2) || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type})`);
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const ch = type === 6 ? 4 : 3, stride = w * ch, out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, u = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let x = line[i];
      if (f === 1) x += a;
      else if (f === 2) x += u;
      else if (f === 3) x += (a + u) >> 1;
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); x += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      cur[i] = x;
    }
    for (let i = 0, o = y * w * 4; i < w; i++, o += 4) {
      out[o] = cur[i * ch]; out[o + 1] = cur[i * ch + 1]; out[o + 2] = cur[i * ch + 2]; out[o + 3] = ch === 4 ? cur[i * ch + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

// --- tree variants ------------------------------------------------------------------
function percentile(values, q) { const s = Float32Array.from(values).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

/** One ez-tree generated, normalised to unit height, with a lighter mid-range version. */
function buildVariant(def) {
  const opts = merge(structuredClone(TreePreset[def.preset]), def.set || {});
  opts.bark.type = def.bark;
  opts.leaves.type = def.leaves;
  const tree = new Tree();
  const levels = [];
  const generateBranch = tree.generateBranch.bind(tree);
  tree.generateBranch = (branch) => { levels.push([tree.branches.indices.length, branch.level]); generateBranch(branch); };
  tree.loadFromJson(opts);
  const B = tree.branches, L = tree.leaves;
  let top = 0;
  for (let i = 1; i < B.verts.length; i += 3) top = Math.max(top, B.verts[i]);
  for (let i = 1; i < L.verts.length; i += 3) top = Math.max(top, L.verts[i]);
  const k = 1 / top, bp = Float32Array.from(B.verts, (v) => v * k), lp = Float32Array.from(L.verts, (v) => v * k);

  // Crown as an ellipsoid around the leaves: spherical leaf normals and ambient occlusion from it.
  const radial = [], ly = [];
  for (let i = 0; i < lp.length; i += 3) { radial.push(Math.hypot(lp[i], lp[i + 2])); ly.push(lp[i + 1]); }
  const crownR = percentile(radial, 0.9), y0 = percentile(ly, 0.03), y1 = percentile(ly, 0.98);
  const cy = (y0 + y1) / 2, ch = Math.max((y1 - y0) / 2, 0.05);
  const inside = (x, y, z) => Math.hypot(x / crownR, (y - cy) / ch, z / crownR);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  const ln = new Float32Array(lp.length), lao = new Float32Array(lp.length / 3);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3(), sn = new THREE.Vector3();
  for (let q = 0; q < lp.length; q += 12) {
    e1.fromArray(lp, q + 3).sub(fn.fromArray(lp, q));
    e2.fromArray(lp, q + 6).sub(fn);
    const face = e1.clone().cross(e2).normalize();
    for (let v = q; v < q + 12; v += 3) {
      const x = lp[v], y = lp[v + 1], z = lp[v + 2], r = inside(x, y, z);
      sn.set(x / crownR, (y - cy) / ch, z / crownR).normalize();
      fn.copy(face);
      if (fn.dot(sn) < 0) fn.negate();
      fn.multiplyScalar(0.35).addScaledVector(sn, 0.65).normalize().toArray(ln, v);
      lao[v / 3] = (0.42 + 0.58 * smooth(0.15, 1.0, r)) * (0.78 + 0.22 * smooth(y0, y1, y));
    }
  }
  const bao = new Float32Array(bp.length / 3);
  for (let v = 0; v < bp.length; v += 3) bao[v / 3] = 0.55 + 0.4 * smooth(0.3, 1.1, inside(bp[v], bp[v + 1], bp[v + 2]));

  let trunkR = 0;
  for (let v = 0; v < bp.length; v += 3) if (bp[v + 1] < 0.03) trunkR = Math.max(trunkR, Math.hypot(bp[v], bp[v + 2]));
  let radius = 0;
  for (const p of [bp, lp]) for (let v = 0; v < p.length; v += 3) radius = Math.max(radius, Math.hypot(p[v], p[v + 1] - 0.5, p[v + 2]));

  const geo = (pos, nrm, uv, ao, index) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
    g.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? Uint32Array.from(index) : Uint16Array.from(index), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), radius);
    return g;
  };
  const bn = Float32Array.from(B.normals), buv = Float32Array.from(B.uvs), luv = Float32Array.from(L.uvs);
  const bark = geo(bp, bn, buv, bao, B.indices);
  const leaves = geo(lp, ln, luv, lao, L.indices);

  // Mid range: the finest twigs go and a third of the leaf cards stay, each grown to keep the crown full.
  const maxLevel = opts.branch.levels;
  const midIndex = [];
  levels.push([B.indices.length, -1]);
  for (let i = 0; i + 1 < levels.length; i++) {
    if (maxLevel >= 2 && levels[i][1] === maxLevel) continue;
    for (let j = levels[i][0]; j < levels[i + 1][0]; j++) midIndex.push(B.indices[j]);
  }
  const perLeaf = opts.leaves.billboard === 'double' ? 8 : 4, keep = 3, grow = 1.55;
  const mp = [], mn = [], muv = [], mao = [], mi = [];
  for (let v = 0, n = 0; v < lp.length / 3; v += perLeaf, n++) {
    if (n % keep) continue;
    const bx = (lp[v * 3 + 3] + lp[v * 3 + 6]) / 2, by = (lp[v * 3 + 4] + lp[v * 3 + 7]) / 2, bz = (lp[v * 3 + 5] + lp[v * 3 + 8]) / 2;
    const first = mp.length / 3;
    for (let u = v; u < v + perLeaf; u++) {
      mp.push(bx + (lp[u * 3] - bx) * grow, by + (lp[u * 3 + 1] - by) * grow, bz + (lp[u * 3 + 2] - bz) * grow);
      mn.push(ln[u * 3], ln[u * 3 + 1], ln[u * 3 + 2]);
      muv.push(luv[u * 2], luv[u * 2 + 1]);
      mao.push(lao[u]);
    }
    for (let q = first; q < first + perLeaf; q += 4) mi.push(q, q + 1, q + 2, q, q + 2, q + 3);
  }
  const midBark = bark.clone();
  midBark.setIndex(new THREE.BufferAttribute(Uint16Array.from(midIndex), 1));
  midBark.boundingSphere = bark.boundingSphere.clone();
  const midLeaves = geo(Float32Array.from(mp), Float32Array.from(mn), Float32Array.from(muv), Float32Array.from(mao), mi);
  // Bark UVs repeat per section; scale them so the texture keeps its proportions on the trunk.
  const repeat = new THREE.Vector2(opts.bark.textureScale.x, 1 / opts.bark.textureScale.y);
  return { def, bark, leaves, midBark, midLeaves, repeat, crownR, crownBase: y0, cy: 0.5, radius, trunkR,
    tris: [(bark.index.count + leaves.index.count) / 3, (midIndex.length + mi.length) / 3] };
}

/** Linear average colour of a texture's opaque texels, to normalise leaf albedo to a target colour. */
function averageColour(image) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data, sum = [0, 0, 0];
  let w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a < 0.5) continue;
    for (let k = 0; k < 3; k++) sum[k] += srgbToLinear(d[i + k] / 255);
    w++;
  }
  return new THREE.Vector3(sum[0] / w, sum[1] / w, sum[2] / w);
}

// --- the tree system ----------------------------------------------------------------
export class Trees {
  /** `roads` and `ground` are told about the canopy so road corridors and the ground sheet agree with it. */
  constructor(scene, renderer, { roads, ground } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.roads = roads;
    this.ground = ground;
    this.group = new THREE.Group();
    this.group.name = 'trees';
    scene.add(this.group);
    this.tiles = new Map();
    this.focusTile = null;
    this.ready = false;
    this.base = '/citytiles';
    this.stats = { tiles: 0, trees: 0, near: 0, mid: 0, impostors: 0 };
    this.msaa = !!renderer.getContextAttributes()?.antialias;
    const sun = scene.children.find((o) => o.isDirectionalLight), hemi = scene.children.find((o) => o.isHemisphereLight);
    // Lit like the sunlight baked into the survey photos, which is softer than the scene lights' full strength.
    this.uniforms = {
      time: { value: 0 },
      wind: { value: new THREE.Vector2(0.8, 0.6) },
      sunDir: { value: sun ? sun.position.clone().sub(sun.target.position).normalize() : new THREE.Vector3(-0.4, 0.8, 0.3).normalize() },
      sunColor: { value: (sun ? sun.color.clone().multiplyScalar(sun.intensity) : new THREE.Color(2.4, 2.3, 2.1)).multiplyScalar(0.36) },
      skyColor: { value: (hemi ? hemi.color.clone().multiplyScalar(hemi.intensity) : new THREE.Color(1, 1.1, 1.2)).multiplyScalar(0.42) },
      groundColor: { value: (hemi ? hemi.groundColor.clone().multiplyScalar(hemi.intensity) : new THREE.Color(0.5, 0.45, 0.4)).multiplyScalar(0.5) },
    };
    this.frustum = new THREE.Frustum();
    this.projScreen = new THREE.Matrix4();
    this.sphere = new THREE.Sphere();
    // Canopy atlas: one 500 m slot per tile of the window, addressed modulo its size (no copying on recentre).
    const size = WINDOW * TILE_SIZE;
    this.veg = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size);
    this.veg.magFilter = this.veg.minFilter = THREE.NearestFilter;
    this.veg.generateMipmaps = false;
    this.veg.needsUpdate = true;
    this.blank = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this.slot = new THREE.DataTexture(this.blank, TILE_SIZE, TILE_SIZE);
    vegUniforms.vegMap.value = this.veg;
    this.floorMaterial = roads ? roads.materials.skirt.clone() : new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    Object.assign(this.floorMaterial, { polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 6, side: THREE.FrontSide });
    roads?.patch(this.floorMaterial, 0.8);
    if (ground) ground.vegGround = (x, z) => this.groundAt(x, z);
    this.init = this.build().catch((err) => console.error('trees:', err));
  }

  async build() {
    const loader = new THREE.TextureLoader();
    const load = async (url) => { const t = await loader.loadAsync(url); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t; };
    const names = (o) => Object.keys(o);
    const [barks, leaves] = await Promise.all([BARK_URL, LEAF_URL].map(async (o) => Object.fromEntries(await Promise.all(names(o).map(async (k) => [k, await load(o[k])])))));
    for (const t of Object.values(leaves)) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.userData.average = averageColour(t.image); }
    this.variants = VARIANTS.map((def) => {
      const v = buildVariant(def);
      v.leafTexture = leaves[def.leaves];
      v.barkTexture = barks[def.bark];
      v.leafColour = new THREE.Color(def.leaf);
      const avg = v.leafTexture.userData.average;
      v.leafScale = new THREE.Vector3(1 / avg.x, 1 / avg.y, 1 / avg.z);
      v.barkScale = new THREE.Vector3(1, 1, 1).multiplyScalar(def.bark === 'birch' ? 1.0 : 0.9);
      return v;
    });
    this.makeMeshes();
    this.bakeImpostors();
    this.ready = true;
    for (const t of this.tiles.values()) if (t.data) this.place(t);
  }

  material(v, leaf, band, bake = false) {
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: MESH_VERT,
      fragmentShader: MESH_FRAG,
      defines: { ...(leaf ? { LEAF: 1 } : {}), ...(bake ? { BAKE: 1 } : {}), ...(this.msaa ? { A2C: 1 } : {}) },
      side: leaf ? THREE.DoubleSide : THREE.FrontSide,
      fog: !bake,
      alphaToCoverage: leaf && this.msaa && !bake,
    });
    Object.assign(m.uniforms, this.uniforms, {
      map: { value: leaf ? v.leafTexture : v.barkTexture },
      repeat: { value: leaf ? new THREE.Vector2(1, 1) : v.repeat },
      albedoScale: { value: leaf ? v.leafScale : v.barkScale },
      lodBand: { value: band },
      bakeMode: { value: 0 },
    });
    return m;
  }

  makeMeshes() {
    const bands = [new THREE.Vector4(-2, -1, NEAR - FADE, NEAR), new THREE.Vector4(NEAR - FADE, NEAR, MID - FADE, MID)];
    this.lods = [0, 1].map((lod) => this.variants.map((v) => {
      const set = { lod, v, count: 0, capacity: 0, bark: null, leaves: null,
        barkGeo: lod ? v.midBark : v.bark, leafGeo: lod ? v.midLeaves : v.leaves,
        barkMat: this.material(v, false, bands[lod]), leafMat: this.material(v, true, bands[lod]) };
      this.grow(set, 256);
      return set;
    }));
  }

  grow(set, capacity) {
    for (const m of [set.bark, set.leaves]) if (m) { this.group.remove(m); m.dispose(); }
    set.capacity = capacity;
    set.leaves = new THREE.InstancedMesh(set.leafGeo, set.leafMat, capacity);
    set.leaves.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    set.bark = new THREE.InstancedMesh(set.barkGeo, set.barkMat, capacity);
    set.bark.instanceMatrix = set.leaves.instanceMatrix; // one transform buffer for both parts
    for (const m of [set.bark, set.leaves]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; // culled per tree on the CPU
      m.count = 0;
      this.group.add(m);
    }
  }

  /** Render every variant from G x G hemisphere directions into albedo and normal atlases. */
  bakeImpostors() {
    const r = this.renderer, V = this.variants.length;
    const opts = { type: THREE.UnsignedByteType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true };
    const targets = [0, 1].map(() => new THREE.WebGLRenderTarget(G * FRAME, G * FRAME * V, opts));
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-G, G, G * V, -G * V, -4, 4);
    const m = new THREE.Matrix4(), rot = new THREE.Matrix4(), f = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
    const mats = [];
    this.variants.forEach((v, vi) => {
      const parts = [[v.bark, this.material(v, false, null, true)], [v.leaves, this.material(v, true, null, true)]];
      for (const [geo, mat] of parts) {
        mats.push(mat);
        const mesh = new THREE.InstancedMesh(geo, mat, G * G);
        mesh.frustumCulled = false;
        for (let j = 0; j < G; j++) {
          for (let i = 0; i < G; i++) {
            const ox = ((i + 0.5) / G) * 2 - 1, oy = ((j + 0.5) / G) * 2 - 1;
            f.set((ox - oy) / 2, 0, (ox + oy) / 2);
            f.y = 1 - Math.abs(f.x) - Math.abs(f.z);
            f.normalize();
            right.set(f.z, 0, -f.x).normalize();
            up.crossVectors(f, right);
            rot.makeBasis(right, up, f).transpose();
            m.makeTranslation(-G + 1 + 2 * i, -G * V + 1 + 2 * (vi * G + j), 0)
              .multiply(new THREE.Matrix4().makeScale(1 / v.radius, 1 / v.radius, 1 / v.radius))
              .multiply(rot)
              .multiply(new THREE.Matrix4().makeTranslation(0, -v.cy, 0));
            mesh.setMatrixAt(j * G + i, m);
          }
        }
        scene.add(mesh);
      }
    });
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    targets.forEach((target, mode) => {
      for (const mat of mats) mat.uniforms.bakeMode.value = mode;
      r.setRenderTarget(target);
      r.clear();
      r.render(scene, camera);
    });
    r.setRenderTarget(null);
    r.setClearColor(clear, alpha);
    for (const mat of mats) mat.dispose();
    scene.traverse((o) => o.isInstancedMesh && o.dispose());

    this.impostorGeometry = new THREE.InstancedBufferGeometry();
    this.impostorGeometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    this.impostorGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.impostorMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: IMP_VERT,
      fragmentShader: IMP_FRAG,
      defines: this.msaa ? { A2C: 1 } : {},
      fog: true,
      side: THREE.DoubleSide,
      alphaToCoverage: this.msaa,
    });
    Object.assign(this.impostorMaterial.uniforms, this.uniforms, {
      albedoMap: { value: targets[0].texture },
      normalMap: { value: targets[1].texture },
      impInfo: { value: this.variants.map((v) => new THREE.Vector4(v.cy, v.radius, 0, 0)) },
      lodBand: { value: new THREE.Vector4(MID - FADE, MID, FAR - 80, FAR) },
    });
    this.atlas = targets;
  }

  // --- tiles ----------------------------------------------------------------------
  /** Keep the WINDOW x WINDOW tiles around `focus` loaded; call with the game's tile updates. */
  tick(focus) {
    const ix = Math.floor(focus.x / TILE_SIZE), iy = Math.floor(-focus.z / TILE_SIZE), key = `${ix},${iy}`;
    if (key === this.focusTile) return;
    this.focusTile = key;
    const h = (WINDOW - 1) / 2, wanted = new Set();
    for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) wanted.add(tileName((ix + dx) * TILE_SIZE, (iy + dy) * TILE_SIZE));
    for (const [name, t] of this.tiles) if (!wanted.has(name)) this.drop(t);
    vegUniforms.vegWindow.value.set((ix - h) * TILE_SIZE, (iy - h) * TILE_SIZE, WINDOW * TILE_SIZE, 1);
    for (const name of wanted) {
      if (this.tiles.has(name)) continue;
      const m = name.match(/^([EW])(\d+)_([NS])(\d+)$/);
      const tx = (m[1] === 'E' ? 1 : -1) * +m[2], ty = (m[3] === 'N' ? 1 : -1) * +m[4];
      const t = { name, ix: tx, iy: ty, data: null, veg: null, trees: [], meshes: [], cells: new Map(), dead: false };
      this.tiles.set(name, t);
      this.writeSlot(t, null);
      this.load(t);
    }
  }

  async load(t) {
    const get = (file, type) => fetch(`${this.base}/${t.name}/${file}`)
      .then((r) => (r.ok && r.headers.get('content-type')?.includes(type) ? (type === 'json' ? r.json() : r.arrayBuffer()) : null))
      .catch(() => null);
    const [doc, png] = await Promise.all([get('trees.json', 'json'), get('veg.png', 'png')]);
    if (t.dead || !doc?.trees) return;
    let veg = null;
    if (png) {
      try {
        veg = await decodePng(png);
        if (veg.w !== TILE_SIZE || veg.h !== TILE_SIZE) throw new Error(`veg.png is ${veg.w}x${veg.h}`);
      } catch (err) { console.warn(`trees: ${t.name}/veg.png`, err.message); veg = null; }
    }
    if (t.dead) return;
    t.data = doc.trees;
    if (veg) {
      // Rows south to north (texture rows follow northing), canopy grown by a metre so blob fringes go too.
      const src = veg.data, out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4), N = TILE_SIZE;
      for (let k = 0; k < N; k++) {
        const r = N - 1 - k;
        for (let c = 0; c < N; c++) {
          const o = (k * N + c) * 4, s = (r * N + c) * 4;
          let m = 0;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < N && cc < N) m = Math.max(m, src[(rr * N + cc) * 4]);
          }
          out[o] = m; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = 255;
        }
      }
      t.veg = out;
      this.writeSlot(t, out);
      this.buildFloor(t);
      if (this.ground) this.ground.dirty = true;
    }
    if (this.ready) this.place(t);
  }

  writeSlot(t, data) {
    const mod = (v) => ((v % WINDOW) + WINDOW) % WINDOW;
    this.slot.image.data = data || this.blank;
    this.renderer.copyTextureToTexture(this.slot, this.veg, null, new THREE.Vector2(mod(t.ix) * TILE_SIZE, mod(t.iy) * TILE_SIZE));
  }

  drop(t) {
    t.dead = true;
    for (const m of t.meshes) { this.group.remove(m); m.geometry.dispose(); }
    this.tiles.delete(t.name);
  }

  /** Surveyed ground under canopy at (x, z), or NaN where the canopy mask is clear or not loaded. */
  groundAt(x, z) {
    const n = -z, ix = Math.floor(x / TILE_SIZE), iy = Math.floor(n / TILE_SIZE);
    const t = this.tiles.get(tileName(ix * TILE_SIZE, iy * TILE_SIZE));
    if (!t?.veg) return NaN;
    const c = Math.floor(x - ix * TILE_SIZE), k = Math.floor(n - iy * TILE_SIZE), o = (k * TILE_SIZE + c) * 4;
    return t.veg[o] > 127 ? (t.veg[o + 1] * 256 + t.veg[o + 2]) / 100 - 100 : NaN;
  }

  /** Ground under the cut-away canopy, a little below the survey's own wherever that exists. */
  buildFloor(t) {
    const N = TILE_SIZE / FLOOR, P = N + 1, veg = t.veg, x0 = t.ix * TILE_SIZE, n0 = t.iy * TILE_SIZE;
    const cover = new Uint8Array(N * N);
    for (let k = 0; k < TILE_SIZE; k++) for (let c = 0; c < TILE_SIZE; c++) if (veg[(k * TILE_SIZE + c) * 4] > 127) cover[Math.floor(k / FLOOR) * N + Math.floor(c / FLOOR)] = 1;
    const pos = new Float32Array(P * P * 3), col = new Float32Array(P * P * 3), uv = new Float32Array(P * P * 2);
    const tint = new THREE.Color('#4b4c33');
    for (let j = 0; j < P; j++) {
      for (let i = 0; i < P; i++) {
        let y = Infinity;
        for (let dk = -2; dk < 2; dk++) for (let dc = -2; dc < 2; dc++) {
          const k = Math.min(TILE_SIZE - 1, Math.max(0, j * FLOOR + dk)), c = Math.min(TILE_SIZE - 1, Math.max(0, i * FLOOR + dc)), o = (k * TILE_SIZE + c) * 4;
          y = Math.min(y, (veg[o + 1] * 256 + veg[o + 2]) / 100 - 100);
        }
        const v = j * P + i, x = x0 + i * FLOOR, z = -(n0 + j * FLOOR), s = 0.85 + 0.3 * hash(x * 0.05, z * 0.05);
        pos[v * 3] = x; pos[v * 3 + 1] = y - 0.12; pos[v * 3 + 2] = z;
        col[v * 3] = tint.r * s; col[v * 3 + 1] = tint.g * s; col[v * 3 + 2] = tint.b * s;
        uv[v * 2] = x * 0.22; uv[v * 2 + 1] = z * 0.22;
      }
    }
    const index = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let any = 0;
        for (let dj = -1; dj <= 1 && !any; dj++) for (let di = -1; di <= 1; di++) { const a = j + dj, b = i + di; if (a >= 0 && b >= 0 && a < N && b < N && cover[a * N + b]) { any = 1; break; } }
        if (!any) continue;
        const a = j * P + i, b = a + 1, c = a + P, d = c + 1;
        index.push(a, b, c, b, d, c);
      }
    }
    if (!index.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.floorMaterial);
    mesh.name = `floor ${t.name}`;
    mesh.matrixAutoUpdate = false;
    t.meshes.push(mesh);
    this.group.add(mesh);
  }

  /** Choose a variant, scale, tint and trunk for every detected tree of a tile and build its impostors. */
  place(t) {
    t.trees = [];
    const lin = new THREE.Color(), def = new THREE.Color();
    for (const row of t.data) {
      const [e, n, gz, h, cr, cb, type, hex] = row;
      if (!(h >= 2.5 && h < 50) || !(gz > -150)) continue;
      const x = e, z = -n, conifer = type === 1;
      // Shape match: crown width and crown base against each variant of the right kind, then a hashed pick.
      const ratio = THREE.MathUtils.clamp(cr / h, 0.08, 0.7), base = THREE.MathUtils.clamp(cb / h, 0, 0.8), r = hash(e, n);
      const ranked = this.variants.map((v, i) => [i, v.def.type !== (conifer ? 1 : 0) ? 99 : Math.abs(Math.log(ratio / v.crownR)) + Math.abs(base - v.crownBase) * 1.5 + hash(e + i, n - i) * 0.5])
        .sort((a, b) => a[1] - b[1]);
      const vi = ranked[r < 0.7 ? 0 : 1][0], v = this.variants[vi];
      const width = THREE.MathUtils.clamp(ratio / v.crownR, 0.75, 1.35);
      def.copy(v.leafColour);
      if (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) lin.set(hex); else lin.copy(def);
      lin.lerp(def, 0.45).multiplyScalar((0.88 + 0.24 * hash(n, e)) * 1.25);
      t.trees.push({ x, y: gz - 0.2, z, h, width, rot: hash(n * 1.7, e * 0.3) * Math.PI * 2, v: vi, tint: lin.clone(), cb, trunk: v.trunkR * h * width + 0.05 });
    }
    this.clearRoads(t);
    this.buildChunks(t);
    t.roadsChecked = !!this.roads?.entries.size;
  }

  buildChunks(t) {
    for (const m of t.meshes.filter((m) => m.userData.impostor)) { this.group.remove(m); m.geometry.dispose(); }
    t.meshes = t.meshes.filter((m) => !m.userData.impostor);
    t.cells.clear();
    const chunks = new Map();
    for (const tr of t.trees) {
      const key = `${Math.floor(tr.x / CHUNK)},${Math.floor(tr.z / CHUNK)}`;
      (chunks.get(key) || chunks.set(key, []).get(key)).push(tr);
      const ck = `${Math.floor(tr.x / TRUNK_CELL)},${Math.floor(tr.z / TRUNK_CELL)}`;
      (t.cells.get(ck) || t.cells.set(ck, []).get(ck)).push(tr);
    }
    for (const list of chunks.values()) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = this.impostorGeometry.index;
      g.setAttribute('corner', this.impostorGeometry.attributes.corner);
      const p = new Float32Array(list.length * 4), d = new Float32Array(list.length * 4), c = new Float32Array(list.length * 3);
      const box = new THREE.Box3();
      list.forEach((tr, i) => {
        p.set([tr.x, tr.y, tr.z, tr.rot], i * 4);
        d.set([tr.h, tr.width, tr.v, 0], i * 4);
        c.set([tr.tint.r, tr.tint.g, tr.tint.b], i * 3);
        box.expandByPoint(new THREE.Vector3(tr.x, tr.y, tr.z)).expandByPoint(new THREE.Vector3(tr.x, tr.y + tr.h * 1.1, tr.z));
      });
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(p, 4));
      g.setAttribute('iData', new THREE.InstancedBufferAttribute(d, 4));
      g.setAttribute('iTint', new THREE.InstancedBufferAttribute(c, 3));
      g.instanceCount = list.length;
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      g.boundingSphere.radius += 15;
      const mesh = new THREE.Mesh(g, this.impostorMaterial);
      mesh.userData.impostor = true;
      mesh.matrixAutoUpdate = false;
      t.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Trees detected under a canopy that overhangs a road would stand in the lane: move them to the verge. */
  clearRoads(t) {
    if (!this.roads) return;
    t.trees = t.trees.filter((tr) => !this.roads.insideBuilding(tr.x, tr.z, 0.3));
    for (const tr of t.trees) {
      const q = this.roads.corridor(tr.x, tr.z);
      if (!q || q.sd < -0.6 - tr.trunk) continue;
      const push = q.sd + 0.6 + tr.trunk;
      tr.x += q.nx * push;
      tr.z += q.nz * push;
    }
  }

  // --- per frame ---------------------------------------------------------------------
  update(camera, time) {
    this.uniforms.time.value = time;
    if (!this.ready) return;
    // Road corridors arrive with the vector tiles: re-seat trees once they are known.
    if (this.roads?.entries.size) for (const t of this.tiles.values()) if (t.data && !t.roadsChecked) this.place(t);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const lod of this.lods) for (const set of lod) set.count = 0;
    let near = 0, mid = 0, total = 0;
    const reach = MID + 4;
    for (const t of this.tiles.values()) {
      total += t.trees.length;
      const tx = t.ix * TILE_SIZE, tn = t.iy * TILE_SIZE;
      const dx = Math.max(tx - cx, 0, cx - tx - TILE_SIZE), dn = Math.max(tn + cz, 0, -cz - tn - TILE_SIZE);
      if (dx * dx + dn * dn > reach * reach) continue;
      for (const tr of t.trees) {
        const ddx = tr.x - cx, ddy = tr.y - cy, ddz = tr.z - cz, d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 > reach * reach) continue;
        const v = this.variants[tr.v];
        this.sphere.center.set(tr.x, tr.y + v.cy * tr.h, tr.z);
        this.sphere.radius = v.radius * tr.h * Math.max(1, tr.width) + 1;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        const d = Math.sqrt(d2);
        if (d < NEAR + 2) { this.push(this.lods[0][tr.v], tr); near++; }
        if (d > NEAR - FADE - 2) { this.push(this.lods[1][tr.v], tr); mid++; }
      }
    }
    for (const lod of this.lods) {
      for (const set of lod) {
        set.bark.count = set.leaves.count = set.count;
        if (set.count) { set.leaves.instanceMatrix.needsUpdate = true; set.leaves.instanceColor.needsUpdate = true; }
      }
    }
    this.stats = { tiles: this.tiles.size, trees: total, near, mid };
  }

  push(set, tr) {
    if (set.count >= set.capacity) {
      const old = set.leaves, n = set.count;
      this.grow(set, set.capacity * 2);
      set.leaves.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, n * 16));
      set.leaves.instanceColor.array.set(old.instanceColor.array.subarray(0, n * 3));
    }
    const i = set.count++, a = set.leaves.instanceMatrix.array, o = i * 16, c = Math.cos(tr.rot), s = Math.sin(tr.rot), w = tr.h * tr.width;
    a[o] = c * w; a[o + 1] = 0; a[o + 2] = -s * w; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = tr.h; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = s * w; a[o + 9] = 0; a[o + 10] = c * w; a[o + 11] = 0;
    a[o + 12] = tr.x; a[o + 13] = tr.y; a[o + 14] = tr.z; a[o + 15] = 1;
    set.leaves.instanceColor.array.set([tr.tint.r, tr.tint.g, tr.tint.b], i * 3);
  }

  // --- collision ---------------------------------------------------------------------
  /** Trunk hit along a horizontal ray from `origin`, shaped like a three.js intersection, or null. */
  wallHit(origin, dir, far) {
    const len = Math.hypot(dir.x, dir.z);
    if (len < 1e-6) return null;
    const ux = dir.x / len, uz = dir.z / len;
    let best = null;
    const x0 = Math.min(origin.x, origin.x + ux * far) - 2, x1 = Math.max(origin.x, origin.x + ux * far) + 2;
    const z0 = Math.min(origin.z, origin.z + uz * far) - 2, z1 = Math.max(origin.z, origin.z + uz * far) + 2;
    for (let gx = Math.floor(x0 / TRUNK_CELL); gx <= Math.floor(x1 / TRUNK_CELL); gx++) {
      for (let gz = Math.floor(z0 / TRUNK_CELL); gz <= Math.floor(z1 / TRUNK_CELL); gz++) {
        const ix = Math.floor((gx * TRUNK_CELL) / TILE_SIZE), iy = Math.floor((-gz * TRUNK_CELL - 0.001) / TILE_SIZE);
        const list = this.tiles.get(tileName(ix * TILE_SIZE, iy * TILE_SIZE))?.cells.get(`${gx},${gz}`);
        if (!list) continue;
        for (const tr of list) {
          if (origin.y < tr.y - 0.5 || origin.y > tr.y + Math.max(tr.cb, 2.5)) continue;
          const px = tr.x - origin.x, pz = tr.z - origin.z, along = px * ux + pz * uz, r = tr.trunk;
          const off2 = px * px + pz * pz - along * along;
          if (off2 > r * r) continue;
          const t = along - Math.sqrt(r * r - off2);
          if (t < -r || t > far || (best && t >= best.distance)) continue;
          const hx = origin.x + ux * Math.max(t, 0), hz = origin.z + uz * Math.max(t, 0), nl = Math.hypot(hx - tr.x, hz - tr.z) || 1;
          best = { distance: Math.max(t, 0), point: new THREE.Vector3(hx, origin.y, hz), face: { normal: new THREE.Vector3((hx - tr.x) / nl, 0, (hz - tr.z) / nl) }, object: TRUNK };
        }
      }
    }
    return best;
  }
}
const TRUNK = { userData: { entry: { leaf: true } }, matrixWorld: new THREE.Matrix4() };
