// Frame composition: the far horizon layer and the near detail layer are drawn as two depth
// ranges (like Cesium's multi-frustum), so each keeps full depth precision and the detail always
// lands on top. The finished, tone-mapped frame is then sharpened (AMD FidelityFX CAS) and lightly
// graded in display space, and the resolution adapts to keep the frame rate.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const CAS = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: null }, texel: { value: new THREE.Vector2() }, sharpness: { value: 0.6 },
    saturation: { value: 1.1 }, contrast: { value: 1.06 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 texel; uniform float sharpness, saturation, contrast; varying vec2 vUv;
    void main() {
      vec3 a = texture2D(tDiffuse, vUv - vec2(0., texel.y)).rgb, b = texture2D(tDiffuse, vUv - vec2(texel.x, 0.)).rgb;
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec3 d = texture2D(tDiffuse, vUv + vec2(texel.x, 0.)).rgb, e = texture2D(tDiffuse, vUv + vec2(0., texel.y)).rgb;
      vec3 mn = min(min(min(a, b), min(d, e)), c), mx = max(max(max(a, b), max(d, e)), c);
      vec3 amp = sqrt(clamp(min(mn, 1. - mx) / max(mx, 1e-4), 0., 1.));
      vec3 w = -amp * mix(1. / 8., 1. / 5., sharpness);
      vec3 col = (c + (a + b + d + e) * w) / (1. + 4. * w);
      float l = dot(col, vec3(.2126, .7152, .0722));
      col = (mix(vec3(l), col, saturation) - .5) * contrast + .5;
      gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
    }`,
  depthTest: false,
  depthWrite: false,
});

export class Post {
  /** `layers`: [scene, camera] pairs drawn back to front, each with its own depth range. */
  constructor(renderer, layers) {
    this.renderer = renderer;
    this.layers = layers;
    this.quad = new FullScreenQuad(CAS);
    this.size = new THREE.Vector2();
    this.frame = null;
    this.sharpen = true;
    this.maxRatio = Math.min(devicePixelRatio, 2);
    this.minRatio = Math.min(1, this.maxRatio);
    this.ema = 16.7;
    this.slow = 0;
    this.fast = 0;
    this.last = performance.now();
    renderer.autoClear = false;
  }

  /** Draw the frame; returns the frame interval in ms. */
  render() {
    const r = this.renderer;
    const now = performance.now(), ms = now - this.last;
    this.last = now;
    r.setRenderTarget(null);
    r.clear(true, true, true);
    for (const [scene, camera] of this.layers) {
      r.clearDepth();
      r.render(scene, camera);
    }
    if (this.sharpen) {
      r.getDrawingBufferSize(this.size);
      if (!this.frame || this.frame.image.width !== this.size.x || this.frame.image.height !== this.size.y) {
        this.frame?.dispose();
        this.frame = new THREE.FramebufferTexture(this.size.x, this.size.y);
        CAS.uniforms.tDiffuse.value = this.frame;
        CAS.uniforms.texel.value.set(1 / this.size.x, 1 / this.size.y);
      }
      r.copyFramebufferToTexture(this.frame);
      this.quad.render(r);
    }
    this.adapt(Math.min(ms, 100));
    return ms;
  }

  /** Dynamic resolution: drop a quarter step after 2 s of slow frames, climb back after 5 s of fast ones. */
  adapt(ms) {
    this.ema += (ms - this.ema) * 0.05;
    const r = this.renderer, ratio = r.getPixelRatio();
    this.slow = this.ema > 19 ? this.slow + ms : 0;
    this.fast = this.ema < 17.5 ? this.fast + ms : 0;
    if (this.slow > 2000 && ratio > this.minRatio) { r.setPixelRatio(Math.max(this.minRatio, ratio - 0.25)); this.slow = 0; }
    else if (this.fast > 5000 && ratio < this.maxRatio) { r.setPixelRatio(Math.min(this.maxRatio, ratio + 0.25)); this.fast = 0; }
  }
}

/** Average colour of the sky just above the horizon as it appears on screen, for haze and fog. */
export function horizonColor(renderer, scene, sky) {
  const gl = renderer.getContext();
  const camera = new THREE.PerspectiveCamera(20, 1, 1, sky.scale.x * 2);
  const px = new Uint8Array(4), sum = [0, 0, 0];
  const w = renderer.domElement.width, h = renderer.domElement.height;
  sky.position.set(0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    camera.lookAt(Math.cos(a), Math.tan(THREE.MathUtils.degToRad(1.5)), Math.sin(a));
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    gl.readPixels(w >> 1, h >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let k = 0; k < 3; k++) sum[k] += px[k] / 255 / 8;
  }
  return new THREE.Color().setRGB(sum[0], sum[1], sum[2], THREE.SRGBColorSpace);
}
