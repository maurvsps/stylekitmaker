// "My kits": several designs saved in this browser, each with a small preview. Plus share links: the design packed
// into the URL hash (uploaded files are left out, linked images stay), opened by anyone with the link.

const KEY = "kit-maker:kits";

export function loadKits() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((k) => k && typeof k.id === "string" && k.data) : [];
  } catch {
    return [];
  }
}

/** Returns false when the browser refuses (storage full or blocked). */
export function storeKits(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** A small JPEG preview of a big image data URL. */
export function shrinkImage(dataUrl, side = 200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const k = side / Math.max(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#16161a";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

const toBase64Url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (text) => {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** { url, skipped } for a serialized project; `skipped` counts uploaded files that cannot travel in a link. */
export async function makeShareLink(data) {
  const assets = {};
  let skipped = 0;
  for (const [id, a] of Object.entries(data.assets || {})) {
    if (a.src.startsWith("data:")) skipped++;
    else assets[id] = a;
  }
  const json = JSON.stringify({ ...data, assets });
  const bytes = new TextEncoder().encode(json);
  const packed = typeof CompressionStream === "function" ? await pipe(bytes, new CompressionStream("deflate-raw")) : bytes;
  const tag = typeof CompressionStream === "function" ? "z" : "r";
  return { url: `${location.origin}${location.pathname}#kit=${tag}.${toBase64Url(packed)}`, skipped };
}

/** The design in a share-link hash, or null. */
export async function readShareLink(hash) {
  const m = /^#kit=([zr])\.([A-Za-z0-9_-]+)$/.exec(hash || "");
  if (!m) return null;
  try {
    const bytes = fromBase64Url(m[2]);
    const raw = m[1] === "z" ? await pipe(bytes, new DecompressionStream("deflate-raw")) : bytes;
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}
