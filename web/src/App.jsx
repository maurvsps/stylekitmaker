import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Viewer, { LIGHTING_PRESETS } from "./Viewer.jsx";
import TextureView from "./TextureView.jsx";
import { isTyping } from "./LayersPanel.jsx";
import Panel from "./Panel.jsx";
import ExportSheet from "./ExportSheet.jsx";
import { FONTS, fontCss } from "./design.js";
import { DEFAULT_PROJECT, fontsInUse, sanitizeProject, serializeProject } from "./project.js";
import { KitRenderer } from "./kitRenderer.js";

const TEXTURE_SIZES = [1024, 2048, 4096];
const PREFS_KEY = "kit-maker:prefs"; // view settings of this browser (not part of the design)
const CAMERAS = [["front", "Front"], ["three-quarter", "3/4"], ["side", "Side"], ["back", "Back"], ["close-up", "Close"]];
const STORAGE_KEY = "kit-maker:design"; // holds a version 1 design in older browsers; migrated on read
// Pages hosted where downloads are blocked (the claude.ai artifact build) show exports in a sheet instead.
const CAN_DOWNLOAD = !import.meta.env.VITE_NO_DOWNLOAD;
// Phones and tablets: a lighter default texture, material maps at half resolution, fewer pixels per frame.
const MOBILE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [project, setProjectRaw] = useState(() => sanitizeProject(readSaved() || DEFAULT_PROJECT));
  const [prefs, setPrefs] = useState(readPrefs);
  const setPref = (k, v) => setPrefs((p) => ({ ...p, [k]: v }));
  const [garment, setGarment] = useState("shirt");
  const [view, setView] = useState("3d"); // "3d" | "texture"

  // Undo / redo: every project change is a step; changes less than half a second apart (a slider being dragged,
  // typing) merge into one.
  const history = useRef({ past: [], future: [], last: 0 });
  const current = useRef(project);
  current.current = project;
  const [, setHistoryTick] = useState(0);
  const setProject = useCallback((update) => {
    setProjectRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      if (next === prev) return prev;
      const h = history.current;
      const now = Date.now();
      if (now - h.last > 500 && h.past[h.past.length - 1] !== prev) {
        h.past.push(prev);
        if (h.past.length > 200) h.past.shift();
      }
      h.last = now;
      h.future = [];
      return next;
    });
    setHistoryTick((n) => n + 1);
  }, []);
  const undo = useCallback(() => {
    const h = history.current;
    if (!h.past.length) return;
    h.future.push(current.current);
    h.last = 0;
    setProjectRaw(h.past.pop());
    setHistoryTick((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const h = history.current;
    if (!h.future.length) return;
    h.past.push(current.current);
    h.last = 0;
    setProjectRaw(h.future.pop());
    setHistoryTick((n) => n + 1);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if (k === "y" || (k === "z" && e.shiftKey)) redo();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const [kits, setKits] = useState(null); // kits.json entries
  const [templates, setTemplates] = useState({}); // model name -> UV template
  const [images, setImages] = useState({}); // asset id -> decoded image
  const [fontsReady, setFontsReady] = useState(0);
  const [error, setError] = useState(null);
  const [sheet, setSheet] = useState(null); // { kind: "image" | "json", title, url | text, filename }
  const viewer = useRef(null);
  const renderer = useMemo(() => new KitRenderer(prefs.textureSize, MOBILE ? 0.5 : 1), []); // eslint-disable-line react-hooks/exhaustive-deps
  const textures = renderer.textures;
  const [maps, setMaps] = useState(renderer.maps); // garment -> material maps, replaced when one appears or goes

  // Templates: the manifest, then every UV template it lists.
  useEffect(() => {
    (async () => {
      const { kits } = await fetch("models/kits.json").then((r) => r.json());
      const entries = await Promise.all(
        kits.map(async (k) => [k.name, await fetch(`models/${k.name}.json`).then((r) => r.json())]),
      );
      setTemplates(Object.fromEntries(entries));
      setKits(kits);
      const shirts = kits.filter((k) => k.garment === "shirt").map((k) => k.name);
      setProjectRaw((p) => (shirts.includes(p.template) ? p : { ...p, template: shirts[0] }));
    })().catch((err) => setError(`Could not load the kit templates (${err.message}). Run blender/make_kit.py first.`));
  }, []);

  const shirtNames = useMemo(() => (kits || []).filter((k) => k.garment === "shirt"), [kits]);
  const models = useMemo(() => ({ shirt: project.template, shorts: "shorts", socks: "socks" }), [project.template]);

  // Uploaded images, decoded once each.
  const assets = project.assets;
  useEffect(() => {
    let live = true;
    Promise.all(Object.entries(assets).map(([id, { src }]) => decodeImage(src).then((img) => [id, img], () => null)))
      .then((list) => live && setImages(Object.fromEntries(list.filter(Boolean))));
    return () => {
      live = false;
    };
  }, [assets]);

  // Web fonts: repaint once the fonts in use have arrived.
  const fontKey = fontsInUse(project).join("|");
  useEffect(() => {
    let live = true;
    Promise.all(fontKey.split("|").map((f) => document.fonts?.load(fontCss(f, 64), "AZ09")))
      .then(() => live && setFontsReady((n) => n + 1), () => {});
    return () => {
      live = false;
    };
  }, [fontKey]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // not remembered
    }
  }, [prefs]);

  // Texture resolution: resize the canvases, then repaint everything.
  const [sizeKey, setSizeKey] = useState(0);
  useEffect(() => {
    renderer.resize(prefs.textureSize);
    setSizeKey((n) => n + 1);
  }, [renderer, prefs.textureSize]);

  // Repaint the garments whose layers (or what they use) changed, at most once per frame (colour pickers fire
  // continuously).
  useEffect(() => {
    if (!kits) return;
    const frame = requestAnimationFrame(() => {
      if (renderer.render(project, templates, models, images, fontsReady).mapsChanged) setMaps({ ...renderer.maps });
    });
    return () => cancelAnimationFrame(frame);
  }, [project, kits, templates, models, renderer, images, fontsReady, sizeKey]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject(project)));
    } catch {
      // storage full or blocked (large images): the project still works, it just is not remembered
    }
  }, [project]);

  const [loaded, setLoaded] = useState(false);
  const onLoading = useCallback(() => {
    setLoaded(false);
    setError(null);
  }, []);
  const onLoaded = useCallback(() => {
    setLoaded(true);
    setError(null);
    window.__kitReady = true; // for automated screenshots
  }, []);

  const actions = {
    screenshot: (aspect) =>
      offer({
        kind: "image",
        title: aspect ? `Screenshot ${aspect}` : "Screenshot",
        url: viewer.current.screenshot(aspect, { transparent: prefs.transparent }),
        filename: `kit${aspect ? `-${aspect.replace(":", "x")}` : ""}${prefs.transparent ? "-transparent" : ""}.png`,
      }),
    /** kind: "color" (the texture), "normal" or "orm" (material maps, when the garment has them). */
    texture: (garment, kind = "color") => {
      const canvas = kind === "color" ? textures[garment].image : renderer.maps[garment]?.[kind]?.image;
      if (!canvas) return setError(`The ${garment} has no material map yet: give a layer a finish or add a material effect.`);
      const label = { color: "texture", normal: "normal map", orm: "roughness-metalness map" }[kind];
      offer({
        kind: "image",
        title: `${garment[0].toUpperCase() + garment.slice(1)} ${label}`,
        url: canvas.toDataURL("image/png"),
        filename: `${garment}-${kind === "color" ? "texture" : kind}.png`,
      });
    },
    hasMaps: garmentsWithMaps(maps),
    transparent: prefs.transparent,
    setTransparent: (v) => setPref("transparent", v),
    save: () =>
      offer({ kind: "json", title: "Design file", text: JSON.stringify(serializeProject(project), null, 2), filename: "kit-design.json" }),
    load: async (file) => {
      try {
        const data = JSON.parse(await file.text());
        setProject(sanitizeProject(data, shirtNames.map((k) => k.name)));
      } catch {
        setError("That file is not a kit design (JSON).");
      }
    },
    reset: () => setProject({ ...structuredClone(DEFAULT_PROJECT), template: shirtNames[0]?.name || DEFAULT_PROJECT.template }),
    view: (preset) => {
      setView("3d");
      viewer.current?.view(preset);
    },
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    textureSize: prefs.textureSize,
    setTextureSize: (v) => setPref("textureSize", v),
    textureSizes: TEXTURE_SIZES,
  };

  function offer(file) {
    if (!CAN_DOWNLOAD) return setSheet(file);
    if (file.kind === "json") {
      const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
      download(url, file.filename, true);
    } else {
      download(file.url, file.filename);
    }
  }

  return (
    <div className="app">
      <main className="stage">
        {kits && (
          <Viewer ref={viewer} models={models} textures={textures} collar={renderer.collar} maps={maps} templates={templates}
            onLoading={onLoading}
            onLoaded={onLoaded} onError={setError} lighting={prefs.lighting} mannequin={prefs.mannequin} pixelRatio={MOBILE ? 1.5 : 2} />
        )}
        {view === "texture" && <TextureView texture={textures[garment]} uvSrc={`models/${models[garment]}_uv.png`} />}
        <div className="stage-tools">
          <div className="seg" role="group" aria-label="History">
            <button type="button" onClick={undo} disabled={!actions.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
            <button type="button" onClick={redo} disabled={!actions.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
          </div>
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={view === "3d" ? "on" : ""} aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D</button>
            <button type="button" className={view === "texture" ? "on" : ""} aria-pressed={view === "texture"} onClick={() => setView("texture")}>
              Texture
            </button>
          </div>
          <button type="button" className={`pill${prefs.mannequin ? " on" : ""}`} aria-pressed={prefs.mannequin} hidden={view === "texture"}
            onClick={() => setPref("mannequin", !prefs.mannequin)} title="Show or hide the mannequin">
            Mannequin
          </button>
          <select value={prefs.lighting} onChange={(e) => setPref("lighting", e.target.value)} aria-label="Lighting">
            {LIGHTING_PRESETS.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)} light
              </option>
            ))}
          </select>
        </div>
        {!loaded && !error && <div className="stage-note">Loading kit…</div>}
        {error && (
          <div className="stage-note error" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <div className="view-buttons" role="group" aria-label="Camera" hidden={view === "texture"}>
          {CAMERAS.map(([v, label]) => (
            <button key={v} type="button" onClick={() => actions.view(v)}>
              {label}
            </button>
          ))}
        </div>
      </main>
      {sheet && <ExportSheet file={sheet} onClose={() => setSheet(null)} />}
      <Panel
        project={project}
        setProject={setProject}
        garment={garment}
        setGarment={setGarment}
        templates={templates}
        models={models}
        shirts={shirtNames}
        fonts={FONTS}
        actions={actions}
        onError={setError}
      />
    </div>
  );
}

function readPrefs() {
  const prefs = { textureSize: MOBILE && Math.min(screen.width, screen.height) < 500 ? 1024 : 2048, lighting: "studio", mannequin: true, transparent: false };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (TEXTURE_SIZES.includes(saved.textureSize)) prefs.textureSize = saved.textureSize;
    if (LIGHTING_PRESETS.includes(saved.lighting)) prefs.lighting = saved.lighting;
    if (typeof saved.mannequin === "boolean") prefs.mannequin = saved.mannequin;
    else if (typeof saved.showMannequin === "boolean") prefs.mannequin = saved.showMannequin; // earlier name
    if (typeof saved.transparent === "boolean") prefs.transparent = saved.transparent;
  } catch {
    // defaults
  }
  return prefs;
}

const garmentsWithMaps = (maps) => Object.keys(maps).filter((g) => maps[g]);

const decoded = new Map(); // data URL -> Promise<HTMLImageElement>
function decodeImage(src) {
  if (!decoded.has(src)) {
    decoded.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    }));
  }
  return decoded.get(src);
}

function download(url, filename, revoke = false) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
