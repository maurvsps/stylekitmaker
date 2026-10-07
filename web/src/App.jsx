import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Viewer, { LIGHTING_PRESETS } from "./Viewer.jsx";
import TextureView from "./TextureView.jsx";
import FlatView from "./FlatView.jsx";
import { makeShareLink, readShareLink, shrinkImage } from "./myKits.js";
import { isTyping } from "./LayersPanel.jsx";
import Panel from "./Panel.jsx";
import ExportSheet from "./ExportSheet.jsx";
import { FONTS, fontCss, resolveTemplate } from "./design.js";
import { DEFAULT_PROJECT, GARMENTS, fontsInUse, sanitizeProject, serializeProject, walk } from "./project.js";
import { KitRenderer } from "./kitRenderer.js";

const TEXTURE_SIZES = [1024, 2048, 4096];
const PREFS_KEY = "kit-maker:prefs"; // view settings of this browser (not part of the design)
const CAMERAS = [["front", "Front"], ["three-quarter", "3/4"], ["side", "Side"], ["back", "Back"], ["close-up", "Close-up"]];
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
  const [view, setView] = useState("3d"); // "3d" | "flat" | "texture"
  const [handTool, setHandTool] = useState(false);

  useEffect(() => {
    const onHandKey = (e) => {
      if (view !== "3d" || e.key.toLowerCase() !== "m" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      setHandTool((active) => !active);
    };
    addEventListener("keydown", onHandKey);
    return () => removeEventListener("keydown", onHandKey);
  }, [view]);

  // A design opened from a share link (#kit=...): load it once, then tidy the address bar.
  useEffect(() => {
    const open = () => {
      if (!location.hash.startsWith("#kit=")) return;
      readShareLink(location.hash).then((data) => {
        if (data) setProjectRaw(sanitizeProject(data));
        window.history.replaceState(null, "", location.pathname + location.search); // (`history` is the undo stack here)
      });
    };
    open();
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
  }, []);

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
  const [confirmReset, setConfirmReset] = useState(false);
  const [busyNote, setBusyNote] = useState(null); // shown over the stage while a big render runs
  const shooting = useRef(false);
  const [saveStatus, setSaveStatus] = useState("saving");
  const [previewHeight, setPreviewHeight] = useState(null);
  const app = useRef(null);
  const viewer = useRef(null);
  const renderer = useMemo(() => new KitRenderer(prefs.textureSize, 0.5), []); // eslint-disable-line react-hooks/exhaustive-deps
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
      setProjectRaw((p) => {
        const template = resolveTemplate(p.template);
        return shirts.includes(template) ? { ...p, template } : { ...p, template: shirts[0] };
      });
    })().catch((err) => setError(`Could not load the kit templates (${err.message}). Run blender/make_kit.py first.`));
  }, []);

  const shirtNames = useMemo(() => (kits || []).filter((k) => k.garment === "shirt"), [kits]);
  const models = useMemo(() => ({ shirt: project.template }), [project.template]);

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

  // Repaint the garments whose layers changed at display refresh rate.
  // We keep a project reference and queue frames without cancelling in-flight frames,
  // preventing frame starvation during rapid slider dragging or color picking.
  const projectRef = useRef(project);
  projectRef.current = project;
  // Read through refs: a frame queued before an image finished decoding must still paint with the newest images and fonts.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const fontsReadyRef = useRef(fontsReady);
  fontsReadyRef.current = fontsReady;
  const scheduledRef = useRef(false);

  const scheduleRender = useCallback(() => {
    if (!kits || scheduledRef.current) return;
    scheduledRef.current = true;
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      const cur = projectRef.current;
      const res = renderer.render(cur, templates, models, imagesRef.current, fontsReadyRef.current);
      if (res.mapsChanged) setMaps({ ...renderer.maps });
      if (projectRef.current !== cur) {
        scheduleRender();
      }
    });
  }, [kits, renderer, templates, models, images, fontsReady]);

  useEffect(() => {
    scheduleRender();
  }, [project, scheduleRender, sizeKey]);

  useEffect(() => {
    setSaveStatus("saving");
    const timeout = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject(project)));
        setSaveStatus("saved");
      } catch {
        setSaveStatus("unavailable");
      }
    }, 500);
    return () => clearTimeout(timeout);
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
    // 4K (3840 px on the long side; 2048 on phones): the garment texture is repainted at 4096 for the shot, then
    // put back, so the cloth, prints and logos are as sharp as the output.
    screenshot: async (aspect) => {
      if (shooting.current) return;
      shooting.current = true;
      const prior = renderer.size;
      const hi = MOBILE ? 2048 : 4096;
      const boost = prior < hi;
      setBusyNote(MOBILE ? "Rendering high quality image…" : "Rendering 4K image…");
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40))); // let the note show first
      try {
        if (boost) {
          renderer.resize(hi);
          renderer.render(projectRef.current, templates, models, imagesRef.current, fontsReadyRef.current);
        }
        const url = viewer.current.screenshot(aspect, { transparent: prefs.transparent, long: MOBILE ? 2048 : 3840 });
        setSheet({
          kind: "image",
          title: `${aspect ? `Preview ${aspect}` : "Preview screenshot"} (${MOBILE ? "2K" : "4K"})`,
          url,
          filename: `kit${aspect ? `-${aspect.replace(":", "x")}` : ""}${MOBILE ? "-2k" : "-4k"}${prefs.transparent ? "-transparent" : ""}.png`,
          preview: true,
        });
      } catch {
        setError("Could not render the image at this size. Try a smaller texture resolution or another browser.");
      } finally {
        if (boost) {
          renderer.resize(prior);
          setSizeKey((n) => n + 1);
        }
        setBusyNote(null);
        shooting.current = false;
      }
    },
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
    saveStatus,
    load: async (file) => {
      try {
        const data = JSON.parse(await file.text());
        setProject(sanitizeProject(data, shirtNames.map((k) => k.name)));
      } catch {
        setError("That file is not a kit design (JSON).");
      }
    },
    reset: () => setConfirmReset(true),
    // My kits and share links
    kitData: () => serializeProject(project),
    kitThumbnail: async () => {
      try {
        const url = viewer.current?.screenshot("1:1", { transparent: false });
        return url ? await shrinkImage(url) : null;
      } catch {
        return null;
      }
    },
    applyKit: (data) => setProject(sanitizeProject(data, shirtNames.map((k) => k.name))),
    shareLink: () => {
      // Crests picked from the catalogue travel as a link to their image, so the shared kit still shows them.
      const data = serializeProject(project);
      const assets = { ...data.assets };
      for (const g of GARMENTS) {
        walk(data.garments[g].layers, (l) => {
          if (l.type !== "image" || !l.clubData || !assets[l.asset]?.src.startsWith("data:")) return;
          const web = l.crestStyle === "mono" && l.clubData.monoUrl ? l.clubData.monoUrl : l.clubData.colorUrl;
          assets[l.asset] = { ...assets[l.asset], src: `https://wsrv.nl/?output=png&w=1024&we&url=${encodeURIComponent(web)}` };
        });
      }
      return makeShareLink({ ...data, assets });
    },
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
    <div className="app" ref={app} style={previewHeight == null ? undefined : { "--preview-height": `${previewHeight}px` }}>
      <main className="stage">
        {kits && (
          <Viewer ref={viewer} models={models} textures={textures} collar={renderer.collar} maps={maps} templates={templates}
            onLoading={onLoading}
            onLoaded={onLoaded} onError={setError} lighting={prefs.lighting} pixelRatio={1.5} handTool={handTool} />
        )}
        {view === "flat" && <FlatView texture={textures[garment]} template={templates[models[garment]]} />}
        {view === "texture" && <TextureView texture={textures[garment]} uvSrc={`models/${models[garment]}_uv.png`} />}
        <div className="stage-tools">
          <div className="seg" role="group" aria-label="History">
            <button type="button" onClick={undo} disabled={!actions.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
            <button type="button" onClick={redo} disabled={!actions.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
          </div>
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={view === "3d" ? "on" : ""} aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D</button>
            <button type="button" className={view === "flat" ? "on" : ""} aria-pressed={view === "flat"} onClick={() => setView("flat")} title="Front and back laid flat">Flat</button>
            <button type="button" className={view === "texture" ? "on" : ""} aria-pressed={view === "texture"} onClick={() => setView("texture")}>
              Texture
            </button>
          </div>
          {view === "3d" && <div className="seg" role="group" aria-label="3D navigation">
            <button type="button" className={handTool ? "on" : ""} aria-pressed={handTool}
              aria-label="Hand tool" title="Hand tool (M): drag to move the view"
              onClick={() => setHandTool((active) => !active)}><span aria-hidden="true">✋</span><span className="pan-label"> Pan</span></button>
          </div>}
          {view === "3d" && <select value={prefs.lighting} onChange={(e) => setPref("lighting", e.target.value)} aria-label="Lighting" title="Lighting preset">
            {LIGHTING_PRESETS.map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>}
        </div>
        {busyNote && <div className="stage-note" role="status">{busyNote}</div>}
        {!loaded && !error && !busyNote && <div className="stage-note">Loading kit…</div>}
        {error && (
          <div className="stage-note error" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <div className="view-buttons" role="group" aria-label="Camera" hidden={view !== "3d"}>
          {CAMERAS.map(([v, label]) => (
            <button key={v} type="button" onClick={() => actions.view(v)}>
              {label}
            </button>
          ))}
        </div>
      </main>
      <div className="preview-resize" role="separator" aria-label="Resize 3D preview" aria-orientation="horizontal"
        aria-valuemin={25} aria-valuemax={75}
        aria-valuenow={Math.round(((previewHeight ?? window.innerHeight * 0.46) / window.innerHeight) * 100)}
        tabIndex={0}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const top = app.current.getBoundingClientRect().top;
          setPreviewHeight(Math.max(200, Math.min(app.current.clientHeight - 200, e.clientY - top)));
        }}
        onKeyDown={(e) => {
          if (!["ArrowUp", "ArrowDown", "Home"].includes(e.key)) return;
          e.preventDefault();
          if (e.key === "Home") return setPreviewHeight(null);
          setPreviewHeight(Math.max(200, Math.min(app.current.clientHeight - 200,
            (previewHeight ?? app.current.clientHeight * 0.46) + (e.key === "ArrowDown" ? 24 : -24))));
        }}><span aria-hidden="true" /></div>
      {sheet && <ExportSheet file={sheet} onClose={() => setSheet(null)}
        onDownload={CAN_DOWNLOAD ? () => { download(sheet.url, sheet.filename); setSheet(null); } : null} />}
      {confirmReset && <div className="sheet-backdrop" onClick={() => setConfirmReset(false)}>
        <div className="sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-label="Reset design" onClick={(e) => e.stopPropagation()}>
          <h2>Reset this design?</h2>
          <p>This replaces the current kit with the starter design. Save a JSON copy first if you want to keep it.</p>
          <div className="row">
            <button type="button" className="quiet" onClick={() => setConfirmReset(false)}>Cancel</button>
            <button type="button" onClick={() => {
              setProject({ ...structuredClone(DEFAULT_PROJECT), template: shirtNames[0]?.name || DEFAULT_PROJECT.template });
              setConfirmReset(false);
            }}>Reset design</button>
          </div>
        </div>
      </div>}
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
  const prefs = { textureSize: 1024, lighting: "studio", transparent: false };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (TEXTURE_SIZES.includes(saved.textureSize)) prefs.textureSize = saved.textureSize;
    if (LIGHTING_PRESETS.includes(saved.lighting)) prefs.lighting = saved.lighting;
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
      if (!src.startsWith("data:")) img.crossOrigin = "anonymous"; // linked images must allow canvas use
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
