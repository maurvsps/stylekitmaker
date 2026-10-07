// Uploaded logos (crests, kit brands, sponsors) as they arrive: often a JPEG or PNG on a white or flat background,
// with wide margins and more pixels than a kit needs. prepareLogo returns a data URL ready for an image layer:
//   - the flat background (the colour all four corners share) made transparent, edges softened;
//   - the empty margin trimmed;
//   - at most MAX_SIDE pixels on the long side, as PNG.
// SVGs are drawn at their own aspect ratio (an SVG with only a viewBox would otherwise come in at the browser's
// default 300 x 150 and squash the logo) and kept transparent; the margin is trimmed the same way.

const MAX_SIDE = 1024;
const TOLERANCE = 48; // colour distance (0..441) still counted as background
const SOFT = 24; // ...and the band above it that fades from transparent to opaque

export async function prepareLogo(file) {
  const svg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name || "");
  const src = svg ? sizedSvg(await file.text()) : await readDataUrl(file);
  if (!src) return readDataUrl(file);
  const img = await decode(src);
  const scale = svg ? 1 : Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  if (!svg) removeBackground(data);
  const box = opaqueBox(data);
  if (!box) return src; // nothing left: keep the original rather than an empty image
  ctx.putImageData(data, 0, 0);
  const pad = Math.round(Math.max(box.w, box.h) * 0.02);
  const out = document.createElement("canvas");
  out.width = box.w + 2 * pad;
  out.height = box.h + 2 * pad;
  out.getContext("2d").drawImage(canvas, box.x, box.y, box.w, box.h, pad, pad, box.w, box.h);
  return out.toDataURL("image/png");
}

/** Clear the background flood-filled from the image border, if the corners agree on one opaque colour. */
export function removeBackground({ data, width: w, height: h }) {
  const at = (x, y) => (y * w + x) * 4;
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  if (corners.some((i) => data[i + 3] < 250)) return false; // already transparent: leave it
  const bg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + data[i + c], 0) / 4);
  const dist = (i) => Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  if (corners.some((i) => dist(i) > TOLERANCE)) return false; // a photo or a full-bleed design: not a flat background
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const k = y * w + x;
    if (seen[k]) return;
    seen[k] = 1;
    if (dist(k * 4) <= TOLERANCE + SOFT) stack.push(k);
  };
  for (let x = 0; x < w; x++) push(x, 0), push(x, h - 1);
  for (let y = 0; y < h; y++) push(0, y), push(w - 1, y);
  while (stack.length) {
    const k = stack.pop();
    const i = k * 4;
    const d = dist(i);
    // Fully transparent inside the tolerance; fading out across the soft band, so anti-aliased edges stay smooth.
    data[i + 3] = d <= TOLERANCE ? 0 : Math.round((data[i + 3] * (d - TOLERANCE)) / SOFT);
    if (d > TOLERANCE) continue; // an edge pixel: do not spread past it
    const x = k % w;
    const y = (k - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return true;
}

/** Bounding box of the pixels that are not (almost) transparent, or null. */
export function opaqueBox({ data, width: w, height: h }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The SVG as a data URL with explicit width and height (MAX_SIDE on the long side) taken from its viewBox. */
function sizedSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const el = doc.documentElement;
  if (!el || el.nodeName.toLowerCase() !== "svg") return null;
  const box = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  let w = box.length === 4 ? box[2] : parseFloat(el.getAttribute("width"));
  let h = box.length === 4 ? box[3] : parseFloat(el.getAttribute("height"));
  if (!(w > 0 && h > 0)) [w, h] = [1, 1];
  if (box.length !== 4) el.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const k = MAX_SIDE / Math.max(w, h);
  el.setAttribute("width", String(Math.round(w * k)));
  el.setAttribute("height", String(Math.round(h * k)));
  el.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const xml = new XMLSerializer().serializeToString(el);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function decode(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not read the image"));
    img.src = src;
  });
}

/**
 * A picture or texture for the kit as it is: no background removal, no trimming. At most ART_SIDE pixels on the long
 * side, kept as PNG when it has transparency and fits `maxBytes`, else JPEG at the best quality that fits.
 */
const ART_SIDE = 2048;
export async function prepareArtwork(file, maxBytes = 1.5 * 1024 * 1024) {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name || "")) return prepareLogo(file);
  const img = await decode(await readDataUrl(file));
  let side = Math.min(ART_SIDE, Math.max(img.naturalWidth, img.naturalHeight));
  const bytes = (url) => url.length * 0.75;
  for (let attempt = 0; attempt < 6; attempt++) {
    const k = side / Math.max(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const alpha = hasAlpha(ctx, canvas);
    if (alpha) {
      const png = canvas.toDataURL("image/png");
      if (bytes(png) <= maxBytes) return png;
    } else {
      for (const q of [0.92, 0.82, 0.7]) {
        const jpg = canvas.toDataURL("image/jpeg", q);
        if (bytes(jpg) <= maxBytes) return jpg;
      }
    }
    side = Math.round(side * 0.75);
  }
  throw new Error("too large");
}

function hasAlpha(ctx, canvas) {
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4 * 16) if (data[i] < 250) return true;
  return false;
}
