import * as THREE from 'three';

/** Concrete, inset panels and painted courses, with no texture fetches. */
export function structureMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .76, metalness: .12 });
  material.customProgramCacheKey = () => 'structure-surfaces-v3-physical-city';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      varying vec3 vStructureWorld;
      varying vec3 vStructureLocal;
      varying vec3 vStructureExtent;
      varying vec3 vStructureFace;
      varying float vStructureDistance;
      attribute vec2 instanceFacade;
      varying vec2 vStructureFacade;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vStructureExtent = vec3(length(instanceMatrix[0].xyz),
        length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vStructureLocal = position * vStructureExtent;
      vStructureWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
      vStructureFace = abs(normal);
      vStructureDistance = distance(cameraPosition, vStructureWorld);
      vStructureFacade = instanceFacade;
    `);
    shader.fragmentShader = `
      varying vec3 vStructureWorld;
      varying vec3 vStructureLocal;
      varying vec3 vStructureExtent;
      varying vec3 vStructureFace;
      varying float vStructureDistance;
      varying vec2 vStructureFacade;
      float structureLine(float coordinate, float period, float width) {
        float edge = abs(fract(coordinate / period + 0.5) - 0.5) * period;
        float aa = max(fwidth(coordinate), 0.006);
        return 1.0 - smoothstep(width, width + aa, edge);
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float structureGlazing = 0.0;
      float wall = 1.0 - vStructureFace.y;
      float across = mix(vStructureWorld.x, vStructureWorld.z, vStructureFace.x);
      float localAcross = mix(vStructureLocal.x, vStructureLocal.z, vStructureFace.x);
      float halfAcross = mix(vStructureExtent.x, vStructureExtent.z, vStructureFace.x);
      float height = vStructureLocal.y + vStructureExtent.y;
      float edgeDistance = min(halfAcross - abs(localAcross),
        vStructureExtent.y - abs(vStructureLocal.y));
      float verticalWall = wall * step(0.85, vStructureExtent.y);
      float facadeStyle = mod(vStructureFacade.x, 16.0);
      float city = step(0.5, vStructureFacade.x);
      float tower = city * (1.0 - step(3.5, facadeStyle));
      // Broad material hierarchy remains visible after small detail fades.
      float lowerCourse = (1.0 - smoothstep(0.35, 0.42, height)) * verticalWall * (1.0 - city);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.37, 0.46, 0.47), lowerCourse);
      diffuseColor.rgb *= mix(0.75, 1.0, smoothstep(0.0, 0.18, max(edgeDistance, 0.0)) * wall + (1.0 - wall));
      float detail = 1.0 - smoothstep(90.0, 240.0, vStructureDistance);
      if (detail > 0.0) {
        vec2 uv = mix(vStructureWorld.xz, vec2(across, vStructureWorld.y), wall);
        float panels = max(structureLine(uv.x, 2.8, 0.016),
          structureLine(uv.y, 1.4, 0.012));
        float concrete = sin(uv.x * 27.3 + sin(uv.y * 19.1)) * sin(uv.y * 31.7);
        float grainFade = 1.0 - smoothstep(18.0, 65.0, vStructureDistance);
        float streaks = sin(across * 5.7 + sin(across * 2.4)) * 0.5 + 0.5;
        float weather = pow(streaks, 5.0) * (1.0 - smoothstep(0.0, 2.8, height));
        diffuseColor.rgb *= 1.0 + (concrete * 0.045 * grainFade - panels * 0.28 - weather * wall * 0.12) * detail;
        // Narrow ochre safety course and corner marks read as a used outpost.
        float course = smoothstep(0.43, 0.46, height) * (1.0 - smoothstep(0.54, 0.57, height));
        float stripe = step(0.5, fract((across + height) * 1.8));
        vec3 safety = mix(vec3(0.10, 0.12, 0.115), vec3(0.64, 0.40, 0.115), stripe);
        diffuseColor.rgb = mix(diffuseColor.rgb, safety, course * verticalWall * detail * 0.85 * (1.0 - city));
        // Small fastener heads at regular panel corners, antialiased by the
        // derivative footprint so they cannot sparkle in distant views.
        vec2 bolt = abs(fract((uv - vec2(0.10)) / vec2(2.8, 1.4) + 0.5) - 0.5) * vec2(2.8, 1.4);
        float boltAA = max(length(fwidth(uv)), 0.004);
        float rivet = 1.0 - smoothstep(0.026, 0.026 + boltAA, length(bolt));
        diffuseColor.rgb *= 1.0 - rivet * detail * 0.36;
      }
      if (tower > 0.0 && wall > 0.5) {
        float elevation = vStructureWorld.y - vStructureFacade.y;
        float glass = step(2.5, facadeStyle);
        float brick = step(1.5, facadeStyle) * (1.0 - glass);
        float vesper = step(15.5, vStructureFacade.x) * (1.0 - step(31.5, vStructureFacade.x));
        float aurelia = step(31.5, vStructureFacade.x);
        vec2 period = vec2(mix(3.6, 3.0, glass), 3.6);
        period = mix(period, vec2(3.6, 5.4), vesper);
        period = mix(period, vec2(4.8, 7.2), aurelia);
        vec2 signedPane = (fract(vec2(across, elevation - 0.6) / period) - 0.5) * period;
        vec2 pane = abs(signedPane);
        vec2 aa = max(fwidth(vec2(across, elevation)), vec2(0.025));
        vec2 halfWindow = mix(vec2(1.05, 1.18), vec2(1.37, 1.57), glass);
        halfWindow = mix(halfWindow, vec2(0.48, 1.7), vesper);
        halfWindow = mix(halfWindow, vec2(1.2, 2.7), aurelia);
        vec2 shape = 1.0 - smoothstep(halfWindow, halfWindow + aa, pane);
        float window = shape.x * shape.y;
        structureGlazing = window;
        // Tall lancets terminate in a pointed arch. Thin alien light slits
        // leave broad obsidian panels, instead of another glass office facade.
        float archWidth = max(0.0, 1.2 - max(0.0, signedPane.y - 0.95) * 0.69);
        float arch = 1.0 - smoothstep(archWidth, archWidth + aa.x, pane.x);
        window *= mix(1.0, arch, aurelia);
        float windowFade = 1.0 - smoothstep(1.0, 3.8, max(aa.x, aa.y));
        float reflectSky = smoothstep(4.0, 75.0, elevation) * 0.12;
        vec3 glazing = vec3(0.085, 0.17, 0.205) + reflectSky * vec3(0.4, 0.65, 0.8);
        glazing = mix(glazing, vec3(0.065, 0.35, 0.39), vesper);
        glazing = mix(glazing, vec3(0.16, 0.22, 0.17), aurelia);
        float roomDepth = smoothstep(-halfWindow.y, halfWindow.y, signedPane.y);
        glazing *= .62 + roomDepth * .52;
        float mullion = max(structureLine(across, period.x / 2.0, .028), structureLine(elevation - .6, period.y / 2.0, .023));
        glazing = mix(glazing, vec3(.032, .055, .06), mullion * windowFade);
        float room = floor(across / period.x) * 17.0 + floor(elevation / period.y) * 31.0;
        float warmWindow = step(0.96, fract(sin(room * 8.41) * 183.71));
        glazing = mix(glazing, mix(vec3(0.66, 0.53, 0.32), vec3(0.47, 0.15, 0.61), vesper), warmWindow * 0.7);
        // At distance the narrow mullions converge to a stable average tint.
        float distantCoverage = mix(0.41, 0.79, glass);
        distantCoverage = mix(distantCoverage, 0.17, vesper);
        distantCoverage = mix(distantCoverage, 0.31, aurelia);
        diffuseColor.rgb = mix(diffuseColor.rgb, glazing, mix(distantCoverage, window, windowFade));
        float band = structureLine(elevation - 0.6, period.y, mix(0.13, 0.065, glass));
        diffuseColor.rgb *= 1.0 - band * 0.17 * windowFade;
        float pilaster = structureLine(across, period.x, 0.19);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.14, 1.08, 0.88),
          pilaster * aurelia * windowFade * (1.0 - window));
        float courses = structureLine(elevation, 0.28, 0.011);
        diffuseColor.rgb *= 1.0 - courses * brick * (1.0 - window) * detail * 0.17;
        totalEmissiveRadiance += glazing * window * (vesper * .23 + warmWindow * .25);
      }
    `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, .2, structureGlazing);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, .5, structureGlazing);');
  };
  return material;
}
