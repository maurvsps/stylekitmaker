import { useState } from "react";
import { BASE_DESIGNS, PATTERNS, baseDesign, pattern as patternDef } from "./library.js";
import { PatternSwatch, DesignThumb } from "./LayersPanel.jsx";
import { defaultPatternColors, editLayers, makeLayer, mapLayer, resolveColor, walk } from "./project.js";

const FIRST = 12; // patterns shown before "Show all"

/** The first layer of a type on the shirt (bottom to top), or null. */
function firstOf(layers, test) {
  let found = null;
  walk(layers, (l) => { if (!found && test(l)) found = l; });
  return found;
}

/**
 * Step 1: the shirt model, the body style and the pattern, all as one-click galleries
 * (the same layers the advanced Layers panel edits).
 */
export default function DesignStep({ project, setProject, shirts }) {
  const [all, setAll] = useState(false);
  const layers = project.garments.shirt.layers;
  const palette = project.palette;
  const patternLayer = firstOf(layers, (l) => l.type === "pattern");
  const bodyLayer = firstOf(layers, (l) => l.type === "base" && !baseDesign("shirt", l.design).trim);
  const activePattern = patternLayer && patternLayer.visible ? patternDef(patternLayer.pattern) : null;
  const activeBody = bodyLayer ? baseDesign("shirt", bodyLayer.design) : null;

  const pickPattern = (def) => {
    setProject((p) => editLayers(p, "shirt", (ls) => {
      const cur = firstOf(ls, (l) => l.type === "pattern");
      if (cur) {
        const from = patternDef(cur.pattern);
        return mapLayer(ls, cur.id, (l) => ({
          ...l, visible: true, pattern: def.id, name: l.name === from.label ? def.label : l.name,
          colors: defaultPatternColors(def, l.colors, from),
        }));
      }
      const layer = makeLayer("pattern", "shirt", { pattern: def.id });
      const at = ls.findIndex((l) => l.type === "base") + 1; // just above the base design
      return [...ls.slice(0, at), layer, ...ls.slice(at)];
    }));
  };

  const plain = () => {
    if (!patternLayer) return;
    setProject((p) => editLayers(p, "shirt", (ls) => mapLayer(ls, patternLayer.id, (l) => ({ ...l, visible: false }))));
  };

  const pickBody = (next) => {
    if (!bodyLayer) return;
    setProject((p) => editLayers(p, "shirt", (ls) => mapLayer(ls, bodyLayer.id, (l) => ({
      ...l, design: next.id, colors: Object.fromEntries(next.slots.map(([k, , c]) => [k, l.colors[k] ?? c])),
    }))));
  };

  const shown = all ? PATTERNS : PATTERNS.slice(0, FIRST);
  const ground = palette[0];

  return (
    <>
      {bodyLayer && (
        <>
          <span className="group-label">Body style</span>
          <div className="design-gallery" role="radiogroup" aria-label="Body style">
            {BASE_DESIGNS.shirt.filter((b) => !b.trim).map((b) => (
              <button key={b.id} type="button" role="radio" aria-checked={activeBody?.id === b.id}
                className={`design-card${activeBody?.id === b.id ? " active" : ""}`} onClick={() => pickBody(b)}>
                <DesignThumb id={b.id} /><span>{b.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <span className="group-label">Pattern</span>
      <div className="pattern-gallery" role="radiogroup" aria-label="Pattern">
        <button type="button" role="radio" aria-checked={!activePattern} className={`pattern-card${!activePattern ? " active" : ""}`} onClick={plain}>
          <span className="pattern-plain" aria-hidden="true" style={{ background: ground }} />
          <span>Plain</span>
        </button>
        {shown.map((def) => {
          const colors = defaultPatternColors(def, patternLayer?.colors, patternLayer ? patternDef(patternLayer.pattern) : null);
          return (
            <button key={def.id} type="button" role="radio" aria-checked={activePattern?.id === def.id}
              className={`pattern-card${activePattern?.id === def.id ? " active" : ""}`} onClick={() => pickPattern(def)}>
              <PatternSwatch def={def} colors={colors.map((c) => c && resolveColor(c, palette))} ground={ground} />
              <span>{def.label}</span>
            </button>
          );
        })}
      </div>
      {PATTERNS.length > FIRST && (
        <button type="button" className="quiet" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${PATTERNS.length} patterns`}</button>
      )}
      <p className="hint">Colours come from the next step. Fine control (position, scale, masks) lives in Advanced layers.</p>
    </>
  );
}
