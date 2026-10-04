import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { ShaderChunk } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const BACKGROUND = 0xd9dbde;
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
 * and `maps` maps garment -> { normal, orm } material maps or null (kitRenderer.js). The ref exposes screenshot()
 * and view().
 */
const Viewer = forwardRef(function Viewer(
  { models, textures, collar, maps, onLoading, onLoaded, onError, lighting = "studio", mannequin = true, pixelRatio = 2 },
  ref,
) {
  const host = useRef(null);
  const three = useRef(null);

  // Scene, renderer, lights and controls: created once.
  useEffect(() => {
    const el = host.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatio));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // Studio light like a product shot: soft room fill (it carries the baked occlusion), a key from the upper
    // left that rakes across the folds, a weaker fill from the right and a rim from behind.
    scene.environmentIntensity = 0.45;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9fa3aa, 0.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(-2.2, 2.4, 1.6);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(2.5, 0.6, 2);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(1.5, 1.8, -2.5);
    scene.add(key, fill, rim);
    const hemi = scene.children.find((o) => o.isHemisphereLight);

    // Soft contact shadow under the feet.
    const shadowTex = new THREE.CanvasTexture(radialShadow());
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.5),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, -1.012, 0.03);
    scene.add(shadow);

    const kit = new THREE.Group();
    scene.add(kit);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false; // keep the kit in frame; orbit and zoom still work
    controls.minDistance = 0.6;
    controls.maxDistance = 8;
    controls.target.set(0, 0, 0);
    camera.position.set(0.26, 0.05, 1); // direction only: the distance is fitted below

    let fitted = false;
    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h);
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
      controls.update();
      renderer.render(scene, camera);
    });

    three.current = { renderer, scene, camera, controls, kit, shadow, garments: {}, lights: { key, fill, rim, hemi } };
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
      Object.entries({ ...models, mannequin: "mannequin" }).map(async ([garment, name]) => {
        if (t.garments[garment]?.name === name) return;
        const isMannequin = garment === "mannequin";
        const [gltf, ao] = await Promise.all([loadGlb(name), isMannequin ? Promise.resolve(null) : loadAo(name)]);
        if (cancelled || !three.current) return;
        const object = gltf.scene.clone(true);
        if (isMannequin) {
          if (t.garments[garment]) t.kit.remove(t.garments[garment].object);
          object.visible = t.showMannequin ?? true;
          t.garments[garment] = { name, object };
          t.kit.add(object);
          return;
        }
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
          }
        });
        if (t.garments[garment]) t.kit.remove(t.garments[garment].object);
        t.garments[garment] = { name, object };
        t.kit.add(object);
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
      if (garment === "mannequin") continue;
      object.traverse((o) => o.isMesh && applyMaps(o.material, maps?.[garment]));
    }
  }, [maps]);

  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.showMannequin = mannequin;
    if (t.garments.mannequin) t.garments.mannequin.object.visible = mannequin;
  }, [mannequin]);

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
    t.scene.background = new THREE.Color(preset.background);
  }, [lighting]);

  useImperativeHandle(ref, () => ({
    /**
     * PNG data URL of the 3D view. With `aspect` ("1:1", "16:9", "9:16") it renders a fresh image at that shape
     * (long side 2048 px), framing the whole kit from the current camera direction. `transparent` leaves out the
     * background and the floor shadow.
     */
    screenshot(aspect, { transparent = false } = {}) {
      const t = three.current;
      const background = t.scene.background;
      if (transparent) {
        t.scene.background = null;
        t.shadow.visible = false;
      }
      try {
        return capture(t, aspect);
      } finally {
        t.scene.background = background;
        t.shadow.visible = true;
      }
    },

    /** Turn the camera to a preset: "front", "three-quarter", "side", "back" or "close-up" (the chest). */
    view(preset) {
      const { camera, controls } = three.current;
      const close = preset === "close-up";
      controls.target.set(0, close ? 0.48 : 0, 0);
      const yaw = { front: 0, back: Math.PI, "three-quarter": 0.45, side: Math.PI / 2, "close-up": 0.15 }[preset] ?? 0;
      const d = close ? 0.95 : fitDistance(camera, controls, false);
      camera.position.set(
        controls.target.x + Math.sin(yaw) * d,
        controls.target.y + (close ? 0.08 : 0.25),
        controls.target.z + Math.cos(yaw) * d,
      );
      controls.update();
    },
  }));

  return <div className="viewer" ref={host} />;
});

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
  const centre = new THREE.Vector3(0, 0, 0); // the whole kit, even after a close-up
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
  const material = new THREE.MeshPhysicalMaterial({
    name, map, side: THREE.DoubleSide,
    roughness: FABRIC.roughness, metalness: 0, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x6a6a6a),
    aoMap: ao, aoMapIntensity: 1,
    normalMap: meshTexture(), normalScale: new THREE.Vector2(0.6, 0.6),
  });
  const relief = { value: null };
  const reliefUv = { value: new THREE.Matrix3() };
  material.userData = { relief, reliefUv };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.reliefMap = relief;
    shader.uniforms.reliefUv = reliefUv;
    let fs = shader.fragmentShader;
    // three.js applies the occlusion map to indirect light only; let it darken the key light too, the way contact
    // shadows look in a studio render.
    if (ao) {
      fs = fs.replace(
        "#include <aomap_fragment>",
        "#include <aomap_fragment>\n\treflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, 0.8);",
      );
    }
    fs = fs.replace(
      "#include <normalmap_pars_fragment>",
      "#include <normalmap_pars_fragment>\n#ifdef USE_RELIEF\nuniform sampler2D reliefMap;\nuniform mat3 reliefUv;\n#endif",
    );
    fs = fs.replace(
      "#include <normal_fragment_maps>",
      ShaderChunk.normal_fragment_maps.replace(
        "mapN.xy *= normalScale;",
        `mapN.xy *= normalScale;
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

// [intensity, x, y, z] per light; studio is the original rig.
const LIGHTING = {
  studio: { env: 0.45, background: BACKGROUND, lights: { key: [2.0, -2.2, 2.4, 1.6], fill: [0.4, 2.5, 0.6, 2], rim: [0.9, 1.5, 1.8, -2.5], hemi: [0.2] } },
  daylight: { env: 0.8, background: 0xe6edf3, lights: { key: [1.6, 1.2, 3, 2], fill: [0.6, -2, 1, 2], rim: [0.4, 0, 2, -2.5], hemi: [0.6] } },
  dramatic: { env: 0.15, background: 0x2b2e33, lights: { key: [2.8, -2.6, 1.8, 1.2], fill: [0.1, 2.5, 0.6, 2], rim: [1.8, 1.8, 1.5, -2.2], hemi: [0.05] } },
  flat: { env: 1.0, background: 0xeeeeee, lights: { key: [0.6, 0, 1, 3], fill: [0.4, 0, 0, 3], rim: [0.1, 0, 2, -2.5], hemi: [0.8] } },
};
export const LIGHTING_PRESETS = Object.keys(LIGHTING);

// The kit (shirt top to sock soles) is about 1.85 m tall and 0.95 m wide, centred on the orbit target.
const KIT_HEIGHT = 2.08;
const KIT_WIDTH = 1.04;

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

function radialShadow() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 64, 0, 128, 64, 120);
  g.addColorStop(0, "rgba(0,0,0,.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.setTransform(1, 0, 0, 0.5, 0, 32);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return c;
}

export default Viewer;
