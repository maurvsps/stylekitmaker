import { fontCss } from "./design.js";
import { baseDesign, graphic, material, paintPattern as paintPatternColors, pattern as patternDef, region } from "./library.js";
import { hasFinish, resolveColor } from "./project.js";

// The layer compositor: paints one garment's texture from its ordered layers (project.js) and its UV template
// (public/models/<name>.json, written by blender/make_kit.py). Plain canvas code, no React.
//
//   garment layers (bottom to top) -> per layer: island + mask clip, transform, paint -> opacity / blend -> canvas
//
// Every UV island has a local frame in metres (p right, q up, as seen from outside) and a rectangle on the
// texture. Layers paint island by island, clipped to the island plus a few pixels of bleed so seams never show,
// and to the layer's mask (and its groups' masks): regions it is limited to, and regions it is hidden on.
// A layer with opacity < 1 or a blend mode (and a group with either) is painted on a scratch canvas first and
// composited as one piece; everything else paints straight onto the texture.

const PAD = 6; // pixels painted beyond each island

/**
 * Paint `garment`'s texture onto `canvas`.
 * `images` maps asset ids to decoded images (image layers whose image has not loaded yet paint nothing).
 */
export function drawGarment(canvas, garment, template, project, images = {}) {
  const ctx = canvas.getContext("2d");
  const env = makeEnv(canvas, garment, template, project, images);
  const S = env.S;
  reset(ctx);
  ctx.fillStyle = "#ffffff"; // fabric without any layer
  ctx.fillRect(0, 0, S, S);
  drawLayers(ctx, project.garments[garment].layers, env, 0);
}

function makeEnv(canvas, garment, template, project, images) {
  const S = canvas.width; // islands are placed in fractions of the width on both axes (the collar canvas is wide)
  const islands = Object.entries(template.islands).map(([name, isl]) => ({ name, kind: isl.kind, isl, frame: islandFrame(isl, S) }));
  return {
    garment, S, H: canvas.height, islands, project, images,
    byName: Object.fromEntries(islands.map((i) => [i.name, i])),
    color: (c) => resolveColor(c, project.palette),
    masks: [], // masks of the groups being painted
  };
}

/**
 * The collar alone, scaled to fill a canvas `width` wide: the collar island is only a few dozen pixels tall on the
 * garment texture, so the 3D view gives the collar mesh its own texture painted from this template.
 * Returns { template, height, repeat: [x, y], offset: [x, y] } (the texture transform from mesh UVs to this canvas).
 */
export function collarTemplate(template, width) {
  const isl = template.islands.collar;
  if (!isl) return null;
  const pad = 8 / width; // keeps the bleed
  const k = (1 - 2 * pad) / isl.rect[2];
  const h = isl.rect[3] * k;
  const height = Math.ceil((h + 2 * pad) * width);
  const yScale = width / height; // canvas y fractions per width fraction
  return {
    template: { ...template, islands: { collar: { ...isl, rect: [pad, pad, 1 - 2 * pad, h], scale: isl.scale * k } } },
    height,
    repeat: [k, k * yScale],
    offset: [pad - isl.rect[0] * k, (pad - isl.rect[1] * k) * yScale],
  };
}

function reset(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawLayers(ctx, layers, env, depth) {
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const isolated = layer.opacity < 1 || layer.blend !== "normal";
    if (!isolated) {
      paintLayer(ctx, layer, env, depth);
      continue;
    }
    const scratch = scratchCanvas(env, depth);
    const sctx = scratch.getContext("2d");
    reset(sctx);
    sctx.clearRect(0, 0, env.S, env.S);
    paintLayer(sctx, layer, env, depth + 1);
    ctx.save();
    reset(ctx);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blend === "normal" ? "source-over" : layer.blend;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
}

// One scratch canvas per nesting depth and size, kept between repaints.
const scratchPool = new Map();
function scratchCanvas(env, depth) {
  const key = `${env.S}x${env.H}:${depth}`;
  let c = scratchPool.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = env.S;
    c.height = env.H;
    scratchPool.set(key, c);
  }
  return c;
}

function paintLayer(ctx, layer, env, depth) {
  switch (layer.type) {
    case "group":
      env.masks.push(layer.mask);
      drawLayers(ctx, layer.children, env, depth);
      env.masks.pop();
      return;
    case "base":
      return paintBase(ctx, layer, env);
    case "pattern":
      return paintPattern(ctx, layer, env);
    case "text":
    case "image":
    case "graphic":
      return paintPlaced(ctx, layer, env);
    default:
      // material effects only change the material (later); they paint nothing on the colour texture
  }
}

/**
 * Run `paint` once per island that `accept(island)` takes (all when null) and the masks leave visible, clipped to
 * the island and its bleed and to the masks.
 */
function eachIsland(ctx, env, layer, accept, paint) {
  const masks = [...env.masks, layer.mask].filter(active);
  for (const island of env.islands) {
    if (accept && !accept(island)) continue;
    const { frame } = island;
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x - PAD, frame.y - PAD, frame.w + 2 * PAD, frame.h + 2 * PAD);
    ctx.clip();
    if (masks.every((m) => clipMask(ctx, env, island, m))) paint(island);
    ctx.restore();
  }
}

const active = (m) => m && (m.include || m.exclude.length);

/** Clip to what mask `m` leaves of `island`; false when it leaves nothing. */
function clipMask(ctx, env, island, m) {
  const { name, isl, frame } = island;
  const parts = (id) => region(env.garment, id)?.parts || {};
  if (m.include) {
    const shapes = m.include.map((id) => parts(id)).filter((p) => name in p).map((p) => p[name]);
    if (!shapes.length) return false;
    if (!shapes.includes(null)) {
      frame.local(ctx);
      ctx.beginPath();
      for (const shape of shapes) for (const r of shape(isl, frame)) addRect(ctx, r);
      ctx.clip();
    }
  }
  for (const id of m.exclude) {
    const p = parts(id);
    if (!(name in p)) continue;
    if (p[name] === null) return false;
    frame.local(ctx);
    ctx.beginPath();
    addRect(ctx, [frame.p0 - 1, frame.q0 - 1, frame.p1 + 1, frame.q1 + 1]);
    for (const r of p[name](isl, frame)) addRect(ctx, r);
    ctx.clip("evenodd");
  }
  return true;
}

function addRect(ctx, [a, b, c, d]) {
  ctx.rect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
}

function islandFrame(isl, S) {
  const [x, y, w, h] = isl.rect.map((v) => v * S);
  const s = isl.scale * S; // pixels per metre
  const bleed = PAD / s;
  return {
    x, y, w, h, s,
    // local bounds in metres, with the bleed
    p0: isl.pmin - bleed, p1: isl.pmin + w / s + bleed,
    q0: isl.qmax - h / s - bleed, q1: isl.qmax + bleed,
    toPx: (p, q) => [x + s * (p - isl.pmin), y + s * (isl.qmax - q)],
    /** Draw in local metres (p, q). */
    local(ctx) {
      ctx.setTransform(s, 0, 0, -s, x - s * isl.pmin, y + s * isl.qmax);
    },
  };
}

// ---------------------------------------------------------------- base design

function paintBase(ctx, layer, env) {
  const design = baseDesign(env.garment, layer.design);
  const colors = Object.fromEntries(design.slots.map(([k, , def]) => [k, env.color(layer.colors[k] ?? def)]));
  if (design.ground && !env.masks.some(active) && !active(layer.mask)) {
    ctx.save();
    reset(ctx);
    ctx.fillStyle = colors[design.ground]; // the texture outside the islands, so mipmaps never bleed white
    ctx.fillRect(0, 0, env.S, env.S);
    ctx.restore();
  }
  eachIsland(ctx, env, layer, null, (island) => design.paint(ctx, island, colors));
}

// ---------------------------------------------------------------- patterns

function paintPattern(ctx, layer, env) {
  const p = patternDef(layer.pattern);
  const colors = layer.colors.map((c) => c && env.color(c));
  const t = layer.transform;
  // How far the pattern must reach in its own (moved, scaled) space to cover every island.
  const reach = (1.5 + Math.hypot(t.x, t.y)) / Math.max(0.05, Math.min(Math.abs(t.scaleX), Math.abs(t.scaleY)));
  // Unless its mask names regions to show on, a pattern covers the panels, sleeves and socks, not the bands.
  const accept = layer.mask?.include ? null : ({ kind }) => kind === "body" || kind === "sleeve" || kind === "sock";
  eachIsland(ctx, env, layer, accept, (island) => {
    const { name, kind, frame } = island;
    frame.local(ctx);
    // Pattern space: body coordinates on panels (the back's frame runs the other way), distance down the tube on
    // sleeves and socks, the island's own frame on bands.
    if (kind === "body") {
      if (name === "back") ctx.scale(-1, 1);
    } else if (kind === "sleeve" || kind === "sock") {
      ctx.scale(1, -1);
    }
    applyTransform(ctx, t);
    paintPatternColors(ctx, p, colors, { ...island, reach });
  });
}

function applyTransform(ctx, t) {
  if (t.x || t.y) ctx.translate(t.x, t.y);
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
  const sx = t.scaleX * (t.flipX ? -1 : 1);
  const sy = t.scaleY * (t.flipY ? -1 : 1);
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
}

// ---------------------------------------------------------------- placed layers (text, image, graphic)

function paintPlaced(ctx, layer, env) {
  const island = env.byName[layer.surface];
  if (!island) return;
  eachIsland(ctx, env, layer, (i) => i.name === layer.surface, ({ frame }) => {
    const t = layer.transform;
    // Work in pixels centred on the layer's position, y down (canvas text and images expect that).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const [cx, cy] = frame.toPx(t.x, t.y);
    const turned = t.rotation || t.flipX || t.flipY;
    if (turned) {
      ctx.translate(cx, cy);
      ctx.rotate((-t.rotation * Math.PI) / 180); // positive = counter-clockwise, as seen from outside
      ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
    }
    const [ox, oy] = turned ? [0, 0] : [cx, cy];
    if (layer.type === "text") placeText(ctx, layer, env, frame, ox, oy);
    else if (layer.type === "image") placeImage(ctx, layer, env, frame, ox, oy);
    else placeGraphic(ctx, layer, env, frame, ox, oy);
  });
}

function placeText(ctx, layer, env, frame, x, y) {
  const { player, font } = env.project;
  const str = layer.bind ? player[layer.bind] : layer.text;
  if (!str) return;
  const t = layer.transform;
  const fontId = layer.font || font;
  let px = layer.size * t.scaleY * frame.s * 1.35; // font size so the capitals are about `size` tall
  ctx.font = fontCss(fontId, px);
  const stretch = t.scaleX / t.scaleY;
  const maxWidth = layer.maxWidth * t.scaleX * frame.s;
  const width = ctx.measureText(str).width * stretch;
  if (width > maxWidth) {
    px *= maxWidth / width;
    ctx.font = fontCss(fontId, px);
  }
  if (stretch !== 1) {
    ctx.translate(x, y);
    ctx.scale(stretch, 1);
    x = y = 0;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  if (layer.outline) {
    ctx.lineWidth = Math.max(2, px * 0.06);
    ctx.strokeStyle = "rgba(0,0,0,.28)";
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = env.color(layer.color);
  ctx.fillText(str, x, y);
}

function placeImage(ctx, layer, env, frame, x, y) {
  const image = env.images[layer.asset];
  if (!image) return;
  const t = layer.transform;
  const iw = image.naturalWidth || image.width || 1;
  const ih = image.naturalHeight || image.height || 1;
  const k = layer.size / Math.max(iw, ih); // metres per image pixel
  const w = iw * k * t.scaleX * frame.s;
  const h = ih * k * t.scaleY * frame.s;
  ctx.drawImage(layer.tint ? tinted(image, env.color(layer.tint)) : image, x - w / 2, y - h / 2, w, h);
}

// One-colour versions of logos (a white brand mark, a sponsor in the trim colour), kept per image and colour.
const tints = new WeakMap();
function tinted(image, color) {
  let byColor = tints.get(image);
  if (!byColor) tints.set(image, (byColor = new Map()));
  let c = byColor.get(color);
  if (!c) {
    c = document.createElement("canvas");
    c.width = image.naturalWidth || image.width || 1;
    c.height = image.naturalHeight || image.height || 1;
    const g = c.getContext("2d");
    g.drawImage(image, 0, 0, c.width, c.height);
    g.globalCompositeOperation = "source-in"; // keep the logo's shape (alpha), replace its colours
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    byColor.set(color, c);
  }
  return c;
}

function placeGraphic(ctx, layer, env, frame, x, y) {
  const t = layer.transform;
  ctx.translate(x, y);
  ctx.scale(frame.s, -frame.s); // metres, y up
  ctx.fillStyle = env.color(layer.color);
  graphic(layer.shape).paint(ctx, layer.size * t.scaleX, layer.size * t.scaleY);
}

// ---------------------------------------------------------------- material maps (PBR)
//
// Two more canvases per garment, painted only when some layer has a finish or is a material effect:
//   height: grey, 128 = the fabric's surface; raised prints are lighter, pressed ones darker. KitRenderer turns it
//           into a normal map (heightToNormal).
//   orm:    glTF occlusion / roughness / metalness: G = roughness (fabric 0.8), B = metalness (0).
// A layer's shape is its painted alpha: the layer is painted on a scratch canvas exactly as on the colour texture
// (islands, masks, transform), then filled with its grey / roughness / metalness and laid onto the maps.

export const FABRIC_ROUGHNESS = 0.8;
const FLAT = 128;

export function drawMaterial(height, orm, garment, template, project, images = {}) {
  const env = makeEnv(height, garment, template, project, images);
  const h = height.getContext("2d");
  const o = orm.getContext("2d");
  for (const ctx of [h, o]) reset(ctx);
  h.fillStyle = grey(FLAT);
  h.fillRect(0, 0, env.S, env.S);
  o.fillStyle = ormColor(FABRIC_ROUGHNESS, 0);
  o.fillRect(0, 0, env.S, env.S);
  finishLayers(h, o, project.garments[garment].layers, env, 1);
}

function finishLayers(h, o, layers, env, alpha) {
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const a = alpha * layer.opacity;
    if (layer.type === "material") {
      materialEffect(h, o, layer, env, a);
      continue;
    }
    if (hasFinish(layer)) finishLayer(h, o, layer, env, a);
    if (layer.type === "group") {
      env.masks.push(layer.mask);
      finishLayers(h, o, layer.children, env, a);
      env.masks.pop();
    }
  }
}

function finishLayer(h, o, layer, env, alpha) {
  const f = layer.finish;
  const scratch = scratchCanvas(env, 90);
  const sctx = scratch.getContext("2d");
  const silhouette = () => {
    reset(sctx);
    sctx.clearRect(0, 0, env.S, env.S);
    if (layer.type === "group") {
      env.masks.push(layer.mask);
      drawLayers(sctx, layer.children, env, 91);
      env.masks.pop();
    } else {
      paintLayer(sctx, layer, env, 91);
    }
    reset(sctx);
    sctx.globalCompositeOperation = "source-in";
  };
  const lay = (ctx) => {
    ctx.save();
    reset(ctx);
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  };
  if (layer.texture === "smooth") {
    silhouette();
    sctx.fillStyle = ormColor(f.roughness ?? FABRIC_ROUGHNESS, f.metalness ?? 0, 0);
    sctx.fillRect(0, 0, env.S, env.S);
    lay(o);
  }
  if (f.relief || f.stitch) {
    silhouette();
    const g = FLAT + Math.round((f.relief || (f.stitch ? 0.35 : 0)) * 110);
    sctx.fillStyle = f.stitch ? stitchPattern(sctx, env.S, g) : grey(g);
    sctx.fillRect(0, 0, env.S, env.S);
    lay(h);
  }
  if (f.roughness !== null || f.metalness !== null || f.stitch) {
    silhouette();
    sctx.fillStyle = ormColor(f.roughness ?? (f.stitch ? 0.6 : FABRIC_ROUGHNESS), f.metalness ?? 0, layer.texture === "smooth" ? 0 : 255);
    sctx.fillRect(0, 0, env.S, env.S);
    lay(o);
  }
}

function materialEffect(h, o, layer, env, alpha) {
  const m = material(layer.effect);
  const all = () => true; // every island the mask leaves, bands included
  o.save();
  o.globalAlpha = alpha;
  eachIsland(o, env, layer, all, ({ frame }) => {
    reset(o);
    o.globalAlpha = alpha;
    o.fillStyle = ormColor(m.roughness, m.metalness);
    o.fillRect(frame.x - PAD, frame.y - PAD, frame.w + 2 * PAD, frame.h + 2 * PAD);
  });
  o.restore();
  if (!m.relief) return;
  h.save();
  h.globalAlpha = alpha;
  eachIsland(h, env, layer, all, ({ frame }) => {
    frame.local(h);
    m.relief(h, frame, grey(FLAT - 70), grey(FLAT + 70));
  });
  h.restore();
}

const grey = (v) => `rgb(${v},${v},${v})`;
const ormColor = (r, m, knit = 255) => `rgb(${knit},${Math.round(r * 255)},${Math.round(m * 255)})`;

// Embroidery: rows of slanted stitches, about 1.5 mm apart on a 2048 texture.
const stitches = new Map();
function stitchPattern(ctx, S, g) {
  const n = Math.max(4, Math.round(S / 400));
  const key = `${n}:${g}`;
  if (!stitches.has(key)) {
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const x = c.getContext("2d");
    x.fillStyle = grey(Math.max(0, g - 40));
    x.fillRect(0, 0, n, n);
    x.strokeStyle = grey(Math.min(255, g + 25));
    x.lineWidth = n * 0.45;
    x.beginPath();
    for (const d of [-n, 0, n]) {
      x.moveTo(d, n);
      x.lineTo(d + n, 0);
    }
    x.stroke();
    stitches.set(key, c);
  }
  return ctx.createPattern(stitches.get(key), "repeat");
}

/**
 * Turn a height canvas into a tangent-space normal map on `out` (same size). x follows texture u, y texture v
 * (the canvas is not flipped: its rows run down v). The heights are softened first so raised edges read as a bevel.
 */
export function heightToNormal(height, out, strength = 1) {
  const S = height.width;
  const src = height.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  let a = new Float32Array(S * S);
  for (let i = 0; i < a.length; i++) a[i] = src[i * 4] / 255;
  const r = Math.max(1, Math.round(S / 1024));
  a = boxBlur(a, S, r);
  const k = strength * (S / 1024) * 1.6; // the slope a full step makes, independent of the resolution
  const img = out.getContext("2d").createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < S - 1 ? y + 1 : y;
    for (let x = 0; x < S; x++) {
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < S - 1 ? x + 1 : x;
      const dx = (a[y * S + x1] - a[y * S + x0]) * k;
      const dy = (a[y1 * S + x] - a[y0 * S + x]) * k;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      d[i] = 128 + 127 * -dx * inv;
      d[i + 1] = 128 + 127 * -dy * inv;
      d[i + 2] = 128 + 127 * inv;
      d[i + 3] = 255;
    }
  }
  out.getContext("2d").putImageData(img, 0, 0);
}

function boxBlur(a, S, r) {
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const n = 2 * r + 1;
  for (let y = 0; y < S; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * S + Math.min(S - 1, Math.max(0, x))];
    for (let x = 0; x < S; x++) {
      tmp[y * S + x] = sum / n;
      sum += a[y * S + Math.min(S - 1, x + r + 1)] - a[y * S + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < S; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(S - 1, Math.max(0, y)) * S + x];
    for (let y = 0; y < S; y++) {
      out[y * S + x] = sum / n;
      sum += tmp[Math.min(S - 1, y + r + 1) * S + x] - tmp[Math.max(0, y - r) * S + x];
    }
  }
  return out;
}
