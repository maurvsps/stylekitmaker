// The kit project (schema version 4): a palette, project-wide text settings, uploaded images, and an ordered
// stack of layers per garment. kitTexture.js composites a garment's layers into its texture; the panel edits them.
// Version 1 files (one flat design object, see design.js) are migrated on load by projectFromDesign(); version 2
// files (patterns had `regions` instead of a mask) and version 3 files (no `finish`) by sanitizeProject().
//
// {
//   version: 4,
//   template: "shirt",                         // shirt model (kits.json); shorts and socks have one model each
//   palette: ["#c8102e", "#ffffff", "#0b1f3a"], // primary, secondary, trim; layer colours "@0".."@2" refer to it
//   font: "Oswald",                            // default font for text layers
//   player: { name: "VEGA", number: "10" },    // text layers with bind: "name" | "number" show these
//   assets: { <id>: { src: data URL, name } },  // uploaded images, used by image layers
//   garments: { shirt: { layers: [...] }, shorts: { layers: [...] }, socks: { layers: [...] } },
// }
//
// Layers are listed bottom to top. Every layer has
//   { id, type, name, visible, locked, opacity, blend, transform: { x, y, scaleX, scaleY, rotation, flipX, flipY },
//     mask: { include: [region ids] | null, exclude: [region ids] },
//     finish: { relief: -1..1, stitch: bool, roughness: 0..1 | null, metalness: 0..1 | null } }
// The mask limits the layer to the garment regions in `include` (null = no limit) and hides it on those in `exclude`
// (library.js REGIONS); a group's mask applies to everything inside it.
// The finish changes how the layer's shape catches the light (kitTexture.js drawMaterial): raised (relief > 0) or
// pressed in (< 0), stitched like embroidery, and its own roughness / metalness (null = the fabric's).
// plus its type's fields:
//   base     { design, colors: { <slot>: colour } }          opaque ground, or the trims (library.js BASE_DESIGNS)
//   pattern  { pattern, colors: [colour..., background|null] }   pattern space moved by transform
//   graphic  { shape, color, size, surface }                  transform x/y = centre in the surface's frame (metres)
//   image    { asset, size, surface, tint, stroke }           size = longer side in metres before scaling; stroke = { color, width (metres) } or null
//   text     { text, bind, font, color, size, maxWidth, outline, surface }   size = capital height in metres
//   material { effect }                                       fabric finish over its mask (library.js MATERIALS)
//   group    { children: [layers...] }
// `role` (optional) marks the layers the panel's shortcuts edit: crest, sponsor, name, number.

import { DEFAULT_DESIGN, FONTS, cleanName, cleanNumber, resolveTemplate, sanitizeDesign } from "./design.js";
import { GRAPHICS, MATERIALS, REGIONS, baseDesign, pattern as patternDef, patternSlots } from "./library.js";

export const PROJECT_VERSION = 4;
export const GARMENTS = ["shirt", "shorts", "socks"];
// Garments the editor shows and edits. Shorts and socks stay in the project (old designs keep them) but are hidden.
export const SHOWN_GARMENTS = ["shirt"];
export const PALETTE_LABELS = ["Primary", "Secondary", "Trim"];

export const LAYER_TYPES = {
  base: "Base design",
  pattern: "Pattern",
  graphic: "Graphic",
  image: "Image",
  text: "Text",
  material: "Material effect",
  group: "Group",
};

export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

// Parts a layer can be placed on (graphic, image, text). Names are UV islands.
export const SURFACES = {
  shirt: [["front", "Front"], ["back", "Back"], ["sleeve_left", "Left sleeve"], ["sleeve_right", "Right sleeve"], ["collar", "Collar"]],
  shorts: [["front", "Front"], ["back", "Back"]],
  socks: [["sock_left", "Left sock"], ["sock_right", "Right sock"]],
};
export { REGIONS };

export const NO_MASK = { include: null, exclude: [] };
export const NO_FINISH = { relief: 0, stitch: false, roughness: null, metalness: null };

/** Whether a layer changes the material maps (relief, roughness, metalness). */
export const hasFinish = (l) =>
  l.type === "material" || l.texture === "smooth" || !!(l.finish && (l.finish.relief || l.finish.roughness !== null || l.finish.metalness !== null));

export const ROLES = ["crest", "sponsor", "name", "number", "logo-brand", "logo-shirt-sponsor", "logo-back-sponsor", "logo-sleeve-left", "logo-sleeve-right", "logo-shorts-mark", "logo-sock-mark"];

const HEX = /^#[0-9a-f]{6}$/i;
const IMAGE_SRC = /^data:image\/(png|svg\+xml|jpeg|webp);/;
const MAX_LAYERS = 200;
const MAX_DEPTH = 4;

export const IDENTITY = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false };

let seq = 0;
export const newId = (prefix = "l") => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A colour value: "@n" (palette entry) or "#rrggbb". */
export function resolveColor(value, palette) {
  if (typeof value === "string" && value[0] === "@") return palette[Number(value.slice(1))] || palette[0];
  return value;
}

// ---------------------------------------------------------------- new layers

const COMMON = { visible: true, locked: false, opacity: 1, blend: "normal" };

// Where new placed layers go: the middle of the chest, the front of the shorts, the shin.
const PLACE = { shirt: ["front", 0, 0.45], shorts: ["front", 0.13, 0.2], socks: ["sock_left", 0, -0.2] };

/** A new layer of `type` for `garment` with sensible defaults; `fields` override them. */
export function makeLayer(type, garment, fields = {}) {
  const [surface, x, y] = PLACE[garment];
  const base = { id: newId(), type, name: LAYER_TYPES[type], ...COMMON, transform: { ...IDENTITY }, mask: { ...NO_MASK, exclude: [] }, finish: { ...NO_FINISH } };
  const placed = { surface, transform: { ...IDENTITY, x, y } };
  const typed = {
    base: () => {
      const b = baseDesign(garment, fields.design);
      return { name: b.trim ? b.label : LAYER_TYPES.base, design: b.id, colors: Object.fromEntries(b.slots.map(([k, , c]) => [k, c])) };
    },
    pattern: () => {
      const p = patternDef(fields.pattern);
      return { name: p.label, pattern: p.id, colors: defaultPatternColors(p) };
    },
    graphic: () => ({ ...placed, shape: "circle", color: "@1", size: 0.1 }),
    image: () => ({ ...placed, asset: null, size: 0.085, tint: null, stroke: null, texture: "kit" }), // texture: kit fabric or a smooth print
    text: () => ({ ...placed, text: "TEXT", bind: null, font: null, color: "@2", size: 0.05, maxWidth: 0.32, outline: true, texture: "kit" }),
    material: () => ({ name: "Satin", effect: "satin" }),
    group: () => ({ children: [] }),
  }[type]();
  return { ...base, ...typed, ...fields, transform: { ...(typed.transform || base.transform), ...(fields.transform || {}) } };
}

/**
 * Colours for a pattern layer switching to pattern `p`: the previous layer's colours (`old`, for pattern `from`) where
 * they fit, else secondary on the first slot, primary on the second, and no background.
 */
export function defaultPatternColors(p, old = [], from = null) {
  const ink = from ? old.slice(0, from.slots.length) : [];
  const ground = from && !from.opaque ? old[from.slots.length] ?? null : null;
  const colors = [];
  p.slots.forEach((_, i) => colors.push(ink[i] || (i === 0 ? "@1" : colors[0] === "@0" ? "@1" : "@0")));
  return p.opaque ? colors : [...colors, ground];
}

// ---------------------------------------------------------------- version 1 -> 2

const LEGACY_PATTERN_REGIONS = {
  hoops: ["front", "back", "sleeve_left", "sleeve_right"],
  halves: ["front", "back", "sleeve_left"],
};

// Version 1 pattern colours: [pattern colours..., background]. Stripes are primary on a secondary ground.
const LEGACY_PATTERN_COLORS = { stripes: ["@0", "@1"], gradient: ["@1", "@0"] };

/** The layers that paint a version 1 design exactly as the version 1 painter did. */
export function projectFromDesign(input, templates) {
  const d = sanitizeDesign(input, templates);
  const text = (id, role, surface, x, y, size, maxWidth, color, fields) =>
    ({ ...makeLayer("text", "shirt"), id, role, surface, size, maxWidth, color, transform: { ...IDENTITY, x, y }, ...fields });
  const base = (g, design, id, name) => ({ ...makeLayer("base", g, { design }), id, name });
  const shirt = [base("shirt", "classic", "shirt-base", "Base")];
  if (d.pattern !== "solid") {
    const p = patternDef(d.pattern);
    shirt.push({
      ...makeLayer("pattern", "shirt", { pattern: p.id }),
      id: "shirt-pattern",
      colors: LEGACY_PATTERN_COLORS[p.id] || ["@1", null],
      mask: { include: LEGACY_PATTERN_REGIONS[p.id] || ["front", "back"], exclude: [] },
    });
  }
  shirt.push(base("shirt", "trim", "shirt-trim", "Collar & cuffs"));
  const assets = {};
  if (d.logo) {
    assets.crest = { src: d.logo.src, name: d.logo.name };
    shirt.push({
      ...makeLayer("image", "shirt"),
      id: "shirt-crest", role: "crest", name: "Crest", asset: "crest", surface: "front",
      transform: { ...IDENTITY, x: 0.095 + d.logo.x / 100, y: 0.555 + d.logo.y / 100, scaleX: d.logo.scale, scaleY: d.logo.scale },
    });
  }
  shirt.push(
    text("shirt-number-front", undefined, "front", -0.095, 0.555, 0.055, 0.08, "@2", { name: "Number (front)", bind: "number" }),
    text("shirt-sponsor", "sponsor", "front", 0, 0.39, 0.065, 0.32, "@2", { name: "Sponsor", text: d.sponsor }),
    text("shirt-name", "name", "back", 0, 0.6, 0.05, 0.32, "@2", { name: "Name", bind: "name" }),
    text("shirt-number", "number", "back", 0, 0.37, 0.24, 0.34, "@2", { name: "Number", bind: "number" }),
  );
  const shorts = [
    base("shorts", "plain", "shorts-base", "Base"),
    base("shorts", "trim", "shorts-trim", "Hem & waistband"),
    text("shorts-number", undefined, "front", 0.13, 0.085, 0.07, 0.1, "@0", { name: "Number", bind: "number" }),
  ];
  const socks = [base("socks", "hoops", "socks-base", "Base"), base("socks", "trim", "socks-trim", "Top band")];
  return {
    version: PROJECT_VERSION,
    template: d.template,
    palette: [...d.colors],
    font: d.font,
    player: { name: d.name, number: d.number },
    assets,
    garments: { shirt: { layers: shirt }, shorts: { layers: shorts }, socks: { layers: socks } },
  };
}

export const DEFAULT_PROJECT = projectFromDesign(DEFAULT_DESIGN);

// ---------------------------------------------------------------- sanitizing (saved files, localStorage)

/** Any saved design (version 1 to 4) as a valid version 4 project, keeping what is valid. */
export function sanitizeProject(input, templates = []) {
  if (!input || typeof input !== "object") return structuredClone(DEFAULT_PROJECT);
  if (!(Number(input.version) >= 2) || !input.garments) return projectFromDesign(input, templates);
  const p = structuredClone(DEFAULT_PROJECT);
  const template = resolveTemplate(input.template);
  if (typeof template === "string" && (!templates.length || templates.includes(template))) p.template = template;
  if (Array.isArray(input.palette)) p.palette = p.palette.map((c, i) => (HEX.test(input.palette[i]) ? input.palette[i].toLowerCase() : c));
  if (FONTS.some((f) => f.id === input.font)) p.font = input.font;
  if (input.player && typeof input.player === "object") {
    if (typeof input.player.name === "string") p.player.name = cleanName(input.player.name);
    if (typeof input.player.number === "string" || typeof input.player.number === "number") p.player.number = cleanNumber(String(input.player.number));
  }
  p.assets = {};
  for (const [id, a] of Object.entries(input.assets && typeof input.assets === "object" ? input.assets : {})) {
    if (a && typeof a.src === "string" && IMAGE_SRC.test(a.src)) p.assets[id] = { src: a.src, name: str(a.name, 80, "image") };
  }
  const ids = new Set();
  const budget = { left: MAX_LAYERS, legacy: Number(input.version) < 4 };
  for (const g of GARMENTS) {
    const layers = input.garments[g]?.layers;
    if (Array.isArray(layers)) p.garments[g] = { layers: sanitizeLayers(layers, g, p.assets, ids, budget, 0) };
  }
  return p;
}

function sanitizeLayers(list, garment, assets, ids, budget, depth) {
  const out = [];
  for (const l of list) {
    if (budget.left <= 0) break;
    const layer = sanitizeLayer(l, garment, assets, ids, budget, depth);
    if (layer) out.push(layer);
  }
  return out;
}

function sanitizeLayer(l, garment, assets, ids, budget, depth) {
  if (!l || typeof l !== "object" || !LAYER_TYPES[l.type]) return null;
  if (l.type === "group" && depth >= MAX_DEPTH) return null;
  budget.left--;
  const d = makeLayer(l.type, garment);
  let id = typeof l.id === "string" && /^[\w-]{1,40}$/.test(l.id) ? l.id : d.id;
  if (ids.has(id)) id = newId();
  ids.add(id);
  const t = l.transform && typeof l.transform === "object" ? l.transform : {};
  const layer = {
    ...d,
    id,
    name: str(l.name, 40, d.name),
    visible: l.visible !== false,
    locked: l.locked === true,
    opacity: num(l.opacity, 0, 1, 1),
    blend: BLEND_MODES.includes(l.blend) ? l.blend : "normal",
    transform: {
      x: num(t.x, -2, 2, d.transform.x),
      y: num(t.y, -2, 2, d.transform.y),
      scaleX: num(t.scaleX, 0.05, 10, 1),
      scaleY: num(t.scaleY, 0.05, 10, 1),
      rotation: num(t.rotation, -360, 360, 0),
      flipX: t.flipX === true,
      flipY: t.flipY === true,
    },
    mask: sanitizeMask(l.mask, garment),
    finish: sanitizeFinish(l.finish),
  };
  // Version 2 patterns listed the parts they covered.
  if (l.type === "pattern" && !l.mask && Array.isArray(l.regions)) layer.mask = sanitizeMask({ include: l.regions }, garment);
  if (ROLES.includes(l.role)) layer.role = l.role;
  else delete layer.role;
  const surfaces = SURFACES[garment].map(([s]) => s);
  if ("surface" in d) layer.surface = surfaces.includes(l.surface) ? l.surface : d.surface;
  switch (l.type) {
    case "base": {
      const b = baseDesign(garment, l.design);
      const colors = l.colors && typeof l.colors === "object" ? l.colors : {};
      layer.design = b.id;
      layer.colors = Object.fromEntries(b.slots.map(([k, , def]) => [k, color(colors[k], def)]));
      break;
    }
    case "pattern": {
      const p = patternDef(l.pattern);
      const colors = Array.isArray(l.colors) ? l.colors : [];
      const fallback = defaultPatternColors(p);
      layer.pattern = p.id;
      layer.colors = fallback.map((def, i) => (i === p.slots.length && colors[i] === null ? null : color(colors[i], def)));
      break;
    }
    case "graphic":
      layer.shape = GRAPHICS.some((g) => g.id === l.shape) ? l.shape : d.shape;
      layer.color = color(l.color, d.color);
      layer.size = num(l.size, 0.005, 1, d.size);
      break;
    case "image":
      layer.asset = typeof l.asset === "string" && assets[l.asset] ? l.asset : null;
      layer.size = num(l.size, 0.005, 1, d.size);
      layer.tint = l.tint == null ? null : color(l.tint, null); // older designs have none: original colours
      layer.texture = l.texture === "smooth" ? "smooth" : "kit";
      layer.stroke = sanitizeStroke(l.stroke);
      break;
    case "text":
      layer.text = str(l.text, 40, "");
      layer.bind = l.bind === "name" || l.bind === "number" ? l.bind : null;
      layer.font = FONTS.some((f) => f.id === l.font) ? l.font : null;
      layer.color = color(l.color, d.color);
      layer.size = num(l.size, 0.005, 0.6, d.size);
      layer.maxWidth = num(l.maxWidth, 0.01, 1.5, d.maxWidth);
      layer.outline = l.outline !== false;
      layer.texture = l.texture === "smooth" ? "smooth" : "kit";
      break;
    case "material":
      {
        // Effects of the first material layer (main before version 4) map to their equivalents.
        const effect = { shine: "satin", knit: "ribbed" }[l.effect] || l.effect;
        layer.effect = MATERIALS.some((m) => m.id === effect) ? effect : d.effect;
        // Older material layers that painted nothing come in hidden, so those files look the same.
        if (budget.legacy && !["shine", "knit", "raised"].includes(l.effect)) layer.visible = false;
      }
      break;
    case "group":
      layer.children = Array.isArray(l.children) ? sanitizeLayers(l.children, garment, assets, ids, budget, depth + 1) : [];
      break;
  }
  return layer;
}

function sanitizeStroke(s) {
  if (!s || typeof s !== "object") return null;
  const width = num(s.width, 0, 0.012, 0);
  return width > 0 ? { color: color(s.color, "#ffffff"), width } : null;
}

function sanitizeMask(m, garment) {
  const ids = REGIONS[garment].map((r) => r.id);
  const pick = (list) => (Array.isArray(list) ? ids.filter((id) => list.includes(id)) : []);
  if (!m || typeof m !== "object") return { include: null, exclude: [] };
  return { include: Array.isArray(m.include) ? pick(m.include) : null, exclude: pick(m.exclude) };
}

function sanitizeFinish(f) {
  if (!f || typeof f !== "object") return { ...NO_FINISH };
  const opt = (v) => (v === null || v === undefined ? null : num(v, 0, 1, null));
  return { relief: num(f.relief, -1, 1, 0), stitch: f.stitch === true, roughness: opt(f.roughness), metalness: opt(f.metalness) };
}

const color = (v, fallback) => (typeof v === "string" && (/^@[0-2]$/.test(v) || HEX.test(v)) ? v.toLowerCase() : fallback);
const str = (v, max, fallback) => (typeof v === "string" ? v.slice(0, max) : fallback);
function num(v, lo, hi, fallback) {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** The project as saved: version stamped, unused images dropped. */
export function serializeProject(project) {
  const used = new Set();
  for (const g of GARMENTS) walk(project.garments[g].layers, (l) => l.type === "image" && l.asset && used.add(l.asset));
  const assets = Object.fromEntries(Object.entries(project.assets).filter(([id]) => used.has(id)));
  return { ...project, version: PROJECT_VERSION, assets };
}

// ---------------------------------------------------------------- layer tree

/** Visit every layer (depth first, bottom to top). */
export function walk(layers, fn, parent = null) {
  for (const l of layers) {
    fn(l, parent);
    if (l.type === "group") walk(l.children, fn, l);
  }
}

export function findLayer(layers, id) {
  let found = null;
  walk(layers, (l) => {
    if (l.id === id) found = l;
  });
  return found;
}

export const findRole = (layers, role) => {
  let found = null;
  walk(layers, (l) => {
    if (!found && l.role === role) found = l;
  });
  return found;
};

/** Where a layer sits: { list (its parent's array), index, parentId }. */
export function locate(layers, id, parentId = null) {
  const index = layers.findIndex((l) => l.id === id);
  if (index >= 0) return { list: layers, index, parentId };
  for (const l of layers) {
    if (l.type === "group") {
      const r = locate(l.children, id, l.id);
      if (r) return r;
    }
  }
  return null;
}

/** Copy of `layers` with `fn` applied to the list whose parent is `parentId` (null = top level). */
function editList(layers, parentId, fn) {
  if (parentId === null) return fn(layers);
  return layers.map((l) => (l.type !== "group" ? l : l.id === parentId ? { ...l, children: fn(l.children) } : { ...l, children: editList(l.children, parentId, fn) }));
}

export function mapLayer(layers, id, fn) {
  return layers.map((l) => (l.id === id ? fn(l) : l.type === "group" ? { ...l, children: mapLayer(l.children, id, fn) } : l));
}

export function removeLayer(layers, id) {
  return layers.filter((l) => l.id !== id).map((l) => (l.type === "group" ? { ...l, children: removeLayer(l.children, id) } : l));
}

/** Insert `layer` into the list of `parentId` at `index` (clamped). */
export function insertLayer(layers, layer, parentId, index) {
  return editList(layers, parentId, (list) => {
    const i = Math.max(0, Math.min(list.length, index));
    return [...list.slice(0, i), layer, ...list.slice(i)];
  });
}

/** Move a layer into the list of `parentId` before position `index` of that list (as it was before the move). */
export function moveLayer(layers, id, parentId, index) {
  const from = locate(layers, id);
  if (!from) return layers;
  const layer = from.list[from.index];
  if (parentId !== null && (parentId === id || (layer.type === "group" && findLayer(layer.children, parentId)))) return layers;
  if (from.parentId === parentId && from.index < index) index--;
  return insertLayer(removeLayer(layers, id), layer, parentId, index);
}

/** A copy of `layer` (from any garment) made valid for `garment`, with fresh ids: for pasting. */
export function adaptLayer(layer, garment, assets) {
  const fresh = (l) => ({ ...l, id: newId(), role: undefined, children: l.children?.map(fresh) });
  return sanitizeLayer(fresh(structuredClone(layer)), garment, assets, new Set(), { left: MAX_LAYERS }, 0);
}

/** A deep copy with fresh ids. */
export function cloneLayer(layer) {
  const copy = { ...structuredClone(layer), id: newId() };
  delete copy.role; // shortcuts keep pointing at the original
  if (copy.type === "group") copy.children = copy.children.map(cloneLayer);
  return copy;
}

/** Garment-level edit: returns a project with garment `g`'s layers replaced by fn(layers). */
export function editLayers(project, g, fn) {
  return { ...project, garments: { ...project.garments, [g]: { layers: fn(project.garments[g].layers) } } };
}

/** Fonts the project's text layers use. */
export function fontsInUse(project) {
  const fonts = new Set([project.font]);
  for (const g of GARMENTS) walk(project.garments[g].layers, (l) => l.type === "text" && l.font && fonts.add(l.font));
  return [...fonts];
}
