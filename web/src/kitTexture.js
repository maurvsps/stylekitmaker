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
    const fx = layer.finish?.fx;
    const isolated = layer.opacity < 1 || layer.blend !== "normal" || !!fx;
    if (!isolated) {
      paintLayer(ctx, layer, env, depth);
      continue;
    }
    const scratch = scratchCanvas(env, depth);
    const sctx = scratch.getContext("2d");
    reset(sctx);
    sctx.clearRect(0, 0, env.S, env.S);
    paintLayer(sctx, layer, env, depth + 1);
    if (fx) applyFx(sctx, fx, env, depth);
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
    case "image":
      if (layer.fit === "texture") return paintTexture(ctx, layer, env);
      if (layer.fit === "tile") return paintTile(ctx, layer, env);
      return paintPlaced(ctx, layer, env);
    case "text":
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
  eachIsland(ctx, env, layer, null, (island) => design.paint(ctx, island, colors, env));
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

/** An image stretched over the whole texture (made on the UV layout), clipped to each island and the layer's masks. */
function paintTexture(ctx, layer, env) {
  const image = env.images[layer.asset];
  if (!image) return;
  if (env.islands.length === 1 && env.islands[0].name === "collar") return; // the collar's own canvas is not the atlas
  eachIsland(ctx, env, layer, null, () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(image, 0, 0, env.S, env.H);
  });
}

/**
 * An image repeated over the garment like a pattern: tiles of `size` metres (the longer side) with `tile.gap` between
 * them, optionally every other row shifted by half a tile. Drawn upright on every panel, moved, scaled and turned by
 * the layer's transform, and kept off the bands unless the mask names regions.
 */
const MAX_TILES = 3000;
function paintTile(ctx, layer, env) {
  const image = env.images[layer.asset];
  if (!image) return;
  const t = layer.transform;
  const iw = image.naturalWidth || image.width || 1;
  const ih = image.naturalHeight || image.height || 1;
  const k = layer.size / Math.max(iw, ih); // metres per image pixel
  const w = iw * k, h = ih * k;
  const gap = layer.tile?.gap ?? 0.03;
  const stepX = w + gap, stepY = h + gap;
  const reach = (1.5 + Math.hypot(t.x, t.y)) / Math.max(0.05, Math.min(Math.abs(t.scaleX), Math.abs(t.scaleY)));
  const nx = Math.ceil(reach / stepX) + 1, ny = Math.ceil(reach / stepY) + 1;
  if ((2 * nx + 1) * (2 * ny + 1) > MAX_TILES) return; // too small to read: skip rather than freeze
  const src = layer.tint ? tinted(image, env.color(layer.tint)) : image;
  const accept = layer.mask?.include ? null : ({ kind }) => kind === "body" || kind === "sleeve" || kind === "sock";
  eachIsland(ctx, env, layer, accept, ({ frame }) => {
    frame.local(ctx); // metres, y up
    applyTransform(ctx, t);
    ctx.scale(1, -1); // images are drawn y down
    for (let j = -ny; j <= ny; j++) {
      const shift = layer.tile?.stagger && j % 2 ? stepX / 2 : 0;
      for (let i = -nx; i <= nx; i++) ctx.drawImage(src, i * stepX + shift - w / 2, -(j * stepY) - h / 2, w, h);
    }
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
  const src = layer.tint ? tinted(image, env.color(layer.tint)) : image;
  const stroke = layer.stroke;
  if (stroke && stroke.width > 0) {
    const r = Math.min(MAX_STROKE_PX, stroke.width / k); // stroke radius in image pixels
    const framed = outlined(src, image, env.color(stroke.color), r);
    const s = w / iw; // canvas pixels per image pixel
    ctx.drawImage(framed.canvas, x - w / 2 - framed.pad * s, y - h / 2 - framed.pad * s, framed.canvas.width * s, framed.canvas.height * s);
    return;
  }
  ctx.drawImage(src, x - w / 2, y - h / 2, w, h);
}

// A border around a logo's shape: its silhouette in the stroke colour stamped around a circle, the logo on top.
// Kept per image, stroke colour and radius, on a canvas padded by the radius.
const MAX_STROKE_PX = 90;
const strokes = new WeakMap();
function outlined(src, image, color, r) {
  let byKey = strokes.get(src);
  if (!byKey) strokes.set(src, (byKey = new Map()));
  const key = `${color}|${r.toFixed(1)}`;
  let hit = byKey.get(key);
  if (!hit) {
    const pad = Math.ceil(r) + 1;
    const iw = image.naturalWidth || image.width || 1;
    const ih = image.naturalHeight || image.height || 1;
    const canvas = document.createElement("canvas");
    canvas.width = iw + pad * 2;
    canvas.height = ih + pad * 2;
    const g = canvas.getContext("2d");
    const silhouette = tinted(image, color);
    for (const ring of [r, r * 0.5]) {
      const steps = Math.max(16, Math.ceil(ring * 1.5));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        g.drawImage(silhouette, pad + Math.cos(a) * ring, pad + Math.sin(a) * ring, iw, ih);
      }
    }
    g.drawImage(src, pad, pad, iw, ih);
    byKey.set(key, (hit = { canvas, pad }));
  }
  return hit;
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
  const hasCustomOrm = f.roughness !== null || f.metalness !== null || f.stitch;
  if (layer.texture === "smooth" && !hasCustomOrm) {
    silhouette();
    sctx.fillStyle = ormColor(f.roughness ?? FABRIC_ROUGHNESS, f.metalness ?? 0, 0);
    sctx.fillRect(0, 0, env.S, env.S);
    lay(o);
  }
  if (f.relief || f.stitch || f.grain) {
    silhouette();
    const g = FLAT + Math.round((f.relief || (f.stitch ? 0.35 : 0)) * 110);
    sctx.fillStyle = f.stitch ? stitchPattern(sctx, env.S, g) : grey(g);
    sctx.fillRect(0, 0, env.S, env.S);
    if (f.grain) {
      sctx.globalCompositeOperation = "source-atop"; // the surface texture, only where the layer is
      sctx.fillStyle = grainPattern(sctx, f.grain, env.S);
      sctx.fillRect(0, 0, env.S, env.S);
    }
    lay(h);
  }
  if (hasCustomOrm) {
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

// ---------------------------------------------------------------- surface textures (relief map) and colour effects
//
// A grain is a small tile of white (raised) and black (pressed in) with some transparency, laid over the layer's grey in
// the relief map. Tile sizes are in material-map pixels and grow a little with the map.

const grains = new Map();
function grainPattern(ctx, id, S) {
  const u = Math.max(1, Math.round(S / 512)); // 1 on a 512 map
  const key = `${id}:${u}`;
  if (!grains.has(key)) {
    const make = (w, h, draw) => {
      const c = document.createElement("canvas");
      c.width = w * u;
      c.height = h * u;
      const g = c.getContext("2d");
      g.scale(u, u);
      draw(g, w, h);
      return c;
    };
    const rnd = seeded(11);
    const white = (a) => `rgba(255,255,255,${a})`;
    const black = (a) => `rgba(0,0,0,${a})`;
    const specks = (g, w, h, n, max) => {
      for (let i = 0; i < n; i++) {
        g.fillStyle = rnd() < 0.5 ? white(0.15 + rnd() * 0.5) : black(0.15 + rnd() * 0.5);
        g.beginPath();
        g.arc(rnd() * w, rnd() * h, 0.4 + rnd() * max, 0, 2 * Math.PI);
        g.fill();
      }
    };
    const tiles = {
      carbon: () => make(16, 16, (g) => {
        g.fillStyle = black(0.3);
        g.fillRect(0, 0, 16, 16);
        for (const [x, y, horizontal] of [[0, 0, 1], [8, 8, 1], [8, 0, 0], [0, 8, 0]]) {
          g.fillStyle = white(0.4);
          for (let i = 0; i < 4; i++) horizontal ? g.fillRect(x, y + i * 2, 8, 1) : g.fillRect(x + i * 2, y, 1, 8);
        }
      }),
      mesh: () => make(10, 10, (g) => {
        g.fillStyle = black(0.85);
        g.beginPath();
        g.arc(5, 5, 3, 0, 2 * Math.PI);
        g.fill();
      }),
      leather: () => make(64, 64, (g, w, h) => specks(g, w, h, 260, 2.2)),
      velvet: () => make(32, 32, (g, w, h) => specks(g, w, h, 420, 0.7)),
      glitter: () => make(96, 96, (g, w, h) => {
        for (let i = 0; i < 90; i++) {
          g.fillStyle = rnd() < 0.5 ? white(0.9) : black(0.8);
          g.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), 1 + (rnd() < 0.3), 1 + (rnd() < 0.3));
        }
      }),
      brushed: () => make(64, 32, (g, w, h) => {
        for (let i = 0; i < 70; i++) {
          g.fillStyle = rnd() < 0.5 ? white(0.1 + rnd() * 0.2) : black(0.1 + rnd() * 0.2);
          const len = 16 + rnd() * 48;
          const y = Math.floor(rnd() * h);
          const x = rnd() * w;
          g.fillRect(x, y, len, 1);
          g.fillRect(x - w, y, len, 1); // wraps round the tile edge
        }
      }),
      hex: () => make(30, 35, (g, w, h) => {
        const r = 10;
        g.strokeStyle = white(0.7);
        g.lineWidth = 2;
        g.fillStyle = black(0.12);
        g.fillRect(0, 0, w, h);
        for (const [cx, cy] of [[0, 0], [0, h], [3 * r, 0], [3 * r, h], [1.5 * r, h / 2]]) {
          g.beginPath();
          for (let i = 0; i <= 6; i++) {
            const t = (i * Math.PI) / 3;
            i ? g.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t)) : g.moveTo(cx + r, cy);
          }
          g.stroke();
        }
      }),
      quilt: () => make(40, 40, (g) => {
        g.fillStyle = black(0.5);
        g.fillRect(0, 0, 40, 40);
        const lit = g.createRadialGradient(20, 20, 1, 20, 20, 20);
        lit.addColorStop(0, white(0.65));
        lit.addColorStop(1, white(0.05));
        g.fillStyle = lit;
        g.beginPath();
        g.moveTo(20, 2); g.lineTo(38, 20); g.lineTo(20, 38); g.lineTo(2, 20);
        g.closePath();
        g.fill();
      }),
      chrome: () => make(32, 128, (g, w, h) => {
        const bands = g.createLinearGradient(0, 0, 0, h);
        for (let i = 0; i <= 8; i++) bands.addColorStop(i / 8, i % 2 ? white(0.55) : black(0.5));
        g.fillStyle = bands;
        g.fillRect(0, 0, w, h);
      }),
      prism: () => make(12, 12, (g) => {
        const tri = (pts, fill) => {
          g.fillStyle = fill;
          g.beginPath();
          g.moveTo(...pts[0]); g.lineTo(...pts[1]); g.lineTo(...pts[2]);
          g.closePath();
          g.fill();
        };
        tri([[0, 0], [12, 0], [6, 6]], white(0.4));
        tri([[12, 0], [12, 12], [6, 6]], black(0.3));
        tri([[12, 12], [0, 12], [6, 6]], black(0.45));
        tri([[0, 12], [0, 0], [6, 6]], white(0.15));
      }),
    };
    grains.set(key, ctx.createPattern((tiles[id] || tiles.leather)(), "repeat"));
  }
  return grains.get(key);
}

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// Colour effects. `sctx` holds the layer as painted; each effect recolours it, cuts it, or fades it, inside its shape.
const RAINBOW = ["#ff4fd8", "#4ff0ff", "#b6ff4f", "#ffb34f", "#9b6bff", "#ff4fd8"];

function applyFx(sctx, fx, env, depth) {
  const { S, H } = env;
  const overlay = (paint, mode, alpha) => {
    const fxc = scratchCanvas(env, depth + 40);
    const g = fxc.getContext("2d");
    reset(g);
    g.clearRect(0, 0, S, H);
    paint(g);
    g.globalCompositeOperation = "destination-in"; // keep the effect only where the layer is
    g.drawImage(sctx.canvas, 0, 0);
    sctx.save();
    reset(sctx);
    sctx.globalAlpha = alpha;
    sctx.globalCompositeOperation = mode;
    sctx.drawImage(fxc, 0, 0);
    sctx.restore();
  };
  const rainbow = (g, x0, y0, x1, y1) => {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    RAINBOW.forEach((c, i) => grad.addColorStop(i / (RAINBOW.length - 1), c));
    return grad;
  };
  const specks = (g, count, size) => {
    const rnd = seeded(5);
    const colors = ["#ffffff", "#fff2c2", "#d6ecff", "#ffd1f0"];
    for (let i = 0; i < count; i++) {
      g.globalAlpha = 0.45 + rnd() * 0.55;
      g.fillStyle = colors[Math.floor(rnd() * colors.length)];
      const s = size * (0.6 + rnd() * 1.6);
      g.fillRect(rnd() * S, rnd() * H, s, s);
    }
    g.globalAlpha = 1;
  };
  const u = S / 2048;

  if (fx === "iridescent") {
    // An oil-slick sheen sweeping across the layer: hue and saturation from a rainbow, the layer's own light and dark kept.
    overlay((g) => { g.fillStyle = rainbow(g, 0, 0, S, H); g.fillRect(0, 0, S, H); }, "color", 0.8);
    overlay((g) => { g.fillStyle = rainbow(g, S, 0, 0, H); g.fillRect(0, 0, S, H); }, "overlay", 0.35);
  } else if (fx === "holo") {
    const tile = document.createElement("canvas");
    tile.width = tile.height = Math.max(32, Math.round(110 * u));
    const t = tile.getContext("2d");
    t.fillStyle = rainbow(t, 0, 0, tile.width, 0);
    t.fillRect(0, 0, tile.width, tile.height);
    overlay((g) => {
      const pattern = g.createPattern(tile, "repeat");
      pattern.setTransform(new DOMMatrix().rotate(28));
      g.fillStyle = pattern;
      g.fillRect(0, 0, S, H);
    }, "color", 0.85);
    overlay((g) => specks(g, Math.round((S * H) / 2600), Math.max(1, 2 * u)), "screen", 0.8);
  } else if (fx === "glitter") {
    overlay((g) => specks(g, Math.round((S * H) / 500), Math.max(1.5, 3 * u)), "source-over", 1);
  } else if (fx === "perforated") {
    const step = Math.max(6, Math.round(14 * u));
    const tile = document.createElement("canvas");
    tile.width = tile.height = step;
    const t = tile.getContext("2d");
    t.fillStyle = "#000";
    for (const [x, y] of [[0.25, 0.25], [0.75, 0.75]]) {
      t.beginPath();
      t.arc(x * step, y * step, step * 0.17, 0, 2 * Math.PI);
      t.fill();
    }
    sctx.save();
    reset(sctx);
    sctx.globalCompositeOperation = "destination-out"; // punch the holes through the layer
    sctx.fillStyle = sctx.createPattern(tile, "repeat");
    sctx.fillRect(0, 0, S, H);
    sctx.restore();
  } else if (fx === "fade") {
    sctx.save();
    reset(sctx);
    sctx.globalCompositeOperation = "destination-out"; // opaque at the top of each panel, gone at the bottom
    for (const { frame } of env.islands) {
      const grad = sctx.createLinearGradient(0, frame.y, 0, frame.y + frame.h);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.35, "rgba(0,0,0,0)");
      grad.addColorStop(1, "rgba(0,0,0,1)");
      sctx.fillStyle = grad;
      sctx.fillRect(frame.x - PAD, frame.y - PAD, frame.w + 2 * PAD, frame.h + 2 * PAD);
    }
    sctx.restore();
  }
}

// Typed array buffer pooling to avoid megabytes of garbage collection on every render
let poolA = null;
let poolTmp = null;
let poolBlurred = null;

function getBlurBuffers(len) {
  if (!poolA || poolA.length < len) {
    poolA = new Float32Array(len);
    poolTmp = new Float32Array(len);
    poolBlurred = new Float32Array(len);
  }
  return [poolA, poolTmp, poolBlurred];
}

/**
 * Turn a height canvas into a tangent-space normal map on `out` (same size). x follows texture u, y texture v
 * (the canvas is not flipped: its rows run down v). The heights are softened first so raised edges read as a bevel.
 */
export function heightToNormal(height, out, strength = 1) {
  const S = height.width;
  const len = S * S;
  const [a, tmp, blurred] = getBlurBuffers(len);
  const src = height.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  for (let i = 0; i < len; i++) a[i] = src[i * 4] / 255;
  const r = Math.max(1, Math.round(S / 1024));
  boxBlur(a, S, r, tmp, blurred);
  const k = strength * (S / 1024) * 1.6; // the slope a full step makes, independent of the resolution
  const outCtx = out.getContext("2d");
  const img = outCtx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    const y0 = (y > 0 ? y - 1 : y) * S;
    const y1 = (y < S - 1 ? y + 1 : y) * S;
    const yRow = y * S;
    for (let x = 0; x < S; x++) {
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < S - 1 ? x + 1 : x;
      const dx = (blurred[yRow + x1] - blurred[yRow + x0]) * k;
      const dy = (blurred[y1 + x] - blurred[y0 + x]) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yRow + x) * 4;
      d[i] = (128 - 127 * dx * inv) | 0;
      d[i + 1] = (128 - 127 * dy * inv) | 0;
      d[i + 2] = (128 + 127 * inv) | 0;
      d[i + 3] = 255;
    }
  }
  outCtx.putImageData(img, 0, 0);
}

function boxBlur(a, S, r, tmp, out) {
  const n = 2 * r + 1;
  for (let y = 0; y < S; y++) {
    const yRow = y * S;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[yRow + Math.min(S - 1, Math.max(0, x))];
    for (let x = 0; x < S; x++) {
      tmp[yRow + x] = sum / n;
      sum += a[yRow + Math.min(S - 1, x + r + 1)] - a[yRow + Math.max(0, x - r)];
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
}
