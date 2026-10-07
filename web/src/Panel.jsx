import { useEffect, useRef, useState } from "react";
import { cleanName, cleanNumber } from "./design.js";
import ColorButton from "./ColorPicker.jsx";
import LayersPanel, { StrokeField } from "./LayersPanel.jsx";
import { IDENTITY, PALETTE_LABELS, SHOWN_GARMENTS, editLayers, findLayer, findRole, makeLayer, mapLayer, newId, walk } from "./project.js";
import { prepareArtwork, prepareLogo } from "./logoImage.js";
import { imageSize, resolveRemoteImage } from "./remoteImage.js";
import { fetchLogo, searchKitBrands, searchSponsors } from "./logoSearch.js";
import { KIT_BRANDS, POPULAR_CLUBS, presetToFile } from "./brandPresets.js";
import ClubPickerModal from "./ClubPickerModal.jsx";
import LogoPickerModal from "./LogoPickerModal.jsx";
import DesignStep from "./DesignStep.jsx";
import ColorsStep from "./ColorsStep.jsx";
import PlacementMap from "./PlacementMap.jsx";
import KitChecklist from "./KitChecklist.jsx";
import MyKits from "./MyKits.jsx";

// The sidebar is a guided flow: one step at a time, in the order a kit gets made. Layers is the advanced mode.
const TABS = [
  { id: "design", label: "Design", hint: "Pick a shirt and a pattern", icon: "M8 4 4 6.5 5.5 10 7 9.3V20h10V9.3l1.5.7L20 6.5 16 4c-.5 1.6-2.1 2.7-4 2.7S8.5 5.6 8 4Z" },
  { id: "colors", label: "Colours", hint: "Choose the kit colours", icon: "M12 3a9 9 0 1 0 0 18c1.7 0 2.4-1 2-2.2-.4-1.2.3-2.3 1.6-2.3H18a3 3 0 0 0 3-3c0-5-4-10.5-9-10.5ZM7.5 11h.01M10 7.5h.01M14.5 7.5h.01" },
  { id: "logos", label: "Logos", hint: "Crest, kit brand and sponsors", icon: "M12 3 5 5.5V11c0 4.4 3 8.2 7 10 4-1.8 7-5.6 7-10V5.5L12 3Z" },
  { id: "images", label: "Images", hint: "Your own pictures and textures", icon: "M4 5h16v14H4V5Zm0 11 4.5-4.5 3.5 3.5 3-3L20 16M9 9.5h.01" },
  { id: "player", label: "Player", hint: "Name, number and font", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6" },
  { id: "export", label: "Export", hint: "Check, save and share", icon: "M12 15V3m0 12-4-4m4 4 4-4M5 15v4h14v-4" },
];
const TAB_KEY = "kit-maker:panel-tab";
const LOGO_SUBTAB_KEY = "kit-maker:logo-subtab";

const savedTab = () => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === "kit") return "design"; // the old name of the first tab
    return TABS.some((x) => x.id === t) || t === "layers" ? t : "design";
  } catch {
    return "design";
  }
};

const savedLogoSubTab = () => {
  try {
    const t = localStorage.getItem(LOGO_SUBTAB_KEY);
    return ["crest", "brand", "sponsors", "all"].includes(t) ? t : "brand";
  } catch {
    return "brand";
  }
};

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
  const logoInput = useRef(null);
  const [pendingLogo, setPendingLogo] = useState(null);
  const [showGuide, setShowGuide] = useState(() => {
    try { return !localStorage.getItem("kit-maker:guide-dismissed") && !localStorage.getItem("kit-maker:design"); }
    catch { return true; }
  });
  const [selection, setSelection] = useState({});
  const [tab, setTab] = useState(savedTab);
  const [logoSubTab, setLogoSubTab] = useState(savedLogoSubTab);
  const [activeSponsorSlotId, setActiveSponsorSlotId] = useState("shirt-sponsor");
  const [clubModalOpen, setClubModalOpen] = useState(false);
  const [logoModal, setLogoModal] = useState(null); // "brand" | "sponsor"

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage blocked */
    }
  }, [tab]);

  useEffect(() => {
    try {
      localStorage.setItem(LOGO_SUBTAB_KEY, logoSubTab);
    } catch {
      /* storage blocked */
    }
  }, [logoSubTab]);

  const selected = selection[garment] && findLayer(project.garments[garment].layers, selection[garment]) ? selection[garment] : null;
  const select = (id, g = garment) => setSelection((s) => ({ ...s, [g]: id }));

  const set = (fields) => setProject((p) => ({ ...p, ...fields }));
  const shirtRole = (role) => findRole(project.garments.shirt.layers, role);

  /** Read an image file into project assets */
  const uploadImage = async (file, { artwork = false } = {}) => {
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
      src = artwork ? await prepareArtwork(file) : await prepareLogo(file);
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
    return { id, name: file.name, src };
  };

  // Text sponsor
  const setSponsor = (text) =>
    setProject((p) =>
      editLayers(p, "shirt", (ls) => {
        const layer = findRole(ls, "sponsor");
        if (layer) return mapLayer(ls, layer.id, (l) => ({ ...l, text, visible: true }));
        return [...ls, makeLayer("text", "shirt", { role: "sponsor", name: "Sponsor", text, size: 0.065, maxWidth: 0.32, transform: { ...IDENTITY, y: 0.39 } })];
      }),
    );

  const clearSponsorText = () =>
    setProject((p) => editLayers(p, "shirt", (ls) => ls.filter((l) => l.role !== "sponsor")));

  const sponsor = shirtRole("sponsor");

  const logoSlots = [
    { id: "crest", label: "Team crest", category: "crest", garment: "shirt", surface: "front", x: 0.095, y: 0.555 },
    { id: "brand", label: "Kit maker brand", category: "brand", garment: "shirt", surface: "front", x: -0.095, y: 0.555 },
    { id: "shirt-sponsor", label: "Front sponsor", category: "sponsor", garment: "shirt", surface: "front", x: 0, y: 0.38 },
    { id: "back-sponsor", label: "Back sponsor", category: "sponsor", garment: "shirt", surface: "back", x: 0, y: 0.42 },
    { id: "sleeve-left", label: "Left sleeve", category: "sponsor", garment: "shirt", surface: "sleeve_left", x: 0, y: 0.42 },
    { id: "sleeve-right", label: "Right sleeve", category: "sponsor", garment: "shirt", surface: "sleeve_right", x: 0, y: 0.42 },
  ];

  const slotLayer = (slot) => findRole(project.garments[slot.garment].layers, slot.id === "crest" ? "crest" : `logo-${slot.id}`);

  /**
   * Places or updates an image in a specific kit slot.
   * Fixed slots stay strictly at their designated coordinates rather than wandering.
   */
  const uploadLogo = async (file, slot, customSize = null, extraProps = {}) => {
    const asset = await uploadImage(file);
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


  const removeLogo = (slot) => {
    const role = slot.id === "crest" ? "crest" : `logo-${slot.id}`;
    setProject((p) => editLayers(p, slot.garment, (ls) => ls.filter((l) => l.role !== role)));
  };

  const setSlotSize = (slot, sizeMeters) => {
    const layer = slotLayer(slot);
    if (!layer) return;
    setProject((p) => editLayers(p, slot.garment, (ls) => mapLayer(ls, layer.id, (l) => ({ ...l, size: sizeMeters }))));
  };

  const setSlotTint = (slot, tint) => {
    const layer = slotLayer(slot);
    if (!layer) return;
    setProject((p) => editLayers(p, slot.garment, (ls) => mapLayer(ls, layer.id, (l) => ({ ...l, tint }))));
  };

  const setSlotStroke = (slot, stroke) => {
    const layer = slotLayer(slot);
    if (!layer) return;
    setProject((p) => editLayers(p, slot.garment, (ls) => mapLayer(ls, layer.id, (l) => ({ ...l, stroke }))));
  };

  const setSlotFinish = (slot, finishItem) => {
    const layer = slotLayer(slot);
    if (!layer) return;
    setProject((p) =>
      editLayers(p, slot.garment, (ls) =>
        mapLayer(ls, layer.id, (l) => ({
          ...l,
          finish: { ...finishItem.finish },
          texture: finishItem.texture,
        })),
      ),
    );
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
  const [imageUrl, setImageUrl] = useState("");
  const [imageFit, setImageFit] = useState("front"); // free | front | back | texture
  const [imageBusy, setImageBusy] = useState(false);
  const artworkInput = useRef(null);
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
    setImageBusy(true);
    try {
      const asset = await uploadImage(file, { artwork: true });
      if (asset) await placeArtwork(asset.id, asset.src, asset.name);
    } finally {
      setImageBusy(false);
    }
  };

  const addArtworkLink = async (e) => {
    e.preventDefault();
    setImageBusy(true);
    try {
      const found = await resolveRemoteImage(imageUrl);
      const id = newId("img");
      setProject((p) => ({ ...p, assets: { ...p.assets, [id]: { src: found.src, name: found.name } } }));
      await placeArtwork(id, found.src, found.name);
      setImageUrl("");
    } catch (err) {
      onError(err.message);
    } finally {
      setImageBusy(false);
    }
  };

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

  // ---- logo placement map: which spots are filled, and tapping one opens the right editor or library
  const filledSlots = Object.fromEntries(logoSlots.map((s) => [s.id, !!slotLayer(s)]));
  const activeSpotId = logoSubTab === "crest" ? "crest" : logoSubTab === "brand" ? "brand" : logoSubTab === "sponsors" ? activeSponsorSlotId : null;
  const pickSpot = (id) => {
    if (id === "crest") {
      setLogoSubTab("crest");
      if (!filledSlots.crest) setClubModalOpen(true);
    } else if (id === "brand") {
      setLogoSubTab("brand");
      if (!filledSlots.brand) setLogoModal("brand");
    } else {
      setLogoSubTab("sponsors");
      setActiveSponsorSlotId(id);
      if (!filledSlots[id]) setLogoModal("sponsor");
    }
    actions.view(id === "back-sponsor" ? "back" : id.startsWith("sleeve") ? "side" : "front");
  };

  // ---- export checklist
  const checklist = [
    { id: "crest", label: "Club crest", done: filledSlots.crest, step: "logos", sub: "crest" },
    { id: "brand", label: "Kit brand", done: filledSlots.brand, step: "logos", sub: "brand", optional: true },
    { id: "sponsor", label: "Front sponsor", done: filledSlots["shirt-sponsor"] || !!sponsor?.text, step: "logos", sub: "sponsors", spot: "shirt-sponsor", optional: true },
    { id: "name", label: "Player name", done: !!project.player.name.trim(), step: "player" },
    { id: "number", label: "Player number", done: !!project.player.number.trim(), step: "player" },
  ];
  const goItem = (item) => {
    if (item.sub) setLogoSubTab(item.sub);
    if (item.spot) setActiveSponsorSlotId(item.spot);
    setTab(item.step);
  };

  const triggerUpload = (slot) => {
    setPendingLogo(slot);
    logoInput.current?.click();
  };


  const brandLayer = slotLayer(brandSlot);
  const brandPos = !brandLayer?.transform
    ? "right"
    : Math.abs(brandLayer.transform.x) < 0.03
    ? "center"
    : brandLayer.transform.x > 0
    ? "left"
    : "right";

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
        {tab === "layers"
          ? <button type="button" className="link" onClick={() => setTab("design")}>← Back to steps</button>
          : <><span title={TABS[stepIndex].hint}>Step {stepIndex + 1} of {TABS.length}</span><button type="button" className="link" onClick={() => setTab("layers")}>Advanced layers</button></>}
      </div>
      <div className="panel-content">
      {tab === "design" && showGuide && <div className="quick-start">
        <button type="button" className="quiet quick-start-close" aria-label="Dismiss getting started guide" onClick={() => {
          setShowGuide(false);
          try { localStorage.setItem("kit-maker:guide-dismissed", "1"); } catch { /* private browsing */ }
        }}>x</button>
        <strong>Make your first kit in six steps</strong>
        <p>Follow the steps below: design, colours, logos, images, player, export. Use Next at the bottom, or jump with the tabs.</p>
      </div>}
      {tab === "design" && <Section title="Design" eyebrow="01">
        <span className="group-label">Shirt template</span>
        <select value={project.template} onChange={(e) => set({ template: e.target.value })} aria-label="Shirt template">
          {shirts.map((k) => (
            <option key={k.name} value={k.name}>
              {k.label}
            </option>
          ))}
        </select>
        <DesignStep project={project} setProject={setProject} shirts={shirts} />
      </Section>}
      {tab === "colors" && <Section title="Colours" eyebrow="02">
        <ColorsStep palette={project.palette} setPalette={(palette) => set({ palette })} />
      </Section>}

      {tab === "logos" && (
        <Section title="Emblems & sponsors" eyebrow="03" className="logo-section">
          <PlacementMap filled={filledSlots} active={activeSpotId} palette={project.palette} onPick={pickSpot} />
          {/* Sub-navigation without emojis */}
          <div className="logo-subnav" role="tablist" aria-label="Emblem categories">
            <button
              type="button"
              role="tab"
              aria-selected={logoSubTab === "brand"}
              className={logoSubTab === "brand" ? "on" : ""}
              onClick={() => setLogoSubTab("brand")}
            >
              <span>Brand</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={logoSubTab === "sponsors"}
              className={logoSubTab === "sponsors" ? "on" : ""}
              onClick={() => setLogoSubTab("sponsors")}
            >
              <span>Sponsors</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={logoSubTab === "crest"}
              className={logoSubTab === "crest" ? "on" : ""}
              onClick={() => setLogoSubTab("crest")}
            >
              <span>Crest</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={logoSubTab === "all"}
              className={logoSubTab === "all" ? "on" : ""}
              onClick={() => setLogoSubTab("all")}
            >
              <span>All</span>
            </button>
          </div>

          {/* 1. KIT MAKER BRAND (PUMA, NIKE, ADIDAS...) */}
          {logoSubTab === "brand" && (
            <div className="category-pane">
              <div className="pane-intro">
                <strong>Kit maker brand</strong>
                <p>Technical apparel supplier (Puma, Nike, Adidas, Umbro, Kappa...). Placed on the chest.</p>
              </div>

              {/* Active Brand Slot Card */}
              <SlotCard
                slot={brandSlot}
                layer={brandLayer}
                project={project}
                onUpload={() => triggerUpload(brandSlot)}
                onRemove={() => removeLogo(brandSlot)}
              />

              {brandLayer && (
                <div className="slot-customizer">
                  <div className="customizer-row">
                    <span className="group-label">Chest position</span>
                    <div className="seg">
                      <button
                        type="button"
                        className={brandPos === "right" ? "on" : ""}
                        onClick={() => setBrandPosition("right")}
                      >
                        Right chest
                      </button>
                      <button
                        type="button"
                        className={brandPos === "center" ? "on" : ""}
                        onClick={() => setBrandPosition("center")}
                      >
                        Center
                      </button>
                      <button
                        type="button"
                        className={brandPos === "left" ? "on" : ""}
                        onClick={() => setBrandPosition("left")}
                      >
                        Left chest
                      </button>
                    </div>
                  </div>

                  {/* Size slider */}
                  <SliderField
                    label="Brand size"
                    value={Math.round((brandLayer.size || DEFAULT_SLOT_SIZES.brand) * 100)}
                    unit="cm"
                    min={2}
                    max={12}
                    step={0.2}
                    onChange={(cm) => setSlotSize(brandSlot, cm / 100)}
                  />

                  <TintPicker
                    value={brandLayer.tint}
                    palette={project.palette}
                    onChange={(tint) => setSlotTint(brandSlot, tint)}
                  />

                  <StrokeField stroke={brandLayer.stroke} palette={project.palette} onChange={(s) => setSlotStroke(brandSlot, s)} />

                  <FinishSelector
                    finish={brandLayer.finish}
                    texture={brandLayer.texture}
                    onChange={(fin) => setSlotFinish(brandSlot, fin)}
                  />
                </div>
              )}

              <LibraryBanner
                title="Kit brand library"
                desc={brandLayer ? "Swap the supplier or search more brands" : "Puma, Nike, Adidas, Umbro, Kappa and online search"}
                action={brandLayer ? "Change brand" : "Browse brands"}
                onOpen={() => setLogoModal("brand")}
              />
            </div>
          )}

          {/* 2. SHIRT SPONSORS */}
          {logoSubTab === "sponsors" && (
            <div className="category-pane">
              <div className="pane-intro">
                <strong>Shirt sponsors</strong>
                <p>Commercial club sponsors: main chest, lower back, and sleeve patches.</p>
              </div>

              {/* Target sponsor spot selector */}
              <span className="group-label">Select spot to edit</span>
              <div className="sponsor-slot-selector">
                {sponsorSlots.map((s) => {
                  const l = slotLayer(s);
                  const isAct = s.id === activeSponsorSlotId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`sponsor-pill${isAct ? " active" : ""}${l ? " populated" : ""}`}
                      onClick={() => setActiveSponsorSlotId(s.id)}
                    >
                      <span>{s.label}</span>
                      {l && <span className="dot" title="Active logo" />}
                    </button>
                  );
                })}
              </div>

              {/* Active Selected Sponsor Slot Card */}
              <SlotCard
                slot={activeSponsorSlot}
                layer={slotLayer(activeSponsorSlot)}
                project={project}
                onUpload={() => triggerUpload(activeSponsorSlot)}
                onRemove={() => removeLogo(activeSponsorSlot)}
              />

              {slotLayer(activeSponsorSlot) && (
                <div className="slot-customizer">
                  {/* Size slider */}
                  <SliderField
                    label="Sponsor size"
                    value={Math.round((slotLayer(activeSponsorSlot).size || DEFAULT_SLOT_SIZES[activeSponsorSlot.id] || 0.18) * 100)}
                    unit="cm"
                    min={4}
                    max={activeSponsorSlot.id.includes("sponsor") ? 36 : 14}
                    step={0.5}
                    onChange={(cm) => setSlotSize(activeSponsorSlot, cm / 100)}
                  />

                  <TintPicker
                    value={slotLayer(activeSponsorSlot).tint}
                    palette={project.palette}
                    onChange={(tint) => setSlotTint(activeSponsorSlot, tint)}
                  />

                  <StrokeField stroke={slotLayer(activeSponsorSlot).stroke} palette={project.palette} onChange={(s) => setSlotStroke(activeSponsorSlot, s)} />

                  <FinishSelector
                    finish={slotLayer(activeSponsorSlot).finish}
                    texture={slotLayer(activeSponsorSlot).texture}
                    onChange={(fin) => setSlotFinish(activeSponsorSlot, fin)}
                  />
                </div>
              )}

              <LibraryBanner
                title="Sponsor library"
                desc={`Find a logo for: ${activeSponsorSlot.label}`}
                action={slotLayer(activeSponsorSlot) ? "Change logo" : "Find sponsor"}
                onOpen={() => setLogoModal("sponsor")}
              />

              {/* Sponsor as Text */}
              <div className="text-sponsor-block">
                <span className="group-label">Chest sponsor as text</span>
                <div className="row">
                  <input
                    value={sponsor?.text ?? ""}
                    maxLength={20}
                    disabled={sponsor?.locked}
                    placeholder="Type brand text (e.g. SONY, JEEP)"
                    onChange={(e) => setSponsor(e.target.value)}
                  />
                  {sponsor?.text && (
                    <button type="button" className="quiet" onClick={clearSponsorText} title="Clear text sponsor">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 3. CLUB CREST */}
          {logoSubTab === "crest" && (
            <div className="category-pane">
              <div className="pane-intro">
                <strong>Team crest / badge</strong>
                <p>Official football club badge placed on the left breast or chest center.</p>
              </div>

              {/* Active Crest Slot Card */}
              <SlotCard
                slot={crestSlot}
                layer={crestLayer}
                project={project}
                onUpload={() => triggerUpload(crestSlot)}
                onRemove={() => removeLogo(crestSlot)}
              />

              {crestLayer && (
                <div className="slot-customizer">
                  <div className="customizer-row">
                    <span className="group-label">Badge style</span>
                    <div className="seg">
                      <button
                        type="button"
                        className={crestStyle === "color" ? "on" : ""}
                        onClick={() => setCrestStyleMode("color")}
                      >
                        Full color
                      </button>
                      <button
                        type="button"
                        className={crestStyle === "mono" ? "on" : ""}
                        onClick={() => setCrestStyleMode("mono")}
                      >
                        Monochrome
                      </button>
                    </div>
                  </div>

                  {crestStyle === "mono" && (
                    <TintPicker
                      value={crestLayer.tint || "@trim"}
                      palette={project.palette}
                      onChange={(tint) => setSlotTint(crestSlot, tint)}
                    />
                  )}

                  <div className="customizer-row">
                    <span className="group-label">Crest position</span>
                    <div className="seg">
                      <button
                        type="button"
                        className={crestPos === "left" ? "on" : ""}
                        onClick={() => setCrestPosition("left")}
                      >
                        Left breast
                      </button>
                      <button
                        type="button"
                        className={crestPos === "center" ? "on" : ""}
                        onClick={() => setCrestPosition("center")}
                      >
                        Center chest
                      </button>
                    </div>
                  </div>

                  {/* Size slider */}
                  <SliderField
                    label="Crest size"
                    value={Math.round((crestLayer.size || DEFAULT_SLOT_SIZES.crest) * 100)}
                    unit="cm"
                    min={4}
                    max={15}
                    step={0.5}
                    onChange={(cm) => setSlotSize(crestSlot, cm / 100)}
                  />

                  <StrokeField stroke={crestLayer.stroke} palette={project.palette} onChange={(s) => setSlotStroke(crestSlot, s)} />

                  <FinishSelector
                    finish={crestLayer.finish}
                    texture={crestLayer.texture}
                    onChange={(fin) => setSlotFinish(crestSlot, fin)}
                  />
                </div>
              )}

              {/* Club Catalog Modal Trigger Banner */}
              <div className="club-catalog-banner">
                <div className="club-catalog-banner-info">
                  <span className="banner-title">Club crest catalog</span>
                  <span className="banner-desc">
                    {crestLayer?.clubData?.name
                      ? `Active: ${crestLayer.clubData.name}`
                      : "Choose from 400+ vector badges with monochrome variants"}
                  </span>
                </div>
                <button
                  type="button"
                  className="browse-catalog-btn"
                  onClick={() => setClubModalOpen(true)}
                >
                  {crestLayer ? "Change club" : "Browse catalog"}
                </button>
              </div>

              {/* Quick Picks for top clubs */}
              <div className="quick-clubs-section">
                <div className="quick-clubs-header">
                  <span className="group-label">Quick picks</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setClubModalOpen(true)}
                  >
                    View all (400+)
                  </button>
                </div>
                <div className="quick-clubs-row">
                  {POPULAR_CLUBS.slice(0, 8).map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      className="quick-club-btn"
                      title={`${c.name} (Official vector + monochrome)`}
                      onClick={() => pickPopularClub(c)}
                    >
                      <img
                        src={crestStyle === "mono" && c.monoUrl ? c.monoUrl : c.colorUrl}
                        alt=""
                        className="quick-club-thumb"
                        loading="lazy"
                      />
                      <span>{c.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 4. ALL LOGOS (OVERVIEW) */}
          {logoSubTab === "all" && (
            <div className="category-pane">
              <div className="pane-intro">
                <strong>Kit emblems overview</strong>
                <p>All active badges, technical brands, and sponsors on this jersey.</p>
              </div>

              <span className="group-label">Club & technical brand</span>
              <div className="all-slots-grid">
                <SlotCard
                  slot={crestSlot}
                  layer={crestLayer}
                  project={project}
                  onUpload={() => triggerUpload(crestSlot)}
                  onRemove={() => removeLogo(crestSlot)}
                  onSelect={() => setLogoSubTab("crest")}
                />
                <SlotCard
                  slot={brandSlot}
                  layer={brandLayer}
                  project={project}
                  onUpload={() => triggerUpload(brandSlot)}
                  onRemove={() => removeLogo(brandSlot)}
                  onSelect={() => setLogoSubTab("brand")}
                />
              </div>

              <span className="group-label">Shirt sponsors</span>
              <div className="all-slots-grid">
                {sponsorSlots.map((s) => (
                  <SlotCard
                    key={s.id}
                    slot={s}
                    layer={slotLayer(s)}
                    project={project}
                    onUpload={() => triggerUpload(s)}
                    onRemove={() => removeLogo(s)}
                    onSelect={() => {
                      setActiveSponsorSlotId(s.id);
                      setLogoSubTab("sponsors");
                    }}
                  />
                ))}
              </div>

              {sponsor?.text && (
                <div className="text-sponsor-card">
                  <span className="label">Text sponsor:</span>
                  <strong>{sponsor.text}</strong>
                  <button type="button" className="quiet danger" onClick={clearSponsorText} title="Remove text sponsor">
                    x
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Hidden File Input for uploading images */}
          <input
            ref={logoInput}
            type="file"
            accept="image/png,image/svg+xml,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              if (e.target.files[0] && pendingLogo) uploadLogo(e.target.files[0], pendingLogo);
              e.target.value = "";
            }}
          />
        </Section>
      )}

      {tab === "images" && <Section title="Kit images" eyebrow="04">
        <p className="section-copy">Add your own artwork or a full texture. Upload a file, or paste a link: links have no size limit and keep your saved design small.</p>
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
        <span className="group-label">Add from a link</span>
        <form className="row" onSubmit={addArtworkLink}>
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://i.ibb.co/xxxx/texture.png" aria-label="Image link" spellCheck={false} />
          <button type="submit" disabled={imageBusy || !imageUrl.trim()}>{imageBusy ? "Loading..." : "Add"}</button>
        </form>
        <p className="section-copy fine">Use the direct image address (ends in .png, .jpg or .webp). On imgbb, copy the "Direct link".</p>
        <span className="group-label">Or upload a file</span>
        <button type="button" className="quiet" disabled={imageBusy} onClick={() => artworkInput.current?.click()}>Upload image (PNG, JPG, WebP, SVG)</button>
        <input ref={artworkInput} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => {
          if (e.target.files[0]) addArtworkFile(e.target.files[0]);
          e.target.value = "";
        }} />
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
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>}

      {tab === "layers" && <Section title="Advanced layers" eyebrow="Adv">
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
          addLink={addImageLink}
        />
      </Section>}

      {tab === "player" && <Section title="Player details" eyebrow="05">
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

      {tab === "export" && <Section title="Export" eyebrow="06">
        <KitChecklist items={checklist} onGo={goItem} />
        <p className="section-copy">Takes a picture of the current 3D view. You can preview it before downloading.</p>
        <div className="row">
          <button type="button" onClick={() => actions.screenshot()}>
            Screenshot of current view (PNG)
          </button>
        </div>
        <span className="group-label">Social media crop</span>
        <div className="row">
          {[["1:1", "Square"], ["16:9", "Wide"], ["9:16", "Story"]].map(([a, name]) => (
            <button key={a} type="button" className="quiet" onClick={() => actions.screenshot(a)} title={`${name} ${a} image, 2048 px long side`}>
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
          <select value={actions.textureSize} onChange={(e) => actions.setTextureSize(Number(e.target.value))}>
            {actions.textureSizes.map((s) => (
              <option key={s} value={s}>
                {s} x {s}
              </option>
            ))}
          </select>
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
        {tab === "layers" ? (
          <button type="button" className="quiet" onClick={() => setTab("design")}>Back to steps</button>
        ) : (
          <>
            <button type="button" className="quiet" disabled={stepIndex === 0} onClick={() => go(stepIndex - 1)}>Back</button>
            <span className="step-dots" aria-hidden="true">{TABS.map((t, i) => <i key={t.id} className={i === stepIndex ? "on" : i < stepIndex ? "past" : ""} />)}</span>
            {stepIndex < TABS.length - 1
              ? <button type="button" onClick={() => go(stepIndex + 1)}>Next: {TABS[stepIndex + 1].label}</button>
              : <button type="button" onClick={() => actions.screenshot()}>Screenshot</button>}
          </>
        )}
      </footer>
      </div>
      <ClubPickerModal
        isOpen={clubModalOpen}
        onClose={() => setClubModalOpen(false)}
        onSelectClub={pickPopularClub}
        currentClub={crestLayer?.clubData}
        activeCrestStyle={crestStyle}
        palette={project.palette}
      />
      <LogoPickerModal
        isOpen={logoModal === "brand"}
        onClose={() => setLogoModal(null)}
        title="Kit brand library"
        subtitle="Technical apparel suppliers placed on the chest"
        targetLabel={brandSlot.label}
        presets={KIT_BRANDS}
        presetsTitle="Popular kit brands"
        placeholder="Search brands (e.g. Kappa, Castore, Lotto)..."
        onSearch={searchKitBrands}
        onPickPreset={(b) => applyPreset(b, brandSlot)}
        onPick={(file) => uploadLogo(file, brandSlot)}
        onUpload={() => triggerUpload(brandSlot)}
        onError={onError}
      />
      <LogoPickerModal
        isOpen={logoModal === "sponsor"}
        onClose={() => setLogoModal(null)}
        title="Sponsor library"
        subtitle="Commercial sponsors for the chest, back and sleeves"
        targetLabel={activeSponsorSlot.label}
        placeholder="Search sponsors (e.g. Spotify, Pirelli, Audi)..."
        onSearch={searchSponsors}
        onPick={(file) => uploadLogo(file, activeSponsorSlot)}
        onUpload={() => triggerUpload(activeSponsorSlot)}
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

/** Card showing an individual logo slot with preview, replace, and clear buttons */
function SlotCard({ slot, layer, project, onUpload, onRemove, onSelect }) {
  const asset = layer && project.assets[layer.asset];
  return (
    <div className={`logo-slot-card${layer ? " populated" : ""}`} onClick={onSelect}>
      <div className="logo-slot-main">
        <div className="logo-preview">
          {asset ? <img src={asset.src} alt="" /> : <span aria-hidden="true">+</span>}
        </div>
        <div className="logo-slot-info">
          <span className="logo-slot-label">{slot.label}</span>
          <span className="logo-slot-file">{asset ? asset.name : "Tap to add"}</span>
        </div>
      </div>
      <div className="logo-slot-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="quiet slot-act-btn" onClick={onUpload} title="Upload image file">
          {asset ? "Replace" : "Upload"}
        </button>
        {layer && (
          <button
            type="button"
            className="quiet slot-act-btn danger"
            onClick={onRemove}
            title={`Remove ${slot.label}`}
            aria-label={`Remove ${slot.label}`}
          >
            x
          </button>
        )}
      </div>
    </div>
  );
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

/** Compact row that opens a logo library popup */
function LibraryBanner({ title, desc, action, onOpen }) {
  return (
    <div className="club-catalog-banner">
      <div className="club-catalog-banner-info">
        <span className="banner-title">{title}</span>
        <span className="banner-desc">{desc}</span>
      </div>
      <button type="button" className="browse-catalog-btn" onClick={onOpen}>{action}</button>
    </div>
  );
}
