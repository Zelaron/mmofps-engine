import * as THREE from 'three';
import { SceneMgr } from '../../packages/client/src/render/scene.js';

// Exercise the real scene/HDR preparation lifecycle without a server or
// streamed world. This entry point is never included in the game bundle.
const canvas = document.createElement('canvas'); canvas.id = 'c'; document.body.appendChild(canvas);
const manager = new SceneMgr(canvas), gl = manager.renderer.getContext();
const contextLoss = gl.getExtension('WEBGL_lose_context')!;
manager.camera.position.set(6, 4, 10); manager.camera.lookAt(0, 1, 0);
const material = new THREE.MeshStandardMaterial({ color: 0xba713d, metalness: .7, roughness: .22 });
const ordinary = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), material);
ordinary.position.set(0, 1.1, 0); ordinary.castShadow = true; manager.scene.add(ordinary);
// Both objects share one material but require different linked programs.
const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 2);
instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-2.5, .5, 0));
instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(2.5, .5, 0));
instances.castShadow = true; manager.scene.add(instances);
const floor = new THREE.Mesh(new THREE.BoxGeometry(30, .2, 30), new THREE.MeshStandardMaterial({ color: 0x7c8b93 }));
floor.position.y = -.1; floor.receiveShadow = true; manager.scene.add(floor);
manager.setWorldSeed(1337);

let lost = 0, restored = 0, playable = true;
const requests: ((value: unknown) => void)[] = [];
canvas.addEventListener('webglcontextlost', () => { lost++; });
canvas.addEventListener('webglcontextrestored', () => { restored++; });
function frame() {
  manager.render(playable);
  if (requests.length && !gl.isContextLost() && manager.renderStats.worldPresented) {
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0, copper = 0, checksum = 2166136261;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 90) lit++;
      if (pixels[i] > pixels[i + 1] * 1.15 && pixels[i + 1] > pixels[i + 2] * 1.05) copper++;
      for (let c = 0; c < 3; c++) checksum = Math.imul(checksum ^ pixels[i + c], 16777619);
    }
    const capture = { ...manager.renderStats, lit, copper, checksum: checksum >>> 0,
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, error: gl.getError() };
    for (const resolve of requests.splice(0)) resolve(capture);
  }
  requestAnimationFrame(frame);
}
(window as any).shaderFixture = {
  get state() { return { ...manager.renderStats, lost, restored, contextLost: gl.isContextLost() }; },
  capture() { return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No presented frame within 15 seconds')), 15000);
    requests.push(value => { clearTimeout(timeout); resolve(value); });
  }); },
  reseed() { manager.setWorldSeed(1337); return manager.renderStats; },
  setPlayable(value: boolean) { playable = value; },
  lose() { contextLoss.loseContext(); },
  restore() { contextLoss.restoreContext(); },
  parallel: !!gl.getExtension('KHR_parallel_shader_compile'),
};
requestAnimationFrame(frame);
