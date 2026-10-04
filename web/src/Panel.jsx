import { useRef } from "react";
import { COLOR_LABELS, LOGO_DEFAULTS, PATTERNS, cleanName, cleanNumber } from "./design.js";

const MAX_LOGO_BYTES = 1.5 * 1024 * 1024;

export default function Panel({ design, update, shirts, fonts, actions, onError }) {
  const logoInput = useRef(null);
  const designInput = useRef(null);

  const setColor = (i, value) => update({ colors: design.colors.map((c, k) => (k === i ? value : c)) });
  const setLogo = (patch) => update({ logo: { ...design.logo, ...patch } });

  const onLogoFile = (file) => {
    if (!file) return;
    if (!/^image\/(png|svg\+xml)$/.test(file.type)) return onError("The crest must be a PNG or SVG file.");
    if (file.size > MAX_LOGO_BYTES) return onError("The crest file is too large (1.5 MB max).");
    const reader = new FileReader();
    reader.onload = () => update({ logo: { ...LOGO_DEFAULTS, ...(design.logo || {}), src: reader.result, name: file.name } });
    reader.readAsDataURL(file);
  };

  return (
    <aside className="panel" aria-label="Kit design">
      <h1>Kit Maker</h1>

      <Section title="Template">
        <select value={design.template} onChange={(e) => update({ template: e.target.value })} aria-label="Shirt template">
          {shirts.map((k) => (
            <option key={k.name} value={k.name}>
              {k.label}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Colours">
        <div className="colors">
          {design.colors.map((c, i) => (
            <label key={i} className="color">
              <input type="color" value={c} onChange={(e) => setColor(i, e.target.value)} />
              <span>{COLOR_LABELS[i]}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Pattern">
        <div className="patterns" role="radiogroup" aria-label="Pattern">
          {PATTERNS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={design.pattern === p.id}
              className={design.pattern === p.id ? "active" : ""}
              onClick={() => update({ pattern: p.id })}
            >
              <PatternSwatch id={p.id} colors={design.colors} />
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Player">
        <div className="row">
          <label className="field grow">
            <span>Name</span>
            <input value={design.name} onChange={(e) => update({ name: cleanName(e.target.value) })} />
          </label>
          <label className="field number">
            <span>Number</span>
            <input inputMode="numeric" value={design.number} onChange={(e) => update({ number: cleanNumber(e.target.value) })} />
          </label>
        </div>
        <label className="field">
          <span>Font</span>
          <select value={design.font} onChange={(e) => update({ font: e.target.value })}>
            {fonts.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.id }}>
                {f.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sponsor</span>
          <input value={design.sponsor} maxLength={20} onChange={(e) => update({ sponsor: e.target.value })} />
        </label>
      </Section>

      <Section title="Crest">
        <input ref={logoInput} type="file" accept="image/png,image/svg+xml" hidden onChange={(e) => {
          onLogoFile(e.target.files[0]);
          e.target.value = "";
        }} />
        <div className="row">
          <button type="button" onClick={() => logoInput.current.click()}>
            {design.logo ? "Replace" : "Upload PNG/SVG"}
          </button>
          {design.logo && (
            <button type="button" className="quiet" onClick={() => update({ logo: null })}>
              Remove
            </button>
          )}
        </div>
        {design.logo && (
          <>
            <p className="file-name">{design.logo.name}</p>
            <Slider label="Left / right" unit="cm" min={-15} max={15} step={0.5} value={design.logo.x} onChange={(x) => setLogo({ x })} />
            <Slider label="Up / down" unit="cm" min={-15} max={15} step={0.5} value={design.logo.y} onChange={(y) => setLogo({ y })} />
            <Slider label="Size" unit="×" min={0.3} max={3} step={0.05} value={design.logo.scale} onChange={(scale) => setLogo({ scale })} />
          </>
        )}
      </Section>

      <Section title="Export">
        <button type="button" onClick={actions.screenshot}>
          Screenshot (PNG)
        </button>
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

function Slider({ label, unit, value, onChange, ...range }) {
  return (
    <label className="slider">
      <span>
        {label}
        <output>
          {Number(value).toFixed(unit === "×" ? 2 : 1)} {unit}
        </output>
      </span>
      <input type="range" value={value} onChange={(e) => onChange(Number(e.target.value))} {...range} />
    </label>
  );
}

/** A tiny shirt-front preview of each pattern, in the current colours. */
function PatternSwatch({ id, colors: [a, b] }) {
  const shapes = {
    solid: null,
    stripes: [0, 1, 2].map((k) => <rect key={k} x={3 + k * 9} y="0" width="4.5" height="32" fill={b} />),
    hoops: [0, 1, 2].map((k) => <rect key={k} x="0" y={4 + k * 10} width="32" height="5" fill={b} />),
    halves: <rect x="16" y="0" width="16" height="32" fill={b} />,
    sash: <path d="M-4 4 L4 -4 L36 28 L28 36 Z" fill={b} />,
    chevron: <path d="M0 6 L16 18 L32 6 L32 12 L16 24 L0 12 Z" fill={b} />,
    gradient: null,
  };
  const gid = `g-${id}`;
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={b} />
          <stop offset="1" stopColor={a} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" fill={id === "gradient" ? `url(#${gid})` : a} />
      {shapes[id]}
    </svg>
  );
}
