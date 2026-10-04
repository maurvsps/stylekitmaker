import { useRef, useState } from "react";
import { cleanName, cleanNumber } from "./design.js";
import LayersPanel from "./LayersPanel.jsx";
import { IDENTITY, PALETTE_LABELS, editLayers, findLayer, findRole, makeLayer, mapLayer, newId } from "./project.js";

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

export default function Panel({ project, setProject, garment, setGarment, templates, models, shirts, fonts, actions, onError }) {
  const designInput = useRef(null);
  const logoInput = useRef(null);
  const [pendingLogo, setPendingLogo] = useState(null);
  const [selection, setSelection] = useState({}); // garment -> selected layer id
  const selected = selection[garment] && findLayer(project.garments[garment].layers, selection[garment]) ? selection[garment] : null;
  const select = (id, g = garment) => setSelection((s) => ({ ...s, [g]: id }));

  const set = (fields) => setProject((p) => ({ ...p, ...fields }));
  const shirtRole = (role) => findRole(project.garments.shirt.layers, role);

  /** Read an image file into the project's assets; resolves to { id, name } (or null after showing an error). */
  const uploadImage = (file) =>
    new Promise((resolve) => {
      if (!/^image\/(png|svg\+xml|jpeg|webp)$/.test(file.type)) {
        onError("Images must be PNG, SVG, JPEG or WebP files.");
        return resolve(null);
      }
      if (file.size > MAX_IMAGE_BYTES) {
        onError("That image is too large (1.5 MB max).");
        return resolve(null);
      }
      const reader = new FileReader();
      reader.onload = () => {
        const id = newId("img");
        setProject((p) => ({ ...p, assets: { ...p.assets, [id]: { src: reader.result, name: file.name } } }));
        resolve({ id, name: file.name });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  // Shortcuts: the crest and sponsor are ordinary shirt layers marked with a role.
  const setSponsor = (text) =>
    setProject((p) =>
      editLayers(p, "shirt", (ls) => {
        const layer = findRole(ls, "sponsor");
        if (layer) return mapLayer(ls, layer.id, (l) => ({ ...l, text }));
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
    { id: "shorts-mark", label: "Shorts", garment: "shorts", surface: "front", x: 0.12, y: 0.27 },
    { id: "sock-mark", label: "Socks", garment: "socks", surface: "sock_left", x: 0, y: -0.36 },
  ];
  const uploadLogo = async (file, slot) => {
    const asset = await uploadImage(file);
    if (!asset) return;
    const role = slot.id === "crest" ? "crest" : `logo-${slot.id}`;
    const fresh = makeLayer("image", slot.garment, {
      role, name: slot.label, asset: asset.id, surface: slot.surface,
      size: slot.id.includes("sleeve") ? 0.055 : slot.id.includes("sponsor") ? 0.16 : 0.085,
      transform: { ...IDENTITY, x: slot.x, y: slot.y },
    });
    const existing = findRole(project.garments[slot.garment].layers, role);
    setProject((p) => editLayers(p, slot.garment, (ls) => {
      const old = findRole(ls, role);
      return old ? mapLayer(ls, old.id, (l) => ({ ...l, asset: asset.id })) : [...ls, fresh];
    }));
    setGarment(slot.garment);
    select(existing?.id || fresh.id, slot.garment);
  };
  const slotLayer = (slot) => findRole(project.garments[slot.garment].layers, slot.id === "crest" ? "crest" : `logo-${slot.id}`);

  return (
    <aside className="panel" aria-label="Kit design">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">K</div>
        <div><h1>Kit Maker</h1><p>Custom kit studio</p></div>
        <button className="quiet header-action" type="button" onClick={actions.reset} title="Start a new design" aria-label="New design">＋</button>
      </header>

      <Section title="Settings" eyebrow="01">
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
            <label key={i} className="color">
              <input type="color" value={c} onChange={(e) => set({ palette: project.palette.map((x, k) => (k === i ? e.target.value : x)) })} />
              <span>{PALETTE_LABELS[i]}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Logos" eyebrow="02" className="logo-section">
        <p className="section-copy">Add artwork to common kit positions. Fine-tune placement in Layers.</p>
        <div className="logo-grid">
          {logoSlots.map((slot) => {
            const layer = slotLayer(slot);
            const asset = layer && project.assets[layer.asset];
            return <button type="button" className={`logo-slot${layer ? " populated" : ""}`} key={slot.id} onClick={() => {
              setPendingLogo(slot); logoInput.current.click();
            }}>
              <span className="logo-preview">{asset ? <img src={asset.src} alt="" /> : <span aria-hidden="true">＋</span>}</span>
              <span className="logo-slot-label">{slot.label}</span>
              <span className="logo-slot-file">{asset?.name || "Upload image"}</span>
            </button>;
          })}
        </div>
        <input ref={logoInput} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => {
          if (e.target.files[0] && pendingLogo) uploadLogo(e.target.files[0], pendingLogo);
          e.target.value = "";
        }} />
      </Section>

      <Section title="Design layers" eyebrow="03">
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
      </Section>

      <Section title="Player details" eyebrow="04">
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
        <label className="field">
          <span>Sponsor</span>
          <input value={sponsor?.text ?? ""} maxLength={20} disabled={sponsor?.locked} onChange={(e) => setSponsor(e.target.value)} />
        </label>
      </Section>

      <Section title="Export" eyebrow="05">
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
          {["shirt", "shorts", "socks"].map((g) => (
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
      </Section>

      <Section title="Save & load" eyebrow="06">
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
      </Section>
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
