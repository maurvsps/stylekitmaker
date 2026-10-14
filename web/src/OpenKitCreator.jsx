import { useState } from "react";
import { LIGHTING_PRESETS, TURNTABLE_LIGHTING_PRESETS, TURNTABLE_VIEWS } from "./Viewer.jsx";
import ColorsStep from "./ColorsStep.jsx";

// "Open Kit Creator": a layout modelled on fifakitcreator.com (icon rail + layer list on the left, 3D / Texture tabs on
// the right). It is the app's only layout; the layer editor inside it is the Panel in its "open" variant.

const CAMERAS = [["front", "Front"], ["three-quarter", "3/4"], ["side", "Side"], ["back", "Back"], ["close-up", "Close-up"]];

const icon = (d, props = {}) => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}><path fillRule="evenodd" clipRule="evenodd" d={d} /></svg>
);
const I = {
  gear: "M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z",
  shield: "M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944z",
  shirt: "M7 2 2 4.5 3.2 8 5.5 7.2V18h9V7.2L16.8 8 18 4.5 13 2c-.4 1.2-1.7 2-3 2S7.4 3.2 7 2z",
  image: "M4 3h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm1 11 3-3.5 2.2 2.5 2.3-3L16 14H5zM7 6.5a1.2 1.2 0 100 2.4 1.2 1.2 0 000-2.4z",
  sliders: "M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z",
  sparkle: "M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z",
  list: "M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z",
  shorts: "M3 3h14l-1 14h-4.5L10 9l-1.5 8H4L3 3z",
  socks: "M7 2h5v8.5l4 3.3c1 .9 1.3 2.2.5 3.1-.9 1-2.4.9-3.5.1L8 14V2z",
  hand: "M7 9V4.5a1.5 1.5 0 013 0V9m0-1V3.5a1.5 1.5 0 013 0V9m0-1.5a1.5 1.5 0 013 0V13a5 5 0 01-5 5H9.5a5 5 0 01-4-2L3 12.5a1.5 1.5 0 012.4-1.8L7 12.5",
};

// Rail: the sections of the left panel. `panel` ones are drawn by the studio's Panel, `settings` by this file.
const RAIL = [
  { id: "settings", label: "Settings", icon: I.gear },
  { id: "logos", label: "Logos", icon: I.shield },
  { id: "layers", label: "Shirt layers", icon: I.shirt },
  { id: "shorts", label: "Shorts (coming soon)", icon: I.shorts, disabled: true },
  { id: "socks", label: "Socks (coming soon)", icon: I.socks, disabled: true },
  { id: "player", label: "Name & number", text: "10" },
  { id: "images", label: "Images", icon: I.image },
  { id: "colors", label: "Kit colours", icon: I.sliders },
  { id: "effects", label: "Effects", icon: I.sparkle },
  { id: "export", label: "Export & save", icon: I.list },
];

const TABS = [["3d", "3D"], ["texture", "Texture"], ["upcoming", "Upcoming"], ["howto", "How to"], ["about", "About"], ["account", "Account"]];

export default function OpenKitCreator({
  section, setSection, view, setView, stage, panel, actions, project, setProject, shirts, template, setTemplate,
  lighting, setLighting, handTool, setHandTool, kitName, setKitName, notice, dismissNotice,
  rig, setRig, turntableLighting, setTurntableLighting, freeView, setFreeView,
}) {
  const [tab, setTab] = useState("3d");
  const [turnView, setTurnView] = useState("front"); // the turntable's named view, or "rotate"
  const turntable = rig === "turntable";
  const pickTurnView = (id) => {
    setTurnView(id);
    if (id === "rotate") setFreeView(false);
    actions.view(id);
  };
  const [downloadOpen, setDownloadOpen] = useState(false);

  const goTab = (id) => {
    setTab(id);
    if (id === "3d") setView("3d");
    if (id === "texture") setView("texture");
  };
  const rotating = view === "3d";

  return (
    <div className="okc">
      <aside className="okc-side" aria-label="Kit design">
        <h1 className="okc-title">
          {icon(I.shirt, { className: "okc-logo" })}
          <span>{kitName || "Open Kit Creator"}</span>
        </h1>

        <button type="button" className="okc-banner" onClick={() => actions.screenshot()}>
          <span>
            <strong>Quick Render</strong>
            <small>Create a 4K image of your kit in one click.</small>
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 13v4a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h5" /><path d="m17.9 3 .9 2.7L21 6.5l-2.2.8-.9 2.7-.9-2.7-2.2-.8 2.2-.8z" />
          </svg>
        </button>

        <div className="okc-body">
          <nav className="okc-rail" aria-label="Sections">
            {RAIL.map((r) => (
              <button key={r.id} type="button" className={section === r.id ? "active" : ""} disabled={r.disabled} title={r.label} aria-label={r.label}
                aria-current={section === r.id ? "page" : undefined}
                onClick={() => { setSection(r.id); if (view !== "3d" && tab === "3d") setView("3d"); }}>
                {r.icon ? icon(r.icon) : <b>{r.text}</b>}
              </button>
            ))}
          </nav>
          <div className="okc-content">
            {section === "settings" ? (
              <SettingsPane {...{ kitName, setKitName, project, setProject, shirts, template, setTemplate, lighting, setLighting, actions, rig, setRig, turntableLighting, setTurntableLighting }} />
            ) : panel}
          </div>
        </div>

        <div className="okc-login">
          <span className={actions.saveStatus === "unavailable" ? "warn" : ""}>
            {actions.saveStatus === "saved" ? "Saved on this device" : actions.saveStatus === "unavailable" ? "Storage unavailable" : "Saving…"}
          </span>
          <button type="button" onClick={actions.save} title="Download the design as a JSON file">Save</button>
        </div>
      </aside>

      <section className="okc-main">
        <div className="okc-tabbar">
          <div className="okc-quick">
            <button type="button" onClick={actions.reset} title="New kit" aria-label="New kit">{icon("M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z")}</button>
            <button type="button" className="okc-wheel" onClick={() => setSection("colors")} title="Recolour the kit" aria-label="Recolour the kit" />
            <button type="button" onClick={actions.undo} disabled={!actions.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
            <button type="button" onClick={actions.redo} disabled={!actions.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
          </div>
          <div className="okc-tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => goTab(id)}>{label}</button>
            ))}
          </div>
        </div>

        {notice && (
          <div className="okc-notice">
            <span className="okc-notice-dot" aria-hidden="true" />
            <span>{notice}</span>
            <button type="button" className="okc-notice-x" onClick={dismissNotice} aria-label="Dismiss">✕</button>
          </div>
        )}

        <div className="okc-tabcontent">
          {(tab === "3d" || tab === "texture") && (
            <>
              <div className="okc-garments" role="group" aria-label="Garment">
                <button type="button" className="active" title="Shirt" aria-label="Shirt">{icon(I.shirt)}</button>
                <button type="button" disabled title="Shorts (coming soon)" aria-label="Shorts">{icon(I.shorts)}</button>
                <button type="button" disabled title="Socks (coming soon)" aria-label="Socks">{icon(I.socks)}</button>
              </div>
              <div className="okc-viewtools" role="group" aria-label="View tools">
                <button type="button" className={turntable ? "okc-rig on" : "okc-rig"} aria-pressed={turntable}
                  onClick={() => { goTab("3d"); setTurnView("front"); setRig(turntable ? "classic" : "turntable"); }}
                  title={turntable ? "Turntable 3D: the kit turns in front of a fixed camera. Click for the classic orbit view" : "Classic orbit 3D. Click for the turntable view (the kit turns in front of a fixed camera)"}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="17" rx="9" ry="3" /><path d="M8 13V6l4-2 4 2v7M19 9.5c1.3.6 2 1.4 2 2.3" /></svg>
                  <span>{turntable ? "Turntable" : "Orbit"}</span>
                </button>
                {turntable && (
                  <button type="button" className={freeView ? "on" : ""} aria-pressed={freeView}
                    onClick={() => { goTab("3d"); if (turnView === "rotate") setTurnView("front"); setFreeView(!freeView); }}
                    title={freeView ? "Free view on: drag to orbit the camera, the lights follow it" : "Free view: orbit the camera instead of turning the kit"} aria-label="Free view">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5c-5 0-9 3.1-9 7s4 7 9 7 9-3.1 9-7" /><path d="m17 4 4 1-1 4" /><circle cx="12" cy="12" r="2.5" /></svg>
                  </button>
                )}
                <button type="button" onClick={() => { goTab("3d"); if (turntable) pickTurnView("front"); else actions.view("front"); }} title="Reset the 3D view" aria-label="Reset the 3D view">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12 3 7" /></svg>
                </button>
                <button type="button" className={view === "flat" ? "on" : ""} onClick={() => { setTab("3d"); setView(view === "flat" ? "3d" : "flat"); }} title="Front and back laid flat" aria-label="Flat view">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
                </button>
                <button type="button" className={handTool ? "on" : ""} onClick={() => setHandTool((v) => !v)} title="Pan (or hold Space)" aria-label="Pan" aria-pressed={handTool}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 013 0V12m0-1.5V4a1.5 1.5 0 013 0v7m0-5a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-1.5a6 6 0 01-4.8-2.4L3.5 14a1.5 1.5 0 012.3-1.9L8 14" /></svg>
                </button>
                <button type="button" onClick={() => actions.screenshot()} title="4K screenshot" aria-label="4K screenshot">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" /></svg>
                </button>
              </div>
              <div className="okc-stage">
                {stage}
                {rotating && !turntable && (
                  <div className="okc-angles" role="group" aria-label="Camera">
                    {CAMERAS.map(([v, label]) => <button key={v} type="button" onClick={() => actions.view(v)}>{label}</button>)}
                  </div>
                )}
                {rotating && turntable && (
                  <div className="okc-angles okc-turn" role="group" aria-label="Change view">
                    <select value={turnView} aria-label="Change view" onChange={(e) => pickTurnView(e.target.value)}>
                      {TURNTABLE_VIEWS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      {!freeView && <option value="rotate">Rotating</option>}
                    </select>
                    {!freeView && (
                      <button type="button" className={turnView === "rotate" ? "on" : ""} aria-pressed={turnView === "rotate"}
                        onClick={() => pickTurnView(turnView === "rotate" ? "front" : "rotate")}>
                        {turnView === "rotate" ? "Stop" : "Rotate"}
                      </button>
                    )}
                    <span className="okc-turn-hint">{freeView ? "Drag to orbit, scroll to zoom" : "Drag to turn the kit, scroll to zoom"}</span>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === "upcoming" && <InfoPage title="Upcoming" items={UPCOMING} />}
          {tab === "howto" && <InfoPage title="How to" items={HOWTO} />}
          {tab === "about" && <InfoPage title="About" items={ABOUT} />}
          {tab === "account" && <InfoPage title="Account" items={ACCOUNT} />}
        </div>

        <div className="okc-bottom">
          <button type="button" onClick={() => goTab("howto")}>FAQ</button>
          <button type="button" onClick={() => goTab("upcoming")}>Showcase</button>
          <div className="okc-dl">
            <button type="button" className="okc-download" onClick={() => setDownloadOpen((v) => !v)} aria-expanded={downloadOpen}>↓ Download</button>
            {downloadOpen && (
              <div className="okc-menu" role="menu" onClick={() => setDownloadOpen(false)}>
                <button type="button" role="menuitem" onClick={() => actions.screenshot()}>4K screenshot (PNG)</button>
                <button type="button" role="menuitem" onClick={() => actions.screenshot("1:1")}>Square 1:1</button>
                <button type="button" role="menuitem" onClick={() => actions.screenshot("16:9")}>Wide 16:9</button>
                <button type="button" role="menuitem" onClick={() => actions.screenshot("9:16")}>Story 9:16</button>
                <button type="button" role="menuitem" onClick={() => actions.texture("shirt")}>Shirt texture</button>
                {actions.hasMaps.includes("shirt") && <button type="button" role="menuitem" onClick={() => actions.texture("shirt", "normal")}>Shirt normal map</button>}
                {actions.hasMaps.includes("shirt") && <button type="button" role="menuitem" onClick={() => actions.texture("shirt", "orm")}>Shirt rough / metal map</button>}
                <button type="button" role="menuitem" onClick={actions.save}>Design file (JSON)</button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsPane({ kitName, setKitName, project, setProject, shirts, template, setTemplate, lighting, setLighting, actions, rig, setRig, turntableLighting, setTurntableLighting }) {
  const turntable = rig === "turntable";
  return (
    <div className="okc-settings">
      <h2>Settings</h2>
      <input className="okc-kit-name" type="text" placeholder="Name" value={kitName} maxLength={40} onChange={(e) => setKitName(e.target.value)} aria-label="Kit name" />
      <label className="okc-field">
        <span>3D Model</span>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}>
          {shirts.map((k) => <option key={k.name} value={k.name}>{k.label || k.name}</option>)}
        </select>
      </label>
      <label className="okc-field">
        <span>3D viewer</span>
        <select value={turntable ? "turntable" : "classic"} onChange={(e) => setRig(e.target.value)}>
          <option value="classic">Classic orbit (the camera moves)</option>
          <option value="turntable">Turntable (the kit turns)</option>
        </select>
      </label>
      <label className="okc-field">
        <span>Lighting</span>
        {turntable ? (
          <select value={turntableLighting} onChange={(e) => setTurntableLighting(e.target.value)}>
            {TURNTABLE_LIGHTING_PRESETS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        ) : (
          <select value={lighting} onChange={(e) => setLighting(e.target.value)}>
            {LIGHTING_PRESETS.map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
          </select>
        )}
      </label>
      <hr />
      <label className="okc-field">
        <span>Texture scale</span>
        <select value={actions.textureSize} onChange={(e) => actions.setTextureSize(Number(e.target.value))}>
          {actions.textureSizes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="okc-check">
        <input type="checkbox" checked={actions.transparent} onChange={(e) => actions.setTransparent(e.target.checked)} />
        Transparent background in screenshots
      </label>
      <hr />
      <h3>Kit colours</h3>
      <ColorsStep palette={project.palette} setPalette={(palette) => setProject((p) => ({ ...p, palette }))} />
    </div>
  );
}

function InfoPage({ title, items }) {
  return (
    <div className="okc-info">
      <h2>{title}</h2>
      {items.map(([h, body]) => (
        <section key={h}><h3>{h}</h3><p>{body}</p></section>
      ))}
    </div>
  );
}

const UPCOMING = [
  ["Shorts and socks", "The shorts and socks models are on the way. Their icons are already in the garment bar."],
  ["Competitions", "Community kit contests with voting."],
  ["Bulk export", "Render several designs at once."],
];
const HOWTO = [
  ["1. Start from a base", "Open the shirt section (shirt icon) and add a Base design, a Pattern or trims. The list is ordered top to bottom: the top layer prints on top."],
  ["2. Add logos", "Use the shield icon for the crest, kit brand, sponsors and sleeve patches, or Images (picture icon) to upload your own artwork."],
  ["3. Name and number", "The 10 icon sets the player name, number and font that print on the back."],
  ["4. Colours and effects", "Kit colours are shared by every layer, so recolouring the kit is one click. Effects adds fabric finishes such as satin or mesh."],
  ["5. Export", "Download opens the menu for a 4K picture of the 3D view, the texture, material maps or a JSON copy of the design. Everything is saved on this device automatically."],
  ["Shortcuts", "Ctrl+Z / Ctrl+Shift+Z undo and redo. Hold Space and drag to pan the 3D view. Ctrl+C, V, D and Delete act on the selected layer."],
];
const ABOUT = [
  ["Open Kit Creator", "An open layout for the kit editor, inspired by the layered workflow of online kit creators. It runs fully in your browser and shares its engine with the Studio layout."],
];
const ACCOUNT = [
  ["No account needed", "Designs are saved in this browser. Use Download → Design file (JSON) to keep a copy, or My kits (Export section) to save several designs and share links."],
];
