// The design library: base designs, patterns and graphics. Each entry is metadata (for the panel and for
// sanitizing saved projects) plus a plain canvas painter (for the compositor in kitTexture.js). No React here.
//
// Painters draw in metres. Patterns get "pattern space": on body panels x = metres across from the centre line
// (+x = wearer's left) and h = metres up from the hem; on sleeves and socks ("tubes") x = metres around from the
// top line and h = metres down from the shoulder or the top edge. The compositor sets that transform up.

const BIG = 2; // metres: further than any panel reaches
const TRIPLE = [0, 0.025, 0.05]; // offsets of sportswear triple stripes (14 mm stripes, 11 mm gaps)

const box = (ctx, color, x0, h0, x1, h1) => {
  ctx.fillStyle = color;
  ctx.fillRect(x0, h0, x1 - x0, h1 - h0);
};

function band(ctx, color, width, points) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  ctx.beginPath();
  points.forEach(([x, h], i) => (i ? ctx.lineTo(x, h) : ctx.moveTo(x, h)));
  ctx.stroke();
}

/** Fill the whole island (and its bleed) in its local frame. */
export function fillIsland(ctx, frame, color) {
  frame.local(ctx);
  ctx.fillStyle = color;
  ctx.fillRect(frame.p0 - 1, frame.q0 - 1, frame.p1 - frame.p0 + 2, frame.q1 - frame.q0 + 2);
}

/** Length of the cuff band at the end of a sleeve, in metres. */
export const cuffLength = (isl) => (isl.length > 0.35 ? 0.05 : 0.025);

// ---------------------------------------------------------------- base designs
// A base design is opaque: the ground colour of every part. A trim design (trim: true) paints only the trims
// (collar, cuffs, hem, waistband, sock tops) and sits above the patterns, so they never cover it. `slots` are the
// colour roles ([key, label, default]); `ground` is the slot that also fills the texture outside the islands.
// paint(ctx, island, colors) paints one island; `island` is { name, kind, isl, frame }.

export const BASE_DESIGNS = {
  shirt: [
    {
      id: "classic",
      label: "Classic",
      ground: "body",
      slots: [["body", "Body", "@0"], ["sleeves", "Sleeves", "@0"]],
      paint: (ctx, { kind, frame }, c) => fillIsland(ctx, frame, kind === "sleeve" ? c.sleeves : c.body),
    },
    {
      id: "contrast-back",
      label: "Contrast back",
      ground: "front",
      slots: [["front", "Front", "@0"], ["back", "Back", "@1"], ["sleeves", "Sleeves", "@0"]],
      paint: (ctx, { kind, name, frame }, c) => fillIsland(ctx, frame, kind === "sleeve" ? c.sleeves : name === "back" ? c.back : c.front),
    },
    {
      id: "split-sleeves",
      label: "Split sleeves",
      ground: "body",
      slots: [["body", "Body", "@0"], ["left", "Left sleeve", "@1"], ["right", "Right sleeve", "@2"]],
      paint: (ctx, { kind, name, frame }, c) =>
        fillIsland(ctx, frame, kind !== "sleeve" ? c.body : name === "sleeve_left" ? c.left : c.right),
    },
    {
      id: "raglan",
      label: "Raglan",
      ground: "body",
      slots: [["body", "Body", "@0"], ["raglan", "Shoulders & sleeves", "@1"]],
      paint(ctx, { kind, frame }, c) {
        if (kind === "sleeve") return fillIsland(ctx, frame, c.raglan);
        fillIsland(ctx, frame, c.body);
        if (kind !== "body") return;
        ctx.fillStyle = c.raglan; // shoulder wedges running from the armpits to the neckline
        ctx.beginPath();
        ctx.moveTo(-1, 0.5); ctx.lineTo(-0.34, 0.5); ctx.lineTo(-0.1, 0.8); ctx.lineTo(-1, 0.8); ctx.closePath();
        ctx.moveTo(1, 0.5); ctx.lineTo(0.34, 0.5); ctx.lineTo(0.1, 0.8); ctx.lineTo(1, 0.8); ctx.closePath();
        ctx.fill();
      },
    },
    {
      id: "trim",
      trim: true,
      label: "Collar & cuffs",
      slots: [["collar", "Collar", "@2"], ["cuffs", "Cuffs", "@2"]],
      paint(ctx, { kind, isl, frame }, c) {
        if (kind === "collar") return fillIsland(ctx, frame, c.collar);
        if (kind !== "sleeve") return;
        frame.local(ctx);
        ctx.fillStyle = c.cuffs;
        ctx.fillRect(frame.p0 - 1, frame.q0 - 1, frame.p1 - frame.p0 + 2, -isl.length + cuffLength(isl) - (frame.q0 - 1));
      },
    },
  ],
  shorts: [
    {
      id: "plain",
      label: "Plain",
      ground: "body",
      slots: [["body", "Body", "@1"]],
      paint: (ctx, { frame }, c) => fillIsland(ctx, frame, c.body),
    },
    {
      id: "side-panels",
      label: "Side panels",
      ground: "body",
      slots: [["body", "Body", "@1"], ["sides", "Side panels", "@0"]],
      paint(ctx, { kind, frame }, c) {
        fillIsland(ctx, frame, c.body);
        if (kind !== "body") return;
        ctx.fillStyle = c.sides;
        ctx.fillRect(-1, -1, 0.73, 2);
        ctx.fillRect(0.27, -1, 0.73, 2);
      },
    },
    {
      id: "trim",
      trim: true,
      label: "Hem & waistband",
      slots: [["hem", "Hem", "@0"], ["waistband", "Waistband", "@2"]],
      paint(ctx, { kind, frame }, c) {
        if (kind !== "body") return fillIsland(ctx, frame, c.waistband);
        frame.local(ctx);
        ctx.fillStyle = c.hem; // a thin band along the leg hems
        ctx.fillRect(-BIG, -BIG, 2 * BIG, BIG + 0.018);
      },
    },
  ],
  socks: [
    {
      id: "hoops",
      label: "Two hoops",
      ground: "body",
      slots: [["body", "Sock", "@0"], ["hoops", "Hoops", "@1"]],
      paint(ctx, { kind, frame }, c) {
        fillIsland(ctx, frame, c.body);
        if (kind === "sock_top") return;
        ctx.fillStyle = c.hoops; // two thin hoops under the top band
        ctx.fillRect(frame.p0 - 1, -0.075, frame.p1 - frame.p0 + 2, 0.012);
        ctx.fillRect(frame.p0 - 1, -0.1, frame.p1 - frame.p0 + 2, 0.012);
      },
    },
    {
      id: "calf-band",
      label: "Calf band",
      ground: "body",
      slots: [["body", "Sock", "@0"], ["band", "Band", "@1"]],
      paint(ctx, { kind, frame }, c) {
        fillIsland(ctx, frame, c.body);
        if (kind === "sock_top") return;
        ctx.fillStyle = c.band;
        ctx.fillRect(frame.p0 - 1, -0.2, frame.p1 - frame.p0 + 2, 0.1);
      },
    },
    {
      id: "plain",
      label: "Plain",
      ground: "body",
      slots: [["body", "Sock", "@0"]],
      paint: (ctx, { frame }, c) => fillIsland(ctx, frame, c.body),
    },
    {
      id: "trim",
      trim: true,
      label: "Top band",
      slots: [["top", "Top band", "@2"]],
      paint: (ctx, { kind, frame }, c) => kind === "sock_top" && fillIsland(ctx, frame, c.top),
    },
  ],
};

/** The base design `id` of a garment; a missing id falls back to the first design of the same kind. */
export const baseDesign = (garment, id, trim = false) =>
  BASE_DESIGNS[garment].find((b) => b.id === id) || BASE_DESIGNS[garment].find((b) => !!b.trim === trim);

// ---------------------------------------------------------------- patterns
// A pattern paints its colours (`slots`) over whatever is below, on an optional background colour (null =
// transparent), except opaque patterns (the gradient). paint(ctx, colors, { kind, name, reach }) draws in pattern
// space and must cover at least `reach` metres around the origin (it grows when the layer is scaled down or moved);
// `sleeve` optionally replaces it on sleeves.

export const PATTERNS = [
  {
    id: "stripes",
    label: "Stripes",
    slots: ["Stripes"],
    paint(ctx, [a], { reach: R }) {
      const w = 0.06; // a stripe on the centre line, alternating outward
      const n = Math.ceil(R / (2 * w));
      for (let k = -n; k <= n; k++) box(ctx, a, (2 * k - 0.5) * w, -R, (2 * k + 0.5) * w, R);
    },
  },
  {
    id: "pinstripes",
    label: "Pinstripes",
    slots: ["Lines"],
    paint(ctx, [a], { reach: R }) {
      const n = Math.ceil(R / 0.03);
      for (let k = -n; k <= n; k++) box(ctx, a, k * 0.03 - 0.002, -R, k * 0.03 + 0.002, R);
    },
  },
  {
    id: "hoops",
    label: "Hoops",
    slots: ["Hoops"],
    paint(ctx, [a], { reach: R }) {
      const b = 0.07; // starting one hoop above the origin (the hem, or the shoulder on sleeves)
      for (let k = 0; (2 * k + 1) * b < R; k++) box(ctx, a, -R, (2 * k + 1) * b, R, (2 * k + 2) * b);
    },
  },
  {
    id: "halves",
    label: "Halves",
    slots: ["Half"],
    paint: (ctx, [a], { reach: R }) => box(ctx, a, 0, -R, R, R),
    // The wearer's left sleeve takes the colour of the wearer's left half.
    sleeve: (ctx, [a], { name, reach: R }) => name === "sleeve_left" && box(ctx, a, -R, -R, R, R),
  },
  {
    id: "quarters",
    label: "Quarters",
    slots: ["Quarters"],
    paint(ctx, [a], { reach: R }) {
      box(ctx, a, 0, 0.4, R, R);
      box(ctx, a, -R, -R, 0, 0.4);
    },
  },
  {
    id: "sash",
    label: "Sash",
    slots: ["Sash"],
    paint: (ctx, [a]) => band(ctx, a, 0.12, [[-0.32, 0.9], [0.4, -0.1]]),
  },
  {
    id: "chevron",
    label: "Chevron",
    slots: ["Chevron"],
    paint: (ctx, [a]) => band(ctx, a, 0.08, [[-0.6, 0.78], [0, 0.42], [0.6, 0.78]]),
  },
  {
    id: "band",
    label: "Chest band",
    slots: ["Band"],
    paint: (ctx, [a], { reach: R }) => box(ctx, a, -R, 0.42, R, 0.54),
  },
  {
    id: "checks",
    label: "Checks",
    slots: ["Checks"],
    paint(ctx, [a], { reach: R }) {
      const s = 0.08;
      const n = Math.ceil(R / s);
      for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) if ((i + j) % 2 === 0) box(ctx, a, i * s, j * s, (i + 1) * s, (j + 1) * s);
    },
  },
  {
    id: "wide-stripes",
    label: "Wide stripes",
    slots: ["Stripes"],
    paint(ctx, [a], { reach: R }) {
      const w = 0.12;
      const n = Math.ceil(R / (2 * w));
      for (let k = -n; k <= n; k++) box(ctx, a, (2 * k - 0.5) * w, -R, (2 * k + 0.5) * w, R);
    },
  },
  {
    id: "centre-stripe",
    label: "Centre stripe",
    slots: ["Stripe"],
    paint: (ctx, [a], { reach: R }) => box(ctx, a, -0.07, -R, 0.07, R),
  },
  {
    id: "twin-stripes",
    label: "Twin stripes",
    slots: ["Stripes"],
    paint(ctx, [a], { reach: R }) {
      box(ctx, a, -0.1, -R, -0.06, R);
      box(ctx, a, 0.06, -R, 0.1, R);
    },
  },
  {
    id: "triple-stripes",
    label: "Three stripes",
    slots: ["Stripes"],
    // Sportswear-style triple stripes: down the top of each sleeve to the cuff, and down both side seams.
    paint(ctx, [a], { reach: R }) {
      for (const x of TRIPLE) {
        box(ctx, a, 0.236 - x - 0.014, -R, 0.236 - x, R);
        box(ctx, a, -0.236 + x, -R, -0.236 + x + 0.014, R);
      }
    },
    sleeve(ctx, [a], { isl, reach: R }) {
      const end = (isl?.length ?? 0.26) - cuffLength(isl ?? {}) - 0.004; // stop at the cuff
      for (const x of TRIPLE) box(ctx, a, x - 0.032, -R, x - 0.018, end);
    },
  },
  {
    id: "claw-marks",
    label: "Claw marks",
    slots: ["Marks"],
    // Three tapered slashes rising from each side seam toward the waist, clear of the crest, number and sponsor.
    paint(ctx, [a]) {
      ctx.fillStyle = a;
      for (const side of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const h = 0.03 + k * 0.07; // where the slash leaves the side seam
          ctx.beginPath();
          ctx.moveTo(side * 0.27, h - 0.015);
          ctx.quadraticCurveTo(side * 0.2, h + 0.03, side * 0.135, h + 0.12);
          ctx.lineTo(side * 0.15, h + 0.13);
          ctx.quadraticCurveTo(side * 0.215, h + 0.08, side * 0.27, h + 0.04);
          ctx.closePath();
          ctx.fill();
        }
      }
    },
    sleeve() {}, // body only
  },
  {
    id: "wing-bands",
    label: "Wing bands",
    slots: ["Bands"],
    // Three bands fanning from the shoulders toward the chest, kept out of the middle (crest, number, name).
    paint(ctx, [a]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const d = k * 0.042;
          band(ctx, a, 0.02, [[side * 0.17, 0.66 - d], [side * 0.27, 0.6 - d], [side * 0.4, 0.58 - d]]);
        }
      }
    },
    sleeve(ctx, [a], { reach: R }) {
      // The bands carry on round the top of the sleeve as short rings near the shoulder.
      for (let k = 0; k < 3; k++) box(ctx, a, -R, 0.03 + k * 0.042, R, 0.05 + k * 0.042);
    },
  },
  {
    id: "side-stripes",
    label: "Side stripes",
    slots: ["Stripes"],
    paint(ctx, [a], { reach: R }) {
      box(ctx, a, -R, -R, -0.24, R);
      box(ctx, a, 0.24, -R, R, R);
    },
  },
  {
    id: "thin-hoops",
    label: "Thin hoops",
    slots: ["Hoops"],
    paint(ctx, [a], { reach: R }) {
      for (let k = 1; k * 0.05 < R; k++) box(ctx, a, -R, k * 0.05 - 0.008, R, k * 0.05 + 0.008);
    },
  },
  {
    id: "diagonal",
    label: "Diagonal stripes",
    slots: ["Stripes"],
    paint(ctx, [a], { reach: R }) {
      ctx.save();
      ctx.rotate(Math.PI / 4);
      const n = Math.ceil((R * 1.5) / 0.12);
      for (let k = -n; k <= n; k++) box(ctx, a, k * 0.12 - 0.03, -R * 1.5, k * 0.12 + 0.03, R * 1.5);
      ctx.restore();
    },
  },
  {
    id: "yoke",
    label: "Yoke",
    slots: ["Yoke"],
    paint: (ctx, [a], { reach: R }) => box(ctx, a, -R, 0.6, R, R),
    sleeve: (ctx, [a]) => box(ctx, a, -2, -2, 2, 0.1),
  },
  {
    id: "v-band",
    label: "V band",
    slots: ["Band"],
    paint: (ctx, [a]) => band(ctx, a, 0.06, [[-0.4, 0.9], [0, 0.45], [0.4, 0.9]]),
  },
  {
    id: "double-sash",
    label: "Double sash",
    slots: ["Sash"],
    paint(ctx, [a]) {
      band(ctx, a, 0.05, [[-0.4, 0.95], [0.45, -0.05]]);
      band(ctx, a, 0.05, [[-0.4, 0.8], [0.45, -0.2]]);
    },
  },
  {
    id: "zigzag",
    label: "Zigzag",
    slots: ["Zigzag"],
    paint(ctx, [a], { reach: R }) {
      for (let row = 1; row * 0.16 < R; row++) {
        const pts = [];
        for (let x = -R; x <= R + 0.06; x += 0.06) pts.push([x, row * 0.16 + (Math.round(x / 0.06) % 2 ? 0.03 : -0.03)]);
        band(ctx, a, 0.025, pts);
      }
    },
  },
  {
    id: "waves",
    label: "Waves",
    slots: ["Waves"],
    paint(ctx, [a], { reach: R }) {
      for (let row = 1; row * 0.14 < R; row++) {
        const pts = [];
        for (let x = -R; x <= R; x += 0.01) pts.push([x, row * 0.14 + 0.025 * Math.sin(x * 40)]);
        band(ctx, a, 0.03, pts);
      }
    },
  },
  {
    id: "dots",
    label: "Dots",
    slots: ["Dots"],
    paint(ctx, [a], { reach: R }) {
      ctx.fillStyle = a;
      const s = 0.06;
      const n = Math.ceil(R / s);
      ctx.beginPath();
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const x = i * s + (j % 2 ? s / 2 : 0);
        ctx.moveTo(x + 0.012, j * s);
        ctx.arc(x, j * s, 0.012, 0, 2 * Math.PI);
      }
      ctx.fill();
    },
  },
  {
    id: "diamonds",
    label: "Diamonds",
    slots: ["Diamonds"],
    paint(ctx, [a], { reach: R }) {
      ctx.fillStyle = a;
      const s = 0.1;
      const n = Math.ceil(R / s);
      ctx.beginPath();
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const x = i * s, y = j * s;
        ctx.moveTo(x, y + s / 2); ctx.lineTo(x + s / 2, y); ctx.lineTo(x, y - s / 2); ctx.lineTo(x - s / 2, y); ctx.closePath();
      }
      ctx.fill();
    },
  },
  {
    id: "argyle",
    label: "Argyle",
    slots: ["Diamonds", "Lines"],
    paint(ctx, [a, b], { reach: R }) {
      const s = 0.16;
      const n = Math.ceil(R / s);
      ctx.fillStyle = a;
      ctx.beginPath();
      for (let i = -n; i <= n; i += 2) for (let j = -n; j <= n; j += 2) {
        const x = i * s, y = j * s; // a diamond on every other lattice point: a checkerboard turned 45°
        ctx.moveTo(x, y + s); ctx.lineTo(x + s, y); ctx.lineTo(x, y - s); ctx.lineTo(x - s, y); ctx.closePath();
      }
      ctx.fill();
      ctx.save();
      ctx.rotate(Math.PI / 4);
      const d = s * Math.SQRT2;
      for (let k = -n * 2; k <= n * 2; k++) {
        box(ctx, b, k * d - 0.002, -R * 2, k * d + 0.002, R * 2);
        box(ctx, b, -R * 2, k * d - 0.002, R * 2, k * d + 0.002);
      }
      ctx.restore();
    },
  },
  {
    id: "hexagons",
    label: "Hexagons",
    slots: ["Lines"],
    paint(ctx, [a], { reach: R }) {
      const r = 0.05, h = r * Math.sqrt(3);
      ctx.strokeStyle = a;
      ctx.lineWidth = 0.008;
      ctx.beginPath();
      for (let i = -Math.ceil(R / (1.5 * r)); i * 1.5 * r <= R; i++) {
        for (let j = -Math.ceil(R / h); j * h <= R; j++) {
          const cx = i * 1.5 * r, cy = j * h + (i % 2 ? h / 2 : 0);
          for (let k = 0; k <= 6; k++) {
            const t = (k * Math.PI) / 3;
            k ? ctx.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t)) : ctx.moveTo(cx + r, cy);
          }
        }
      }
      ctx.stroke();
    },
  },
  {
    id: "camo",
    label: "Camo",
    slots: ["Shade 1", "Shade 2"],
    paint(ctx, [a, b], { reach: R }) {
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const blobs = Math.min(4000, Math.ceil((R * R) / 0.004));
      for (let i = 0; i < blobs; i++) {
        ctx.fillStyle = i % 2 ? a : b;
        ctx.beginPath();
        ctx.ellipse((rnd() * 2 - 1) * R, (rnd() * 2 - 1) * R, 0.03 + rnd() * 0.05, 0.02 + rnd() * 0.03, rnd() * Math.PI, 0, 2 * Math.PI);
        ctx.fill();
      }
    },
  },
  {
    id: "fade-stripes",
    label: "Fading hoops",
    slots: ["Hoops"],
    paint(ctx, [a], { reach: R }) {
      for (let k = 0; k * 0.06 < Math.min(R, 0.9); k++) {
        const t = 0.045 * (1 - k / 15);
        if (t > 0) box(ctx, a, -R, k * 0.06, R, k * 0.06 + t);
      }
    },
  },
  {
    id: "gradient",
    label: "Gradient",
    slots: ["Bottom", "Top"],
    opaque: true,
    paint(ctx, [a, b], { reach: R }) {
      const g = ctx.createLinearGradient(0, 0.05, 0, 0.75);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R, 2 * R, 2 * R);
    },
    sleeve() {}, // sleeves keep their base colour
  },
  {
    id: "gradient-side",
    label: "Side gradient",
    slots: ["Left", "Right"],
    opaque: true,
    paint(ctx, [a, b], { reach: R }) {
      const g = ctx.createLinearGradient(-0.35, 0, 0.35, 0);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R, 2 * R, 2 * R);
    },
    sleeve(ctx, [a, b], { name, reach: R }) {
      ctx.fillStyle = name === "sleeve_left" ? b : a;
      ctx.fillRect(-R, -R, 2 * R, 2 * R);
    },
  },
];

export const pattern = (id) => PATTERNS.find((p) => p.id === id) || PATTERNS[0];

/** Colour slot labels of a pattern layer: the pattern's colours, then the optional background. */
export const patternSlots = (p) => (p.opaque ? p.slots : [...p.slots, "Background"]);

/** Paint a pattern layer's colours (in pattern space) on one island. */
export function paintPattern(ctx, p, colors, island) {
  const n = p.slots.length;
  const R = island.reach ?? BIG;
  if (!p.opaque && colors[n]) box(ctx, colors[n], -R, -R, R, R);
  const ink = colors.slice(0, n);
  if (ink.some((c) => !c)) return;
  if (island.kind === "sleeve" && p.sleeve) p.sleeve(ctx, ink, island);
  else p.paint(ctx, ink, island);
}

// ---------------------------------------------------------------- garment regions
// Named areas a layer can be masked to ("only on") or masked out of ("hide on"). A region lists the UV islands it
// touches; null takes the whole island, a function returns rectangles [p0, q0, p1, q1] in the island's local frame
// (metres, p across, q up). Regions may overlap: a sleeve includes its cuff.

const whole = null;
const sides = (w) => (isl, f) => [[f.p0 - 1, f.q0 - 1, -w, f.q1 + 1], [w, f.q0 - 1, f.p1 + 1, f.q1 + 1]];
const above = (h) => (isl, f) => [[f.p0 - 1, h, f.p1 + 1, f.q1 + 1]];
const below = (h) => (isl, f) => [[f.p0 - 1, f.q0 - 1, f.p1 + 1, h]];
const cuff = (isl, f) => [[f.p0 - 1, f.q0 - 1, f.p1 + 1, -isl.length + cuffLength(isl)]];

export const REGIONS = {
  shirt: [
    { id: "front", label: "Front", parts: { front: whole } },
    { id: "back", label: "Back", parts: { back: whole } },
    { id: "sleeve_left", label: "Left sleeve", parts: { sleeve_left: whole } },
    { id: "sleeve_right", label: "Right sleeve", parts: { sleeve_right: whole } },
    { id: "collar", label: "Collar", parts: { collar: whole } },
    { id: "cuffs", label: "Cuffs", parts: { sleeve_left: cuff, sleeve_right: cuff } },
    { id: "side_panels", label: "Side panels", parts: { front: sides(0.19), back: sides(0.19) } },
    { id: "shoulders", label: "Shoulders", parts: { front: above(0.62), back: above(0.62) } },
  ],
  shorts: [
    { id: "front", label: "Front", parts: { front: whole } },
    { id: "back", label: "Back", parts: { back: whole } },
    { id: "waistband", label: "Waistband", parts: { waistband: whole } },
    { id: "hem", label: "Hem", parts: { front: below(0.018), back: below(0.018) } },
    { id: "side_panels", label: "Side panels", parts: { front: sides(0.27), back: sides(0.27) } },
  ],
  socks: [
    { id: "sock_left", label: "Left sock", parts: { sock_left: whole, sock_top_left: whole } },
    { id: "sock_right", label: "Right sock", parts: { sock_right: whole, sock_top_right: whole } },
    { id: "top_bands", label: "Top bands", parts: { sock_top_left: whole, sock_top_right: whole } },
  ],
};

export const region = (garment, id) => REGIONS[garment].find((r) => r.id === id);

// ---------------------------------------------------------------- graphics
// Shapes centred on the origin, `w` x `h` metres, drawn in island-local metres (y up).

export const GRAPHICS = [
  { id: "rect", label: "Rectangle", paint: (ctx, w, h) => ctx.fillRect(-w / 2, -h / 2, w, h) },
  {
    id: "circle",
    label: "Circle",
    paint(ctx, w, h) {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, 2 * Math.PI);
      ctx.fill();
    },
  },
  { id: "diamond", label: "Diamond", paint: (ctx, w, h) => poly(ctx, [[0, h / 2], [w / 2, 0], [0, -h / 2], [-w / 2, 0]]) },
  { id: "triangle", label: "Triangle", paint: (ctx, w, h) => poly(ctx, [[0, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2]]) },
  {
    id: "star",
    label: "Star",
    paint(ctx, w, h) {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.4 : 1;
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([(Math.cos(a) * r * w) / 2, (Math.sin(a) * r * h) / 2]);
      }
      poly(ctx, pts);
    },
  },
  { id: "chevron", label: "Chevron", paint: (ctx, w, h) => poly(ctx, [[-w / 2, h / 2], [0, -h / 6], [w / 2, h / 2], [w / 2, h / 6], [0, -h / 2], [-w / 2, h / 6]]) },
  {
    id: "hexagon",
    label: "Hexagon",
    paint: (ctx, w, h) => poly(ctx, [0, 1, 2, 3, 4, 5].map((k) => [(Math.cos((k * Math.PI) / 3) * w) / 2, (Math.sin((k * Math.PI) / 3) * h) / 2])),
  },
  {
    id: "shield",
    label: "Shield",
    paint(ctx, w, h) {
      ctx.beginPath();
      ctx.moveTo(-w / 2, h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(w / 2, 0);
      ctx.quadraticCurveTo(w / 2, -h / 3, 0, -h / 2);
      ctx.quadraticCurveTo(-w / 2, -h / 3, -w / 2, 0);
      ctx.closePath();
      ctx.fill();
    },
  },
  {
    id: "ring",
    label: "Ring",
    paint(ctx, w, h) {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, 2 * Math.PI);
      ctx.ellipse(0, 0, w * 0.36, h * 0.36, 0, 0, 2 * Math.PI);
      ctx.fill("evenodd");
    },
  },
  {
    id: "cross",
    label: "Cross",
    paint(ctx, w, h) {
      ctx.fillRect(-w / 2, -h / 8, w, h / 4);
      ctx.fillRect(-w / 8, -h / 2, w / 4, h);
    },
  },
  { id: "bolt", label: "Lightning", paint: (ctx, w, h) => poly(ctx, [[0.1 * w, h / 2], [-0.35 * w, -0.05 * h], [0, -0.05 * h], [-0.1 * w, -h / 2], [0.35 * w, 0.08 * h], [0, 0.08 * h]]) },
  {
    id: "heart",
    label: "Heart",
    paint(ctx, w, h) {
      ctx.beginPath();
      ctx.moveTo(0, -h / 2);
      ctx.bezierCurveTo(-w * 0.7, -h * 0.05, -w * 0.4, h * 0.55, 0, h * 0.2);
      ctx.bezierCurveTo(w * 0.4, h * 0.55, w * 0.7, -h * 0.05, 0, -h / 2);
      ctx.fill();
    },
  },
  { id: "arrow", label: "Arrow", paint: (ctx, w, h) => poly(ctx, [[0, h / 2], [w / 2, 0], [w / 6, 0], [w / 6, -h / 2], [-w / 6, -h / 2], [-w / 6, 0], [-w / 2, 0]]) },
  {
    id: "stripe-band",
    label: "Band (3 stripes)",
    paint(ctx, w, h) {
      for (const y of [-h / 2, -h / 10, (3 * h) / 10]) ctx.fillRect(-w / 2, y, w, h / 5);
    },
  },
];

export const graphic = (id) => GRAPHICS.find((g) => g.id === id) || GRAPHICS[0];

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------- material effects (PBR)
// A material layer changes how its regions (its mask) catch the light: roughness, metalness and, optionally, a
// knit relief. `relief(ctx, frame, lo)` paints in the island's local metres (frame bounds p0..p1, q0..q1) on a
// height map where mid grey is flat; `lo` is the grey of the recesses, `hi` of raised parts. Nothing here touches the colour texture.

const grooves = (gap, width, vertical) => (ctx, f, lo) => {
  ctx.fillStyle = lo;
  if (vertical) for (let p = Math.floor(f.p0 / gap) * gap; p < f.p1; p += gap) ctx.fillRect(p, f.q0, width, f.q1 - f.q0);
  else for (let q = Math.floor(f.q0 / gap) * gap; q < f.q1; q += gap) ctx.fillRect(f.p0, q, f.p1 - f.p0, width);
};

export const MATERIALS = [
  { id: "satin", label: "Satin", roughness: 0.42, metalness: 0 },
  { id: "gloss", label: "Gloss", roughness: 0.22, metalness: 0 },
  { id: "matte", label: "Matte cotton", roughness: 0.97, metalness: 0 },
  { id: "metallic", label: "Metallic", roughness: 0.32, metalness: 0.85 },
  {
    id: "mesh", label: "Perforated mesh", roughness: 0.85, metalness: 0,
    relief(ctx, f, lo) {
      ctx.fillStyle = lo;
      const g = 0.006;
      let row = 0;
      for (let q = Math.floor(f.q0 / g) * g; q < f.q1; q += g, row++) {
        ctx.beginPath();
        for (let p = Math.floor(f.p0 / g) * g + (row % 2) * (g / 2); p < f.p1; p += g) {
          ctx.moveTo(p + g * 0.28, q);
          ctx.arc(p, q, g * 0.28, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    },
  },
  {
    id: "raised", label: "Raised print", roughness: 0.78, metalness: 0,
    relief(ctx, f, lo, hi) {
      ctx.fillStyle = hi;
      ctx.fillRect(f.p0, f.q0, f.p1 - f.p0, f.q1 - f.q0);
    },
  },
  { id: "ribbed", label: "Ribbed knit", roughness: 0.88, metalness: 0, relief: grooves(0.005, 0.0022, true) },
  { id: "embossed-stripes", label: "Embossed pinstripes", roughness: 0.75, metalness: 0, relief: grooves(0.03, 0.004, true) },
  {
    id: "quilted", label: "Quilted diamonds", roughness: 0.8, metalness: 0,
    relief(ctx, f, lo) {
      ctx.strokeStyle = lo;
      ctx.lineWidth = 0.003;
      const g = 0.05;
      ctx.beginPath();
      for (let k = Math.floor((f.p0 - f.q1) / g) * g; k < f.p1 - f.q0; k += g) { // lines p = q + k
        ctx.moveTo(f.q0 + k, f.q0);
        ctx.lineTo(f.q1 + k, f.q1);
      }
      for (let k = Math.floor((f.p0 + f.q0) / g) * g; k < f.p1 + f.q1; k += g) { // lines p = k - q
        ctx.moveTo(k - f.q0, f.q0);
        ctx.lineTo(k - f.q1, f.q1);
      }
      ctx.stroke();
    },
  },
];
export const material = (id) => MATERIALS.find((m) => m.id === id) || MATERIALS[0];
