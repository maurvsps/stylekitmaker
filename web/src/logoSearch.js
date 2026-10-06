// Find real logos by name, fetched from public sources in the viewer's browser (nothing is bundled with the app):
//   crests: football club badges from TheSportsDB (free public API key "3");
//   kit brands: technical apparel makers on Wikimedia Commons;
//   sponsors: shirt sponsors on Wikimedia Commons.
// The search APIs send CORS headers, but image hosts may not (TheSportsDB's badge storage does not), and the design
// needs the pixels. So a chosen logo is downloaded directly when the host allows it, else through the public wsrv.nl
// image proxy, which adds CORS headers.
// Each search resolves to [{ name, thumb, url }]; fetchLogo(url, name) resolves to a File for uploadImage.

const SPORTSDB = "https://www.thesportsDB.com/api/v1/json/3/searchteams.php?t=";
const COMMONS = "https://commons.wikimedia.org/w/api.php";

export async function searchCrests(query) {
  const res = await fetch(SPORTSDB + encodeURIComponent(query.trim()));
  if (!res.ok) throw new Error(`crest search failed (${res.status})`);
  const { teams } = await res.json();
  return (teams || [])
    .filter((t) => t.strBadge && (t.strSport || "Soccer") === "Soccer")
    .slice(0, 15)
    .map((t) => ({ name: t.strTeam, thumb: `${t.strBadge}/small`, url: t.strBadge }));
}

const KIT_FILTER_REGEX = /(?:kit[\s_-]?(?:body|shorts|socks|left|right|arm|sleeve)|flag[\s_-]of|jersey)/i;

function cleanLogoTitle(title) {
  return title
    .replace(/^File:/, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Search kit maker brands (Puma, Nike, Adidas, Kappa...) on Wikimedia, filtering out Wikipedia kit template files. */
export async function searchKitBrands(query) {
  const qStr = `${query.trim()} logo -kit -shorts -socks filetype:drawing|bitmap`;
  const params = new URLSearchParams({
    action: "query", format: "json", origin: "*",
    generator: "search", gsrnamespace: "6", gsrlimit: "24",
    gsrsearch: qStr,
    prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "960",
  });
  const res = await fetch(`${COMMONS}?${params}`);
  if (!res.ok) throw new Error(`brand search failed (${res.status})`);
  const { query: q } = await res.json();
  return Object.values(q?.pages || {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({ p, info: p.imageinfo?.[0] }))
    .filter(({ p, info }) =>
      info?.thumburl &&
      /^image\/(svg\+xml|png|jpeg|webp)$/.test(info.mime) &&
      !KIT_FILTER_REGEX.test(p.title)
    )
    .slice(0, 15)
    .map(({ p, info }) => ({
      name: cleanLogoTitle(p.title),
      thumb: info.thumburl,
      url: info.thumburl,
    }));
}

/** Search shirt sponsors (commercial brands, companies) on Wikimedia Commons. */
export async function searchSponsors(query) {
  const qStr = `${query.trim()} logo -kit -shorts -socks filetype:drawing|bitmap`;
  const params = new URLSearchParams({
    action: "query", format: "json", origin: "*",
    generator: "search", gsrnamespace: "6", gsrlimit: "24",
    gsrsearch: qStr,
    prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "960",
  });
  const res = await fetch(`${COMMONS}?${params}`);
  if (!res.ok) throw new Error(`sponsor search failed (${res.status})`);
  const { query: q } = await res.json();
  return Object.values(q?.pages || {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({ p, info: p.imageinfo?.[0] }))
    .filter(({ p, info }) =>
      info?.thumburl &&
      /^image\/(svg\+xml|png|jpeg|webp)$/.test(info.mime) &&
      !KIT_FILTER_REGEX.test(p.title)
    )
    .slice(0, 15)
    .map(({ p, info }) => ({
      name: cleanLogoTitle(p.title),
      thumb: info.thumburl,
      url: info.thumburl,
    }));
}

// Keep searchBrands for backwards compatibility
export const searchBrands = searchSponsors;

const PROXY = "https://wsrv.nl/?output=png&w=1024&we&url=";

/** Download a found logo as a File, so it goes through the same clean-up as an upload. */
export async function fetchLogo(url, name) {
  let blob;
  try {
    blob = await download(url);
  } catch {
    blob = await download(PROXY + encodeURIComponent(url)); // the host sent no CORS headers (or refused): go via the proxy
  }
  const type = /^image\/(png|jpeg|webp|svg\+xml)$/.test(blob.type) ? blob.type : "image/png";
  return new File([blob], `${name}.${type === "image/svg+xml" ? "svg" : type.split("/")[1]}`, { type });
}

async function download(url) {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/") && blob.type !== "application/octet-stream") throw new Error("not an image");
  return blob;
}
