import * as THREE from 'three';
import {
  CAVE_HORIZON_RADIUS,
} from '@shared/constants';
import {
  CAVE_HORIZON_RENDER_ORDER, CAVE_PORTAL_STENCIL_REF,
} from './cave-visibility.js';
export { CAVE_HORIZON_RENDER_ORDER } from './cave-visibility.js';
import { createCloudNoise } from './material-detail.js';
import { RenderQuality, basePixelRatio } from './render-quality.js';
import { CAVE_FOG_HEX, SURFACE_FOG_NEAR, SURFACE_FOG_FAR } from './atmosphere.js';
import { renderProfile, isTouchDevice } from './device-profile.js';
import { type CityThemeSite } from '@shared/city-themes';
import { CityAtmosphere, BASE_SKY_TOP, BASE_SKY_HORIZON } from './city-atmosphere.js';
import { ContactLighting } from './contact-lighting.js';
import { setCityEnvironmentSites } from './city-environment.js';
import { ShaderPreparation } from './shader-preparation.js';
import { ShaderCommandQueue } from './shader-command-queue.js';

// Physical lighting, a procedural reflection environment, and camera-local
// desktop sun shadows. Resolution adapts under sustained GPU load.

const SKY_TOP = BASE_SKY_TOP;
const SKY_HORIZON = BASE_SKY_HORIZON;
const SKY_RADIUS = 5200;
const CAVE_FOG_COLOR = new THREE.Color(CAVE_FOG_HEX);
export const SKY_RENDER_ORDER = -10;

/** Two mipmapped cloud samples on a single dome, with a sun disk matching
 * the key light. The lower sky matches the terrain's fog color exactly. */
export function createSky(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      skyTop: { value: SKY_TOP.clone() },
      skyHorizon: { value: SKY_HORIZON.clone() },
      cloudLow: { value: new THREE.Color().setRGB(.64, .72, .76) },
      cloudHigh: { value: new THREE.Color().setRGB(.96, .94, .87) },
      sunColor: { value: new THREE.Color().setRGB(1, .94, .76) },
      sunStrength: { value: 1 },
      cityMood: { value: new THREE.Vector2() },
      rainforest: { value: 0 },
      sunDirection: { value: new THREE.Vector3(0.55, 0.75, 0.3).normalize() },
      cloudNoise: { value: createCloudNoise() },
      worldPhase: { value: 0 },
      skyTime: { value: 0 },
      liquidView: { value: 0 },
      liquidColor: { value: new THREE.Color(0x164952) },
    },
    vertexShader: `varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 skyTop, skyHorizon, sunDirection, cloudLow, cloudHigh, sunColor;
      uniform vec2 cityMood;
      uniform float sunStrength;
      uniform float rainforest;
      uniform sampler2D cloudNoise;
      uniform float skyTime, worldPhase;
      uniform float liquidView;
      uniform vec3 liquidColor;
      varying vec3 vSkyDirection;
      float lunarNoise(vec2 p) {
        vec2 cell = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float n = dot(cell, vec2(127.1, 311.7));
        vec4 h = fract(sin(n + vec4(0.0, 127.1, 311.7, 438.8)) * 43758.5453);
        return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y);
      }
      void main() {
        vec3 direction = normalize(vSkyDirection);
        float elevation = max(0.0, direction.y);
        vec3 sky = mix(skyHorizon, skyTop, pow(elevation, 0.48));
        float sunAngle = max(0.0, dot(direction, sunDirection));
        sky += mix(vec3(1.0, 0.68, 0.32), sunColor, cityMood.x) * pow(sunAngle, 48.0) * 0.19 * sunStrength;
        sky += mix(vec3(1.0, 0.86, 0.62), sunColor, cityMood.x) * pow(sunAngle, 700.0) * 0.38 * sunStrength;
        sky = mix(sky, sunColor, smoothstep(0.99965, 0.99985, sunAngle) * sunStrength);
        // A close binary companion, rendered in the same dome pass.
        vec3 companionDirection = normalize(sunDirection + vec3(-.16, .05, -.19));
        float companionAngle = max(0.0, dot(direction, companionDirection));
        sky += vec3(.50, .72, 1.0) * pow(companionAngle, 480.0) * .10 * sunStrength;
        sky = mix(sky, vec3(.85, .93, 1.0), smoothstep(.99994, .99998, companionAngle) * sunStrength);
        vec2 cloudUV = direction.xz / (0.22 + elevation) * 0.45;
        cloudUV.x *= 1.0 - cityMood.x * .40;
        cloudUV += vec2(skyTime * .00023, skyTime * .00008);
        vec3 cloudData = texture2D(cloudNoise, cloudUV).rgb;
        vec3 cloudDetail = texture2D(cloudNoise, cloudUV * 3.13 + vec2(.27, .63)).rgb;
        float cloud = cloudData.r * .78 + cloudDetail.r * .22;
        float threshold = .47 - cityMood.y * .025 - rainforest * .04 - cityMood.x * .025;
        float erosion = (cloudDetail.b - .5) * .035;
        float cover = smoothstep(threshold, threshold + .14, cloud + erosion) * smoothstep(.01, .18, elevation);
        float thickness = smoothstep(threshold + .015, threshold + .19, cloud);
        vec3 cloudShade = mix(skyTop * .53 + skyHorizon * .16, cloudLow * .76, .45);
        vec3 cloudColor = mix(cloudHigh, cloudShade, thickness * (.62 + cloudData.g * .30));
        float silver = pow(max(0.0, 1.0 - thickness), 3.0) * pow(sunAngle, 12.0);
        cloudColor += sunColor * silver * .55 * sunStrength;
        cloudColor = mix(skyHorizon, cloudColor, smoothstep(.015, .3, elevation));
        sky = mix(sky, cloudColor, cover * .91);
        // A distant rocky moon gives an explorer a celestial bearing. Its
        // lit phase uses the real key-light direction and needs no texture.
        vec3 moonDirection = normalize(vec3(-.42, .34, -.74));
        vec3 moonRight = normalize(cross(moonDirection, vec3(0.0, 1.0, 0.0)));
        vec3 moonUp = normalize(cross(moonRight, moonDirection));
        vec2 moonUV = vec2(dot(direction, moonRight), dot(direction, moonUp)) / .10;
        float moonRadius2 = dot(moonUV, moonUV);
        float moonMask = (1.0 - smoothstep(.98, 1.0, moonRadius2)) * step(.8, dot(direction, moonDirection));
        vec3 moonNormal = moonRight * moonUV.x + moonUp * moonUV.y - moonDirection * sqrt(max(0.0, 1.0 - moonRadius2));
        float moonLight = max(0.0, dot(moonNormal, sunDirection));
        if (moonMask > 0.0) {
          float lunarGeology = lunarNoise(moonUV * 10.0 + worldPhase) * .7 + lunarNoise(moonUV * 42.0 + worldPhase) * .3;
          vec3 moonSurface = vec3(.42, .45, .43) * (moonLight * .82 + .09) * mix(.72, 1.18, lunarGeology);
          moonSurface = mix(sky, moonSurface, .66);
          sky = mix(sky, moonSurface, moonMask * (1.0 - cover));
        }
        // Broad refracted teal strata belong to the dome itself, so no
        // overhead quads or horizon planes can intersect the world/caves.
        float strata = smoothstep(0.52, 0.9, sin(elevation * 34.0 + direction.x * 7.0 + cloud * 4.0));
        sky = mix(sky, cloudHigh * vec3(0.55, 1.0, 0.96),
          strata * cityMood.x * 0.32 * smoothstep(0.08, 0.4, elevation));
        // Slow auroral fractures over the abyss, all on the dome: no world
        // planes, strobing flashes or extra transparent full-screen passes.
        float rift = abs(direction.x + .18 * sin(direction.y * 12.0 + skyTime * .025) + direction.z * .32);
        sky += vec3(.10, .65, .38) * exp(-rift * 130.0) * cityMood.x * smoothstep(.08, .4, elevation) * .55;
        // A vast eclipsed planet gives the golden capital a celestial scale.
        vec3 planetDir = normalize(vec3(-.55, .42, -.32));
        float planetDot = dot(direction, planetDir);
        float planet = smoothstep(.930, .931, planetDot) * cityMood.y;
        float planetNoise = cloud * .6 + .2 + sin(direction.y * 28.0 + direction.x * 4.0) * .10;
        vec3 planetColor = mix(vec3(.10, .10, .065), vec3(.42, .30, .13), planetNoise);
        sky = mix(sky, planetColor, planet * .85);
        sky += vec3(.50, .32, .11) * exp(-abs(planetDot - .931) * 1600.0) * cityMood.y;
        // Unmeshed distant pixels must end in the same water haze as the
        // terrain and surface. An unfogged sky leaves a bright horizon slit.
        gl_FragColor = vec4(mix(sky, liquidColor, liquidView), 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 24, 12), material);
}

/**
 * Camera-centred opaque cave backdrop. It renders after ordinary terrain and
 * entrance stencil caps. Their crossing parity distinguishes distant interior
 * from exterior rays, including looking into a cave while standing outside.
 */
export function createCaveHorizon(): THREE.Mesh<
  THREE.SphereGeometry, THREE.MeshBasicMaterial
> {
  const horizon = new THREE.Mesh(
    new THREE.SphereGeometry(CAVE_HORIZON_RADIUS, 20, 10),
    new THREE.MeshBasicMaterial({
      color: CAVE_FOG_COLOR,
      side: THREE.BackSide,
      fog: false,
      depthTest: true,
      depthWrite: true,
      stencilWrite: true,
      stencilWriteMask: 0x00,
      stencilRef: CAVE_PORTAL_STENCIL_REF,
      stencilFunc: THREE.EqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    }),
  );
  // The entrance caps clip against a radial sphere. A low-poly sphere's
  // triangles sit several metres inside that radius, so its ordinary depth
  // could cover exterior ground that lies between a facet and the true
  // sphere. Write the analytic sphere depth per pixel instead. This keeps
  // the inexpensive dome and makes its depth agree with the portal cutoff
  // while the camera moves across hillside entrances.
  horizon.material.onBeforeCompile = (shader) => {
    shader.uniforms.caveHorizonRadius = { value: CAVE_HORIZON_RADIUS };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCaveHorizonViewPosition;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCaveHorizonViewPosition = mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform mat4 projectionMatrix;\nuniform float caveHorizonRadius;\nvarying vec3 vCaveHorizonViewPosition;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        vec3 spherePoint = normalize(vCaveHorizonViewPosition) * caveHorizonRadius;
        vec4 sphereClip = projectionMatrix * vec4(spherePoint, 1.0);
        gl_FragDepth = (sphereClip.z / sphereClip.w) * 0.5 + 0.5;
      `);
  };
  horizon.material.customProgramCacheKey = () => 'analytic-cave-horizon-depth-v1';
  horizon.renderOrder = CAVE_HORIZON_RENDER_ORDER;
  return horizon;
}

export function configureCaveHorizon(material: THREE.MeshBasicMaterial,
  belowSurfaceEnvelope: boolean): void {
  material.stencilFunc = belowSurfaceEnvelope ? THREE.NotEqualStencilFunc : THREE.EqualStencilFunc;
}

export class SceneMgr {
  liquidKind: 'water' | 'lava' | null = null;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly caveHorizon: ReturnType<typeof createCaveHorizon>;
  private readonly surfaceFogColor: THREE.Color;
  private readonly atmosphereFog: THREE.Fog;
  private readonly liquidFog = new THREE.Fog(0x164952, .6, 32);
  private readonly quality = new RenderQuality();
  private readonly qualityMode: string;
  private readonly cityAtmosphere: CityAtmosphere;
  private readonly sun: THREE.DirectionalLight;
  private readonly contactLighting: ContactLighting;
  private readonly shaderPreparation: ShaderPreparation;
  private readonly shaderCommands: ShaderCommandQueue;
  private reflectionTarget: THREE.WebGLRenderTarget | null = null;
  private contextLost = false;
  private lastPlayable = false;
  private worldPresented = false;
  private readonly lightDirection = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      stencil: true,
    });
    this.qualityMode = new URLSearchParams(location.search).get('quality') ?? 'auto';
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = !isTouchDevice() && this.qualityMode !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.updateResolution();
    this.renderer.setSize(document.documentElement.clientWidth, window.innerHeight, false);

    // Fog color matches the sky gradient at eye level, so far terrain fades
    // into the sky instead of silhouetting against it. Fog spans most of the
    // LOD2 range (which reaches the world border); the far plane clips just
    // past the fully-fogged distance.
    this.surfaceFogColor = SKY_HORIZON.clone();
    this.atmosphereFog = new THREE.Fog(
      this.surfaceFogColor, SURFACE_FOG_NEAR, Math.min(SURFACE_FOG_FAR, renderProfile().fogFar),
    );
    this.scene.fog = this.atmosphereFog;

    this.camera = new THREE.PerspectiveCamera(92, document.documentElement.clientWidth / window.innerHeight, 0.08, 6000);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera); // so the viewmodel (a camera child) renders

    const hemi = new THREE.HemisphereLight(0xc5ddeb, 0x514939, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe5bf, 1.65);
    sun.position.set(0.55, 0.75, 0.3);
    this.sun = sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -115, right: 115, top: 115, bottom: -115, near: 1, far: 700 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = .3; sun.shadow.bias = -.0002;
    this.scene.add(sun, sun.target);

    this.sky = createSky();
    this.sky.renderOrder = SKY_RENDER_ORDER;
    this.scene.add(this.sky);
    // Bake the procedural sky once for roughness-aware reflections; no HDR download.
    this.rebuildEnvironment();
    this.scene.environmentIntensity = .65;
    this.contactLighting = new ContactLighting(this.renderer, isTouchDevice());
    this.contactLighting.enabled = this.qualityMode !== 'low';
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.shaderCommands = new ShaderCommandQueue(gl);
    let parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.shaderPreparation = new ShaderPreparation(() => this.contactLighting.prepare(this.scene, this.camera), () => {
      if (gl.isContextLost()) return false;
      const extension = parallel;
      // Without nonblocking shader-status queries, let the browser process
      // the submitted command queue between frames before ordinary first-use
      // checks. A fence is a scheduling aid, not proof of successful linking.
      if (!extension) return this.shaderCommands.poll((this.renderer.info.programs ?? [])
        .map(program => program.program).filter((program): program is WebGLProgram => !!program));
      // Poll every cached variant, including materials shared by ordinary
      // and instanced meshes; one material may own several linked programs.
      return (this.renderer.info.programs ?? []).every(program => !program.program ||
        gl.getProgramParameter(program.program, extension.COMPLETION_STATUS_KHR));
    });
    canvas.addEventListener('webglcontextlost', () => {
      this.contextLost = true; this.worldPresented = false; this.shaderPreparation.invalidate();
      this.shaderCommands.reset();
      // Release the old renderer's target bookkeeping while its context is
      // lost; deleting those obsolete GL handles after restoration is invalid.
      this.reflectionTarget?.dispose(); this.reflectionTarget = null; this.scene.environment = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.shaderCommands.reset();
      parallel = gl.getExtension('KHR_parallel_shader_compile');
      // Render-target pixels have no CPU copy for Three to upload again.
      // Recreate the sky reflections before preparing the restored scene.
      this.rebuildEnvironment(); this.contextLost = false;
      this.worldPresented = false; this.shaderPreparation.invalidate();
    });
    this.renderer.info.autoReset = false;
    this.cityAtmosphere = new CityAtmosphere(this.sky.material, this.atmosphereFog, hemi, sun);

    // The gradient sky deliberately ignores ordinary fog. Underground, the
    // camera-centered horizon fills distant pixels only after terrain and the
    // canonical entrance caps have established depth + stencil visibility.
    this.caveHorizon = createCaveHorizon();
    this.scene.add(this.caveHorizon);

    window.addEventListener('resize', () => {
      this.camera.aspect = document.documentElement.clientWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.updateResolution();
      this.renderer.setSize(document.documentElement.clientWidth, window.innerHeight, false);
    });
  }

  private rebuildEnvironment(): void {
    const environmentScene = new THREE.Scene(), environmentSky = createSky();
    environmentScene.add(environmentSky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    try {
      const target = pmrem.fromScene(environmentScene, .05, .1, 6000);
      this.reflectionTarget?.dispose(); this.reflectionTarget = target;
      this.scene.environment = target.texture;
    } finally {
      environmentSky.geometry.dispose(); environmentSky.material.uniforms.cloudNoise.value.dispose();
      environmentSky.material.dispose(); pmrem.dispose();
    }
  }

  private updateResolution(): void {
    const scale = this.qualityMode === 'low' ? 0.7 :
      this.qualityMode === 'high' ? 1 : this.quality.scale;
    this.renderer.setPixelRatio(basePixelRatio(window.innerWidth, window.innerHeight,
      window.devicePixelRatio) * scale);
  }

  /** Browser frame cadence includes both simulation and rendering work. */
  updateFrame(frameSeconds: number, elapsedSeconds: number): void {
    this.sky.material.uniforms.skyTime.value = elapsedSeconds;
    if (this.qualityMode !== 'high' && this.qualityMode !== 'low' &&
        this.quality.update(frameSeconds, !document.hidden)) this.updateResolution();
  }

  get renderStats(): { calls: number; triangles: number; pixelRatio: number; geometries: number; textures: number; contactShadowPasses: number;
    shaderPrograms: number; shadersPending: boolean; shaderQueueFallbacks: number; worldPresented: boolean } {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles,
      pixelRatio: this.renderer.getPixelRatio(), geometries: info.memory.geometries,
      textures: info.memory.textures, contactShadowPasses: this.contactLighting.active ? 2 : 0,
      shaderPrograms: info.programs?.length ?? 0, shadersPending: this.shaderPreparation.pending,
      shaderQueueFallbacks: this.shaderCommands.fallbackCount, worldPresented: this.worldPresented };
  }

  setCaveView(belowSurfaceEnvelope: boolean): void {
    // Only enclosed terrain receives cave fog (its shader uses per-vertex
    // depth). Switching global fog turned the exterior landscape into a
    // dark plane when seen through an otherwise correctly stencilled exit.
    configureCaveHorizon(this.caveHorizon.material, belowSurfaceEnvelope);
  }

  setCities(cities: readonly CityThemeSite[]): void {
    this.cityAtmosphere.setCities(cities);
    setCityEnvironmentSites(cities);
  }

  get cityMood() { return this.cityAtmosphere.weights; }
  setWorldSeed(seed: number): void {
    this.cityAtmosphere.seed = seed; this.sky.material.uniforms.worldPhase.value = seed * .001;
    this.worldPresented = false; this.shaderPreparation.invalidate();
  }

  render(playable = false): void {
    this.renderer.info.reset();
    if (this.contextLost) return;
    if (playable !== this.lastPlayable) {
      this.lastPlayable = playable; this.worldPresented = false; this.shaderPreparation.invalidate();
    }
    // The DOM loading screen remains visible until the first authoritative
    // snapshot. Drawing a world at the placeholder camera can synchronously
    // upload its resources before the client can process that snapshot.
    if (!playable) return;
    this.cityAtmosphere.update(this.camera.position);
    this.sky.material.uniforms.liquidView.value = this.liquidKind ? 1 : 0;
    // The atmosphere caches biome weights, so liquid effects must never
    // overwrite its fog. Select the current camera's fog every frame instead.
    this.scene.fog = this.atmosphereFog;
    if (this.liquidKind) {
      const fog = this.liquidFog;
      fog.color.setHex(this.liquidKind === 'water' ? 0x164952 : 0x9b2609);
      fog.near = .6; fog.far = this.liquidKind === 'water' ? 32 : 7;
      this.scene.fog = fog;
      this.sky.material.uniforms.liquidColor.value.copy(fog.color);
    }
    this.sky.position.copy(this.camera.position);
    this.caveHorizon.position.copy(this.camera.position);
    this.lightDirection.copy(this.sky.material.uniforms.sunDirection.value);
    this.sun.target.position.copy(this.camera.position);
    this.sun.position.copy(this.camera.position).addScaledVector(this.lightDirection, 320);
    this.sun.target.updateMatrixWorld();
    if (!this.shaderPreparation.poll()) return;
    this.contactLighting.render(this.scene, this.camera, !!this.liquidKind);
    this.worldPresented = playable;
  }
}
