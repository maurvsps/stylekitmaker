import { useEffect, useRef, useState } from "react";
import { BASE_DESIGNS, GRAPHICS, MATERIALS, PATTERNS, baseDesign, fillIsland, paintPattern, pattern as patternDef, patternSlots } from "./library.js";
import { findOpenImagePosition } from "./imagePlacement.js";
import {
  BLEND_MODES, LAYER_TYPES, PALETTE_LABELS, REGIONS, SURFACES, adaptLayer, cloneLayer, defaultPatternColors, editLayers, findLayer, locate, makeLayer,
  mapLayer, moveLayer, removeLayer, insertLayer, resolveColor, SHOWN_GARMENTS,
} from "./project.js";

const GARMENT_LABELS = { shirt: "Shirt", shorts: "Shorts", socks: "Socks" };
const ADDABLE = ["text", "image", "graphic", "pattern", "base", "trim", "material", "group"];
const ICONS = { base: "▣", pattern: "▥", graphic: "◆", image: "▨", text: "T", material: "✦", group: "▤" };

/** The layer stack of one garment: tabs, the list (top layer first), the toolbar and the selected layer's fields. */
/** Keyboard shortcuts leave text fields alone. */
export const isTyping = (el) =>
  !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && el.type !== "range" && el.type !== "checkbox";

let clipboard = null; // the copied layer (kept while the page is open)

export default function LayersPanel({ project, setProject, garment, setGarment, selected, select, template, fonts, uploadImage }) {
  const layers = project.garments[garment].layers;
  const layer = selected ? findLayer(layers, selected) : null;
  const imageInput = useRef(null);
  const [renaming, setRenaming] = useState(null);
  const [clip, setClip] = useState(clipboard?.name ?? null);

  const edit = (fn) => setProject((p) => editLayers(p, garment, fn));
  const patch = (id, fields) => edit((ls) => mapLayer(ls, id, (l) => ({ ...l, ...fields })));

  /** Put a new layer above the selection (inside it when it is a group), or on top. */
  const add = (newLayer) => {
    edit((ls) => {
      const at = selected && locate(ls, selected);
      if (!at) return [...ls, newLayer];
      const sel = at.list[at.index];
      if (sel.type === "group") return insertLayer(ls, newLayer, sel.id, sel.children.length);
      return insertLayer(ls, newLayer, at.parentId, at.index + 1);
    });
    select(newLayer.id);
  };

  const onAdd = (type) => {
    if (type === "image") return imageInput.current.click();
    if (type === "trim") return add(makeLayer("base", garment, { design: "trim" }));
    add(makeLayer(type, garment));
  };

  const onImageFile = async (file) => {
    const asset = await uploadImage(file);
    if (asset) {
      const position = findOpenImagePosition(layers, garment, template);
      add(makeLayer("image", garment, {
        asset: asset.id,
        name: asset.name.replace(/\.\w+$/, "").slice(0, 40) || "Image",
        surface: position.surface,
        transform: { x: position.x, y: position.y, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
      }));
    }
  };

  const act = {
    duplicate: () => {
      const copy = { ...cloneLayer(layer), name: `${layer.name} copy`.slice(0, 40) };
      edit((ls) => {
        const at = locate(ls, layer.id);
        return at ? insertLayer(ls, copy, at.parentId, at.index + 1) : ls;
      });
      select(copy.id);
    },
    remove: () => {
      edit((ls) => removeLayer(ls, selected));
      select(null);
    },
    // Up = towards the top of the stack (later in its list).
    up: () => edit((ls) => {
      const at = locate(ls, selected);
      return at && at.index < at.list.length - 1 ? moveLayer(ls, selected, at.parentId, at.index + 2) : ls;
    }),
    down: () => edit((ls) => {
      const at = locate(ls, selected);
      return at && at.index > 0 ? moveLayer(ls, selected, at.parentId, at.index - 1) : ls;
    }),
  };

  act.copy = () => {
    clipboard = structuredClone(layer);
    setClip(clipboard.name);
  };
  act.paste = () => {
    if (!clipboard) return;
    const pasted = adaptLayer(clipboard, garment, project.assets);
    if (pasted) add(pasted);
  };

  // Ctrl/Cmd+C, V, D and Delete act on the selected layer (outside text fields).
  const keys = useRef(act);
  keys.current = { ...act, layer };
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e.target)) return;
      const { layer: l, ...a } = keys.current;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "v") a.paste();
      else if (!l) return;
      else if (mod && k === "c") a.copy();
      else if (mod && k === "d") a.duplicate();
      else if ((k === "delete" || k === "backspace") && !l.locked) a.remove();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const at = layer && locate(layers, layer.id);
  return (
    <div className="layers">
      <div className="tabs" role="tablist" aria-label="Garment">
        {Object.entries(GARMENT_LABELS).filter(([g]) => SHOWN_GARMENTS.includes(g)).map(([g, label]) => (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={g === garment}
            className={g === garment ? "active" : ""}
            onClick={() => setGarment(g)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="layer-tools">
        {clip && (
          <button type="button" className="quiet" onClick={act.paste} title={`Paste "${clip}" (Ctrl+V)`}>
            Paste
          </button>
        )}
        <select value="" onChange={(e) => e.target.value && onAdd(e.target.value)} aria-label="Add layer" aria-describedby="layer-help">
          <option value="">+ Add layer</option>
          {ADDABLE.map((t) => (
            <option key={t} value={t}>
              {t === "trim" ? baseDesign(garment, "trim").label : t === "image" ? "Image / logo…" : LAYER_TYPES[t]}
            </option>
          ))}
        </select>
        <input ref={imageInput} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => {
          if (e.target.files[0]) onImageFile(e.target.files[0]);
          e.target.value = "";
        }} />
      </div>

      <p className="layer-help" id="layer-help">Top layers cover lower ones. Select a row to edit it; drag ⠿ to reorder. Images are placed in a free spot.</p>

      <LayerList
        layers={layers}
        selected={selected}
        select={select}
        renaming={renaming}
        setRenaming={setRenaming}
        patch={patch}
        move={(id, parentId, index) => edit((ls) => moveLayer(ls, id, parentId, index))}
      />

      {layer && (
        <div className="row layer-actions">
          <button type="button" className="quiet" title="Move up" aria-label="Move up" disabled={layer.locked || at.index >= at.list.length - 1} onClick={act.up}>↑</button>
          <button type="button" className="quiet" title="Move down" aria-label="Move down" disabled={layer.locked || at.index === 0} onClick={act.down}>↓</button>
          <button type="button" className="quiet" disabled={layer.locked} onClick={() => setRenaming(layer.id)}>Rename</button>
          <button type="button" className="quiet" onClick={act.duplicate} title="Ctrl+D">Duplicate</button>
          <button type="button" className="quiet" onClick={act.copy} title="Ctrl+C">Copy</button>
          <button type="button" className="quiet danger" disabled={layer.locked} onClick={act.remove}>Delete</button>
        </div>
      )}

      {layer && (
        <Inspector
          key={layer.id}
          layer={layer}
          garment={garment}
          project={project}
          template={template}
          fonts={fonts}
          patch={(fields) => patch(layer.id, fields)}
          uploadImage={uploadImage}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- list with drag and drop

/** Rows top layer first; groups are followed by their children, indented. */
function flatten(layers, depth = 0, parentId = null, out = []) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    out.push({ layer, depth, parentId, index: i });
    if (layer.type === "group") flatten(layer.children, depth + 1, layer.id, out);
  }
  return out;
}

function LayerList({ layers, selected, select, renaming, setRenaming, patch, move }) {
  const rows = flatten(layers);
  const list = useRef(null);
  const drag = useRef(null); // { id, row }
  const [drop, setDrop] = useState(null); // { id, where: "above" | "below" | "inside" }

  // Pointer events (not HTML drag and drop) so dragging works with a finger too.
  const onPointerDown = (e, row) => {
    if (row.layer.locked) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = row;
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    let target = null;
    for (const el of list.current.querySelectorAll("[data-row]")) {
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom) {
        const row = rows[Number(el.dataset.row)];
        const f = (e.clientY - r.top) / r.height;
        const where = row.layer.type === "group" && f > 0.3 && f < 0.7 ? "inside" : f < 0.5 ? "above" : "below";
        target = { row, where };
        break;
      }
    }
    const id = drag.current.layer.id;
    const inside = (r) => r && (r.layer.id === id || findLayer(drag.current.layer.children || [], r.layer.id));
    setDrop(target && !inside(target.row) ? { id: target.row.layer.id, where: target.where, row: target.row } : null);
  };
  const onPointerUp = () => {
    const from = drag.current;
    drag.current = null;
    if (from && drop) {
      const { row, where } = drop;
      if (where === "inside") move(from.layer.id, row.layer.id, row.layer.children.length);
      else move(from.layer.id, row.parentId, where === "above" ? row.index + 1 : row.index);
    }
    setDrop(null);
  };

  if (!rows.length) return <p className="hint">No layers yet. Add one above.</p>;
  return (
    <ul className="layer-list" ref={list} role="listbox" aria-label="Layers">
      {rows.map((row, i) => {
        const { layer, depth } = row;
        const cls = ["layer-row"];
        if (layer.id === selected) cls.push("selected");
        if (!layer.visible) cls.push("hidden");
        if (drop?.id === layer.id) cls.push(`drop-${drop.where}`);
        if (drag.current?.layer.id === layer.id) cls.push("dragging");
        return (
          <li
            key={layer.id}
            data-row={i}
            className={cls.join(" ")}
            role="option"
            aria-selected={layer.id === selected}
            style={{ paddingLeft: 4 + depth * 16 }}
            onClick={() => select(layer.id)}
            onDoubleClick={() => !layer.locked && setRenaming(layer.id)}
          >
            <span
              className={`handle${layer.locked ? " off" : ""}`}
              aria-hidden="true"
              onPointerDown={(e) => onPointerDown(e, row)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                drag.current = null;
                setDrop(null);
              }}
            >
              ⠿
            </span>
            <button
              type="button"
              className="icon"
              aria-label={layer.visible ? "Hide layer" : "Show layer"}
              title={layer.visible ? "Hide" : "Show"}
              onClick={(e) => {
                e.stopPropagation();
                patch(layer.id, { visible: !layer.visible });
              }}
            >
              {layer.visible ? <EyeIcon /> : <EyeIcon off />}
            </button>
            <button
              type="button"
              className={`icon${layer.locked ? " on" : ""}`}
              aria-label={layer.locked ? "Unlock layer" : "Lock layer"}
              title={layer.locked ? "Unlock" : "Lock"}
              onClick={(e) => {
                e.stopPropagation();
                patch(layer.id, { locked: !layer.locked });
              }}
            >
              <LockIcon open={!layer.locked} />
            </button>
            <span className="type" title={LAYER_TYPES[layer.type]}>
              {ICONS[layer.type]}
            </span>
            {renaming === layer.id ? (
              <RenameField
                value={layer.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name != null && name.trim()) patch(layer.id, { name: name.trim().slice(0, 40) });
                }}
              />
            ) : (
              <>
                <span className="name">{layer.name}</span>
                {layer.role && <span className="layer-role" title="This layer is linked to a quick control above">Quick control</span>}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RenameField({ value, onDone }) {
  const input = useRef(null);
  useEffect(() => input.current?.select(), []);
  return (
    <input
      ref={input}
      className="rename"
      defaultValue={value}
      maxLength={40}
      aria-label="Layer name"
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

const EyeIcon = ({ off }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" fill="none" stroke="currentColor" strokeWidth="1.6" />
    {off ? <path d="M3 17 17 3" stroke="currentColor" strokeWidth="1.6" /> : <circle cx="10" cy="10" r="2.6" fill="currentColor" />}
  </svg>
);

const LockIcon = ({ open }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="4" y="9" width="12" height="8" rx="1.5" fill={open ? "none" : "currentColor"} stroke="currentColor" strokeWidth="1.6" />
    <path d={open ? "M7 9V6.5a3 3 0 0 1 5.8-1" : "M7 9V6.5a3 3 0 0 1 6 0V9"} fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

// ---------------------------------------------------------------- inspector

function Inspector({ layer, garment, project, template, fonts, patch, uploadImage }) {
  const { palette } = project;
  const [librarySearch, setLibrarySearch] = useState("");
  const locked = layer.locked;
  const placed = "surface" in layer;
  const island = placed && template?.islands[layer.surface];
  const setT = (fields) => patch({ transform: { ...layer.transform, ...fields } });

  return (
    <fieldset className="inspector" disabled={locked}>
      <legend>
        {LAYER_TYPES[layer.type]}
        {locked && <span className="badge">Locked</span>}
      </legend>

      {layer.type === "base" && (() => {
        const design = baseDesign(garment, layer.design);
        const choices = BASE_DESIGNS[garment].filter((b) => !!b.trim === !!design.trim && b.label.toLowerCase().includes(librarySearch.toLowerCase()));
        return (
          <>
            <label className="field library-search">
              <span>Find a base design</span>
              <input value={librarySearch} placeholder="Search designs…" onChange={(e) => setLibrarySearch(e.target.value)} />
            </label>
            <div className="design-gallery" role="radiogroup" aria-label="Base design">
              {choices.map((next) => (
                <button key={next.id} type="button" role="radio" aria-checked={design.id === next.id}
                  className={`design-card${design.id === next.id ? " active" : ""}`} onClick={() => {
                patch({ design: next.id, colors: Object.fromEntries(next.slots.map(([k, , c]) => [k, layer.colors[k] ?? c])) });
              }}><DesignThumb id={next.id} /><span>{next.label}</span></button>
              ))}
              {!choices.length && <p className="hint">No matching designs.</p>}
            </div>
            <div className="slot-colors">
              {design.slots.map(([k, label, def]) => (
                <ColorField key={k} label={label} value={layer.colors[k] ?? def} palette={palette}
                  onChange={(c) => patch({ colors: { ...layer.colors, [k]: c } })} />
              ))}
            </div>
          </>
        );
      })()}

      {layer.type === "pattern" && (() => {
        const p = patternDef(layer.pattern);
        const choices = PATTERNS.filter((def) => def.label.toLowerCase().includes(librarySearch.toLowerCase()));
        return (
          <>
            <label className="field library-search"><span>Find a pattern</span><input value={librarySearch} placeholder="Search patterns…" onChange={(e) => setLibrarySearch(e.target.value)} /></label>
            <div className="patterns" role="radiogroup" aria-label="Pattern">
              {choices.map((def) => {
                const colors = defaultPatternColors(def, layer.colors, p);
                return (
                  <button key={def.id} type="button" role="radio" aria-checked={p.id === def.id}
                    className={p.id === def.id ? "active" : ""}
                    onClick={() => patch({ pattern: def.id, name: layer.name === p.label ? def.label : layer.name, colors })}>
                    <PatternSwatch def={def} colors={colors.map((c) => c && resolveColor(c, palette))} ground={palette[0]} />
                    {def.label}
                  </button>
                );
              })}
              {!choices.length && <p className="hint">No matching patterns.</p>}
            </div>
            <div className="slot-colors">
              {patternSlots(p).map((label, i) => (
                <ColorField key={i} label={label} value={layer.colors[i]} palette={palette} allowNone={i === p.slots.length}
                  onChange={(c) => patch({ colors: layer.colors.map((v, k) => (k === i ? c : v)) })} />
              ))}
            </div>
          </>
        );
      })()}

      {layer.type === "text" && (
        <>
          <label className="field">
            <span>Content</span>
            <select value={layer.bind || ""} onChange={(e) => patch({ bind: e.target.value || null })}>
              <option value="">Custom text</option>
              <option value="name">Player name</option>
              <option value="number">Player number</option>
            </select>
          </label>
          {layer.bind ? (
            <p className="hint">Shows the player {layer.bind} from the Player section.</p>
          ) : (
            <label className="field">
              <span>Text</span>
              <input value={layer.text} maxLength={40} onChange={(e) => patch({ text: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span>Font</span>
            <select value={layer.font || ""} onChange={(e) => patch({ font: e.target.value || null })}>
              <option value="">Kit font ({project.font})</option>
              {fonts.map((f) => <option key={f.id} value={f.id}>{f.id}</option>)}
            </select>
          </label>
          <ColorField label="Colour" value={layer.color} palette={palette} onChange={(color) => patch({ color })} />
          <label className="check">
            <input type="checkbox" checked={layer.outline} onChange={(e) => patch({ outline: e.target.checked })} />
            Soft outline
          </label>
        </>
      )}

      {layer.type === "image" && (
        <>
          <AssetPicker project={project} value={layer.asset} onChange={(asset) => patch({ asset })} uploadImage={uploadImage} />
          <ColorField label="One colour" value={layer.tint ?? null} palette={palette} allowNone noneLabel="Original colours"
            onChange={(tint) => patch({ tint })} />
        </>
      )}

      {layer.type === "graphic" && (
        <>
          <label className="field library-search"><span>Find a graphic</span><input value={librarySearch} placeholder="Search graphics…" onChange={(e) => setLibrarySearch(e.target.value)} /></label>
          <div className="graphic-gallery" role="radiogroup" aria-label="Graphic">
            {GRAPHICS.filter((g) => g.label.toLowerCase().includes(librarySearch.toLowerCase())).map((g) => <button key={g.id} type="button" role="radio" aria-checked={layer.shape === g.id}
              className={`graphic-card${layer.shape === g.id ? " active" : ""}`} onClick={() => patch({ shape: g.id })}><GraphicThumb id={g.id} /><span>{g.label}</span></button>)}
          </div>
          <ColorField label="Colour" value={layer.color} palette={palette} onChange={(color) => patch({ color })} />
        </>
      )}

      {placed && (
        <>
          <label className="field">
            <span>Placed on</span>
            <select value={layer.surface} onChange={(e) => {
              const isl = template?.islands[e.target.value];
              const centre = isl ? islandBounds(isl) : null;
              patch({
                surface: e.target.value,
                transform: centre ? { ...layer.transform, x: (centre.x0 + centre.x1) / 2, y: (centre.y0 + centre.y1) / 2 } : layer.transform,
              });
            }}>
              {SURFACES[garment].map(([s, label]) => <option key={s} value={s}>{label}</option>)}
            </select>
          </label>
          {island && (() => {
            const b = islandBounds(island);
            return (
              <>
                <Slider label="Left / right" unit="cm" min={Math.floor(b.x0 * 100)} max={Math.ceil(b.x1 * 100)} step={0.5}
                  value={round(layer.transform.x * 100)} onChange={(v) => setT({ x: v / 100 })} />
                <Slider label="Up / down" unit="cm" min={Math.floor(b.y0 * 100)} max={Math.ceil(b.y1 * 100)} step={0.5}
                  value={round(layer.transform.y * 100)} onChange={(v) => setT({ y: v / 100 })} />
              </>
            );
          })()}
          {layer.type !== "image" && (
            <Slider label={layer.type === "text" ? "Letter height" : "Size"} unit="cm" min={1} max={layer.type === "text" ? 40 : 60} step={0.5}
              value={round(layer.size * 100)} onChange={(v) => patch({ size: v / 100 })} />
          )}
          {layer.type === "text" && (
            <Slider label="Max width" unit="cm" min={2} max={80} step={0.5} value={round(layer.maxWidth * 100)}
              onChange={(v) => patch({ maxWidth: v / 100 })} />
          )}
        </>
      )}

      {(placed || layer.type === "pattern") && <TransformFields layer={layer} setT={setT} pattern={layer.type === "pattern"} />}

      {layer.type === "material" && (
        <>
          <label className="field">
            <span>Effect</span>
            <select value={layer.effect} onChange={(e) => {
              const next = MATERIALS.find((m) => m.id === e.target.value);
              const old = MATERIALS.find((m) => m.id === layer.effect);
              patch({ effect: next.id, name: layer.name === old?.label ? next.label : layer.name });
            }}>
              {MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <Slider label="Strength" unit="%" min={0} max={100} step={1} value={Math.round(layer.opacity * 100)}
            onChange={(v) => patch({ opacity: v / 100 })} />
          <p className="hint">Changes how the fabric catches the light where the mask allows (no colour). Limit it with the mask below.</p>
          <MaskFields layer={layer} garment={garment} patch={patch} />
        </>
      )}

      {layer.type !== "material" && (
        <>
          <details className="sub">
            <summary>
              Blending
              <span>{BLEND_LABELS[layer.blend]} · {Math.round(layer.opacity * 100)}%</span>
            </summary>
            <Slider label="Opacity" unit="%" min={0} max={100} step={1} value={Math.round(layer.opacity * 100)}
              onChange={(v) => patch({ opacity: v / 100 })} />
            <label className="field">
              <span>Blend mode</span>
              <select value={layer.blend} onChange={(e) => patch({ blend: e.target.value })}>
                {BLEND_MODES.map((m) => <option key={m} value={m}>{BLEND_LABELS[m]}</option>)}
              </select>
            </label>
          </details>
          <MaskFields layer={layer} garment={garment} patch={patch} />
          <FinishFields layer={layer} patch={patch} />
        </>
      )}

      {layer.type === "group" && <p className="hint">{layer.children.length} layer{layer.children.length === 1 ? "" : "s"}. Drag layers onto the group to put them inside.</p>}
    </fieldset>
  );
}

const round = (v) => Math.round(v * 10) / 10;

const BLEND_LABELS = Object.fromEntries(
  BLEND_MODES.map((m) => [m, m === "normal" ? "Normal" : m[0].toUpperCase() + m.slice(1).replace("-", " ")]),
);

/** Scale, rotation and flips (and the offset of a pattern; placed layers set their position above). */
function TransformFields({ layer, setT, pattern }) {
  const t = layer.transform;
  const [linked, setLinked] = useState(t.scaleX === t.scaleY);
  const pct = (v) => Math.round(v * 100);
  const setScale = (axis, v) => setT(linked ? { scaleX: v / 100, scaleY: v / 100 } : { [axis]: v / 100 });
  return (
    <div className="sub">
      <div className="sub-head">
        <span>Transform</span>
        <button type="button" className="link" onClick={() => setT({ scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false, ...(pattern ? { x: 0, y: 0 } : {}) })}>
          Reset
        </button>
      </div>
      {pattern && (
        <>
          <Slider label="Move left / right" unit="cm" min={-50} max={50} step={0.5} value={round(t.x * 100)} onChange={(v) => setT({ x: v / 100 })} />
          <Slider label="Move up / down" unit="cm" min={-50} max={50} step={0.5} value={round(t.y * 100)} onChange={(v) => setT({ y: v / 100 })} />
        </>
      )}
      <Slider label={linked ? "Scale" : "Scale X"} unit="%" min={10} max={400} step={1} value={pct(t.scaleX)} onChange={(v) => setScale("scaleX", v)} />
      {!linked && <Slider label="Scale Y" unit="%" min={10} max={400} step={1} value={pct(t.scaleY)} onChange={(v) => setScale("scaleY", v)} />}
      <label className="check">
        <input type="checkbox" checked={linked} onChange={(e) => {
          setLinked(e.target.checked);
          if (e.target.checked) setT({ scaleY: t.scaleX });
        }} />
        Keep proportions
      </label>
      <Slider label="Rotation" unit="°" min={-180} max={180} step={1} value={Math.round(t.rotation)} onChange={(v) => setT({ rotation: v })} />
      <div className="row toggles">
        <button type="button" className={`quiet${t.flipX ? " on" : ""}`} aria-pressed={t.flipX} onClick={() => setT({ flipX: !t.flipX })}>
          ⇋ Flip horizontal
        </button>
        <button type="button" className={`quiet${t.flipY ? " on" : ""}`} aria-pressed={t.flipY} onClick={() => setT({ flipY: !t.flipY })}>
          ⇵ Flip vertical
        </button>
      </div>
    </div>
  );
}

/** Garment regions the layer shows only on, and regions it is hidden on. */
function MaskFields({ layer, garment, patch }) {
  const { include, exclude } = layer.mask;
  const regions = REGIONS[garment];
  const label = (ids) => ids.map((id) => regions.find((r) => r.id === id)?.label).filter(Boolean).join(", ");
  const summary = include ? `Only ${label(include)}` : exclude.length ? `Not on ${label(exclude)}` : "Everywhere";
  const setMask = (fields) => patch({ mask: { ...layer.mask, ...fields } });
  const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <details className="sub">
      <summary>
        Mask
        <span>{include && exclude.length ? `${summary}, not on ${label(exclude)}` : summary}</span>
      </summary>
      <div className="field">
        <span>Show only on {layer.type === "pattern" && !include ? "(default: body, sleeves, socks)" : ""}</span>
        <div className="chips">
          {regions.map((r) => (
            <button key={r.id} type="button" className={`chip${include?.includes(r.id) ? " on" : ""}`} aria-pressed={!!include?.includes(r.id)}
              onClick={() => {
                const next = toggle(include || [], r.id);
                setMask({ include: next.length ? next : null });
              }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Hide on</span>
        <div className="chips">
          {regions.map((r) => (
            <button key={r.id} type="button" className={`chip${exclude.includes(r.id) ? " on" : ""}`} aria-pressed={exclude.includes(r.id)}
              onClick={() => setMask({ exclude: toggle(exclude, r.id) })}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

/** Relief, stitching and shine of the layer's shape (material maps; no colour change). */
const FINISHES = {
  flat: ["Flat print", { relief: 0, stitch: false, roughness: null, metalness: null }],
  embroidered: ["Embroidered", { relief: 0.45, stitch: true, roughness: 0.6, metalness: null }],
  raised: ["Raised (heat-pressed)", { relief: 0.5, stitch: false, roughness: 0.5, metalness: null }],
  vinyl: ["Glossy vinyl", { relief: 0.2, stitch: false, roughness: 0.2, metalness: null }],
  debossed: ["Debossed", { relief: -0.5, stitch: false, roughness: null, metalness: null }],
  foil: ["Metallic foil", { relief: 0.1, stitch: false, roughness: 0.3, metalness: 0.9 }],
};

function FinishFields({ layer, patch }) {
  const f = layer.finish;
  const preset = Object.keys(FINISHES).find((k) => JSON.stringify(FINISHES[k][1]) === JSON.stringify(f));
  const set = (fields) => patch({ finish: { ...f, ...fields } });
  return (
    <details className="sub">
      <summary>
        Finish
        <span>{preset ? FINISHES[preset][0] : "Custom"}</span>
      </summary>
      <div className="chips">
        {Object.entries(FINISHES).map(([k, [label, value]]) => (
          <button key={k} type="button" className={`chip${preset === k ? " on" : ""}`} aria-pressed={preset === k} onClick={() => patch({ finish: { ...value } })}>
            {label}
          </button>
        ))}
      </div>
      <Slider label="Relief (pressed in … raised)" unit="%" min={-100} max={100} step={5} value={Math.round(f.relief * 100)}
        onChange={(v) => set({ relief: v / 100 })} />
      <label className="check">
        <input type="checkbox" checked={f.stitch} onChange={(e) => set({ stitch: e.target.checked })} />
        Stitched (embroidery)
      </label>
      <label className="check">
        <input type="checkbox" checked={f.roughness !== null} onChange={(e) => set({ roughness: e.target.checked ? 0.4 : null })} />
        Own shine
      </label>
      {f.roughness !== null && (
        <Slider label="Roughness (glossy … matte)" unit="%" min={0} max={100} step={1} value={Math.round(f.roughness * 100)}
          onChange={(v) => set({ roughness: v / 100 })} />
      )}
      <Slider label="Metallic" unit="%" min={0} max={100} step={1} value={Math.round((f.metalness ?? 0) * 100)}
        onChange={(v) => set({ metalness: v ? v / 100 : null })} />
    </details>
  );
}

/** An island's local extent in metres: x0..x1 (across), y0..y1 (up). */
function islandBounds(isl) {
  const w = isl.rect[2] / isl.scale;
  const h = isl.rect[3] / isl.scale;
  return { x0: isl.pmin, x1: isl.pmin + w, y0: isl.qmax - h, y1: isl.qmax };
}

/** A colour: one of the palette entries (follows palette changes), a custom colour, or none when allowed. */
export function ColorField({ label, value, palette, onChange, allowNone = false, noneLabel = "None (transparent)" }) {
  const resolved = value ? resolveColor(value, palette) : "#ffffff";
  return (
    <div className="color-field">
      <span>{label}</span>
      <div className="swatches">
        {allowNone && (
          <button type="button" className={`swatch none${value === null ? " active" : ""}`} title={noneLabel}
            aria-label={`${label}: ${noneLabel}`} aria-pressed={value === null} onClick={() => onChange(null)} />
        )}
        {palette.map((c, i) => (
          <button key={i} type="button" className={`swatch${value === `@${i}` ? " active" : ""}`} style={{ background: c }}
            title={PALETTE_LABELS[i]} aria-label={`${label}: ${PALETTE_LABELS[i]}`} aria-pressed={value === `@${i}`}
            onClick={() => onChange(`@${i}`)} />
        ))}
        <label className={`swatch custom${value?.[0] === "#" ? " active" : ""}`} title="Custom colour">
          <input type="color" value={resolved} aria-label={`${label}: custom colour`} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

function AssetPicker({ project, value, onChange, uploadImage }) {
  const input = useRef(null);
  const assets = Object.entries(project.assets);
  return (
    <div className="field">
      <span>Image</span>
      <div className="assets">
        {assets.map(([id, a]) => (
          <button key={id} type="button" className={`asset${id === value ? " active" : ""}`} title={a.name} aria-label={a.name}
            aria-pressed={id === value} onClick={() => onChange(id)}>
            <img src={a.src} alt="" />
          </button>
        ))}
        <button type="button" className="asset add" onClick={() => input.current.click()} aria-label="Upload image">+</button>
      </div>
      <input ref={input} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        const asset = file && (await uploadImage(file));
        if (asset) onChange(asset.id);
      }} />
    </div>
  );
}

export function Slider({ label, unit, value, onChange, ...range }) {
  return (
    <label className="slider">
      <span>
        {label}
        <output>
          {Number(value).toFixed(unit === "×" ? 2 : unit === "%" || unit === "°" ? 0 : 1)}
          {unit === "°" || unit === "%" ? "" : " "}
          {unit}
        </output>
      </span>
      <input type="range" value={value} onChange={(e) => onChange(Number(e.target.value))} {...range} />
    </label>
  );
}

/** A small shirt-front preview of a pattern, painted by the same code as the texture. */
function PatternSwatch({ def, colors, ground }) {
  const canvas = useRef(null);
  const key = [def.id, ground, ...colors].join();
  useEffect(() => {
    const c = canvas.current;
    const ctx = c.getContext("2d");
    const n = c.width;
    const frame = {
      p0: -0.4, p1: 0.4, q0: 0, q1: 0.8,
      local: (cx) => cx.setTransform(n / 0.8, 0, 0, -n / 0.8, n / 2, n), // 80 x 80 cm of the front, hem at the bottom
    };
    fillIsland(ctx, frame, ground);
    paintPattern(ctx, def, colors, { kind: "body", name: "front" });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={canvas} width="64" height="64" aria-hidden="true" />;
}

function DesignThumb({ id }) {
  return <span className={`design-thumb design-${id}`} aria-hidden="true"><i /><b /></span>;
}

function GraphicThumb({ id }) {
  const paths = { rect: <rect x="5" y="8" width="22" height="16" rx="2" />, circle: <circle cx="16" cy="16" r="10" />, diamond: <path d="M16 4 28 16 16 28 4 16z" />, triangle: <path d="M16 4 28 27H4z" />, star: <path d="m16 3 4 9 10 1-8 7 2 10-8-5-8 5 2-10-8-7 10-1z" /> };
  return <svg className="graphic-thumb" viewBox="0 0 32 32" aria-hidden="true">{paths[id] || <path d="M4 16h24M16 4v24" />}</svg>;
}
