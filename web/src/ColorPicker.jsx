import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The app's own colour picker: a swatch button that opens a glass popover with a saturation/brightness square,
// a hue strip, a hex field, the screen eyedropper (where the browser has one), the kit colours, favourites and
// recently used colours. Favourites and recents belong to this browser (localStorage), not to the design.

const FAVORITES = "kit-maker:color-favorites";
const RECENTS = "kit-maker:color-recents";
const MAX_RECENTS = 12;
const MAX_FAVORITES = 24;

const load = (key) => {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(list) ? list.filter((c) => /^#[0-9a-f]{6}$/.test(c)) : [];
  } catch {
    return [];
  }
};
const save = (key, list) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* private window or storage blocked: the lists just do not persist */
  }
};

export function rememberColor(hex) {
  const c = normalizeHex(hex);
  if (c) save(RECENTS, [c, ...load(RECENTS).filter((x) => x !== c)].slice(0, MAX_RECENTS));
}

export function normalizeHex(text) {
  let s = String(text || "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.replace(/./g, "$&$&");
  return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
}

export function hexToHsv(hex) {
  const n = parseInt(normalizeHex(hex)?.slice(1) || "ffffff", 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A button showing `value` that opens the picker. `palette` (the kit colours) is offered as quick picks.
 * Extra props (className, style, title, aria-label, children) go on the button.
 */
export default function ColorButton({ value, onChange, palette = [], label = "Colour", className = "", children, ...rest }) {
  const button = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={button} type="button" className={`color-button ${className}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={rest["aria-label"] || `${label}: ${value}`} title={rest.title || label} style={rest.style}
        onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      {open && <ColorPopover anchor={button.current} value={value} onChange={onChange} palette={palette} label={label} onClose={() => setOpen(false)} />}
    </>
  );
}

function ColorPopover({ anchor, value, onChange, palette, label, onClose }) {
  const pop = useRef(null);
  const start = useRef(normalizeHex(value) || "#ffffff");
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hex, setHex] = useState(normalizeHex(value) || "#ffffff");
  const [favorites, setFavorites] = useState(() => load(FAVORITES));
  const [recents] = useState(() => load(RECENTS));
  const [pos, setPos] = useState(null);

  // Follow outside changes (undo, another control) without losing the hue of greys.
  useEffect(() => {
    const c = normalizeHex(value);
    if (c && c !== hsvToHex(hsv)) {
      setHsv(hexToHsv(c));
      setHex(c);
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (next) => {
    setHsv(next);
    const c = hsvToHex(next);
    setHex(c);
    onChange(c);
  };
  const pick = (c) => {
    const n = normalizeHex(c);
    if (!n) return;
    setHsv(hexToHsv(n));
    setHex(n);
    onChange(n);
  };

  // Recently used: the colour it ends on, if it changed.
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => () => {
    const c = normalizeHex(latest.current);
    if (c && c !== start.current) rememberColor(c);
  }, []);

  // Place below (or above) the button, kept on screen; a bottom sheet on narrow screens.
  useLayoutEffect(() => {
    const place = () => {
      const el = pop.current;
      if (!el || !anchor) return;
      if (innerWidth <= 560) return setPos({ sheet: true });
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth, h = el.offsetHeight;
      const left = Math.min(Math.max(8, a.left), innerWidth - w - 8);
      const below = a.bottom + 8;
      const roomBelow = below + h <= innerHeight - 8;
      const top = Math.min(Math.max(8, roomBelow ? below : a.top - h - 8), Math.max(8, innerHeight - h - 8));
      setPos({ left, top });
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const down = (e) => {
      if (!pop.current?.contains(e.target) && !anchor?.contains(e.target)) onClose();
    };
    const key = (e) => e.key === "Escape" && onClose();
    const scroll = (e) => !pop.current?.contains(e.target) && onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, onClose]);

  const drag = (handler) => (e) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      handler(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    move(e);
    el.onpointermove = move;
    el.onpointerup = el.onpointercancel = () => { el.onpointermove = null; };
  };
  const nudge = (key, step) => (e) => {
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const next = { ...hsv };
    if (key === "sv") {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") next.s = Math.min(1, Math.max(0, hsv.s + d * step));
      else next.v = Math.min(1, Math.max(0, hsv.v + d * step));
    } else next.h = (hsv.h + d * step * 360 + 360) % 360;
    apply(next);
  };

  const current = hsvToHex(hsv);
  const isFavorite = favorites.includes(current);
  const toggleFavorite = () => {
    const next = isFavorite ? favorites.filter((c) => c !== current) : [current, ...favorites].slice(0, MAX_FAVORITES);
    setFavorites(next);
    save(FAVORITES, next);
  };
  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const sample = async () => {
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      pick(sRGBHex);
    } catch {
      /* cancelled */
    }
  };

  const style = pos?.sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 };
  return createPortal(
    <div ref={pop} className={`color-pop${pos?.sheet ? " sheet-mode" : ""}`} role="dialog" aria-label={`${label} colour`} style={style}>
      <div className="cp-sv" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={drag((x, y) => apply({ ...hsv, s: x, v: 1 - y }))}
        tabIndex={0} role="slider" aria-label="Saturation and brightness" aria-valuetext={current} onKeyDown={nudge("sv", 0.02)}>
        <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }} />
      </div>
      <div className="cp-hue" onPointerDown={drag((x) => apply({ ...hsv, h: Math.min(359.9, x * 360) }))}
        tabIndex={0} role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} onKeyDown={nudge("h", 1 / 72)}>
        <i style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div className="cp-row">
        <span className="cp-preview" style={{ background: current }} />
        <input className="cp-hex" value={hex} spellCheck={false} aria-label="Hex colour" maxLength={7}
          onChange={(e) => { setHex(e.target.value); const c = normalizeHex(e.target.value); if (c && e.target.value.replace("#", "").length === 6) pick(c); }}
          onBlur={() => setHex(current)} onKeyDown={(e) => e.key === "Enter" && pick(hex)} />
        {eyedropper && <button type="button" className="cp-icon" onClick={sample} title="Pick from screen" aria-label="Pick a colour from the screen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 4.6a2 2 0 0 0-2.8 0l-2.3 2.3-1.1-1.1-1.4 1.4 1.1 1.1-7.4 7.4V19h3.3l7.4-7.4 1.1 1.1 1.4-1.4-1.1-1.1 2.3-2.3a2 2 0 0 0 0-2.8l-.5-.5ZM7.5 17H7v-.5l7.1-7.1.5.5L7.5 17Z" /></svg>
        </button>}
        <button type="button" className={`cp-icon${isFavorite ? " on" : ""}`} onClick={toggleFavorite} aria-pressed={isFavorite}
          title={isFavorite ? "Remove from favourites" : "Add to favourites"} aria-label={isFavorite ? "Remove from favourites" : "Add to favourites"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" /></svg>
        </button>
      </div>
      {palette.length > 0 && <Swatches title="Kit colours" colors={palette} current={current} onPick={pick} />}
      <Swatches title="Favourites" colors={favorites} current={current} onPick={pick} empty="Tap ☆ to save the current colour." />
      <Swatches title="Recent" colors={recents} current={current} onPick={pick} empty="Colours you use appear here." />
    </div>,
    document.body,
  );
}

function Swatches({ title, colors, current, onPick, empty }) {
  return (
    <div className="cp-group">
      <span>{title}</span>
      {colors.length ? (
        <div className="cp-swatches">
          {colors.map((c, i) => (
            <button key={`${c}${i}`} type="button" className={`cp-swatch${normalizeHex(c) === current ? " on" : ""}`} style={{ background: c }}
              title={c} aria-label={`${title}: ${c}`} onClick={() => onPick(c)} />
          ))}
        </div>
      ) : (
        <p>{empty}</p>
      )}
    </div>
  );
}
