// Car physics: planar rigid body on four Pacejka tyres, a sprung body for heave/pitch/roll,
// an automatic gearbox and a wall bounce. No three.js dependency: the world is reached through
// two injected queries, so the model can be tuned headless.
//
// Frame (same as main.js): x = east, y = up, z = -north, heading counter-clockwise from +x,
// forward = (cos h, 0, -sin h), right = (sin h, 0, cos h). Body-local: lx forward, lz right.
// Wheel order everywhere: fl, fr, rl, rr (models.js makeCar userData.wheels).

const G = 9.81;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Ferrari-458-like; geometry measured from public/models/ferrari.glb (origin on the ground under the body centre). */
export const FERRARI_458 = {
  mass: 1500,
  yawInertia: 2550, // ~ m·a·b
  cgX: -0.38, // centre of gravity behind the model origin: 42/58 front/rear
  cgHeight: 0.44,
  wheels: [[1.155, -0.835], [1.155, 0.835], [-1.495, -0.823], [-1.495, 0.823]],
  wheelRadius: 0.358,
  rollShareFront: 0.56, // front share of lateral load transfer: >0.5 = stable, mild understeer
  // Tyres: Pacejka magic formula F = D sin(C atan(B a - E (B a - atan(B a)))), D = mu Fz.
  tyre: { B: 9.5, C: 1.65, E: 0.35, muFront: 1.0, muRear: 1.06, rearStiffness: 1.1, loadSens: 0.1, slideMu: 0.5 },
  lowSpeed: 2.5, // m/s floor in the slip-angle denominator: keeps standstill quiet
  // Engine: torque (Nm) at rpm; ~590 hp at 9000.
  torque: [[0, 260], [1000, 300], [2000, 380], [3000, 430], [4000, 480], [5000, 520], [6000, 540], [7000, 535], [8000, 510], [9000, 460]],
  idleRpm: 1000, redline: 9000, launchRpm: 4200, engineBrake: 75,
  gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69], reverseRatio: 2.9, finalDrive: 4.44, efficiency: 0.85,
  reverseRpmLimit: 3600, shiftTime: 0.16,
  tractionControl: 0.92, // drive force cap as a share of rear grip; 1 = off
  driftTime: 1.6, driftTraction: 0.82, driftStability: 0.3, // after a handbrake pull
  stability: 1.5, stabilityOver: 4, slideAllowance: 0.15, // 1/s, yaw-rate assist against understeer / oversteer; 0 = raw physics
  brakeForce: 17500, brakeFront: 0.62, abs: 0.95, // ABS keeps each tyre below this share of its grip
  dragCoef: 0.41, // 1/2 rho Cd A
  downforce: 0.12, // N per (m/s)^2
  rollingResistance: 0.013,
  // Steering: lock falls with speed; assist steers into a slide when the player lets go.
  maxLock: 0.6, lockSpeed: 11, minLock: 0.085, steerRate: 2.6, steerReturn: 5.0, countersteer: 0.55,
  // Sprung body (visual + tyre load): soft and floaty in the GTA IV way.
  heaveHz: 1.5, heaveDamping: 0.42, travel: 0.11, groundFilter: 25, // 1/s low-pass on the road height
  pitchPerG: 0.06, rollPerG: 0.09, bodyHz: 1.35, bodyDamping: 0.33, // radians of body angle per g
  // Walls.
  halfLength: 2.28, halfWidth: 0.98, rayHeight: 1.75, maxStep: 1.1, restitution: 0.22, wallFriction: 0.25, wallSpin: 0.5,
};

function torqueAt(curve, rpm) {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [r1, t1] = curve[i];
    if (rpm <= r1) {
      const [r0, t0] = curve[i - 1];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return curve[curve.length - 1][1];
}

const magic = ({ B, C, E }, a) => Math.sin(C * Math.atan(B * a - E * (B * a - Math.atan(B * a))));

export class Vehicle {
  /**
   * @param spec    tuning, e.g. FERRARI_458
   * @param groundY (x, z, refY) => height | null; smoothed road height near refY (main.js roadY)
   * @param wallRay (ox, oy, oz, dx, dz, far) => { distance, nx, nz } | null; horizontal ray against walls
   * @param pos     object with x, y, z to drive (e.g. a THREE.Vector3): the model origin, on the ground under the body centre
   */
  constructor(spec, { groundY, wallRay, pos = { x: 0, y: 0, z: 0 } }) {
    this.s = spec;
    this.groundY = groundY;
    this.wallRay = wallRay;
    this.pos = pos;
    this.forward = { x: 1, y: 0, z: 0 }; // body axes for the mesh basis
    this.up = { x: 0, y: 1, z: 0 };
    this.right = { x: 0, y: 0, z: 1 };
    this.wheelSteer = [0, 0, 0, 0];
    this.wheelSpin = [0, 0, 0, 0];
    this.wheelLift = [0, 0, 0, 0]; // suspension offset of each wheel, metres, + = pushed up into the arch
    this.reset(0, 0, 0, 0);
  }

  reset(x, y, z, heading) {
    Object.assign(this.pos, { x, y, z });
    this.heading = heading;
    this.vx = 0; this.vz = 0; // world planar velocity of the CG
    this.yawRate = 0;
    this.vy = 0;
    this.groundPrev = null;
    this.steer = 0;
    this.gear = 1;
    this.shift = 0;
    this.rpm = this.s.idleRpm;
    this.throttle = 0;
    this.demand = 0; // throttle averaged over about a second: what the gearbox shifts on
    this.shiftHold = 0;
    this.accX = 0; this.accZ = 0; // body-local acceleration, filtered (weight transfer + body motion)
    this.pitch = 0; this.pitchV = 0; this.roll = 0; this.rollV = 0;
    this.groundPitch = 0; this.groundRoll = 0;
    this.contact = 1;
    this.wheelspin = 0;
    this.drift = 0;
    this.slip = 0; // 0..1 drift intensity, for tyre smoke and sound
    this.impact = 0; // closing speed of the last wall hit, m/s; main.js may read and clear it
    this.wheelSteer.fill(0);
    this.wheelLift.fill(0);
    this.snap = true;
  }

  /** Signed forward speed, m/s. */
  get speed() { return this.vx * Math.cos(this.heading) - this.vz * Math.sin(this.heading); }
  get kmh() { return Math.abs(this.speed) * 3.6; }

  /**
   * @param input { drive: -1..1 (W/S), steer: -1..1 (+ = left), handbrake: bool }.
   *  S brakes while rolling forward and engages reverse once stopped; W does the opposite in reverse.
   */
  update(dt, input = {}) {
    if (dt <= 0) return;
    const n = Math.min(8, Math.ceil(dt * 120)); // fixed-ish 120 Hz, split evenly so frames stay smooth
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h, input);
    this.collide(dt);
    this.pose();
  }

  step(h, { drive = 0, steer = 0, handbrake = false }) {
    const s = this.s;
    const cos = Math.cos(this.heading), sin = Math.sin(this.heading);
    const fx = cos, fz = -sin, rx = sin, rz = cos;
    // Body-local velocity of the CG and the CG position.
    let u = this.vx * fx + this.vz * fz;
    let w = this.vx * rx + this.vz * rz;
    const speed = Math.hypot(u, w);
    const cgx = this.pos.x + fx * s.cgX, cgz = this.pos.z + fz * s.cgX;

    // --- ground: wheel heights, plane, sprung heave ---------------------------------------
    const gy = [0, 0, 0, 0];
    let found = 0;
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = s.wheels[i];
      const y = this.groundY(this.pos.x + fx * lx + rx * lz, this.pos.z + fz * lx + rz * lz, this.pos.y);
      if (y !== null) found++;
      gy[i] = y ?? this.pos.y;
    }
    if (!found) this.vy = Math.max(this.vy, 0); // nothing streamed in below yet: hover rather than fall through
    const [[ax], , [bx]] = s.wheels;
    const wb = ax - bx;
    const front = (gy[0] + gy[1]) / 2, rear = (gy[2] + gy[3]) / 2;
    const left = (gy[0] + gy[2]) / 2, rightY = (gy[1] + gy[3]) / 2;
    const track = s.wheels[1][1] - s.wheels[0][1];
    this.groundPitch = Math.atan2(front - rear, wb);
    this.groundRoll = Math.atan2(left - rightY, track); // + = right side lower
    const raw = rear + ((front - rear) * -bx) / wb; // under the model origin
    if (this.snap) { this.pos.y = raw; this.vy = 0; this.groundPrev = raw; this.snap = false; }
    // Road heights come from a 1 m grid, so they step as the wheels cross cells. Smoothed over ~40 ms
    // (about a tyre's footprint at speed) they stop kicking the damper and launching the car off flat road.
    const ground = this.groundPrev === null ? raw : this.groundPrev + (raw - this.groundPrev) * Math.min(1, h * s.groundFilter);
    const groundV = this.groundPrev === null ? 0 : clamp((ground - this.groundPrev) / h, -15, 15);
    this.groundPrev = ground;
    const wh = TAU * s.heaveHz;
    const gap = ground - this.pos.y; // + = body below its rest height
    let support = 0;
    if (gap > -s.travel) support = Math.max(0, G + wh * wh * gap - 2 * s.heaveDamping * wh * (this.vy - groundV));
    this.vy += (support - G) * h;
    this.pos.y += this.vy * h;
    if (this.pos.y < ground - 0.3) { this.pos.y = ground - 0.3; this.vy = Math.max(this.vy, groundV); } // never sink into a refined mesh
    this.contact = clamp(support / G, 0, 2.5);
    const grip = clamp(this.contact, 0, 1.6);

    // --- gearbox and engine -----------------------------------------------------------------
    const rev = this.gear < 0;
    let throttle = 0, brake = 0;
    if (!rev) {
      if (drive > 0) throttle = drive;
      else if (drive < 0) { if (u > 0.8) brake = -drive; else { this.gear = -1; this.shift = s.shiftTime; } }
    } else {
      if (drive < 0) throttle = -drive;
      else if (drive > 0) { if (u < -0.8) brake = drive; else { this.gear = 1; this.shift = s.shiftTime; } }
    }
    this.throttle += clamp(throttle - this.throttle, -h * 10, h * 6);
    const ratio = (this.gear < 0 ? -s.reverseRatio : s.gears[this.gear - 1]) * s.finalDrive;
    const wheelRpm = ((u / s.wheelRadius) * 60) / TAU;
    const coupled = wheelRpm * ratio; // engine rpm the rear axle asks for
    const clutchRpm = s.idleRpm + this.throttle * (s.launchRpm - s.idleRpm);
    let rpm = Math.max(coupled, clutchRpm);
    const limit = this.gear < 0 ? s.reverseRpmLimit : s.redline;
    let engine = coupled >= limit ? 0 : torqueAt(s.torque, rpm) * this.throttle;
    engine -= s.engineBrake * (1 - this.throttle) * clamp((coupled - s.idleRpm) / (s.redline - s.idleRpm), 0, 1);
    if (this.shift > 0) { this.shift -= h; engine = Math.min(engine, 0) * 0.3; }
    const driveForce = (engine * ratio * s.efficiency) / s.wheelRadius; // along body forward, rear axle

    // --- tyre loads: static + weight transfer + downforce ------------------------------------
    const a = ax - s.cgX, b = s.cgX - bx; // CG to front / rear axle
    const L = a + b;
    const down = s.downforce * u * u;
    // Acceleration toward +right loads the left wheels, forward acceleration the rear.
    const lon = (s.mass * this.accX * s.cgHeight) / L;
    const latF = (s.mass * this.accZ * s.cgHeight * s.rollShareFront) / track;
    const latR = (s.mass * this.accZ * s.cgHeight * (1 - s.rollShareFront)) / track;
    const fzFront = ((s.mass * G + down) * b) / L / 2, fzRear = ((s.mass * G + down) * a) / L / 2;
    const loads = [fzFront - lon / 2 + latF, fzFront - lon / 2 - latF, fzRear + lon / 2 + latR, fzRear + lon / 2 - latR]
      .map((f) => Math.max(0, f * grip));
    const fz0 = (s.mass * G) / 4;

    // --- steering --------------------------------------------------------------------------
    const lock = Math.max(s.minLock, s.maxLock / (1 + Math.max(0, u) / s.lockSpeed));
    const beta = speed > 3 && u > 0 ? Math.atan2(w, u) : 0; // + = sliding toward the right
    const assist = s.countersteer * (steer === 0 ? 1 : 0.4);
    const target = clamp(steer * lock - assist * beta, -s.maxLock, s.maxLock);
    const rate = Math.abs(target) < Math.abs(this.steer) || Math.sign(target) !== Math.sign(this.steer) ? s.steerReturn : s.steerRate;
    this.steer += clamp(target - this.steer, -rate * h, rate * h);
    // Mild Ackermann: the inner wheel turns more.
    const ack = 1 + 0.12 * Math.abs(this.steer);
    this.wheelSteer[0] = this.steer > 0 ? this.steer * ack : this.steer / ack;
    this.wheelSteer[1] = this.steer > 0 ? this.steer / ack : this.steer * ack;

    // --- tyre forces -------------------------------------------------------------------------
    let Fx = 0, Fy = 0, M = 0, slipSum = 0;
    // Handbrake opens a drift window: traction control stands back so the throttle can hold the slide.
    if (handbrake && speed > 4) this.drift = s.driftTime;
    else this.drift = Math.max(0, this.drift - h);
    const tc = this.drift > 0 ? s.driftTraction : s.tractionControl;
    let spinExcess = 0;
    for (let i = 0; i < 4; i++) {
      const [wlx, wlz] = s.wheels[i];
      const lx = wlx - s.cgX, lz = wlz;
      const isFront = i < 2;
      const d = isFront ? this.wheelSteer[i] : 0;
      const cd = Math.cos(d), sd = Math.sin(d);
      // Contact patch velocity in body then wheel axes.
      const pu = u + this.yawRate * lz, pw = w - this.yawRate * lx;
      const wu = pu * cd - pw * sd, ww = pu * sd + pw * cd;
      const load = loads[i];
      const mu = (isFront ? s.tyre.muFront : s.tyre.muRear) * (1 - s.tyre.loadSens * (load / fz0 - 1));
      const cap = mu * load;
      const share = load / G; // mass the tyre can stop within one step
      let fl = 0, ft = 0;
      const locked = !isFront && handbrake;
      if (locked) {
        // Locked rear tyre slides: kinetic friction against the patch velocity.
        const v = Math.hypot(wu, ww);
        const k = (s.tyre.slideMu * cap * Math.min(1, v / 0.4)) / Math.max(v, 1e-3);
        fl = -wu * k; ft = -ww * k;
        slipSum += Math.min(1, v / 6) * (load / fz0);
      } else {
        // Lateral: magic formula on the slip angle, never more than stops the sideways slide this step.
        const alpha = Math.atan2(ww, Math.max(Math.abs(wu), s.lowSpeed));
        const stop = (share * Math.abs(ww)) / h;
        ft = clamp(-cap * magic(s.tyre, isFront ? alpha : alpha * s.tyre.rearStiffness), -stop, stop);
        // Assists keep cornering force first: traction control and ABS use what grip is left.
        const left = cap * Math.sqrt(Math.max(isFront ? 0.2 : 0.04, 1 - (ft / Math.max(cap, 1)) ** 2));
        if (!isFront) {
          const want = driveForce / 2;
          const max = this.drift > 0 ? cap * tc : left * tc;
          if (Math.abs(want) > cap) spinExcess += ((Math.abs(want) - cap) / Math.max(cap, 1)) * (this.drift > 0 ? 1 : 0.2);
          fl = clamp(want, -max, max);
        }
        let brk = (brake * s.brakeForce * (isFront ? s.brakeFront : 1 - s.brakeFront)) / 2;
        if (!brake && !throttle && Math.abs(u) < 0.6) brk = cap; // parked: hold against slopes and creep
        brk = Math.min(brk, left * s.abs, (share * Math.abs(wu)) / h);
        fl -= Math.sign(wu) * brk;
        // Friction ellipse: whatever the longitudinal force leaves.
        const room = Math.sqrt(Math.max(0, cap * cap - fl * fl));
        ft = clamp(ft, -room, room);
        slipSum += clamp((Math.abs(alpha) - 0.12) / 0.25, 0, 1) * (load / fz0);
      }
      // Back to body axes.
      const bxF = fl * cd + ft * sd, bzF = -fl * sd + ft * cd;
      Fx += bxF; Fy += bzF;
      M += lz * bxF - lx * bzF;
    }
    this.wheelspin += (clamp(spinExcess, 0, 2) - this.wheelspin) * Math.min(1, h * 8);

    // Drag, rolling resistance and slope gravity at the CG.
    Fx -= s.dragCoef * u * speed + Math.sign(u) * Math.min(s.rollingResistance * s.mass * G * grip, (s.mass * Math.abs(u)) / h);
    Fy -= s.dragCoef * w * speed;
    const slopeX = -G * Math.sin(this.groundPitch) * Math.min(grip, 1);
    const slopeZ = G * Math.sin(this.groundRoll) * Math.min(grip, 1);

    // --- integrate --------------------------------------------------------------------------
    const accX = Fx / s.mass + slopeX, accZ = Fy / s.mass + slopeZ;
    u += accX * h; w += accZ * h;
    // Stability assist (ESC-like): ease the yaw rate toward what the steering asks for, within grip.
    if (grip > 0.3 && u > 3) {
      const want = (u * Math.tan(this.steer)) / wb;
      const cap = (Math.abs(this.accZ) + s.slideAllowance * G) / speed; // the yaw the path can follow, plus a little
      const err = clamp(want, -cap, cap) - this.yawRate;
      const over = err * this.yawRate < 0; // turning more than asked: the rear is stepping out
      const gain = (over ? s.stabilityOver : s.stability) * Math.min(1, (u - 3) / 7) * (this.drift > 0 ? s.driftStability : 1);
      M += gain * s.yawInertia * err;
    }
    this.yawRate += (M / s.yawInertia) * h;
    if (grip < 0.05) this.yawRate *= 1 - h * 0.3; // airborne: keep spinning, a little air drag
    this.heading += this.yawRate * h;
    // Body-local velocity back to the world, in the new heading, so the CG keeps its momentum.
    const c2 = Math.cos(this.heading), s2 = Math.sin(this.heading);
    const wvx = u * fx + w * rx, wvz = u * fz + w * rz;
    this.vx = wvx; this.vz = wvz;
    const ncx = cgx + wvx * h, ncz = cgz + wvz * h;
    this.pos.x = ncx - c2 * s.cgX;
    this.pos.z = ncz + s2 * s.cgX;
    // Filtered tyre acceleration (gravity on a slope does not shift load the same way).
    const k = Math.min(1, h * 14);
    this.accX += (Fx / s.mass - this.accX) * k;
    this.accZ += (Fy / s.mass - this.accZ) * k;
    this.slip += (clamp(slipSum / 2, 0, 1) - this.slip) * Math.min(1, h * 6);

    // --- automatic gearbox ---------------------------------------------------------------
    // Shifts follow demand over time, not the instant key state: a keyboard is only ever 0 or 1, so
    // pulsing W through town short-shifts into 3rd or 4th, while held full throttle revs to the limiter.
    // Braking holds the gear and blips down early, so engine braking helps and the exit pulls.
    this.demand += (throttle - this.demand) * Math.min(1, h * (throttle > this.demand ? 3 : 1.5));
    this.shiftHold -= h;
    if (this.gear > 0 && this.shift <= 0 && this.shiftHold <= 0) {
      const d3 = this.demand ** 3;
      const up = brake ? Infinity : lerp(2700, 8700, d3), downAt = brake ? 4600 : lerp(1400, 5600, d3);
      const next = this.gear < s.gears.length ? (coupled * s.gears[this.gear]) / s.gears[this.gear - 1] : 0;
      const prev = this.gear > 1 ? (coupled * s.gears[this.gear - 2]) / s.gears[this.gear - 1] : Infinity;
      if (coupled > up && next > Math.max(downAt * 1.15, 1300)) { this.gear++; this.shift = s.shiftTime; this.shiftHold = 0.5; }
      else if (coupled < downAt && prev < Math.min(up * 0.92, 8400)) { this.gear--; this.shift = s.shiftTime * 0.6; this.shiftHold = 0.5; }
    }
    // Displayed rpm flares with wheelspin.
    rpm = Math.min(limit + 150, rpm * (1 + this.wheelspin * 0.15));
    this.rpm += (rpm - this.rpm) * Math.min(1, h * 12);

    // --- wheel spin angles ---------------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      if (i >= 2 && handbrake) continue;
      const [lx, lz] = s.wheels[i];
      const pu = u + this.yawRate * lz;
      const extra = i >= 2 && throttle ? this.wheelspin * 12 * Math.sign(ratio) : 0;
      this.wheelSpin[i] = (this.wheelSpin[i] + ((pu / s.wheelRadius) + extra) * h) % TAU;
    }

    // --- sprung body: pitch and roll chase the weight transfer ------------------------------
    const wb2 = TAU * s.bodyHz;
    const pitchT = (this.accX / G) * s.pitchPerG, rollT = (-this.accZ / G) * s.rollPerG;
    this.pitchV += (wb2 * wb2 * (pitchT - this.pitch) - 2 * s.bodyDamping * wb2 * this.pitchV) * h;
    this.rollV += (wb2 * wb2 * (rollT - this.roll) - 2 * s.bodyDamping * wb2 * this.rollV) * h;
    this.pitch += this.pitchV * h;
    this.roll += this.rollV * h;
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = s.wheels[i];
      // Ground under the wheel relative to where the tilted body expects it.
      const body = this.pos.y + lx * Math.sin(this.groundPitch + this.pitch) - lz * Math.sin(this.groundRoll + this.roll);
      this.wheelLift[i] = clamp(gy[i] - body, -s.travel, s.travel);
    }
  }

  /** Sweep the hull along the frame's motion; bounce off what it meets. */
  collide(dt) {
    const s = this.s;
    const speed = Math.hypot(this.vx, this.vz);
    if (speed < 0.05) return;
    const dx = this.vx / speed, dz = this.vz / speed;
    const fx = Math.cos(this.heading), fz = -Math.sin(this.heading);
    const rx = -fz, rz = fx;
    // Hull extent along the motion and across it.
    const along = Math.abs(dx * fx + dz * fz) * s.halfLength + Math.abs(dx * rx + dz * rz) * s.halfWidth;
    const across = Math.abs(-dz * fx + dx * fz) * s.halfLength + Math.abs(-dz * rx + dx * rz) * s.halfWidth;
    const step = speed * dt;
    const oy = this.pos.y + s.rayHeight;
    let best = null;
    for (const o of [0, -0.8, 0.8]) {
      const ox = this.pos.x - dz * across * o, oz = this.pos.z + dx * across * o;
      const hit = this.wallRay(ox, oy, oz, dx, dz, along + step + 0.3);
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, ox, oz };
    }
    if (!best) {
      // A sudden rise ahead (a building plinth, steps) counts as a wall too.
      const px = this.pos.x + dx * (along + step), pz = this.pos.z + dz * (along + step);
      const y = this.groundY(px, pz, this.pos.y + 0.6);
      if (y !== null && y - this.pos.y > s.maxStep) best = { distance: along + step, nx: -dx, nz: -dz, ox: this.pos.x, oz: this.pos.z };
    }
    if (!best) return;
    let nx = best.nx, nz = best.nz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; }
    // Contact point relative to the CG.
    const px = best.ox + dx * best.distance, pz = best.oz + dz * best.distance;
    const cgx = this.pos.x + fx * s.cgX, cgz = this.pos.z + fz * s.cgX;
    const qx = px - cgx, qz = pz - cgz;
    // Point velocity: v + w x q, with w about +y: (w qz, -w qx).
    const vpx = this.vx + this.yawRate * qz, vpz = this.vz - this.yawRate * qx;
    const vn = vpx * nx + vpz * nz;
    if (vn < 0) {
      // y component of q x n, as torque about +y: qz nx - qx nz.
      const qn = qz * nx - qx * nz;
      const j = (-(1 + s.restitution) * vn) / (1 / s.mass + (qn * qn) / s.yawInertia);
      this.vx += (j * nx) / s.mass;
      this.vz += (j * nz) / s.mass;
      // Scrape: friction along the wall.
      const tx = -nz, tz = nx;
      const vt = this.vx * tx + this.vz * tz;
      const drop = Math.min(Math.abs(vt), (s.wallFriction * j) / s.mass) * Math.sign(vt);
      this.vx -= tx * drop; this.vz -= tz * drop;
      this.yawRate = clamp(this.yawRate + (s.wallSpin * qn * j) / s.yawInertia, -2.5, 2.5);
      this.impact = Math.max(this.impact, -vn);
    }
    // Push out of the wall if the hull overlaps it.
    const depth = along + 0.08 - best.distance;
    if (depth > 0) { this.pos.x += nx * depth; this.pos.z += nz * depth; }
  }

  /** Body axes from the ground plane plus the sprung pitch and roll. */
  pose() {
    const P = this.groundPitch + this.pitch, R = this.groundRoll + this.roll;
    const c = Math.cos(this.heading), sn = Math.sin(this.heading);
    const f = this.forward, r = this.right, up = this.up;
    f.x = c * Math.cos(P); f.y = Math.sin(P); f.z = -sn * Math.cos(P);
    r.x = sn * Math.cos(R); r.y = -Math.sin(R); r.z = c * Math.cos(R);
    // up = right x forward, then re-orthogonalise right = forward x up.
    up.x = r.y * f.z - r.z * f.y; up.y = r.z * f.x - r.x * f.z; up.z = r.x * f.y - r.y * f.x;
    const ul = Math.hypot(up.x, up.y, up.z);
    up.x /= ul; up.y /= ul; up.z /= ul;
    r.x = f.y * up.z - f.z * up.y; r.y = f.z * up.x - f.x * up.z; r.z = f.x * up.y - f.y * up.x;
  }
}
