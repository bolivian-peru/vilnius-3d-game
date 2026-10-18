// Mapped OSM streets and footpaths as the drivable and walkable surface.
// The survey mesh captures trees as solid curtains down to the road (with no ground under the
// densest canopy) and has every parked car baked in, so each mapped road gets its own height
// profile surveyed from the mesh, its own drawn surface and markings, and a height mask that lets
// the mesh shader cut away whatever stands in the road corridor. Coordinates are scene metres:
// x = east, z = -north.

import * as THREE from 'three';

const STEP = 2;                      // profile sample spacing along a road, m
const CELL = 16;                     // grid hash for road pieces
const BCELL = 32;                    // grid hash for building footprints
const SURVEY_RADIUS = 300;
const MASK_PX = 1024, MASK_RES = 0.5; // carve mask: 512 m square around the focus
// Carve band above the profile: on roads everything of the mesh goes (the drawn surface replaces it);
// on paths the mesh ground stays and only what stands on it goes.
const CARVE_LOW = 0.0, CARVE_HIGH = 4.2, PATH_KEEP = 0.3;
const BUILDING_MARGIN = 1.0;         // OSM footprints sit within ~1 m of the mesh walls
const BLEND = 10;                    // junction blend length, m
const PATH_WIDTH = { footway: 2, path: 1.6, steps: 2.2, cycleway: 2.5, track: 3, bridleway: 2, pedestrian: 4 };
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
const NO_KERB = new Set(['service', 'living_street', 'pedestrian', 'track', 'unclassified']);
const GRADE = { road: 0.2, path: 0.4, steps: 1.2 };
const DOWN = new THREE.Vector3(0, -1, 0);
// Verges: the ground is probed this far beyond each edge, and the verge reaches out to VERGE_REACH.
const VERGE_PROBE = { road: 8, path: 5 }, VERGE_REACH = { road: 24, path: 14 };
// OSM land cover tints the verge (sRGB): unmapped yards, woodland floor, grass, hard standing.
const LU_RES = 4;
const LANDUSE = [[/parking|industrial|construction|brownfield|railway/, 3], [/grass|park|meadow|garden|cemetery|pitch|golf|recreation|village_green|allotments/, 2], [/wood|forest|scrub|heath/, 1]];
const TINTS = ['#6e7350', '#5c5a3d', '#687e46', '#76756f'].map((h) => new THREE.Color(h));
const UP = new THREE.Vector3(0, 1, 0);

const gridKey = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096);
const lerp = (a, b, t) => a + (b - a) * t;
const finite = (v) => v === v;

// Synthetic ray hits returned on mapped roads, shaped like three.js intersections.
const HIT_FINAL = { userData: { entry: { leaf: true } }, matrixWorld: new THREE.Matrix4() };
const HIT_COARSE = { userData: { entry: { leaf: false } }, matrixWorld: new THREE.Matrix4() };

/** Distance-limited lower envelope fit of one survey line; canopy hits stand far above it. */
function fitLine(ss, raw, off, grade, out) {
  const n = ss.length;
  out.fill(NaN);
  const idx = [];
  for (let i = 0; i < n; i++) if (finite(raw[i * 3 + off])) idx.push(i);
  if (!idx.length) return;
  const m = idx.length, ys = idx.map((i) => raw[i * 3 + off]), env = ys.slice();
  for (let k = 1; k < m; k++) env[k] = Math.min(env[k], env[k - 1] + grade * (ss[idx[k]] - ss[idx[k - 1]]));
  for (let k = m - 2; k >= 0; k--) env[k] = Math.min(env[k], env[k + 1] + grade * (ss[idx[k + 1]] - ss[idx[k]]));
  const acc = [];
  for (let k = 0; k < m; k++) if (ys[k] <= env[k] + 0.4) acc.push(k);
  // Linear through accepted points, flat beyond them, only across the measured range.
  let a = 0;
  const tmp = new Float32Array(n).fill(NaN);
  for (let i = idx[0]; i <= idx[m - 1]; i++) {
    while (a < acc.length - 1 && idx[acc[a + 1]] <= i) a++;
    const k0 = acc[a], k1 = acc[Math.min(a + 1, acc.length - 1)];
    const i0 = idx[k0], i1 = idx[k1];
    tmp[i] = i <= i0 ? ys[k0] : i >= i1 ? ys[k1] : lerp(ys[k0], ys[k1], (ss[i] - ss[i0]) / (ss[i1] - ss[i0]));
  }
  // Triangular smoothing over ±5 samples (±10 m).
  for (let i = 0; i < n; i++) {
    if (!finite(tmp[i])) continue;
    let sum = 0, w = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) {
      if (!finite(tmp[j])) continue;
      const wj = 6 - Math.abs(j - i);
      sum += tmp[j] * wj;
      w += wj;
    }
    out[i] = sum / w;
  }
}

function asphaltTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + (Math.random() - 0.5) * 70 + (Math.random() < 0.02 ? 40 : 0);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // A few soft patches so the surface is not uniformly new.
  for (let k = 0; k < 18; k++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${0.04 + Math.random() * 0.05})`;
    g.beginPath();
    g.ellipse(Math.random() * 256, Math.random() * 256, 10 + Math.random() * 40, 6 + Math.random() * 20, Math.random() * 3, 0, 7);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Soft grey ground noise (leaf litter, worn grass) to multiply with the verge's land-cover tint. */
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c8c8c8';
  g.fillRect(0, 0, 256, 256);
  for (let k = 0; k < 2600; k++) {
    const v = 120 + Math.random() * 135 | 0;
    g.fillStyle = `rgba(${v},${v},${v},${0.25 + Math.random() * 0.35})`;
    g.beginPath();
    g.ellipse(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 4, 0.6 + Math.random() * 1.6, Math.random() * 3, 0, 7);
    g.fill();
  }
  for (let k = 0; k < 14; k++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '40,40,30' : '255,255,240'},${0.05 + Math.random() * 0.06})`;
    g.beginPath();
    g.ellipse(Math.random() * 256, Math.random() * 256, 20 + Math.random() * 50, 10 + Math.random() * 30, Math.random() * 3, 0, 7);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Land-cover classes of one tile at LU_RES metres, rasterized on a canvas. */
function landuseGrid(doc) {
  const [x0, y0, x1, y1] = doc.bounds_local, w = Math.ceil((x1 - x0) / LU_RES), h = Math.ceil((y1 - y0) / LU_RES);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  for (const [re, code] of LANDUSE) {
    g.fillStyle = `rgb(${code * 60},0,0)`;
    for (const a of doc.areas || []) {
      if (!re.test(a.kind)) continue;
      g.beginPath();
      for (const ring of a.polygon) ring.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, (x - x0) / LU_RES, (y1 - y) / LU_RES));
      g.fill('evenodd');
    }
  }
  const px = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(px[i * 4] / 60);
  return { x0, y1, w, h, out };
}

class GeoBuilder {
  constructor() { this.pos = []; this.col = []; this.uv = []; this.idx = []; }
  vert(x, y, z, shade = 1, tint = null) {
    this.pos.push(x, y, z);
    if (tint) this.col.push(tint.r * shade, tint.g * shade, tint.b * shade); else this.col.push(shade, shade, shade);
    this.uv.push(x * 0.22, z * 0.22);
    return this.pos.length / 3 - 1;
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

export class RoadNet {
  constructor(scene, stream) {
    this.stream = stream;
    this.group = new THREE.Group();
    this.group.name = 'roads';
    scene.add(this.group);
    this.entries = new Map();   // key -> road or path entry
    this.nodes = new Map();     // OSM junction node -> { x, z, ends: [[entry, 0|1]], y, r }
    this.cells = new Map();     // grid key -> [[entry, piece]]
    this.bcells = new Map();    // grid key -> [building]
    this.crossings = [];
    this.signals = new Set();
    this.chunks = new Map();    // 128 m cell -> { entries: Set, meshes, dirty, built }
    this.landuse = new Map();   // tile -> land-cover grid
    this.ray = new THREE.Raycaster();
    this.hits = [];
    this.focus = new THREE.Vector3();
    this.queue = [];
    this.queueAt = -1e9;
    this.queueFocus = new THREE.Vector3(1e9, 0, 1e9);
    this.changed = new Set();
    this.profileVersion = 0;
    this.enabled = true;

    const tex = asphaltTexture();
    this.materials = {
      road: new THREE.MeshBasicMaterial({ map: tex, color: 0x66686c, vertexColors: true, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
      path: new THREE.MeshBasicMaterial({ map: tex, color: 0x8a867e, vertexColors: true, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 }),
      mark: new THREE.MeshBasicMaterial({ color: 0xcfcfc8, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
      kerb: new THREE.MeshBasicMaterial({ color: 0x8f8d88, vertexColors: true, toneMapped: false, side: THREE.DoubleSide }),
      // Ground under the verges, below the mesh's own: it only shows where tree canopy has no ground under it.
      skirt: new THREE.MeshBasicMaterial({ map: groundTexture(), vertexColors: true, toneMapped: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }),
    };

    // Height mask for the mesh carve: r = road height minus `ref`, g = signed distance into the corridor.
    // Rasterized in floats, uploaded as half floats (half the upload and memory; centimetres are plenty).
    this.maskData = new Float32Array(MASK_PX * MASK_PX * 2);
    this.maskHalf = new Uint16Array(MASK_PX * MASK_PX * 2);
    this.maskTex = new THREE.DataTexture(new Uint16Array(MASK_PX * MASK_PX * 2), MASK_PX, MASK_PX, THREE.RGFormat, THREE.HalfFloatType);
    this.maskTex.magFilter = this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.generateMipmaps = false;
    this.maskTex.needsUpdate = true;
    this.uniforms = {
      roadMask: { value: this.maskTex },
      roadMaskInfo: { value: new THREE.Vector4(0, 0, 1 / (MASK_PX * MASK_RES), 0) },
      roadMaskOn: { value: 0 },
    };
    this.mask = { texture: this.maskTex, centre: new THREE.Vector2(), size: MASK_PX * MASK_RES, uniforms: this.uniforms };
    this.maskJob = null;
    this.maskAt = -1e9;
    this.maskVersion = -1;
    this.maskCentre = new THREE.Vector3(1e9, 0, 1e9);
    this.signGroup = new THREE.Group();
    this.group.add(this.signGroup);
    this.signTex = new Map();
    this.signAt = -1e9;
    this.signFocus = new THREE.Vector3(1e9, 0, 1e9);

    for (const mesh of stream.group.children) this.patch(mesh.material);
    stream.group.addEventListener('childadded', (e) => this.patch(e.child.material));
  }

  // --- network ---------------------------------------------------------------
  /** Rebuild from the loaded tile docs; entries that survive keep their surveyed heights. */
  rebuild(docs) {
    const fresh = new Map();
    const keep = (key, make) => { const e = this.entries.get(key) || make(); fresh.set(key, e); return e; };
    for (const doc of docs) {
      for (const seg of doc.lanegraph?.segments || []) {
        if (seg.tunnel || seg.points.length < 2) continue;
        keep(`r${seg.id}`, () => {
          let width = seg.width_m || 5.5;
          if (seg.inferred?.includes('width') && seg.class === 'service') width = Math.min(width, 4);
          if (seg.inferred?.includes('width') && seg.class === 'living_street') width = Math.min(width, 5);
          return this.makeEntry(`r${seg.id}`, 'road', seg.points, { seg, width, name: seg.name, cls: seg.class,
            bridge: seg.bridge, from: seg.from_node, to: seg.to_node, grade: GRADE.road });
        });
      }
      for (const p of doc.paths || []) {
        const hw = p.tags?.highway;
        if (p.tags?.tunnel && p.tags.tunnel !== 'no') continue;
        if (p.tags?.level || p.tags?.indoor === 'yes' || p.centerline.length < 2) continue;
        keep(`p${doc.tile}:${p.id}`, () => {
          const width = Number(p.tags.width) || (p.tags.footway === 'sidewalk' ? 3 : PATH_WIDTH[hw] || 2);
          return this.makeEntry(`p${doc.tile}:${p.id}`, 'path', p.centerline, { width: Math.min(width, 6), name: p.tags.name || null,
            cls: hw, bridge: p.tags.bridge && p.tags.bridge !== 'no', grade: hw === 'steps' ? GRADE.steps : GRADE.path });
        });
      }
    }
    // Only chunks near an entry that came or went are redrawn (kerbs, verges and junctions look across).
    const changed = [];
    for (const [key, e] of this.entries) if (!fresh.has(key)) { this.chunkOf(e)?.entries.delete(e); changed.push(e); }
    for (const [key, e] of fresh) if (!this.entries.has(key)) changed.push(e);
    this.entries = fresh;

    this.cells.clear();
    this.nodes.clear();
    for (const e of fresh.values()) {
      this.index(e);
      if (e.kind !== 'road') continue;
      for (const [id, end] of [[e.from, 0], [e.to, 1]]) {
        let node = this.nodes.get(id);
        const i = end ? e.n - 1 : 0;
        if (!node) this.nodes.set(id, (node = { id, x: e.xs[i], z: e.zs[i], ends: [], y: NaN, r: 0 }));
        node.ends.push([e, end]);
        node.r = Math.max(node.r, e.half);
      }
    }
    for (const node of this.nodes.values()) if (node.ends.length < 2) node.r = 0;
    for (const e of fresh.values()) {
      if (e.kind !== 'road') continue;
      e.trim0 = this.nodes.get(e.from).r;
      e.trim1 = this.nodes.get(e.to).r;
    }

    this.buildings = [];
    this.bcells.clear();
    for (const doc of docs) {
      for (const b of doc.buildings || []) {
        if (b.tags?.building === 'roof' || b.tags?.layer < 0) continue;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        const rings = b.footprint.map((ring) => {
          const r = new Float32Array(ring.length * 2);
          ring.forEach(([x, north], k) => {
            r[k * 2] = x; r[k * 2 + 1] = -north;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, -north); z1 = Math.max(z1, -north);
          });
          return r;
        });
        const bld = { rings, x0, x1, z0, z1 };
        this.buildings.push(bld);
        const m = BUILDING_MARGIN + 0.5;
        for (let cx = Math.floor((x0 - m) / BCELL); cx <= Math.floor((x1 + m) / BCELL); cx++) {
          for (let cz = Math.floor((z0 - m) / BCELL); cz <= Math.floor((z1 + m) / BCELL); cz++) {
            const k = gridKey(cx, cz);
            const list = this.bcells.get(k);
            if (list) list.push(bld); else this.bcells.set(k, [bld]);
          }
        }
      }
    }

    const tiles = new Set(docs.map((d) => d.tile));
    for (const key of this.landuse.keys()) if (!tiles.has(key)) this.landuse.delete(key);
    for (const doc of docs) if (doc.bounds_local && !this.landuse.has(doc.tile)) this.landuse.set(doc.tile, landuseGrid(doc));
    this.landuseList = [...this.landuse.values()];

    this.crossings = [];
    const seen = new Set();
    for (const doc of docs) {
      for (const p of doc.points || []) {
        if (p.kind !== 'highway=crossing' || seen.has(p.id)) continue;
        seen.add(p.id);
        const marks = p.tags?.['crossing:markings'];
        const zebra = marks ? !['no', 'dots', 'dashes'].includes(marks) : ['zebra', 'marked', 'uncontrolled', 'traffic_signals'].includes(p.tags?.crossing);
        if (zebra) this.crossings.push({ x: p.xyz[0], z: -p.xyz[1] });
      }
    }
    this.signals = new Set(docs.flatMap((d) => d.lanegraph?.signals || []));

    this.junctions(this.nodes.keys());
    for (const e of fresh.values()) { this.finalize(e, true); this.attach(e); }
    const PAD = 20;
    for (const [key, c] of this.chunks) {
      if (!c.entries.size) {
        for (const m of c.meshes) { this.group.remove(m); m.geometry.dispose(); }
        this.chunks.delete(key);
        if (this.chunkJobOf === c) this.chunkJob = null;
        continue;
      }
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const e of c.entries) { x0 = Math.min(x0, e.x0); x1 = Math.max(x1, e.x1); z0 = Math.min(z0, e.z0); z1 = Math.max(z1, e.z1); }
      if (changed.some((e) => e.x1 > x0 - PAD && e.x0 < x1 + PAD && e.z1 > z0 - PAD && e.z0 < z1 + PAD)) c.dirty = true;
    }
    this.queueAt = -1e9;
    this.signAt = -1e9;
    this.profileVersion++;
  }

  makeEntry(key, kind, line, o) {
    const pts = line.map((p) => [p[0], -p[1]]);
    const dist = [0];
    for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = Math.max(dist.at(-1), 0.01);
    const n = Math.max(2, Math.ceil(len / STEP) + 1);
    const step = len / (n - 1);
    const e = { key, kind, ...o, half: o.width / 2, len, n, step,
      xs: new Float32Array(n), zs: new Float32Array(n), ss: new Float32Array(n), nx: new Float32Array(n), nz: new Float32Array(n),
      raw: new Float32Array(n * 3).fill(NaN), fin: new Uint8Array(n), tried: new Float32Array(n).fill(-1e9), ref: new Array(n),
      fc: new Float32Array(n).fill(NaN), fr: new Float32Array(n).fill(NaN), fl: new Float32Array(n).fill(NaN),
      y: new Float32Array(n).fill(NaN), kr: new Float32Array(n), kl: new Float32Array(n), trim0: 0, trim1: 0, j0: NaN, j1: NaN,
      vg: new Float32Array(n * 2).fill(NaN), probe: o.width / 2 + VERGE_PROBE[kind] };
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i * step;
      while (j < pts.length - 2 && dist[j + 1] < s) j++;
      const t = THREE.MathUtils.clamp((s - dist[j]) / Math.max(dist[j + 1] - dist[j], 1e-6), 0, 1);
      e.xs[i] = lerp(pts[j][0], pts[j + 1][0], t);
      e.zs[i] = lerp(pts[j][1], pts[j + 1][1], t);
      e.ss[i] = s;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      const tx = e.xs[b] - e.xs[a], tz = e.zs[b] - e.zs[a], l = Math.hypot(tx, tz) || 1;
      // Right of travel: (-tz, tx) in scene coordinates.
      e.nx[i] = -tz / l;
      e.nz[i] = tx / l;
    }
    e.off = e.half >= 1.6 ? e.half - 0.6 : 0;
    e.x0 = Math.min(...e.xs) - e.half; e.x1 = Math.max(...e.xs) + e.half;
    e.z0 = Math.min(...e.zs) - e.half; e.z1 = Math.max(...e.zs) + e.half;
    return e;
  }

  index(e) {
    const m = e.half + 1.6;
    for (let i = 0; i < e.n - 1; i++) {
      const ax = e.xs[i], az = e.zs[i], bx = e.xs[i + 1], bz = e.zs[i + 1];
      for (let cx = Math.floor((Math.min(ax, bx) - m) / CELL); cx <= Math.floor((Math.max(ax, bx) + m) / CELL); cx++) {
        for (let cz = Math.floor((Math.min(az, bz) - m) / CELL); cz <= Math.floor((Math.max(az, bz) + m) / CELL); cz++) {
          const k = gridKey(cx, cz);
          const list = this.cells.get(k);
          if (list) list.push(e, i); else this.cells.set(k, [e, i]);
        }
      }
    }
  }

  // --- queries -----------------------------------------------------------------
  /**
   * The mapped road or path at (x, z). With `refY`, only surfaces at most 1.6 m above it count and the
   * highest of those wins, so bridges and the streets under them stay apart.
   */
  /** Every mapped road or path within 1.6 m of its edge at (x, z), nearest piece of each, with its height. */
  candidates(x, z, roadsOnly = false, out = []) {
    out.length = 0;
    const list = this.cells.get(gridKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return out;
    const near = this.nearScratch || (this.nearScratch = new Map());
    near.clear();
    for (let k = 0; k < list.length; k += 2) {
      const e = list[k], i = list[k + 1];
      if (roadsOnly && e.kind !== 'road') continue;
      const ax = e.xs[i], az = e.zs[i], dx = e.xs[i + 1] - ax, dz = e.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz || 1e-6;
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const px = x - (ax + dx * t), pz = z - (az + dz * t);
      const d2 = px * px + pz * pz;
      if (d2 > (e.half + 1.6) ** 2) continue;
      const prev = near.get(e);
      if (prev && prev[0] <= d2) continue;
      near.set(e, [d2, i, t, px, pz, dx, dz]);
    }
    for (const [e, [d2, i, t, px, pz, dx, dz]] of near) {
      const l = Math.hypot(dx, dz) || 1e-6;
      const u = (px * -dz + pz * dx) / l;
      const y = this.heightAt(e, i, t, u);
      if (finite(y)) out.push({ e, i, t, u, dx, dz, dist: Math.sqrt(d2), sd: e.half - Math.sqrt(d2), y });
    }
    return out;
  }

  /**
   * The mapped road or path at (x, z). With `refY`, only surfaces at most 1.6 m above it count, and of
   * those only the top level (within 2 m of the highest), so bridges and the streets under them stay apart.
   * Within a level, roads beat paths and the corridor you are most inside wins.
   */
  query(x, z, refY = null, roadsOnly = false) {
    const cands = this.candidates(x, z, roadsOnly, this.candScratch || (this.candScratch = []));
    let top = -Infinity;
    if (refY !== null) for (const c of cands) if (c.y <= refY + 1.6 && c.y > top) top = c.y;
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      if (refY !== null && (c.y > refY + 1.6 || c.y < top - 2)) continue;
      const score = (c.sd >= 0 ? 1000 : c.sd * 10) + Math.min(c.sd, 1.5) + (c.e.kind === 'road' ? 2 : 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;
    const { e, i } = best;
    return { e, i, t: best.t, u: best.u, dist: best.dist, sd: best.sd, y: best.y, half: e.half, kind: e.kind, onRoad: best.sd >= 0,
      heading: Math.atan2(-best.dz, best.dx), final: e.fin[i] === 2 && e.fin[i + 1] === 2, name: e.name };
  }

  heightAt(e, i, t, u) {
    const j = t <= 0 ? i : t >= 1 ? i + 1 : -1; // exact sample: the neighbour may be unsurveyed
    const k = u >= 0 ? e.kr : e.kl, a = Math.min(Math.abs(u), e.half);
    if (j >= 0) return e.y[j] + k[j] * a;
    return lerp(e.y[i], e.y[i + 1], t) + lerp(k[i], k[i + 1], t) * a;
  }

  /** Profile height if (x, z) is within `margin` of a mapped road or path, else null. */
  groundAt(x, z, refY = null, margin = 0.6) {
    const q = this.query(x, z, refY);
    return q && q.sd > -margin ? q.y : null;
  }

  /** A synthetic downward hit on the road profile, or null when (x, z) is off the mapped network. */
  hitAt(x, z, fromY, reach) {
    const q = this.query(x, z, fromY);
    if (!q || q.sd < -0.2 || q.y > fromY || q.y < fromY - reach) return null;
    return { point: new THREE.Vector3(x, q.y, z), distance: fromY - q.y, face: { normal: UP }, object: q.final ? HIT_FINAL : HIT_COARSE, road: q };
  }

  /** A mesh hit that is clutter in a road corridor (canopy, parked car, lamp) rather than a building. */
  passable(p) {
    const q = this.query(p.x, p.z, p.y);
    // Roads reach a little past the kerb, where tree curtains hang over the pavement.
    return !!q && q.sd > (q.kind === 'road' ? -0.8 : -0.3) && p.y > q.y + 0.1 && !this.insideBuilding(p.x, p.z, BUILDING_MARGIN);
  }

  /** Signed distance into the nearest mapped road corridor at (x, z), heights aside, and the way out of it. */
  corridor(x, z) {
    const list = this.cells.get(gridKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    let best = null;
    for (let k = 0; list && k < list.length; k += 2) {
      const e = list[k], i = list[k + 1];
      if (e.kind !== 'road') continue;
      const ax = e.xs[i], az = e.zs[i], dx = e.xs[i + 1] - ax, dz = e.zs[i + 1] - az;
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-6), 0, 1);
      const px = x - ax - dx * t, pz = z - az - dz * t, d = Math.hypot(px, pz) || 1e-6;
      if (!best || e.half - d > best.sd) best = { sd: e.half - d, nx: d > 1e-5 ? px / d : -dz, nz: d > 1e-5 ? pz / d : dx };
    }
    return best;
  }

  insideBuilding(x, z, margin = 0) {
    const list = this.bcells.get(gridKey(Math.floor(x / BCELL), Math.floor(z / BCELL)));
    if (!list) return false;
    for (const b of list) {
      if (x < b.x0 - margin || x > b.x1 + margin || z < b.z0 - margin || z > b.z1 + margin) continue;
      let inside = false, d2 = Infinity;
      for (const r of b.rings) {
        for (let a = 0, c = r.length - 2; a < r.length; c = a, a += 2) {
          const ax = r[a], az = r[a + 1], cx = r[c], cz = r[c + 1];
          if ((az > z) !== (cz > z) && x < ((cx - ax) * (z - az)) / (cz - az) + ax) inside = !inside;
          if (margin > 0) {
            const dx = cx - ax, dz = cz - az, l2 = dx * dx + dz * dz || 1e-9;
            const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
            d2 = Math.min(d2, (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2);
          }
        }
      }
      if (inside || d2 < margin * margin) return true;
    }
    return false;
  }

  // --- height survey -------------------------------------------------------------
  /** Per-frame incremental survey of road heights near the focus, nearest roads first. */
  survey(focus, budgetMs = 1.5) {
    const t0 = performance.now();
    const now = this.stream.time;
    if (now - this.queueAt > 1 || this.queueFocus.distanceToSquared(focus) > 15 * 15) {
      this.queueAt = now;
      this.queueFocus.copy(focus);
      const d = (e) => Math.hypot(Math.max(e.x0 - focus.x, 0, focus.x - e.x1), Math.max(e.z0 - focus.z, 0, focus.z - e.z1));
      this.queue = [...this.entries.values()].map((e) => [e, d(e)]).filter(([, dd]) => dd < SURVEY_RADIUS)
        .sort((a, b) => a[1] - b[1]).map(([e]) => e);
      this.qi = 0;
      for (const e of this.queue) e.cursor = 0;
    }
    const r2 = SURVEY_RADIUS * SURVEY_RADIUS;
    while (this.qi < this.queue.length && performance.now() - t0 < budgetMs) {
      const e = this.queue[this.qi];
      let i = e.cursor;
      for (; i < e.n; i++) {
        if ((e.xs[i] - focus.x) ** 2 + (e.zs[i] - focus.z) ** 2 > r2) continue;
        const f = e.fin[i];
        if (f === 2) continue;
        if (f === 1 && e.ref[i]?.visible && e.ref[i].parent) continue;
        if (f === 0 && now - e.tried[i] < 1.5) continue;
        break;
      }
      e.cursor = i;
      if (i >= e.n) { this.qi++; continue; }
      if (!e.meshes || e.meshesAt !== now) {
        e.meshes = this.stream.selected.filter((s) => {
          const c = s.sphere.center, r = s.sphere.radius;
          return c.x + r > e.x0 && c.x - r < e.x1 && c.z + r > e.z0 && c.z - r < e.z1;
        }).map((s) => s.mesh).filter(Boolean);
        e.meshesAt = now;
      }
      e.tried[i] = now;
      e.cursor = i + 1;
      const col = this.column(e, i);
      const missing = col.filter((m) => !m.geometry.boundsTree);
      if (missing.length) {
        // Collision trees come from the stream's worker; this sample is retried once they exist.
        for (const m of missing) this.stream.buildBVH(m.userData.entry);
        continue;
      }
      this.surveySample(e, i, col);
      e.cursor = i + 1;
      this.changed.add(e);
    }
    if (this.changed.size) this.refit();
  }

  /** Drawn meshes whose bounds reach the vertical line through sample i (with its side rays). */
  column(e, i) {
    const x = e.xs[i], z = e.zs[i], pad = e.probe;
    return e.meshes.filter((m) => {
      const c = m.userData.entry.sphere, r = c.radius + pad;
      return (c.center.x - x) ** 2 + (c.center.z - z) ** 2 < r * r;
    });
  }

  surveySample(e, i, col) {
    const offs = [0, e.off, -e.off, e.probe, -e.probe];
    let fin = 0, ref = null;
    for (let k = 0; k < offs.length; k++) {
      if (k > 0 && k < 3 && !(e.off > 0)) continue;
      if (k >= 3 && (!fin || e.bridge)) break;
      const x = e.xs[i] + e.nx[i] * offs[k], z = e.zs[i] + e.nz[i] * offs[k];
      const meshes = [];
      for (const m of col) {
        const c = m.userData.entry.sphere;
        if ((c.center.x - x) ** 2 + (c.center.z - z) ** 2 < c.radius * c.radius) meshes.push(m);
      }
      this.ray.set(new THREE.Vector3(x, 450, z), DOWN);
      this.ray.far = 600;
      this.ray.firstHitOnly = false;
      this.hits.length = 0;
      this.ray.intersectObjects(meshes, false, this.hits);
      if (!this.hits.length) continue;
      if (k >= 3) {
        // Verge ground relative to the centre; only canopy above means a hole in the survey (NaN).
        const rel = this.hits[this.hits.length - 1].point.y - e.raw[i * 3];
        const v = rel > 1.5 ? NaN : Math.max(rel, -6), old = e.vg[i * 2 + k - 3];
        // Redraw only for a real change, not for every re-survey of the same ground.
        if (finite(v) !== finite(old) || Math.abs(v - old) > 0.3) { e.vg[i * 2 + k - 3] = v; e.vergeNew = true; }
        continue;
      }
      // Lowest surface, which is the ground wherever any is captured; bridges take the deck on top.
      const hit = e.bridge ? this.hits[0] : this.hits[this.hits.length - 1];
      e.raw[i * 3 + k] = hit.point.y;
      if (k === 0) { fin = hit.object.userData.entry.leaf ? 2 : 1; ref = hit.object; }
    }
    if (fin) { e.fin[i] = fin; e.ref[i] = ref; }
  }

  refit() {
    const nodes = new Set();
    for (const e of this.changed) {
      if (e.vergeNew) { e.vergeNew = false; const c = this.chunkOf(e); if (c) c.dirty = true; }
      fitLine(e.ss, e.raw, 0, e.grade, e.fc);
      if (e.off > 0) { fitLine(e.ss, e.raw, 1, e.grade, e.fr); fitLine(e.ss, e.raw, 2, e.grade, e.fl); }
      if (e.kind === 'road') { nodes.add(e.from); nodes.add(e.to); }
    }
    const affected = new Set(this.changed);
    for (const e of this.junctions(nodes)) affected.add(e);
    this.changed.clear();
    for (const e of affected) if (e.kind === 'road') this.finalize(e);
    for (const e of affected) if (e.kind !== 'road') { this.pathEnds(e); this.finalize(e); }
  }

  /** Paths have no junction nodes: each end meets whatever mapped surface is there (roads win). */
  pathEnds(e) {
    for (const end of [0, 1]) {
      const i = end ? e.n - 1 : 0;
      const others = this.candidates(e.xs[i], e.zs[i]).filter((c) => c.e !== e && c.sd > -0.3 && (!finite(e.fc[i]) || Math.abs(c.y - e.fc[i]) < 2.5));
      // A road, or another path met mid-way, sets the height; ends that meet each other share their mean.
      const fixed = others.filter((c) => c.e.kind === 'road')
        .concat(others.filter((c) => { const s = c.e.ss[c.i] + c.t * c.e.step; return s > 1 && s < c.e.len - 1; }));
      const ys = fixed.length ? [fixed[0].y] : [...others.map((c) => c.y), ...(finite(e.fc[i]) ? [e.fc[i]] : [])];
      e[end ? 'j1' : 'j0'] = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : NaN;
    }
  }

  /** Junction height = median of the fitted ends that meet there; returns the entries touching them. */
  junctions(ids) {
    const touched = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const ys = node.ends.map(([e, end]) => e.fc[end ? e.n - 1 : 0]).filter(finite).sort((a, b) => a - b);
      node.y = ys.length ? ys[Math.floor(ys.length / 2)] : NaN;
      for (const [e] of node.ends) touched.push(e);
    }
    return touched;
  }

  /** Final profile: fitted centre, cross slope, blended into junction heights at both ends. */
  finalize(e, quiet = false) {
    const n = e.n;
    const j0 = e.kind === 'road' ? this.nodes.get(e.from)?.y : e.j0, j1 = e.kind === 'road' ? this.nodes.get(e.to)?.y : e.j1;
    let moved = 0;
    const smooth = (v) => v * v * (3 - 2 * v);
    for (let i = 0; i < n; i++) {
      let y = e.fc[i];
      let kr = 0, kl = 0;
      if (e.off > 0) {
        if (finite(e.fr[i]) && finite(y)) kr = THREE.MathUtils.clamp((e.fr[i] - y) / e.off, -0.06, 0.06);
        if (finite(e.fl[i]) && finite(y)) kl = THREE.MathUtils.clamp((e.fl[i] - y) / e.off, -0.06, 0.06);
      }
      const s = e.ss[i];
      const w0 = s < BLEND && finite(j0) ? 1 - smooth(s / BLEND) : 0;
      const w1 = e.len - s < BLEND && finite(j1) ? 1 - smooth((e.len - s) / BLEND) : 0;
      if (finite(y)) {
        if (w0) y += (j0 - e.fc[0]) * w0;
        if (w1) y += (j1 - e.fc[n - 1]) * w1;
      } else if (w0 || w1) {
        y = w0 >= w1 ? j0 : j1; // reaches into an unsurveyed stretch from a known junction
      }
      const keep = 1 - Math.max(w0, w1);
      kr *= keep; kl *= keep;
      if (finite(y) !== finite(e.y[i]) || Math.abs(y - e.y[i]) > 0.05) moved = 1;
      e.y[i] = y; e.kr[i] = kr; e.kl[i] = kl;
    }
    if (moved && !quiet) {
      this.profileVersion++;
      const c = this.chunkOf(e);
      if (c) c.dirty = true;
    }
  }

  // --- drawing -------------------------------------------------------------------
  chunkOf(e) { return e.chunk ? this.chunks.get(e.chunk) : null; }

  attach(e) {
    const m = Math.floor(e.n / 2), cx = Math.floor(e.xs[m] / 128), cz = Math.floor(e.zs[m] / 128);
    e.chunk = gridKey(cx, cz);
    let c = this.chunks.get(e.chunk);
    if (!c) this.chunks.set(e.chunk, (c = { key: e.chunk, x: (cx + 0.5) * 128, z: (cz + 0.5) * 128, entries: new Set(), meshes: [], dirty: true, built: -1e9 }));
    c.entries.add(e);
  }

  update(focus, budgetMs) {
    const now = this.stream.time;
    // One chunk at a time, the nearest dirty one first, built in slices of about 2 ms a frame.
    if (!this.chunkJob) {
      let pick = null, best = Infinity;
      for (const c of this.chunks.values()) {
        if (!c.dirty || now - c.built < 1) continue;
        const d = (c.x - focus.x) ** 2 + (c.z - focus.z) ** 2;
        if (d < best) { best = d; pick = c; }
      }
      if (pick) {
        pick.dirty = false;
        pick.built = now;
        this.chunkJob = this.chunkBuilder(pick);
        this.chunkJobOf = pick;
      }
    }
    const t0 = performance.now();
    while (this.chunkJob && performance.now() - t0 < 2) if (this.chunkJob.next().done) this.chunkJob = null;
    this.updateMask(focus, budgetMs);
    if (now - this.signAt > 1 && (this.signFocus.distanceToSquared(focus) > 900 || now - this.signAt > 5)) {
      this.signAt = now;
      this.signFocus.copy(focus);
      this.buildSigns(focus);
    }
  }

  posAt(e, s, u, lift) {
    const f = THREE.MathUtils.clamp(s / e.step, 0, e.n - 1.0001);
    const i = Math.floor(f), t = f - i;
    const nx = lerp(e.nx[i], e.nx[i + 1], t), nz = lerp(e.nz[i], e.nz[i + 1], t);
    return [lerp(e.xs[i], e.xs[i + 1], t) + nx * u, this.heightAt(e, i, t, u) + lift, lerp(e.zs[i], e.zs[i + 1], t) + nz * u];
  }

  /** A strip at lateral offset `u`, `w` wide, from chainage s0 to s1, dashed when `dash` is set. */
  strip(b, e, u, w, s0, s1, dash = 0, gap = 0, lift = 0.05) {
    const period = dash ? dash + gap : Infinity;
    for (let a = s0; a < s1 - 0.05; a += period) {
      const end = Math.min(s1, dash ? a + dash : s1);
      let prev = null;
      for (let s = a; ; s = Math.min(s + STEP, end)) {
        const p = this.posAt(e, s, u - w / 2, lift), q = this.posAt(e, s, u + w / 2, lift);
        if (!finite(p[1]) || !finite(q[1])) { prev = null; if (s >= end) break; continue; }
        const vi = b.vert(...p), vj = b.vert(...q);
        if (prev) b.quad(prev[0], prev[1], vj, vi);
        prev = [vi, vj];
        if (s >= end) break;
      }
    }
  }

  buildChunk(c) { for (const _ of this.chunkBuilder(c)); }

  /** Geometry of one chunk, yielding after each street so update() can spread it over frames; the old meshes stay until it is done. */
  *chunkBuilder(c) {
    const road = new GeoBuilder(), path = new GeoBuilder(), mark = new GeoBuilder(), kerb = new GeoBuilder(), skirt = new GeoBuilder();
    const nodes = new Set();
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const e of [...c.entries]) {
      yield;
      x0 = Math.min(x0, e.x0); x1 = Math.max(x1, e.x1); z0 = Math.min(z0, e.z0); z1 = Math.max(z1, e.z1);
      const b = e.kind === 'road' ? road : path;
      const lift = e.kind === 'road' ? 0.04 : -0.03;
      const cols = e.kind === 'road' ? [-1, -0.92, 0, 0.92, 1] : [-1, 0, 1];
      const shades = e.kind === 'road' ? [0.8, 0.95, 1, 0.95, 0.8] : [0.9, 1, 0.9];
      let prev = null;
      for (let i = 0; i < e.n; i++) {
        if (!finite(e.y[i])) { prev = null; continue; }
        const row = cols.map((cu, k) => {
          const u = cu * e.half;
          return b.vert(e.xs[i] + e.nx[i] * u, this.heightAt(e, Math.min(i, e.n - 2), i === e.n - 1 ? 1 : 0, u) + lift, e.zs[i] + e.nz[i] * u, shades[k]);
        });
        if (prev) for (let k = 0; k < cols.length - 1; k++) b.quad(prev[k], prev[k + 1], row[k + 1], row[k]);
        prev = row;
      }
      if (!e.bridge) this.skirts(skirt, e);
      if (e.kind !== 'road') continue;
      nodes.add(e.from); nodes.add(e.to);
      this.markings(mark, e);
      if (!NO_KERB.has(e.cls) && !e.bridge) this.kerbs(kerb, e);
    }
    // Junction discs fill the corners between the ribbons that meet there.
    for (const id of nodes) {
      const node = this.nodes.get(id);
      if (!node || node.r === 0 || !finite(node.y) || this.chunkOf(node.ends[0][0]) !== c) continue;
      const centre = road.vert(node.x, node.y + 0.04, node.z);
      const ring = [];
      for (let k = 0; k <= 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        ring.push(road.vert(node.x + Math.cos(a) * node.r, node.y + 0.04, node.z + Math.sin(a) * node.r, 0.95));
      }
      for (let k = 0; k < 20; k++) road.idx.push(centre, ring[k + 1], ring[k]);
      if (!node.ends.some(([e]) => e.bridge)) this.junctionVerge(skirt, node);
      yield;
    }
    for (const cr of this.crossings) {
      if (cr.x < x0 - 2 || cr.x > x1 + 2 || cr.z < z0 - 2 || cr.z > z1 + 2) continue;
      const q = this.query(cr.x, cr.z, null, true);
      if (!q || q.sd < -2 || this.chunkOf(q.e) !== c) continue;
      const s = q.e.ss[q.i] + q.t * q.e.step;
      for (let u = -q.e.half + 0.6; u <= q.e.half - 0.5; u += 1.0) this.strip(mark, q.e, u + 0.25, 0.5, s - 1.5, s + 1.5);
    }
    yield;
    for (const m of c.meshes) { this.group.remove(m); m.geometry.dispose(); }
    c.meshes = [];
    const add = (g, m, order) => {
      const geo = g.build();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, m);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      c.meshes.push(mesh);
    };
    add(path, this.materials.path, 0);
    add(road, this.materials.road, 1);
    add(skirt, this.materials.skirt, 0);
    add(kerb, this.materials.kerb, 1);
    add(mark, this.materials.mark, 2);
  }

  markings(b, e) {
    const s0 = e.trim0 ? e.trim0 + 1 : 0, s1 = e.len - (e.trim1 ? e.trim1 + 1 : 0);
    if (s1 - s0 < 2) return;
    const seg = e.seg, fwd = seg.lanes_fwd || 0, bwd = seg.lanes_bwd || 0, lanes = Math.max(1, fwd + bwd);
    const lw = e.width / lanes;
    const major = MAJOR.has(e.cls);
    if (fwd > 0 && bwd > 0 && e.width >= 6) {
      if (major && lanes >= 4) { this.strip(b, e, -0.12, 0.12, s0, s1); this.strip(b, e, 0.12, 0.12, s0, s1); }
      else this.strip(b, e, 0, 0.12, s0, s1, 3, 6);
    }
    // Lane dividers inside each direction: forward lanes lie right of the centreline.
    const start = bwd > 0 ? 0 : -e.half;
    for (let k = 1; k < fwd; k++) this.strip(b, e, start + k * lw, 0.12, s0, s1, 3, 9);
    for (let k = 1; k < bwd; k++) this.strip(b, e, -k * lw, 0.12, s0, s1, 3, 9);
    if (major && e.width >= 6) {
      this.strip(b, e, e.half - 0.35, 0.15, s0, s1);
      this.strip(b, e, -e.half + 0.35, 0.15, s0, s1);
    }
    // Stop lines where the lane graph has traffic signals.
    if (this.signals.has(e.to) && s1 - s0 > 6) this.strip(b, e, bwd > 0 ? e.half / 2 : 0, bwd > 0 ? e.half : e.width, s1 - 2.4, s1 - 2);
    if (this.signals.has(e.from) && bwd > 0 && s1 - s0 > 6) this.strip(b, e, -e.half / 2, e.half, s0 + 2, s0 + 2.4);
  }

  /** Verge colour for the land cover at (x, z). */
  tintAt(x, z) { return TINTS[this.landuseAt(x, z)]; }

  /** Land-cover class at (x, z): 0 unmapped, 1 woodland, 2 grass, 3 hard standing. */
  landuseAt(x, z) {
    const north = -z;
    for (const t of this.landuseList || []) {
      const c = Math.floor((x - t.x0) / LU_RES), r = Math.floor((t.y1 - north) / LU_RES);
      if (c >= 0 && r >= 0 && c < t.w && r < t.h) return t.out[r * t.w + c];
    }
    return 0;
  }

  /**
   * Verges from both edges out to VERGE_REACH, tinted by land cover. They follow the mesh ground probed
   * beside the road, a little under it so the photo wins wherever it has ground, and where the survey
   * has none (under dense canopy) they run on gently instead of leaving a hole into the haze.
   */
  skirts(b, e) {
    const D = e.probe - e.half, far = VERGE_REACH[e.kind];
    // Columns every 1.5 m out to the probe, so no quad there can bridge over a neighbouring street
    // between two samples, then every 4 m; rows every 4 m along the road.
    const reach = [];
    for (let d = 0; d < D; d += 1.5) reach.push(d);
    for (let d = D; d < far + 0.5; d += 4) if (d > reach.at(-1) + 0.5) reach.push(Math.min(d, far));
    if (reach.at(-1) < far) reach.push(far);
    const v = new Float32Array(e.n);
    for (const side of [1, -1]) {
      // Probed verge heights, smoothed along the road over ±3 samples.
      const off = side > 0 ? 0 : 1;
      for (let i = 0; i < e.n; i++) {
        let sum = 0, w = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(e.n - 1, i + 3); j++) {
          const g = e.vg[j * 2 + off];
          if (finite(g)) { sum += g; w++; }
        }
        v[i] = w ? sum / w : NaN;
      }
      let prev = null;
      for (let i = 0; i < e.n; i += i + 2 < e.n ? 2 : 1) {
        if (!finite(e.y[i])) { prev = null; continue; }
        const y = this.heightAt(e, Math.min(i, e.n - 2), i === e.n - 1 ? 1 : 0, side * e.half);
        const atProbe = finite(v[i]) ? e.y[i] + v[i] - y - 0.25 : -0.6;
        const slope = THREE.MathUtils.clamp(atProbe / D, -0.5, 0.05);
        const row = reach.map((d) => {
          const u = side * (e.half + d), x = e.xs[i] + e.nx[i] * u, z = e.zs[i] + e.nz[i] * u;
          let top = y + (d <= D ? lerp(-0.04, atProbe, d / D) : atProbe + (d - D) * slope);
          // Never above a neighbouring street or path: a verge from a road up the slope would roof it over.
          top = Math.min(top, this.lowestOther(x, z, e) - 0.25);
          return b.vert(x, top, z, 0.95 - 0.15 * (d / far), TINTS[this.landuseAt(x, z)]);
        });
        if (prev) for (let k = 0; k < row.length - 1; k++) b.quad(prev[k], prev[k + 1], row[k + 1], row[k]);
        prev = row;
      }
    }
  }

  /** A verge ring around a junction, filling the wedges the verges of the streets meeting there leave open. */
  junctionVerge(b, node) {
    let low = 0;
    for (const [e, end] of node.ends) {
      const i = end ? e.n - 1 : 0;
      for (const g of [e.vg[i * 2], e.vg[i * 2 + 1]]) if (finite(g)) low = Math.min(low, g);
    }
    const radii = [node.r, node.r + 8, node.r + 16, node.r + 24], drops = [-0.06, Math.min(-0.6, low - 0.25), Math.min(-1.2, low - 0.6), Math.min(-1.8, low - 1)];
    let prev = null;
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const row = radii.map((r, j) => {
        const x = node.x + ca * r, z = node.z + sa * r;
        const y = Math.min(node.y + drops[j], this.lowestOther(x, z, null) - 0.25);
        return b.vert(x, y, z, 0.95 - 0.15 * (j / 3), TINTS[this.landuseAt(x, z)]);
      });
      if (prev) for (let j = 0; j < radii.length - 1; j++) b.quad(prev[j], prev[j + 1], row[j + 1], row[j]);
      prev = row;
    }
  }

  /** Lowest profile height of any other road or path within 1 m of (x, z); Infinity if none. Allocation-free. */
  lowestOther(x, z, self) {
    const list = this.cells.get(gridKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    let low = Infinity;
    if (!list) return low;
    for (let k = 0; k < list.length; k += 2) {
      const e = list[k], i = list[k + 1];
      if (e === self) continue;
      const ax = e.xs[i], az = e.zs[i], dx = e.xs[i + 1] - ax, dz = e.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz || 1e-6;
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const px = x - (ax + dx * t), pz = z - (az + dz * t);
      if (px * px + pz * pz > (e.half + 1) ** 2) continue;
      const y = this.heightAt(e, i, t, (px * -dz + pz * dx) / Math.sqrt(l2));
      if (y < low) low = y;
    }
    return low;
  }

  kerbs(b, e) {
    const s0 = e.trim0 + 1.5, s1 = e.len - e.trim1 - 1.5;
    for (const side of [1, -1]) {
      let prev = null;
      for (let s = s0; s <= s1; s += STEP) {
        const p = this.posAt(e, s, side * e.half, 0);
        const out = this.posAt(e, s, side * (e.half + 0.6), 0);
        // No kerb across another street or where it would stand inside a building.
        const other = this.query(out[0], out[2], p[1] + 1, true);
        const open = finite(p[1]) && !(other && other.e !== e && other.sd > 0) && !this.insideBuilding(p[0], p[2]);
        if (!open) { prev = null; continue; }
        const top = this.posAt(e, s, side * (e.half + 0.18), 0);
        const row = [b.vert(p[0], p[1] - 0.3, p[2], 0.75), b.vert(p[0], p[1] + 0.13, p[2], 1), b.vert(top[0], p[1] + 0.13, top[2], 1.05)];
        if (prev) { b.quad(prev[0], row[0], row[1], prev[1]); b.quad(prev[1], row[1], row[2], prev[2]); }
        prev = row;
      }
    }
  }

  signTexture(name) {
    let t = this.signTex.get(name);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#1f3c6e'; g.fillRect(6, 6, 500, 116);
    g.fillStyle = '#ffffff';
    let size = 64;
    g.font = `600 ${size}px "Helvetica Neue", Arial, sans-serif`;
    while (g.measureText(name).width > 470 && size > 24) g.font = `600 ${(size -= 4)}px "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, 256, 68);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.signTex.set(name, t);
    return t;
  }

  /** Street name plates on posts at junctions where the street name changes, near the focus only. */
  buildSigns(focus) {
    for (const m of [...this.signGroup.children]) this.signGroup.remove(m);
    this.signPost ||= new THREE.CylinderGeometry(0.045, 0.045, 3, 6).translate(0, 1.5, 0);
    this.signPlate ||= new THREE.PlaneGeometry(1.15, 0.29);
    this.postMat ||= new THREE.MeshBasicMaterial({ color: 0x55585c, toneMapped: false });
    const near = [...this.nodes.values()].filter((n) => n.ends.length >= 2 && finite(n.y) && (n.x - focus.x) ** 2 + (n.z - focus.z) ** 2 < 150 * 150)
      .sort((a, b) => (a.x - focus.x) ** 2 + (a.z - focus.z) ** 2 - ((b.x - focus.x) ** 2 + (b.z - focus.z) ** 2));
    let count = 0;
    for (const node of near) {
      if (count >= 40) break;
      const named = new Map();
      for (const [e, end] of node.ends) if (e.name && !named.has(e.name) && !['service'].includes(e.cls)) named.set(e.name, [e, end]);
      if (named.size < 2) continue;
      const [[e0, end0]] = named.values();
      // Corner position: back along the first street and off to its side, clear of the carriageway.
      const s = end0 ? e0.len - node.r - 1.5 : node.r + 1.5;
      const p = this.posAt(e0, s, (end0 ? 1 : -1) * (e0.half + 1.2), 0);
      if (!finite(p[1]) || this.insideBuilding(p[0], p[2])) continue;
      const post = new THREE.Mesh(this.signPost, this.postMat);
      post.position.set(p[0], (this.groundAt(p[0], p[2], p[1] + 1) ?? p[1]) + 0.1, p[2]);
      this.signGroup.add(post);
      let h = 2.75;
      for (const [name, [e, end]] of [...named].slice(0, 3)) {
        const i = end ? e.n - 1 : 0;
        const heading = Math.atan2(e.nx[i], e.nz[i]); // plate runs along its street
        for (const flip of [0, Math.PI]) {
          const plate = new THREE.Mesh(this.signPlate, new THREE.MeshBasicMaterial({ map: this.signTexture(name), toneMapped: false }));
          plate.position.set(0, h, 0);
          plate.rotation.y = heading + flip;
          post.add(plate);
        }
        h -= 0.33;
      }
      count++;
    }
  }

  // --- mesh carve ------------------------------------------------------------------
  /** Cut away what of `material` stands in a road corridor; `margin` m widens the corridor beyond the kerb. */
  patch(material, margin = 0) {
    if (!material || material.userData.roadCarve) return;
    material.userData.roadCarve = true;
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    const u = this.uniforms;
    material.onBeforeCompile = function (shader, renderer) {
      prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.vertexShader = 'varying vec3 vRoadW;\n' + shader.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n  vRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = 'uniform sampler2D roadMask;\nuniform vec4 roadMaskInfo;\nuniform float roadMaskOn;\nvarying vec3 vRoadW;\n'
        + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  if (roadMaskOn > 0.5) {
    vec2 ruv = (vRoadW.xz - roadMaskInfo.xy) * roadMaskInfo.z + 0.5;
    if (ruv.x > 0.0 && ruv.y > 0.0 && ruv.x < 1.0 && ruv.y < 1.0) {
      vec2 rm = texture2D(roadMask, ruv).rg;
      float rdy = vRoadW.y - roadMaskInfo.w - rm.r;
      if (rm.g > ${(-margin).toFixed(2)} && rdy > ${CARVE_LOW.toFixed(2)} && rdy < ${CARVE_HIGH.toFixed(2)}) discard;
    }
  }`);
    };
    material.customProgramCacheKey = function () { return `${prevKey.call(this)}|roadcarve${margin}`; };
    material.needsUpdate = true;
  }

  updateMask(focus, budgetMs) {
    const now = this.stream.time;
    if (!this.maskJob) {
      const far = this.maskCentre.distanceToSquared(focus) > 48 * 48;
      const stale = this.maskVersion !== this.profileVersion && now - this.maskAt > 3;
      if (!far && !stale) return;
      this.maskAt = now;
      this.maskJob = this.rasterize(Math.round(focus.x), Math.round(focus.z), Math.round(focus.y), this.profileVersion);
    }
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (this.maskJob.next().done) { this.maskJob = null; break; }
    }
  }

  *rasterize(cx, cz, ref, version) {
    const N = MASK_PX, R = MASK_RES, half = (N * R) / 2;
    const x0 = cx - half, z0 = cz - half;
    const out = this.maskData;
    for (let row = 0; row < N; row += 64) {
      for (let p = row * N, end = Math.min(N, row + 64) * N; p < end; p++) { out[p * 2] = 0; out[p * 2 + 1] = -9; }
      yield;
    }
    let work = 0;
    // Road corridors: signed distance to the edge and the profile height there.
    for (const e of this.entries.values()) {
      if (e.x1 < x0 - 2 || e.x0 > x0 + 2 * half + 2 || e.z1 < z0 - 2 || e.z0 > z0 + 2 * half + 2) continue;
      const m = e.half + 1.5, lift = e.kind === 'path' ? PATH_KEEP : 0;
      for (let i = 0; i < e.n - 1; i++) {
        if (!finite(e.y[i]) || !finite(e.y[i + 1])) continue;
        const ax = e.xs[i], az = e.zs[i], dx = e.xs[i + 1] - ax, dz = e.zs[i + 1] - az;
        const l2 = dx * dx + dz * dz || 1e-6, l = Math.sqrt(l2);
        const c0 = Math.max(0, Math.floor((Math.min(ax, ax + dx) - m - x0) / R)), c1 = Math.min(N - 1, Math.ceil((Math.max(ax, ax + dx) + m - x0) / R));
        const r0 = Math.max(0, Math.floor((Math.min(az, az + dz) - m - z0) / R)), r1 = Math.min(N - 1, Math.ceil((Math.max(az, az + dz) + m - z0) / R));
        if (c0 > c1 || r0 > r1) continue;
        for (let row = r0; row <= r1; row++) {
          const z = z0 + (row + 0.5) * R;
          for (let col = c0; col <= c1; col++) {
            const x = x0 + (col + 0.5) * R;
            const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
            const px = x - ax - dx * t, pz = z - az - dz * t;
            const sd = e.half - Math.sqrt(px * px + pz * pz);
            const p = (row * N + col) * 2;
            if (sd <= out[p + 1]) continue;
            out[p + 1] = sd;
            out[p] = this.heightAt(e, i, t, (px * -dz + pz * dx) / l) - ref + lift;
          }
        }
        work += (r1 - r0 + 1) * (c1 - c0 + 1);
        if (work > 20000) { work = 0; yield; }
      }
    }
    // Never carve near a building, so facades along narrow streets stay whole.
    const m = BUILDING_MARGIN + 1.6;
    for (const b of this.buildings) {
      if (b.x1 < x0 - m || b.x0 > x0 + 2 * half + m || b.z1 < z0 - m || b.z0 > z0 + 2 * half + m) continue;
      const c0 = Math.max(0, Math.floor((b.x0 - m - x0) / R)), c1 = Math.min(N - 1, Math.ceil((b.x1 + m - x0) / R));
      const r0 = Math.max(0, Math.floor((b.z0 - m - z0) / R)), r1 = Math.min(N - 1, Math.ceil((b.z1 + m - z0) / R));
      for (let row = r0; row <= r1; row++) {
        const z = z0 + (row + 0.5) * R;
        for (let col = c0; col <= c1; col++) {
          const p = (row * N + col) * 2;
          if (out[p + 1] <= -1.5) continue;
          const x = x0 + (col + 0.5) * R;
          let inside = false, d2 = Infinity;
          for (const r of b.rings) {
            for (let a = 0, c = r.length - 2; a < r.length; c = a, a += 2) {
              const ax = r[a], az = r[a + 1], ex = r[c], ez = r[c + 1];
              if ((az > z) !== (ez > z) && x < ((ex - ax) * (z - az)) / (ez - az) + ax) inside = !inside;
              const dx = ex - ax, dz = ez - az, l2 = dx * dx + dz * dz || 1e-9;
              const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
              d2 = Math.min(d2, (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2);
            }
          }
          const g = (inside ? -1 : Math.sqrt(d2)) - BUILDING_MARGIN;
          if (g < out[p + 1]) out[p + 1] = g;
          work += b.rings[0].length;
        }
        if (work > 30000) { work = 0; yield; }
      }
      work += 50;
    }
    const staged = this.maskHalf, toHalf = THREE.DataUtils.toHalfFloat;
    for (let p = 0; p < out.length; p += 1 << 16) {
      for (let q = p, end = Math.min(out.length, p + (1 << 16)); q < end; q++) staged[q] = toHalf(out[q]);
      yield;
    }
    // Swap in the finished buffer; the old one is the next staging buffer.
    [this.maskHalf, this.maskTex.image.data] = [this.maskTex.image.data, staged];
    this.maskTex.needsUpdate = true;
    this.uniforms.roadMaskInfo.value.set(cx, cz, 1 / (N * R), ref);
    this.uniforms.roadMaskOn.value = this.enabled ? 1 : 0;
    this.mask.centre.set(cx, cz);
    this.maskCentre.set(cx, ref, cz);
    this.maskVersion = version;
  }

  /** One call per frame: survey, redraw changed stretches, refresh the carve mask and signs. */
  tick(focus, budgetMs = 1.5) {
    if (!this.entries.size) return;
    this.survey(focus, budgetMs);
    this.update(focus, Math.max(1, budgetMs));
    this.group.visible = this.enabled;
    if (!this.enabled) this.uniforms.roadMaskOn.value = 0;
  }
}
