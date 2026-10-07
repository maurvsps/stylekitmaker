// Images added by link. The project stores the URL itself (not the pixels), so large textures cost nothing in the
// saved design; they are fetched again when the design opens. Loading needs the host to allow cross-origin use
// (canvas painting would otherwise be blocked), so a link that is refused is retried through an image proxy.

const PROXY = "https://wsrv.nl/?output=png&url=";

/** Make a pasted link usable: add https:// when missing, upgrade http, reject anything that is not a web URL. */
export function normalizeImageUrl(input) {
  let text = String(input || "").trim();
  if (!text) throw new Error("Paste an image link first.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That does not look like a web link.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) image links are supported.");
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) url.protocol = "https:"; // keep local dev links as they are
  return url.toString();
}

/** Load `src` for canvas use. Resolves { img, width, height }. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ img, width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => reject(new Error("could not load"));
    img.src = src;
  });
}

/**
 * Resolve a pasted link to { src, name, width, height }: the link itself when the host allows it, else through the
 * proxy. Throws an Error with a message fit to show the user.
 */
export async function resolveRemoteImage(input) {
  const url = normalizeImageUrl(input);
  const name = decodeURIComponent(url.split("?")[0].split("/").pop() || "image").slice(0, 60) || "image";
  for (const src of [url, `${PROXY}${encodeURIComponent(url)}`]) {
    try {
      const { width, height } = await loadImage(src);
      return { src, name, width, height };
    } catch {
      // try the next route
    }
  }
  throw new Error(
    "Could not load that link. Use the direct image address (it ends in .png, .jpg or .webp, e.g. https://i.ibb.co/xxxx/texture.png), not the page that shows it.",
  );
}

const sizes = new Map(); // src -> Promise<{ width, height }>

/** Pixel size of any image source (data URL or link). */
export function imageSize(src) {
  if (!sizes.has(src)) sizes.set(src, loadImage(src).then(({ width, height }) => ({ width, height })));
  return sizes.get(src);
}
