// Browser build: walk and drive anywhere in Vilnius on the streamed municipal survey mesh.
// World frame is three.js Y-up: x = east, y = height, z = -north, metres from the project origin.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { I3SStream, HORIZON_RADIUS, gpuBudget } from './i3s.js';
import { Post, horizonColor } from './post.js';
import { loadModels } from './models.js';
import { PLACES } from './places.js';
import { Vehicle, FERRARI_458 } from './vehicle.js';
import { lonLatToLocal, ORIGIN, TILE_SIZE, tileName } from './geo.js';
import { RoadNet } from './roads.js';
import { GroundSheet } from './ground.js';
import { Trees } from './trees.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Served by the dev server's caching proxy (vite.config.js), which forwards to the municipal service.
// On localhost the same server also answers as s0..s3.localhost, which lifts the browser's six
// connections per host; each resource always maps to one host so the HTTP cache keeps working.
const MESH_URLS = location.hostname === 'localhost' ? [0, 1, 2, 3].map((i) => `${location.protocol}//s${i}.localhost:${location.port}/i3s`) : ['/i3s'];
const DOWN = new THREE.Vector3(0, -1, 0);

const $ = (id) => document.getElementById(id);
const forwardOf = (heading) => new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));

// --- renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
const scene = new THREE.Scene();
// Aerial perspective: exponential haze that only swallows the city towards the real horizon.
scene.fog = new THREE.FogExp2(0xb9cfe6, 3.3e-4);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const camera = new THREE.PerspectiveCamera(60, 1, 0.25, 2600);
// The far layer (sky and the coarse horizon city) is drawn first with its own depth range.
const farCamera = new THREE.PerspectiveCamera(60, 1, 3, HORIZON_RADIUS + 2500);
const horizonScene = new THREE.Scene();
horizonScene.fog = scene.fog;
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x6a6458, 1.2));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.set(-200, 400, 150);
scene.add(sun);

// Physical sky dome that follows the camera; the survey mesh itself is drawn unlit.
const sky = new Sky();
sky.scale.setScalar(farCamera.far * 0.55); // box corners must stay inside the far plane
sky.frustumCulled = false;
Object.assign(sky.material.uniforms.turbidity, { value: 4 });
Object.assign(sky.material.uniforms.rayleigh, { value: 1.4 });
Object.assign(sky.material.uniforms.mieCoefficient, { value: 0.004 });
sky.material.uniforms.sunPosition.value.copy(sun.position).normalize();
// Below the horizon show the horizon's haze rather than the shader's grey ground half.
sky.material.fragmentShader = sky.material.fragmentShader.replace('vec3 direction = normalize( vWorldPosition - cameraPosition );',
  'vec3 direction = normalize( vWorldPosition - cameraPosition ); direction.y = max( direction.y, 0.01 ); direction = normalize( direction );');
horizonScene.add(sky);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  for (const c of [camera, farCamera]) {
    c.aspect = innerWidth / innerHeight;
    c.updateProjectionMatrix();
  }
}
addEventListener('resize', resize);
resize();
const haze = horizonColor(renderer, horizonScene, sky);
scene.fog.color.copy(haze);
horizonScene.background = haze;

const stream = new I3SStream(MESH_URLS, scene);
stream.anisotropy = renderer.capabilities.getMaxAnisotropy();
stream.budget = gpuBudget(renderer);
// Survey textures release their source bitmaps after upload, so a lost context reloads the stream.
renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stream.clear(); });
renderer.domElement.addEventListener('webglcontextrestored', () => { stream.clear(); heightCache.clear(); });
horizonScene.add(stream.horizonGroup);
const post = new Post(renderer, [[horizonScene, farCamera], [scene, camera]]);

// --- collision queries against the streamed mesh ----------------------------
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const scratch = [];
const probe = new THREE.Vector3();

// Mapped OSM roads and paths carry their own surveyed height profile, so on them the ground is the
// profile and trees, lamps and baked-in parked cars standing in the corridor never block (roads.js).
const roads = new RoadNet(scene, stream);
const ground = new GroundSheet(scene, stream, roads);
// Real trees replace the survey's canopy blobs; their trunks are solid for the player, car and camera.
const trees = new Trees(scene, renderer, { roads, ground });
if (new URLSearchParams(location.search).get('trees')) trees.base = new URLSearchParams(location.search).get('trees');
const wallFromScratch = new THREE.Vector3();

/** First surface below (x, fromY, z) within `reach` metres, or null. On a mapped road: the road. */
function rayGround(x, z, fromY, reach = 30) {
  const road = roads.hitAt(x, z, fromY, reach);
  if (road) return road;
  ray.set(probe.set(x, fromY, z), DOWN);
  ray.far = reach;
  return ray.intersectObjects(stream.column(x, z, fromY, fromY - reach, scratch), false)[0] || null;
}

/** First solid surface along a ray: a tree trunk, or the mesh where clutter inside a road corridor is passed through. */
function wallHit(origin, dir, far) {
  const trunk = trees.wallHit(origin, dir, far), hit = meshWallHit(origin, dir, trunk ? trunk.distance : far);
  return hit || trunk;
}

function meshWallHit(origin, dir, far) {
  const from = wallFromScratch.copy(origin);
  let gone = 0;
  for (let k = 0; k < 6 && gone < far; k++) {
    ray.set(from, dir);
    ray.far = far - gone;
    const hit = ray.intersectObjects(stream.near(from, far - gone + 2, scratch), false)[0];
    if (!hit) return null;
    if (!roads.passable(hit.point)) { hit.distance += gone; return hit; }
    gone += hit.distance + 0.05;
    from.copy(origin).addScaledVector(dir, gone);
  }
  return null;
}

// Vehicles ride a smoothed surface. The survey mesh has every parked car baked in as a lump,
// so each wheel takes a low quantile of nearby heights instead of the surface right under it.
const heightCache = new Map();
const ROAD_SAMPLES = [[0, 0], [2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6], [1.8, 1.8], [1.8, -1.8], [-1.8, 1.8], [-1.8, -1.8]];

function cellY(x, z, refY) {
  const key = `${Math.round(x)},${Math.round(z)},${Math.round(refY / 3)}`;
  const cached = heightCache.get(key);
  if (cached !== undefined && cached.until > stream.time) return cached.y;
  const hit = rayGround(Math.round(x), Math.round(z), refY + 1.6, 4.6);
  const y = hit ? hit.point.y : null;
  // Only finest-detail results are final; coarser ones expire so they sharpen as the area streams in.
  const final = hit ? hit.object.userData.entry.leaf : stream.stats.loading === 0;
  if (heightCache.size > 400000) heightCache.clear();
  heightCache.set(key, { y, until: final ? Infinity : stream.time + 1.5 });
  return y;
}

/** Drivable height at (x, z): the road profile on a mapped road, blending to the mesh over 1.5 m past its edge. */
function roadY(x, z, refY) {
  const q = roads.query(x, z, refY);
  if (q?.onRoad) return q.y;
  const m = meshRoadY(x, z, refY);
  if (q && q.sd > -1.5) return m === null ? q.y : q.y + (m - q.y) * Math.min(1, -q.sd / 1.5);
  return m;
}

function meshRoadY(x, z, refY) {
  const ys = [];
  for (const [dx, dz] of ROAD_SAMPLES) {
    const y = cellY(x + dx, z + dz, refY);
    if (y !== null) ys.push(y);
  }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor((ys.length - 1) * 0.25)];
}

/**
 * Top-down probe of a 4 m patch. Open road is flat; a tree canopy or roof edge is not, so
 * `spread` tells a usable spawn point from the top of a tree.
 */
function surfaceAt(x, z, topY) {
  let min = Infinity, max = -Infinity, centre = null, leaf = true;
  for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const hit = rayGround(x + dx, z + dz, topY, 700);
    if (!hit) return null;
    if (!centre) centre = hit.point.y;
    leaf = leaf && hit.object.userData.entry.leaf;
    min = Math.min(min, hit.point.y);
    max = Math.max(max, hit.point.y);
  }
  return { y: centre, spread: max - min, leaf };
}
window.__roads = { roads, ground, trees, rayGround, wallHit, roadY, surfaceAt }; // for tests and the console

// --- state ------------------------------------------------------------------
const keys = new Set();
const player = { pos: new THREE.Vector3(), vy: 0, heading: 0, grounded: true, mesh: null, speed: 0 };
const car = { pos: new THREE.Vector3(), heading: 0, speed: 0, mesh: null, vehicle: null };
const cam = { yaw: 0, pitch: 0.24, lastMouse: 0 };
const world = { tiles: new Map(), signature: '', streets: [], mapBase: null, mapOrigin: null };
let mode = 'foot';
let ready = false;
let travel = null; // { name, target: Vector3, since, snapped }
let spawn = null;
let models = null;

addEventListener('keydown', (e) => {
  if (e.repeat || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (e.code === 'KeyF') toggleCar();
  if (e.code === 'KeyR' && spawn) reset();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// The camera follows the mouse straight away. Clicking captures the pointer so it can turn without
// hitting the edge of the window; Esc releases it.
const capture = () => { if (ready && document.pointerLockElement !== $('view')) $('view').requestPointerLock?.(); };
$('view').addEventListener('click', capture);
$('capture').addEventListener('click', capture);
document.addEventListener('pointerlockchange', () => {
  $('capture').style.display = document.pointerLockElement === $('view') || !ready ? 'none' : 'block';
});
addEventListener('mousemove', (e) => {
  if (!ready || e.target.closest?.('#help')) return;
  // Ignore the jump some browsers report on the first event after capture.
  if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
  cam.yaw -= e.movementX * 0.0026;
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + e.movementY * 0.0022, -0.3, 1.25);
  cam.lastMouse = performance.now();
});

const axis = (pos, neg) => (keys.has(pos[0]) || keys.has(pos[1]) ? 1 : 0) - (keys.has(neg[0]) || keys.has(neg[1]) ? 1 : 0);
const focusPos = () => (travel ? travel.target : mode === 'car' ? car.pos : player.pos);

function reset() {
  mode = 'foot';
  player.mesh.visible = true;
  player.pos.copy(spawn.player);
  player.heading = spawn.heading;
  player.vy = 0;
  cam.yaw = spawn.heading;
  placeCar(spawn.car, spawn.heading);
}

function toggleCar() {
  if (!ready) return;
  if (mode === 'foot') {
    if (player.pos.distanceTo(car.pos) > 5) return;
    mode = 'car';
    player.mesh.visible = false;
  } else if (Math.abs(car.speed) < 4) {
    // Step out on the driver's side (left), else the right, else behind: the first spot that is clear
    // and has ground within a metre of the car's. Otherwise stand on the road beside the door.
    const f = forwardOf(car.heading);
    const left = new THREE.Vector3(f.z, 0, -f.x);
    const from = car.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
    const spots = [[left, 2.0], [left.clone().negate(), 2.0], [f.clone().negate(), 3.6]];
    let at = null;
    for (const [dir, d] of spots) {
      if (wallHit(from, dir, d + 0.6)) continue;
      const p = car.pos.clone().addScaledVector(dir, d);
      const y = roads.groundAt(p.x, p.z, car.pos.y + 1.5) ?? rayGround(p.x, p.z, car.pos.y + 1.5, 4)?.point.y;
      if (y !== undefined && y !== null && Math.abs(y - car.pos.y) < 1) { at = p.setY(y); break; }
    }
    player.pos.copy(at || car.pos.clone().addScaledVector(left, 1.6));
    player.heading = car.heading;
    player.vy = 0;
    player.mesh.visible = true;
    mode = 'foot'; // an undriven car gets the handbrake and stops itself
  }
}

// --- vector tiles: streets, lane graph, minimap -----------------------------
function updateTiles() {
  const f = focusPos();
  roads.tick(f, travel ? 6 : 1.5);
  ground.tick(f, travel ? 3 : 0.8);
  trees.tick(f);
  const ix = Math.floor(f.x / TILE_SIZE), iy = Math.floor(-f.z / TILE_SIZE);
  const names = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const name = tileName((ix + dx) * TILE_SIZE, (iy + dy) * TILE_SIZE);
      names.push(name);
      if (world.tiles.has(name)) continue;
      world.tiles.set(name, null);
      fetch(`/citytiles/${name}/tile.json`)
        .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : { empty: true }))
        .catch(() => ({ empty: true }))
        .then((doc) => world.tiles.set(name, doc));
    }
  }
  const loaded = names.filter((n) => world.tiles.get(n));
  const signature = loaded.join('|');
  if (signature === world.signature) return;
  world.signature = signature;
  for (const name of [...world.tiles.keys()]) if (!names.includes(name) && world.tiles.get(name)) world.tiles.delete(name);
  const docs = loaded.map((n) => world.tiles.get(n)).filter((d) => !d.empty);
  world.streets = [];
  for (const doc of docs) {
    for (const r of doc.roads) {
      const step = Math.max(1, Math.floor(r.centerline.length / 8));
      for (let i = 0; i < r.centerline.length; i += step) {
        world.streets.push({ x: r.centerline[i][0], z: -r.centerline[i][1], name: r.name, drive: r.car_access === 'yes' && r.class !== 'service', i, road: r });
      }
    }
  }
  roads.rebuild(docs);
  drawMapBase(docs, ix - 1, iy - 1);
}

function drawMapBase(docs, ix0, iy0) {
  const size = 3 * TILE_SIZE;
  const base = world.mapBase || (world.mapBase = document.createElement('canvas'));
  base.width = base.height = size;
  world.mapOrigin = { x: ix0 * TILE_SIZE, north: (iy0 + 3) * TILE_SIZE };
  const c = base.getContext('2d');
  const px = (x) => x - world.mapOrigin.x;
  const py = (north) => world.mapOrigin.north - north;
  const path = (rings) => { c.beginPath(); for (const ring of rings) ring.forEach(([x, y], i) => (i ? c.lineTo(px(x), py(y)) : c.moveTo(px(x), py(y)))); };
  c.fillStyle = '#1b222b';
  c.fillRect(0, 0, size, size);
  for (const doc of docs) {
    for (const a of doc.areas) {
      const water = a.kind.includes('water') || a.kind.includes('riverbank');
      const green = /park|wood|forest|grass|garden|meadow|cemetery/.test(a.kind);
      if (!water && !green) continue;
      c.fillStyle = water ? '#2f6fa3' : '#27402c';
      path(a.polygon);
      c.fill('evenodd');
    }
  }
  c.fillStyle = 'rgba(255,255,255,.2)';
  for (const doc of docs) for (const b of doc.buildings) { path(b.footprint); c.fill('evenodd'); }
  c.lineCap = c.lineJoin = 'round';
  // Footpaths thin and dashed under the streets; streets from the lane graph, which has whole polylines.
  c.strokeStyle = '#6f7c70';
  c.lineWidth = 1.5;
  c.setLineDash([3, 3]);
  for (const doc of docs) for (const p of doc.paths || []) { path([p.centerline]); c.stroke(); }
  c.setLineDash([]);
  const minor = new Set(['service', 'living_street', 'pedestrian', 'track']);
  for (const pass of [0, 1]) {
    for (const doc of docs) {
      for (const seg of doc.lanegraph?.segments || []) {
        if (minor.has(seg.class) !== (pass === 0)) continue;
        c.strokeStyle = pass === 0 ? '#9ba1a8' : /primary|secondary|trunk|motorway/.test(seg.class) ? '#f3dc9a' : '#e8e8e8';
        c.lineWidth = Math.max(2, seg.width_m * (pass === 0 ? 0.7 : 1));
        path([seg.points]);
        c.stroke();
      }
    }
  }
}

// --- travel -----------------------------------------------------------------
function travelTo(index) {
  const [name, lon, lat, street, at] = PLACES[index];
  const [east, north] = at || lonLatToLocal(lon, lat);
  travel = { name, street, at, started: performance.now(), target: new THREE.Vector3(east, 0, -north), since: performance.now(), snapped: false };
  ready = false;
  $('capture').style.display = 'none';
  $('place').value = String(index);
  $('loading').style.display = 'block';
  history.replaceState(null, '', `?place=${index}`);
}

function updateTravel() {
  const t = travel.target;
  camera.position.set(t.x + 40, t.y + 170, t.z + 150);
  camera.lookAt(t.x, t.y, t.z);
  $('loading').textContent = `Loading ${travel.name}… ${stream.stats.loading} mesh parts to go`;
  // Hold the start until everything around the spawn is at full detail (or a minute has passed).
  if ((stream.stats.shown === 0 || stream.stats.nearLoading > 0) && performance.now() - travel.started < 60000) return;

  if (travel.at && !travel.snapped) {
    // Pinned spawn: no street search, just wait for the ground under it.
    Object.assign(travel, { snapped: true, placed: true, options: [], heading: travel.at[2] });
  }
  if (!travel.snapped) {
    if (world.tiles.size < 9 || [...world.tiles.values()].some((doc) => !doc)) return;
    updateTiles(); // make sure the street list reflects every tile that just arrived
    // Start on the nearest ordinary street.
    const named = travel.street && world.streets.some((s) => s.drive && s.name === travel.street);
    const dist2 = (s) => (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
    travel.options = world.streets.filter((s) => s.drive && (!named || s.name === travel.street))
      .sort((a, b) => dist2(a) - dist2(b)).slice(0, 14);
    // Centre the loading view on the street itself so its mesh is what streams in first.
    if (travel.options[0]) t.set(travel.options[0].x, t.y, travel.options[0].z);
    travel.snapped = true;
  }

  // Wait for full detail at the nearest street point, then take the nearest one that is open road.
  const first = travel.options[0];
  if (first && !travel.placed) {
    const probeHere = surfaceAt(first.x, first.z, 500);
    if (probeHere) t.set(first.x, probeHere.y, first.z);
    if (!probeHere || (!probeHere.leaf && performance.now() - travel.since < 25000)) return;
    let best = first, bestSpread = Infinity;
    for (const s of travel.options) {
      const p = surfaceAt(s.x, s.z, 500);
      if (!p) continue;
      if (p.spread < bestSpread) { bestSpread = p.spread; best = s; }
      if (p.spread < 0.35) break;
    }
    {
      const line = best.road.centerline;
      const i = THREE.MathUtils.clamp(best.i, 1, line.length - 1);
      travel.heading = Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]);
      const f = forwardOf(travel.heading);
      const right = new THREE.Vector3(-f.z, 0, f.x);
      t.set(best.x, t.y, best.z).addScaledVector(right, best.road.oneway ? 0 : best.road.lane_width_m * 0.5);
    }
    travel.placed = true;
    travel.since = performance.now();
  }
  travel.heading ??= 0;

  const hit = rayGround(t.x, t.z, 500, 700);
  if (hit) t.y = hit.point.y;
  const waited = performance.now() - travel.since;
  if (!hit || (!hit.object.userData.entry.leaf && waited < 25000)) return;

  const f = forwardOf(travel.heading);
  const right = new THREE.Vector3(-f.z, 0, f.x);
  const carPos = t.clone();
  const playerPos = t.clone().addScaledVector(right, -2.4).addScaledVector(f, -0.5);
  playerPos.y = rayGround(playerPos.x, playerPos.z, t.y + 2.5)?.point.y ?? t.y;
  spawn = { heading: travel.heading, car: carPos, player: playerPos };
  travel = null;
  ready = true;
  reset();
  $('loading').style.display = 'none';
  $('capture').style.display = document.pointerLockElement === $('view') ? 'none' : 'block';
}

// --- on foot ----------------------------------------------------------------
function updatePlayer(dt) {
  const fwd = axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
  const strafe = axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
  const camF = forwardOf(cam.yaw);
  const camR = new THREE.Vector3(-camF.z, 0, camF.x);
  const move = camF.multiplyScalar(fwd).addScaledVector(camR, strafe);
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = move.lengthSq() > 0 ? (run ? 5.5 : 1.9) : 0;
  let moved = 0;

  if (speed > 0) {
    move.normalize();
    let dh = Math.atan2(-move.z, move.x) - player.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    player.heading += dh * Math.min(1, dt * 12);
    const step = move.clone().multiplyScalar(speed * dt);
    const chest = player.pos.clone().add(new THREE.Vector3(0, 1.1, 0));
    const hit = wallHit(chest, move, 0.4 + step.length());
    if (hit) {
      // Slide along the wall instead of stopping dead.
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).setY(0).normalize();
      if (n.dot(move) > 0) n.negate();
      step.addScaledVector(n, -step.dot(n));
      if (step.lengthSq() > 1e-8 && wallHit(chest, step.clone().normalize(), 0.4 + step.length())) step.set(0, 0, 0);
    }
    const next = player.pos.clone().add(step);
    const g = rayGround(next.x, next.z, player.pos.y + 1.2);
    // Refuse steps onto anything taller than a kerb while standing on the ground.
    if (!g || !player.grounded || g.point.y - player.pos.y < 0.65) {
      player.pos.x = next.x;
      player.pos.z = next.z;
      moved = step.length() / dt;
    }
  }
  player.speed = moved;

  if (player.grounded && keys.has('Space')) {
    player.vy = 5.0;
    player.grounded = false;
  }
  player.vy -= 14 * dt;
  player.pos.y += player.vy * dt;
  // Ground below the feet, or just above them if he has sunk into a refining mesh; never a canopy or roof
  // far overhead, which is all a long upward probe finds over a hole in the survey.
  const g = rayGround(player.pos.x, player.pos.z, player.pos.y + 1.2) ?? rayGround(player.pos.x, player.pos.z, player.pos.y + 2, 32);
  if (g && (player.pos.y <= g.point.y || (player.grounded && player.pos.y - g.point.y < 0.6))) {
    player.pos.y = g.point.y;
    player.vy = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
    if (!g) { player.vy = 0; } // nothing loaded below yet: hover rather than fall through the world
  }
  player.mesh.position.copy(player.pos);
  player.mesh.rotation.y = player.heading;
  player.mesh.userData.animate(player.speed, dt, player.grounded);
}

// --- vehicle ----------------------------------------------------------------
// Physics live in vehicle.js; it reaches the world only through these two queries, so the
// road-height and wall code here can change without touching the car model.
const wallFrom = new THREE.Vector3(), wallDir = new THREE.Vector3(), wallN = new THREE.Vector3();
function wallRay(ox, oy, oz, dx, dz, far) {
  const hit = wallHit(wallFrom.set(ox, oy, oz), wallDir.set(dx, 0, dz), far);
  if (!hit) return null;
  const n = hit.face ? wallN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld) : wallN.set(0, 1, 0);
  const len = Math.hypot(n.x, n.z);
  // A near-horizontal face (a sloped roof, a kerb top) gives no useful normal: treat it as head-on.
  return len < 0.3 ? { distance: hit.distance, nx: -dx, nz: -dz } : { distance: hit.distance, nx: n.x / len, nz: n.z / len };
}
// Low-quantile road height; a long probe only when nothing is near (driving off a ledge).
const groundY = (x, z, refY) => roadY(x, z, refY) ?? rayGround(x, z, refY + 1.6, 40)?.point.y ?? null;

function placeCar(p, heading) {
  const hit = rayGround(p.x, p.z, p.y + 300, 700);
  car.vehicle.reset(p.x, hit ? hit.point.y : p.y, p.z, heading);
  syncCar();
}

function updateCar(dt, driven) {
  car.vehicle.update(dt, driven
    ? { drive: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']), steer: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']), handbrake: keys.has('Space') }
    : { handbrake: true });
  syncCar();
}

const basis = new THREE.Matrix4(), bf = new THREE.Vector3(), bu = new THREE.Vector3(), br = new THREE.Vector3();
function syncCar() {
  const v = car.vehicle, m = car.mesh;
  car.heading = v.heading;
  car.speed = v.speed;
  m.position.copy(car.pos);
  m.quaternion.setFromRotationMatrix(basis.makeBasis(bf.copy(v.forward), bu.copy(v.up), br.copy(v.right)));
  m.userData.wheels.forEach((w, i) => {
    w.rotation.x = -v.wheelSpin[i]; // axle is model X, nose is -Z: rolling forward is negative about X
    w.rotation.y = i < 2 ? v.wheelSteer[i] : 0;
    w.position.y = w.userData.restY + v.wheelLift[i];
  });
}

// --- camera, HUD, minimap ---------------------------------------------------
const chase = { dist: 3.6, fov: 60, y: 0, vel: new THREE.Vector3(), lag: new THREE.Vector3(), shake: 0, live: false };
const camTarget = new THREE.Vector3(), camTmp = new THREE.Vector3();
function updateCamera(dt) {
  const k = (rate) => 1 - Math.exp(-rate * dt); // frame-rate independent smoothing
  let dist = 3.6, fov = 60;
  if (mode === 'car') {
    const v = car.vehicle, spd = Math.hypot(v.vx, v.vz), t = THREE.MathUtils.clamp(spd / 50, 0, 1);
    chase.y = chase.live ? chase.y + (car.pos.y - chase.y) * k(6) : car.pos.y; // filters mesh bumps
    // Trails back under acceleration and creeps closer under braking; swings a little in turns.
    chase.vel.lerp(camTmp.set(v.vx, 0, v.vz), k(3));
    chase.lag.set(v.vx, 0, v.vz).sub(chase.vel).multiplyScalar(-0.09).clampLength(0, 1.6);
    camTarget.set(car.pos.x, chase.y + 1.35, car.pos.z).add(chase.lag);
    if (performance.now() - cam.lastMouse > 1500 && spd > 1) {
      // Along the heading, swung part way toward the travel direction so drifts read; reversing looks forward.
      let slide = Math.atan2(-v.vz, v.vx) - v.heading;
      slide = Math.atan2(Math.sin(slide), Math.cos(slide));
      const d = (v.speed > 0 ? v.heading + slide * 0.45 : v.heading) - cam.yaw;
      cam.yaw += Math.atan2(Math.sin(d), Math.cos(d)) * k(2 + 2 * t);
      cam.pitch += (0.2 - 0.05 * t - cam.pitch) * k(1.5);
    }
    dist = 6.2 + 2.6 * t;
    fov = 60 + 14 * t * t;
    // Impacts kick the camera and decay; a faint buzz stays above ~110 km/h.
    chase.shake = Math.max(chase.shake * Math.exp(-dt * 6), Math.min(0.35, v.impact * 0.025), (t - 0.6) * 0.08);
    v.impact = 0;
    chase.live = true;
  } else {
    chase.live = false;
    chase.shake = 0;
    camTarget.copy(player.pos).y += 1.5;
  }
  const back = forwardOf(cam.yaw).multiplyScalar(-Math.cos(cam.pitch));
  back.y = Math.sin(cam.pitch);
  chase.dist += (dist - chase.dist) * k(2.5);
  let d = chase.dist;
  const hit = wallHit(camTarget, back, d);
  if (hit) d = Math.max(0.7, hit.distance - 0.3); // pull in at once, ease back out through chase.dist
  chase.dist = Math.min(chase.dist, d + 0.5);
  camera.position.copy(camTarget).addScaledVector(back, d);
  if (chase.shake > 0.002) camera.position.add(camTmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(chase.shake));
  camera.lookAt(camTarget);
  chase.fov += (fov - chase.fov) * k(3);
  if (Math.abs(camera.fov - chase.fov) > 0.01) { camera.fov = chase.fov; camera.updateProjectionMatrix(); }
}

let hudTimer = 0;
function updateHud(dt) {
  const p = mode === 'car' ? car.pos : player.pos;
  $('speed').firstChild.nodeValue = Math.round(Math.abs(mode === 'car' ? car.speed : player.speed) * 3.6);
  const v = car.vehicle;
  $('speed').lastChild.textContent = mode === 'car' ? `km/h · ${v.gear < 0 ? 'R' : v.gear} · ${Math.round(v.rpm / 100) * 100} rpm` : 'km/h';
  const near = mode === 'foot' && player.pos.distanceTo(car.pos) < 5;
  $('prompt').style.display = near ? 'block' : 'none';
  if (near) $('prompt').textContent = 'Press F to drive';
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.4;
  let best = null, bestD = 70 * 70;
  for (const s of world.streets) {
    if (!s.name) continue;
    const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = s.name; }
  }
  $('street').textContent = best || '—';
  $('coords').textContent = `LKS-94  E ${(ORIGIN.e + p.x).toFixed(1)}  N ${(ORIGIN.n - p.z).toFixed(1)}  H ${(ORIGIN.h + p.y).toFixed(1)} m`;
}

const mapCtx = $('map').getContext('2d');
function drawMap() {
  if (!world.mapBase) return;
  const p = mode === 'car' ? car.pos : player.pos;
  const view = 420, size = 400, scale = size / view;
  const mx = (x) => (x - p.x) * scale + size / 2;
  const mz = (z) => (z - p.z) * scale + size / 2;
  mapCtx.fillStyle = '#1b222b';
  mapCtx.fillRect(0, 0, size, size);
  mapCtx.drawImage(world.mapBase, mx(world.mapOrigin.x), mz(-world.mapOrigin.north), world.mapBase.width * scale, world.mapBase.height * scale);
  mapCtx.fillStyle = '#e03a2f';
  mapCtx.fillRect(mx(car.pos.x) - 4, mz(car.pos.z) - 4, 8, 8);
  mapCtx.save();
  mapCtx.translate(size / 2, size / 2);
  mapCtx.rotate(-(mode === 'car' ? car.heading : player.heading));
  mapCtx.fillStyle = '#4de08a';
  mapCtx.beginPath();
  mapCtx.moveTo(12, 0); mapCtx.lineTo(-8, -8); mapCtx.lineTo(-8, 8);
  mapCtx.fill();
  mapCtx.restore();
}

// --- start ------------------------------------------------------------------
async function start() {
  const gltf = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));
  models = await loadModels(gltf);
  player.mesh = models.makePerson();
  car.mesh = models.makeCar(0xa01414);
  scene.add(player.mesh, car.mesh);
  car.vehicle = new Vehicle(FERRARI_458, { groundY, wallRay, pos: car.pos });
  PLACES.forEach(([name], i) => $('place').add(new Option(name, String(i))));
  if (PLACES.length < 2) $('place').style.display = 'none';
  $('place').addEventListener('change', (e) => { travelTo(Number(e.target.value)); e.target.blur(); });
  const wanted = Number(new URLSearchParams(location.search).get('place'));
  travelTo(Number.isInteger(wanted) && PLACES[wanted] ? wanted : 0);
}

const clock = new THREE.Clock();
window.__vilnius = { player, car, cam, camera, stream, post, world, renderer, trees, freeCam: false, get travel() { return travel; }, get mode() { return mode; }, get ready() { return ready; }, fps: 0, simMs: 0, renderMs: 0 };
let frames = 0, fpsTime = 0, streamTimer = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t0 = performance.now();
  if (models) {
    updateTiles();
    if (travel) {
      updateTravel();
    } else if (ready) {
      if (mode === 'foot') updatePlayer(dt);
      updateCar(dt, mode === 'car');
      if (!window.__vilnius.freeCam) updateCamera(dt); // tests may fly the camera themselves
      updateHud(dt);
      drawMap();
    }
    streamTimer -= dt;
    if (streamTimer <= 0) {
      streamTimer = 0.12;
      camera.updateMatrixWorld();
      stream.pixelRatio = renderer.getPixelRatio();
      stream.update(camera, focusPos(), innerHeight, 0.12);
      $('stream').textContent = `${stream.stats.shown} mesh parts · ${(stream.stats.triangles / 1e6).toFixed(1)} M triangles${stream.stats.loading ? ` · loading ${stream.stats.loading}` : ''}`;
    }
  }
  const t1 = performance.now();
  camera.updateMatrixWorld();
  farCamera.position.copy(camera.position);
  farCamera.quaternion.copy(camera.quaternion);
  if (farCamera.fov !== camera.fov || farCamera.aspect !== camera.aspect) {
    Object.assign(farCamera, { fov: camera.fov, aspect: camera.aspect }).updateProjectionMatrix();
  }
  sky.position.copy(camera.position);
  trees.update(camera, performance.now() / 1000);
  stream.flush(renderer);
  stream.sample(post.render());
  const stats = window.__vilnius;
  stats.simMs += (t1 - t0 - stats.simMs) * 0.05;
  stats.renderMs += (performance.now() - t1 - stats.renderMs) * 0.05;
  frames++;
  fpsTime += dt;
  if (fpsTime >= 1) { window.__vilnius.fps = Math.round(frames / fpsTime); frames = 0; fpsTime = 0; }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  $('error').style.display = 'block';
  $('error').textContent = `Could not start: ${err.message}`;
});
frame();
