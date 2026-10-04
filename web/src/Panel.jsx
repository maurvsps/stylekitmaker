import { useRef, useState } from "react";
import { cleanName, cleanNumber } from "./design.js";
import LayersPanel from "./LayersPanel.jsx";
import { IDENTITY, PALETTE_LABELS, editLayers, findLayer, findRole, makeLayer, mapLayer, newId, removeLayer } from "./project.js";

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

export default function Panel({ project, setProject, garment, setGarment, templates, models, shirts, fonts, actions, onError }) {
  const designInput = useRef(null);
  const crestInput = useRef(null);
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
  const onCrestFile = async (file) => {
    const asset = await uploadImage(file);
    if (!asset) return;
    const fresh = makeLayer("image", "shirt", { role: "crest", name: "Crest", asset: asset.id, transform: { ...IDENTITY, x: 0.095, y: 0.555 } });
    setProject((p) =>
      editLayers(p, "shirt", (ls) => {
        const layer = findRole(ls, "crest");
        return layer ? mapLayer(ls, layer.id, (l) => ({ ...l, asset: asset.id })) : [...ls, fresh];
      }),
    );
  };
  const crest = shirtRole("crest");
  const sponsor = shirtRole("sponsor");

  return (
    <aside className="panel" aria-label="Kit design">
      <h1>Kit Maker</h1>

      <Section title="Template">
        <select value={project.template} onChange={(e) => set({ template: e.target.value })} aria-label="Shirt template">
          {shirts.map((k) => (
            <option key={k.name} value={k.name}>
              {k.label}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Kit colours">
        <div className="colors">
          {project.palette.map((c, i) => (
            <label key={i} className="color">
              <input type="color" value={c} onChange={(e) => set({ palette: project.palette.map((x, k) => (k === i ? e.target.value : x)) })} />
              <span>{PALETTE_LABELS[i]}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Layers">
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

      <Section title="Player">
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

      <Section title="Crest">
        <input ref={crestInput} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => {
          if (e.target.files[0]) onCrestFile(e.target.files[0]);
          e.target.value = "";
        }} />
        <div className="row">
          <button type="button" disabled={crest?.locked} onClick={() => crestInput.current.click()}>
            {crest ? "Replace" : "Upload image"}
          </button>
          {crest && (
            <>
              <button type="button" className="quiet" onClick={() => {
                setGarment("shirt");
                select(crest.id, "shirt");
              }}>
                Position
              </button>
              <button type="button" className="quiet" disabled={crest.locked}
                onClick={() => setProject((p) => editLayers(p, "shirt", (ls) => removeLayer(ls, crest.id)))}>
                Remove
              </button>
            </>
          )}
        </div>
        {crest?.asset && <p className="file-name">{project.assets[crest.asset]?.name}</p>}
      </Section>

      <Section title="Export">
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
      </Section>

      <Section title="Design file">
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

function Section({ title, children }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
