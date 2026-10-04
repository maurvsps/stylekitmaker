import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import Viewer from "./Viewer.jsx";
import Panel from "./Panel.jsx";
import ExportSheet from "./ExportSheet.jsx";
import { DEFAULT_DESIGN, FONTS, fontCss, sanitizeDesign } from "./design.js";
import { drawGarment } from "./kitTexture.js";

const TEXTURE_SIZE = 2048;
const GARMENTS = ["shirt", "shorts", "socks"];
const STORAGE_KEY = "kit-maker:design";
// Pages hosted where downloads are blocked (the claude.ai artifact build) show exports in a sheet instead.
const CAN_DOWNLOAD = !import.meta.env.VITE_NO_DOWNLOAD;

function makeTexture() {
  const canvas = document.createElement("canvas"); // hidden: only the 3D view and the downloads show it
  canvas.width = canvas.height = TEXTURE_SIZE;
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false; // glTF UVs: canvas top = texture v 0
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [design, setDesign] = useState(() => sanitizeDesign(readSaved() || DEFAULT_DESIGN));
  const [kits, setKits] = useState(null); // kits.json entries
  const [templates, setTemplates] = useState({}); // model name -> UV template
  const [logoImage, setLogoImage] = useState(null);
  const [fontsReady, setFontsReady] = useState(0);
  const [error, setError] = useState(null);
  const [sheet, setSheet] = useState(null); // { kind: "image" | "json", title, url | text, filename }
  const viewer = useRef(null);
  const textures = useMemo(() => Object.fromEntries(GARMENTS.map((g) => [g, makeTexture()])), []);

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
      setDesign((d) => (shirts.includes(d.template) ? d : { ...d, template: shirts[0] }));
    })().catch((err) => setError(`Could not load the kit templates (${err.message}). Run blender/make_kit.py first.`));
  }, []);

  const shirtNames = useMemo(() => (kits || []).filter((k) => k.garment === "shirt"), [kits]);
  const models = useMemo(() => ({ shirt: design.template, shorts: "shorts", socks: "socks" }), [design.template]);

  // Crest image, decoded once per upload.
  const logoSrc = design.logo?.src;
  useEffect(() => {
    if (!logoSrc) return setLogoImage(null);
    let live = true;
    const img = new Image();
    img.onload = () => live && setLogoImage(img);
    img.onerror = () => live && setLogoImage(null);
    img.src = logoSrc;
    return () => {
      live = false;
    };
  }, [logoSrc]);

  // Web fonts: repaint once the selected font has arrived.
  useEffect(() => {
    let live = true;
    document.fonts
      ?.load(fontCss(design.font, 64), "AZ09")
      .then(() => live && setFontsReady((n) => n + 1), () => {});
    return () => {
      live = false;
    };
  }, [design.font]);

  // Repaint every texture on each design change, at most once per frame (colour pickers fire continuously).
  useEffect(() => {
    if (!kits) return;
    const frame = requestAnimationFrame(() => {
      for (const garment of GARMENTS) {
        const template = templates[models[garment]];
        if (!template) continue;
        drawGarment(textures[garment].image, garment, template, design, { logo: logoImage });
        textures[garment].needsUpdate = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [design, kits, templates, models, textures, logoImage, fontsReady]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(design));
    } catch {
      // storage full or blocked (large crest): the design still works, it just is not remembered
    }
  }, [design]);

  const update = useCallback((patch) => setDesign((d) => ({ ...d, ...patch })), []);
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
      offer({ kind: "json", title: "Design file", text: JSON.stringify({ version: 1, ...design }, null, 2), filename: "kit-design.json" }),
    load: async (file) => {
      try {
        const data = JSON.parse(await file.text());
        setDesign(sanitizeDesign(data, shirtNames.map((k) => k.name)));
      } catch {
        setError("That file is not a kit design (JSON).");
      }
    },
    reset: () => setDesign({ ...DEFAULT_DESIGN, template: shirtNames[0]?.name || DEFAULT_DESIGN.template }),
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
      <Panel design={design} update={update} shirts={shirtNames} fonts={FONTS} actions={actions} onError={setError} />
    </div>
  );
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
