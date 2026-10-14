import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { ShaderChunk } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { cuffLength } from "./library.js";
import { heightToNormal } from "./kitTexture.js";

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
  {
    models, textures, collar, maps, templates, onLoading, onLoaded, onError, lighting = "studio", pixelRatio = 2, handTool = false,
    rig = "studio", turntableLighting = "soft", freeView = false, fkcModel = false, baseColor = "#ffffff",
  },
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
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
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
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -1.15, right: 1.15, top: 1.15, bottom: -1.15, near: 0.5, far: 7 });
    key.shadow.radius = 4;
    key.shadow.blurSamples = 8;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.006; // the cloth is thin: keep it from shadowing itself in stripes
    scene.add(key, fill, rim);
    const hemi = scene.children.find((o) => o.isHemisphereLight);

    const kit = new THREE.Group();
    scene.add(kit);
    const turntableLights = makeTurntableLights();
    turntableLights.visible = false;
    scene.add(turntableLights);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = false; // keep the kit in frame; orbit and zoom still work
    controls.minDistance = 0.6;
    controls.maxDistance = 8;
    controls.target.set(0, CENTRE_Y, 0);
    controls.addEventListener("change", () => {
      dirty = true;
    });
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
      if (three.current?.turn.on && !three.current.turn.free) placeTurntableCamera(three.current);
      else if (!fitted) {
        fitDistance(camera, controls);
        fitted = true; // after that, leave the user's zoom alone (mobile browsers resize as the URL bar hides)
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    renderer.setAnimationLoop((time) => {
      const t = three.current;
      let moved = controls.update();
      const turn = t?.turn;
      if (turn?.on && !turn.free && turn.rotating) {
        turn.angle = (time * TURN_SPEED) % (Math.PI * 2);
        kit.rotation.y = turn.angle;
        moved = true;
      }
      if (turn?.on && turn.free && moved) followCamera(t);
      const now = t ? textureStamp(t) : 0;
      if (!moved && !dirty && now === stamp) return;
      dirty = false;
      stamp = now;
      renderer.render(scene, camera);
    });

    three.current = {
      renderer, scene, camera, controls, kit, garments: {}, materials: [], lights: { key, fill, rim, hemi }, turntableLights,
      invalidate: () => (dirty = true),
      // Turntable rig: the camera stays put and the kit turns (see setRig).
      turn: { on: false, free: false, angle: 0, rotating: false, zoom: 1, pan: new THREE.Vector2(), drag: null },
      handTool: false,
    };
    // Turntable: drag turns the kit (or pans with the hand tool), the wheel zooms. Free view uses the orbit controls.
    const dom = renderer.domElement;
    const onDown = (e) => {
      const t = three.current;
      if (!t?.turn.on || t.turn.free || (e.pointerType === "mouse" && e.button !== 0)) return;
      t.turn.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, angle: t.turn.angle, pan: t.turn.pan.clone(), panning: t.handTool };
      dom.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      const t = three.current;
      const drag = t?.turn.drag;
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.panning) {
        const span = 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const perPixel = span / (el.clientHeight || 1);
        t.turn.pan.set(drag.pan.x - dx * perPixel, drag.pan.y + dy * perPixel);
        placeTurntableCamera(t);
      } else {
        t.turn.rotating = false;
        t.turn.angle = drag.angle + dx * TURN_PER_PIXEL;
        kit.rotation.y = t.turn.angle;
      }
      t.invalidate();
    };
    const onUp = (e) => {
      const t = three.current;
      if (t?.turn.drag?.id === e.pointerId) t.turn.drag = null;
    };
    const onWheel = (e) => {
      const t = three.current;
      if (!t?.turn.on || t.turn.free) return;
      e.preventDefault();
      t.turn.zoom = THREE.MathUtils.clamp(t.turn.zoom * Math.exp(e.deltaY * 0.001), 0.3, 1.8);
      placeTurntableCamera(t);
      t.invalidate();
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointercancel", onUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    if (import.meta.env.DEV) window.__kit = three.current; // for screenshots and debugging in the dev server
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("wheel", onWheel);
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const controls = three.current?.controls;
    if (!controls) return;
    three.current.handTool = handTool;
    controls.enablePan = handTool;
    controls.mouseButtons.LEFT = handTool ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.touches.ONE = handTool ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }, [handTool]);

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
        const seams = seamMap(name, object);
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
            if (seams && !o.material.name.endsWith("_inner")) {
              o.material.userData.seam.value = seams;
              o.material.defines = { ...o.material.defines, USE_SEAM: "" };
            }
          }
        });
        if (t.garments[garment]) t.kit.remove(t.garments[garment].object);
        object.visible = !t.fkc?.visible;
        t.garments[garment] = { name, object };
        t.kit.add(object);
        t.materials = [];
        t.kit.traverse((o) => {
          if (o.isMesh && o.material) t.materials.push(o.material);
        });
        t.renderer.shadowMap.needsUpdate = true;
        t.invalidate();
      }),
    ).then(() => !cancelled && onLoaded?.(), (err) => {
      if (cancelled) return;
      console.error("Could not load the 3D kit", err);
      console.error("3D model failed to load:", err);
      onError?.("The 3D model could not be shown. Try another camera view or reload the page.");
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
    t.fkc?.traverse((o) => o.isMesh && applyMaps(o.material, maps?.shirt));
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

  // FIFA Kit Creator's shirt (assets/third_party/fifakitcreator, used with permission): shown instead of ours. Its
  // geometry gets new UVs in the selected shirt template's layout, so every layer paints on it like on our shirt.
  const template = templates?.[models.shirt];
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    let cancelled = false;
    const show = (on) => {
      if (t.fkc) t.fkc.visible = on;
      for (const g of Object.values(t.garments)) g.object.visible = !on;
      t.invalidate();
    };
    if (!fkcModel) {
      show(false);
      return;
    }
    if (!template) return; // wait for the UV template
    Promise.all([loadFkcFiles(), loadGlb(models.shirt)]).then(([files, ours]) => {
      if (cancelled || !three.current) return;
      if (t.fkc) {
        t.kit.remove(t.fkc);
        t.fkc.traverse((o) => o.isMesh && (o.geometry.dispose(), o.material.dispose()));
      }
      const group = buildFkcShirt(files, template, textures.shirt, t.maps?.shirt, t.renderer.capabilities.getMaxAnisotropy(), ours.scene);
      t.fkc = group;
      t.kit.add(group);
      t.materials = [];
      t.kit.traverse((o) => o.isMesh && o.material && t.materials.push(o.material));
      show(true);
    }, (err) => {
      console.error("FIFA Kit Creator model", err);
      if (!cancelled) onError?.("The FIFA Kit Creator model files are not in assets/third_party/fifakitcreator/ yet (see CREDIT.txt there for the list).");
    });
    return () => {
      cancelled = true;
    };
  }, [fkcModel, template, textures, onError]);

  // Camera rig: the studio orbit, or the turntable (fixed camera, the kit turns) with an optional free view.
  useEffect(() => {
    const t = three.current;
    if (t) setRig(t, rig === "turntable", freeView);
  }, [rig, freeView]);

  // Lighting presets: the same rig, re-balanced.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    if (rig === "turntable") {
      applyTurntableLighting(t, turntableLighting);
      return;
    }
    const preset = LIGHTING[lighting] || LIGHTING.studio;
    for (const [name, [intensity, x, y, z]] of Object.entries(preset.lights)) {
      t.lights[name].intensity = intensity;
      if (x !== undefined) t.lights[name].position.set(x, y, z);
    }
    t.scene.environmentIntensity = preset.env;
    t.scene.background = new THREE.Color(BACKGROUND);
    t.renderer.toneMappingExposure = preset.exposure ?? 0.9;
    t.renderer.shadowMap.needsUpdate = true;
    t.invalidate();
  }, [lighting, turntableLighting, rig]);

  useImperativeHandle(ref, () => ({
    /**
     * PNG data URL of the 3D view. With `aspect` ("1:1", "16:9", "9:16") it renders a fresh image at that shape
     * (long side 2048 px), framing the whole kit from the current camera direction. `transparent` leaves out the
     * background.
     */
    screenshot(aspect, { transparent = false, long = 3840 } = {}) {
      const t = three.current;
      const background = t.scene.background;
      t.scene.background = transparent ? null : new THREE.Color(BACKGROUND);
      try {
        return capture(t, aspect, long);
      } finally {
        t.scene.background = background;
        t.invalidate();
      }
    },

    /** Turn the camera to a preset: "front", "three-quarter", "side", "back" or "close-up" (the chest). */
    view(preset) {
      const t = three.current;
      if (t.turn.on) return turntableView(t, preset);
      const { camera, controls } = t;
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

  return <div className={`viewer${handTool ? " hand-tool" : ""}`} ref={host} />;
});

// ---------------------------------------------------------------- turntable rig
// The alternative viewer of the Open Kit Creator layout, modelled on how fifakitcreator.com shows a kit: a long lens
// (20 degrees) that stays put while the kit itself turns, named angles, a slow spin, and a free view where the
// lights travel with the camera so the side facing the viewer is always lit.

const TURN_FOV = 20;
const STUDIO_FOV = 30;
const TURN_PER_PIXEL = 0.02; // radians the kit turns per pixel dragged
const TURN_SPEED = 0.0006; // radians per millisecond while spinning (about one turn in 10 s)
/** Kit angle per named view (0 shows the front). */
export const TURNTABLE_VIEWS = [
  ["front", "Front", 0],
  ["side", "Side", -Math.PI * 0.2],
  ["side_right", "Side right", Math.PI * 0.2],
  ["lateral_left", "Lateral left", -Math.PI / 2],
  ["lateral_right", "Lateral right", Math.PI / 2],
  ["back", "Back", Math.PI],
  ["side_back", "Side (back)", Math.PI * 0.8],
];
const VIEW_ANGLE = Object.fromEntries(TURNTABLE_VIEWS.map(([id, , a]) => [id, a]));
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Six lights the turntable presets balance: ambient, two from the front, two rims from above behind, and sky. */
function makeTurntableLights() {
  const group = new THREE.Group();
  group.name = "turntable-lights";
  const names = ["ambient", "frontLeft", "frontRight", "rimLeft", "rimRight", "sky"];
  const lights = [
    new THREE.AmbientLight(0xffffff, 0),
    ...[0, 1, 2, 3].map(() => new THREE.DirectionalLight(0xffffff, 0)),
    new THREE.HemisphereLight(0xffffff, 0x000000, 0),
  ];
  lights.forEach((l, i) => {
    l.name = names[i];
    l.userData.base = new THREE.Vector3(0, 1, 0);
    group.add(l);
  });
  return group;
}

// Presets: per light [intensity, [x, y, z] direction, colour, ground colour (sky light)]; env = room reflections.
// Keep the ambient low: it has no direction, so it flattens relief and shows no gloss. The finishes and material
// effects (satin, metallic, quilted, mesh...) read through the directional lights and the room reflections.
const TURNTABLE_LIGHTING = {
  soft: {
    label: "Soft box", env: 0.65, exposure: 1,
    lights: { ambient: [0.3], frontLeft: [1.7, [-0.7, 0.45, 1]], frontRight: [0.8, [0.6, 0.1, 1]], rimLeft: [0.9, [-0.5, 2, -1]], rimRight: [0.9, [0.5, 2, -1]], sky: [0.5, [0, 1, 0], "#ffffff", "#5a5a5a"] },
  },
  studio: {
    label: "Studio", env: 0.5, exposure: 1,
    lights: { frontLeft: [1.1, [-0.6, 0.3, 1]], frontRight: [0.6, [0.5, 0, 1]], rimLeft: [0.5, [-0.5, 2, -1]], rimRight: [0.5, [0.5, 2, -1]], sky: [1.5, [0, 1, 0], "#ffffff", "#5a5a5a"] },
  },
  contrast: {
    label: "Contrast", env: 0.4, exposure: 1,
    lights: { frontLeft: [1.6, [-0.3, 1, 1]], frontRight: [0.5, [0, -1, 1]], rimLeft: [0.6, [-0.5, 2, -1]], rimRight: [0.6, [0.5, 2, -1]], sky: [1.4, [0, 1, 0], "#ffffff", "#000000"] },
  },
  day: {
    label: "Day", env: 0.5, exposure: 1,
    lights: { frontLeft: [2.6, [0, 40, 30], "#fff5e5"], sky: [1.4, [0, 50, 0], "#4d8fff", "#ffc880"] },
  },
  dayLeft: {
    label: "Day (left)", env: 0.5, exposure: 1,
    lights: { frontLeft: [2.6, [-30, 52, 30], "#fff5e5"], sky: [1.4, [0, 50, 0], "#4d8fff", "#ffc880"] },
  },
  dayRight: {
    label: "Day (right)", env: 0.5, exposure: 1,
    lights: { frontLeft: [2.6, [30, 52, 30], "#fff5e5"], sky: [1.4, [0, 50, 0], "#4d8fff", "#ffc880"] },
  },
  night: {
    label: "Night", env: 0.3, exposure: 1,
    lights: { ambient: [0.2], frontLeft: [1.6, [-0.5, 1, 1]], frontRight: [1.4, [0.5, 1, 1]], rimLeft: [1.2, [-0.5, 1, -1]], rimRight: [1.2, [0.5, 1, -1]] },
  },
  darkLeft: {
    label: "Dark (left)", env: 0.2, exposure: 1,
    lights: { ambient: [0.15], frontRight: [3.6, [-4, 3, 1]], rimLeft: [0.6, [-0.5, 2, -1]], rimRight: [0.6, [0.5, 2, -1]] },
  },
  darkRight: {
    label: "Dark (right)", env: 0.2, exposure: 1,
    lights: { ambient: [0.15], frontRight: [3.6, [4, 3, 1]], rimLeft: [0.6, [-0.5, 2, -1]], rimRight: [0.6, [0.5, 2, -1]] },
  },
  environment: { label: "Environment only", env: 1.1, exposure: 1, lights: {} },
};
export const TURNTABLE_LIGHTING_PRESETS = Object.entries(TURNTABLE_LIGHTING).map(([id, p]) => [id, p.label]);

function applyTurntableLighting(t, name) {
  const preset = TURNTABLE_LIGHTING[name] || TURNTABLE_LIGHTING.soft;
  for (const light of t.turntableLights.children) {
    const [intensity = 0, dir, color, ground] = preset.lights[light.name] || [];
    light.intensity = intensity;
    if (dir) light.userData.base.set(...dir).normalize().multiplyScalar(5);
    light.color.set(color || "#ffffff");
    if (light.isHemisphereLight) light.groundColor.set(ground || "#000000");
  }
  t.scene.environmentIntensity = preset.env;
  t.renderer.toneMappingExposure = preset.exposure;
  followCamera(t);
  t.invalidate();
}

/** Free view: the lights and the room reflections turn with the camera, so the side facing it stays lit. */
function followCamera(t) {
  const { camera, controls, turntableLights, scene, turn } = t;
  const azimuth = turn.on && turn.free ? Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) : 0;
  for (const light of turntableLights.children) light.position.copy(light.userData.base).applyAxisAngle(Y_AXIS, azimuth);
  scene.environmentRotation.y = azimuth;
}

/** Fixed turntable camera: straight at the kit's centre, at the fitted distance times the zoom, moved by the pan. */
function placeTurntableCamera(t) {
  const { camera, controls, turn } = t;
  controls.target.set(turn.pan.x, CENTRE_Y + turn.pan.y, 0);
  const d = fitDistance(camera, controls, false) * turn.zoom;
  camera.position.set(turn.pan.x, CENTRE_Y + turn.pan.y, d);
  camera.lookAt(controls.target);
  controls.update();
}

/** Free-view camera at the angle the turntable shows (turning the kit by a equals orbiting the camera by -a). */
function placeOrbitCamera(t, angle) {
  const { camera, controls } = t;
  controls.target.set(0, CENTRE_Y, 0);
  const d = fitDistance(camera, controls, false);
  camera.position.set(Math.sin(-angle) * d, CENTRE_Y, Math.cos(-angle) * d);
  controls.update();
}

function setRig(t, on, free) {
  const { turn, camera, controls, kit, lights, turntableLights } = t;
  const was = turn.on;
  if (on && !was) {
    // A fresh turntable starts at the front, unzoomed.
    turn.angle = 0;
    turn.zoom = 1;
    turn.pan.set(0, 0);
    turn.rotating = false;
  } else if (on && turn.free && !free) {
    // Leaving the free view: keep looking from where the camera was (orbiting by a equals turning the kit by -a).
    turn.angle = -Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  }
  turn.on = on;
  turn.free = on && free;
  turn.drag = null;
  for (const light of Object.values(lights)) light.visible = !on;
  turntableLights.visible = on;
  camera.fov = on ? TURN_FOV : STUDIO_FOV;
  camera.updateProjectionMatrix();
  if (!on) {
    turn.rotating = false;
    kit.rotation.y = 0;
    controls.enabled = true;
    if (was) {
      controls.target.set(0, CENTRE_Y, 0);
      camera.position.set(0.26, CENTRE_Y + 0.05, 1);
      fitDistance(camera, controls);
    }
  } else if (turn.free) {
    turn.rotating = false;
    kit.rotation.y = 0;
    controls.enabled = true;
    placeOrbitCamera(t, turn.angle);
  } else {
    controls.enabled = false;
    kit.rotation.y = turn.angle;
    placeTurntableCamera(t);
  }
  followCamera(t);
  t.renderer.shadowMap.needsUpdate = true;
  t.invalidate();
}

/** A named turntable view, "rotate" to spin, or a studio preset name (mapped to the nearest angle). */
function turntableView(t, preset) {
  const { turn, kit } = t;
  const alias = { "three-quarter": "side_right", "close-up": "front" };
  const id = alias[preset] || preset;
  if (id === "rotate") {
    if (turn.free) setRig(t, true, false);
    turn.rotating = true;
    t.invalidate();
    return;
  }
  turn.rotating = false;
  turn.angle = VIEW_ANGLE[id] ?? 0;
  turn.pan.set(0, 0);
  turn.zoom = preset === "close-up" ? 0.55 : 1;
  if (turn.free) placeOrbitCamera(t, turn.angle);
  else {
    kit.rotation.y = turn.angle;
    placeTurntableCamera(t);
  }
  followCamera(t);
  t.invalidate();
}

/** Sum of the versions of every texture the kit's materials draw: it changes whenever one is repainted. */
function textureStamp(t) {
  let s = 0;
  const mats = t.materials;
  if (!mats || mats.length === 0) return 0;
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    s += (m.map?.version || 0) + (m.userData.relief?.value?.version || 0) + (m.roughnessMap?.version || 0) + (m.iridescenceMap?.version || 0);
  }
  return s;
}

/**
 * Render the scene to a PNG data URL, `long` pixels on the long side (clamped to what the GPU allows). Without an
 * aspect it keeps the view as framed on screen; with one it frames the whole shirt. The key light's shadow map is
 * enlarged for the shot, so shadows stay crisp at 4K.
 */
function capture(t, aspect, long = 3840) {
  const { renderer, camera, controls, lights } = t;
  const max = Math.min(long, renderer.capabilities.maxTextureSize || long, 8192);
  let cam = camera;
  let ratio = camera.aspect;
  if (aspect) {
    const [aw, ah] = aspect.split(":").map(Number);
    ratio = aw / ah;
    cam = camera.clone();
    cam.aspect = ratio;
    cam.updateProjectionMatrix();
    const centre = new THREE.Vector3(0, CENTRE_Y, 0); // the whole shirt, even after a close-up
    const dir = camera.position.clone().sub(controls.target).normalize();
    cam.position.copy(centre).addScaledVector(dir, fitDistance(cam, controls, false));
    cam.lookAt(centre);
  }
  const w = ratio >= 1 ? max : Math.round(max * ratio);
  const h = ratio >= 1 ? Math.round(max / ratio) : max;

  const key = lights.key;
  const shadowSize = key.shadow.mapSize.x;
  const resizeShadow = (n) => {
    key.shadow.mapSize.set(n, n);
    key.shadow.map?.dispose();
    key.shadow.map = null;
    renderer.shadowMap.needsUpdate = true;
  };
  const pixelRatio = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  try {
    resizeShadow(Math.min(4096, renderer.capabilities.maxTextureSize || 2048));
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.render(t.scene, cam);
    return renderer.domElement.toDataURL("image/png");
  } finally {
    resizeShadow(shadowSize);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(size.x, size.y, false);
    renderer.render(t.scene, camera);
  }
}


// ---------------------------------------------------------------- FIFA Kit Creator shirt
// Their models are in centimetres on a mannequin (the shirt from y = 162 to 298); ours are in metres with the hem at
// 0. Their own UVs stay as a second channel (uv1) for their fold normal map; the first channel is rebuilt in our
// template's layout, piece by piece, in each island's frame (front and back: metres across and up from the hem;
// sleeves: around from the top line and down from the shoulder; collar: around from the front centre). Each piece is
// stretched to its island's extent, so a layer placed on our shirt lands in the same place on theirs.

const FKC_DIR = "third_party/fifakitcreator/";
const FKC_HEIGHT = 0.75; // metres, hem to the top of the shoulders, like our shirt
let fkcFiles;
function loadFkcFiles() {
  const obj = new OBJLoader();
  const firstGeometry = (group) => {
    let g = null;
    group.traverse((o) => !g && o.isMesh && (g = o.geometry));
    return g;
  };
  fkcFiles ??= Promise.all([
    obj.loadAsync(`${FKC_DIR}jersey_ss.obj`),
    obj.loadAsync(`${FKC_DIR}collar_0.obj`),
    new THREE.TextureLoader().loadAsync(`${FKC_DIR}jersey_24.png`).catch(() => null),
  ]).then(([jersey, collar, folds]) => {
    if (folds) {
      folds.colorSpace = THREE.NoColorSpace;
      folds.channel = 1; // their UVs
    }
    return { jersey: firstGeometry(jersey), collar: firstGeometry(collar), folds };
  });
  fkcFiles.catch(() => (fkcFiles = null)); // a missing file can be added and retried
  return fkcFiles;
}

function buildFkcShirt(files, template, map, maps, anisotropy, ours) {
  const group = new THREE.Group();
  group.name = "fifakitcreator-shirt";
  map.anisotropy = anisotropy;
  const parts = [
    ["shirt_body", files.jersey, (g) => remapJersey(g, template, ours)],
    ["shirt_collar", files.collar, (g) => remapCollar(g, template)],
  ];
  for (const [name, source, remap] of parts) {
    const g = (source.index ? source.toNonIndexed() : source.clone());
    g.setAttribute("uv1", g.attributes.uv.clone());
    remap(g);
    const material = makeFabric(name, map, null);
    if (name === "shirt_body" && files.folds) {
      material.normalMap = files.folds; // their folds and creases instead of our knit tile
      material.normalScale.set(1, 1);
    }
    applyMaps(material, maps);
    applyRibs(material, template);
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.garment = "shirt";
    group.add(mesh);
  }
  // Their units are not metres (the shirt is 136 units tall): scale it to our shirt's height, hem on our hem line
  // (y = 0), centred on the vertical axis.
  const box = new THREE.Box3().setFromBufferAttribute(files.jersey.attributes.position);
  const s = FKC_HEIGHT / (box.max.y - box.min.y);
  group.scale.setScalar(s);
  group.position.set(-s * (box.min.x + box.max.x) / 2, -s * box.min.y, -s * (box.min.z + box.max.z) / 2);
  return group;
}

/** An island's texture position of a point (p, q) of its frame (metres). */
function islandUv(isl, p, q) {
  return [isl.rect[0] + isl.scale * (p - isl.pmin), isl.rect[1] + isl.scale * (isl.qmax - q)];
}
const islandBox = (isl) => ({ p0: isl.pmin, p1: isl.pmin + isl.rect[2] / isl.scale, q0: isl.qmax - isl.rect[3] / isl.scale, q1: isl.qmax });
const lerp = (x, a0, a1, b0, b1) => b0 + ((x - a0) / (a1 - a0 || 1)) * (b1 - b0);
/** An angle (-PI..PI, 0 = the reference line) spread over [p0, p1] with 0 at p = 0 when the range spans it. */
const angleToP = (a, box) => (box.p0 < 0 && box.p1 > 0 ? (a < 0 ? (-a / Math.PI) * box.p0 : (a / Math.PI) * box.p1) : lerp(a, -Math.PI, Math.PI, box.p0, box.p1));
/** Keep a triangle's three angles on one side of the seam (where -PI meets PI). */
function unwrap(a) {
  if (Math.max(...a) - Math.min(...a) <= Math.PI) return a;
  return a.map((x) => (x < 0 ? x + 2 * Math.PI : x));
}

function remapJersey(g, T, ours) {
  const P = g.attributes.position;
  const uv = g.attributes.uv1; // their layout: tells which triangles belong to one piece
  const n = P.count;
  const tris = n / 3;
  const v = (i) => new THREE.Vector3(P.getX(i), P.getY(i), P.getZ(i));

  // Their UV pieces: triangles that share a UV corner belong together.
  const parent = Array.from({ length: tris }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const corner = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(uv.getX(i) * 1e5)}_${Math.round(uv.getY(i) * 1e5)}`;
    const tri = (i / 3) | 0;
    if (corner.has(key)) parent[find(tri)] = find(corner.get(key));
    else corner.set(key, tri);
  }

  // Body width from the hem: anything further out is a sleeve.
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    yMin = Math.min(yMin, P.getY(i));
    yMax = Math.max(yMax, P.getY(i));
  }
  let half = 0;
  for (let i = 0; i < n; i++) if (P.getY(i) < yMin + 0.25 * (yMax - yMin)) half = Math.max(half, Math.abs(P.getX(i)));
  const pieces = new Map(); // root -> { tris, sx }
  for (let t = 0; t < tris; t++) {
    const r = find(t);
    if (!pieces.has(r)) pieces.set(r, { tris: [], sx: 0, ax: 0 });
    const pc = pieces.get(r);
    pc.tris.push(t);
    for (let k = 0; k < 3; k++) {
      pc.sx += P.getX(t * 3 + k);
      pc.ax += Math.abs(P.getX(t * 3 + k));
    }
  }
  const role = new Array(tris);
  for (const pc of pieces.values()) {
    const mean = pc.ax / (pc.tris.length * 3);
    const side = pc.sx >= 0 ? "sleeve_left" : "sleeve_right"; // +X is the wearer's left
    for (const t of pc.tris) role[t] = mean > half * 1.05 ? side : null;
  }
  // Body triangles: front or back by which way they face.
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    if (role[t]) continue;
    e1.subVectors(v(t * 3 + 1), v(t * 3));
    e2.subVectors(v(t * 3 + 2), v(t * 3));
    const nz = e1.cross(e2).z;
    const nx = P.getX(t * 3) + P.getX(t * 3 + 1) + P.getX(t * 3 + 2);
    role[t] = nz >= 0 ? "front" : "back";
    void nx;
  }

  const out = new Float32Array(n * 2);
  const set = (i, [x, y]) => {
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  };

  // Front and back: x across (the back as seen from behind), y up from the hem. Column by column, their top edge
  // (neckline, shoulders) is stretched onto ours, so the neck opening and the trims line up with our template.
  for (const name of ["front", "back"]) {
    const isl = T.islands[name];
    if (!isl) continue;
    const box = islandBox(isl);
    const pOf = (i) => lerp(name === "back" ? -P.getX(i) : P.getX(i), -half, half, box.p0, box.p1);
    const theirs = new Float32Array(TOP_BINS).fill(-Infinity);
    for (let t = 0; t < tris; t++) {
      if (role[t] !== name) continue;
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const b = topBin(pOf(i), box);
        theirs[b] = Math.max(theirs[b], P.getY(i));
      }
    }
    fillBins(theirs);
    const mine = ourTopEdge(ours, isl, box) || new Float32Array(TOP_BINS).fill(box.q1);
    for (let t = 0; t < tris; t++) {
      if (role[t] !== name) continue;
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const pp = pOf(i);
        const top = sampleBins(theirs, pp, box);
        const q = lerp(Math.min(P.getY(i), top), yMin, top, box.q0, sampleBins(mine, pp, box));
        set(i, islandUv(isl, pp, q));
      }
    }
  }

  // Sleeves: around the sleeve's axis (0 on top) and along it from the shoulder.
  for (const name of ["sleeve_left", "sleeve_right"]) {
    const isl = T.islands[name];
    const mine = [];
    for (let t = 0; t < tris; t++) if (role[t] === name) mine.push(t);
    if (!isl || !mine.length) continue;
    const xs = mine.flatMap((t) => [0, 1, 2].map((k) => Math.abs(P.getX(t * 3 + k)))).sort((a, b) => a - b);
    const lo = xs[Math.floor(xs.length * 0.1)];
    const hi = xs[Math.floor(xs.length * 0.9)];
    const shoulder = new THREE.Vector3(), cuff = new THREE.Vector3();
    let ns = 0, nc = 0;
    for (const t of mine) {
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const ax = Math.abs(P.getX(i));
        if (ax <= lo) (shoulder.add(v(i)), ns++);
        if (ax >= hi) (cuff.add(v(i)), nc++);
      }
    }
    shoulder.divideScalar(ns || 1);
    cuff.divideScalar(nc || 1);
    const axis = cuff.clone().sub(shoulder).normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y).normalize();
    const side = new THREE.Vector3().crossVectors(axis, up);
    if (name === "sleeve_right") side.negate(); // the same way round on both arms
    let tMax = 0;
    const d = new THREE.Vector3();
    for (const t of mine) for (let k = 0; k < 3; k++) tMax = Math.max(tMax, d.subVectors(v(t * 3 + k), shoulder).dot(axis));
    const box = islandBox(isl);
    for (const t of mine) {
      const ang = [0, 1, 2].map((k) => {
        d.subVectors(v(t * 3 + k), shoulder);
        return Math.atan2(d.dot(side), d.dot(up));
      });
      const a = unwrap(ang);
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const along = Math.max(0, d.subVectors(v(i), shoulder).dot(axis));
        set(i, islandUv(isl, angleToP(a[k], box), lerp(along, 0, tMax, box.q1, box.q0)));
      }
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(out, 2));
}

// The top edge of a front or back piece, as the highest q in each of TOP_BINS columns across the island.
const TOP_BINS = 48;
const topBin = (p, box) => Math.max(0, Math.min(TOP_BINS - 1, Math.floor(((p - box.p0) / (box.p1 - box.p0)) * TOP_BINS)));
/** Columns with no point take the value of their neighbours. */
function fillBins(a) {
  const known = [...a.keys()].filter((i) => Number.isFinite(a[i]));
  if (!known.length) return a;
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i])) continue;
    const l = known.filter((k) => k < i).pop();
    const r = known.find((k) => k > i);
    a[i] = l === undefined ? a[r] : r === undefined ? a[l] : lerp(i, l, r, a[l], a[r]);
  }
  return a;
}
/** The value at p, interpolated between the column centres. */
function sampleBins(a, p, box) {
  const f = ((p - box.p0) / (box.p1 - box.p0)) * TOP_BINS - 0.5;
  const i = Math.max(0, Math.min(TOP_BINS - 1, Math.floor(f)));
  const j = Math.min(TOP_BINS - 1, i + 1);
  const w = Math.max(0, Math.min(1, f - i));
  return a[i] * (1 - w) + a[j] * w;
}
/** Our shirt's top edge in an island's frame, read from our model's own UVs (null without the model). */
function ourTopEdge(ours, isl, box) {
  if (!ours) return null;
  const top = new Float32Array(TOP_BINS).fill(-Infinity);
  const [rx, ry, rw, rh] = isl.rect;
  ours.traverse((o) => {
    if (!o.isMesh || o.material?.name !== "shirt_body") return;
    const uv = o.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const w = uv.getY(i);
      if (u < rx || u > rx + rw || w < ry || w > ry + rh) continue;
      const p = isl.pmin + (u - rx) / isl.scale;
      const q = isl.qmax - (w - ry) / isl.scale;
      const b = topBin(p, box);
      top[b] = Math.max(top[b], q);
    }
  });
  return fillBins(top);
}

function remapCollar(g, T) {
  const isl = T.islands.collar;
  const P = g.attributes.position;
  const n = P.count;
  if (!isl) return;
  g.computeBoundingBox();
  const b = g.boundingBox;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const box = islandBox(isl);
  const out = new Float32Array(n * 2);
  for (let t = 0; t < n / 3; t++) {
    const a = unwrap([0, 1, 2].map((k) => Math.atan2(P.getX(t * 3 + k) - cx, P.getZ(t * 3 + k) - cz))); // 0 at the front
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const [x, y] = islandUv(isl, angleToP(a[k], box), lerp(P.getY(i), b.min.y, b.max.y, box.q0, box.q1));
      out[i * 2] = x;
      out[i * 2 + 1] = y;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(out, 2));
}

// ---------------------------------------------------------------- seams
// Every edge of the sewing pattern (the UV islands: side seams, armholes, shoulders, collar, hems and cuffs) gets a
// sewn look in a normal map: a soft fold right at the edge, where the two pieces are joined, and a row of stitches a
// few millimetres inside each piece. Built once per model from its geometry: an edge that only one triangle uses is
// the edge of a piece (glTF splits the vertices along UV seams).

const SEAM_SIZE = 2048;
const seamCache = new Map();

function seamMap(name, object) {
  if (seamCache.has(name)) return seamCache.get(name);
  const S = SEAM_SIZE;
  const height = document.createElement("canvas");
  height.width = height.height = S;
  const ctx = height.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "rgb(128,128,128)";
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = "round";
  let edges = 0;
  object.traverse((o) => {
    if (!o.isMesh || o.material?.name?.endsWith("_inner")) return;
    const g = o.geometry;
    const uv = g.attributes.uv;
    if (!uv) return;
    const index = g.index ? g.index.array : null;
    const count = index ? index.length : g.attributes.position.count;
    const at = (i) => (index ? index[i] : i);
    // Edges used once, with the triangle's third corner (it says which side is inside the piece).
    const seen = new Map();
    for (let f = 0; f < count; f += 3) {
      const tri = [at(f), at(f + 1), at(f + 2)];
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (seen.has(key)) seen.set(key, null);
        else seen.set(key, [a, b, tri[(k + 2) % 3]]);
      }
    }
    const px = (i) => [uv.getX(i) * S, uv.getY(i) * S]; // canvas top = v 0 (flipY = false)
    const folds = new Path2D();
    const stitches = new Path2D();
    for (const e of seen.values()) {
      if (!e) continue;
      const [a, b, c] = e.map(px);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.5 || len > S * 0.2) continue;
      // Unit normal pointing into the piece.
      let nx = -dy / len;
      let ny = dx / len;
      if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      folds.moveTo(a[0], a[1]);
      folds.lineTo(b[0], b[1]);
      const off = SEAM.stitchInset * S;
      stitches.moveTo(a[0] + nx * off, a[1] + ny * off);
      stitches.lineTo(b[0] + nx * off, b[1] + ny * off);
      edges++;
    }
    // The fold: the cloth turns down into the seam.
    ctx.strokeStyle = "rgb(70,70,70)";
    ctx.lineWidth = SEAM.foldWidth * S;
    ctx.stroke(folds);
    ctx.strokeStyle = "rgb(100,100,100)";
    ctx.lineWidth = SEAM.foldWidth * S * 2.2;
    ctx.globalAlpha = 0.5;
    ctx.stroke(folds);
    ctx.globalAlpha = 1;
    // The stitch row: a shallow channel, then raised stitches along it.
    ctx.strokeStyle = "rgb(112,112,112)";
    ctx.lineWidth = SEAM.stitchWidth * S * 1.8;
    ctx.stroke(stitches);
    ctx.setLineDash([SEAM.stitchLength * S, SEAM.stitchGap * S]);
    ctx.strokeStyle = "rgb(190,190,190)";
    ctx.lineWidth = SEAM.stitchWidth * S;
    ctx.stroke(stitches);
    ctx.setLineDash([]);
  });
  if (!edges) {
    seamCache.set(name, null);
    return null;
  }
  const out = document.createElement("canvas");
  out.width = out.height = S;
  heightToNormal(height, out, SEAM.strength);
  const texture = new THREE.CanvasTexture(out);
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  seamCache.set(name, texture);
  return texture;
}

// Sizes as fractions of the texture (about 0.84 texture units per metre on the body: 0.0025 is about 3 mm).
const SEAM = { foldWidth: 0.0016, stitchInset: 0.0035, stitchWidth: 0.0009, stitchLength: 0.0022, stitchGap: 0.0012, strength: 1.4 };

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
    normalMap: meshTexture(), normalScale: new THREE.Vector2(0.4, 0.4),
  });
  if (name === "shirt_collar") {
    // The trim sits on the same cloth at the shoulder seam; keep tiny depth ties from showing shirt fragments.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
  }
  if (inner) material.defines = { ...material.defines, USE_INNER: "" }; // its own shader program
  const relief = { value: null };
  const seam = { value: null };
  const reliefUv = { value: new THREE.Matrix3() };
  const ribRects = { value: Array.from({ length: RIB_ZONES }, () => new THREE.Vector4(-1, -1, -1, -1)) };
  const ribPeriod = { value: 1 };
  material.userData = { relief, reliefUv, ribRects, ribPeriod, seam };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.reliefMap = relief;
    shader.uniforms.reliefUv = reliefUv;
    shader.uniforms.ribRects = ribRects;
    shader.uniforms.ribPeriod = ribPeriod;
    shader.uniforms.seamMap = seam;
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
#ifdef USE_SEAM
uniform sampler2D seamMap;
#endif
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
	#endif
	#ifdef USE_SEAM
		// Seams and stitching (seamMap): the fold where two pieces meet and the row of stitches beside it.
		vec3 seamN = texture2D( seamMap, ( reliefUv * vec3( vMapUv, 1.0 ) ).xy ).xyz * 2.0 - 1.0;
		mapN = normalize( vec3( mapN.xy + seamN.xy, mapN.z * seamN.z ) );
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
  const irid = maps?.irid || null;
  if (relief.value === normal && material.roughnessMap === orm && material.iridescenceMap === irid) return;
  relief.value = normal;
  // Thin-film iridescence (iridescent / holographic layers): the colour shifts with the viewing angle, as on real foil.
  material.iridescenceMap = material.iridescenceThicknessMap = irid;
  material.iridescence = irid ? 1 : 0;
  material.iridescenceIOR = 1.8;
  material.iridescenceThicknessRange = [180, 760];
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
      h[y * n + x] = Math.min(1, d / 0.11) ** 0.8; // 0 in a (small) hole, rising to the flat knit surface
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
  t.repeat.set(210, 210); // about 2.7 mm per cell on the shirt, like a fine performance knit
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

export default Viewer;
