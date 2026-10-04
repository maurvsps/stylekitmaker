import { fontCss } from "./design.js";

// Paints a garment's texture from the design. The canvas follows the garment's UV template
// (public/models/<name>.json, written by blender/make_kit.py): every island has a local frame in metres
// (p right, q up, as seen from outside) and a rectangle on the texture.
//
// Body panels are painted in body coordinates: x = metres across from the centre line (+x = wearer's left,
// which is on the viewer's right when looking at the front) and h = metres up from the hem. The back's frame
// runs the other way (p = -x), so patterns line up across the side seams.
//
// Colour roles: primary and secondary make the shirt pattern; the trim colour paints collar, cuffs, waistband,
// sock tops and the lettering. Shorts are secondary, socks primary.

const PAD = 6; // pixels painted beyond each island so seams never show the background

export function drawGarment(canvas, garment, template, design, assets) {
  const ctx = canvas.getContext("2d");
  const S = canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = design.colors[0];
  ctx.fillRect(0, 0, S, S);
  for (const [name, isl] of Object.entries(template.islands)) {
    const frame = islandFrame(isl, S);
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x - PAD, frame.y - PAD, frame.w + 2 * PAD, frame.h + 2 * PAD);
    ctx.clip();
    const painter = PAINTERS[garment];
    painter(ctx, name, isl, frame, design, assets);
    ctx.restore();
  }
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

/** Draw in body coordinates (x, h) on a front or back panel. */
function bodySpace(ctx, name, frame) {
  frame.local(ctx);
  if (name === "back") ctx.scale(-1, 1);
}

/** Fill the whole island (in its local frame, whatever transform is current). */
function fill(ctx, frame, color) {
  frame.local(ctx);
  ctx.fillStyle = color;
  ctx.fillRect(frame.p0 - 1, frame.q0 - 1, frame.p1 - frame.p0 + 2, frame.q1 - frame.q0 + 2);
}

// ---------------------------------------------------------------- patterns (body coordinates)

const BIG = 2; // metres: further than any panel reaches

function paintPattern(ctx, pattern, [primary, secondary]) {
  const box = (color, x0, h0, x1, h1) => {
    ctx.fillStyle = color;
    ctx.fillRect(x0, h0, x1 - x0, h1 - h0);
  };
  switch (pattern) {
    case "stripes": {
      const w = 0.06; // a primary stripe on the centre line, alternating outward
      box(secondary, -BIG, -BIG, BIG, BIG);
      for (let k = -10; k <= 10; k++) box(primary, (2 * k - 0.5) * w, -BIG, (2 * k + 0.5) * w, BIG);
      break;
    }
    case "hoops": {
      const b = 0.07;
      box(primary, -BIG, -BIG, BIG, BIG);
      for (let k = 0; k < 20; k++) box(secondary, -BIG, (2 * k + 1) * b, BIG, (2 * k + 2) * b);
      break;
    }
    case "halves":
      box(primary, -BIG, -BIG, 0, BIG);
      box(secondary, 0, -BIG, BIG, BIG);
      break;
    case "sash":
      box(primary, -BIG, -BIG, BIG, BIG);
      band(ctx, secondary, 0.12, [[-0.32, 0.9], [0.4, -0.1]]);
      break;
    case "chevron":
      box(primary, -BIG, -BIG, BIG, BIG);
      band(ctx, secondary, 0.08, [[-0.6, 0.78], [0, 0.42], [0.6, 0.78]]);
      break;
    case "gradient": {
      const g = ctx.createLinearGradient(0, 0.05, 0, 0.75);
      g.addColorStop(0, secondary);
      g.addColorStop(1, primary);
      ctx.fillStyle = g;
      ctx.fillRect(-BIG, -BIG, 2 * BIG, 2 * BIG);
      break;
    }
    default:
      box(primary, -BIG, -BIG, BIG, BIG);
  }
}

function band(ctx, color, width, points) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  ctx.beginPath();
  points.forEach(([x, h], i) => (i ? ctx.lineTo(x, h) : ctx.moveTo(x, h)));
  ctx.stroke();
}

// ---------------------------------------------------------------- text and crest

/** Text centred at a local point, `height` metres tall (cap height), at most `maxWidth` metres wide. */
function text(ctx, frame, str, p, q, height, maxWidth, design, color) {
  if (!str) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const [cx, cy] = frame.toPx(p, q);
  let px = height * frame.s * 1.35; // font size so the capitals are about `height` tall
  ctx.font = fontCss(design.font, px);
  const width = ctx.measureText(str).width;
  if (width > maxWidth * frame.s) {
    px *= (maxWidth * frame.s) / width;
    ctx.font = fontCss(design.font, px);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, px * 0.06);
  ctx.strokeStyle = "rgba(0,0,0,.28)";
  ctx.strokeText(str, cx, cy);
  ctx.fillStyle = color;
  ctx.fillText(str, cx, cy);
  ctx.restore();
}

function crest(ctx, frame, image, logo, p, q) {
  if (!image) return;
  const size = 0.085 * logo.scale; // metres, the longer side
  const iw = image.naturalWidth || image.width || 1;
  const ih = image.naturalHeight || image.height || 1;
  const k = size / Math.max(iw, ih);
  const w = iw * k;
  const h = ih * k;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const [cx, cy] = frame.toPx(p + logo.x / 100, q + logo.y / 100);
  ctx.drawImage(image, cx - (w * frame.s) / 2, cy - (h * frame.s) / 2, w * frame.s, h * frame.s);
  ctx.restore();
}

// ---------------------------------------------------------------- garments

const [PRIMARY, SECONDARY, TRIM] = [0, 1, 2];

function paintShirt(ctx, name, isl, frame, design, assets) {
  const c = design.colors;
  if (isl.kind === "body") {
    bodySpace(ctx, name, frame);
    paintPattern(ctx, design.pattern, c);
    if (name === "front") {
      // Crest on the wearer's left chest (viewer's right), small number opposite, sponsor across the chest.
      crest(ctx, frame, assets.logo, design.logo, 0.095, 0.555);
      text(ctx, frame, design.number, -0.095, 0.555, 0.055, 0.08, design, c[TRIM]);
      text(ctx, frame, design.sponsor, 0, 0.39, 0.065, 0.32, design, c[TRIM]);
    } else {
      text(ctx, frame, design.name, 0, 0.6, 0.05, 0.32, design, c[TRIM]);
      text(ctx, frame, design.number, 0, 0.37, 0.24, 0.34, design, c[TRIM]);
    }
    return;
  }
  if (isl.kind === "sleeve") {
    frame.local(ctx);
    const wearerLeft = name === "sleeve_left";
    const base = design.pattern === "halves" ? c[wearerLeft ? SECONDARY : PRIMARY] : c[PRIMARY];
    fill(ctx, frame, design.pattern === "gradient" ? c[PRIMARY] : base);
    if (design.pattern === "hoops") {
      for (let k = 0; k < 12; k++) {
        ctx.fillStyle = c[SECONDARY];
        ctx.fillRect(frame.p0 - 1, -(2 * k + 2) * 0.07, frame.p1 - frame.p0 + 2, 0.07);
      }
    }
    const cuff = isl.length > 0.35 ? 0.05 : 0.025;
    ctx.fillStyle = c[TRIM];
    ctx.fillRect(frame.p0 - 1, frame.q0 - 1, frame.p1 - frame.p0 + 2, -isl.length + cuff - (frame.q0 - 1));
    return;
  }
  fill(ctx, frame, c[TRIM]); // collar
}

function paintShorts(ctx, name, isl, frame, design) {
  const c = design.colors;
  if (isl.kind !== "body") {
    fill(ctx, frame, c[TRIM]); // waistband
    return;
  }
  bodySpace(ctx, name, frame);
  fill(ctx, frame, c[SECONDARY]);
  ctx.fillStyle = c[PRIMARY]; // hem trim
  ctx.fillRect(-BIG, -BIG, 2 * BIG, BIG + 0.018);
  if (name === "front") text(ctx, frame, design.number, 0.13, 0.085, 0.07, 0.1, design, c[PRIMARY]);
}

function paintSocks(ctx, name, isl, frame, design) {
  const c = design.colors;
  if (isl.kind === "sock_top") {
    fill(ctx, frame, c[TRIM]);
    return;
  }
  frame.local(ctx);
  fill(ctx, frame, c[PRIMARY]);
  ctx.fillStyle = c[SECONDARY]; // two thin hoops under the top band
  ctx.fillRect(frame.p0 - 1, -0.075, frame.p1 - frame.p0 + 2, 0.012);
  ctx.fillRect(frame.p0 - 1, -0.1, frame.p1 - frame.p0 + 2, 0.012);
}

const PAINTERS = { shirt: paintShirt, shorts: paintShorts, socks: paintSocks };
