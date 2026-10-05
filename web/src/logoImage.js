// Uploaded logos (crests, kit brands, sponsors) as they arrive: often a JPEG or PNG on a white or flat background,
// with wide margins and more pixels than a kit needs. prepareLogo returns a data URL ready for an image layer:
//   - the flat background (the colour all four corners share) made transparent, edges softened;
//   - the empty margin trimmed;
//   - at most MAX_SIDE pixels on the long side, as PNG.
// SVGs are vector and usually already transparent: they are kept as they are.

const MAX_SIDE = 1024;
const TOLERANCE = 48; // colour distance (0..441) still counted as background
const SOFT = 24; // ...and the band above it that fades from transparent to opaque

export async function prepareLogo(file) {
  const src = await readDataUrl(file);
  if (file.type === "image/svg+xml") return src;
  const img = await decode(src);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  removeBackground(data);
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
