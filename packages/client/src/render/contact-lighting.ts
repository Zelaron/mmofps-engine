import * as THREE from 'three';

const VERTEX = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`;

export const CONTACT_DEPTH_GLSL = `
uniform highp sampler2D sceneDepth;
uniform mat4 inverseProjection;
uniform vec2 fullTexel;
vec2 depthPixel(vec2 uv) {
  // Depth uses nearest filtering. Unproject the sampled pixel's centre,
  // not the unsnapped offset; otherwise a perfectly flat plane self-shadows
  // in horizontal bands, especially at half resolution.
  return (floor(clamp(uv, fullTexel * .5, 1.0 - fullTexel * .5) / fullTexel) + .5) * fullTexel;
}
vec3 viewPoint(vec2 uv) {
  uv = depthPixel(uv);
  float depth = texture2D(sceneDepth, uv).r;
  vec4 point = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return point.xyz / point.w;
}
`;

/** No extra geometry/normal pass: reconstruct nearby surfaces from the same
 * depth/stencil target that rendered the world, including its cave portals. */
export function contactShader(samples: number): string {
  return `
  varying vec2 vUv;
  ${CONTACT_DEPTH_GLSL}
  uniform vec2 projectionScale;
  void main() {
    vec2 centerUv = depthPixel(vUv);
    vec3 center = viewPoint(centerUv);
    float distanceToCamera = -center.z;
    if (texture2D(sceneDepth, vUv).r >= .999999 || distanceToCamera > 180.0) {
      gl_FragColor = vec4(1.0, distanceToCamera, 0.0, 1.0); return;
    }
    // Choose the shallower derivative at discontinuities so foreground
    // silhouettes do not cast a dark outline onto distant background pixels.
    vec3 left = center - viewPoint(centerUv - vec2(fullTexel.x, 0.0));
    vec3 right = viewPoint(centerUv + vec2(fullTexel.x, 0.0)) - center;
    vec3 down = center - viewPoint(centerUv - vec2(0.0, fullTexel.y));
    vec3 up = viewPoint(centerUv + vec2(0.0, fullTexel.y)) - center;
    // At the framebuffer edge a clamped neighbour equals the centre.
    // Never choose that zero derivative as the "shallower" surface.
    vec3 dx = dot(left, left) > 1e-14 && (dot(right, right) < 1e-14 || abs(left.z) < abs(right.z)) ? left : right;
    vec3 dy = dot(down, down) > 1e-14 && (dot(up, up) < 1e-14 || abs(down.z) < abs(up.z)) ? down : up;
    vec3 normal = cross(dx, dy);
    if (dot(normal, normal) < 1e-20) { gl_FragColor = vec4(1.0, distanceToCamera, 0.0, 1.0); return; }
    normal = normalize(normal);
    float radius = mix(.10, 2.1, smoothstep(.45, 3.0, distanceToCamera));
    vec2 radiusUv = min(projectionScale * radius / max(.08, distanceToCamera), fullTexel * 100.0);
    float rotation = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    float occlusion = 0.0;
    for (int i = 0; i < ${samples}; i++) {
      float phase = (float(i) + .5) / ${samples.toFixed(1)};
      float angle = rotation + float(i) * 2.3999632;
      vec2 uv = centerUv + vec2(cos(angle), sin(angle)) * radiusUv * sqrt(phase);
      if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) continue;
      vec3 delta = viewPoint(uv) - center;
      float separation = length(delta);
      float falloff = 1.0 - smoothstep(radius * .35, radius, separation);
      float horizon = max(0.0, dot(normal, delta) / max(.001, separation) - .10);
      occlusion += horizon * falloff;
    }
    float ao = clamp(1.0 - occlusion * (3.6 / ${samples.toFixed(1)}), .38, 1.0);
    ao = mix(ao, 1.0, smoothstep(90.0, 180.0, distanceToCamera));
    gl_FragColor = vec4(ao, distanceToCamera, 0.0, 1.0);
  }`;
}

export const CONTACT_COMPOSITE_GLSL = `
varying vec2 vUv;
${CONTACT_DEPTH_GLSL}
uniform sampler2D sceneColor;
uniform sampler2D contactTexture;
uniform vec2 contactTexel;
uniform float strength;
void main() {
  vec3 color = texture2D(sceneColor, vUv).rgb;
  float depth = -viewPoint(vUv).z;
  float total = 0.0, weights = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 offset = vec2(float(x), float(y)) * contactTexel;
    vec2 contact = texture2D(contactTexture, vUv + offset).rg;
    float spatial = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
    float weight = spatial * exp(-abs(contact.y - depth) / max(.03, depth * .012));
    total += contact.x * weight; weights += weight;
  }
  float ao = weights > .001 ? total / weights : 1.0;
  color *= mix(1.0, ao, strength);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function contactTargetSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(1, Math.ceil(width / 2)), height: Math.max(1, Math.ceil(height / 2)) };
}

/** One HDR world render, half-resolution contact lighting, one output pass.
 * Devices without renderable floating-point textures keep direct rendering. */
export class ContactLighting {
  enabled = true;
  readonly supported: boolean;
  readonly sampleCount: number;
  private target: THREE.WebGLRenderTarget | null = null;
  private contact: THREE.WebGLRenderTarget | null = null;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new THREE.Scene();
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly contactMaterial: THREE.ShaderMaterial;
  private readonly outputMaterial: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer, touch: boolean) {
    this.supported = renderer.extensions.has('EXT_color_buffer_float');
    this.sampleCount = touch ? 8 : 12;
    const depthUniforms = { sceneDepth: { value: null }, inverseProjection: { value: new THREE.Matrix4() }, fullTexel: { value: new THREE.Vector2() } };
    this.contactMaterial = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: contactShader(this.sampleCount),
      uniforms: { ...depthUniforms, projectionScale: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false, toneMapped: false });
    this.outputMaterial = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: CONTACT_COMPOSITE_GLSL,
      uniforms: { ...depthUniforms, sceneColor: { value: null }, contactTexture: { value: null },
        contactTexel: { value: new THREE.Vector2() }, strength: { value: .68 } }, depthTest: false, depthWrite: false });
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0, 3,-1,0, -1,3,0], 3));
    triangle.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 2,0, 0,2], 2));
    this.quad = new THREE.Mesh(triangle, this.contactMaterial); this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    if (this.supported) {
      const depth = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type);
      depth.format = THREE.DepthStencilFormat;
      this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true, depthTexture: depth });
      // Resolve the depth/stencil with the color samples; the contact pass
      // must see precisely the same portal mask and silhouettes as the world.
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const colorSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
      const depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, gl.SAMPLES) as Int32Array | null;
      this.target.samples = Math.max(0, ...Array.from(colorSamples ?? []).filter(n => n <= 4 && Array.from(depthSamples ?? []).includes(n)));
      this.contact = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.contactMaterial.uniforms.sceneDepth.value = depth;
      this.outputMaterial.uniforms.sceneColor.value = this.target.texture;
      this.outputMaterial.uniforms.contactTexture.value = this.contact.texture;
    }
  }

  get active(): boolean { return this.enabled && this.supported; }

  /** Queue the same program variants used by the actual HDR/direct passes.
   * Render-target color space affects program selection, so preparation must
   * use each pass's target too. No surface is drawn here. */
  prepare(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (!this.active || !this.target || !this.contact) { this.renderer.compile(scene, camera); return; }
    const previous = this.renderer.getRenderTarget(), material = this.quad.material;
    try {
      this.renderer.setRenderTarget(this.target); this.renderer.compile(scene, camera);
      this.quad.material = this.contactMaterial;
      this.renderer.setRenderTarget(this.contact); this.renderer.compile(this.scene, this.camera);
      this.quad.material = this.outputMaterial;
      this.renderer.setRenderTarget(previous); this.renderer.compile(this.scene, this.camera);
    } finally { this.quad.material = material; this.renderer.setRenderTarget(previous); }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, underwater = false): void {
    if (!this.active || !this.target || !this.contact) { this.renderer.render(scene, camera); return; }
    this.renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target.setSize(this.size.x, this.size.y);
      const contact = contactTargetSize(this.size.x, this.size.y);
      this.contact.setSize(contact.width, contact.height);
      this.contactMaterial.uniforms.fullTexel.value.set(1 / this.size.x, 1 / this.size.y);
      this.outputMaterial.uniforms.contactTexel.value.set(1 / contact.width, 1 / contact.height);
    }
    this.contactMaterial.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
    this.contactMaterial.uniforms.projectionScale.value.set(camera.projectionMatrix.elements[0] * .5, camera.projectionMatrix.elements[5] * .5);
    this.outputMaterial.uniforms.strength.value = underwater ? 0 : .68;
    const previous = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(this.target); this.renderer.render(scene, camera);
      this.quad.material = this.contactMaterial;
      this.renderer.setRenderTarget(this.contact); this.renderer.render(this.scene, this.camera);
      this.quad.material = this.outputMaterial;
      this.renderer.setRenderTarget(previous); this.renderer.render(this.scene, this.camera);
    } finally { this.renderer.setRenderTarget(previous); }
  }

  dispose(): void {
    this.target?.depthTexture?.dispose(); this.target?.dispose(); this.contact?.dispose();
    this.contactMaterial.dispose(); this.outputMaterial.dispose(); this.quad.geometry.dispose();
  }
}
