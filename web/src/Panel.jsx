import { useEffect, useRef, useState } from "react";
import { cleanName, cleanNumber } from "./design.js";
import LayersPanel, { StrokeField } from "./LayersPanel.jsx";
import { IDENTITY, SHOWN_GARMENTS, editLayers, findLayer, findRole, makeLayer, mapLayer, newId, walk } from "./project.js";
import { prepareArtwork, prepareLogo } from "./logoImage.js";
import { imageSize, normalizeImageUrl, resolveRemoteImage } from "./remoteImage.js";
import { fetchLogo, searchKitBrands, searchSponsors } from "./logoSearch.js";
import { KIT_BRANDS, POPULAR_CLUBS, presetToFile } from "./brandPresets.js";
import { brandLibrary } from "./brandVariants.js";

const BRAND_LIBRARY = brandLibrary(KIT_BRANDS); // the bundled brands plus their symbol / wordmark / combined variants
import ClubPickerModal from "./ClubPickerModal.jsx";
import LogoPickerModal from "./LogoPickerModal.jsx";
import PATCHES from "./patches.json";
import KitChecklist from "./KitChecklist.jsx";
import MyKits from "./MyKits.jsx";
import Select from "./Select.jsx";

// The sidebar is a guided flow, one step at a time. Layers holds the kit colours, the design and every logo.
const TABS = [
  { id: "layers", label: "Layers", hint: "Colours, design, logos and every layer of the kit", icon: "M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" },
  { id: "images", label: "Images", hint: "Your own pictures and textures", icon: "M4 5h16v14H4V5Zm0 11 4.5-4.5 3.5 3.5 3-3L20 16M9 9.5h.01" },
  { id: "player", label: "Player", hint: "Name, number and font", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6" },
  { id: "export", label: "Export", hint: "Check, save and share", icon: "M12 15V3m0 12-4-4m4 4 4-4M5 15v4h14v-4" },
];
const TAB_KEY = "kit-maker:panel-tab";

const savedTab = () => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.id === t) ? t : "layers"; // the old Design, Colours and Logos steps are all in Layers now
  } catch {
    return "layers";
  }
};

const COLORS_ID = "__colors"; // the pinned "Kit colours" row of the layer list is selectable like a layer

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const FINISH_PRESETS = [
  { id: "flat", label: "Flat print", finish: { relief: 0, stitch: false, roughness: null, metalness: null }, texture: "kit" },
  { id: "raised", label: "3D Raised", finish: { relief: 0.5, stitch: false, roughness: 0.5, metalness: null }, texture: "smooth" },
  { id: "embroidered", label: "Embroidered", finish: { relief: 0.45, stitch: true, roughness: 0.6, metalness: null }, texture: "smooth" },
  { id: "foil", label: "Metallic", finish: { relief: 0.1, stitch: false, roughness: 0.3, metalness: 0.9 }, texture: "smooth" },
];

const DEFAULT_SLOT_SIZES = {
  crest: 0.08,
  brand: 0.058,
  "shirt-sponsor": 0.22,
  "back-sponsor": 0.16,
  "sleeve-left": 0.065,
  "sleeve-right": 0.065,
};

export default function Panel({ project, setProject, garment, setGarment, templates, models, shirts, fonts, actions, onError }) {
  const designInput = useRef(null);
  const [showGuide, setShowGuide] = useState(() => {
    try { return !localStorage.getItem("kit-maker:guide-dismissed") && !localStorage.getItem("kit-maker:design"); }
    catch { return true; }
  });
  const [selection, setSelection] = useState({ shirt: COLORS_ID });
  const [tab, setTab] = useState(savedTab);
  const [activeSponsorSlotId, setActiveSponsorSlotId] = useState("shirt-sponsor");
  const [clubModalOpen, setClubModalOpen] = useState(false);
  const [logoModal, setLogoModal] = useState(null); // "brand" | "sponsor" | "patch"
  const [activePatchSlotId, setActivePatchSlotId] = useState("sleeve-left");

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage blocked */
    }
  }, [tab]);

  const colorsSelected = selection[garment] === COLORS_ID;
  const selected = selection[garment] && !colorsSelected && findLayer(project.garments[garment].layers, selection[garment]) ? selection[garment] : null;
  const select = (id, g = garment) => setSelection((s) => ({ ...s, [g]: id }));

  const set = (fields) => setProject((p) => ({ ...p, ...fields }));
  const shirtRole = (role) => findRole(project.garments.shirt.layers, role);

  /** Read an image file into project assets */
  const uploadImage = async (file, { artwork = false, strict = false } = {}) => {
    const fail = (message) => {
      if (strict) throw new Error(message);
      onError(message);
      return null;
    };
    if (!/^image\/(png|svg\+xml|jpeg|webp)$/.test(file.type)) {
      return fail("Images must be PNG, SVG, JPEG or WebP files.");
    }
    if (file.size > (file.type === "image/svg+xml" ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES)) {
      return fail(`That image is too large (${file.type === "image/svg+xml" ? "1.5" : "15"} MB max).`);
    }
    let src;
    try {
      src = artwork ? await prepareArtwork(file) : await prepareLogo(file);
    } catch {
      return fail("That image could not be read.");
    }
    if (src.length * 0.75 > MAX_IMAGE_BYTES) {
      return fail("That image is still too large after shrinking it (1.5 MB max).");
    }
    const id = newId("img");
    setProject((p) => ({ ...p, assets: { ...p.assets, [id]: { src, name: file.name } } }));
    return { id, name: file.name, src };
  };

  const sponsor = shirtRole("sponsor");

  const logoSlots = [
    { id: "crest", label: "Team crest", category: "crest", garment: "shirt", surface: "front", x: 0.095, y: 0.555 },
    { id: "brand", label: "Kit maker brand", category: "brand", garment: "shirt", surface: "front", x: -0.095, y: 0.555 },
    { id: "shirt-sponsor", label: "Front sponsor", category: "sponsor", garment: "shirt", surface: "front", x: 0, y: 0.38 },
    { id: "back-sponsor", label: "Back sponsor", category: "sponsor", garment: "shirt", surface: "back", x: 0, y: 0.42 },
    { id: "sleeve-left", label: "Left sleeve", category: "patch", garment: "shirt", surface: "sleeve_left", x: 0, y: 0.42 },
    { id: "sleeve-right", label: "Right sleeve", category: "patch", garment: "shirt", surface: "sleeve_right", x: 0, y: 0.42 },
  ];

  const slotLayer = (slot) => findRole(project.garments[slot.garment].layers, slot.id === "crest" ? "crest" : `logo-${slot.id}`);

  /**
   * Places or updates an image in a specific kit slot.
   * Fixed slots stay strictly at their designated coordinates rather than wandering.
   */
  const uploadLogo = async (file, slot, customSize = null, extraProps = {}, options = {}) => {
    const asset = await uploadImage(file, options);
    if (!asset) return;
    const role = slot.id === "crest" ? "crest" : `logo-${slot.id}`;
    const standardSize = customSize || DEFAULT_SLOT_SIZES[slot.id] || 0.08;

    const fresh = makeLayer("image", slot.garment, {
      role,
      name: slot.label,
      asset: asset.id,
      surface: slot.surface,
      texture: slot.id === "crest" || slot.id === "brand" ? "smooth" : "kit",
      size: standardSize,
      transform: { ...IDENTITY, x: slot.x, y: slot.y },
      ...extraProps,
    });

    const existing = findRole(project.garments[slot.garment].layers, role);
    setProject((p) => editLayers(p, slot.garment, (ls) => {
      const old = findRole(ls, role);
      const cleared = hideAt(ls, slot, role);
      if (old) {
        return mapLayer(cleared, old.id, (l) => ({
          ...l,
          asset: asset.id,
          // When a custom size is specified (e.g. from preset), use it; otherwise maintain layer size
          size: customSize || l.size || standardSize,
          ...extraProps,
        }));
      }
      return [...cleared, fresh];
    }));
    setGarment(slot.garment);
    select(existing?.id || fresh.id, slot.garment);
    // Turn the kit so the change is visible: crest/brand/front sponsor on the chest, back sponsor behind, sleeves from the side.
    actions.view(slot.surface === "back" ? "back" : slot.surface.startsWith("sleeve") ? "side" : "front");
  };


  const setBrandPosition = (posKey) => {
    const brandSlot = logoSlots.find((s) => s.id === "brand");
    const layer = slotLayer(brandSlot);
    if (!layer) return;
    const positions = {
      right: { x: -0.095, y: 0.555 },
      center: { x: 0, y: 0.51 },
      left: { x: 0.095, y: 0.555 },
    };
    const targetPos = positions[posKey] || positions.right;
    setProject((p) =>
      editLayers(p, "shirt", (ls) =>
        mapLayer(ls, layer.id, (l) => ({
          ...l,
          transform: { ...l.transform, x: targetPos.x, y: targetPos.y },
        })),
      ),
    );
  };

  const setCrestPosition = (posKey) => {
    const crestSlot = logoSlots.find((s) => s.id === "crest");
    const layer = slotLayer(crestSlot);
    if (!layer) return;
    const positions = {
      left: { x: 0.095, y: 0.555 },
      center: { x: 0, y: 0.555 },
    };
    const targetPos = positions[posKey] || positions.left;
    setProject((p) =>
      editLayers(p, "shirt", (ls) =>
        mapLayer(ls, layer.id, (l) => ({
          ...l,
          transform: { ...l.transform, x: targetPos.x, y: targetPos.y },
        })),
      ),
    );
  };

  const applyPreset = async (preset, targetSlot) => {
    const file = presetToFile(preset);
    await uploadLogo(file, targetSlot, preset.size || DEFAULT_SLOT_SIZES[targetSlot.id]);
  };

  const crestSlot = logoSlots.find((s) => s.id === "crest");
  const brandSlot = logoSlots.find((s) => s.id === "brand");
  const sponsorSlots = logoSlots.filter((s) => s.category === "sponsor");
  const activeSponsorSlot = sponsorSlots.find((s) => s.id === activeSponsorSlotId) || sponsorSlots[0];
  const patchSlots = logoSlots.filter((s) => s.category === "patch");
  const activePatchSlot = patchSlots.find((s) => s.id === activePatchSlotId) || patchSlots[0];

  const crestLayer = slotLayer(crestSlot);
  const crestPos = !crestLayer?.transform ? "left" : Math.abs(crestLayer.transform.x) < 0.03 ? "center" : "left";
  const crestStyle = crestLayer?.crestStyle || (crestLayer?.tint ? "mono" : "color");

  const pickPopularClub = async (club, explicitStyleMode) => {
    try {
      const mode = explicitStyleMode || crestStyle;
      const isMono = mode === "mono";
      const targetUrl = isMono && club.monoUrl ? club.monoUrl : (club.colorUrl || club.url);
      const file = await fetchLogo(targetUrl, `${club.name}${isMono ? "-mono" : ""}`);
      await uploadLogo(file, crestSlot, DEFAULT_SLOT_SIZES.crest, {
        crestStyle: isMono ? "mono" : "color",
        tint: isMono ? (crestLayer?.tint || "@trim") : null,
        clubData: {
          name: club.name,
          colorUrl: club.colorUrl || club.url,
          monoUrl: club.monoUrl || null,
        },
      });
    } catch (err) {
      onError(`Could not load crest (${err.message}).`);
    }
  };

  const setCrestStyleMode = async (mode) => {
    const layer = slotLayer(crestSlot);
    if (!layer) return;

    if (mode === "color") {
      if (layer.clubData?.colorUrl) {
        try {
          const file = await fetchLogo(layer.clubData.colorUrl, layer.clubData.name);
          const asset = await uploadImage(file);
          if (asset) {
            setProject((p) =>
              editLayers(p, "shirt", (ls) =>
                mapLayer(ls, layer.id, (l) => ({
                  ...l,
                  asset: asset.id,
                  crestStyle: "color",
                  tint: null,
                }))
              )
            );
            return;
          }
        } catch {
          /* fallback */
        }
      }
      setProject((p) =>
        editLayers(p, "shirt", (ls) =>
          mapLayer(ls, layer.id, (l) => ({
            ...l,
            crestStyle: "color",
            tint: null,
          }))
        )
      );
    } else {
      const defaultTint = layer.tint || "@trim";
      if (layer.clubData?.monoUrl) {
        try {
          const file = await fetchLogo(layer.clubData.monoUrl, `${layer.clubData.name}-mono`);
          const asset = await uploadImage(file);
          if (asset) {
            setProject((p) =>
              editLayers(p, "shirt", (ls) =>
                mapLayer(ls, layer.id, (l) => ({
                  ...l,
                  asset: asset.id,
                  crestStyle: "mono",
                  tint: defaultTint,
                }))
              )
            );
            return;
          }
        } catch {
          /* fallback */
        }
      }
      setProject((p) =>
        editLayers(p, "shirt", (ls) =>
          mapLayer(ls, layer.id, (l) => ({
            ...l,
            crestStyle: "mono",
            tint: defaultTint,
          }))
        )
      );
    }
  };

  // ---- Kit images: a file or a link, placed freely, filling a panel, or stretched over the whole texture
  const [imageFit, setImageFit] = useState("front"); // free | front | back | texture
  const [imageModal, setImageModal] = useState(false);
  const template = templates[models[garment]];
  const imageLayers = [];
  walk(project.garments.shirt.layers, (l) => l.type === "image" && !l.role && imageLayers.push(l));

  /** Add an image layer for asset `assetId` using the chosen fit. */
  const placeArtwork = async (assetId, src, name) => {
    const label = (name || "Image").replace(/\.\w+$/, "").slice(0, 40) || "Image";
    let fields = { asset: assetId, name: label, texture: "smooth" };
    if (imageFit === "texture") {
      fields = { ...fields, fit: "texture", surface: "front" };
    } else if (imageFit === "front" || imageFit === "back") {
      const isl = template?.islands?.[imageFit];
      const dim = await imageSize(src).catch(() => null);
      if (isl && dim) {
        const w = isl.rect[2] / isl.scale;
        const h = isl.rect[3] / isl.scale;
        const k = Math.max(w / dim.width, h / dim.height); // metres per pixel so the image covers the panel
        fields = {
          ...fields, surface: imageFit, size: Math.min(2.5, k * Math.max(dim.width, dim.height)),
          transform: { ...IDENTITY, x: isl.pmin + w / 2, y: isl.qmax - h / 2 },
        };
      } else {
        fields.surface = imageFit;
      }
    } else {
      fields = { ...fields, surface: "front", size: 0.2, transform: { ...IDENTITY, x: 0, y: 0.35 } };
    }
    const layer = makeLayer("image", "shirt", fields);
    // Fills sit above the base design and trims but below the text and logos; free images go on top.
    setProject((p) => editLayers(p, "shirt", (ls) => {
      if (imageFit === "free") return [...ls, layer];
      const at = ls.findIndex((l) => l.type !== "base" && l.type !== "pattern");
      return at < 0 ? [...ls, layer] : [...ls.slice(0, at), layer, ...ls.slice(at)];
    }));
    setGarment("shirt");
    select(layer.id, "shirt");
    actions.view(imageFit === "back" ? "back" : "front");
  };

  const addArtworkFile = async (file) => {
    const asset = await uploadImage(file, { artwork: true, strict: true });
    if (asset) await placeArtwork(asset.id, asset.src, asset.name);
  };

  const addArtworkUrl = async (url) => {
    const found = await resolveRemoteImage(url);
    const id = newId("img");
    setProject((p) => ({ ...p, assets: { ...p.assets, [id]: { src: found.src, name: found.name } } }));
    await placeArtwork(id, found.src, found.name);
  };

  const patchImageLayer = (id, fields) => setProject((p) => editLayers(p, "shirt", (ls) => mapLayer(ls, id, (l) => ({ ...l, ...fields }))));
  const setLayerSize = (id, size) => setProject((p) => editLayers(p, "shirt", (ls) => mapLayer(ls, id, (l) => ({ ...l, size }))));
  const removeImageLayer = (id) => setProject((p) => editLayers(p, "shirt", (ls) => ls.filter((l) => l.id !== id)));

  const addImageLink = async (url) => {
    try {
      const found = await resolveRemoteImage(url);
      const id = newId("img");
      setProject((p) => ({ ...p, assets: { ...p.assets, [id]: { src: found.src, name: found.name } } }));
      return id;
    } catch (err) {
      onError(err.message);
      return null;
    }
  };

  // ---- steps
  const stepIndex = Math.max(0, TABS.findIndex((t) => t.id === tab));
  const go = (i) => setTab(TABS[Math.max(0, Math.min(TABS.length - 1, i))].id);

  const filledSlots = Object.fromEntries(logoSlots.map((s) => [s.id, !!slotLayer(s)]));

  // ---- export checklist
  const checklist = [
    { id: "crest", label: "Club crest", done: filledSlots.crest, step: "layers", slot: "crest" },
    { id: "brand", label: "Kit brand", done: filledSlots.brand, step: "layers", slot: "brand", optional: true },
    { id: "sponsor", label: "Front sponsor", done: filledSlots["shirt-sponsor"] || !!sponsor?.text, step: "layers", slot: "shirt-sponsor", optional: true },
    { id: "name", label: "Player name", done: !!project.player.name.trim(), step: "player" },
    { id: "number", label: "Player number", done: !!project.player.number.trim(), step: "player" },
  ];
  const goItem = (item) => {
    setTab(item.step);
    if (item.slot) logo.add(item.slot);
  };

  /** Open the right "add a picture" popup for a logo slot. */
  const openSlot = (slot) => {
    if (slot.id === "crest") setClubModalOpen(true);
    else if (slot.id === "brand") setLogoModal("brand");
    else if (slot.category === "patch") {
      setActivePatchSlotId(slot.id);
      setLogoModal("patch");
    } else {
      setActiveSponsorSlotId(slot.id);
      setLogoModal("sponsor");
    }
  };

  /** A pasted link as a File, so it goes through the same clean-up as an upload. */
  const linkToFile = async (url) => {
    const href = normalizeImageUrl(url);
    const name = decodeURIComponent(href.split("?")[0].split("/").pop() || "logo").replace(/\.\w+$/, "") || "logo";
    try {
      return await fetchLogo(href, name);
    } catch {
      throw new Error("Could not load that link. Use the direct address of the image (it ends in .png, .jpg, .webp or .svg).");
    }
  };
  const strict = { strict: true };
  const slotFile = (slot, extra = {}, size = null) => (file) => uploadLogo(file, slot, size, extra, strict);
  const slotLink = (slot, extra = {}, size = null) => async (url) => uploadLogo(await linkToFile(url), slot, size, extra, strict);


  const brandLayer = slotLayer(brandSlot);
  const brandPos = !brandLayer?.transform
    ? "right"
    : Math.abs(brandLayer.transform.x) < 0.03
    ? "center"
    : brandLayer.transform.x > 0
    ? "left"
    : "right";

  /** What the Layers panel needs to edit logos: which spots are filled, the libraries, the crest style and positions. */
  const logo = {
    filled: filledSlots,
    slotOf: (layer) => logoSlots.find((s) => (s.id === "crest" ? "crest" : `logo-${s.id}`) === layer.role) || null,
    change: openSlot,
    // An existing logo is selected for editing; an empty spot opens its library.
    add: (id) => {
      const slot = logoSlots.find((x) => x.id === id);
      const existing = slotLayer(slot);
      if (existing) select(existing.id, slot.garment);
      else openSlot(slot);
    },
    crestStyle,
    setCrestStyle: setCrestStyleMode,
    position: (slot) => (slot.id === "crest" ? crestPos : brandPos),
    setPosition: (slot, key) => (slot.id === "crest" ? setCrestPosition(key) : setBrandPosition(key)),
    quickClubs: POPULAR_CLUBS.slice(0, 8),
    pickClub: pickPopularClub,
    openClubs: () => setClubModalOpen(true),
  };

  return (
    <aside className="panel" aria-label="Kit design">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">K</div>
        <div><h1>Kit Maker</h1><p>Custom kit studio</p></div>
        <button className="quiet header-action" type="button" onClick={actions.reset} title="Start a new design" aria-label="New design">+</button>
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
      <div className="panel-sub">
        <span title={TABS[stepIndex].hint}>Step {stepIndex + 1} of {TABS.length}</span>
        <span className="panel-sub-hint">{TABS[stepIndex].hint}</span>
      </div>
      <div className="panel-content">
      {tab === "layers" && showGuide && <div className="quick-start">
        <button type="button" className="quiet quick-start-close" aria-label="Dismiss getting started guide" onClick={() => {
          setShowGuide(false);
          try { localStorage.setItem("kit-maker:guide-dismissed", "1"); } catch { /* private browsing */ }
        }}>x</button>
        <strong>Make your first kit in four steps</strong>
        <p>Everything about the shirt is a layer: pick one and its options open on top. Then add images, the player and export.</p>
      </div>}
      {tab === "layers" && <Section title="Layers" eyebrow="01" className="layers-section">
        <LayersPanel
          project={project}
          setProject={setProject}
          garment={garment}
          setGarment={setGarment}
          selected={selected}
          select={select}
          colorsSelected={colorsSelected}
          selectColors={() => select(COLORS_ID)}
          setPalette={(palette) => set({ palette })}
          logo={logo}
          template={templates[models[garment]]}
          fonts={fonts}
          uploadImage={uploadImage}
          addLink={addImageLink}
        />
      </Section>}

      {tab === "images" && <Section title="Kit images" eyebrow="02">
        <p className="section-copy">Add your own artwork or a full texture. Links have no size limit and keep your saved design small.</p>
        <span className="group-label">How should it fit?</span>
        <div className="fit-options" role="radiogroup" aria-label="Image fit">
          {[
            ["front", "Fill front", "Covers the front of the shirt"],
            ["back", "Fill back", "Covers the back of the shirt"],
            ["texture", "Whole texture", "Stretched over the full kit texture, like the downloaded shirt texture"],
            ["free", "Free image", "A smaller image you move and resize"],
          ].map(([id, label, hint]) => (
            <button key={id} type="button" role="radio" aria-checked={imageFit === id} className={`fit-card${imageFit === id ? " active" : ""}`} onClick={() => setImageFit(id)}>
              <strong>{label}</strong><span>{hint}</span>
            </button>
          ))}
        </div>
        <button type="button" className="add-image-btn" onClick={() => setImageModal(true)}>Add image</button>
        <p className="section-copy fine">Upload from your device or paste a link. On imgbb, copy the "Direct link".</p>
        {imageLayers.length > 0 && (
          <>
            <span className="group-label">Images on the kit</span>
            <ul className="kit-images">
              {imageLayers.map((l) => {
                const a = project.assets[l.asset];
                return (
                  <li key={l.id} className={`kit-image${l.id === selected ? " selected" : ""}`}>
                    <div className="kit-image-head">
                      <span className="kit-image-thumb">{a && <img src={a.src} alt="" />}</span>
                      <span className="kit-image-name">{l.name}<small>{l.fit === "texture" ? "Whole texture" : (l.surface || "front").replace("_", " ")}</small></span>
                      <button type="button" className="quiet slot-act-btn" onClick={() => { select(l.id, "shirt"); setTab("layers"); }}>Edit</button>
                      <button type="button" className="quiet slot-act-btn danger" aria-label={`Remove ${l.name}`} onClick={() => removeImageLayer(l.id)}>x</button>
                    </div>
                    {l.fit !== "texture" && (
                      <SliderField label="Size" value={Math.round(l.size * 100)} unit="cm" min={2} max={Math.max(150, Math.round(l.size * 100))} step={1}
                        onChange={(cm) => setLayerSize(l.id, cm / 100)} />
                    )}
                    <details className="kit-image-more">
                      <summary>Print texture{l.fit === "texture" ? "" : " & border"}</summary>
                      <div className="kit-image-options">
                        <FinishSelector finish={l.finish} texture={l.texture}
                          onChange={(fin) => patchImageLayer(l.id, { finish: { ...fin.finish }, texture: fin.texture })} />
                        {l.fit !== "texture" && (
                          <>
                            <TintPicker value={l.tint} palette={project.palette} onChange={(tint) => patchImageLayer(l.id, { tint })} />
                            <StrokeField stroke={l.stroke} palette={project.palette} onChange={(stroke) => patchImageLayer(l.id, { stroke })} />
                          </>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>}

      {tab === "player" && <Section title="Player details" eyebrow="03">
        <div className="row">
          <label className="field grow">
            <span>Name</span>
            <input value={project.player.name} maxLength={14} autoComplete="off" onChange={(e) => set({ player: { ...project.player, name: cleanName(e.target.value) } })} />
          </label>
          <label className="field number">
            <span>Number</span>
            <input inputMode="numeric" maxLength={2} autoComplete="off" value={project.player.number}
              onChange={(e) => set({ player: { ...project.player, number: cleanNumber(e.target.value) } })} />
          </label>
        </div>
        <p className="hint">Name up to 14 characters, number up to 2 digits. They print on the back; rotate the kit to check.</p>
        <button type="button" className="quiet" onClick={() => actions.view("back")}>Show back of shirt</button>
        <span className="group-label">Number and name font</span>
        <div className="font-gallery" role="radiogroup" aria-label="Kit font">
          {fonts.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={project.font === f.id}
              className={`font-card${project.font === f.id ? " active" : ""}`} onClick={() => set({ font: f.id })}>
              <span className="font-sample" style={{ fontFamily: `"${f.id}", Impact, sans-serif`, fontWeight: f.weight }}>{project.player.number || "10"}</span>
              <span className="font-name">{f.id}</span>
            </button>
          ))}
        </div>
      </Section>}

      {tab === "export" && <Section title="Export" eyebrow="04">
        <KitChecklist items={checklist} onGo={goItem} />
        <p className="section-copy">Takes a 4K picture of the current 3D view (2K on phones). You can preview it before downloading.</p>
        <div className="row">
          <button type="button" onClick={() => actions.screenshot()}>
            4K screenshot (PNG)
          </button>
        </div>
        <span className="group-label">Social media crop</span>
        <div className="row">
          {[["1:1", "Square"], ["16:9", "Wide"], ["9:16", "Story"]].map(([a, name]) => (
            <button key={a} type="button" className="quiet" onClick={() => actions.screenshot(a)} title={`${name} ${a} image, 4K (3840 px on the long side)`}>
              {name} <small>{a}</small>
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={actions.transparent} onChange={(e) => actions.setTransparent(e.target.checked)} />
          Transparent background
        </label>
        <label className="field">
          <span>Texture resolution (for the downloads below)</span>
          <Select value={actions.textureSize} onChange={(e) => actions.setTextureSize(Number(e.target.value))}>
            {actions.textureSizes.map((s) => (
              <option key={s} value={s}>
                {s} x {s}
              </option>
            ))}
          </Select>
        </label>
        <div className="row">
          {SHOWN_GARMENTS.map((g) => (
            <button key={g} type="button" className="quiet" onClick={() => actions.texture(g)}>
              Download {g} texture
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

      {tab === "export" && <Section title="Save & load">
        <p className={`save-status ${actions.saveStatus === "unavailable" ? "warning" : ""}`} role="status">
          {actions.saveStatus === "saved" ? "Saved on this device" : actions.saveStatus === "unavailable" ? "Browser storage unavailable. Export a JSON copy to keep your design." : "Saving..."}
        </p>
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
        </div>
        <button type="button" className="quiet danger reset-btn" onClick={actions.reset}>
          Reset to starter design
        </button>
      </Section>}
      {tab === "export" && <Section title="My kits & sharing">
        <MyKits actions={actions} onError={onError} />
      </Section>}
      </div>
      <footer className="panel-footer">
        <button type="button" className="quiet" disabled={stepIndex === 0} onClick={() => go(stepIndex - 1)}>Back</button>
        <span className="step-dots" aria-hidden="true">{TABS.map((t, i) => <i key={t.id} className={i === stepIndex ? "on" : i < stepIndex ? "past" : ""} />)}</span>
        {stepIndex < TABS.length - 1
          ? <button type="button" onClick={() => go(stepIndex + 1)}>Next: {TABS[stepIndex + 1].label}</button>
          : <button type="button" onClick={() => actions.screenshot()}>Screenshot</button>}
      </footer>
      </div>
      <ClubPickerModal
        isOpen={clubModalOpen}
        onClose={() => setClubModalOpen(false)}
        onSelectClub={pickPopularClub}
        onPickFile={slotFile(crestSlot, { crestStyle: "color", tint: null, clubData: null }, DEFAULT_SLOT_SIZES.crest)}
        onPickLink={slotLink(crestSlot, { crestStyle: "color", tint: null, clubData: null }, DEFAULT_SLOT_SIZES.crest)}
        currentClub={crestLayer?.clubData}
        activeCrestStyle={crestStyle}
        palette={project.palette}
      />
      <LogoPickerModal
        isOpen={logoModal === "brand"}
        onClose={() => setLogoModal(null)}
        title="Add kit brand"
        subtitle="Pick a supplier from the library, paste a link or upload your own"
        targetLabel={brandSlot.label}
        presets={BRAND_LIBRARY}
        presetsTitle="Popular kit brands"
        placeholder="Search brands (e.g. Kappa, Castore, Lotto)..."
        onSearch={searchKitBrands}
        onPickPreset={(b) => applyPreset(b, brandSlot)}
        onPick={(file) => uploadLogo(file, brandSlot)}
        onPickFile={slotFile(brandSlot)}
        onPickLink={slotLink(brandSlot)}
        onError={onError}
      />
      <LogoPickerModal
        isOpen={logoModal === "sponsor"}
        onClose={() => setLogoModal(null)}
        title="Add sponsor"
        subtitle="Search the library, paste a link or upload your own"
        targets={sponsorSlots}
        targetId={activeSponsorSlot.id}
        onTarget={setActiveSponsorSlotId}
        placeholder="Search sponsors (e.g. Spotify, Pirelli, Audi)..."
        onSearch={searchSponsors}
        onPick={(file) => uploadLogo(file, activeSponsorSlot)}
        onPickFile={slotFile(activeSponsorSlot)}
        onPickLink={slotLink(activeSponsorSlot)}
        onError={onError}
      />
      <LogoPickerModal
        isOpen={logoModal === "patch"}
        onClose={() => setLogoModal(null)}
        title="Add patch"
        subtitle="League, Champions League, cup and tournament badges, or your own"
        targets={patchSlots}
        targetId={activePatchSlot.id}
        onTarget={setActivePatchSlotId}
        presets={PATCHES}
        presetsTitle="Competition patches"
        placeholder="Filter patches (e.g. Champions, Premier, Copa)..."
        onPickPreset={async (p) => uploadLogo(await fetchLogo(p.url, p.name), activePatchSlot, 0.07, {}, strict)}
        onPickFile={slotFile(activePatchSlot)}
        onPickLink={slotLink(activePatchSlot)}
        onError={onError}
      />
      <LogoPickerModal
        isOpen={imageModal}
        onClose={() => setImageModal(false)}
        title="Add image"
        subtitle="Paste a link or upload a file"
        targetLabel={{ front: "Fill the front", back: "Fill the back", texture: "Whole kit texture", free: "A free image" }[imageFit]}
        onPickFile={addArtworkFile}
        onPickLink={addArtworkUrl}
        onError={onError}
      />
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

/** Size adjustment slider */
function SliderField({ label, value, unit, min, max, step = 1, onChange }) {
  return (
    <label className="slider">
      <span>
        <span>{label}</span>
        <output>{value}{unit ? ` ${unit}` : ""}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Color tint picker for monochrome marks matching kit colors */
function TintPicker({ value, palette, onChange }) {
  const options = [
    { label: "Original colors", value: null, bg: "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" },
    { label: "White", value: "#ffffff", bg: "#ffffff" },
    { label: "Black", value: "#111111", bg: "#111111" },
    { label: "Gold", value: "#d4af37", bg: "#d4af37" },
    { label: "Primary (@0)", value: "@0", bg: palette[0] },
    { label: "Secondary (@1)", value: "@1", bg: palette[1] },
    { label: "Trim (@2)", value: "@2", bg: palette[2] },
  ];
  return (
    <div className="tint-picker-block">
      <span className="group-label">Color tint</span>
      <div className="swatches">
        {options.map((opt) => (
          <button
            key={opt.label}
            type="button"
            className={`swatch${value === opt.value ? " active" : ""}`}
            style={{ background: opt.bg }}
            title={opt.label}
            onClick={() => onChange(opt.value)}
          />
        ))}
      </div>
    </div>
  );
}

/** Finish selector (Flat, 3D Raised, Embroidered, Metallic) */
function FinishSelector({ finish, texture, onChange }) {
  const activePreset =
    FINISH_PRESETS.find((p) => p.texture === texture && JSON.stringify(p.finish) === JSON.stringify(finish))?.id ||
    (finish?.stitch ? "embroidered" : finish?.relief > 0 ? "raised" : finish?.metalness ? "foil" : "flat");

  return (
    <div className="finish-selector-block">
      <span className="group-label">Finish / texture</span>
      <div className="chips">
        {FINISH_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip${activePreset === p.id ? " on" : ""}`}
            onClick={() => onChange(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
