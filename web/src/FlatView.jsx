import { useEffect, useRef } from "react";

const PANELS = [["front", "Front"], ["back", "Back"]];

/** The shirt laid flat: the front and back panels cut from the live texture, side by side. */
export default function FlatView({ texture, template }) {
  const refs = useRef({});

  useEffect(() => {
    let frame;
    let version = -1;
    const tick = () => {
      if (texture.version !== version) {
        version = texture.version;
        const src = texture.image;
        for (const [name] of PANELS) {
          const isl = template?.islands?.[name];
          const c = refs.current[name];
          if (!isl || !c) continue;
          const [x, y, w, h] = isl.rect;
          const sx = x * src.width, sy = y * src.width, sw = w * src.width, sh = h * src.width;
          c.width = Math.round(sw);
          c.height = Math.round(sh);
          c.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [texture, template]);

  return (
    <div className="flat-view">
      {PANELS.map(([name, label]) => (
        <figure key={name}>
          <canvas ref={(el) => { refs.current[name] = el; }} aria-label={`${label} of the shirt`} />
          <figcaption>{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}
