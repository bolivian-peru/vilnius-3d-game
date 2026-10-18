// Level-of-detail streaming of the municipal I3S integrated mesh, the same way the public
// 3d.vilnius.lt viewer consumes it: nodes are requested as the camera needs them and nothing
// is stored. Two layers are kept:
//  - detail: the full node-switching LOD tree out to DETAIL_RADIUS, refined around the player and
//    in view, textures sized to what the screen needs and upgraded as you come closer;
//  - horizon: one simplified, tiny-textured copy of every coarsest mesh node out to HORIZON_RADIUS,
//    drawn in its own pass behind the detail so the city always reaches the haze; it has its own
//    share of the memory budget and gives up its farthest copies first.
// Heavy work stays off the main thread: JPEG decode/resize (createImageBitmap), Draco (workers),
// collision BVHs and horizon simplification (i3s-worker.js). GPU uploads are time-budgeted per frame.

import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { mercatorToLocal, ORIGIN } from './geo.js';

const NODES_PER_PAGE = 64;
const MAX_REQUESTS = 12;        // detail nodes in flight: 4 shard hosts x 6 sockets / 2 requests per node
const HORIZON_REQUESTS = [2, 6]; // horizon nodes in flight while detail is busy / idle
const MAX_LOADED = 4000;        // scene-graph cap; memory itself is bounded by the GPU budget
const HORIZON_SHARE = 0.18;     // of the GPU budget
const BVH_JOBS = [2, 6];        // worker BVH builds in flight: ahead of need / for a query now
const STALE_SECONDS = 1;        // a request nobody has wanted for this long is cancelled
export const DETAIL_RADIUS = 2200;
export const HORIZON_RADIUS = 4000;
const MERCATOR_SCALE = Math.cos((54.69 * Math.PI) / 180); // ground metres per Mercator unit at Vilnius
const DRACO_TASK = { attributeIDs: { position: 'POSITION', uv: 'TEX_COORD' },
  attributeTypes: { position: 'Float32Array', uv: 'Float32Array' }, useUniqueIDs: false, vertexColorSpace: THREE.LinearSRGBColorSpace };

/**
 * Canopy mask shared by every survey material (filled by trees.js): the photographed tree blobs are cut
 * away more than a metre above the surveyed ground, where real 3D trees stand instead. A toroidal
 * 1 m atlas: texel (east mod size, north mod size) = r canopy, gb ground cm, a loaded; window = x0, n0, size, on.
 */
export const vegUniforms = {
  vegMap: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) },
  vegWindow: { value: new THREE.Vector4(0, 0, 0, 0) },
};
vegUniforms.vegMap.value.needsUpdate = true;
const VEG_CUT = /* glsl */ `
  if (vegWindow.w > 0.5) {
    vec2 vegEN = vec2(vVegW.x, -vVegW.z) - 0.5, vegRel = vegEN - vegWindow.xy;
    if (vegRel.x >= 0.0 && vegRel.y >= 0.0 && vegRel.x < vegWindow.z - 1.0 && vegRel.y < vegWindow.z - 1.0) {
      ivec2 vp = ivec2(mod(floor(vegEN), vegWindow.z)), vq = ivec2(mod(vec2(vp + 1), vegWindow.z));
      vec4 v00 = texelFetch(vegMap, vp, 0), v10 = texelFetch(vegMap, ivec2(vq.x, vp.y), 0);
      vec4 v01 = texelFetch(vegMap, ivec2(vp.x, vq.y), 0), v11 = texelFetch(vegMap, vq, 0);
      vec2 vf = fract(vegEN);
      float canopy = mix(mix(v00.r * v00.a, v10.r * v10.a, vf.x), mix(v01.r * v01.a, v11.r * v11.a, vf.x), vf.y);
      vec4 vn = vf.x < 0.5 ? (vf.y < 0.5 ? v00 : v01) : (vf.y < 0.5 ? v10 : v11);
      if (canopy > 0.5 && vVegW.y > (vn.g * 65280.0 + vn.b * 255.0) * 0.01 - 99.0) discard;
    }
  }`;

// Textures are uploaded as raw bytes (sRGB uploads take a slow driver path) and decoded in the shader.
function surveyMaterial(map) {
  const m = new THREE.MeshBasicMaterial({ map, toneMapped: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, vegUniforms);
    sh.vertexShader = 'varying vec3 vVegW;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vVegW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform sampler2D vegMap;\nuniform vec4 vegWindow;\nvarying vec3 vVegW;\n' + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${VEG_CUT}`)
      .replace('#include <map_fragment>', 'diffuseColor *= sRGBTransferEOTF(texture(map, vMapUv, -0.4));');
  };
  m.customProgramCacheKey = () => 'survey-srgb-veg';
  return m;
}

/** Width and height from a JPEG's SOF marker, without decoding it. */
async function jpegSize(blob) {
  const b = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

const geometryBytes = (g) => Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, g.index ? g.index.array.byteLength : 0);

/**
 * GPU memory for detail and horizon together, decoded uploads included; uncompressed photo textures
 * dominate. Browsers report at most 8 GB of memory, which is also what the smallest common laptops
 * have, so only a GPU known to be large (Apple Pro/Max/Ultra, current discrete cards) or a big CPU gets
 * the high tier. ?gpu=<GB> overrides.
 */
export function gpuBudget(renderer) {
  const asked = Number(new URLSearchParams(location.search).get('gpu'));
  if (asked > 0) return asked * 1e9;
  const gl = renderer?.getContext(), info = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  const memory = navigator.deviceMemory ?? 4;
  const big = /Apple M\d+ (Pro|Max|Ultra)|RTX|Radeon RX|Radeon Pro|Arc A/i.test(gpu) || (navigator.hardwareConcurrency ?? 4) >= 12;
  return (memory < 8 ? 1.6 : big ? 3.2 : 2.4) * 1e9;
}

export class I3SStream {
  /** `urls`: one base URL or several equivalent hosts to spread requests over (browser connection limits). */
  constructor(urls, scene) {
    this.urls = (Array.isArray(urls) ? urls : [urls]).map((u) => u.replace(/\/$/, ''));
    this.url = this.urls.find((u) => u.startsWith('/')) || this.urls[0];
    this.group = new THREE.Group();
    this.horizonGroup = new THREE.Group();
    scene.add(this.group);
    this.pages = new Map();   // page index -> node array, or null while loading
    this.state = new Map();   // node index -> entry
    this.selected = [];       // detail entries drawn this update
    this.horizon = new Set(); // entries holding a horizon copy
    this.horizonWanted = [];
    this.uploads = [];        // decoded detail meshes and texture upgrades waiting for the GPU
    this.horizonUploads = [];
    this.loading = new Set();
    this.inFlight = 0;
    this.horizonFlight = 0;
    this.upgrading = 0;
    this.bytes = 0;
    this.horizonBytes = 0;
    this.pendingBytes = 0;    // decoded, not yet uploaded
    this.budget = gpuBudget(null);
    this.bvhJobs = 0;
    this.slowWindows = 0;
    this.time = 0;
    this.horizonTimer = 0;
    this.draco = new DRACOLoader().setDecoderPath('/draco/').setWorkerLimit(6);
    this.frustum = new THREE.Frustum();
    this.eye = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.ahead = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.lastFocus = null;
    this.ppr = 700;
    /** Device pixels per CSS pixel; set by the renderer so texture sizes follow real resolution. */
    this.pixelRatio = 1;
    this.stats = { shown: 0, loaded: 0, loading: 0, nearLoading: 0, triangles: 0, horizon: 0, gpuMB: 0, quality: 0 };
    this.anisotropy = 16;
    /** Finest detail is forced within this distance of the focus (and the look-ahead point), for collision. */
    this.fineRadius = 90;
    /** Inside this distance nothing is culled by the view, so turning around shows no gaps; out to
     * backRadius what is behind the camera still refines, with quality scaled by backQuality. */
    this.keepRadius = 320;
    this.backRadius = 1100;
    this.backQuality = 0.3;
    /** Above 1 the mesh refines sooner (sharper, heavier). Beyond sharpRadius farQuality applies. */
    this.quality = 2.2;
    this.farQuality = 1.4;
    this.sharpRadius = 450;
    /** Horizon copies keep this share of triangles, with textures this wide within / beyond 2 km. */
    this.horizonDetail = 0.25;
    this.horizonTexture = [128, 64];
    /** Texture resolution relative to what the screen needs; the governor lowers it under memory pressure. */
    this.texScale = 1;
    /** Adapt `quality` to frame time and `texScale` to GPU memory. */
    this.governor = true;
    this.frameMs = [];
    this.governTimer = 0;
    this.workers = [0, 1].map(() => new Worker(new URL('./i3s-worker.js', import.meta.url), { type: 'module' }));
    this.jobs = new Map();
    this.jobId = 0;
    for (const w of this.workers) {
      w.pending = 0;
      w.onmessage = ({ data }) => {
        const job = this.jobs.get(data.id);
        this.jobs.delete(data.id);
        w.pending--;
        if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
      };
    }
  }

  job(type, data, transfer) {
    const w = this.workers.reduce((a, b) => (b.pending < a.pending ? b : a));
    const id = ++this.jobId;
    w.pending++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      w.postMessage({ type, id, ...data }, transfer);
    });
  }

  node(index) {
    const page = Math.floor(index / NODES_PER_PAGE);
    const nodes = this.pages.get(page);
    if (nodes) return nodes[index % NODES_PER_PAGE];
    if (nodes === undefined) {
      this.pages.set(page, null);
      fetch(`${this.url}/nodepages/${page}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`nodepage ${page}: ${r.status}`))))
        .then((doc) => this.pages.set(page, doc.nodes))
        .catch((err) => { console.warn(err); setTimeout(() => this.pages.delete(page), 3000); });
    }
    return null;
  }

  entry(node) {
    let s = this.state.get(node.index);
    if (!s) {
      const [cx, cy, cz] = node.obb.center;
      const [east, north] = mercatorToLocal(cx, cy);
      const [hx, hy, hz] = node.obb.halfSize;
      const center = new THREE.Vector3(east, cz - ORIGIN.h, -north);
      s = { node, status: 'idle', mesh: null, used: 0, wantedAt: 0, bytes: 0, texSize: 0, native: 0,
        hstatus: 'idle', hmesh: null, hbytes: 0, leaf: !(node.children && node.children.length),
        sphere: new THREE.Sphere(center, Math.hypot(hx * MERCATOR_SCALE, hy * MERCATOR_SCALE, hz)) };
      this.state.set(node.index, s);
    }
    return s;
  }

  resource(id, part) {
    return `${this.urls[id % this.urls.length]}/nodes/${id}/${part}`;
  }

  /** Texture edge length worth having for this node at the current view distance. */
  texSize(s) {
    const d = Math.max(s.sphere.center.distanceTo(this.eye) - s.sphere.radius, 6);
    const need = ((2 * s.sphere.radius * this.ppr * this.pixelRatio) / d) * 1.5 * this.texScale;
    return Math.max(256, 2 ** Math.ceil(Math.log2(need)));
  }

  /** Choose what to draw for this camera and keep full detail around `focus`. */
  update(camera, focus, viewportHeight, dt) {
    this.time += dt;
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const pixelsPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.ppr = pixelsPerRadian;
    this.eye.copy(camera.position);

    // Look ahead along the focus' own motion, so the street you are driving into loads first.
    if (this.lastFocus && dt > 0) {
      const v = new THREE.Vector3().subVectors(focus, this.lastFocus).divideScalar(dt);
      if (v.length() > 80) v.set(0, 0, 0); // a teleport, not motion
      this.velocity.lerp(v, 0.5);
    }
    this.lastFocus = (this.lastFocus || new THREE.Vector3()).copy(focus);
    this.focus.copy(focus);
    const speed = this.velocity.length();
    this.ahead.copy(focus).addScaledVector(this.velocity, speed > 1 ? Math.min(2.5, 120 / speed) : 0);
    const ahead = this.ahead;
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const toNode = new THREE.Vector3();

    const picks = [];
    const wanted = [];
    for (const s of this.horizon) s.hmesh.visible = true;
    const want = (s, gap, nearGap) => {
      const dist = toNode.subVectors(s.sphere.center, camera.position).length() || 1;
      const facing = toNode.dot(camDir) / dist;
      const priority = (Math.max(nearGap, 0) + 1) * (facing > 0.6 ? 1 : facing > 0 ? 1.7 : 3) / (gap >= 3 ? 4 : 1);
      wanted.push([s, priority, nearGap]);
      s.wantedAt = this.time;
    };
    // The horizon copy of a node is hidden wherever detail already covers it, but not where part of
    // it was skipped as out of view: that part shows at once when the camera turns.
    let culled = 0;
    const cover = (s, covered, culledBefore = culled) => {
      if (s.hmesh) s.hmesh.visible = !covered || culled !== culledBefore;
      return covered;
    };

    // `gap` counts levels since the nearest loaded ancestor, which is what covers a node on screen
    // until its own mesh arrives. A horizon copy counts as a coarse ancestor.
    const visit = (index, gap) => {
      const node = this.node(index);
      if (!node) return false;
      const s = this.entry(node);
      const c = s.sphere.center, r = s.sphere.radius;
      const focusGap = c.distanceTo(focus) - r;
      if (focusGap > DETAIL_RADIUS) return false;
      const nearGap = Math.min(focusGap, c.distanceTo(ahead) - r);
      // Out of view: skipped far away, kept at a fraction of the detail nearer in, so turning around
      // swaps in what is already loaded instead of refilling half the view.
      const offscreen = nearGap > this.keepRadius && !this.frustum.intersectsSphere(s.sphere);
      if (offscreen && nearGap > this.backRadius) { culled++; return true; }
      if (s.status === 'loading' || s.status === 'decoded') s.wantedAt = this.time;
      const horizon = s.hstatus === 'ready';

      const dist = Math.max(c.distanceTo(camera.position), 1);
      const diameter = (2 * r * pixelsPerRadian) / dist;
      const q = (dist < this.sharpRadius ? this.quality : this.farQuality) * (offscreen ? this.backQuality : 1);
      const refine = !s.leaf && (!node.mesh || nearGap < this.fineRadius || 0.785 * diameter * diameter * q > node.lodThreshold);

      if (refine) {
        const mark = picks.length, culledBefore = culled;
        let covered = true;
        const childGap = s.status === 'ready' ? 1 : horizon ? 2 : gap + 1;
        for (const child of node.children) covered = visit(child, childGap) && covered;
        if (covered) return cover(s, true, culledBefore);
        if (!node.mesh) return false;
        if (s.status === 'ready') {
          // Children are still arriving: draw this coarser node in their place.
          picks.length = mark;
          picks.push(s);
          return cover(s, true);
        }
        // Load in-between levels only where the covering ancestor is far coarser, so the view
        // sharpens in steps without fetching every level of the tree.
        if (s.status === 'idle' && gap >= 3 && !horizon) want(s, gap, nearGap);
        return cover(s, false);
      }
      if (!node.mesh) return true;
      if (s.status === 'ready') { picks.push(s); return cover(s, true); }
      if (s.status === 'idle') want(s, gap, nearGap);
      return cover(s, false);
    };
    visit(0, 99);

    for (const s of this.selected) if (s.mesh) s.mesh.visible = false;
    let triangles = 0;
    const upgrades = [];
    let shownBytes = 0;
    const needBVH = [];
    for (const s of picks) {
      s.mesh.visible = true;
      shownBytes += s.bytes;
      s.used = this.time;
      triangles += s.triangles;
      if (!s.upgrading && s.texSize < s.native && this.texSize(s) >= 2 * s.texSize) upgrades.push(s);
      if (!s.mesh.geometry.boundsTree && !s.bvhPending) {
        const gap = Math.min(s.sphere.center.distanceTo(focus), s.sphere.center.distanceTo(ahead)) - s.sphere.radius;
        if (gap < 250) needBVH.push([s, gap]);
      }
    }
    this.selected = picks;
    this.shownBytes = shownBytes;
    // Collision trees for everything drawn near the player or ahead, before anything asks for them.
    needBVH.sort((a, b) => a[1] - b[1]);
    for (const [s] of needBVH) if (!this.buildBVH(s)) break;

    // Cancel what nobody wants any more (streets already behind the car).
    for (const s of this.loading) {
      if (this.time - s.wantedAt > STALE_SECONDS) { s.abort.abort(); this.loading.delete(s); s.status = 'idle'; }
    }

    wanted.sort((a, b) => a[1] - b[1]);
    for (const [s] of wanted) {
      if (this.inFlight >= MAX_REQUESTS) break;
      this.load(s);
    }
    if (this.inFlight < MAX_REQUESTS / 2) {
      upgrades.sort((a, b) => a.sphere.center.distanceTo(this.eye) - b.sphere.center.distanceTo(this.eye));
      for (const s of upgrades) { if (this.upgrading >= 3) break; this.upgrade(s); }
    }

    // The horizon trickles (one node at a time, served last by the proxy) while anything near the player
    // waits, and never holds more than its share of memory.
    this.horizonTimer -= dt;
    if (this.horizonTimer <= 0) { this.horizonTimer = 1; this.walkHorizon(focus); }
    const nearWanted = wanted.filter((w) => w[2] < this.keepRadius).length;
    const limit = nearWanted ? 1 : HORIZON_REQUESTS[this.inFlight < MAX_REQUESTS / 2 ? 1 : 0];
    while (this.horizonFlight < limit && this.horizonWanted.length && this.horizonBytes < this.budget * HORIZON_SHARE * 0.95) {
      const [s] = this.horizonWanted.shift();
      if (s.hstatus === 'idle') this.loadHorizon(s);
    }

    this.evict();
    this.govern(dt);
    const waiting = this.inFlight + wanted.length + this.uploads.length;
    this.stats = { shown: picks.length, loaded: this.group.children.length, loading: waiting, nearWanted,
      nearLoading: wanted.filter((w) => w[2] < 220).length + this.uploads.length, triangles, budgetMB: Math.round(this.budget / 1e6),
      horizon: this.horizonGroup.children.length, horizonLoading: this.horizonFlight + this.horizonWanted.length,
      gpuMB: Math.round((this.bytes + this.horizonBytes + this.pendingBytes) / 1e6), horizonMB: Math.round(this.horizonBytes / 1e6), shownMB: Math.round(this.shownBytes / 1e6),
      quality: +this.quality.toFixed(2), texScale: +this.texScale.toFixed(2) };
  }

  /** Coarsest meshed node of every branch within HORIZON_RADIUS, nearest first. */
  walkHorizon(focus) {
    const out = [];
    const walk = (index) => {
      const node = this.node(index);
      if (!node) return;
      const s = this.entry(node);
      const d = Math.hypot(s.sphere.center.x - focus.x, s.sphere.center.z - focus.z) - s.sphere.radius;
      if (d > HORIZON_RADIUS) return;
      if (node.mesh) { if (s.hstatus === 'idle') out.push([s, d]); return; }
      for (const child of node.children || []) walk(child);
    };
    walk(0);
    this.horizonWanted = out.sort((a, b) => a[1] - b[1]);
    const held = [];
    for (const s of this.horizon) {
      const d = Math.hypot(s.sphere.center.x - focus.x, s.sphere.center.z - focus.z) - s.sphere.radius;
      if (d > HORIZON_RADIUS * 1.3) this.unloadHorizon(s); else held.push([s, d]);
    }
    // Over its share: the farthest copies go, and nothing farther than the last kept one is fetched.
    if (this.horizonBytes > this.budget * HORIZON_SHARE) {
      held.sort((a, b) => b[1] - a[1]);
      let reach = Infinity;
      for (const [s, d] of held) {
        if (this.horizonBytes <= this.budget * HORIZON_SHARE * 0.9) break;
        this.unloadHorizon(s);
        reach = d;
      }
      this.horizonWanted = this.horizonWanted.filter((w) => w[1] < reach);
    }
  }

  async fetchOk(url, signal, low = false) {
    // Low priority (the horizon) also tells the caching proxy to serve it after everything else.
    const res = await fetch(low ? `${url}?lo` : url, { signal, priority: low ? 'low' : 'auto' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res;
  }

  async geometry(resource, signal, low) {
    const buffer = await (await this.fetchOk(this.resource(resource, 'geometries/1'), signal, low)).arrayBuffer();
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const g = await this.draco.decodeGeometry(buffer, DRACO_TASK);
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    return g;
  }

  /** Decoded off the main thread and resized to at most `size` px wide. */
  async texture(resource, size, signal, low) {
    const blob = await (await this.fetchOk(this.resource(resource, 'textures/0'), signal, low)).blob();
    const [w0, h0] = (await jpegSize(blob)) || [size, size];
    const w = Math.min(w0, size), h = Math.max(1, Math.round((h0 * w) / w0));
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none',
      ...(w < w0 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' } : {}) });
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false; // I3S texture origin is top-left
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    // The bitmap is not needed after upload; a lost context reloads the stream instead (clear()).
    texture.onUpdate = () => bitmap.close();
    return { texture, w, h, native: w0, bytes: w * h * 4 * 1.34 };
  }

  /** Vertices arrive as Mercator offsets from the node centre; turn them into local metres around the
   * same centre (32-bit floats stay precise anywhere). One affine map per node is exact to millimetres. */
  reproject(s, geometry) {
    const [cx, cy] = s.node.obb.center, c = s.sphere.center, D = 50;
    const [e0, n0] = mercatorToLocal(cx, cy);
    const [ex, nx] = mercatorToLocal(cx + D, cy), [ey, ny] = mercatorToLocal(cx, cy + D);
    const ax = (ex - e0) / D, bx = (ey - e0) / D, ay = (nx - n0) / D, by = (ny - n0) / D;
    const ox = e0 - c.x, oz = -n0 - c.z;
    const a = geometry.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1];
      a[i] = ox + ax * x + bx * y; a[i + 1] = a[i + 2]; a[i + 2] = oz - (ay * x + by * y);
    }
  }

  makeMesh(s, geometry, texture) {
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    // The survey textures already contain sunlight and shadow, so draw them unlit.
    const mesh = new THREE.Mesh(geometry, surveyMaterial(texture));
    mesh.position.copy(s.sphere.center);
    mesh.visible = false;
    mesh.updateMatrixWorld(true);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.userData.entry = s;
    return mesh;
  }

  async load(s) {
    s.status = 'loading';
    s.wantedAt = this.time;
    this.inFlight++;
    this.loading.add(s);
    const abort = (s.abort = new AbortController());
    let tex = null, geometry = null;
    try {
      const { geometry: g, material: m } = s.node.mesh;
      [geometry, tex] = await Promise.all([this.geometry(g.resource, abort.signal), this.texture(m.resource, this.texSize(s), abort.signal)]);
      if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
      this.reproject(s, geometry);
      // Collision BVHs for the street around the player are built in a worker before upload.
      if (s.leaf && s.sphere.center.distanceTo(this.focus) - s.sphere.radius < this.fineRadius + 60) {
        const pos = geometry.attributes.position.array, index = geometry.index.array;
        const r = await this.job('bvh', { position: pos, index }, [pos.buffer, index.buffer]);
        geometry.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
        geometry.setIndex(new THREE.BufferAttribute(r.index, 1));
        geometry.boundsTree = MeshBVH.deserialize({ roots: r.roots, index: r.index }, geometry, { setIndex: false });
        if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
      }
      s.mesh = this.makeMesh(s, geometry, tex.texture);
      s.triangles = geometry.index.count / 3;
      s.texSize = tex.w;
      s.native = tex.native;
      s.texBytes = tex.bytes;
      s.bytes = tex.bytes + geometryBytes(geometry);
      s.status = 'decoded';
      this.loading.delete(s);
      this.pendingBytes += s.bytes;
      this.uploads.push({ s });
    } catch (err) {
      tex?.texture.image.close?.();
      geometry?.dispose();
      if (abort.signal.aborted) return; // already reset by the canceller
      this.loading.delete(s);
      console.warn('I3S node failed', s.node.index, err);
      s.status = 'error';
      setTimeout(() => { if (s.status === 'error') s.status = 'idle'; }, 5000);
    } finally {
      this.inFlight--;
    }
  }

  /** Same texture again at a higher resolution; it comes from the browser cache. */
  async upgrade(s) {
    s.upgrading = true;
    this.upgrading++;
    const mesh = s.mesh;
    try {
      const tex = await this.texture(s.node.mesh.material.resource, Math.min(s.native, this.texSize(s)));
      if (s.status !== 'ready' || s.mesh !== mesh) { tex.texture.image.close(); return; }
      this.pendingBytes += tex.bytes;
      this.uploads.push({ s, tex, mesh });
    } catch (err) {
      console.warn('I3S texture upgrade failed', s.node.index, err);
    } finally {
      s.upgrading = false;
      this.upgrading--;
    }
  }

  async loadHorizon(s) {
    s.hstatus = 'loading';
    this.horizonFlight++;
    const abort = (s.habort = new AbortController());
    try {
      const { geometry: g, material: m } = s.node.mesh;
      const d = Math.hypot(s.sphere.center.x - this.focus.x, s.sphere.center.z - this.focus.z);
      const size = d < 2000 ? this.horizonTexture[0] : this.horizonTexture[1];
      const [geometry, tex] = await Promise.all([this.geometry(g.resource, abort.signal, true), this.texture(m.resource, size, abort.signal, true)]);
      if (abort.signal.aborted) { tex.texture.image.close(); geometry.dispose(); return; }
      this.reproject(s, geometry);
      const position = geometry.attributes.position.array, uv = geometry.attributes.uv.array, index = geometry.index.array;
      const r = await this.job('simplify', { position, uv, index, ratio: this.horizonDetail }, [position.buffer, uv.buffer, index.buffer]);
      const simple = new THREE.BufferGeometry();
      simple.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
      simple.setAttribute('uv', new THREE.BufferAttribute(r.uv, 2));
      simple.setIndex(new THREE.BufferAttribute(r.index, 1));
      if (s.hstatus !== 'loading' || abort.signal.aborted) { tex.texture.image.close(); return; }
      s.hmesh = this.makeMesh(s, simple, tex.texture);
      s.hbytes = tex.bytes + geometryBytes(simple);
      this.horizonUploads.push(s);
    } catch (err) {
      if (abort.signal.aborted) return;
      console.warn('I3S horizon node failed', s.node.index, err);
      s.hstatus = 'error';
      setTimeout(() => { if (s.hstatus === 'error') s.hstatus = 'idle'; }, 8000);
    } finally {
      this.horizonFlight--;
    }
  }

  /** Upload decoded meshes to the GPU within a per-frame time budget. Call every frame before rendering. */
  flush(renderer, budgetMs = 3) {
    const t0 = performance.now();
    while (this.uploads.length && performance.now() - t0 < budgetMs) {
      const { s, tex, mesh } = this.uploads.shift();
      this.pendingBytes -= tex ? tex.bytes : s.bytes;
      if (tex) {
        if (s.mesh !== mesh) { tex.texture.image.close(); continue; }
        renderer.initTexture(tex.texture);
        mesh.material.map.dispose();
        mesh.material.map = tex.texture;
        this.bytes += tex.bytes - s.texBytes;
        s.bytes += tex.bytes - s.texBytes;
        s.texBytes = tex.bytes;
        s.texSize = tex.w;
        continue;
      }
      if (s.status !== 'decoded') continue;
      renderer.initTexture(s.mesh.material.map);
      this.group.add(s.mesh);
      this.bytes += s.bytes;
      s.status = 'ready';
      s.used = this.time;
    }
    while (this.horizonUploads.length && performance.now() - t0 < budgetMs) {
      const s = this.horizonUploads.shift();
      if (s.hstatus !== 'loading') continue;
      renderer.initTexture(s.hmesh.material.map);
      this.horizonGroup.add(s.hmesh);
      this.horizon.add(s);
      this.horizonBytes += s.hbytes;
      s.hstatus = 'ready';
    }
    this.flushMs = performance.now() - t0;
  }

  /** Report a frame interval; feeds the quality governor. Upload bursts are not the view's cost. */
  sample(ms) {
    if (this.flushMs > 2) return;
    this.frameMs.push(ms);
    if (this.frameMs.length > 240) this.frameMs.shift();
  }

  /**
   * Quality (mesh refinement) follows sustained frame time, not single stalls: it drops only after three
   * slow windows in a row (the renderer's pixel ratio absorbs shorter ones) and recovers whenever frames
   * are fast, streaming or not. Memory is what textures cost, so memory pressure scales texture
   * resolution instead; refinement barely changes it.
   */
  govern(dt) {
    this.governTimer += dt;
    if (!this.governor || this.governTimer < 2 || this.frameMs.length < 60) return;
    this.governTimer = 0;
    const f = this.frameMs.slice().sort((a, b) => a - b);
    const p75 = f[Math.floor(f.length * 0.75)];
    this.frameMs.length = 0;
    const shown = this.shownBytes + this.horizonBytes;
    this.slowWindows = p75 > 22 ? this.slowWindows + 1 : 0;
    if (this.slowWindows >= 3) { this.quality *= 0.92; this.slowWindows = 0; }
    else if (p75 < 18 && shown < this.budget * 0.7 && this.uploads.length < 30) this.quality *= 1.04;
    if (shown > this.budget * 0.75) this.texScale *= 0.85;
    else if (shown < this.budget * 0.6) this.texScale *= 1.08;
    this.texScale = THREE.MathUtils.clamp(this.texScale, 0.35, 1);
    this.quality = THREE.MathUtils.clamp(this.quality, 1.8, 2.8);
    this.farQuality = 0.65 * this.quality;
  }

  unload(s) {
    const mesh = s.mesh;
    this.group.remove(mesh);
    mesh.geometry.boundsTree = null;
    mesh.geometry.dispose();
    mesh.material.map.dispose();
    mesh.material.dispose();
    this.bytes -= s.bytes;
    s.mesh = null;
    s.status = 'idle';
    s.texSize = 0;
  }

  unloadHorizon(s) {
    this.horizonGroup.remove(s.hmesh);
    s.hmesh.geometry.dispose();
    s.hmesh.material.map.dispose();
    s.hmesh.material.dispose();
    this.horizonBytes -= s.hbytes;
    this.horizon.delete(s);
    s.hmesh = null;
    s.hstatus = 'idle';
  }

  /** Detail, horizon and decoded uploads together stay within the budget; least recently drawn detail goes first. */
  evict() {
    const total = () => this.bytes + this.horizonBytes + this.pendingBytes;
    if (total() <= this.budget && this.group.children.length <= MAX_LOADED) return;
    const old = this.group.children.filter((m) => !m.visible && this.time - m.userData.entry.used > 2)
      .sort((a, b) => a.userData.entry.used - b.userData.entry.used);
    for (const m of old) {
      if (total() < this.budget * 0.9 && this.group.children.length < MAX_LOADED * 0.9) break;
      this.unload(m.userData.entry);
    }
  }

  /** Drop everything (after a lost WebGL context); nodes stream in again from the HTTP cache. */
  clear() {
    for (const s of this.loading) s.abort.abort();
    for (const u of this.uploads) (u.tex ? u.tex.texture : u.s.mesh?.material.map)?.image?.close?.();
    for (const s of this.state.values()) {
      if (s.mesh && s.status === 'ready') this.unload(s);
      if (s.hmesh && s.hstatus === 'ready') this.unloadHorizon(s);
      s.habort?.abort();
      s.status = s.hstatus = 'idle';
      s.mesh = s.hmesh = null;
    }
    this.loading.clear();
    this.uploads.length = this.horizonUploads.length = 0;
    this.horizon.clear();
    this.horizonWanted = [];
    this.selected = [];
    this.group.clear();
    this.horizonGroup.clear();
    this.bytes = this.horizonBytes = this.pendingBytes = 0;
  }

  /** Drawn meshes with collision trees whose bounds come within `radius` of a point. Never builds on this thread. */
  near(point, radius, out = []) {
    out.length = 0;
    for (const s of this.selected) {
      if (s.sphere.center.distanceTo(point) - s.sphere.radius > radius) continue;
      if (s.mesh.geometry.boundsTree) out.push(s.mesh); else this.buildBVH(s, true);
    }
    return out;
  }

  /**
   * The same for a vertical segment at (x, z) from `top` down to `bottom`: what a ground probe can hit.
   * `out.missing` counts the meshes left out because their tree is still being built.
   */
  column(x, z, top, bottom, out = [], urgent = true) {
    out.length = 0;
    out.missing = 0;
    for (const s of this.selected) {
      const c = s.sphere.center, r = s.sphere.radius;
      if ((c.x - x) ** 2 + (c.z - z) ** 2 > r * r || c.y - r > top || c.y + r < bottom) continue;
      if (s.mesh.geometry.boundsTree) out.push(s.mesh); else { out.missing++; this.buildBVH(s, urgent); }
    }
    return out;
  }

  /** Collision tree from a worker; false when the queue is full. `urgent`: a query is waiting for it. */
  buildBVH(s, urgent = false) {
    if (s.bvhPending) return true;
    if (this.bvhJobs >= BVH_JOBS[urgent ? 1 : 0]) return false;
    s.bvhPending = true;
    this.bvhJobs++;
    const mesh = s.mesh, g = mesh.geometry;
    const position = g.attributes.position.array.slice(), index = g.index.array.slice();
    this.job('bvh', { position, index }, [position.buffer, index.buffer])
      .then((r) => { if (s.mesh === mesh && !g.boundsTree) g.boundsTree = MeshBVH.deserialize({ roots: r.roots, index: r.index }, g, { setIndex: true }); })
      .catch((err) => console.warn('BVH build failed', err))
      .finally(() => { s.bvhPending = false; this.bvhJobs--; });
    return true;
  }
}
