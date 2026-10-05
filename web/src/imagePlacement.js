/** Find a nearby free position for a newly added image, using its maximum rendered side in metres. */
export function findOpenImagePosition(layers, garment, template, preferred = null, size = 0.085) {
  const place = {
    shirt: ["front", 0, 0.45],
    shorts: ["front", 0.13, 0.2],
    socks: ["sock_left", 0, -0.2],
  }[garment];
  const surface = preferred?.surface || place[0];
  const island = template?.islands?.[surface];
  const anchor = preferred || { surface, x: place[1], y: place[2] };
  if (!island) return anchor;

  const x0 = island.pmin;
  const x1 = x0 + island.rect[2] / island.scale;
  const y0 = island.qmax - island.rect[3] / island.scale;
  const y1 = island.qmax;
  const margin = size / 2 + 0.015;
  const xs = Array.from({ length: 11 }, (_, i) => x0 + (x1 - x0) * (i + 0.5) / 11)
    .filter((x) => x >= x0 + margin && x <= x1 - margin);
  const ys = Array.from({ length: 13 }, (_, i) => y0 + (y1 - y0) * (i + 0.5) / 13)
    .filter((y) => y >= y0 + margin && y <= y1 - margin);
  const occupied = [];
  const visit = (items) => items.forEach((layer) => {
    if (layer.type === "group") visit(layer.children || []);
    else if (layer.type === "image" && layer.visible && layer.surface === surface) {
      const scale = layer.transform || {};
      const extent = layer.size * Math.max(Math.abs(scale.scaleX || 1), Math.abs(scale.scaleY || 1));
      occupied.push({ x: scale.x || 0, y: scale.y || 0, size: extent });
    }
  });
  visit(layers);

  const candidates = [];
  for (const x of xs) for (const y of ys) candidates.push({ x, y });
  candidates.sort((a, b) =>
    (a.x - anchor.x) ** 2 + (a.y - anchor.y) ** 2 - ((b.x - anchor.x) ** 2 + (b.y - anchor.y) ** 2),
  );
  const free = candidates.find(({ x, y }) => occupied.every((item) =>
    Math.abs(x - item.x) >= (size + item.size) / 2 + 0.02 || Math.abs(y - item.y) >= (size + item.size) / 2 + 0.02,
  ));
  return { surface, x: free?.x ?? anchor.x, y: free?.y ?? anchor.y };
}
