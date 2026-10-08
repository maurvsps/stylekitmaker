// Layer finishes: how a layer's shape catches the light and what it is made of. A finish is
//   { relief: -1..1, stitch, roughness, metalness, grain, fx }
// relief / stitch / roughness / metalness feed the material maps (kitTexture.js drawMaterial); `grain` is a surface
// texture pressed into the relief map (GRAINS), `fx` an effect painted on the colour (FX).
// The picker shows them in groups; a finish matches a preset when all six fields agree.

export const GRAINS = ["carbon", "mesh", "leather", "brushed", "hex", "quilt", "glitter", "velvet", "chrome", "prism"];
export const FX = ["iridescent", "holo", "glitter", "perforated", "fade"];

const f = (relief, stitch, roughness, metalness, grain = null, fx = null) => ({ relief, stitch, roughness, metalness, grain, fx });

export const FINISH_GROUPS = [
  {
    id: "print",
    label: "Print",
    items: [
      { id: "flat", label: "Flat print", swatch: "linear-gradient(135deg,#8a8f98,#6a6f78)", finish: f(0, false, null, null) },
      { id: "vinyl", label: "Glossy vinyl", swatch: "linear-gradient(135deg,#3a3f48 0%,#fff 38%,#3a3f48 52%,#9aa 100%)", finish: f(0.2, false, 0.2, null) },
      { id: "velvet", label: "Flock velvet", swatch: "radial-gradient(circle at 30% 30%,#6b4a7a,#2a1633)", finish: f(0.15, false, 1, null, "velvet") },
    ],
  },
  {
    id: "relief",
    label: "Raised & stitched",
    items: [
      { id: "embroidered", label: "Embroidered", swatch: "repeating-linear-gradient(60deg,#c9ccd2 0 2px,#8d919a 2px 4px)", finish: f(0.45, true, 0.6, null) },
      { id: "raised", label: "Heat-pressed", swatch: "linear-gradient(160deg,#e6e8ec,#6d717a)", finish: f(0.5, false, 0.5, null) },
      { id: "debossed", label: "Debossed", swatch: "linear-gradient(160deg,#4b4f57,#b8bcc4)", finish: f(-0.5, false, null, null) },
      { id: "quilted", label: "Quilted", swatch: "conic-gradient(from 45deg at 50% 50%,#9aa0aa,#5a5f69,#9aa0aa,#5a5f69,#9aa0aa)", finish: f(0.3, false, 0.55, null, "quilt") },
    ],
  },
  {
    id: "metal",
    label: "Metal & shine",
    items: [
      { id: "foil", label: "Metallic foil", swatch: "linear-gradient(135deg,#f6e7a8,#b98a1f 50%,#f6e7a8)", finish: f(0.1, false, 0.3, 0.9) },
      { id: "brushed", label: "Brushed steel", swatch: "repeating-linear-gradient(0deg,#c3c8d0 0 1px,#9ba1ab 1px 3px)", finish: f(0, false, 0.4, 0.85, "brushed") },
      { id: "chrome", label: "Liquid chrome", swatch: "linear-gradient(120deg,#fff 0%,#59606b 28%,#e8edf3 50%,#3a3f48 72%,#fff 100%)", finish: f(0.2, false, 0.05, 1, "chrome") },
      { id: "reflective", label: "Reflective", swatch: "repeating-conic-gradient(#dfe3e8 0 25%,#aeb4bd 0 50%) 0 0/8px 8px", finish: f(0.1, false, 0.25, 0.7, "prism") },
    ],
  },
  {
    id: "texture",
    label: "Textures",
    items: [
      { id: "carbon", label: "Carbon fibre", swatch: "repeating-linear-gradient(45deg,#1b1d21 0 4px,#34373d 4px 8px),#222", finish: f(0.15, false, 0.35, 0.2, "carbon") },
      { id: "leather", label: "Leather", swatch: "radial-gradient(circle at 20% 30%,#7a5233,#3d2615)", finish: f(0.2, false, 0.65, null, "leather") },
      { id: "mesh", label: "Mesh", swatch: "radial-gradient(circle,#15171a 30%,#7d828b 32%) 0 0/8px 8px", finish: f(-0.2, false, 0.7, null, "mesh") },
      { id: "honeycomb", label: "Honeycomb", swatch: "repeating-linear-gradient(60deg,#9aa0aa 0 1px,transparent 1px 8px),repeating-linear-gradient(-60deg,#9aa0aa 0 1px,transparent 1px 8px),#5a5f69", finish: f(0.35, false, 0.5, null, "hex") },
    ],
  },
  {
    id: "fx",
    label: "Special effects",
    items: [
      { id: "iridescent", label: "Iridescent", swatch: "linear-gradient(135deg,#ff4fd8,#4ff0ff,#b6ff4f,#ffb34f,#9b6bff)", finish: f(0.05, false, 0.2, 0.6, null, "iridescent") },
      { id: "holo", label: "Holographic", swatch: "repeating-linear-gradient(115deg,#ff6ad5 0 6px,#6affef 6px 12px,#fff36a 12px 18px,#9d6aff 18px 24px)", finish: f(0.05, false, 0.15, 0.7, "prism", "holo") },
      { id: "glitter", label: "Glitter", swatch: "radial-gradient(circle at 20% 25%,#fff 0 1px,transparent 2px),radial-gradient(circle at 70% 60%,#fff 0 1px,transparent 2px),radial-gradient(circle at 45% 80%,#ffe9a0 0 1px,transparent 2px),#7a5a2a", finish: f(0.1, false, 0.3, 0.6, "glitter", "glitter") },
      { id: "perforated", label: "Perforated", swatch: "radial-gradient(circle,transparent 30%,#8d919a 32%) 0 0/9px 9px", finish: f(0, false, null, null, null, "perforated") },
      { id: "fade", label: "Fade out", swatch: "linear-gradient(180deg,#e6e8ec,transparent)", finish: f(0, false, null, null, null, "fade") },
    ],
  },
];

export const FINISH_PRESETS = FINISH_GROUPS.flatMap((g) => g.items);

const key = (x) => [x.relief ?? 0, !!x.stitch, x.roughness ?? null, x.metalness ?? null, x.grain ?? null, x.fx ?? null].join("|");

/** The preset a finish equals, or undefined for a custom one. */
export const matchFinish = (finish) => (finish ? FINISH_PRESETS.find((p) => key(p.finish) === key(finish)) : FINISH_PRESETS[0]);
