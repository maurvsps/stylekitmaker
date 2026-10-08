// Version 1 of the saved design (one flat object, files saved before the layer editor) and the shared font list.
// project.js migrates these designs into layer projects (projectFromDesign); fontCss is used by the compositor.

export const PATTERNS = [
  { id: "solid", label: "Solid" },
  { id: "stripes", label: "Stripes" },
  { id: "hoops", label: "Hoops" },
  { id: "halves", label: "Halves" },
  { id: "sash", label: "Sash" },
  { id: "chevron", label: "Chevron" },
  { id: "gradient", label: "Gradient" },
];

// Google Fonts loaded in index.html; weight is the one requested from the font file.
export const FONTS = [
  { id: "Oswald", weight: 700 },
  { id: "Bebas Neue", weight: 400 },
  { id: "Anton", weight: 400 },
  { id: "Teko", weight: 600 },
  { id: "Saira Condensed", weight: 800 },
  { id: "Barlow Condensed", weight: 700 },
  { id: "Big Shoulders Display", weight: 800 },
  { id: "Staatliches", weight: 400 },
  { id: "Fjalla One", weight: 400 },
  { id: "Archivo Black", weight: 400 },
  { id: "Russo One", weight: 400 },
  { id: "Squada One", weight: 400 },
  { id: "Racing Sans One", weight: 400 },
  { id: "Passion One", weight: 900 },
  { id: "Alfa Slab One", weight: 400 },
  { id: "Graduate", weight: 400 },
  { id: "Orbitron", weight: 800 },
  { id: "Chakra Petch", weight: 700 },
];

export const DEFAULT_DESIGN = {
  template: "shirt_puma19",
  colors: ["#c8102e", "#ffffff", "#0b1f3a"],
  pattern: "stripes",
  logo: null, // { src: data URL, name, x: cm, y: cm, scale }
  sponsor: "", // empty until the user adds one: a fake "SPONSOR" looked like real content
  name: "VEGA",
  number: "10",
  font: "Oswald",
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Turn untrusted input (a loaded JSON file, localStorage) into a valid design, keeping what is valid. */
export function sanitizeDesign(input, templates = []) {
  const d = { ...DEFAULT_DESIGN };
  if (!input || typeof input !== "object") return d;
  const template = resolveTemplate(input.template);
  if (typeof template === "string" && (!templates.length || templates.includes(template))) d.template = template;
  if (Array.isArray(input.colors)) d.colors = DEFAULT_DESIGN.colors.map((c, i) => (HEX.test(input.colors[i]) ? input.colors[i].toLowerCase() : c));
  if (PATTERNS.some((p) => p.id === input.pattern)) d.pattern = input.pattern;
  if (FONTS.some((f) => f.id === input.font)) d.font = input.font;
  if (typeof input.sponsor === "string") d.sponsor = input.sponsor.slice(0, 20);
  if (typeof input.name === "string") d.name = cleanName(input.name);
  if (typeof input.number === "string" || typeof input.number === "number") d.number = cleanNumber(String(input.number));
  const logo = input.logo;
  if (logo && typeof logo.src === "string" && /^data:image\/(png|svg\+xml);/.test(logo.src)) {
    d.logo = {
      src: logo.src,
      name: typeof logo.name === "string" ? logo.name : "crest",
      x: clampNum(logo.x, -15, 15, 0),
      y: clampNum(logo.y, -15, 15, 0),
      scale: clampNum(logo.scale, 0.3, 3, 1),
    };
  }
  return d;
}

/** Saved designs from before the PUMA 19 shirt became the only template open it on that shirt. */
export function resolveTemplate(name) {
  return typeof name === "string" && name.startsWith("shirt_clo") ? "shirt_puma19" : name;
}

export const cleanName = (s) => s.toUpperCase().slice(0, 14);
export const cleanNumber = (s) => s.replace(/\D/g, "").slice(0, 2);

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function fontCss(fontId, px) {
  const f = FONTS.find((x) => x.id === fontId) || FONTS[0];
  return `${f.weight} ${px}px "${f.id}", Impact, "Arial Narrow", sans-serif`;
}
