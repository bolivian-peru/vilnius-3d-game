// Ground sheet under the streamed survey. Where dense canopy hid the ground from the survey flights the
// mesh has no ground at all, so the view under trees ended in the haze. This samples the lowest mesh
// surface (finest detail only) on a world-aligned grid around the focus, adds the mapped road profiles
// as known ground, takes canopy and roofs out with a slope-limited lower envelope (anything standing
// more steeply above its surroundings than GRADE is not ground), and draws a sheet SINK below that:
// hidden wherever the photo has ground, plausible ground where it has none.

import * as THREE from 'three';

const CELL = 6, N = 96;             // 576 m square
const GRADE = 0.35, SINK = 0.5;
const DOWN = new THREE.Vector3(0, -1, 0);

export class GroundSheet {
  constructor(scene, stream, roads) {
    this.stream = stream;
    this.roads = roads;
    this.samples = new Map();       // world cell key -> { y, final, at, road, rv }
    this.ox = NaN; this.oz = NaN;   // world cell of grid corner (0, 0)
    this.dirty = false;
    this.builtAt = -1e9;
    this.cursor = 0;
    this.cursorAt = -1e9;
    this.ray = new THREE.Raycaster();
    this.ray.far = 700;
    this.hits = [];
    this.meshes = [];
    this.env = new Float32Array(N * N);
    /** Optional (x, z) -> surveyed ground under tree canopy (trees.js), which the mesh itself may lack. */
    this.vegGround = null;
    // Survey order: nearest cells first.
    const order = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) order.push([(i - N / 2 + 0.5) ** 2 + (j - N / 2 + 0.5) ** 2, j * N + i]);
    this.order = Int32Array.from(order.sort((a, b) => a[0] - b[0]).map((o) => o[1]));

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * N * 3).fill(0.5), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(N * N * 2), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array((N - 1) * (N - 1) * 6), 1));
    g.setDrawRange(0, 0);
    const material = roads.materials.skirt.clone();
    Object.assign(material, { polygonOffsetFactor: 4, polygonOffsetUnits: 8, side: THREE.FrontSide });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'ground';
    // Interpolation across a 6 m cell can lift the sheet over a road edge: the corridor cuts it away.
    roads.patch(material, 0.8);
    scene.add(this.mesh);
  }

  key(cx, cz) { return (cx + 32768) * 65536 + (cz + 32768); }

  /** Lowest surface at a cell centre, or null while a mesh over it still lacks its collision tree. */
  sample(x, z) {
    const meshes = this.stream.column(x, z, 450, -250, this.meshes, false);
    if (meshes.missing) return null;
    this.ray.set(new THREE.Vector3(x, 450, z), DOWN);
    this.ray.firstHitOnly = false;
    this.hits.length = 0;
    this.ray.intersectObjects(meshes, false, this.hits);
    const low = this.hits.at(-1);
    return low ? { y: low.point.y, final: low.object.userData.entry.leaf } : { y: NaN, final: false };
  }

  tick(focus, budgetMs = 0.8) {
    const now = this.stream.time;
    const fx = Math.floor(focus.x / CELL), fz = Math.floor(focus.z / CELL);
    if (!(Math.abs(fx - (this.ox + N / 2)) < N / 4 && Math.abs(fz - (this.oz + N / 2)) < N / 4)) {
      this.ox = fx - N / 2; this.oz = fz - N / 2;
      this.cursor = 0;
      this.dirty = true;
      // Forget samples far outside the grid.
      if (this.samples.size > N * N * 3) {
        for (const [k, s] of this.samples) {
          const cx = Math.floor(k / 65536) - 32768, cz = (k % 65536) - 32768;
          if (Math.abs(cx - fx) > N || Math.abs(cz - fz) > N) this.samples.delete(k);
        }
      }
    }
    if (now - this.cursorAt > 1.5) { this.cursorAt = now; this.cursor = 0; }
    const t0 = performance.now();
    while (this.cursor < this.order.length && performance.now() - t0 < budgetMs) {
      const c = this.order[this.cursor++], cx = this.ox + (c % N), cz = this.oz + Math.floor(c / N);
      const k = this.key(cx, cz), x = (cx + 0.5) * CELL, z = (cz + 0.5) * CELL;
      let s = this.samples.get(k);
      if (!s) this.samples.set(k, (s = { y: NaN, final: false, at: -1e9, road: NaN, rv: -1 }));
      if (s.rv !== this.roads.profileVersion) {
        const q = this.roads.query(x, z);
        const road = q && q.sd > -1 ? q.y : NaN;
        s.rv = this.roads.profileVersion;
        if (!Object.is(road, s.road)) { s.road = road; this.dirty = true; }
      }
      if (s.final || now - s.at < 4) continue;
      const r = this.sample(x, z);
      if (!r) continue;
      s.at = now;
      if (r.final) { s.y = r.y; s.final = true; this.dirty = true; }
    }
    if (this.dirty && now - this.builtAt > 1) this.build(now);
  }

  build(now) {
    this.dirty = false;
    this.builtAt = now;
    const env = this.env, d1 = GRADE * CELL, d2 = GRADE * CELL * Math.SQRT2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const s = this.samples.get(this.key(this.ox + i, this.oz + j));
        const veg = this.vegGround ? this.vegGround((this.ox + i + 0.5) * CELL, (this.oz + j + 0.5) * CELL) : NaN;
        env[j * N + i] = Math.min(!s ? Infinity : Math.min(s.y === s.y ? s.y : Infinity, s.road === s.road ? s.road : Infinity), veg === veg ? veg : Infinity);
      }
    }
    // Two-pass chamfer lower envelope.
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let v = env[j * N + i];
        if (i > 0) v = Math.min(v, env[j * N + i - 1] + d1);
        if (j > 0) {
          v = Math.min(v, env[(j - 1) * N + i] + d1);
          if (i > 0) v = Math.min(v, env[(j - 1) * N + i - 1] + d2);
          if (i < N - 1) v = Math.min(v, env[(j - 1) * N + i + 1] + d2);
        }
        env[j * N + i] = v;
      }
    }
    for (let j = N - 1; j >= 0; j--) {
      for (let i = N - 1; i >= 0; i--) {
        let v = env[j * N + i];
        if (i < N - 1) v = Math.min(v, env[j * N + i + 1] + d1);
        if (j < N - 1) {
          v = Math.min(v, env[(j + 1) * N + i] + d1);
          if (i < N - 1) v = Math.min(v, env[(j + 1) * N + i + 1] + d2);
          if (i > 0) v = Math.min(v, env[(j + 1) * N + i - 1] + d2);
        }
        env[j * N + i] = v;
      }
    }
    const g = this.mesh.geometry, pos = g.attributes.position.array, uv = g.attributes.uv.array, col = g.attributes.color.array;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = j * N + i, x = (this.ox + i + 0.5) * CELL, z = (this.oz + j + 0.5) * CELL;
        pos[v * 3] = x; pos[v * 3 + 1] = env[v] - SINK; pos[v * 3 + 2] = z;
        uv[v * 2] = x * 0.22; uv[v * 2 + 1] = z * 0.22;
        const t = this.roads.tintAt(x, z);
        col[v * 3] = t.r * 0.82; col[v * 3 + 1] = t.g * 0.82; col[v * 3 + 2] = t.b * 0.82;
      }
    }
    const index = g.index.array;
    let n = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
        if (!(env[a] < Infinity && env[b] < Infinity && env[c] < Infinity && env[d] < Infinity)) continue;
        index[n++] = a; index[n++] = c; index[n++] = b;
        index[n++] = b; index[n++] = c; index[n++] = d;
      }
    }
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = g.attributes.uv.needsUpdate = g.attributes.color.needsUpdate = g.index.needsUpdate = true;
  }
}
