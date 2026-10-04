import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Viewer from "./Viewer.jsx";
import Panel from "./Panel.jsx";
import ExportSheet from "./ExportSheet.jsx";
import { FONTS, fontCss } from "./design.js";
import { DEFAULT_PROJECT, fontsInUse, sanitizeProject, serializeProject } from "./project.js";
import { KitRenderer } from "./kitRenderer.js";

const TEXTURE_SIZE = 2048;
const STORAGE_KEY = "kit-maker:design"; // holds a version 1 design in older browsers; migrated on read
// Pages hosted where downloads are blocked (the claude.ai artifact build) show exports in a sheet instead.
const CAN_DOWNLOAD = !import.meta.env.VITE_NO_DOWNLOAD;

function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [project, setProject] = useState(() => sanitizeProject(readSaved() || DEFAULT_PROJECT));
  const [kits, setKits] = useState(null); // kits.json entries
  const [templates, setTemplates] = useState({}); // model name -> UV template
  const [images, setImages] = useState({}); // asset id -> decoded image
  const [fontsReady, setFontsReady] = useState(0);
  const [error, setError] = useState(null);
  const [sheet, setSheet] = useState(null); // { kind: "image" | "json", title, url | text, filename }
  const viewer = useRef(null);
  const renderer = useMemo(() => new KitRenderer(TEXTURE_SIZE), []);
  const textures = renderer.textures;

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
      setProject((p) => (shirts.includes(p.template) ? p : { ...p, template: shirts[0] }));
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

  // Repaint the garments whose layers (or what they use) changed, at most once per frame (colour pickers fire
  // continuously).
  useEffect(() => {
    if (!kits) return;
    const frame = requestAnimationFrame(() => renderer.render(project, templates, models, images, fontsReady));
    return () => cancelAnimationFrame(frame);
  }, [project, kits, templates, models, renderer, images, fontsReady]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject(project)));
    } catch {
      // storage full or blocked (large images): the project still works, it just is not remembered
    }
  }, [project]);

  const [loaded, setLoaded] = useState(false);
  const onLoaded = useCallback(() => {
    setLoaded(true);
    window.__kitReady = true; // for automated screenshots
  }, []);

  const actions = {
    screenshot: () => offer({ kind: "image", title: "Screenshot", url: viewer.current.screenshot(), filename: "kit.png" }),
    texture: (garment) =>
      offer({
        kind: "image",
        title: `${garment[0].toUpperCase() + garment.slice(1)} texture`,
        url: textures[garment].image.toDataURL("image/png"),
        filename: `${garment}-texture.png`,
      }),
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
    view: (preset) => viewer.current?.view(preset),
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
        {kits && <Viewer ref={viewer} models={models} textures={textures} onLoaded={onLoaded} />}
        {!loaded && !error && <div className="stage-note">Loading kit…</div>}
        {error && (
          <div className="stage-note error" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <div className="view-buttons" role="group" aria-label="Camera">
          {["front", "three-quarter", "back"].map((v) => (
            <button key={v} type="button" onClick={() => actions.view(v)}>
              {v === "three-quarter" ? "3/4" : v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </main>
      {sheet && <ExportSheet file={sheet} onClose={() => setSheet(null)} />}
      <Panel
        project={project}
        setProject={setProject}
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
