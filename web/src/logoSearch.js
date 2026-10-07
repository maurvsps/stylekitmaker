import { FCLOGO_CLUBS } from "./brandPresets.js";

// Find real logos by name, fetched from public sources in the viewer's browser (nothing is bundled with the app):
//   crests: football club vector badges from FCLOGO (with monochrome variants) and Wikimedia Commons;
//   kit brands: technical apparel makers on Wikimedia Commons;
//   sponsors: shirt sponsors on Wikimedia Commons.
// The search APIs send CORS headers, but image hosts may not (TheSportsDB's badge storage does not), and the design
// needs the pixels. So a chosen logo is downloaded directly when the host allows it, else through the public wsrv.nl
// image proxy, which adds CORS headers.
// Each search resolves to [{ name, thumb, url, monoUrl, hasMono, source }]; fetchLogo(url, name) resolves to a File for uploadImage.

const SPORTSDB = "https://www.thesportsDB.com/api/v1/json/3/searchteams.php?t=";
const COMMONS = "https://commons.wikimedia.org/w/api.php";

export async function searchCrests(query) {
  const qStr = query.trim().toLowerCase();
  if (!qStr) return [];

  // 1. Search curated FCLOGO vector catalog first (instant, authentic vector + monochrome variants)
  const fclogoMatches = (FCLOGO_CLUBS || [])
    .filter((c) =>
      c.name.toLowerCase().includes(qStr) ||
      (c.aliases && c.aliases.some((a) => a.toLowerCase().includes(qStr)))
    )
    .map((c) => ({
      name: c.name,
      thumb: c.colorUrl,
      url: c.colorUrl,
      monoUrl: c.monoUrl,
      hasMono: !!c.monoUrl,
      source: "FCLOGO",
    }));

  if (fclogoMatches.length >= 6) {
    return fclogoMatches.slice(0, 15);
  }

  // 2. Search Wikimedia Commons for vector SVG badges
  let wikiMatches = [];
  try {
    const wikiQuery = `${query.trim()} logo football club -kit -jersey -shorts filetype:svg`;
    const params = new URLSearchParams({
      action: "query", format: "json", origin: "*",
      generator: "search", gsrnamespace: "6", gsrlimit: "15",
      gsrsearch: wikiQuery,
      prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "360",
    });
    const res = await fetch(`${COMMONS}?${params}`);
    if (res.ok) {
      const { query: q } = await res.json();
      wikiMatches = Object.values(q?.pages || {})
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((p) => ({ p, info: p.imageinfo?.[0] }))
        .filter(({ p, info }) =>
          info?.thumburl &&
          info.mime === "image/svg+xml" &&
          !KIT_FILTER_REGEX.test(p.title)
        )
        .map(({ p, info }) => ({
          name: cleanLogoTitle(p.title),
          thumb: info.thumburl,
          url: info.url || info.thumburl,
          source: "Wikimedia",
        }));
    }
  } catch {
    /* Wikimedia search failed, continue to fallback */
  }

  const combined = [...fclogoMatches, ...wikiMatches];
  if (combined.length > 0) {
    return combined.slice(0, 15);
  }

  // 3. Fallback to TheSportsDB if no vector found
  try {
    const res = await fetch(SPORTSDB + encodeURIComponent(query.trim()));
    if (res.ok) {
      const { teams } = await res.json();
      const sdbResults = (teams || [])
        .filter((t) => t.strBadge && (t.strSport || "Soccer") === "Soccer")
        .slice(0, 15)
        .map((t) => ({
          name: t.strTeam,
          thumb: `${t.strBadge}/small`,
          url: t.strBadge,
          source: "TheSportsDB",
        }));
      return sdbResults;
    }
  } catch {
    /* all searches failed */
  }

  return [];
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
  const isSvgUrl = /\.svg($|\?)/i.test(url);
  try {
    blob = await download(url);
  } catch {
    const proxyUrl = isSvgUrl
      ? `https://wsrv.nl/?output=svg&url=${encodeURIComponent(url)}`
      : `${PROXY}${encodeURIComponent(url)}`;
    blob = await download(proxyUrl);
  }
  const isSvg = isSvgUrl || blob.type === "image/svg+xml";
  const type = isSvg ? "image/svg+xml" : /^image\/(png|jpeg|webp)$/.test(blob.type) ? blob.type : "image/png";
  return new File([blob], `${name}.${isSvg ? "svg" : type.split("/")[1] || "png"}`, { type });
}


async function download(url) {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/") && blob.type !== "application/octet-stream") throw new Error("not an image");
  return blob;
}
