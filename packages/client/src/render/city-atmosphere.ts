import * as THREE from 'three';
import { cityThemeInfluence, CITY_THEME_PALETTES, type CityThemeSite } from '@shared/city-themes';
import { rainforestAt } from '@shared/rainforest';

export const BASE_SKY_TOP = new THREE.Color(0x3979ac);
export const BASE_SKY_HORIZON = new THREE.Color(0xd6dedc);
const BASE = { top: BASE_SKY_TOP, horizon: BASE_SKY_HORIZON,
  cloudLow: new THREE.Color().setRGB(.64, .72, .76), cloudHigh: new THREE.Color().setRGB(.96, .94, .87),
  sun: new THREE.Color().setRGB(1, .94, .76), skyLight: new THREE.Color(0xc5ddeb),
  groundLight: new THREE.Color(0x514939), sunLight: new THREE.Color(0xffe5bf) };
const palette = (theme: 'vesper' | 'aurelia') => {
  const p = CITY_THEME_PALETTES[theme];
  return { top: new THREE.Color(p.skyTop), horizon: new THREE.Color(p.horizon), cloudLow: new THREE.Color(p.cloudLow),
    cloudHigh: new THREE.Color(p.cloudHigh), sun: new THREE.Color(p.sun), skyLight: new THREE.Color(p.skyLight),
    groundLight: new THREE.Color(p.groundLight), sunLight: new THREE.Color(p.sunLight) };
};
const VESPER = palette('vesper'), AURELIA = palette('aurelia');
const RAINFOREST = { top: new THREE.Color(0x688e87), horizon: new THREE.Color(0xa2c2a6),
  cloudLow: new THREE.Color(0x799f91), cloudHigh: new THREE.Color(0xd9e5ce), sun: new THREE.Color(0xf4e6ad),
  skyLight: new THREE.Color(0xb0d3b0), groundLight: new THREE.Color(0x29432e), sunLight: new THREE.Color(0xe4edb5) };

/** Reuses the existing hemisphere/key light and sky dome. Location blending
 * changes only color uniforms; cave horizon, stencil and fog ranges remain
 * independent, including exterior sky seen from underground. */
export class CityAtmosphere {
  private cities: readonly CityThemeSite[] = [];
  private readonly influence = { vesper: 0, aurelia: 0 };
  private lastVesper = NaN;
  private lastAurelia = NaN;
  private lastForest = NaN;
  seed = 1337;
  constructor(private readonly sky: THREE.ShaderMaterial, private readonly fog: THREE.Fog,
    private readonly hemi: THREE.HemisphereLight, private readonly sun: THREE.DirectionalLight) {}

  setCities(cities: readonly CityThemeSite[]): void { this.cities = cities; this.lastVesper = NaN; }

  update(position: { x: number; y: number; z: number }): void {
    const weights = cityThemeInfluence(this.cities, position.x, position.y, position.z, this.influence);
    const forest = rainforestAt(this.seed, position.x, position.z) * (1 - weights.vesper - weights.aurelia) *
      Math.max(0, Math.min(1, (400 - position.y) / 180));
    if (weights.vesper === this.lastVesper && weights.aurelia === this.lastAurelia && forest === this.lastForest) return;
    this.lastForest = forest;
    this.lastVesper = weights.vesper; this.lastAurelia = weights.aurelia;
    const v = weights.vesper, a = weights.aurelia, base = 1 - v - a - forest;
    const blend = (target: THREE.Color, key: keyof typeof BASE) => target.setRGB(
      BASE[key].r * base + VESPER[key].r * v + AURELIA[key].r * a + RAINFOREST[key].r * forest,
      BASE[key].g * base + VESPER[key].g * v + AURELIA[key].g * a + RAINFOREST[key].g * forest,
      BASE[key].b * base + VESPER[key].b * v + AURELIA[key].b * a + RAINFOREST[key].b * forest);
    const u = this.sky.uniforms;
    blend(u.skyTop.value, 'top'); blend(u.skyHorizon.value, 'horizon');
    blend(u.cloudLow.value, 'cloudLow'); blend(u.cloudHigh.value, 'cloudHigh'); blend(u.sunColor.value, 'sun');
    u.cityMood.value.set(v, a);
    if (u.rainforest) u.rainforest.value = forest;
    u.sunStrength.value = base + v * .30 + a * 1.08 + forest * .72;
    this.fog.color.copy(u.skyHorizon.value);
    blend(this.hemi.color, 'skyLight'); blend(this.hemi.groundColor, 'groundLight');
    blend(this.sun.color, 'sunLight');
    this.fog.near = 90 * (1 - forest) + 30 * forest;
    this.fog.far = 4600 * (1 - forest) + 900 * forest;
    this.hemi.intensity = .68 * base + 1.05 * v + .78 * a + .72 * forest;
    this.sun.intensity = 2.8 * base + 1.8 * v + 2.9 * a + 1.7 * forest;
    this.sun.position.set(.55, .75 * base + .32 * v + .30 * a + .8 * forest, .3).normalize();
    u.sunDirection.value.copy(this.sun.position);
  }

  get weights(): Readonly<{ vesper: number; aurelia: number }> { return this.influence; }
}
