import ColorButton from "./ColorPicker.jsx";
import { PALETTES } from "./palettes.js";
import { PALETTE_LABELS } from "./project.js";

const same = (a, b) => a.length === b.length && a.every((c, i) => c.toLowerCase() === b[i].toLowerCase());

/** Step 2: colour combinations in one click, swap and shuffle, and the three kit colours by hand. */
export default function ColorsStep({ palette, setPalette }) {
  const shuffle = () => {
    const options = PALETTES.filter((p) => !same(p.colors, palette));
    setPalette(options[Math.floor(Math.random() * options.length)].colors);
  };
  return (
    <>
      <span className="group-label">Kit colours</span>
      <div className="colors">
        {palette.map((c, i) => (
          <div key={i} className="color">
            <ColorButton className="kit-color" style={{ background: c }} value={c} label={PALETTE_LABELS[i]} palette={palette}
              onChange={(hex) => setPalette(palette.map((x, k) => (k === i ? hex : x)))} />
            <span>{PALETTE_LABELS[i]}</span>
          </div>
        ))}
      </div>
      <div className="row">
        <button type="button" className="quiet" onClick={() => setPalette([palette[1], palette[0], palette[2]])} title="Swap primary and secondary">Swap main colours</button>
        <button type="button" className="quiet" onClick={shuffle}>Surprise me</button>
      </div>

      <span className="group-label">Colour combinations</span>
      <div className="palette-grid" role="radiogroup" aria-label="Colour combinations">
        {PALETTES.map((p) => {
          const on = same(p.colors, palette);
          return (
            <button key={p.name} type="button" role="radio" aria-checked={on} className={`palette-card${on ? " active" : ""}`} onClick={() => setPalette(p.colors)}>
              <span className="palette-chips" aria-hidden="true">{p.colors.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
              <span>{p.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
