// Extra kit-brand logos: symbol-only, wordmark-only and combined versions of the brands in brandPresets.js.
// Each file in ./brands is a cleaned SVG (no scripts or metadata). Some come from Wikimedia Commons, the rest are
// cut out of the bundled logos. They are third-party trademarks: check each brand's terms before publishing a kit.
const files = import.meta.glob("./brands/*.svg", { query: "?raw", import: "default", eager: true });

const VARIANTS = [
  { id: "adidas-trefoil", name: "Adidas Trefoil", group: "Symbol", size: 0.05 },
  { id: "adidas-trefoil-name", name: "Adidas Trefoil + name", group: "Combined", size: 0.05 },
  { id: "adidas-badge", name: "Adidas Badge of Sport", group: "Combined", size: 0.058 },
  { id: "adidas-stripes-name", name: "Adidas stripes + name", group: "Combined", size: 0.065 },
  { id: "puma-wordmark", name: "Puma wordmark", group: "Wordmark", size: 0.065 },
  { id: "nike-wordmark", name: "Nike wordmark", group: "Wordmark", size: 0.058 },
  { id: "nike-swoosh-name", name: "Nike swoosh + name", group: "Combined", size: 0.058 },
  { id: "newbalance-monogram", name: "New Balance monogram", group: "Symbol", size: 0.058 },
  { id: "newbalance-wordmark", name: "New Balance wordmark", group: "Wordmark", size: 0.065 },
  { id: "umbro-name", name: "Umbro diamond + name", group: "Combined", size: 0.058 },
  { id: "umbro-red", name: "Umbro red diamond", group: "Symbol", size: 0.058 },
  { id: "umbro-classic", name: "Umbro classic wordmark", group: "Wordmark", size: 0.065 },
  { id: "kappa-omini", name: "Kappa Omini", group: "Symbol", size: 0.058 },
  { id: "kappa-wordmark", name: "Kappa wordmark", group: "Wordmark", size: 0.065 },
  { id: "castore-emblem", name: "Castore emblem", group: "Symbol", size: 0.058 },
  { id: "castore-wordmark", name: "Castore wordmark", group: "Wordmark", size: 0.065 },
  { id: "macron-symbol", name: "Macron symbol", group: "Symbol", size: 0.05 },
  { id: "macron-wordmark", name: "Macron wordmark", group: "Wordmark", size: 0.065 },
  { id: "hummel-bee", name: "Hummel bee", group: "Symbol", size: 0.05 },
  { id: "hummel-wordmark", name: "Hummel wordmark", group: "Wordmark", size: 0.065 },
  { id: "underarmour-monogram", name: "Under Armour monogram", group: "Symbol", size: 0.058 },
  { id: "underarmour-wordmark", name: "Under Armour wordmark", group: "Wordmark", size: 0.065 },
  { id: "mizuno-runbird", name: "Mizuno Runbird", group: "Symbol", size: 0.058 },
  { id: "mizuno-wordmark", name: "Mizuno wordmark", group: "Wordmark", size: 0.065 },
  { id: "lecoq-wordmark", name: "Le Coq Sportif wordmark", group: "Wordmark", size: 0.065 },
  { id: "lecoq-wordmark-2026", name: "Le Coq Sportif wordmark 2026", group: "Wordmark", size: 0.065 },
  { id: "lotto-box", name: "Lotto box", group: "Wordmark", size: 0.065 },
  { id: "lotto-bar", name: "Lotto bar", group: "Wordmark", size: 0.065 },
  { id: "reebok-vector", name: "Reebok vector", group: "Symbol", size: 0.065 },
  { id: "reebok-wordmark", name: "Reebok wordmark", group: "Wordmark", size: 0.065 },
  { id: "reebok-delta", name: "Reebok delta + name", group: "Combined", size: 0.065 },
  { id: "kelme-paw", name: "Kelme paw", group: "Symbol", size: 0.05 },
  { id: "kelme-wordmark", name: "Kelme wordmark", group: "Wordmark", size: 0.065 },
];

const dataUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Brand presets for the logo picker: the bundled logos ("Main") plus every variant, each with a thumbnail URL. */
export function brandLibrary(mainBrands) {
  const withThumb = (p) => ({ ...p, url: dataUri(p.svg) });
  return [
    ...mainBrands.map((b) => withThumb({ ...b, group: "Main" })),
    ...VARIANTS.map((v) => withThumb({ ...v, category: "brand", svg: files[`./brands/${v.id}.svg`] })),
  ];
}
