import { useEffect, useRef, useState } from "react";
import { cleanName, cleanNumber } from "./design.js";
import ColorButton from "./ColorPicker.jsx";
import LayersPanel from "./LayersPanel.jsx";
import { IDENTITY, PALETTE_LABELS, SHOWN_GARMENTS, editLayers, findLayer, findRole, makeLayer, mapLayer, newId } from "./project.js";
import { findOpenImagePosition } from "./imagePlacement.js";
import { prepareLogo } from "./logoImage.js";
import { fetchLogo, searchBrands, searchCrests } from "./logoSearch.js";

// The sidebar: one section at a time, so the panel stays short.
const TABS = [
  { id: "kit", label: "Kit", icon: "M8 4 4 6.5 5.5 10 7 9.3V20h10V9.3l1.5.7L20 6.5 16 4c-.5 1.6-2.1 2.7-4 2.7S8.5 5.6 8 4Z" },
  { id: "logos", label: "Logos", icon: "M12 3 5 5.5V11c0 4.4 3 8.2 7 10 4-1.8 7-5.6 7-10V5.5L12 3Z" },
  { id: "layers", label: "Layers", icon: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" },
  { id: "player", label: "Player", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6" },
  { id: "export", label: "Export", icon: "M12 15V3m0 12-4-4m4 4 4-4M5 15v4h14v-4" },
];
const TAB_KEY = "kit-maker:panel-tab";
const savedTab = () => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.id === t) ? t : "kit";
  } catch {
    return "kit";
  }
};

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // stored in the design
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // a raster file before prepareLogo shrinks it

export default function Panel({ project, setProject, garment, setGarment, templates, models, shirts, fonts, actions, onError }) {
  const designInput = useRef(null);
  const logoInput = useRef(null);
  const [pendingLogo, setPendingLogo] = useState(null);
  const [selection, setSelection] = useState({}); // garment -> selected layer id
  const [tab, setTab] = useState(savedTab);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage blocked: the panel just opens on Kit next time */
    }
  }, [tab]);
  const selected = selection[garment] && findLayer(project.garments[garment].layers, selection[garment]) ? selection[garment] : null;
  const select = (id, g = garment) => setSelection((s) => ({ ...s, [g]: id }));

  const set = (fields) => setProject((p) => ({ ...p, ...fields }));
  const shirtRole = (role) => findRole(project.garments.shirt.layers, role);

  /**
   * Read an image file into the project's assets; resolves to { id, name } (or null after showing an error).
   * Logos are cleaned up on the way in (logoImage.js): a flat background becomes transparent, margins are trimmed and
   * big photos are scaled down, so a crest or brand logo saved from the web drops straight onto the shirt.
   */
  const uploadImage = async (file) => {
    if (!/^image\/(png|svg\+xml|jpeg|webp)$/.test(file.type)) {
      onError("Images must be PNG, SVG, JPEG or WebP files.");
      return null;
    }
    if (file.size > (file.type === "image/svg+xml" ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES)) {
      onError(`That image is too large (${file.type === "image/svg+xml" ? "1.5" : "15"} MB max).`);
      return null;
    }
    let src;
    try {
      src = await prepareLogo(file);
    } catch {
      onError("That image could not be read.");
      return null;
    }
    if (src.length * 0.75 > MAX_IMAGE_BYTES) {
      onError("That image is still too large after shrinking it (1.5 MB max).");
      return null;
    }
    const id = newId("img");
    setProject((p) => ({ ...p, assets: { ...p.assets, [id]: { src, name: file.name } } }));
    return { id, name: file.name };
  };

  // Shortcuts: the crest and sponsor are ordinary shirt layers marked with a role.
  const setSponsor = (text) =>
    setProject((p) =>
      editLayers(p, "shirt", (ls) => {
        const layer = findRole(ls, "sponsor");
        if (layer) return mapLayer(ls, layer.id, (l) => ({ ...l, text, visible: true }));
        return [...ls, makeLayer("text", "shirt", { role: "sponsor", name: "Sponsor", text, size: 0.065, maxWidth: 0.32, transform: { ...IDENTITY, y: 0.39 } })];
      }),
    );
  const sponsor = shirtRole("sponsor");

  const logoSlots = [
    { id: "crest", label: "Team crest", garment: "shirt", surface: "front", x: 0.095, y: 0.555 },
    { id: "brand", label: "Brand", garment: "shirt", surface: "front", x: -0.095, y: 0.555 },
    { id: "shirt-sponsor", label: "Front sponsor", garment: "shirt", surface: "front", x: 0, y: 0.38 },
    { id: "back-sponsor", label: "Back sponsor", garment: "shirt", surface: "back", x: 0, y: 0.42 },
    { id: "sleeve-left", label: "Left sleeve", garment: "shirt", surface: "sleeve_left", x: 0, y: 0.42 },
    { id: "sleeve-right", label: "Right sleeve", garment: "shirt", surface: "sleeve_right", x: 0, y: 0.42 },
  ];
  const uploadLogo = async (file, slot) => {
    const asset = await uploadImage(file);
    if (!asset) return;
    const role = slot.id === "crest" ? "crest" : `logo-${slot.id}`;
    const preferred = { surface: slot.surface, x: slot.x, y: slot.y };
    const position = findOpenImagePosition(project.garments[slot.garment].layers, slot.garment, templates[models[slot.garment]], preferred,
      slot.id.includes("sponsor") ? 0.16 : slot.id.includes("sleeve") ? 0.055 : 0.085);
    const fresh = makeLayer("image", slot.garment, {
      role, name: slot.label, asset: asset.id, surface: position.surface,
      // Crest and brand are printed on top of the fabric, not woven into it; sponsors start on the fabric.
      texture: slot.id === "crest" || slot.id === "brand" ? "smooth" : "kit",
      size: slot.id.includes("sleeve") ? 0.055 : slot.id.includes("sponsor") ? 0.16 : 0.085,
      transform: { ...IDENTITY, x: position.x, y: position.y },
    });
    const existing = findRole(project.garments[slot.garment].layers, role);
    setProject((p) => editLayers(p, slot.garment, (ls) => {
      const old = findRole(ls, role);
      // Whatever already sits in that spot (the default design's chest number, under the brand logo) steps aside.
      const cleared = hideAt(ls, slot, role);
      return old ? mapLayer(cleared, old.id, (l) => ({ ...l, asset: asset.id })) : [...cleared, fresh];
    }));
    setGarment(slot.garment);
    select(existing?.id || fresh.id, slot.garment);
  };
  const slotLayer = (slot) => findRole(project.garments[slot.garment].layers, slot.id === "crest" ? "crest" : `logo-${slot.id}`);
  const slotButton = (slot) => {
    const layer = slotLayer(slot);
    const asset = layer && project.assets[layer.asset];
    return <button type="button" className={`logo-slot${layer ? " populated" : ""}`} key={slot.id} title={asset ? "Replace image" : "Upload image"} onClick={() => {
      setPendingLogo(slot); logoInput.current.click();
    }}>
      <span className="logo-preview">{asset ? <img src={asset.src} alt="" /> : <span aria-hidden="true">+</span>}</span>
      <span className="logo-slot-label">{slot.label}</span>
      <span className="logo-slot-file">{asset ? "Tap to replace" : "Upload"}</span>
    </button>;
  };

  return (
    <aside className="panel" aria-label="Kit design">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">K</div>
        <div><h1>Kit Maker</h1><p>Custom kit studio</p></div>
        <button className="quiet header-action" type="button" onClick={actions.reset} title="Start a new design" aria-label="New design">＋</button>
      </header>

      <div className="panel-body">
      <nav className="panel-nav" aria-label="Panel sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? "on" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.icon} /></svg>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="panel-content">
      {tab === "kit" && <Section title="Settings" eyebrow="01">
        <span className="group-label">Shirt template</span>
        <select value={project.template} onChange={(e) => set({ template: e.target.value })} aria-label="Shirt template">
          {shirts.map((k) => (
            <option key={k.name} value={k.name}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="group-label">Kit colours</span>
        <div className="colors">
          {project.palette.map((c, i) => (
            <div key={i} className="color">
              <ColorButton className="kit-color" style={{ background: c }} value={c} label={PALETTE_LABELS[i]} palette={project.palette}
                onChange={(hex) => set({ palette: project.palette.map((x, k) => (k === i ? hex : x)) })} />
              <span>{PALETTE_LABELS[i]}</span>
            </div>
          ))}
        </div>
      </Section>}

      {tab === "logos" && <Section title="Crest & sponsors" eyebrow="02" className="logo-section">
        <p className="section-copy">Search a club or a brand, or tap a spot below to upload your own image.</p>
        <LogoFinder slots={logoSlots} onPick={uploadLogo} onError={onError} />
        <span className="group-label">Club</span>
        <div className="logo-grid">{logoSlots.filter((slot) => ["crest", "brand"].includes(slot.id)).map(slotButton)}</div>
        <span className="group-label">Sponsors & sleeves</span>
        <div className="logo-grid">{logoSlots.filter((slot) => !["crest", "brand"].includes(slot.id)).map(slotButton)}</div>
        <label className="field sponsor-text">
          <span>Sponsor as text</span>
          <input value={sponsor?.text ?? ""} maxLength={20} disabled={sponsor?.locked}
            placeholder="Type a name or brand"
            onChange={(e) => setSponsor(e.target.value)} />
        </label>
        <p className="section-copy fine">Printed across the chest. For a sponsor logo, use Front sponsor above.</p>
        <input ref={logoInput} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => {
          if (e.target.files[0] && pendingLogo) uploadLogo(e.target.files[0], pendingLogo);
          e.target.value = "";
        }} />
      </Section>}

      {tab === "layers" && <Section title="Design layers" eyebrow="03">
        <LayersPanel
          project={project}
          setProject={setProject}
          garment={garment}
          setGarment={setGarment}
          selected={selected}
          select={select}
          template={templates[models[garment]]}
          fonts={fonts}
          uploadImage={uploadImage}
        />
      </Section>}

      {tab === "player" && <Section title="Player details" eyebrow="04">
        <div className="row">
          <label className="field grow">
            <span>Name</span>
            <input value={project.player.name} onChange={(e) => set({ player: { ...project.player, name: cleanName(e.target.value) } })} />
          </label>
          <label className="field number">
            <span>Number</span>
            <input inputMode="numeric" value={project.player.number}
              onChange={(e) => set({ player: { ...project.player, number: cleanNumber(e.target.value) } })} />
          </label>
        </div>
        <label className="field">
          <span>Kit font</span>
          <select value={project.font} onChange={(e) => set({ font: e.target.value })}>
            {fonts.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.id }}>
                {f.id}
              </option>
            ))}
          </select>
        </label>
      </Section>}

      {tab === "export" && <Section title="Export" eyebrow="05">
        <div className="row">
          <button type="button" onClick={() => actions.screenshot()}>
            Screenshot (PNG)
          </button>
        </div>
        <div className="row">
          {["1:1", "16:9", "9:16"].map((a) => (
            <button key={a} type="button" className="quiet" onClick={() => actions.screenshot(a)} title={`Framed ${a} image, 2048 px long side`}>
              {a}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={actions.transparent} onChange={(e) => actions.setTransparent(e.target.checked)} />
          Transparent background
        </label>
        <label className="field">
          <span>Texture resolution</span>
          <select value={actions.textureSize} onChange={(e) => actions.setTextureSize(Number(e.target.value))}>
            {actions.textureSizes.map((s) => (
              <option key={s} value={s}>
                {s} × {s}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          {SHOWN_GARMENTS.map((g) => (
            <button key={g} type="button" className="quiet" onClick={() => actions.texture(g)}>
              {g[0].toUpperCase() + g.slice(1)} texture
            </button>
          ))}
        </div>
        {actions.hasMaps.length > 0 && (
          <div className="row">
            {actions.hasMaps.flatMap((g) => [
              <button key={`${g}-n`} type="button" className="quiet" onClick={() => actions.texture(g, "normal")}>
                {g[0].toUpperCase() + g.slice(1)} normal
              </button>,
              <button key={`${g}-o`} type="button" className="quiet" onClick={() => actions.texture(g, "orm")} title="Green: roughness, blue: metalness (glTF)">
                {g[0].toUpperCase() + g.slice(1)} rough/metal
              </button>,
            ])}
          </div>
        )}
      </Section>}

      {tab === "export" && <Section title="Save & load" eyebrow="06">
        <input ref={designInput} type="file" accept="application/json,.json" hidden onChange={(e) => {
          if (e.target.files[0]) actions.load(e.target.files[0]);
          e.target.value = "";
        }} />
        <div className="row">
          <button type="button" onClick={actions.save}>
            Save JSON
          </button>
          <button type="button" onClick={() => designInput.current.click()}>
            Load JSON
          </button>
          <button type="button" className="quiet" onClick={actions.reset}>
            Reset
          </button>
        </div>
      </Section>}
      </div>
      </div>
    </aside>
  );
}

function Section({ title, eyebrow, children, className = "" }) {
  return (
    <section className={`section ${className}`}>
      <h2>{eyebrow && <span className="section-index">{eyebrow}</span>}{title}</h2>
      {children}
    </section>
  );
}

/** Hide the placed layers (other than `role`'s) centred within 4 cm of a logo slot on the same surface. */
function hideAt(layers, slot, role) {
  return layers.map((l) => {
    if (l.type === "group") return { ...l, children: hideAt(l.children, slot, role) };
    const near = l.surface === slot.surface && l.role !== role && l.transform &&
      Math.hypot(l.transform.x - slot.x, l.transform.y - slot.y) < 0.04;
    return near && l.visible ? { ...l, visible: false } : l;
  });
}

/** Search real club crests and brand logos by name and drop the chosen one into a logo slot. */
function LogoFinder({ slots, onPick, onError }) {
  const [kind, setKind] = useState("crest");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("crest");
  const targets = kind === "crest" ? slots.filter((s) => s.id === "crest") : slots.filter((s) => s.id !== "crest");
  const search = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await (kind === "crest" ? searchCrests(query) : searchBrands(query)));
    } catch (err) {
      setResults([]);
      onError(`Could not search ${kind === "crest" ? "crests" : "logos"} (${err.message}). Check the connection, or upload the image instead.`);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (r) => {
    setBusy(true);
    try {
      await onPick(await fetchLogo(r.url, r.name), slots.find((s) => s.id === target));
    } catch (err) {
      onError(`Could not load that logo (${err.message}). Download it and upload the file instead.`);
    } finally {
      setBusy(false);
    }
  };
  const switchKind = (k) => {
    setKind(k);
    setResults(null);
    setTarget(k === "crest" ? "crest" : "brand");
  };
  return (
    <div className="logo-finder">
            <div className="seg" role="group" aria-label="Image type">
        <button type="button" className={kind === "crest" ? "on" : ""} aria-pressed={kind === "crest"} onClick={() => switchKind("crest")}>Club crest</button>
        <button type="button" className={kind === "brand" ? "on" : ""} aria-pressed={kind === "brand"} onClick={() => switchKind("brand")}>Brand / sponsor</button>
      </div>
      <form className="row" onSubmit={search}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search"
          placeholder={kind === "crest" ? "Club name, e.g. Arsenal" : "Brand, e.g. Nike, Adidas, Puma"} />
        <button type="submit" disabled={busy}>{busy ? "Searching…" : "Find"}</button>
      </form>
      {results && (
        <>
          <label className="field">
            <span>Place {kind === "crest" ? "crest" : "logo"} on</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          {results.length === 0 && <p className="section-copy">Nothing found.</p>}
          <div className="logo-results">
            {results.map((r) => (
              <button key={r.url} type="button" className="logo-result" title={r.name} disabled={busy} onClick={() => pick(r)}>
                <img src={r.thumb} alt="" loading="lazy" onError={(e) => { if (e.currentTarget.src !== r.url) e.currentTarget.src = r.url; }} />
                <span>{r.name}</span>
              </button>
            ))}
          </div>
          <p className="section-copy fine">
            {kind === "crest" ? "Crests from TheSportsDB" : "Logos from Wikimedia Commons"}. Club crests and brand logos are
            trademarks of their owners: use them for your own designs.
          </p>
        </>
      )}
    </div>
  );
}
