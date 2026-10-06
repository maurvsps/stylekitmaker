import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { ShaderChunk } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { cuffLength } from "./library.js";

const BACKGROUND = 0x000000;
const draco = new DRACOLoader().setDecoderPath("draco/");
// The artifact build runs where WebAssembly may be refused: use the plain JS decoder there.
if (import.meta.env.VITE_NO_DOWNLOAD) draco.setDecoderConfig({ type: "js" });
const loader = new GLTFLoader().setDRACOLoader(draco);
// Hosts that refuse .glb get the same models as glTF JSON with the binary embedded (see KIT_MAKER.md).
const MODEL_EXT = import.meta.env.VITE_MODEL_EXT || ".glb";
const glbCache = new Map();
const loadGlb = (name) => {
  if (!glbCache.has(name)) glbCache.set(name, loader.loadAsync(`models/${name}${MODEL_EXT}`));
  return glbCache.get(name);
};
// Performance mesh fabric (staggered pinholes, like a Climacool / Dri-FIT knit) as a tiling normal map.
let mesh;
const meshTexture = () => (mesh ??= makeMeshFabric());
// Ambient occlusion baked by blender/make_kit.py (models/<name>_ao.png): contact shadows and fold depth.
const aoCache = new Map();
const loadAo = (name) => {
  if (!aoCache.has(name)) {
    aoCache.set(name, new THREE.TextureLoader().loadAsync(`models/${name}_ao.png`).then((t) => {
      t.flipY = false;
      return t;
    }, () => null));
  }
  return aoCache.get(name);
};


/**
 * The 3D kit. `models` maps garment -> model name (e.g. { shirt: "shirt_polo", shorts: "shorts", socks: "socks" }),
 * `textures` maps garment -> THREE.CanvasTexture (painted by the parent), `collar` is the shirt collar's own texture
 * `maps` maps garment -> { normal, orm } material maps or null (kitRenderer.js) and `templates` maps model name -> UV
 * template (where the ribbed trims are). The ref exposes screenshot() and view().
 */
const Viewer = forwardRef(function Viewer(
  { models, textures, collar, maps, templates, onLoading, onLoaded, onError, lighting = "studio", pixelRatio = 2 },
  ref,
) {
  const host = useRef(null);
  const three = useRef(null);

  // Scene, renderer, lights and controls: created once.
  useEffect(() => {
    const el = host.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // capture() renders before reading
    renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatio));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Soft shadows from the key light: sleeves on the torso, the collar on the chest, the shirt on the shorts.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // Studio light like a product shot: soft room fill (it carries the baked occlusion), a low key from the left
    // that rakes across the folds and lets the far side fall off, a weak fill from the right and a rim from behind.
    // The values are set by the lighting preset (LIGHTING.studio by default).
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9fa3aa, 0));
    const key = new THREE.DirectionalLight(0xffffff, 0);
    const fill = new THREE.DirectionalLight(0xffffff, 0);
    const rim = new THREE.DirectionalLight(0xffffff, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -1.15, right: 1.15, top: 1.15, bottom: -1.15, near: 0.5, far: 7 });
    key.shadow.radius = 5;
    key.shadow.blurSamples = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.006; // the cloth is thin: keep it from shadowing itself in stripes
    scene.add(key, fill, rim);
    const hemi = scene.children.find((o) => o.isHemisphereLight);

    const kit = new THREE.Group();
    scene.add(kit);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false; // keep the kit in frame; orbit and zoom still work
    controls.minDistance = 0.6;
    controls.maxDistance = 8;
    controls.target.set(0, CENTRE_Y, 0);
    camera.position.set(0.26, CENTRE_Y + 0.05, 1); // direction only: the distance is fitted below

    let fitted = false;
    // Draw only when something changed: the camera moved (or is still easing), a texture was repainted, or an
    // effect below called invalidate(). An idle kit costs no GPU time, which keeps phones cool and the page snappy.
    let dirty = true;
    let stamp = -1;
    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h);
      dirty = true;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!fitted) {
        fitDistance(camera, controls);
        fitted = true; // after that, leave the user's zoom alone (mobile browsers resize as the URL bar hides)
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    renderer.setAnimationLoop(() => {
      const t = three.current;
      const moved = controls.update();
      const now = t ? textureStamp(t) : 0;
      if (!moved && !dirty && now === stamp) return;
      dirty = false;
      stamp = now;
      renderer.render(scene, camera);
    });

    three.current = {
      renderer, scene, camera, controls, kit, garments: {}, lights: { key, fill, rim, hemi },
      invalidate: () => (dirty = true),
    };
    if (import.meta.env.DEV) window.__kit = three.current; // for screenshots and debugging in the dev server
    return () => {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Garment models: (re)load whichever changed and paint them with their texture.
  useEffect(() => {
    let cancelled = false;
    const t = three.current;
    onLoading?.();
    Promise.all(
      Object.entries(models).map(async ([garment, name]) => {
        if (t.garments[garment]?.name === name) return;
        const [gltf, ao] = await Promise.all([loadGlb(name), loadAo(name)]);
        if (cancelled || !three.current) return;
        const object = gltf.scene.clone(true);
        object.traverse((o) => {
          if (o.isMesh) o.castShadow = o.receiveShadow = true;
        });
        const anisotropy = t.renderer.capabilities.getMaxAnisotropy();
        object.traverse((o) => {
          if (o.isMesh) {
            // The collar mesh shows the collar's own, sharper texture (same design, see collarTemplate).
            const ownCollar = garment === "shirt" && o.material.name === "shirt_collar" && collar;
            const map = ownCollar ? collar : textures[garment];
            map.anisotropy = anisotropy;
            o.material = makeFabric(o.material.name, map, ao);
            o.userData.garment = garment;
            if (ownCollar) {
              // The material maps cover the whole garment: undo the collar texture's UV transform for them.
              const back = o.material.userData.reliefUv.value;
              o.onBeforeRender = () => back.copy(map.matrix).invert();
            }
            applyMaps(o.material, t.maps?.[garment]);
            applyRibs(o.material, t.templates?.[name]);
          }
        });
        if (t.garments[garment]) t.kit.remove(t.garments[garment].object);
        t.garments[garment] = { name, object };
        t.kit.add(object);
        t.invalidate();
      }),
    ).then(() => !cancelled && onLoaded?.(), (err) => {
      if (cancelled) return;
      console.error("Could not load the 3D kit", err);
      onError?.(`The 3D model could not be loaded: ${err.message || err}. Check the model files and Draco decoder.`);
    });
    return () => {
      cancelled = true;
    };
  }, [models, textures, onLoading, onLoaded, onError]);

  // Material maps (relief, roughness, metalness): attach or detach them when a garment starts or stops using them.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.maps = maps;
    for (const [garment, { object }] of Object.entries(t.garments)) {
      object.traverse((o) => o.isMesh && applyMaps(o.material, maps?.[garment]));
    }
    t.invalidate();
  }, [maps]);

  // Ribbed trims (collar, cuffs, sock tops) come from the UV templates, which may arrive after the models.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.templates = templates;
    for (const { name, object } of Object.values(t.garments)) {
      object.traverse((o) => o.isMesh && applyRibs(o.material, templates?.[name]));
    }
    t.invalidate();
  }, [templates]);

  // Lighting presets: the same rig, re-balanced.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const preset = LIGHTING[lighting] || LIGHTING.studio;
    for (const [name, [intensity, x, y, z]] of Object.entries(preset.lights)) {
      t.lights[name].intensity = intensity;
      if (x !== undefined) t.lights[name].position.set(x, y, z);
    }
    t.scene.environmentIntensity = preset.env;
    t.scene.background = new THREE.Color(BACKGROUND);
    t.renderer.toneMappingExposure = preset.exposure ?? 0.9;
    t.invalidate();
  }, [lighting]);

  useImperativeHandle(ref, () => ({
    /**
     * PNG data URL of the 3D view. With `aspect` ("1:1", "16:9", "9:16") it renders a fresh image at that shape
     * (long side 2048 px), framing the whole kit from the current camera direction. `transparent` leaves out the
     * background.
     */
    screenshot(aspect, { transparent = false } = {}) {
      const t = three.current;
      const background = t.scene.background;
      t.scene.background = transparent ? null : new THREE.Color(BACKGROUND);
      try {
        return capture(t, aspect);
      } finally {
        t.scene.background = background;
        t.invalidate();
      }
    },

    /** Turn the camera to a preset: "front", "three-quarter", "side", "back" or "close-up" (the chest). */
    view(preset) {
      const { camera, controls } = three.current;
      const close = preset === "close-up";
      controls.target.set(0, close ? 0.48 : CENTRE_Y, 0);
      const yaw = { front: 0, back: Math.PI, "three-quarter": 0.45, side: Math.PI / 2, "close-up": 0.15 }[preset] ?? 0;
      const d = close ? 0.75 : fitDistance(camera, controls, false);
      camera.position.set(
        controls.target.x + Math.sin(yaw) * d,
        controls.target.y + (close ? 0.06 : 0.12),
        controls.target.z + Math.cos(yaw) * d,
      );
      controls.update();
      three.current.invalidate();
    },
  }));

  return <div className="viewer" ref={host} />;
});

/** Sum of the versions of every texture the kit's materials draw: it changes whenever one is repainted. */
function textureStamp(t) {
  let s = 0;
  t.kit.traverse((o) => {
    const m = o.isMesh && o.material;
    if (!m) return;
    s += (m.map?.version || 0) + (m.userData.relief?.value?.version || 0) + (m.roughnessMap?.version || 0);
  });
  return s;
}

function capture(t, aspect) {
  if (!aspect) {
    t.renderer.render(t.scene, t.camera);
    return t.renderer.domElement.toDataURL("image/png");
  }
  const [aw, ah] = aspect.split(":").map(Number);
  const long = 2048;
  const w = aw >= ah ? long : Math.round((long * aw) / ah);
  const h = aw >= ah ? Math.round((long * ah) / aw) : long;
  const { renderer, camera, controls } = t;
  const cam = camera.clone();
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
  const centre = new THREE.Vector3(0, CENTRE_Y, 0); // the whole shirt, even after a close-up
  const dir = camera.position.clone().sub(controls.target).normalize();
  cam.position.copy(centre).addScaledVector(dir, fitDistance(cam, controls, false));
  cam.lookAt(centre);
  const ratio = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.render(t.scene, cam);
  const url = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(ratio);
  renderer.setSize(size.x, size.y, false);
  renderer.render(t.scene, camera);
  return url;
}

// ---------------------------------------------------------------- fabric material

/**
 * The fabric: physical material with sheen, the knit as a tiling normal map, baked occlusion. Its shader is extended
 * (onBeforeCompile) so the occlusion also darkens the key light, and so the garment's relief map (from the layers'
 * finishes) is added to the knit normal when present.
 */
function makeFabric(name, map, ao) {
  const inner = name.endsWith("_inner"); // the inner shell (blender/make_kit.py thicken)
  const sleeve = name.startsWith("shirt_sleeves");
  const material = new THREE.MeshPhysicalMaterial({
    name, map, side: THREE.DoubleSide,
    roughness: FABRIC.roughness, metalness: 0, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x6a6a6a),
    aoMap: ao, aoMapIntensity: sleeve ? 0.45 : 1,
    normalMap: meshTexture(), normalScale: new THREE.Vector2(0.6, 0.6),
  });
  if (inner) material.defines = { ...material.defines, USE_INNER: "" }; // its own shader program
  const relief = { value: null };
  const reliefUv = { value: new THREE.Matrix3() };
  const ribRects = { value: Array.from({ length: RIB_ZONES }, () => new THREE.Vector4(-1, -1, -1, -1)) };
  const ribPeriod = { value: 1 };
  material.userData = { relief, reliefUv, ribRects, ribPeriod };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.reliefMap = relief;
    shader.uniforms.reliefUv = reliefUv;
    shader.uniforms.ribRects = ribRects;
    shader.uniforms.ribPeriod = ribPeriod;
    let fs = shader.fragmentShader;
    // The inside is the reverse of the printed fabric. Keep its colour visible in the neck opening.
    fs = fs.replace(
      "#include <map_fragment>",
      `#ifdef USE_INNER
	vec4 innerColor = vec4( 0.65, 0.65, 0.65, 1.0 );
	#ifdef USE_MAP
		vec3 fabricInside = texture2D( map, vMapUv ).rgb;
		float fabricLight = dot( fabricInside, vec3( 0.2126, 0.7152, 0.0722 ) );
		innerColor.rgb = max( mix( fabricInside, vec3( fabricLight ), 0.15 ) * 0.82, vec3( 0.14 ) );
	#endif
	#ifdef USE_RIB
		// Rib trims (collar band, cuffs) are the same knit on both faces: show their own colour inside too.
		vec2 innerUv = ( reliefUv * vec3( vMapUv, 1.0 ) ).xy;
		for ( int i = 0; i < ${RIB_ZONES}; i ++ ) {
			vec4 r = ribRects[ i ];
			if ( innerUv.x >= r.x && innerUv.x <= r.z && innerUv.y >= r.y && innerUv.y <= r.w ) innerColor = texture2D( map, vMapUv ) * 0.85;
		}
	#endif
	diffuseColor *= vec4( innerColor.rgb, 1.0 );
#else
	#include <map_fragment>
#endif`,
    );
    // three.js applies the occlusion map to indirect light only; let it darken the key light too, the way contact
    // shadows look in a studio render.
    if (ao) {
      fs = fs.replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>\n\treflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, ${sleeve ? "0.3" : "0.8"});`,
      );
    }
    fs = fs.replace(
      "#include <normalmap_pars_fragment>",
      `#include <normalmap_pars_fragment>
uniform mat3 reliefUv;
#ifdef USE_RELIEF
uniform sampler2D reliefMap;
#endif
#ifdef USE_RIB
uniform vec4 ribRects[ ${RIB_ZONES} ];
uniform float ribPeriod;
#endif`,
    );
    fs = fs.replace(
      "#include <normal_fragment_maps>",
      ShaderChunk.normal_fragment_maps.replace(
        "mapN.xy *= normalScale;",
        `mapN.xy *= normalScale;
	#ifdef USE_ROUGHNESSMAP
		// The ORM red channel keeps the fabric knit off smooth sponsor prints while leaving relief intact.
		mapN.xy *= texture2D( roughnessMap, vRoughnessMapUv ).r;
	#endif
	#ifdef USE_RIB
		// Rib knit on the trims: raised cords running along the band (the island's q axis is the texture's v).
		vec2 rawUv = ( reliefUv * vec3( vMapUv, 1.0 ) ).xy;
		float rib = 0.0;
		for ( int i = 0; i < ${RIB_ZONES}; i ++ ) {
			vec4 r = ribRects[ i ];
			rib = max( rib, step( r.x, rawUv.x ) * step( rawUv.x, r.z ) * step( r.y, rawUv.y ) * step( rawUv.y, r.w ) );
		}
		if ( rib > 0.5 ) {
			float phase = rawUv.x / ribPeriod;
			float fade = clamp( 1.5 - 2.0 * fwidth( phase ), 0.0, 1.0 ); // fade out where the cords get too small to draw
			float slope = sin( 6.2831853 * phase );
			slope = sign( slope ) * pow( abs( slope ), 0.6 ) * 0.5 * fade;
			mapN = normalize( vec3( slope + mapN.x * 0.25, mapN.y * 0.25, 1.0 ) );
		}
	#endif
	#ifdef USE_RELIEF
		vec3 reliefN = texture2D( reliefMap, ( reliefUv * vec3( vMapUv, 1.0 ) ).xy ).xyz * 2.0 - 1.0;
		mapN = normalize( vec3( mapN.xy + reliefN.xy, mapN.z * reliefN.z ) ); // whiteout blend: knit on top of the relief
	#endif`,
      ),
    );
    shader.fragmentShader = fs;
  };
  return material;
}

const FABRIC = { roughness: 0.8 };

/** Attach a garment's material maps ({ normal, orm } or null) to a fabric material. */
function applyMaps(material, maps) {
  const { relief } = material.userData;
  const orm = maps?.orm || null;
  const normal = maps?.normal || null;
  if (relief.value === normal && material.roughnessMap === orm) return;
  relief.value = normal;
  material.roughnessMap = material.metalnessMap = orm;
  // With the map, the values come from it (G = roughness, B = metalness); without, the plain fabric.
  material.roughness = orm ? 1 : FABRIC.roughness;
  material.metalness = orm ? 1 : 0;
  if (normal) material.defines = { ...material.defines, USE_RELIEF: "" };
  else if (material.defines) delete material.defines.USE_RELIEF;
  material.needsUpdate = true;
}

// Ribbed trims: up to RIB_ZONES rectangles of the texture (the collar, each cuff, each sock top).
const RIB_ZONES = 4;
const RIB_SPACING = 0.0026; // metres from cord to cord

/** Texture rectangles [u0, v0, u1, v1] of a template's ribbed trims, and the cord spacing in texture units. */
function ribZones(template) {
  const zones = [];
  let scale = 1;
  for (const isl of Object.values(template?.islands || {})) {
    const [x, y, w, h] = isl.rect;
    scale = isl.scale;
    if (isl.kind === "collar" || isl.kind === "sock_top") zones.push([x, y, x + w, y + h]);
    else if (isl.kind === "sleeve" && isl.length) {
      // The cuff: the last cuffLength of the sleeve (q runs from 0 at the shoulder to -length at the cuff).
      zones.push([x, y + isl.scale * (isl.qmax + isl.length - cuffLength(isl)), x + w, y + h]);
    }
  }
  return { zones: zones.slice(0, RIB_ZONES), period: RIB_SPACING * scale };
}

/** Point a fabric material's rib uniforms at a template's trims (none: plain knit everywhere). */
function applyRibs(material, template) {
  const { ribRects, ribPeriod } = material.userData;
  const { zones, period } = ribZones(template);
  ribRects.value.forEach((v, i) => v.set(...(zones[i] || [-1, -1, -1, -1])));
  ribPeriod.value = period;
  const on = zones.length > 0;
  if (on === "USE_RIB" in (material.defines || {})) return;
  if (on) material.defines = { ...material.defines, USE_RIB: "" };
  else delete material.defines.USE_RIB;
  material.needsUpdate = true;
}

// [intensity, x, y, z] per light; the key light casts the shadows.
const LIGHTING = {
  studio: {
    env: 0.2, exposure: 1.05,
    lights: { key: [3.0, -2.6, 1.6, 1.2], fill: [0.35, 2.6, 0.4, 1.4], rim: [1.6, 1.5, 1.8, -2.5], hemi: [0.04] },
  },
  daylight: { env: 0.8, lights: { key: [1.6, 1.2, 3, 2], fill: [0.6, -2, 1, 2], rim: [0.4, 0, 2, -2.5], hemi: [0.6] } },
  dramatic: { env: 0.15, lights: { key: [2.8, -2.6, 1.8, 1.2], fill: [0.1, 2.5, 0.6, 2], rim: [1.8, 1.8, 1.5, -2.2], hemi: [0.05] } },
  flat: { env: 1.0, lights: { key: [0.6, 0, 1, 3], fill: [0.4, 0, 0, 3], rim: [0.1, 0, 2, -2.5], hemi: [0.8] } },
};
export const LIGHTING_PRESETS = Object.keys(LIGHTING);

// The view frames the shirt alone (no mannequin, shorts or socks): hem to collar is about 0.75 m, sleeve tip to
// sleeve tip about 0.6 m, round CENTRE_Y. The sizes below leave a margin.
const CENTRE_Y = 0.35;
const KIT_HEIGHT = 0.95;
const KIT_WIDTH = 0.85;

/** Distance at which the whole kit fits the view, with a margin; moves the camera there unless apply is false. */
function fitDistance(camera, controls, apply = true) {
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = 1.08 * Math.max(KIT_HEIGHT / 2 / tan, KIT_WIDTH / 2 / (tan * camera.aspect));
  if (apply) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, d);
    controls.update();
  }
  return d;
}

function makeMeshFabric() {
  // One tile = 2 x 2 cells of a staggered grid of small holes, as a height field turned into normals.
  const n = 64;
  const h = new Float32Array(n * n);
  const holes = [[0.25, 0.25], [0.75, 0.25], [0, 0.75], [0.5, 0.75], [1, 0.75]];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let d = 1;
      for (const [hx, hy] of holes) {
        for (const oy of [-1, 0, 1]) {
          d = Math.min(d, Math.hypot(x / n - hx, y / n - hy - oy));
        }
      }
      h[y * n + x] = Math.min(1, d / 0.16) ** 0.8; // 0 in a hole, rising to the knit surface
    }
  }
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(n, n);
  const at = (x, y) => h[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      img.data[i] = 128 + 127 * (-dx / len);
      img.data[i + 1] = 128 + 127 * (dy / len);
      img.data[i + 2] = 128 + 127 * (1 / len);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(140, 140); // about 4 mm per cell on the shirt
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

export default Viewer;
