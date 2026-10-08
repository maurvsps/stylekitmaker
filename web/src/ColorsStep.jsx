import ColorButton from "./ColorPicker.jsx";
import { PALETTE_LABELS } from "./project.js";

/** The three kit colours, picked by hand. */
export default function ColorsStep({ palette, setPalette }) {
  return (
    <>
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
      </div>
    </>
  );
}
