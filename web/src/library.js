// The design library: base designs, patterns and graphics. Each entry is metadata (for the panel and for
// sanitizing saved projects) plus a plain canvas painter (for the compositor in kitTexture.js). No React here.
//
// Painters draw in metres. Patterns get "pattern space": on body panels x = metres across from the centre line
// (+x = wearer's left) and h = metres up from the hem; on sleeves and socks ("tubes") x = metres around from the
// top line and h = metres down from the shoulder or the top edge. The compositor sets that transform up.

const BIG = 2; // metres: further than any panel reaches

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
// transparent), except opaque patterns (the gradient). paint(ctx, colors, { kind, name }) draws in pattern space;
// `sleeve` optionally replaces it on sleeves.

export const PATTERNS = [
  {
    id: "stripes",
    label: "Stripes",
    slots: ["Stripes"],
    paint(ctx, [a]) {
      const w = 0.06; // a stripe on the centre line, alternating outward
      for (let k = -10; k <= 10; k++) box(ctx, a, (2 * k - 0.5) * w, -BIG, (2 * k + 0.5) * w, BIG);
    },
  },
  {
    id: "pinstripes",
    label: "Pinstripes",
    slots: ["Lines"],
    paint(ctx, [a]) {
      for (let k = -40; k <= 40; k++) box(ctx, a, k * 0.03 - 0.002, -BIG, k * 0.03 + 0.002, BIG);
    },
  },
  {
    id: "hoops",
    label: "Hoops",
    slots: ["Hoops"],
    paint(ctx, [a]) {
      const b = 0.07;
      for (let k = 0; k < 20; k++) box(ctx, a, -BIG, (2 * k + 1) * b, BIG, (2 * k + 2) * b);
    },
  },
  {
    id: "halves",
    label: "Halves",
    slots: ["Half"],
    paint: (ctx, [a]) => box(ctx, a, 0, -BIG, BIG, BIG),
    // The wearer's left sleeve takes the colour of the wearer's left half.
    sleeve: (ctx, [a], { name }) => name === "sleeve_left" && box(ctx, a, -BIG, -BIG, BIG, BIG),
  },
  {
    id: "quarters",
    label: "Quarters",
    slots: ["Quarters"],
    paint(ctx, [a]) {
      box(ctx, a, 0, 0.4, BIG, BIG);
      box(ctx, a, -BIG, -BIG, 0, 0.4);
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
    paint: (ctx, [a]) => box(ctx, a, -BIG, 0.42, BIG, 0.54),
  },
  {
    id: "checks",
    label: "Checks",
    slots: ["Checks"],
    paint(ctx, [a]) {
      const s = 0.08;
      for (let i = -12; i < 12; i++) for (let j = -12; j < 12; j++) if ((i + j) % 2 === 0) box(ctx, a, i * s, j * s, (i + 1) * s, (j + 1) * s);
    },
  },
  {
    id: "gradient",
    label: "Gradient",
    slots: ["Bottom", "Top"],
    opaque: true,
    paint(ctx, [a, b]) {
      const g = ctx.createLinearGradient(0, 0.05, 0, 0.75);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      ctx.fillRect(-BIG, -BIG, 2 * BIG, 2 * BIG);
    },
    sleeve() {}, // sleeves keep their base colour
  },
];

export const pattern = (id) => PATTERNS.find((p) => p.id === id) || PATTERNS[0];

/** Colour slot labels of a pattern layer: the pattern's colours, then the optional background. */
export const patternSlots = (p) => (p.opaque ? p.slots : [...p.slots, "Background"]);

/** Paint a pattern layer's colours (in pattern space) on one island. */
export function paintPattern(ctx, p, colors, island) {
  const n = p.slots.length;
  if (!p.opaque && colors[n]) box(ctx, colors[n], -BIG, -BIG, BIG, BIG);
  const ink = colors.slice(0, n);
  if (ink.some((c) => !c)) return;
  if (island.kind === "sleeve" && p.sleeve) p.sleeve(ctx, ink, island);
  else p.paint(ctx, ink, island);
}

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
];

export const graphic = (id) => GRAPHICS.find((g) => g.id === id) || GRAPHICS[0];

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}
