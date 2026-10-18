// Character and car models:
//   man.glb      - "Casual Character" by Quaternius, CC0 (see public/models/CREDITS.md)
//   ferrari.glb  - Ferrari 458 Italia by vicent091036 (Sketchfab, CC BY)
// They are stand-ins of reasonable quality, not final game art.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export async function loadModels(gltf) {
  const [man, ferrari, ao] = await Promise.all([
    gltf.loadAsync('/models/man.glb'),
    gltf.loadAsync('/models/ferrari.glb'),
    new THREE.TextureLoader().loadAsync('/models/ferrari_ao.png'),
  ]);
  const carSource = ferrari.scene.children[0];
  const details = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.5 });
  // Plain transparency: physical transmission would render the whole city a second time every frame.
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2630, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.45 });
  const blob = new THREE.MeshBasicMaterial({ map: ao, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true });

  /** Car with local +X forward, origin on the ground under its centre. */
  function makeCar(color) {
    const model = carSource.clone(true);
    const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.9, roughness: 0.45, clearcoat: 1.0, clearcoatRoughness: 0.05 });
    model.getObjectByName('body').material = paint;
    for (const name of ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim']) model.getObjectByName(name).material = details;
    model.getObjectByName('glass').material = glass;
    const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map((n) => model.getObjectByName(n));
    for (const w of wheels) { w.rotation.order = 'YXZ'; w.userData.restY = w.position.y; }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.655 * 4, 1.3 * 4), blob);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.renderOrder = 2;
    model.add(shadow);
    model.rotation.y = -Math.PI / 2; // the model's nose points along -Z
    const car = new THREE.Group();
    car.add(model);
    car.userData = { wheels, paint };
    return car;
  }

  // Metres covered by one cycle of each in-place locomotion clip (measured from foot travel).
  const STRIDE = { Walk: 1.67, Run: 2.1 };
  const RUN_PHASE = 0.37; // Run reaches the left-foot-forward pose this far into its cycle, Walk at 0

  /** Person with local +X forward, feet at the origin. animate(speed, dt, grounded). */
  function makePerson() {
    const model = cloneSkinned(man.scene);
    model.rotation.y = Math.PI / 2; // the model faces +Z
    model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    const person = new THREE.Group();
    person.add(model);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.03;
    person.add(shadow);

    const mixer = new THREE.AnimationMixer(model);
    const clips = Object.fromEntries(man.animations.map((c) => [c.name, mixer.clipAction(c)]));
    const names = ['Idle', 'Walk', 'Run'];
    for (const name of names) { clips[name].play(); clips[name].setEffectiveWeight(name === 'Idle' ? 1 : 0); }
    // Walk and Run share one gait phase driven by distance travelled, so feet never slide and the blend stays in step.
    clips.Walk.timeScale = clips.Run.timeScale = 0;
    const weight = { Idle: 1, Walk: 0, Run: 0 };
    let phase = 0;
    person.userData.animate = (speed, dt, grounded = true) => {
      const run = THREE.MathUtils.smoothstep(speed, 2.6, 4.5);
      const move = speed > 0.15 ? 1 : 0;
      const target = { Idle: 1 - move, Walk: move * (1 - run), Run: move * run };
      const k = 1 - Math.exp(-dt * 10); // ~0.2 s crossfade
      if (grounded) for (const name of names) weight[name] += (target[name] - weight[name]) * k;
      const sum = weight.Idle + weight.Walk + weight.Run || 1;
      for (const name of names) clips[name].setEffectiveWeight(weight[name] / sum);
      const gaitW = weight.Walk + weight.Run;
      const stride = gaitW > 0 ? (weight.Walk * STRIDE.Walk + weight.Run * STRIDE.Run) / gaitW : STRIDE.Walk;
      // In the air the legs keep only a slow drift instead of running on nothing.
      phase = (phase + (grounded ? speed : 0.3) * dt / stride) % 1;
      clips.Walk.time = phase * clips.Walk.getClip().duration;
      clips.Run.time = ((phase + RUN_PHASE) % 1) * clips.Run.getClip().duration;
      mixer.update(dt);
    };
    return person;
  }

  return { makeCar, makePerson };
}
