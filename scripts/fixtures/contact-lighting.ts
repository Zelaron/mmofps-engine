import * as THREE from 'three';
import { ContactLighting } from '../../packages/client/src/render/contact-lighting.js';

// An isolated GPU fixture, never included in the game bundle or server.
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true });
renderer.setSize(960, 640); renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x93bac8);
const camera = new THREE.PerspectiveCamera(62, 1.5, .08, 6000);
camera.position.set(4, 3.2, 6); camera.lookAt(0, .6, 0);
scene.add(new THREE.HemisphereLight(0xe0ecff, 0x777364, 2));
const sun = new THREE.DirectionalLight(0xfff2de, 2.5); sun.position.set(4, 6, 2); scene.add(sun);
const material = new THREE.MeshStandardMaterial({ color: 0x929da6, roughness: .6 });
for (const [w, h, d, x, y, z] of [[30, .2, 30, 0, -.1, 0], [5, 3, .3, 0, 1.5, -2],
  [1.5, 1.8, 1.5, .6, .9, .1], [.17, 2.5, .17, -1.3, 1.25, 1.3]]) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); box.position.set(x, y, z); scene.add(box);
}
// A stencil-only opening: the red surface must appear through the circle,
// even when the HDR framebuffer uses multisampled depth/stencil.
const opening = new THREE.Mesh(new THREE.CircleGeometry(.58, 32), new THREE.MeshBasicMaterial({
  colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
  stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
}));
opening.position.set(-2, 1.2, -1.7); opening.renderOrder = 10; scene.add(opening);
const behindOpening = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({
  color: 0xff2010, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc,
}));
behindOpening.position.copy(opening.position); behindOpening.position.z -= .02;
behindOpening.renderOrder = 11; scene.add(behindOpening);

let lighting = new ContactLighting(renderer, false);
function draw(mode: 'direct' | 'hdr' | 'contact') {
  renderer.info.reset(); lighting.enabled = mode !== 'direct'; lighting.render(scene, camera, mode === 'hdr');
  const gl = renderer.getContext(), pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
  gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let redPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 120 && pixels[i] > pixels[i + 1] * 1.65 && pixels[i] > pixels[i + 2] * 1.65) redPixels++;
  return { pixels, redPixels, error: gl.getError() };
}
(window as any).contactFixture = {
  supported: lighting.supported,
  compare() {
    const hdr = draw('hdr'), contact = draw('contact');
    let darkened = 0, brightened = 0, totalChange = 0, maxChange = 0, flatChange = 0;
    for (let i = 0; i < hdr.pixels.length; i += 4) {
      const change = hdr.pixels[i] - contact.pixels[i];
      if (change > 3) darkened++; if (change < -3) brightened++;
      totalChange += change; maxChange = Math.max(maxChange, change);
      if (i < hdr.pixels.length * .08) flatChange += change;
    }
    return { darkened, brightened, meanChange: totalChange / (hdr.pixels.length / 4), maxChange,
      flatChange: flatChange / Math.floor(hdr.pixels.length / 4 * .08),
      redPixels: contact.redPixels, errors: [hdr.error, contact.error], samples: lighting.sampleCount };
  },
  draw(mode: 'direct' | 'hdr' | 'contact') { const { pixels, ...result } = draw(mode); return result; },
  resize(width: number, height: number, touch: boolean) {
    lighting.dispose(); lighting = new ContactLighting(renderer, touch);
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
  },
};
