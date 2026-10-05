// Find real logos by name, fetched from public sources in the viewer's browser (nothing is bundled with the app):
//   crests: football club badges from TheSportsDB (free public API key "3");
//   brands: logo files on Wikimedia Commons (kit makers, sponsors), as PNG thumbnails of their SVGs.
// Both send CORS headers, so a chosen logo can be read into the design like an uploaded file.
// Each search resolves to [{ name, thumb, url }]; fetchLogo(url, name) resolves to a File for uploadImage.

const SPORTSDB = "https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=";
const COMMONS = "https://commons.wikimedia.org/w/api.php";

export async function searchCrests(query) {
  const res = await fetch(SPORTSDB + encodeURIComponent(query.trim()));
  if (!res.ok) throw new Error(`crest search failed (${res.status})`);
  const { teams } = await res.json();
  return (teams || [])
    .filter((t) => t.strBadge && (t.strSport || "Soccer") === "Soccer")
    .slice(0, 12)
    .map((t) => ({ name: t.strTeam, thumb: `${t.strBadge}/small`, url: t.strBadge }));
}

export async function searchBrands(query) {
  const params = new URLSearchParams({
    action: "query", format: "json", origin: "*",
    generator: "search", gsrnamespace: "6", gsrlimit: "16",
    gsrsearch: `${query.trim()} logo filetype:drawing|bitmap`,
    prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "512",
  });
  const res = await fetch(`${COMMONS}?${params}`);
  if (!res.ok) throw new Error(`logo search failed (${res.status})`);
  const { query: q } = await res.json();
  return Object.values(q?.pages || {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({ p, info: p.imageinfo?.[0] }))
    .filter(({ info }) => info?.thumburl && /^image\/(svg\+xml|png|jpeg|webp)$/.test(info.mime))
    .slice(0, 12)
    .map(({ p, info }) => ({ name: p.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""), thumb: info.thumburl, url: info.thumburl }));
}

/** Download a found logo as a File, so it goes through the same clean-up as an upload. */
export async function fetchLogo(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const blob = await res.blob();
  const type = /^image\/(png|jpeg|webp|svg\+xml)$/.test(blob.type) ? blob.type : "image/png";
  return new File([blob], `${name}.${type === "image/svg+xml" ? "svg" : type.split("/")[1]}`, { type });
}
