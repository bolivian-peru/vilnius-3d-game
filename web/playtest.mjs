// Headless playtest: node playtest.mjs <screenshot dir> [place index] [destination east,north]
// Loads the game, walks, runs, drives through the start roundabout and along the lane graph to the
// destination (default: the far end of Vasaros g.), tests braking / steering / handbrake, shoots
// horizon views, and fails on console errors, NPC cars, a blocked car or a slow frame budget.
import { chromium } from 'playwright';
import fs from 'fs';

const out = process.argv[2] || '.';
const place = process.argv[3] || '0';
const dest = (process.argv[4] || '2385.6,21.1').split(',').map(Number);
const EXE = process.env.CHROME_EXE || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: fs.existsSync(EXE) ? EXE : undefined, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [], fails = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) fails.push(what); };
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: `${out}/p${place}_${name}.png` });
const snap = () => page.evaluate(() => {
  const v = window.__vilnius, r = (a) => a.toArray().map((n) => +n.toFixed(1)), s = v.stream.stats;
  return { mode: v.mode, fps: v.fps, sim: +v.simMs.toFixed(2), render: +v.renderMs.toFixed(2), player: r(v.player.pos), car: r(v.car.pos), kmh: Math.round(v.car.speed * 3.6), gear: v.car.vehicle.gear, rpm: Math.round(v.car.vehicle.rpm),
    stream: { shown: s.shown, loading: s.loading, horizon: s.horizon, horizonLoading: s.horizonLoading, gpuMB: s.gpuMB, horizonMB: s.horizonMB, budgetMB: s.budgetMB, quality: s.quality, texScale: s.texScale, shownMB: s.shownMB, tris: +(s.triangles / 1e6).toFixed(1) },
    street: document.getElementById('street').textContent };
});

const t0 = Date.now();
await page.goto('http://localhost:5180/?place=' + place + (process.env.QUERY ? '&' + process.env.QUERY : ''));
await page.waitForFunction(() => window.__vilnius?.ready, null, { timeout: 150000 });
console.log('ready after', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForFunction(() => window.__vilnius.stream.stats.loading === 0, null, { timeout: 30000 }).catch(() => {});
await wait(1500);
if (process.env.PROFILE) await page.evaluate(() => {
  // PROFILE=1: slowest call of each main-thread stage, printed at the end.
  const v = window.__vilnius, R = window.__roads, prof = (window.__prof = {});
  const wrap = (obj, name, label) => { const f = obj[name]; obj[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { const d = performance.now() - t, p = (prof[label] ||= { max: 0, over8: 0, n: 0 }); p.n++; p.max = Math.max(p.max, d); if (d > 8) p.over8++; } }; };
  wrap(R.roads, 'rebuild', 'roads.rebuild'); wrap(R.roads, 'update', 'roads.update'); wrap(R.roads, 'survey', 'roads.survey'); wrap(R.roads, 'updateMask', 'roads.updateMask');
  wrap(R.ground, 'tick', 'ground.tick'); wrap(R.ground, 'build', 'ground.build'); wrap(v.stream, 'update', 'stream.update'); wrap(v.stream, 'flush', 'stream.flush'); wrap(v.post, 'render', 'post.render');
  wrap(v.car.vehicle, 'update', 'vehicle.update');
});
const start = await snap();
console.log('start', JSON.stringify(start));
await shot('1_start');

// Frame-time recorder and key helpers, in the page so they keep pace with the game.
await page.evaluate(() => {
  const ft = (window.__ft = []);
  let last = performance.now();
  const tick = (t) => { ft.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__key = (code, down) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
});
const frameStats = () => page.evaluate(() => {
  const a = window.__ft.splice(0).sort((x, y) => x - y), q = (p) => +a[Math.floor((a.length - 1) * p)].toFixed(1);
  return { frames: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), over33: a.filter((x) => x > 33).length };
});

// --- NPC traffic is gone: exactly one wheeled car in the scene.
const cars = await page.evaluate(() => { let n = 0; window.__vilnius.car.mesh.parent.traverse((o) => { if (o.userData?.wheels) n++; }); return 'traffic' in window.__vilnius ? -1 : n; });
check(cars === 1, `one car in the scene, no NPC traffic (found ${cars})`);

// --- On foot: walk, then run; the man moves, animates and keeps his feet on the ground.
const bones = () => page.evaluate(() => { const q = []; window.__vilnius.player.mesh.traverse((o) => { if (o.isBone) q.push(...o.quaternion.toArray()); }); return q; });
const b0 = await bones(), p0 = (await snap()).player;
await page.keyboard.down('KeyS'); await wait(1800);
const walking = await page.evaluate(() => window.__vilnius.player.speed);
await shot('2_walk');
await page.keyboard.down('ShiftLeft'); await wait(1200);
const running = await page.evaluate(() => window.__vilnius.player.speed);
const b1 = await bones();
await shot('3_run');
await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyS'); await wait(600);
const p1 = (await snap()).player;
const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
const pose = b0.reduce((s, x, i) => s + Math.abs(x - b1[i]), 0);
const feet = await page.evaluate(() => { const { rayGround } = window.__roads, p = window.__vilnius.player.pos; const g = rayGround(p.x, p.z, p.y + 1.2); return g ? +(p.y - g.point.y).toFixed(2) : null; });
console.log('foot', { walking: +walking.toFixed(2), running: +running.toFixed(2), moved: +moved.toFixed(1), pose: +pose.toFixed(2), feetAboveGround: feet });
check(walking > 1.5 && running > 4.5 && moved > 4, 'player walks and runs');
check(pose > 0.5 && b0.length > 40, `skinned man animates (${b0.length / 4} bones)`);
check(feet !== null && Math.abs(feet) < 0.15, 'feet on the ground');

// --- Turning on the spot swaps in detail that is already loaded rather than refilling the view.
await page.waitForFunction(() => window.__vilnius.stream.stats.loading < 20, null, { timeout: 30000 }).catch(() => {});
await wait(1500);
const turn = await page.evaluate(async () => {
  const v = window.__vilnius, before = { ...v.stream.stats };
  v.cam.lastMouse = performance.now() + 1e9;
  v.cam.yaw += Math.PI;
  await new Promise((r) => setTimeout(r, 400));
  const after = { ...v.stream.stats };
  return { before: { shown: before.shown, tris: +(before.triangles / 1e6).toFixed(2), loading: before.loading }, after: { shown: after.shown, tris: +(after.triangles / 1e6).toFixed(2), loading: after.loading } };
});
console.log('turn around', JSON.stringify(turn));
check(turn.after.tris > turn.before.tris * 0.75, `turning around keeps detail (${turn.before.tris} -> ${turn.after.tris} M triangles)`);

// --- Horizon views at street level, then a free camera 120 m up looking out over the city.
await page.evaluate(() => { const c = window.__vilnius.cam; c.pitch = -0.12; c.lastMouse = performance.now() + 1e9; });
for (const [i, yaw] of [0, 1.57, 3.14, 4.71].entries()) {
  await page.evaluate((y) => { window.__vilnius.cam.yaw = y; }, yaw);
  await wait(1200);
  await shot(`4_horizon_${i}`);
}
await page.evaluate(() => { const c = window.__vilnius.cam; c.pitch = 0.24; c.lastMouse = 0; });
for (const [i, yaw] of [0.8, 3.9].entries()) {
  await page.evaluate((yaw) => {
    const v = window.__vilnius, p = v.player.pos;
    v.freeCam = true;
    v.camera.position.set(p.x, p.y + 120, p.z);
    v.camera.lookAt(p.x + Math.cos(yaw) * 1000, p.y - 60, p.z - Math.sin(yaw) * 1000);
  }, yaw);
  await wait(6000);
  await shot(`5_aerial_${i}`);
}
await page.evaluate(() => { window.__vilnius.freeCam = false; });
const aerial = await snap();
console.log('aerial', JSON.stringify(aerial.stream));
check(aerial.stream.horizon > 300, `horizon layer loaded (${aerial.stream.horizon} coarse nodes)`);

// --- Into the car.
await page.evaluate(() => { const v = window.__vilnius; v.player.pos.copy(v.car.pos); v.player.pos.x += 2; });
await wait(300);
await page.keyboard.press('KeyF');
await wait(300);
check((await snap()).mode === 'car', 'F enters the car');

// --- Drive the shortest lane-graph route from the car to the destination with an in-page autopilot
// that only presses keys (W/S/A/D), like a player.
const route = await page.evaluate((dest) => {
  const v = window.__vilnius, key = (p) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
  const adj = new Map(), at = new Map();
  const link = (pts, name) => { const a = key(pts[0]), b = key(pts.at(-1)); at.set(a, pts[0]); at.set(b, pts.at(-1)); if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, pts, name }); };
  for (const doc of v.world.tiles.values()) for (const s of doc?.lanegraph?.segments || []) {
    if (s.car_access !== 'yes' || s.tunnel) continue;
    link(s.points, s.name);
    if (!s.oneway) link([...s.points].reverse(), s.name);
  }
  const len = (pts) => pts.reduce((L, p, i) => (i ? L + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  // Start on the directed lane-graph edge under the car (aligned with its heading), at its far end.
  const c = v.car, cf = [Math.cos(c.heading), Math.sin(c.heading)], ce = [c.pos.x, -c.pos.z];
  let src = null, lead = null, best = 1e9, dst = null, bestD = 1e9;
  for (const [k, edges] of adj) for (const e of edges) for (let i = 1; i < e.pts.length; i++) {
    const [a, b] = [e.pts[i - 1], e.pts[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const t = Math.max(0, Math.min(L, (ce[0] - a[0]) * ux + (ce[1] - a[1]) * uy));
    const d = Math.hypot(a[0] + ux * t - ce[0], a[1] + uy * t - ce[1]);
    if (ux * cf[0] + uy * cf[1] > 0.7 && d < best) { best = d; src = e.to; lead = e.pts.slice(i); }
  }
  for (const [k, p] of at) { const dd = Math.hypot(p[0] - dest[0], p[1] - dest[1]); if (dd < bestD) { bestD = dd; dst = k; } }
  const dist = new Map([[src, 0]]), prev = new Map(), open = new Set([src]);
  while (open.size) {
    let u = null; for (const k of open) if (u === null || dist.get(k) < dist.get(u)) u = k;
    open.delete(u);
    if (u === dst) break;
    for (const e of adj.get(u) || []) {
      const d = dist.get(u) + len(e.pts);
      if (d < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, d); prev.set(e.to, [u, e]); open.add(e.to); }
    }
  }
  if (!prev.has(dst)) return null;
  const parts = [], names = [];
  for (let k = dst; k !== src; k = prev.get(k)[0]) { parts.unshift(prev.get(k)[1].pts); names.unshift(prev.get(k)[1].name); }
  const pts = [ce, ...lead.slice(0, -1), ...parts.flatMap((p, i) => (i ? p.slice(1) : p))];
  // Resample every 2 m.
  const dense = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s < L; s += 2) dense.push([a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L]);
  }
  dense.push(pts.at(-1));
  return { pts: dense, length: Math.round(dist.get(dst)), names: [...new Set(names.filter(Boolean))] };
}, dest);
check(!!route, 'lane-graph route to the destination exists');
console.log('route', route && { length: route.length, names: route.names });

await page.evaluate((pts) => {
  const v = window.__vilnius, held = new Set(), A = (window.__auto = { idx: 0, on: true, off: 0, maxOff: 0, done: false });
  const press = (code, on) => { if (on !== held.has(code)) { window.__key(code, on); on ? held.add(code) : held.delete(code); } };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const tick = () => {
    if (!A.on) { for (const k of [...held]) press(k, false); return; }
    const e = v.car.pos.x, n = -v.car.pos.z;
    let bi = A.idx, bd = 1e9;
    for (let i = A.idx; i < Math.min(pts.length, A.idx + 40); i++) { const d = Math.hypot(pts[i][0] - e, pts[i][1] - n); if (d < bd) { bd = d; bi = i; } }
    A.idx = bi; A.off = bd; A.maxOff = Math.max(A.maxOff, bd);
    const kmh = v.car.speed * 3.6, look = Math.round((6 + Math.abs(v.car.speed) * 0.5) / 2);
    const t = pts[Math.min(bi + look, pts.length - 1)];
    const dh = wrap(Math.atan2(t[1] - n, t[0] - e) - v.car.heading);
    // Slow for the sharpest bend within the next 40 m.
    let bend = 0;
    for (let i = bi; i < Math.min(bi + 20, pts.length - 3); i++) bend = Math.max(bend, Math.abs(wrap(Math.atan2(pts[i + 2][1] - pts[i + 1][1], pts[i + 2][0] - pts[i + 1][0]) - Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]))));
    const want = Math.max(22, 55 - bend * 160);
    press('KeyA', dh > 0.03); press('KeyD', dh < -0.03);
    press('KeyW', kmh < want - 2); press('KeyS', kmh > want + 6);
    if (bi >= pts.length - 3) { A.done = true; A.on = false; }
    requestAnimationFrame(tick);
  };
  tick();
}, route.pts);
await frameStats();
if (process.env.PROFILE) await page.evaluate(() => { for (const k in window.__prof) delete window.__prof[k]; });
const log = [];
let stuck = 0, blocked = null;
for (let i = 0; i < 1200; i++) {
  await wait(250);
  const s = await snap();
  const a = await page.evaluate(() => ({ idx: window.__auto.idx, off: +window.__auto.off.toFixed(1), done: window.__auto.done }));
  log.push({ ...s, ...a });
  if (i % 20 === 0) console.log('drive', JSON.stringify({ idx: `${a.idx}/${route.pts.length}`, kmh: s.kmh, off: a.off, street: s.street, fps: s.fps, sim: s.sim, render: s.render, stream: s.stream }));
  if (i % 24 === 8) await shot(`6_drive_${String(i).padStart(3, '0')}`);
  stuck = Math.abs(s.kmh) < 2 ? stuck + 1 : 0;
  if (stuck > 16) { blocked = s.car; break; }
  if (a.done) break;
}
const drive = await frameStats();
if (process.env.PROFILE) console.log('drive profile', JSON.stringify(await page.evaluate(() => window.__prof)));
const last = log.at(-1);
const town = log.filter((s) => s.kmh >= 35 && s.kmh <= 60).map((s) => s.gear).sort((a, b) => a - b);
const townGear = town[Math.floor(town.length / 2)] ?? 0;
const minQ = Math.min(...log.map((s) => s.stream.quality)), maxMB = Math.max(...log.map((s) => s.stream.gpuMB)), minTex = Math.min(...log.map((s) => s.stream.texScale));
console.log('drive gearbox', { samples35to60: town.length, medianGear: townGear }, 'quality', { start: start.stream.quality, min: minQ, end: last.stream.quality }, 'gpu', { maxMB, budgetMB: last.stream.budgetMB, horizonMB: last.stream.horizonMB, minTexScale: minTex });
check(town.length < 5 || townGear >= 2, `town speeds (35-60 km/h) above 1st gear (median ${townGear})`);
check(minQ >= 2.0, `detail quality held at 2.0 or more (start ${start.stream.quality}, min ${minQ}, end ${last.stream.quality})`);
check(maxMB <= last.stream.budgetMB * 1.03, `GPU memory within budget (max ${maxMB} of ${last.stream.budgetMB} MB, horizon included)`);
console.log('drive frames', JSON.stringify(drive), 'maxOff', await page.evaluate(() => window.__auto.maxOff.toFixed(1)));
check(!blocked && last.done, `drove ${route.length} m to the destination without being blocked${blocked ? ` (stuck at ${blocked})` : ''}`);
check(drive.p95 < 25, `drive frame time p95 ${drive.p95} ms`);
await shot('7_arrived');
fs.writeFileSync(`${out}/p${place}_drive.json`, JSON.stringify(log));

// --- Handling on the way back along the route: braking, steering and the handbrake.
await page.evaluate(() => { window.__auto.on = false; });
const dA = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const hold = async (keys, ms) => { for (const k of keys) await page.keyboard.down(k); await wait(ms); for (const k of keys) await page.keyboard.up(k); };
const state = () => page.evaluate(() => { const v = window.__vilnius.car.vehicle; return { kmh: v.speed * 3.6, heading: v.heading, x: v.pos.x, z: v.pos.z, gear: v.gear, rpm: v.rpm }; });
// Each test starts from rest on the straightest 90 m of the route.
let straight = 0, straightest = Infinity;
for (let i = 0; i + 45 < route.pts.length; i++) {
  const [p, q, r] = [route.pts[i], route.pts[i + 22], route.pts[i + 45]];
  const off = Math.abs(dA(Math.atan2(r[1] - q[1], r[0] - q[0]), Math.atan2(q[1] - p[1], q[0] - p[0])));
  if (off < straightest) { straightest = off; straight = i; }
}
const restart = async () => {
  await page.evaluate(([p, q]) => { const v = window.__vilnius, { roads } = window.__roads; v.car.vehicle.reset(p[0], roads.groundAt(p[0], -p[1], v.car.pos.y + 30) ?? v.car.pos.y, -p[1], Math.atan2(q[1] - p[1], q[0] - p[0])); v.cam.yaw = v.car.vehicle.heading; }, [route.pts[straight], route.pts[straight + 2]]);
  await wait(1200);
};
await restart();
const tb0 = Date.now();
await page.keyboard.down('KeyW');
await page.waitForFunction(() => window.__vilnius.car.vehicle.speed * 3.6 >= 60, null, { timeout: 8000 }).catch(() => {});
const zeroTo60 = (Date.now() - tb0) / 1000;
await page.keyboard.up('KeyW');
const b0s = await state(), tb = Date.now();
await page.keyboard.down('KeyS');
await page.waitForFunction(() => window.__vilnius.car.vehicle.speed < 0.5, null, { timeout: 8000 }).catch(() => {});
await page.keyboard.up('KeyS');
const b1s = await state();
const brakeDist = Math.hypot(b1s.x - b0s.x, b1s.z - b0s.z), brakeT = (Date.now() - tb) / 1000;
console.log('accel/brake', { zeroTo60s: zeroTo60, from: +b0s.kmh.toFixed(0), metres: +brakeDist.toFixed(1), seconds: brakeT, gear: b0s.gear, rpm: Math.round(b0s.rpm) });
check(zeroTo60 < 4.5, `0-60 km/h in ${zeroTo60} s`);
check(b0s.kmh > 50 && brakeDist < (b0s.kmh / 3.6) ** 2 / (2 * 6) + 3, 'brakes harder than 6 m/s²');
await restart();
await hold(['KeyW'], 2200);
const s0 = await state();
await hold(['KeyW', 'KeyA'], 900);
const s1 = await state();
const turnRate = dA(s1.heading, s0.heading) / 0.9;
console.log('steer', { kmh: +s0.kmh.toFixed(0), yawDegPerS: +(turnRate * 57.3).toFixed(0) });
check(turnRate > 0.2, 'steering left turns left');
await restart();
await hold(['KeyW'], 2600);
const h0 = await state();
await hold(['KeyD', 'Space'], 1200);
const h1 = await state();
await shot('8_handbrake');
console.log('handbrake', { from: +h0.kmh.toFixed(0), to: +h1.kmh.toFixed(0), turnDeg: +(dA(h0.heading, h1.heading) * 57.3).toFixed(0) });
check(h1.kmh < h0.kmh - 5 && dA(h0.heading, h1.heading) > 0.3, 'handbrake turn slows and rotates the car');
await page.keyboard.down('Space');
await page.waitForFunction(() => Math.abs(window.__vilnius.car.vehicle.speed) < 1, null, { timeout: 8000 }).catch(() => {});
await page.keyboard.up('Space');
await page.keyboard.press('KeyF'); await wait(600);
const exited = await snap();
check(exited.mode === 'foot', 'F leaves the car');
check(Math.abs(exited.player[1] - exited.car[1]) < 1.2, `steps out at street level (player y ${exited.player[1]}, car y ${exited.car[1]})`);
await shot('9_exit');

// --- A lost WebGL context drops the stream and it streams back in.
const lost = await page.evaluate(async () => {
  const v = window.__vilnius, ext = v.renderer.getContext().getExtension('WEBGL_lose_context');
  if (!ext) return null;
  ext.loseContext();
  await new Promise((r) => setTimeout(r, 800));
  ext.restoreContext();
  await new Promise((r) => setTimeout(r, 8000));
  return { shown: v.stream.stats.shown, gpuMB: v.stream.stats.gpuMB, lost: v.renderer.getContext().isContextLost() };
});
console.log('context loss', JSON.stringify(lost));
check(!lost || (!lost.lost && lost.shown > 50), 'recovers from a lost WebGL context');
await shot('10_restored');

console.log('final', JSON.stringify(await snap()));
if (process.env.PROFILE) console.log('profile', JSON.stringify(await page.evaluate(() => window.__prof)));
const unique = [...new Set(errors)];
check(unique.length === 0, `no console errors (${errors.length})`);
if (unique.length) console.log('errors', JSON.stringify(unique.slice(0, 8)));
console.log(fails.length ? `FAILED: ${fails.join('; ')}` : 'ALL PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);
