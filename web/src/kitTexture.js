import { fontCss } from "./design.js";
import { baseDesign, graphic, paintPattern as paintPatternColors, pattern as patternDef, region } from "./library.js";
import { resolveColor } from "./project.js";

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
  const S = canvas.width;
  const islands = Object.entries(template.islands).map(([name, isl]) => ({ name, kind: isl.kind, isl, frame: islandFrame(isl, S) }));
  const env = {
    garment, S, islands, project, images,
    byName: Object.fromEntries(islands.map((i) => [i.name, i])),
    color: (c) => resolveColor(c, project.palette),
    masks: [], // masks of the groups being painted
  };
  reset(ctx);
  ctx.fillStyle = "#ffffff"; // fabric without any layer
  ctx.fillRect(0, 0, S, S);
  drawLayers(ctx, project.garments[garment].layers, env, 0);
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

// One scratch canvas per nesting depth, kept between repaints.
const scratchPool = [];
function scratchCanvas(env, depth) {
  let c = scratchPool[depth];
  if (!c || c.width !== env.S) {
    c = scratchPool[depth] = document.createElement("canvas");
    c.width = c.height = env.S;
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
  ctx.drawImage(image, x - w / 2, y - h / 2, w, h);
}

function placeGraphic(ctx, layer, env, frame, x, y) {
  const t = layer.transform;
  ctx.translate(x, y);
  ctx.scale(frame.s, -frame.s); // metres, y up
  ctx.fillStyle = env.color(layer.color);
  graphic(layer.shape).paint(ctx, layer.size * t.scaleX, layer.size * t.scaleY);
}
